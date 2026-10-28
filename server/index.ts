/**
 * Quandrite server entry point.
 *
 * Wires together the REST API, the WebSocket signalling layer and the static
 * client, and exposes `createServer()` so tests can boot the whole stack on an
 * ephemeral port.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.ts';
import { RecordingStore } from './recordings.ts';
import { RoomRegistry } from './rooms.ts';
import { SignalingServer } from './signaling.ts';
import { createApiRouter } from './api.ts';
import { Mailer } from './mailer.ts';

export function createServer(options: any = {}) {
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

  const mailer =
    options.mailer ||
    new Mailer({
      from: config.mailFrom,
      smtpUrl: config.smtpUrl,
      webhookUrl: config.mailWebhook,
      logger,
    });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use(
    '/api',
    createApiRouter({
      registry,
      recordingStore,
      config,
      logger,
      mailer,
      // The signalling server is created with the HTTP server below, so the API
      // reaches it lazily (it pushes the recording library after a delete).
      getSignaling: () => signaling,
    }),
  );

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
  // TypeScript sources are never served - only the compiled client.
  const denySources = (req, res, next) => {
    if (req.path.endsWith('.ts')) return res.status(404).json({ error: 'not found' });
    return next();
  };
  app.use('/shared', denySources, express.static(config.sharedDir, { index: false }));
  app.use(denySources, express.static(config.publicDir, { index: 'index.html' }));

  app.use((req, res) => {
    res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
  });

  // HTTPS when a certificate is configured: a browser only gives a page the
  // camera and the microphone on a secure origin (or localhost), so serving over
  // TLS is what makes the studio usable from other machines.
  const server =
    config.tlsCert && config.tlsKey
      ? https.createServer(
          { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) },
          app,
        )
      : http.createServer(app);
  const signaling = new SignalingServer({ server, registry, config, logger, mailer, recordingStore });

  const listen = (port = config.port, host = config.host) =>
    new Promise<any>((resolve, reject) => {
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { app, server, config, registry, recordingStore, signaling, mailer, listen, close };
}

async function main() {
  const config = loadConfig();
  // The server only ever serves the compiled client, so a missing build is the
  // single most confusing failure mode ("nothing works"): say it out loud.
  const indexFile = path.join(config.publicDir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    console.warn(`  ! no client build found in ${config.publicDir}`);
    console.warn('  ! run "npm run build" (or use npm start / npm run dev, which build first)');
  }
  const quandrite = createServer({ config });
  quandrite.registry.startSweeper();
  // Reap sockets that stopped answering: without a heartbeat a closed tab keeps
  // its seat in the roster as a ghost member, and the room never looks right.
  quandrite.signaling.startHeartbeat();

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
