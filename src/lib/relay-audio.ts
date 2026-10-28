/**
 * Socket-relayed voice.
 *
 * Pictures are the visible half of the fallback; this is the audible half. When
 * two networks will not let the browsers reach each other, the microphone is cut
 * into slices, encoded as **Opus at 48 kHz** where WebCodecs is there and sent as
 * **48 kHz 24-bit PCM** where it is not, posted over the same WebSocket the studio
 * already uses, and played back on the other side through a small jitter buffer.
 *
 * The rule is the same as for the pictures: **keep the delay flat, never grow a
 * queue.** Slices are dropped rather than queued when the socket is behind, a
 * slice that arrives too late is thrown away, and the playback clock is pushed
 * forward instead of drifting - so a struggling network sounds choppy but stays
 * live, rather than sounding fine and being seconds behind.
 */
import {
  RELAY_AUDIO_RATE,
  RELAY_AUDIO_STALE_NS,
  isStaleNs,
  monotonicNs,
  nsToWire,
  relayLagNs,
} from '@shared/protocol';
import {
  RELAY_CAPTURE_RATE,
  RELAY_MONO,
  RELAY_OPUS_MUSIC_BITRATE_BPS,
  RELAY_OPUS_VOICE_BITRATE_BPS,
  RELAY_PCM_BITS,
  RELAY_PCM_BYTES,
  RELAY_PCM_MAX,
  RELAY_PCM_RATE,
  RELAY_STEREO,
} from '@shared/audio';

/** 1024 samples at 48 kHz: a 21 ms slice, and what Opus is happiest with. */
const AUDIO_FRAME_SAMPLES = 1024;
/** 20 ms of Opus, in microseconds - the timestamp unit WebCodecs uses. */
const AUDIO_FRAME_US = 20_000;
/** Always keep this much voice queued ahead of the clock, to ride out jitter. */
export const AUDIO_JITTER_MIN_S = 0.05;
/** Further behind than this and we jump forward: a growing delay is worse than a gap. */
export const AUDIO_JITTER_MAX_S = 0.35;
/** Below this peak a slice is silence, and silence is not worth its bytes. */
const AUDIO_SILENCE_PEAK = 0.004;
/** ...but send one anyway this often, so the far end knows we are still here. */
const AUDIO_SILENCE_KEEPALIVE_MS = 500;
/** How loud relayed voice is allowed to be while a howl is being suppressed. */
const RELAY_DUCKED_GAIN = 0.02;

/** One shared context: capture and playback both live here, the browser mixes it. */
let context: AudioContext | null = null;
/** Where each sender's next slice should be played, on the context clock. */
const playing = new Map<string, number>();
/** How much relayed voice was played, and how much was too late to use. */
let played = 0;
let audioStale = 0;
/**
 * The socket whose server-clock offset the relay times against.
 *
 * Nanosecond stamps from another device only mean something on the server's clock,
 * so the transport measures that offset (see `QuandriteSocket.syncClock`) and this
 * module asks it what time it is rather than trusting the local wall clock.
 */
let clock: any = null;
/** The last hops measured, in nanoseconds, so the studio can show where lag comes from. */
let lastHops: any = null;

/** Point the relay at the socket that knows the server's clock. */
export function useRelayClock(source: any) {
  clock = source;
}

/** The shared clock, or the local monotonic one if the offset is not known yet. */
export function relayNowNs(): bigint {
  return clock?.serverNowNs?.() ?? monotonicNs();
}

/** Per-sender Opus decoders, and how the relay's own encoding is doing. */
const decoders = new Map<string, any>();
let decoded = 0;
let decodeErrors = 0;
let encodeErrors = 0;
let encoded = 0;
/** The codecs the sender ended up using: `opus`, `pcm24`, or both across sources. */
const sendCodecs = new Set<string>();

/** The most recent hop breakdown (inbound / outbound / total), in nanoseconds. */
export function relayHopsNs() {
  return lastHops;
}

/**
 * Relayed voice goes through one gain, and past one meter.
 *
 * The meter is *before* the gain, deliberately: a howl must still be visible to the
 * feedback detector while the room is already ducked, or the duck would hide the thing
 * that is being detected and the room would never come back up.
 */
let relayMaster: GainNode | null = null;
let relayAnalyser: AnalyserNode | null = null;
let relayDucked = false;

function relayOutput(ctx: AudioContext) {
  if (relayMaster && relayAnalyser) return { master: relayMaster, analyser: relayAnalyser };
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  const master = ctx.createGain();
  master.gain.value = relayDucked ? RELAY_DUCKED_GAIN : 1;
  analyser.connect(master);
  master.connect(ctx.destination);
  relayAnalyser = analyser;
  relayMaster = master;
  return { master, analyser };
}

/**
 * The meter for relayed voice, so the room's feedback detector can watch it.
 *
 * The relay is the fallback path, and it is exactly the path where a howl used to be
 * played without anybody noticing: it is a second audio context with its own output.
 */
export function relayedAudioAnalyser(): AnalyserNode | null {
  const ctx = relayAudioContext();
  if (!ctx) return null;
  return relayOutput(ctx).analyser;
}

/** Pull the relayed voice down (or back up) while a howl is being suppressed. */
export function setRelayedAudioDucked(ducked: boolean) {
  relayDucked = Boolean(ducked);
  if (!relayMaster || !context) return;
  try {
    relayMaster.gain.setTargetAtTime(relayDucked ? RELAY_DUCKED_GAIN : 1, context.currentTime, 0.05);
  } catch {
    relayMaster.gain.value = relayDucked ? RELAY_DUCKED_GAIN : 1;
  }
}

/** The audio context, created on first use (it needs a user gesture to run). */
export function relayAudioContext(): AudioContext | null {
  if (context) return context;
  const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  try {
    // Full quality: the relay encodes 48 kHz Opus, and a context at 16 kHz would resample
    // everything down before it ever reached the encoder.
    context = new Ctor({ sampleRate: RELAY_CAPTURE_RATE });
  } catch {
    context = new Ctor();
  }
  return context;
}

/** Browsers keep audio silent until the user interacts: call this on a gesture. */
export function resumeRelayedAudio() {
  const ctx = relayAudioContext();
  if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
}

/** Forget a sender's playback clock (they left, or stopped publishing). */
export function forgetRelayedAudio(peerId: string) {
  playing.delete(peerId);
}

/**
 * Send relayed voice to a chosen speaker, where the browser can.
 *
 * The relay plays on a context of its own, so choosing an output device is two calls - one
 * for the room mix (`RoomAudio.setOutputDevice`) and one for this. A browser without
 * `setSinkId` follows the system, and this says so rather than pretending.
 */
export async function setRelayedAudioOutputDevice(deviceId: string) {
  const ctx: any = relayAudioContext();
  if (!ctx || typeof ctx.setSinkId !== 'function') return false;
  try {
    await ctx.setSinkId(deviceId || '');
    return true;
  } catch {
    return false;
  }
}

/**
 * Play one slice of relayed voice.
 *
 * Two codecs arrive here: **Opus** (48 kHz, what the sender prefers) and the **PCM** slice,
 * which is 48 kHz 24-bit from a current client and 16 kHz 16-bit from an older one - the
 * fallback for a browser without WebCodecs. Both end up in the same jitter-buffered
 * scheduler, so a mixed room sounds the same either way.
 */
export function playRelayedAudio(header: any, payload: Uint8Array | ArrayBuffer | null) {
  const from = header?.from;
  if (!from || !payload) return false;
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.byteLength < 2) return false;

  // How old is this slice, on the shared clock? Nanoseconds, because a slice only
  // lives for 20 ms and the interesting differences are well under a millisecond.
  const nowNs = relayNowNs();
  const lag = relayLagNs(header, nowNs);
  lastHops = lag;
  // Voice that arrives late is worse than voice that never arrives: playing it
  // would push everything after it later still.
  if (isStaleNs(lag.capturedNs, nowNs, RELAY_AUDIO_STALE_NS)) {
    audioStale += 1;
    return false;
  }

  const ctx = relayAudioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  if (header.codec === 'opus') return decodeRelayedOpus(from, header, bytes, ctx);

  // The PCM fallback. A slice says how it was encoded: **48 kHz 24-bit** from a current
  // client, and 16 kHz 16-bit from an older one. Anything that does not say (an old
  // sender, or a frame whose header predates the field) is read as 16-bit, because
  // reading 16-bit samples as 24-bit is not a small error - it is noise.
  const bits = header.codec === 'pcm24' || Number(header.bits) === 24 ? 24 : 16;
  const width = bits / 8;
  const count = Math.floor(bytes.byteLength / width);
  if (!count) return false;
  const rate = header.rate || (bits === 16 ? RELAY_AUDIO_RATE : RELAY_PCM_RATE);
  const buffer = ctx.createBuffer(1, count, rate);
  const channel = buffer.getChannelData(0);
  // Read through a DataView: the payload is a view into the frame buffer and is
  // not guaranteed to start on an even byte.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i += 1) {
    channel[i] = bits === 24 ? readPcm24(view, i * RELAY_PCM_BYTES) / RELAY_PCM_MAX : view.getInt16(i * 2, true) / 32768;
  }
  return scheduleRelayedBuffer(from, buffer, ctx);
}

/**
 * One 24-bit little-endian sample, sign-extended.
 *
 * A 24-bit sample has no typed-array counterpart, so it is read three bytes at a time and
 * the sign bit of the top byte is carried down - which is what makes -1 full scale rather
 * than a spike at the other end of the range.
 */
function readPcm24(view: DataView, at: number) {
  const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
  return value & 0x800000 ? value - 0x1000000 : value;
}

/**
 * Decode one Opus packet, and play it when it comes out.
 *
 * Opus is decoded asynchronously, so the packet is handed to a per-sender decoder and
 * the result is scheduled from its `output` callback - the same scheduler the PCM path
 * uses, which is what keeps the jitter buffer and the delay behaviour identical.
 */
function decodeRelayedOpus(from: string, header: any, bytes: Uint8Array, ctx: AudioContext) {
  const Ctor = (window as any).AudioDecoder;
  if (!Ctor) {
    decodeErrors += 1;
    return false;
  }
  const rate = header.rate || RELAY_CAPTURE_RATE;
  const channels = header.channels || RELAY_MONO;
  let decoder = decoders.get(from);
  if (!decoder || decoder.__rate !== rate || decoder.__channels !== channels) {
    try {
      decoder?.close?.();
    } catch {
      // already gone
    }
    try {
      decoder = new Ctor({
        output: (audio: any) => {
          const buffer = audioBufferFrom(audio, ctx);
          audio.close?.();
          if (buffer) scheduleRelayedBuffer(from, buffer, ctx);
        },
        error: () => {
          decodeErrors += 1;
        },
      });
      decoder.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: channels });
      decoder.__rate = rate;
      decoder.__channels = channels;
      decoder.__timestampUs = 0;
      decoders.set(from, decoder);
    } catch {
      decodeErrors += 1;
      decoders.delete(from);
      return false;
    }
  }

  // A synthetic, monotonic timestamp: the decoder only passes it through, and a clock
  // that jumps would look like a discontinuity to it.
  const timestamp = decoder.__timestampUs;
  decoder.__timestampUs += AUDIO_FRAME_US;
  try {
    decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: bytes }));
  } catch {
    decodeErrors += 1;
    return false;
  }
  decoded += 1;
  return true;
}

/** A decoded Opus frame as an audio buffer the graph can play. */
function audioBufferFrom(audio: any, ctx: AudioContext) {
  try {
    const frames = audio.numberOfFrames;
    const channels = audio.numberOfChannels;
    if (!frames || !channels) return null;
    const buffer = ctx.createBuffer(channels, frames, audio.sampleRate || RELAY_CAPTURE_RATE);
    // WebCodecs hands back f32-planar, which is exactly what an AudioBuffer wants.
    for (let channel = 0; channel < channels; channel += 1) {
      const target = buffer.getChannelData(channel);
      const source = new Float32Array(frames);
      audio.copyTo(source, { planeIndex: channel, format: 'f32-planar' });
      target.set(source.subarray(0, frames));
    }
    return buffer;
  } catch {
    decodeErrors += 1;
    return null;
  }
}

/**
 * Schedule a decoded slice just ahead of the clock, through the relay's meter and gain.
 *
 * The schedule is pushed forward and never backwards, so the delay stays bounded: a
 * struggling network sounds choppy rather than seconds behind.
 */
function scheduleRelayedBuffer(from: string, buffer: AudioBuffer, ctx: AudioContext) {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  // Through the relay's own meter and gain, never straight to the speakers: this is the
  // one path a howl can arrive on that the room mixer cannot see.
  const { analyser } = relayOutput(ctx);
  source.connect(analyser);

  const now = ctx.currentTime;
  let endsAt = playing.get(from) ?? 0;
  if (endsAt < now + AUDIO_JITTER_MIN_S || endsAt > now + AUDIO_JITTER_MAX_S) {
    // Nothing queued, or hopelessly behind: start fresh just ahead of the clock.
    endsAt = now + AUDIO_JITTER_MIN_S;
  }
  source.start(endsAt);
  playing.set(from, endsAt + buffer.duration);
  played += 1;
  return true;
}

/** What the relayed voice is doing, for the studio's own diagnostics. */
export function relayedAudioStats() {
  return {
    played,
    stale: audioStale,
    senders: playing.size,
    // What the two ends are actually speaking: Opus at 48 kHz where WebCodecs is there,
    // and 48 kHz PCM at 24-bit - or 16-bit when the socket is tight - where it is not.
    // A room can have both at once.
    codecs: [...sendCodecs],
    encoded,
    decoded,
    encodeErrors,
    decodeErrors,
    decoders: decoders.size,
    // The room's feedback handling reaches this path too, so it says whether it is
    // currently pulled down. Its *level* is reported by the mixer, which owns the meter.
    ducked: relayDucked,
    // The last measured lag, in nanoseconds, split by hop.
    lag: lastHops
      ? {
          totalNs: lastHops.totalNs?.toString() ?? null,
          inboundNs: lastHops.inboundNs?.toString() ?? null,
          outboundNs: lastHops.outboundNs?.toString() ?? null,
        }
      : null,
  };
}


/**
 * The sending half: microphones posted over the socket.
 *
 * `add()` takes the same streams the camera manager holds, so the relay follows
 * whatever is published - a camera with a microphone in it, a shared screen with
 * sound, or the microphone on its own.
 */
export class AudioRelay extends EventTarget {
  // --- state (typed loosely, matching MediaRelay) ---
  context: any;
  dropped: any;
  logger: any;
  maxBufferedBytes: any;
  muted: any;
  sent: any;
  silentUntil: any;
  socket: any;
  sources: any;

  constructor({ socket, logger = console, maxBufferedBytes = 64 * 1024 }: any = {}) {
    super();
    this.socket = socket;
    this.logger = logger;
    this.maxBufferedBytes = maxBufferedBytes;
    this.sources = new Map();
    this.muted = false;
    this.sent = 0;
    this.dropped = 0;
    this.silentUntil = 0;
    this.context = null;
  }

  get publishing() {
    return this.sources.size > 0;
  }

  get ids() {
    return [...this.sources.keys()];
  }

  /** Mute stops the bytes, not just the sound: silence costs nothing to send. */
  setMuted(muted: boolean) {
    this.muted = Boolean(muted);
  }

  /** Start posting the audio track(s) in `stream`. */
  add({ id, kind = 'audio', label = null, stream }: any = {}) {
    if (!id || !stream || this.sources.has(id)) return false;
    const tracks = stream.getAudioTracks?.() || [];
    if (!tracks.length) return false;
    const context = this._ensureContext();
    if (!context) return false;
    // A microphone is one channel of speech; a shared screen's sound is music and may be
    // stereo, so it is captured as stereo and encoded that way.
    const microphone = kind === 'audio' || kind === 'camera';
    const channels = microphone ? RELAY_MONO : RELAY_STEREO;
    const node = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(AUDIO_FRAME_SAMPLES, channels, channels);
    const entry: any = {
      id,
      label,
      stream,
      node,
      processor,
      microphone,
      channels,
      rate: context.sampleRate || RELAY_CAPTURE_RATE,
      encoder: null,
      timestampUs: 0,
    };
    processor.onaudioprocess = (event) => this._slice(id, entry, event);
    // A ScriptProcessor only runs while it is connected to something, but sending
    // it to the speakers would play the room's own voice back at them: route it
    // through a silent gain node instead.
    const sink = context.createGain();
    sink.gain.value = 0;
    node.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    entry.sink = sink;

    // Opus at 48 kHz rather than the PCM fallback: a fraction of the bandwidth and none of
    // the telephone sound. Where WebCodecs is missing (or refuses the config) the 48 kHz
    // 24-bit slice below is still there, so the room keeps working.
    entry.encoder = this._makeEncoder(entry);

    this.sources.set(id, entry);
    this._emit('sources', { ids: this.ids });
    return true;
  }

  /** An Opus encoder for one source, or null where WebCodecs cannot do it. */
  _makeEncoder(entry: any) {
    const Ctor = (window as any).AudioEncoder;
    if (!Ctor) return null;
    try {
      const encoder = new Ctor({
        output: (chunk: any) => this._sendEncoded(entry, chunk),
        error: () => {
          encodeErrors += 1;
        },
      });
      encoder.configure({
        codec: 'opus',
        sampleRate: entry.rate,
        numberOfChannels: entry.channels,
        bitrate: entry.microphone ? RELAY_OPUS_VOICE_BITRATE_BPS : RELAY_OPUS_MUSIC_BITRATE_BPS,
      });
      return encoder;
    } catch {
      // An encoder that will not configure is not a reason to lose the voice.
      encodeErrors += 1;
      return null;
    }
  }

  /** One Opus packet, posted as it comes out of the encoder. */
  _sendEncoded(entry: any, chunk: any) {
    if (!entry || !this.sources.has(entry.id)) return;
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    if (!this._ready(entry)) return;
    const sent = this.socket.sendRelayFrame(
      {
        sourceId: entry.id,
        kind: 'audio',
        codec: 'opus',
        label: entry.label,
        rate: entry.rate,
        channels: entry.channels,
        tns: nsToWire(this.socket.serverNowNs?.() ?? monotonicNs()),
        t: Date.now(),
      },
      bytes.buffer,
    );
    if (sent) {
      encoded += 1;
      this.sent += 1;
      sendCodecs.add('opus');
    } else {
      this.dropped += 1;
    }
  }

  /** Is there room on the socket for another slice right now? */
  _ready(entry: any) {
    const track = entry.stream.getAudioTracks?.()[0];
    // Muting is about my microphone: a shared screen keeps being heard while I am
    // muted, because its sound is the thing I am presenting, not my voice.
    if ((this.muted && entry.microphone) || track?.enabled === false) return false;
    const backlog = this.socket?.socket?.bufferedAmount ?? 0;
    if (backlog > this.maxBufferedBytes) {
      this.dropped += 1;
      this._emit('dropped', { id: entry.id, backlog });
      return false;
    }
    return true;
  }

  remove(id: string) {
    const entry = this.sources.get(id);
    if (!entry) return false;
    entry.processor.onaudioprocess = null;
    try {
      entry.encoder?.close?.();
    } catch {
      // already closed
    }
    entry.node.disconnect();
    entry.processor.disconnect();
    entry.sink.disconnect();
    this.sources.delete(id);
    this._emit('sources', { ids: this.ids });
    return true;
  }

  stop() {
    for (const id of this.ids) this.remove(id);
  }

  /**
   * One slice of captured audio: encoded if Opus is available, PCM if not.
   *
   * Nothing is ever queued: if the socket is behind, the slice is dropped, and a silent
   * PCM slice is only sent now and then as a keepalive. Opus needs no silence
   * suppression of its own - it compresses silence to a handful of bytes - so with an
   * encoder the audio goes out whole, which is what stops a soft passage from clipping
   * to nothing.
   */
  _slice(id: string, entry: any, event: any) {
    if (!entry || this.sources.get(id) !== entry) return;
    const mono = event.inputBuffer.getChannelData(0);
    const second = entry.channels > 1 ? event.inputBuffer.getChannelData(1) : null;

    if (entry.encoder) {
      if (!this._ready(entry)) return;
      const frames = mono.length;
      const planar = new Float32Array(frames * entry.channels);
      planar.set(mono, 0);
      if (second) planar.set(second, frames);
      try {
        entry.encoder.encode(
          new AudioData({
            format: 'f32-planar',
            sampleRate: entry.rate,
            numberOfFrames: frames,
            numberOfChannels: entry.channels,
            // Monotonic, and in microseconds: what WebCodecs expects of a timestamp.
            timestamp: entry.timestampUs,
            data: planar,
          }),
        );
        entry.timestampUs += Math.round((frames / entry.rate) * 1_000_000);
      } catch {
        encodeErrors += 1;
      }
      let peak = 0;
      for (let i = 0; i < mono.length; i += 1) {
        const level = Math.abs(mono[i]);
        if (level > peak) peak = level;
      }
      this._emit('level', { id, level: peak });
      return;
    }

    // No WebCodecs: the PCM fallback, at 48 kHz. Its depth follows the socket - 24-bit
    // while there is room for it, 16-bit when there is not, because a voice that arrives
    // at 16 bits is worth more than one at 24 that never arrives. The header says which,
    // and the far end reads it back the same way.
    if (!this._ready(entry)) return;
    const bits = this._pcmBits();
    const pcm = this._toPcm(mono, bits);
    let peak = 0;
    for (let i = 0; i < mono.length; i += 1) {
      const level = Math.abs(mono[i]);
      if (level > peak) peak = level;
    }
    // Silence is not worth its bytes. The peak is on a 0..1 scale, whatever the sample
    // width, so the threshold means the same thing here and with Opus.
    const quiet = peak < AUDIO_SILENCE_PEAK;
    const now = Date.now();
    if (quiet && now < this.silentUntil) return;
    this.silentUntil = quiet ? now + AUDIO_SILENCE_KEEPALIVE_MS : 0;

    const sent = this.socket.sendRelayFrame(
      {
        sourceId: id,
        kind: 'audio',
        codec: bits === 24 ? 'pcm24' : 'pcm16',
        bits,
        label: entry.label,
        rate: RELAY_PCM_RATE,
        // One channel: the fallback carries the voice, which is mono whatever the source.
        channels: RELAY_MONO,
        // Nanoseconds on the shared clock: a voice slice lives for 20 ms, so
        // milliseconds are simply not fine enough to say where it is.
        tns: nsToWire(this.socket.serverNowNs?.() ?? monotonicNs()),
        t: now,
      },
      pcm.buffer,
    );
    if (sent) {
      this.sent += 1;
      sendCodecs.add(bits === 24 ? 'pcm24' : 'pcm16');
      this._emit('level', { id, level: peak });
    } else {
      this.dropped += 1;
    }
  }

  /**
   * How deep the PCM fallback can afford to be right now.
   *
   * 24-bit is the standard the voice path runs at (see `shared/audio.ts`), but it is three
   * bytes a sample - 144 KB/s at 48 kHz - and the relay is a fallback path with a small
   * socket budget. When the socket is already half full, the depth steps down rather than
   * dropping the slice: the room keeps hearing the voice, and the header says which depth
   * this slice is so the far end decodes it correctly.
   */
  _pcmBits() {
    const backlog = this.socket?.socket?.bufferedAmount ?? 0;
    return backlog > this.maxBufferedBytes / 2 ? 16 : RELAY_PCM_BITS;
  }

  /**
   * Float samples to PCM, little-endian, at the rate the wire expects - 24-bit by
   * default, 16-bit when the socket cannot carry the depth.
   *
   * A browser can mix above 48 kHz (96 kHz on some audio hardware); when it does, the
   * samples that are skipped are averaged rather than dropped, so a voice does not alias -
   * and 24 bits keep the quiet end of it above the quantisation noise.
   */
  _toPcm(input: Float32Array, bits = RELAY_PCM_BITS) {
    const rate = this.context?.sampleRate || RELAY_PCM_RATE;
    const step = rate > RELAY_PCM_RATE ? rate / RELAY_PCM_RATE : 1;
    const count = step > 1 ? Math.floor(input.length / step) : input.length;
    const width = bits / 8;
    const pcm = new Uint8Array(count * width);
    for (let i = 0; i < count; i += 1) {
      let sample;
      if (step > 1) {
        // Average the samples we are skipping, so voices do not alias.
        const start = Math.floor(i * step);
        const end = Math.min(input.length, Math.floor((i + 1) * step));
        let sum = 0;
        for (let j = start; j < end; j += 1) sum += input[j];
        sample = sum / Math.max(1, end - start);
      } else {
        sample = input[i];
      }
      const clamped = Math.max(-1, Math.min(1, sample));
      const at = i * width;
      if (width === RELAY_PCM_BYTES) {
        // Two's complement, little-endian: -1 is 0x800000 and 1 is 0x7fffff, so full
        // scale lands exactly where the receiving end divides it back from.
        const value =
          Math.round(clamped < 0 ? clamped * (RELAY_PCM_MAX + 1) : clamped * RELAY_PCM_MAX) & 0xffffff;
        pcm[at] = value & 0xff;
        pcm[at + 1] = (value >> 8) & 0xff;
        pcm[at + 2] = (value >> 16) & 0xff;
      } else {
        const value = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
        pcm[at] = value & 0xff;
        pcm[at + 1] = (value >> 8) & 0xff;
      }
    }
    return pcm;
  }

  _ensureContext() {
    const ctx = relayAudioContext();
    if (!ctx) return null;
    this.context = ctx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  _emit(type: string, detail: any) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export default AudioRelay;
