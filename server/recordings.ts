/**
 * Recording catalogue.
 *
 * The relay writes the program feed to a crash-safe Matroska file; when the
 * broadcast ends the store finalises the entry (size, duration) and remuxes it
 * to a browser friendly MP4 so it can be replayed or downloaded later.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildProbeArgs, buildRemuxArgs, parseDurationSeconds } from './ffmpeg.ts';

const INDEX_FILE = 'index.json';

/** Run an ffmpeg command and collect its output. Never rejects on exit code. */
export function runFfmpeg(bin, args, { timeoutMs = 60000 }: any = {}): Promise<any> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message || error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error?.message || error}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function safeSegment(value, fallback = 'room') {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || fallback;
}

export class RecordingStore {

  // --- state (typed loosely while the class is migrated) ---
  _writeChain: any;
  dir: any;
  entries: any;
  ffmpegBin: any;
  loaded: any;
  logger: any;
  remuxToMp4: any;
  constructor({ dir, ffmpegBin, remuxToMp4 = true, logger = console }: any = {}) {
    if (!dir) throw new Error('RecordingStore requires a directory');
    this.dir = dir;
    this.ffmpegBin = ffmpegBin;
    this.remuxToMp4 = remuxToMp4;
    this.logger = logger;
    this.entries = [];
    this.loaded = false;
    this._writeChain = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this.entries;
    this.loaded = true;
    try {
      const raw = await fsp.readFile(path.join(this.dir, INDEX_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.entries = parsed;
    } catch {
      this.entries = [];
    }
    return this.entries;
  }

  _persist() {
    const payload = JSON.stringify(this.entries, null, 2);
    this._writeChain = this._writeChain
      .then(async () => {
        const tmp = path.join(this.dir, `${INDEX_FILE}.tmp`);
        await fsp.writeFile(tmp, payload, 'utf8');
        await fsp.rename(tmp, path.join(this.dir, INDEX_FILE));
      })
      .catch((error) => {
        this.logger.error?.(`failed to persist recording index: ${error.message}`);
      });
    return this._writeChain;
  }

  absPath(entry) {
    return path.join(this.dir, entry.file);
  }

  /** Register a new recording before the relay starts writing to it. */
  async create({ roomId, roomName, format = 'mkv', destinations = [], preset = null }: any = {}) {
    await this.load();
    const now = new Date();
    const id = randomUUID();
    const base = `${safeSegment(roomName || roomId)}_${stamp(now)}_${id.slice(0, 6)}`;
    const entry = {
      id,
      roomId,
      roomName: roomName || roomId,
      file: `${base}.${format}`,
      format,
      mp4: null,
      preset,
      status: 'recording',
      createdAt: now.getTime(),
      endedAt: null,
      durationMs: null,
      sizeBytes: 0,
      destinations,
    };
    this.entries.unshift(entry);
    await this._persist();
    return entry;
  }

  get(id) {
    return this.entries.find((entry) => entry.id === id) || null;
  }

  list({ roomId }: any = {}) {
    const sorted = [...this.entries].sort((a, b) => b.createdAt - a.createdAt);
    return roomId ? sorted.filter((entry) => entry.roomId === roomId) : sorted;
  }

  /** Read the duration of a finished media file (no decode). */
  async probeDurationMs(file) {
    if (!this.ffmpegBin) return null;
    const { stderr } = await runFfmpeg(this.ffmpegBin, buildProbeArgs(file), { timeoutMs: 30000 });
    const seconds = parseDurationSeconds(stderr);
    return seconds === null ? null : Math.round(seconds * 1000);
  }

  /**
   * Mark a recording finished: measure it, optionally remux to MP4 and store
   * the final metadata.
   */
  async finalize(id, { remux }: any = {}) {
    await this.load();
    const entry = this.get(id);
    if (!entry) return null;

    const abs = this.absPath(entry);
    try {
      const stats = await fsp.stat(abs);
      entry.sizeBytes = stats.size;
    } catch {
      entry.status = 'error';
      entry.error = 'recording file was not created';
      entry.endedAt = Date.now();
      await this._persist();
      return entry;
    }

    entry.durationMs = await this.probeDurationMs(abs);

    const shouldRemux =
      (remux ?? this.remuxToMp4) && entry.format !== 'mp4' && entry.sizeBytes > 0 && Boolean(this.ffmpegBin);
    if (shouldRemux) {
      const mp4File = `${entry.file.replace(/\.[a-z0-9]+$/i, '')}.mp4`;
      const target = path.join(this.dir, mp4File);
      const { code } = await runFfmpeg(this.ffmpegBin, buildRemuxArgs(abs, target));
      if (code === 0) {
        entry.mp4 = mp4File;
        try {
          const mp4Stats = await fsp.stat(target);
          entry.mp4SizeBytes = mp4Stats.size;
        } catch {
          // keep the mkv only
        }
      } else {
        entry.remuxError = 'ffmpeg could not remux the recording to mp4';
      }
    }

    entry.status = entry.sizeBytes > 0 ? 'ready' : 'error';
    entry.endedAt = Date.now();
    await this._persist();
    return entry;
  }

  /** Remove a recording and both of its files from disk. */
  async remove(id) {
    await this.load();
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    const [entry] = this.entries.splice(index, 1);
    for (const file of [entry.file, entry.mp4]) {
      if (!file) continue;
      try {
        await fsp.unlink(path.join(this.dir, file));
      } catch {
        // already deleted
      }
    }
    await this._persist();
    return true;
  }

  /** Public JSON shape for the API. */
  toPublic(entry) {
    if (!entry) return null;
    const downloadFile = entry.mp4 || entry.file;
    return {
      id: entry.id,
      roomId: entry.roomId,
      roomName: entry.roomName,
      status: entry.status,
      createdAt: entry.createdAt,
      endedAt: entry.endedAt,
      durationMs: entry.durationMs,
      sizeBytes: entry.sizeBytes,
      mp4SizeBytes: entry.mp4SizeBytes ?? null,
      format: entry.format,
      hasMp4: Boolean(entry.mp4),
      file: entry.file,
      mp4: entry.mp4,
      downloadUrl: `/recordings/${encodeURIComponent(downloadFile)}`,
      streamUrl: `/recordings/${encodeURIComponent(entry.file)}`,
      destinations: entry.destinations || [],
    };
  }
}
