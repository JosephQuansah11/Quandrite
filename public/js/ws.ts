/**
 * WebSocket client for the Quandrite protocol.
 *
 * Request/response calls are promise based (`send()` resolves with the ack),
 * and server pushes are dispatched as events named after the protocol type so
 * callers can subscribe with `socket.on('stream:update', handler)`.
 */

import { CLIENT, SERVER } from '/shared/protocol.js';

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
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
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
    this._emit(message.type, message);
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

  _flushBackpressure() {
    const queue = this.backpressureQueue;
    this.backpressureQueue = [];
    for (const frame of queue) this.sendBinary(frame);
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
    this.socket?.close();
  }
}

export default QuandriteSocket;
