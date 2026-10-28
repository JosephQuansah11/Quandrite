/**
 * WebSocket client for the Quandrite protocol.
 *
 * Request/response calls are promise based (`send()` resolves with the ack),
 * and server pushes are dispatched as events named after the protocol type so
 * callers can subscribe with `socket.on('stream:update', handler)`. A push that
 * carries a `payload` is dispatched as that payload, not as the envelope.
 */

import { CLIENT, SERVER, CLOCK_SYNC_INTERVAL_MS, clockOffsetNs, decodeRelayFrame, encodeRelayFrame, isRelayFrame, monotonicNs, nsToWire, pushPayload } from '/shared/protocol.js';

export class QuandriteSocket extends EventTarget {

  // --- state (typed loosely while the class is migrated) ---
  attempt: any;
  autoReconnect: any;
  backpressureQueue: any;
  counter: any;
  logger: any;
  manualClose: any;
  pending: any;
  socket: any;
  url: any;
  constructor({ url, autoReconnect = true, logger = console }: any = {}) {
    super();
    this.url = url;
    this.autoReconnect = autoReconnect;
    this.logger = logger;
    this.socket = null;
    this.pending = new Map();
    this.counter = 0;
    this.attempt = 0;
    this.manualClose = false;
    this.backpressureQueue = [];
    // Nanosecond clock state: my offset to the server's clock, and the samples it
    // was estimated from.
    this.clockOffsetNs = null;
    this.clockRoundTripNs = null;
    this.clockSamples = [];
    this.clockTimer = null;

  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect() {
    this.manualClose = false;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return this;
    }

    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this._emit('open', {});
      this._flushBackpressure();
      // The relay's nanosecond stamps are only meaningful against the server's
      // clock, so measure the offset as soon as there is a connection.
      this.startClockSync();
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        this._handleBinary(event.data);
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        this.logger.warn?.('received malformed message from server');
        return;
      }
      this._handle(message);
    });

    socket.addEventListener('close', () => {
      this._emit('close', {});
      for (const [, entry] of this.pending) {
        entry.reject(new Error('connection closed'));
      }
      this.pending.clear();
      if (!this.manualClose && this.autoReconnect) this._scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      this._emit('socket-error', {});
    });

    return this;
  }

  _scheduleReconnect() {
    this.attempt += 1;
    const delay = Math.min(15000, 500 * 2 ** Math.min(this.attempt, 5));
    setTimeout(() => {
      if (!this.manualClose) this.connect();
    }, delay);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * Dispatch one server message.
   *
   * Studio pushes carry their body in `payload` and are dispatched as that
   * payload, so `socket.on('sources:update', (sources) => ...)` really gets the
   * array of sources; the flat messages are dispatched whole. See `pushPayload`.
   */
  _handle(message) {
    if (message.type === SERVER.ACK || message.type === SERVER.ERROR) {
      const entry = message.id ? this.pending.get(message.id) : null;
      if (entry) {
        this.pending.delete(message.id);
        if (message.type === SERVER.ACK) entry.resolve(message.result ?? {});
        else entry.reject(new Error(message.message || 'request failed'));
        return;
      }
    }
    if (message.type === SERVER.ERROR) {
      this._emit('server-error', message);
      return;
    }
    this._emit(message.type, pushPayload(message));
  }

  /**
   * Send a protocol request and resolve with the server ack.
   * @returns {Promise<object>}
   */
  send(type, payload: any = {}, { timeoutMs = 15000 }: any = {}) {
    if (!this.connected) return Promise.reject(new Error('not connected to the server'));
    this.counter += 1;
    const id = `${this.counter}-${Date.now().toString(36)}`;
    const envelope = { type, ...payload, id };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify(envelope));
    });
  }

  /** Send a binary frame (the program feed) without waiting for an ack. */
  sendBinary(buffer) {
    if (!this.connected) return false;
    if (this.socket.bufferedAmount > 4 * 1024 * 1024) {
      // Keep memory bounded: drop the frame instead of queueing unbounded data.
      this._emit('backpressure', { bufferedAmount: this.socket.bufferedAmount });
      return false;
    }
    this.socket.send(buffer);
    return true;
  }

  /**
   * Binary frames: a relayed camera/screen picture, or a program chunk.
   *
   * Relayed pictures are dispatched as `media:frame`; program chunks as
   * `media:chunk` (the publisher's own feed coming back is ignored upstream).
   */
  _handleBinary(data) {
    const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (isRelayFrame(buffer)) {
      const decoded = decodeRelayFrame(buffer);
      if (decoded) this._emit('media:frame', decoded);
      return;
    }
    this._emit('media:chunk', { data: buffer });
  }

  /**
   * Post one relayed picture.
   *
   * Used when peer-to-peer cannot carry the camera or the screen, so the room
   * still sees it over the socket the studio already uses. A socket that is
   * already behind is not worth adding to: queueing here would only mean the
   * picture arrives later than it was taken.
   */
  sendRelayFrame(header, payload) {
    if (!this.connected) return false;
    if (this.socket.bufferedAmount > 256 * 1024) return false;
    try {
      this.socket.send(encodeRelayFrame(header, payload));
      return true;
    } catch {
      return false;
    }
  }

  _flushBackpressure() {
    const queue = this.backpressureQueue;
    this.backpressureQueue = [];
    for (const frame of queue) this.sendBinary(frame);
  }

  /**
   * Measure the offset between my clock and the server's, in nanoseconds.
   *
   * This is the exchange that makes nanosecond stamps mean anything: without it a
   * stamp from another device is a number on a different clock, and the "lag"
   * between them would be the difference between two wall clocks (seconds) rather
   * than the time the picture spent on the wire. The reply carries the server's
   * clock twice - on receipt and on send - so half the round trip can be taken off
   * and what is left is the offset. The round trip is also the error bound, so the
   * best sample wins rather than the latest.
   */
  syncClock() {
    if (!this.connected) return Promise.resolve(null);
    this.counter += 1;
    const id = `clock-${this.counter}`;
    const t0 = monotonicNs();
    return new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        off();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 4000);
      const off = this.on(SERVER.TIME_SYNC, (payload) => {
        if (payload?.id !== id) return;
        const sample = clockOffsetNs({ t0, t1: payload.t1, t2: payload.t2, t3: monotonicNs() });
        if (sample) this._keepClockSample(sample);
        finish(sample);
      });
      try {
        this.socket.send(JSON.stringify({ type: CLIENT.TIME_SYNC, id }));
      } catch {
        finish(null);
      }
    });
  }

  /**
   * Keep the few best samples.
   *
   * A sample can only be wrong in one direction - a queue anywhere along the way
   * adds delay - so the lowest round trips are the honest ones, and averaging them
   * smooths out the jitter without dragging the estimate around.
   */
  _keepClockSample(sample) {
    this.clockSamples.push(sample);
    this.clockSamples.sort((a, b) => (a.roundTripNs < b.roundTripNs ? -1 : a.roundTripNs > b.roundTripNs ? 1 : 0));
    this.clockSamples = this.clockSamples.slice(0, 5);
    let total = 0n;
    for (const entry of this.clockSamples) total += entry.offsetNs;
    this.clockOffsetNs = total / BigInt(this.clockSamples.length);
    this.clockRoundTripNs = this.clockSamples[0].roundTripNs;
    this._emit('clock', {
      offsetNs: nsToWire(this.clockOffsetNs),
      roundTripNs: nsToWire(this.clockRoundTripNs),
      samples: this.clockSamples.length,
    });
  }

  /** Measure now, and keep measuring: clocks drift and networks change. */
  startClockSync() {
    if (this.clockTimer) return;
    this.syncClock().catch(() => {});
    this.clockTimer = setInterval(() => this.syncClock().catch(() => {}), CLOCK_SYNC_INTERVAL_MS);
  }

  stopClockSync() {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  /**
   * The server's clock, as well as this machine can tell.
   *
   * Everything the relay stamps is on this clock, so a stamp from any device can be
   * compared with a reading from any other - which is the whole point.
   */
  serverNowNs() {
    return monotonicNs() + (this.clockOffsetNs || 0n);
  }

  /** How well the offset is known: the round trip of the best sample. */
  clockAccuracyNs() {
    return this.clockRoundTripNs === null ? null : this.clockRoundTripNs / 2n;
  }

  on(type, handler) {
    const wrapped = (event) => handler(event.detail);
    this.addEventListener(type, wrapped);
    return () => this.removeEventListener(type, wrapped);
  }

  async join({ roomId, name, role, password }) {
    const result = await this.send(CLIENT.JOIN, { roomId, name, role, password });
    return result;
  }

  close() {
    this.manualClose = true;
    this.stopClockSync();
    this.socket?.close();
  }
}

export default QuandriteSocket;
