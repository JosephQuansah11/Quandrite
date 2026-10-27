/**
 * Outbound relay process.
 *
 * One `ffmpeg` process per live broadcast: the browser compositor streams the
 * finished program picture into stdin, and ffmpeg encodes it once and fans the
 * result out to every platform plus the recording file.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { buildRelayArgs, detectRelayError } from './ffmpeg.ts';

export class StreamRelay extends EventEmitter {

  // --- state (typed loosely while the class is migrated) ---
  _lastSampleAt: any;
  _lastSampleBytes: any;
  _liveTimer: any;
  _metricsTimer: any;
  _restartTimer: any;
  audioBitrateKbps: any;
  bytesIn: any;
  child: any;
  endedAt: any;
  error: any;
  exitCode: any;
  ffmpegBin: any;
  inputFormat: any;
  logger: any;
  measuredBitrateKbps: any;
  options: any;
  preset: any;
  restartTimes: any;
  roomId: any;
  startedAt: any;
  status: any;
  stderrTail: any;
  stopReason: any;
  stopping: any;
  targets: any;
  /**
   * @param {object} options
   * @param {string} options.ffmpegBin
   * @param {string} options.roomId
   * @param {string} options.preset
   * @param {Array<object>} options.targets tee targets (rtmp + file)
   */
  constructor({
    ffmpegBin,
    roomId,
    preset = '1080p30',
    targets = [],
    inputFormat = 'matroska',
    audioBitrateKbps = 160,
    relayOptions = {},
    logger = console,
  }: any = {}) {
    super();
    this.ffmpegBin = ffmpegBin;
    this.roomId = roomId;
    this.preset = preset;
    this.targets = targets;
    this.inputFormat = inputFormat;
    this.audioBitrateKbps = audioBitrateKbps;
    this.logger = logger;
    this.options = {
      liveDelayMs: 900,
      stopTimeoutMs: 6000,
      maxRestarts: 3,
      restartWindowMs: 60000,
      restartDelayMs: 1500,
      ...relayOptions,
    };

    this.status = 'idle';
    this.child = null;
    this.startedAt = null;
    this.endedAt = null;
    this.bytesIn = 0;
    this.exitCode = null;
    this.error = null;
    this.stderrTail = '';
    this.restartTimes = [];
    this.stopping = false;
    this.measuredBitrateKbps = 0;

    this._liveTimer = null;
    this._restartTimer = null;
    this._metricsTimer = null;
    this._lastSampleBytes = 0;
    this._lastSampleAt = 0;
  }

  get command() {
    return [
      this.ffmpegBin,
      ...buildRelayArgs({
        inputFormat: this.inputFormat,
        preset: this.preset,
        targets: this.targets,
        audioBitrateKbps: this.audioBitrateKbps,
      }),
    ];
  }

  start() {
    if (this.child) return false;
    this.stopping = false;
    this.endedAt = null;
    this.restartTimes = [];
    this._spawn();
    return true;
  }

  _spawn() {
    const args = buildRelayArgs({
      inputFormat: this.inputFormat,
      preset: this.preset,
      targets: this.targets,
      audioBitrateKbps: this.audioBitrateKbps,
    });

    this.emit('log', { level: 'info', message: `relay spawn: ${this.ffmpegBin} ${args.join(' ')}` });

    let child;
    try {
      child = spawn(this.ffmpegBin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (error) {
      this._fail(error);
      return;
    }

    this.child = child;
    this.exitCode = null;
    this.error = null;
    if (!this.startedAt) this.startedAt = Date.now();
    this._lastSampleAt = Date.now();
    this._lastSampleBytes = this.bytesIn;
    this._setStatus(this.restartTimes.length ? 'reconnecting' : 'connecting');

    // ffmpeg closing stdin early surfaces as EPIPE; that is expected on teardown.
    child.stdin.on('error', () => {});

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
      const detected = detectRelayError(chunk);
      if (detected) this.error = detected;
      const trimmed = String(chunk).trim();
      if (trimmed) this.emit('log', { level: 'warn', message: trimmed });
      this.emit('stderr', chunk);
    });

    child.on('error', (error) => this._fail(error));
    child.on('exit', (code, signal) => this._onExit(code, signal));

    this._liveTimer = setTimeout(() => {
      if (this.child !== child) return;
      if (this.status === 'connecting' || this.status === 'reconnecting') {
        this._setStatus('live');
      }
    }, this.options.liveDelayMs);

    if (!this._metricsTimer) {
      this._metricsTimer = setInterval(() => this._sampleMetrics(), 2000);
      if (typeof this._metricsTimer.unref === 'function') this._metricsTimer.unref();
    }
  }

  _sampleMetrics() {
    const now = Date.now();
    const elapsedMs = now - this._lastSampleAt;
    if (elapsedMs <= 0) return;
    const deltaBytes = this.bytesIn - this._lastSampleBytes;
    this._lastSampleBytes = this.bytesIn;
    this._lastSampleAt = now;
    this.measuredBitrateKbps = Math.round((deltaBytes * 8) / elapsedMs);
    this.emit('metrics', this.snapshot());
  }

  /**
   * Feed one program chunk into ffmpeg.
   * @returns {boolean} false when the caller should apply backpressure
   */
  write(chunk) {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    this.bytesIn += chunk.length;
    return stdin.write(chunk);
  }

  /** Resolves once ffmpeg has drained its stdin buffer (backpressure relief). */
  whenDrained() {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return Promise.resolve();
    if (stdin.writableLength === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 2000);
      if (typeof timer.unref === 'function') timer.unref();
      stdin.once('drain', done);
    });
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', this.snapshot());
  }

  _fail(error) {
    this.error = error?.message || String(error);
    this._setStatus('error');
    this.emit('failed', { error: this.error });
  }

  _onExit(code, signal) {
    this.child = null;
    if (this._liveTimer) {
      clearTimeout(this._liveTimer);
      this._liveTimer = null;
    }
    this.exitCode = code;

    if (this.stopping || code === 0) {
      this.endedAt = Date.now();
      this._setStatus('ended');
      this.emit('stopped', {
        code,
        signal,
        bytesIn: this.bytesIn,
        error: this.stopping ? this.error : null,
      });
      return;
    }

    const now = Date.now();
    this.restartTimes = this.restartTimes.filter(
      (time) => now - time < this.options.restartWindowMs,
    );
    if (this.restartTimes.length >= this.options.maxRestarts) {
      this.error = this.error || `ffmpeg exited with code ${code}`;
      this._setStatus('error');
      this.emit('failed', { error: this.error, code, signal, exhausted: true });
      return;
    }

    this.restartTimes.push(now);
    this._setStatus('reconnecting');
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this.stopping) this._spawn();
    }, this.options.restartDelayMs);
    if (typeof this._restartTimer.unref === 'function') this._restartTimer.unref();
    this.emit('restart', { attempt: this.restartTimes.length, code, signal });
  }

  /** Gracefully finalise the muxers so recordings stay playable. */
  async stop({ reason = 'stopped' }: any = {}) {
    this.stopping = true;
    this.stopReason = reason;
    if (this._liveTimer) {
      clearTimeout(this._liveTimer);
      this._liveTimer = null;
    }
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }

    const child = this.child;
    if (!child) {
      this._setStatus('ended');
      return { code: this.exitCode, signal: null, bytesIn: this.bytesIn };
    }

    this._setStatus('stopping');
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    try {
      child.stdin.end();
    } catch {
      // stdin already closed
    }

    const timeout = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), this.options.stopTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    const result = await Promise.race([exited, timeout]);
    if (result === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // process already gone
      }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }

    if (this._metricsTimer) {
      clearInterval(this._metricsTimer);
      this._metricsTimer = null;
    }

    this.endedAt = Date.now();
    this._setStatus('ended');
    return { code: this.exitCode, signal: null, bytesIn: this.bytesIn };
  }

  snapshot() {
    return {
      status: this.status,
      preset: this.preset,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      uptimeMs: this.startedAt ? (this.endedAt || Date.now()) - this.startedAt : 0,
      bytesIn: this.bytesIn,
      bitrateKbps: this.measuredBitrateKbps,
      restarts: this.restartTimes.length,
      exitCode: this.exitCode,
      error: this.error,
      destinationCount: this.targets.filter((target) => target.kind === 'rtmp').length,
      recording: this.targets.some((target) => target.kind === 'file'),
      stderrTail: this.stderrTail.slice(-600),
    };
  }
}
