/**
 * Quandrite server entry point.
 *
 * Wires together the REST API, the WebSocket signalling layer and the static
 * client, and exposes `createServer()` so tests can boot the whole stack on an
 * ephemeral port.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { RecordingStore } from './recordings.js';
import { RoomRegistry } from './rooms.js';
import { SignalingServer } from './signaling.js';
import { createApiRouter } from './api.js';

export function createServer(options = {}) {
  const config = options.config || loadConfig(options);
  const logger = options.logger || console;

  const recordingStore =
    options.recordingStore ||
    new RecordingStore({
      dir: config.recordingsDir,
      ffmpegBin: config.ffmpegBin,
      remuxToMp4: config.remuxRecordingToMp4,
      logger,
    });

  const registry =
    options.registry || new RoomRegistry({ config, recordingStore, logger });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', createApiRouter({ registry, recordingStore, config, logger }));

  // Recording library: never expose the internal index file.
  app.use(
    '/recordings',
    (req, res, next) => {
      if (req.path.includes('index.json')) return res.status(404).json({ error: 'not found' });
      return next();
    },
    express.static(config.recordingsDir, {
      index: false,
      dotfiles: 'deny',
      fallthrough: true,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    }),
  );

  // Shared, dependency free modules used by both the server and the browser.
  app.use('/shared', express.static(config.sharedDir, { index: false }));
  app.use(express.static(config.publicDir, { index: 'index.html' }));

  app.use((req, res) => {
    res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
  });

  const server = http.createServer(app);
  const signaling = new SignalingServer({ server, registry, config, logger });

  const listen = (port = config.port, host = config.host) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        const address = server.address();
        resolve(address);
      });
    });

  const close = async () => {
    registry.stopSweeper();
    await signaling.close();
    await registry.dispose();
    await new Promise((resolve) => server.close(() => resolve()));
  };

  return { app, server, config, registry, recordingStore, signaling, listen, close };
}

async function main() {
  const config = loadConfig();
  const quandrite = createServer({ config });
  quandrite.registry.startSweeper();

  const address = await quandrite.listen();
  const host = address.address === '::' || address.address === '0.0.0.0' ? 'localhost' : address.address;
  const base = `http://${host}:${address.port}`;

  console.log('');
  console.log('  Quandrite studio is running');
  console.log(`  Studio UI : ${base}/`);
  console.log(`  WebSocket : ws://${host}:${address.port}/ws`);
  console.log(`  ffmpeg    : ${config.ffmpegBin}`);
  console.log(`  recordings: ${config.recordingsDir}`);
  console.log('');

  const shutdown = async (signal) => {
    console.log(`\nreceived ${signal}, shutting down...`);
    try {
      await quandrite.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`failed to start Quandrite: ${error.stack || error.message}`);
    process.exit(1);
  });
}

export default createServer;
