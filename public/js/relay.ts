/**
 * Socket-relayed pictures.
 *
 * The room's cameras and screens travel peer to peer first: it is faster and it
 * costs the server nothing. But two networks will not always let the browsers
 * reach each other (symmetric NAT, corporate Wi-Fi, mobile data), and then the
 * room would see nothing at all. So the same picture is posted over the
 * WebSocket the studio already uses, at a low frame rate and a modest size, and
 * the server fans it out to the room.
 *
 * The frames are JPEG, tagged with the source they came from, so a relayed
 * camera or screen can be shown in the room *and* composited onto the program.
 * Each one carries a nanosecond capture stamp on the server's clock (`tns`), so
 * the room can say exactly how long it spent on the wire - see the time-base note
 * in `shared/protocol.ts`.
 */

import { monotonicNs, nsToWire } from '/shared/protocol.js';
import { QualityLadder, RELAY_LADDER, ladderIndexForNetwork } from './quality.js';

export class MediaRelay extends EventTarget {

  // --- state (typed loosely while the class is migrated) ---
  _busy: any;
  _capturedNs: any;
  _interval: any;
  _measuredKbps: any;
  _windowBytes: any;
  _windowStartedAt: any;
  bytes: any;
  canvasWidth: any;
  dropped: any;
  fps: any;
  ladder: any;
  logger: any;
  maxBufferedBytes: any;
  quality: any;
  sent: any;
  socket: any;
  sources: any;
  targetFps: any;
  targetQuality: any;
  timer: any;
  constructor({
    socket,
    logger = console,
    // The picture that goes over the socket is a fallback, but it should still look
    // like the thing it stands in for. The ladder decides *how good* it can be from
    // how the sending is actually going, so a good link gets a sharp 1080p and a
    // poor one gets a smaller picture that keeps moving.
    ladder = null,
    startIndex = 0,
    maxBufferedBytes = 64 * 1024,
  }: any = {}) {
    super();
    this.socket = socket;
    this.logger = logger;
    this.ladder = new QualityLadder({ ladder: ladder || RELAY_LADDER, startIndex });
    this.maxBufferedBytes = maxBufferedBytes;
    this.sources = new Map();
    this.timer = null;
    this._busy = false;
    this.dropped = 0;
    this.sent = 0;
    this.bytes = 0;
    this._windowBytes = 0;
    this._windowStartedAt = Date.now();
    this._measuredKbps = 0;
    this.fps = this.ladder.rung.fps;
    this.quality = this.ladder.rung.quality;
    this.targetFps = this.ladder.rung.fps;
    this.targetQuality = this.ladder.rung.quality;
    this.canvasWidth = this.ladder.rung.width;
    this._interval = Math.round(1000 / this.fps);
  }

  get publishing() {
    return this.sources.size > 0;
  }

  get ids() {
    return [...this.sources.keys()];
  }

  /** Start posting `stream` (a camera or a screen) as low-rate pictures. */
  add({ id, kind = 'camera', label = null, stream }) {
    if (!id || !stream || this.sources.has(id)) return false;
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    video.play().catch(() => {});
    // A screen share is text, so it is worth more pixels than a talking head when
    // the ladder has to choose: it keeps its place at the front of the queue.
    this.sources.set(id, { id, kind, label, video, canvas: null, priority: kind === 'screen' ? 0 : 1 });
    this._ensureTimer();
    this._emit('sources', { ids: this.ids });
    return true;
  }

  remove(id) {
    const entry = this.sources.get(id);
    if (!entry) return false;
    entry.video.srcObject = null;
    this.sources.delete(id);
    if (!this.sources.size) this.stop();
    this._emit('sources', { ids: this.ids });
    return true;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const entry of this.sources.values()) entry.video.srcObject = null;
    this.sources.clear();
    this._emit('sources', { ids: [] });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick().catch(() => {}), this._interval);
  }

  /**
   * One picture at a time, and never a queue.
   *
   * This is the "conflate" idea (what Akka Streams would call it): when the
   * encoder or the socket is still busy, this frame is *dropped* rather than
   * queued, because the next one is already fresher. A queue would keep every
   * frame and put the room further and further behind real time; dropping keeps
   * the delay flat, which is what matters for a call.
   */
  async _tick() {
    if (this._busy) {
      this.dropped += 1;
      return;
    }
    this._busy = true;
    const startedAt = Date.now();
    try {
      for (const entry of this.sources.values()) await this._send(entry);
    } finally {
      this._busy = false;
      this._adapt(Date.now() - startedAt);
    }
  }

  /**
   * Keep the rate inside what the network is actually carrying.
   *
   * Slow frames, a filling socket or a slow encoder all mean "send less"; when
   * everything is comfortable again the rate walks back up to the target. The
   * point is that the delay stays flat instead of growing with the backlog.
   */
  _adapt(elapsedMs) {
    const backlog = this.socket?.socket?.bufferedAmount ?? 0;
    const struggling = elapsedMs > this._interval * 0.9 || backlog > this.maxBufferedBytes / 2;
    // Within a rung, the rate still moves: a burst of frames is thinned out, and a
    // quiet stretch lets it come back.
    const rung = this.ladder.rung;
    if (struggling) {
      this.fps = Math.max(1, this.fps - 1);
      this.quality = Math.max(0.3, Number((this.quality - 0.05).toFixed(2)));
    } else {
      this.fps = Math.min(rung.fps, this.fps + 0.25);
      this.quality = Math.min(rung.quality, Number((this.quality + 0.02).toFixed(2)));
    }
    // ...and the ladder moves between rungs: down when the link is struggling, up
    // only after it has been comfortable for a while.
    const before = this.ladder.index;
    const chosen = this.ladder.note({ struggling, now: Date.now() });
    if (this.ladder.index !== before) {
      this.fps = chosen.fps;
      this.quality = chosen.quality;
      this.canvasWidth = chosen.width;
      this._emit('quality', { rung: chosen, index: this.ladder.index, measuredKbps: this._measuredKbps });
    }
    const interval = Math.max(120, Math.round(1000 / this.fps));
    if (interval !== this._interval) {
      this._interval = interval;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        this._ensureTimer();
      }
    }
  }

  /** How fast the socket has actually been carrying frames, in kilobits a second. */
  _measure() {
    const now = Date.now();
    const elapsed = now - this._windowStartedAt;
    if (elapsed < 1000) return this._measuredKbps;
    this._measuredKbps = Math.round((this._windowBytes * 8) / elapsed);
    this._windowBytes = 0;
    this._windowStartedAt = now;
    return this._measuredKbps;
  }

  /** The browser says the network changed: start again from what it reports. */
  noteNetworkHint(connection) {
    const rung = this.ladder.reset(ladderIndexForNetwork(connection, this.ladder.ladder));
    this.fps = rung.fps;
    this.quality = rung.quality;
    this.canvasWidth = rung.width;
    this._emit('quality', { rung, index: this.ladder.index, measuredKbps: this._measuredKbps, hint: true });
    return rung;
  }

  async _send(entry) {
    const video = entry.video;
    if (!video?.videoWidth) return;
    // The socket is already behind: skipping this frame is what keeps the picture
    // live instead of late.
    if ((this.socket?.socket?.bufferedAmount ?? 0) > this.maxBufferedBytes) {
      this.dropped += 1;
      return;
    }
    const scale = Math.min(1, (this.ladder.rung.width || this.canvasWidth) / video.videoWidth);
    const width = Math.max(2, Math.round(video.videoWidth * scale));
    const height = Math.max(2, Math.round(video.videoHeight * scale));
    const canvas = entry.canvas || (entry.canvas = document.createElement('canvas'));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0, width, height);
    // Stamp the moment the picture was taken: encoding below is asynchronous, and
    // that cost is part of the lag the room should be able to see.
    this._capturedNs = this.socket.serverNowNs?.() ?? monotonicNs();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', this.quality));
    if (!blob) return;
    const payload = await blob.arrayBuffer();
    // Stamp the picture on the shared (server) clock, in nanoseconds: when it was
    // taken, not when it was finished encoding. That is what the room measures the
    // lag against, so a slow encoder shows up as lag rather than hiding in it.
    const capturedNs = this._capturedNs ?? this.socket.serverNowNs?.() ?? monotonicNs();
    this._capturedNs = null;
    const sent = this.socket.sendRelayFrame(
      {
        sourceId: entry.id,
        kind: entry.kind,
        label: entry.label,
        w: width,
        h: height,
        // The rung this picture belongs to, so the room can see the quality it is
        // being sent at rather than guessing.
        rung: this.ladder.name,
        tns: nsToWire(capturedNs),
        // The wall clock in milliseconds stays, for logs and for older clients.
        t: Date.now(),
      },
      payload,
    );
    if (sent) {
      this.sent += 1;
      this.bytes += payload.byteLength;
      this._windowBytes += payload.byteLength;
      this._measure();
    } else {
      this.dropped += 1;
    }
  }

  /** How the relay is doing: the rung it settled on and what it threw away. */
  stats() {
    const rung = this.ladder.rung;
    return {
      rung: rung?.name || null,
      width: rung?.width || null,
      fps: this.fps,
      quality: this.quality,
      sent: this.sent,
      dropped: this.dropped,
      bytes: this.bytes,
      measuredKbps: this._measuredKbps,
      intervalMs: this._interval,
      atCeiling: this.ladder.atCeiling,
      sources: [...this.sources.values()].map((entry) => ({ id: entry.id, kind: entry.kind })),
    };
  }
}

export default MediaRelay;
