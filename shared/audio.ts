/**
 * Audio quality.
 *
 * Voice is carried by two different stacks - WebRTC when two browsers can reach each
 * other, and the socket relay when they cannot - and both are quiet by default in ways
 * nobody asked for:
 *
 *  - WebRTC's Opus sender starts at about 32 kbps, mono, with **DTX on**, which stops
 *    sending during quiet passages. That is fine for a phone call and wrong for a studio:
 *    it thins music and makes a soft voice drop out. The encoder's real settings live in
 *    the SDP (`a=fmtp:<pt> ...`), not in `setParameters`, so this module rewrites them.
 *  - The relay used to send 16 kHz 16-bit PCM: telephone bandwidth, 256 kbps on the wire,
 *    and no compression to spend on quality. Opus at 48 kHz costs a fraction of that and
 *    sounds like the room.
 *
 * The numbers here are the ones both ends have to agree on, so they live in `shared/`.
 */

/** What a shared screen's audio (music, a video, system sound) is worth. */
export const MUSIC_BITRATE_BPS = 128_000;
/** ...and a microphone, which is speech and needs less. */
export const VOICE_BITRATE_BPS = 96_000;
/** The ceiling the relay asks Opus for: mono voice, transparent enough for speech. */
export const RELAY_OPUS_VOICE_BITRATE_BPS = 48_000;
/** ...and for a shared screen's sound, which may be music. */
export const RELAY_OPUS_MUSIC_BITRATE_BPS = 96_000;
/** The relay captures and encodes at full quality; PCM is the fallback, not the target. */
export const RELAY_CAPTURE_RATE = 48_000;
/** Opus is happiest in 20 ms frames, and so is a jitter buffer. */
export const RELAY_OPUS_FRAME_MS = 20;
/** Channels the relay encodes: a microphone is one, a shared screen may be two. */
export const RELAY_MONO = 1;
export const RELAY_STEREO = 2;

/**
 * Rewrite an SDP so its Opus carries what a studio needs.
 *
 * The payload type of Opus is dynamic, so it is read from the `rtpmap` line and the
 * matching `fmtp` line is rewritten - created if the browser did not send one, right
 * after the `rtpmap` where a parser expects it. Anything without Opus (no audio, or a
 * codec this does not know) is returned untouched.
 */
export function preferOpus(sdp, options: any = {}) {
  const text = String(sdp || '');
  const {
    maxaveragebitrate = VOICE_BITRATE_BPS,
    stereo = false,
    useinbandfec = true,
    usedtx = false,
    minptime = 10,
  } = options;

  const mapping = /a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?/i.exec(text);
  if (!mapping) return text;
  const payloadType = mapping[1];

  // In-band FEC costs a little bitrate and hides packet loss, which is the difference
  // between a glitch and a hole in somebody's sentence.
  const wanted = {
    minptime: String(minptime),
    useinbandfec: useinbandfec ? '1' : '0',
    usedtx: usedtx ? '1' : '0',
    stereo: stereo ? '1' : '0',
    'sprop-stereo': stereo ? '1' : '0',
    maxaveragebitrate: String(Math.round(maxaveragebitrate)),
  };

  const line = new RegExp(`a=fmtp:${payloadType} ([^\\r\\n]*)`, 'i');
  const existing = line.exec(text);
  const params = new Map<string, string>();
  for (const pair of String(existing?.[1] ?? '').split(';')) {
    const [key, value] = pair.split('=');
    if (key && key.trim()) params.set(key.trim(), (value ?? '').trim());
  }
  // What the browser already said stays, unless it is one of the things we are setting.
  for (const [key, value] of Object.entries(wanted)) params.set(key, value);
  const rewritten = `a=fmtp:${payloadType} ${[...params]
    .map(([key, value]) => (value === '' ? key : `${key}=${value}`))
    .join(';')}`;

  if (existing) return text.replace(line, rewritten);
  return text.replace(
    new RegExp(`(a=rtpmap:${payloadType}[^\\r\\n]*)`, 'i'),
    `$1\r\n${rewritten}`,
  );
}

/** The Opus parameters an SDP actually carries, for the studio's diagnostics. */
export function opusParameters(sdp) {
  const text = String(sdp || '');
  const mapping = /a=rtpmap:(\d+)\s+opus\/48000(?:\/(\d+))?/i.exec(text);
  if (!mapping) return null;
  const params: any = {};
  const fmtp = new RegExp(`a=fmtp:${mapping[1]} ([^\\r\\n]*)`, 'i').exec(text);
  for (const pair of String(fmtp?.[1] ?? '').split(';')) {
    const [key, value] = pair.split('=');
    if (key && key.trim()) params[key.trim()] = (value ?? '').trim();
  }
  return {
    payloadType: Number(mapping[1]),
    channels: Number(mapping[2] || 1),
    maxaveragebitrate: Number(params.maxaveragebitrate) || null,
    stereo: params.stereo === '1',
    useinbandfec: params.useinbandfec === '1',
    usedtx: params.usedtx === '1',
    minptime: Number(params.minptime) || null,
  };
}

/**
 * The audio constraints a device should be opened with.
 *
 * A microphone is speech: echo cancellation, noise suppression and a steady level all
 * help, and one channel is all it has. A **shared screen** is the opposite - it may be
 * music, and every one of those three processors would damage it - so they are turned
 * off and stereo is kept. Asking for 48 kHz keeps the whole path at one rate, which is
 * what stops a quiet resample from being the thing that limits the sound.
 */
export function microphoneConstraints(deviceId: string | null = null) {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: RELAY_CAPTURE_RATE,
  };
}

export function screenAudioConstraints() {
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: RELAY_STEREO,
    sampleRate: RELAY_CAPTURE_RATE,
  };
}
