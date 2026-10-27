/**
 * End-to-end livestream test.
 *
 * Uses real ffmpeg: two RTMP servers are started as stand-ins for YouTube and
 * Facebook, the studio relays the program feed to both of them while recording,
 * and we then assert that both platforms received media and that the recording
 * was finalised and is downloadable through the API.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

import { createServer } from '../server/index.ts';
import { loadConfig } from '../server/config.ts';
import { resolveFfmpegBin, rootDir } from '../server/config.ts';

const FFMPEG = process.env.QUANDRITE_FFMPEG_BIN || resolveFfmpegBin(undefined);
const silent = { info() {}, warn() {}, error() {} };
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quandrite-e2e-'));
const sourceFile = path.join(workDir, 'source.webm');

let quandrite;
let wsUrl;
let httpBase;
const listeners = [];
const ports = [];

function run(bin, args, { timeoutMs = 30000 }: any = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as any;
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startRtmpSink(port, label) {
  const output = path.join(workDir, `${label}.flv`);
  const child = spawn(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-listen',
      '1',
      '-f',
      'flv',
      '-i',
      `rtmp://127.0.0.1:${port}/live/${label}`,
      '-c',
      'copy',
      '-f',
      'flv',
      output,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  listeners.push({ child, output, get stderr() { return stderr; } });
  return { port, output, label };
}

function connect() {
  const socket = new WebSocket(wsUrl);
  const received = [];
  const waiters = [];
  socket.on('message', (data, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(data.toString('utf8'));
    received.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].match(message)) {
        const waiter = waiters.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  let counter = 0;
  return {
    socket,
    received,
    open: () =>
      new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      }),
    next(match, timeoutMs = 20000) {
      const found = received.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = {
          match,
          resolve,
          timer: setTimeout(() => reject(new Error('timed out waiting for a message')), timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    send(type, payload: any = {}, timeoutMs = 20000) {
      counter += 1;
      const id = `e2e-${counter}`;
      const acked = this.next(
        (message) => (message.type === 'ack' || message.type === 'error') && message.id === id,
        timeoutMs,
      ).then((message) => {
        if (message.type === 'error') throw new Error(message.message);
        return message.result ?? {};
      });
      socket.send(JSON.stringify({ type, ...payload, id }));
      return acked;
    },
  };
}

before(async () => {
  // A short programme: video plus audio, exactly like a MediaRecorder stream.
  const generated: any = await run(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=15',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '5',
    '-c:v',
    'libvpx',
    '-b:v',
    '500k',
    '-c:a',
    'libopus',
    '-f',
    'webm',
    sourceFile,
  ]);
  assert.equal(generated.code, 0, `could not generate the source clip: ${generated.stderr}`);
  assert.ok(fs.statSync(sourceFile).size > 20000, 'the source clip has real content');

  const config = loadConfig({
    recordingsDir: path.join(workDir, 'recordings'),
    relay: { liveDelayMs: 400, stopTimeoutMs: 10000, restartDelayMs: 300 },
  });
  quandrite = createServer({ config, logger: silent });
  const address = await quandrite.listen(0, '127.0.0.1');
  wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  httpBase = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const listener of listeners) {
    try {
      listener.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  await quandrite?.close();
  void rootDir;
});

test('the program feed reaches every platform and is recorded for later', { timeout: 120000 }, async () => {
  const youtube = startRtmpSink(await freePort(), 'youtube');
  const facebook = startRtmpSink(await freePort(), 'facebook');
  ports.push(youtube.port, facebook.port);

  // ffmpeg's RTMP listener accepts a single connection, so never probe the port:
  // a throwaway TCP connect would consume the listener's one slot. Just wait for
  // the listeners to be up and confirm they are still running.
  await sleep(2500);
  for (const listener of listeners) {
    assert.equal(listener.child.exitCode, null, `the ${listener.output} listener is running`);
  }

  const host = connect();
  await host.open();
  await host.send('join', { roomId: 'live-room', name: 'Ada', role: 'host' });

  await host.send('source:add', { source: { id: 'cam-1', kind: 'camera', label: 'Studio camera' } });

  await host.send('destination:add', {
    destination: { platform: 'custom', overrideUrl: `rtmp://127.0.0.1:${youtube.port}/live`, streamKey: 'youtube', label: 'YouTube' },
  });
  await host.send('destination:add', {
    destination: { platform: 'custom', overrideUrl: `rtmp://127.0.0.1:${facebook.port}/live`, streamKey: 'facebook', label: 'Facebook' },
  });

  const started = await host.send('stream:start', { preset: '480p30', record: true });
  assert.equal(started.stream.status, 'connecting');
  assert.equal(started.stream.destinationStatuses.length, 2);

  const live = await host.next(
    (message) => message.type === 'stream:update' && message.payload.status === 'live',
  );
  assert.equal(live.payload.recording, true);

  // Feed the relay exactly like the browser publisher does: WebM chunks.
  const source = fs.readFileSync(sourceFile);
  const chunkSize = 16384;
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    host.socket.send(source.subarray(offset, offset + chunkSize));
    await sleep(5);
  }

  const fed = await host.next(
    (message) =>
      message.type === 'stream:update' && (message.payload.bytesIn || 0) > 0,
    20000,
  );
  assert.ok(fed.payload.bytesIn > 0, 'the encoder received the program feed');

  await sleep(2000);

  const stopped = await host.send('stream:stop', {});
  assert.equal(stopped.stream.status, 'ended');

  const ready = await host.next(
    (message) => message.type === 'recording:update' && message.payload.status === 'ready',
    30000,
  );
  assert.equal(ready.payload.status, 'ready');
  assert.ok(ready.payload.durationMs > 1000, `recording duration was ${ready.payload.durationMs}ms`);
  assert.ok(ready.payload.sizeBytes > 5000, `recording size was ${ready.payload.sizeBytes} bytes`);
  assert.match(ready.payload.file, /\.mp4$/);

  const recordingPath = path.join(quandrite.config.recordingsDir, ready.payload.file);
  assert.ok(fs.existsSync(recordingPath), 'the recording file exists on disk');

  // Both platforms received media (multi-platform fan-out from a single encode).
  await sleep(1500);
  for (const sink of [youtube, facebook]) {
    const stats = fs.existsSync(sink.output) ? fs.statSync(sink.output) : null;
    assert.ok(stats, `${sink.label} received a stream`);
    assert.ok(stats.size > 5000, `${sink.label} received ${stats?.size ?? 0} bytes`);
    assert.ok(!/Connection refused/.test(listeners.find((l) => l.output === sink.output).stderr));
  }

  // The recording is listed and downloadable through the API.
  const list = await (await fetch(`${httpBase}/api/rooms/live-room/recordings`)).json();
  assert.equal(list.recordings.length, 1);
  assert.equal(list.recordings[0].status, 'ready');
  assert.equal(list.recordings[0].destinations.length, 2);

  const download = await fetch(`${httpBase}${list.recordings[0].downloadUrl}`);
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.ok(bytes.length > 5000, 'the mp4 download has content');
  assert.equal(bytes.subarray(4, 8).toString('ascii'), 'ftyp', 'the download is a real mp4');

  host.socket.close();
});
