/**
 * REST API.
 *
 * Read-only views of the studio state plus room and recording management.
 * Live control happens over the WebSocket protocol; this surface is for
 * dashboards, automation and the recording library.
 */

import express from 'express';
import { listPlatforms } from '../shared/destinations.ts';
import { OVERLAY_DEFINITIONS, REQUESTABLE_OVERLAY_TYPES } from '../shared/overlays.ts';
import { listPresets } from './ffmpeg.ts';
import { MIN_PASSWORD_LENGTH, PASSWORD_ROLES, REQUESTABLE_SCENE_TYPES, ROLES } from '../shared/protocol.ts';

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
