/**
 * Runtime configuration.
 *
 * Everything is overridable from the environment so the same build can run on
 * a laptop, a studio machine or a container. `loadConfig()` also guarantees the
 * recordings directory exists before the server starts writing to it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Locate an ffmpeg executable.
 *
 * Order: explicit argument, QUANDRITE_FFMPEG_BIN, FFMPEG_BIN, the bundled
 * `ffmpeg-static` binary, then whatever `ffmpeg` is on PATH.
 */
export function resolveFfmpegBin(explicit) {
  const candidates = [
    explicit,
    process.env.QUANDRITE_FFMPEG_BIN,
    process.env.FFMPEG_BIN,
  ];
  try {
    const bundled = require('ffmpeg-static');
    if (typeof bundled === 'string') candidates.push(bundled);
  } catch {
    // ffmpeg-static is optional; a system ffmpeg is fine.
  }
  candidates.push('ffmpeg');

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === 'ffmpeg') return candidate;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return 'ffmpeg';
}

export function loadConfig(overrides: any = {}) {
  const recordingsDir =
    overrides.recordingsDir ||
    process.env.QUANDRITE_RECORDINGS_DIR ||
    path.join(rootDir, 'recordings');

  const base = {
    rootDir,
    // The browser only ever sees the compiled client in `build/`.
    publicDir: path.join(rootDir, 'build', 'public'),
    sharedDir: path.join(rootDir, 'build', 'shared'),
    recordingsDir,
    host: process.env.QUANDRITE_HOST || '0.0.0.0',
    port: intEnv('PORT', intEnv('QUANDRITE_PORT', 8080)),
    ffmpegBin: resolveFfmpegBin(overrides.ffmpegBin),
    defaultPreset: process.env.QUANDRITE_PRESET || '1080p30',
    defaultInputFormat: process.env.QUANDRITE_INPUT_FORMAT || 'matroska',
    recordFormat: process.env.QUANDRITE_RECORD_FORMAT || 'mp4',
    remuxRecordingToMp4: process.env.QUANDRITE_REMUX_MP4 !== '0',
    audioBitrateKbps: intEnv('QUANDRITE_AUDIO_KBPS', 160),
    chatLimit: intEnv('QUANDRITE_CHAT_LIMIT', 500),
    // Role passwords. Empty means "let each room generate its own".
    hostPassword: process.env.QUANDRITE_HOST_PASSWORD || '',
    cohostPassword: process.env.QUANDRITE_COHOST_PASSWORD || '',
    maxBreakouts: intEnv('QUANDRITE_MAX_BREAKOUTS', 8),
    // Mail: the host password is emailed instead of only shown on screen.
    mailFrom: process.env.QUANDRITE_MAIL_FROM || 'Quandrite <no-reply@quandrite.local>',
    smtpUrl: process.env.QUANDRITE_SMTP_URL || '',
    mailWebhook: process.env.QUANDRITE_MAIL_WEBHOOK || '',
    publicUrl: process.env.QUANDRITE_PUBLIC_URL || '',
    maxRooms: intEnv('QUANDRITE_MAX_ROOMS', 200),
    maxSourcesPerRoom: intEnv('QUANDRITE_MAX_SOURCES', 24),
    maxDestinationsPerRoom: intEnv('QUANDRITE_MAX_DESTINATIONS', 8),
    maxChunkBytes: intEnv('QUANDRITE_MAX_CHUNK_BYTES', 8 * 1024 * 1024),
    relay: {
      liveDelayMs: intEnv('QUANDRITE_LIVE_DELAY_MS', 900),
      stopTimeoutMs: intEnv('QUANDRITE_STOP_TIMEOUT_MS', 6000),
      maxRestarts: intEnv('QUANDRITE_MAX_RESTARTS', 3),
      restartWindowMs: intEnv('QUANDRITE_RESTART_WINDOW_MS', 60000),
      restartDelayMs: intEnv('QUANDRITE_RESTART_DELAY_MS', 1500),
    },
    logLevel: process.env.QUANDRITE_LOG_LEVEL || 'info',
  };

  const config = {
    ...base,
    ...overrides,
    relay: { ...base.relay, ...(overrides.relay || {}) },
  };

  fs.mkdirSync(config.recordingsDir, { recursive: true });
  return config;
}

export default loadConfig;
