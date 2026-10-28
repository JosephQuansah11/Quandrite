/**
 * REST API.
 *
 * Read-only views of the studio state plus room and recording management.
 * Live control happens over the WebSocket protocol; this surface is for
 * dashboards, automation and the recording library.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { listPlatforms } from '../shared/destinations.ts';
import { OVERLAY_DEFINITIONS, REQUESTABLE_OVERLAY_TYPES } from '../shared/overlays.ts';
import { listPresets } from './ffmpeg.ts';
import { CHAT_ATTACHMENT_TYPES, MAX_CHAT_ATTACHMENT_BYTES, MIN_PASSWORD_LENGTH, PASSWORD_ROLES, REQUESTABLE_SCENE_TYPES, ROLES } from '../shared/protocol.ts';

/** A file name for a picture, with nothing that could mean a path. */
function cleanFileName(name) {
  return String(name ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Read an image data URL into bytes.
 *
 * Only the picture types the room accepts are read, the base64 has to decode, and the
 * result has to start with a real magic number for that type - a file called `.png` is
 * not a picture, and the room should not be asked to serve one.
 */
function decodeImageDataUrl(dataUrl) {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) return null;
  const mime = match[1].toLowerCase();
  if (!CHAT_ATTACHMENT_TYPES.includes(mime)) return null;
  let bytes;
  try {
    bytes = Buffer.from(match[2], 'base64');
  } catch {
    return null;
  }
  if (!bytes.length) return null;
  const signature = bytes.subarray(0, 12);
  const looksRight =
    (mime === 'image/png' && signature[0] === 0x89 && signature[1] === 0x50) ||
    (mime === 'image/jpeg' && signature[0] === 0xff && signature[1] === 0xd8) ||
    (mime === 'image/gif' && signature.subarray(0, 3).toString('latin1') === 'GIF') ||
    (mime === 'image/webp' && signature.subarray(0, 4).toString('latin1') === 'RIFF' && signature.subarray(8, 12).toString('latin1') === 'WEBP');
  if (!looksRight) return null;
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
  return { mime, extension, bytes };
}


export function createApiRouter({
  registry,
  recordingStore,
  config,
  logger = console,
  mailer = null,
  getSignaling = null,
}) {
  const router = express.Router();

  const joinUrlFor = (roomId) =>
    config.publicUrl ? `${String(config.publicUrl).replace(/\/$/, '')}/?room=${encodeURIComponent(roomId)}` : undefined;

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: 'quandrite',
      uptimeMs: Math.round(process.uptime() * 1000),
      rooms: registry.rooms.size,
      ffmpeg: config.ffmpegBin,
      recordingsDir: config.recordingsDir,
      now: Date.now(),
    });
  });

  router.get('/capabilities', (req, res) => {
    res.json({
      platforms: listPlatforms(),
      presets: listPresets(),
      overlayTypes: REQUESTABLE_OVERLAY_TYPES,
      sceneTypes: REQUESTABLE_SCENE_TYPES,
      roles: ROLES,
      passwordRoles: PASSWORD_ROLES,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxBreakouts: config.maxBreakouts,
      mail: {
        enabled: Boolean(mailer?.enabled),
        from: mailer?.from || null,
        transport: mailer?.transport || null,
      },
      overlayDefinitions: OVERLAY_DEFINITIONS,
      defaultPreset: config.defaultPreset,
      maxDestinationsPerRoom: config.maxDestinationsPerRoom,
      maxSourcesPerRoom: config.maxSourcesPerRoom,
      recordFormat: config.recordFormat,
      websocketPath: '/ws',
    });
  });

  router.get('/rooms', (req, res) => {
    res.json({ rooms: registry.list() });
  });

  router.post('/rooms', async (req, res) => {
    const { id, name, hostName, hostPassword, cohostPassword, hostEmail } = req.body || {};
    const result = registry.create({ id, name, hostName, hostPassword, cohostPassword });
    if (!result.ok) return res.status(400).json({ error: result.error });

    const credentials = result.studio.credentialsSnapshot();
    // The caller is the operator that created the room, so it gets the role
    // passwords back. They are never part of the shared room snapshot.
    // `hostEmail` additionally mails them, so the host password is not only on
    // screen.
    let mail = null;
    if (hostEmail) {
      mail = mailer
        ? await mailer.sendHostPassword({
            to: String(hostEmail),
            roomId: result.studio.id,
            roomName: result.studio.name,
            hostPassword: credentials.hostPassword,
            cohostPassword: credentials.cohostPassword,
            joinUrl: joinUrlFor(result.studio.id),
          })
        : { ok: false, error: 'mail is not configured on this server' };
    }

    return res.status(201).json({ room: result.studio.snapshot(), credentials, mail });
  });

  /**
   * Mail a room password to an address.
   *
   * The caller has to prove it knows the password it is asking to be sent, so
   * this cannot be used to mail a password to someone who does not have it.
   */
  router.post('/rooms/:id/invite', async (req, res) => {
    const studio = registry.get(req.params.id);
    if (!studio) return res.status(404).json({ error: 'room not found' });
    if (!mailer?.enabled) return res.status(503).json({ error: 'mail is not configured on this server' });

    const { email, password, role = 'host' } = req.body || {};
    const credentials = studio.credentialsSnapshot();
    const wanted = role === 'cohost' ? credentials.cohostPassword : credentials.hostPassword;
    if (!password || password !== wanted) {
      return res.status(403).json({ error: 'that password does not match this room' });
    }

    const result = await mailer.send({
      to: String(email ?? ''),
      subject: `Quandrite ${role} password for ${studio.name}`,
      text: [
        `Room code: ${studio.id}`,
        joinUrlFor(studio.id) ? `Join: ${joinUrlFor(studio.id)}` : null,
        '',
        `${role === 'cohost' ? 'Co-host' : 'Host'} password: ${wanted}`,
      ]
        .filter((line) => line !== null)
        .join('\n'),
    });
    if (!result.ok) return res.status(502).json({ error: result.error });
    return res.json({ sent: true, to: email, role, via: result.via });
  });

  router.get('/rooms/:id', (req, res) => {
    const studio = registry.get(req.params.id);
    if (!studio) return res.status(404).json({ error: 'room not found' });
    return res.json({ room: studio.snapshot() });
  });

  router.get('/rooms/:id/chat', (req, res) => {
    const studio = registry.get(req.params.id);
    if (!studio) return res.status(404).json({ error: 'room not found' });
    const limit = Math.min(Number(req.query.limit) || 100, studio.chat.length);
    return res.json({ messages: studio.chat.slice(-limit) });
  });

  /**
   * Take a picture for chat, and hand back the URL to refer to it by.
   *
   * The picture arrives as a data URL (the browser has already scaled it down, which is
   * what keeps a phone screenshot from being 8 MB), is checked to be a picture of a sane
   * size, and is written under a name this server invents. The client never chooses a
   * path: the message that follows can only point at what this endpoint stored.
   */
  router.post(
    '/rooms/:id/chat/upload',
    express.json({ limit: '8mb' }),
    (req, res) => {
      const studio = registry.get(req.params.id);
      if (!studio) return res.status(404).json({ error: 'room not found' });
      const parsed = decodeImageDataUrl(req.body?.dataUrl);
      if (!parsed) return res.status(400).json({ error: 'that is not a picture' });
      if (parsed.bytes.length > MAX_CHAT_ATTACHMENT_BYTES) {
        return res.status(413).json({ error: 'that picture is too big' });
      }
      const file = `${studio.id}-${randomUUID()}.${parsed.extension}`;
      try {
        fs.mkdirSync(config.uploadsDir, { recursive: true });
        fs.writeFileSync(path.join(config.uploadsDir, file), parsed.bytes);
      } catch (error) {
        logger.warn?.(`chat upload failed: ${error.message}`);
        return res.status(500).json({ error: 'the picture could not be stored' });
      }
      return res.json({
        attachment: {
          url: `/uploads/${file}`,
          name: cleanFileName(req.body?.name) || `picture.${parsed.extension}`,
          mime: parsed.mime,
          bytes: parsed.bytes.length,
          width: Math.max(0, Math.min(20000, Number(req.body?.width) || 0)),
          height: Math.max(0, Math.min(20000, Number(req.body?.height) || 0)),
        },
      });
    },
  );

  router.get('/rooms/:id/recordings', async (req, res) => {
    const studio = registry.get(req.params.id);
    if (!studio) return res.status(404).json({ error: 'room not found' });
    await recordingStore.load();
    return res.json({
      recordings: recordingStore.list({ roomId: studio.id }).map((entry) => recordingStore.toPublic(entry)),
    });
  });

  router.delete('/rooms/:id', async (req, res) => {
    const removed = await registry.delete(req.params.id);
    if (!removed) return res.status(404).json({ error: 'room not found' });
    return res.json({ deleted: true });
  });

  router.get('/recordings', async (req, res) => {
    await recordingStore.load();
    const roomId = req.query.roomId ? String(req.query.roomId) : undefined;
    return res.json({
      recordings: recordingStore.list({ roomId }).map((entry) => recordingStore.toPublic(entry)),
    });
  });

  router.delete('/recordings/:id', async (req, res) => {
    const entry = recordingStore.get(req.params.id);
    const roomId = entry?.roomId ?? null;
    const removed = await recordingStore.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'recording not found' });
    // Everyone in that room sees the library shrink, without refreshing.
    if (roomId) await getSignaling?.()?.broadcastRecordings(roomId);
    return res.json({ deleted: true });
  });

  router.use((error, req, res, next) => {
    logger.error?.(`api error: ${error.stack || error.message}`);
    res.status(500).json({ error: 'internal error' });
    void next;
  });

  return router;
}

export default createApiRouter;
