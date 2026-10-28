/**
 * Program publisher.
 *
 * Encodes the composited program stream with MediaRecorder and streams the
 * resulting WebM chunks to the server over the WebSocket. The server pipes them
 * straight into ffmpeg, which fans them out to every platform and the
 * recording file.
 */

const MIME_CANDIDATES = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
  'video/mp4',
];

export class StreamPublisher extends EventTarget {

  // --- state (typed loosely while the class is migrated) ---
  audioBitsPerSecond: any;
  bytes: any;
  chunks: any;
  compositor: any;
  dropped: any;
  logger: any;
  recorder: any;
  recorderStream: any;
  socket: any;
  startedAt: any;
  timesliceMs: any;
  videoBitsPerSecond: any;
  /** How long a change of on-air video waits for the burst of changes to settle. */
  trackSwitchDelayMs: any;
  _rebuildTimer: any;
  _rebuilds: any;
  constructor({
    socket,
    compositor,
    videoBitsPerSecond = 6_000_000,
    audioBitsPerSecond = 160_000,
    timesliceMs = 500,
    trackSwitchDelayMs = 800,
    logger = console,
  }: any = {}) {
    super();
    this.socket = socket;
    this.compositor = compositor;
    this.videoBitsPerSecond = videoBitsPerSecond;
    this.audioBitsPerSecond = audioBitsPerSecond;
    this.timesliceMs = timesliceMs;
    this.trackSwitchDelayMs = trackSwitchDelayMs;
    this._rebuildTimer = null;
    this._rebuilds = 0;
    this.logger = logger;
    this.recorder = null;
    this.recorderStream = null;
    this.startedAt = null;
    this.chunks = 0;
    this.bytes = 0;
    this.dropped = 0;
  }

  get active() {
    return Boolean(this.recorder) && this.recorder.state !== 'inactive';
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const candidate of MIME_CANDIDATES) {
      try {
        if (MediaRecorder.isTypeSupported(candidate)) return candidate;
      } catch {
        // keep looking
      }
    }
    return '';
  }

  start(stream = null) {
    if (this.active) return false;
    if (typeof MediaRecorder === 'undefined') {
      this._emit('error', { message: 'this browser cannot encode a livestream (MediaRecorder missing)' });
      return false;
    }

    const source = stream || this.compositor.programStream();
    const mimeType = this.pickMimeType();
    try {
      this.recorder = new MediaRecorder(source, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: this.videoBitsPerSecond,
        audioBitsPerSecond: this.audioBitsPerSecond,
      });
    } catch (error) {
      this._emit('error', { message: `could not start the encoder: ${error.message}` });
      return false;
    }
    this.recorderStream = source;

    this.chunks = 0;
    this.bytes = 0;
    this.dropped = 0;
    this.startedAt = Date.now();

    this.recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      event.data
        .arrayBuffer()
        .then((buffer) => {
          const sent = this.socket.sendBinary(buffer);
          this.chunks += 1;
          if (sent) this.bytes += buffer.byteLength;
          else this.dropped += 1;
          this._emit('stats', this.stats());
        })
        .catch((error) => this.logger.warn?.('chunk failed', error));
    };

    this.recorder.onerror = (event) => {
      this._emit('error', { message: event.error?.message || 'encoder error' });
    };

    this.recorder.onstop = () => {
      this._emit('stopped', this.stats());
    };

    this.recorder.start(this.timesliceMs);
    this._emit('started', this.stats());
    return true;
  }

  /**
   * Keep the encoder on the real on-air video.
   *
   * The program picture follows the studio (another camera, the grid, an overlay),
   * and the encoder is bound to the tracks it started with - so when the video
   * source changes while live, the recorder is rebuilt on the new one.
   *
   * The rebuild is **delayed and coalesced**, because a change rarely arrives
   * alone: a source list settling, a scene switch or somebody's camera coming and
   * going all fire in a burst, and each rebuild restarts the stream ffmpeg is
   * reading - which the audience sees as a blink. Waiting for the burst to finish
   * turns several restarts into one, and if the picture settles back to where it
   * was there is no restart at all.
   */
  syncVideoTrack() {
    if (!this.active) return false;
    const wanted = this.compositor.programVideoTrack();
    const current = this.recorderStream?.getVideoTracks?.()[0] || null;
    if (!wanted || wanted === current) return false;
    if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => {
      this._rebuildTimer = null;
      if (!this.active) return;
      const settled = this.compositor.programVideoTrack();
      const live = this.recorderStream?.getVideoTracks?.()[0] || null;
      if (!settled || settled === live) return;
      this._rebuilds += 1;
      const stream = this.compositor.programStream();
      this.stop();
      this.start(stream);
    }, this.trackSwitchDelayMs);
    return true;
  }

  stop() {
    if (this._rebuildTimer) {
      clearTimeout(this._rebuildTimer);
      this._rebuildTimer = null;
    }
    if (!this.recorder) return false;
    try {
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {
      // already stopped
    }
    this.recorder = null;
    return true;
  }

  stats() {
    return {
      active: this.active,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      chunks: this.chunks,
      bytes: this.bytes,
      dropped: this.dropped,
      mimeType: this.recorder?.mimeType || null,
      // How often the encoder has been rebuilt on a new video source: each one is
      // a restart of the stream ffmpeg is reading, so this should stay small.
      rebuilds: this._rebuilds,
    };
  }
}

export default StreamPublisher;
