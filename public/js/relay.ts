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
 */

export class MediaRelay extends EventTarget {

  // --- state (typed loosely while the class is migrated) ---
  _busy: any;
  canvasWidth: any;
  fps: any;
  logger: any;
  quality: any;
  socket: any;
  sources: any;
  timer: any;
  constructor({ socket, logger = console, canvasWidth = 480, fps = 4, quality = 0.5 }: any = {}) {
    super();
    this.socket = socket;
    this.logger = logger;
    this.canvasWidth = canvasWidth;
    this.fps = fps;
    this.quality = quality;
    this.sources = new Map();
    this.timer = null;
    this._busy = false;
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
    this.sources.set(id, { id, kind, label, video, canvas: null });
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
    this.timer = setInterval(() => this._tick().catch(() => {}), Math.round(1000 / this.fps));
  }

  async _tick() {
    // One picture at a time: encoding is slower than the interval on a busy tab.
    if (this._busy) return;
    this._busy = true;
    try {
      for (const entry of this.sources.values()) await this._send(entry);
    } finally {
      this._busy = false;
    }
  }

  async _send(entry) {
    const video = entry.video;
    if (!video?.videoWidth) return;
    const scale = Math.min(1, this.canvasWidth / video.videoWidth);
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
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', this.quality));
    if (!blob) return;
    const payload = await blob.arrayBuffer();
    this.socket.sendRelayFrame(
      { sourceId: entry.id, kind: entry.kind, label: entry.label, w: width, h: height },
      payload,
    );
  }
}

export default MediaRelay;
