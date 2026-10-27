import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { createServer } from '../server/index.js';
import { loadConfig } from '../server/config.js';

const silent = { info() {}, warn() {}, error() {} };

let quandrite;
let wsUrl;
let requestCounter = 0;
const openClients = new Set();

before(async () => {
  const config = loadConfig({
    recordingsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'quandrite-signal-')),
  });
  quandrite = createServer({ config, logger: silent });
  const address = await quandrite.listen(0, '127.0.0.1');
  wsUrl = `ws://127.0.0.1:${address.port}/ws`;
});

after(async () => {
  for (const client of openClients) client.socket.close();
  await quandrite.close();
});

function connect() {
  const socket = new WebSocket(wsUrl);
  const received = [];
  const waiters = [];
  openClients.add({ socket });

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

  const client = {
    socket,
    received,
    open: () =>
      new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      }),
    next(match, timeoutMs = 5000) {
      const found = received.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = {
          match,
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error('timed out waiting for a server message'));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    send(type, payload = {}, timeoutMs = 8000) {
      requestCounter += 1;
      const id = `req-${requestCounter}`;
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
    close() {
      socket.close();
      openClients.delete(client);
    },
  };
  return client;
}

test('a new connection receives the protocol welcome with the platform catalogue', async () => {
  const client = connect();
  await client.open();
  const welcome = await client.next((message) => message.type === 'welcome');
  assert.equal(welcome.protocolVersion, 1);
  assert.ok(welcome.clientId);
  assert.deepEqual(welcome.sceneTypes, ['title', 'announcement', 'screenshare', 'song', 'break', 'ended']);
  assert.ok(welcome.platforms.some((platform) => platform.id === 'youtube'));
  assert.ok(welcome.overlayDefinitions.title);
  client.close();
});

test('joining returns a snapshot and broadcasts presence to the room', async () => {
  const host = connect();
  await host.open();
  const joined = await host.send('join', { roomId: 'sig-room', name: 'Ada', role: 'host' });
  assert.equal(joined.role, 'host');
  assert.equal(joined.roomId, 'sig-room');
  assert.equal(joined.snapshot.room.id, 'sig-room');
  assert.ok(Array.isArray(joined.snapshot.presets) && joined.snapshot.presets.length > 0);

  const viewer = connect();
  await viewer.open();
  const viewerJoin = await viewer.send('join', { roomId: 'sig-room', name: 'Cleo' });
  assert.equal(viewerJoin.role, 'viewer');

  const update = await host.next(
    (message) => message.type === 'members:update' && message.payload.length === 2,
  );
  assert.deepEqual(update.payload.map((member) => member.name).sort(), ['Ada', 'Cleo']);

  host.close();
  viewer.close();
});

test('chat reaches every participant', async () => {
  const a = connect();
  const b = connect();
  await Promise.all([a.open(), b.open()]);
  await a.send('join', { roomId: 'chat-room', name: 'Ada' });
  await b.send('join', { roomId: 'chat-room', name: 'Bob' });

  await a.send('chat:send', { text: 'Hello everyone' });
  const seen = await b.next((message) => message.type === 'chat:new' && message.payload.text === 'Hello everyone');
  assert.equal(seen.payload.authorName, 'Ada');
  assert.equal(seen.payload.kind, 'text');

  await assert.rejects(() => a.send('chat:send', { text: '   ' }), /empty/);

  a.close();
  b.close();
});

test('viewers cannot drive the broadcast but hosts and co-hosts can', async () => {
  const host = connect();
  const viewer = connect();
  await Promise.all([host.open(), viewer.open()]);
  await host.send('join', { roomId: 'control-room', name: 'Ada', role: 'host' });
  await viewer.send('join', { roomId: 'control-room', name: 'Cleo', role: 'viewer' });

  await assert.rejects(() => viewer.send('program:set', { mode: 'grid' }), /only the host or a co-host/);
  await assert.rejects(
    () => viewer.send('scene:set', { scene: { type: 'break', payload: {} } }),
    /only the host or a co-host/,
  );
  await assert.rejects(
    () => viewer.send('destination:add', { destination: { platform: 'youtube', streamKey: 'k' } }),
    /only the host or a co-host/,
  );

  await host.send('source:add', { source: { id: 'cam-1', kind: 'camera', label: 'Camera 1' } });
  await host.send('source:add', { source: { id: 'cam-2', kind: 'camera', label: 'Camera 2' } });

  const acked = await host.send('program:set', { mode: 'grid', gridIds: ['cam-1', 'cam-2'] });
  assert.equal(acked.program.mode, 'grid');
  assert.deepEqual(acked.program.onAir, ['cam-1', 'cam-2']);

  const pushed = await viewer.next(
    (message) => message.type === 'program:update' && message.payload.mode === 'grid',
  );
  assert.deepEqual(pushed.payload.onAir, ['cam-1', 'cam-2']);

  host.close();
  viewer.close();
});

test('overlays pushed by the host reach every client', async () => {
  const host = connect();
  const viewer = connect();
  await Promise.all([host.open(), viewer.open()]);
  await host.send('join', { roomId: 'scene-room', name: 'Ada', role: 'host' });
  await viewer.send('join', { roomId: 'scene-room', name: 'Cleo' });

  await host.send('scene:set', {
    scene: { type: 'song', payload: { title: 'Sunlight', artist: 'Amara' } },
  });
  const song = await viewer.next((message) => message.type === 'scene:update' && message.payload?.type === 'song');
  assert.equal(song.payload.payload.title, 'Sunlight');
  assert.equal(song.payload.persistent, true);

  await host.send('scene:set', {
    scene: { type: 'break', payload: { message: 'Back in a moment', countdownMs: 120000 } },
  });
  const brk = await viewer.next((message) => message.type === 'scene:update' && message.payload?.type === 'break');
  assert.equal(brk.payload.blocksProgram, true);

  await host.send('scene:clear', {});
  await viewer.next((message) => message.type === 'scene:update' && message.payload === null);

  await assert.rejects(
    () => host.send('scene:set', { scene: { type: 'title', payload: {} } }),
    /headline is required/,
  );

  host.close();
  viewer.close();
});

test('destinations are stored without echoing the stream key back', async () => {
  const host = connect();
  await host.open();
  await host.send('join', { roomId: 'dest-room', name: 'Ada', role: 'host' });

  const added = await host.send('destination:add', {
    destination: { platform: 'youtube', streamKey: 'super-secret-key', label: 'Main channel' },
  });
  assert.equal(added.destination.platform, 'youtube');
  assert.ok(!JSON.stringify(added.destination).includes('super-secret-key'));
  assert.match(added.destination.url, /a\.rtmp\.youtube\.com\/live2/);

  const pushed = await host.next((message) => message.type === 'destinations:update');
  assert.equal(pushed.payload.length, 1);
  assert.equal(pushed.payload[0].hasStreamKey, true);

  await assert.rejects(
    () => host.send('destination:add', { destination: { platform: 'youtube' } }),
    /stream key/,
  );

  const removed = await host.send('destination:remove', { destinationId: added.destination.id });
  assert.equal(removed.removed, added.destination.id);

  host.close();
});

test('program feeds are only accepted from the active publisher', async () => {
  const viewer = connect();
  await viewer.open();
  await viewer.send('join', { roomId: 'feed-room', name: 'Cleo' });

  viewer.socket.send(Buffer.from([1, 2, 3, 4]));
  const error = await viewer.next(
    (message) => message.type === 'error' && /not the active publisher/.test(message.message || ''),
  );
  assert.match(error.message, /not the active publisher/);

  viewer.close();
});
