/**
 * REST API.
 *
 * Read-only views of the studio state plus room and recording management.
 * Live control happens over the WebSocket protocol; this surface is for
 * dashboards, automation and the recording library.
 */

import express from 'express';
import { listPlatforms } from '../shared/destinations.js';
import { OVERLAY_DEFINITIONS, REQUESTABLE_OVERLAY_TYPES } from '../shared/overlays.js';
import { listPresets } from './ffmpeg.js';
import { REQUESTABLE_SCENE_TYPES } from '../shared/protocol.js';

export function createApiRouter({ registry, recordingStore, config, logger = console }) {
  const router = express.Router();

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

  router.post('/rooms', (req, res) => {
    const { id, name, hostName } = req.body || {};
    const result = registry.create({ id, name, hostName });
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.status(201).json({ room: result.studio.snapshot() });
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
    const removed = await recordingStore.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'recording not found' });
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
