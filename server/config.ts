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

/** A comma separated environment value, as a list. */
function csv(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * The ICE servers every client is handed.
 *
 * STUN is enough to find each other on most home networks; a TURN server is what
 * makes a call work across strict firewalls and symmetric NAT, because it relays
 * the media when a direct connection cannot be made.
 */
export function iceServersFrom(config: any = {}) {
  const servers: any[] = [];
  const stun = config.stunUrls || [];
  if (stun.length) servers.push({ urls: stun });
  const turn = config.turnUrls || [];
  if (turn.length) {
    servers.push({
      urls: turn,
      ...(config.turnUsername ? { username: config.turnUsername } : {}),
      ...(config.turnCredential ? { credential: config.turnCredential } : {}),
    });
  }
  return servers;
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

  // Pictures sent in chat. They are written here and served back from `/uploads`, so a
  // message can carry a URL instead of a megabyte of base64 over the socket.
  const uploadsDir =
    overrides.uploadsDir || process.env.QUANDRITE_UPLOADS_DIR || path.join(rootDir, 'uploads');

  const base = {
    rootDir,
    // The browser only ever sees the compiled client in `build/`.
    publicDir: path.join(rootDir, 'build', 'public'),
    sharedDir: path.join(rootDir, 'build', 'shared'),
    recordingsDir,
    uploadsDir,
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
    // WebRTC reachability. STUN lets peers discover each other; a TURN server
    // relays the media when their networks refuse a direct connection (symmetric
    // NAT, corporate firewalls, mobile data). Without TURN, calls only work when
    // both sides happen to be reachable directly.
    stunUrls: csv(process.env.QUANDRITE_STUN_URLS || 'stun:stun.l.google.com:19302'),
    turnUrls: csv(process.env.QUANDRITE_TURN_URLS || process.env.QUANDRITE_TURN_URL || ''),
    turnUsername: process.env.QUANDRITE_TURN_USERNAME || '',
    turnCredential: process.env.QUANDRITE_TURN_CREDENTIAL || '',
    // Serve over HTTPS when a certificate is given: browsers only hand out the
    // camera and the microphone on a secure origin (or localhost).
    tlsCert: process.env.QUANDRITE_TLS_CERT || '',
    tlsKey: process.env.QUANDRITE_TLS_KEY || '',
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
  // Handed to every client, so a call can cross networks.
  config.iceServers = overrides.iceServers || iceServersFrom(config);

  fs.mkdirSync(config.recordingsDir, { recursive: true });
  // Chat pictures live here too, so a fresh install can accept one immediately.
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  return config;
}

export default loadConfig;
