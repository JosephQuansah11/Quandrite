import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { createServer } from '../server/index.ts';
import { iceServersFrom, loadConfig } from '../server/config.ts';
import { clockOffsetNs, decodeRelayFrame, encodeRelayFrame, isRelayFrame, monotonicNs, nsFromWire, nsToWire, relayLagNs } from '../shared/protocol.ts';

const silent = { info() {}, warn() {}, error() {} };

let quandrite;
let wsUrl;
let base;
let requestCounter = 0;
const openClients = new Set<any>();

/** A real 1×1 PNG, for the tests that send a picture. */
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

before(async () => {
  const config = loadConfig({
    recordingsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'quandrite-signal-')),
    uploadsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'quandrite-uploads-')),
  });
  quandrite = createServer({ config, logger: silent });
  const address = await quandrite.listen(0, '127.0.0.1');
  wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const client of openClients) client.socket.close();
  await quandrite.close();
});

function connect() {
  const socket = new WebSocket(wsUrl);
  const received = [];
  const binary = [];
  const waiters = [];
  openClients.add({ socket });

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      // Program chunks and relayed pictures both arrive as binary.
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      binary.push(buffer);
      return;
    }
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
    binary,
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
    send(type, payload: any = {}, timeoutMs = 8000) {
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
  assert.equal(welcome.protocolVersion, 2);
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

test('the welcome hands every client STUN and TURN, so calls cross networks', async () => {
  const client = connect();
  await client.open();
  const welcome = await client.next((message) => message.type === 'welcome');
  assert.ok(Array.isArray(welcome.iceServers), 'the welcome carries ICE servers');
  assert.ok(
    welcome.iceServers.some((server) => String(server.urls).includes('stun:')),
    'with a STUN server to find a route',
  );
  client.socket.close();
});

test('a configured TURN server is handed to every client', () => {
  // STUN alone cannot get through a symmetric NAT or a corporate firewall.
  const stunOnly = iceServersFrom({ stunUrls: ['stun:example.org:3478'] });
  assert.deepEqual(stunOnly, [{ urls: ['stun:example.org:3478'] }]);

  const relayed = iceServersFrom({
    stunUrls: ['stun:example.org:3478'],
    turnUrls: ['turn:relay.example.org:3478'],
    turnUsername: 'user',
    turnCredential: 'secret',
  });
  assert.deepEqual(relayed[1], {
    urls: ['turn:relay.example.org:3478'],
    username: 'user',
    credential: 'secret',
  });

  // And the studio server passes its own list on to the clients.
  const config = loadConfig({ turnUrls: ['turn:relay.example.org:3478'], turnUsername: 'u', turnCredential: 'p' });
  assert.ok(config.iceServers.some((server) => String(server.urls).includes('turn:')), 'the config exposes it');
});

test('a newcomer is handed the room as it already is', async () => {
  const host = connect();
  await host.open();
  await host.send('join', { roomId: 'warm-room', name: 'Ada', role: 'host' });

  // Somebody already in the room publishes a picture.
  const picture = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 7, 7, 7]);
  host.socket.send(
    encodeRelayFrame({ sourceId: 'camera:1', kind: 'camera', w: 320, h: 180, tns: nsToWire(monotonicNs()) }, picture),
  );
  await new Promise((r) => setTimeout(r, 200));

  // Somebody joins afterwards. They should see the room at once, not an empty
  // tile waiting for the next frame to happen along. (The socket is created here,
  // so `open()` is awaited while it is still connecting.)
  const latecomer = connect();
  await latecomer.open();
  await latecomer.send('join', { roomId: 'warm-room', name: 'Vic', role: 'viewer' });
  const deadline = Date.now() + 3000;
  while (!latecomer.binary.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

  assert.ok(latecomer.binary.length, 'the room arrives with them');
  const decoded = decodeRelayFrame(latecomer.binary.at(-1));
  assert.equal(decoded.header.warm, true, 'it is a still, marked as one');
  assert.equal(decoded.header.sourceId, 'camera:1', 'of the source it belongs to');
  assert.deepEqual([...decoded.payload], [...picture], 'and the picture is the one that was on screen');

  host.socket.close();
  latecomer.socket.close();
});

test('the clock exchange gives the room one nanosecond time base', async () => {
  const client = connect();
  await client.open();

  // The client asks what time it is, stamping its own clock on the way out.
  const t0 = monotonicNs();
  client.socket.send(JSON.stringify({ type: 'time:sync', id: 'clock-1' }));
  const reply = await client.next((message) => message.type === 'time:sync' && message.id === 'clock-1');
  const t3 = monotonicNs();

  assert.equal(typeof reply.t1, 'string', 'the server answers in nanoseconds, as text');
  assert.equal(typeof reply.t2, 'string', 'twice - on receipt and on send');
  assert.match(reply.t1, /^\d+$/, 'and they are whole numbers of nanoseconds');

  const sample = clockOffsetNs({ t0, t1: reply.t1, t2: reply.t2, t3 });
  assert.ok(sample, 'the exchange is enough to estimate an offset');
  assert.ok(sample.roundTripNs > 0n, `the round trip was measured (${sample.roundTripNs} ns)`);
  assert.ok(sample.roundTripNs < 2_000_000_000n, 'and it was fast, being a loopback socket');
  assert.ok(nsFromWire(reply.t2) >= nsFromWire(reply.t1), 'the server clock moved forward while answering');

  client.socket.close();
});

test('a relayed frame carries the server\'s own nanosecond arrival stamp', async () => {
  const host = connect();
  const sender = connect();
  await Promise.all([host.open(), sender.open()]);
  await host.send('join', { roomId: 'clock-room', name: 'Ada', role: 'host' });
  await sender.send('join', { roomId: 'clock-room', name: 'Vic', role: 'viewer' });
  await new Promise((r) => setTimeout(r, 100));

  // The sender stamps the picture with the server's clock (it measured its offset
  // at connect) - the same instant the server is about to stamp its arrival.
  const captured = monotonicNs();
  const picture = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 9, 9]);
  sender.socket.send(
    encodeRelayFrame({ sourceId: 'camera:1', kind: 'camera', w: 320, h: 180, tns: nsToWire(captured) }, picture),
  );

  const deadline = Date.now() + 4000;
  while (!host.binary.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(host.binary.length, 'the room receives the picture');

  const decoded = decodeRelayFrame(host.binary.at(-1));
  assert.equal(decoded.header.tns, nsToWire(captured), 'the sender\'s nanosecond stamp is passed through untouched');
  const arrived = nsFromWire(decoded.header.srv);
  assert.ok(arrived !== null, 'and the server added its own arrival stamp');

  // Both stamps are on the same clock, so the two hops can be told apart - which is
  // the whole point of a shared nanosecond time base.
  const lag = relayLagNs(decoded.header, monotonicNs());
  assert.ok(lag.inboundNs !== null && lag.outboundNs !== null, 'so both hops are measurable');
  assert.ok(lag.inboundNs >= 0n, `the sender-to-server hop is sane (${lag.inboundNs} ns)`);
  assert.ok(lag.totalNs === lag.inboundNs + lag.outboundNs, 'and the hops add up to the total');

  host.socket.close();
  sender.socket.close();
});

test('voice relayed over the socket is not throttled like pictures', async () => {
  const host = connect();
  const speaker = connect();
  await Promise.all([host.open(), speaker.open()]);
  await host.send('join', { roomId: 'voice-room', name: 'Ada', role: 'host' });
  await speaker.send('join', { roomId: 'voice-room', name: 'Vic', role: 'viewer' });
  await new Promise((r) => setTimeout(r, 100));

  // Twenty milliseconds of voice, twice, back to back: at the picture rate the
  // second slice would be thrown away and the sound would be chopped up.
  const slice = Buffer.alloc(640);
  for (let i = 0; i < slice.length; i += 2) slice.writeInt16LE(i * 8, i);
  speaker.socket.send(
    encodeRelayFrame({ sourceId: 'mic:1', kind: 'audio', rate: 16000, t: Date.now() }, slice),
  );
  speaker.socket.send(
    encodeRelayFrame({ sourceId: 'mic:1', kind: 'audio', rate: 16000, t: Date.now() }, slice),
  );

  const deadline = Date.now() + 4000;
  while (host.binary.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(host.binary.length, 2, 'both slices reach the room');

  const decoded = decodeRelayFrame(host.binary.at(-1));
  assert.equal(decoded.header.kind, 'audio', 'tagged as voice');
  assert.equal(decoded.header.rate, 16000, 'at the rate it was captured');
  assert.deepEqual([...decoded.payload], [...slice], 'and the samples are untouched');

  // A second picture in the same instant *is* thinned out: the two budgets are
  // separate, so voice never loses its steadiness to a burst of pictures.
  const picture = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]);
  const pictures = host.binary.length;
  for (let i = 0; i < 3; i += 1) {
    speaker.socket.send(
      encodeRelayFrame({ sourceId: 'camera:1', kind: 'camera', w: 480, h: 270 }, picture),
    );
  }
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(host.binary.length, pictures + 1, 'only one picture gets through per interval');

  host.socket.close();
  speaker.socket.close();
});

test('a camera picture relayed over the socket reaches the room', async () => {
  const host = connect();
  const viewer = connect();
  await Promise.all([host.open(), viewer.open()]);
  await host.send('join', { roomId: 'relay-room', name: 'Ada', role: 'host' });
  await viewer.send('join', { roomId: 'relay-room', name: 'Vic', role: 'viewer' });

  // The viewer cannot reach the host peer to peer, so it posts a picture instead.
  const picture = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]);
  viewer.socket.send(
    encodeRelayFrame({ sourceId: 'camera:1', kind: 'camera', label: 'Vic camera', w: 480, h: 270 }, picture),
  );

  const deadline = Date.now() + 4000;
  while (!host.binary.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(host.binary.length, 'the room receives the picture');
  const decoded = decodeRelayFrame(host.binary.at(-1));
  assert.ok(decoded, 'and it is still a relay frame');
  assert.equal(decoded.header.sourceId, 'camera:1', 'the source it belongs to travels with it');
  assert.equal(decoded.header.fromName, 'Vic', 'so does who sent it');
  assert.deepEqual([...decoded.payload], [...picture], 'and the picture is untouched');

  // The program feed is untouched by all of this: a WebM chunk is still a chunk.
  assert.equal(isRelayFrame(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00])), false);

  host.socket.close();
  viewer.socket.close();
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

test('a participant publishes their own camera and asks for the grid', async () => {
  const host = connect();
  const visitor = connect();
  await Promise.all([host.open(), visitor.open()]);
  await host.send('join', { roomId: 'gate-room', name: 'Ada', role: 'host' });
  const joined = await visitor.send('join', { roomId: 'gate-room', name: 'Vic', role: 'visitor' });
  assert.equal(joined.role, 'visitor');

  // A participant may publish their own camera - and only their own.
  const added = await visitor.send('source:add', {
    source: { id: 'cam-9', kind: 'camera', label: 'Vic camera', ownerId: 'someone-else' },
  });
  assert.equal(added.source.ownerId, joined.clientId, 'ownership is always the caller');

  const seen = await host.next(
    (message) => message.type === 'sources:update' && message.payload.some((source) => source.id === 'cam-9'),
  );
  assert.equal(seen.payload.find((source) => source.id === 'cam-9').request, null);

  // The host is told what the participant wants, immediately.
  const asked = await visitor.send('source:update', { sourceId: 'cam-9', patch: { request: 'grid' } });
  assert.equal(asked.source.request, 'grid');
  const requestSeen = await host.next(
    (message) =>
      message.type === 'sources:update' &&
      message.payload.some((source) => source.id === 'cam-9' && source.request === 'grid'),
  );
  assert.equal(requestSeen.payload.find((source) => source.id === 'cam-9').request, 'grid');

  // The program and other people's sources stay out of reach.
  await assert.rejects(() => visitor.send('program:set', { mode: 'grid' }), /only the host or a co-host/);
  await host.send('source:add', { source: { id: 'cam-host', kind: 'camera', label: 'Host camera' } });
  await assert.rejects(() => visitor.send('source:remove', { sourceId: 'cam-host' }), /not your source/);
  await assert.rejects(
    () => visitor.send('source:update', { sourceId: 'cam-host', patch: { request: 'air' } }),
    /not your source/,
  );

  // The host applies the request and it clears itself.
  const applied = await host.send('program:set', { mode: 'grid', gridIds: ['cam-9'] });
  assert.deepEqual(applied.program.onAir, ['cam-9']);
  const cleared = await visitor.next(
    (message) =>
      message.type === 'sources:update' &&
      message.payload.some((source) => source.id === 'cam-9' && source.request === null),
  );
  assert.equal(cleared.payload.find((source) => source.id === 'cam-9').request, null);

  host.close();
  visitor.close();
});

test('claiming the host or co-host seat needs the room password', async () => {
  const host = connect();
  const viewer = connect();
  await Promise.all([host.open(), viewer.open()]);

  const joined = await host.send('join', { roomId: 'seat-room', name: 'Ada', role: 'host' });
  assert.equal(joined.role, 'host');
  assert.ok(joined.credentials?.cohostPassword, 'the host is given the passwords to share');

  const viewerJoin = await viewer.send('join', { roomId: 'seat-room', name: 'Cleo' });
  assert.equal(viewerJoin.role, 'viewer');
  assert.equal(viewerJoin.credentials, null, 'a viewer never receives the passwords');
  assert.ok(!JSON.stringify(viewerJoin.snapshot).includes(joined.credentials.cohostPassword));

  await assert.rejects(
    () => viewer.send('join', { roomId: 'seat-room', name: 'Cleo', role: 'cohost', password: 'wrong' }),
    /co-host password/,
  );

  const claimed = await viewer.send('join', {
    roomId: 'seat-room',
    name: 'Cleo',
    role: 'cohost',
    password: joined.credentials.cohostPassword,
  });
  assert.equal(claimed.role, 'cohost');

  // The promoted member can now drive the broadcast.
  await host.send('source:add', { source: { id: 'cam-1', kind: 'camera', label: 'Camera 1' } });
  const acked = await viewer.send('program:set', { mode: 'single', sourceId: 'cam-1' });
  assert.equal(acked.program.mode, 'single');
  assert.deepEqual(acked.program.onAir, ['cam-1']);

  host.close();
  viewer.close();
});

test('the host splits the room into breakouts, and each participant picks one', async () => {
  const host = connect();
  const first = connect();
  const second = connect();
  await Promise.all([host.open(), first.open(), second.open()]);
  const hostJoin = await host.send('join', { roomId: 'split-room', name: 'Ada', role: 'host' });
  const firstJoin = await first.send('join', { roomId: 'split-room', name: 'Bob' });
  await second.send('join', { roomId: 'split-room', name: 'Cleo' });

  const created = await host.send('breakout:create', { count: 2, labels: ['Design', 'Build'] });
  assert.equal(created.breakouts.rooms.length, 2);
  assert.deepEqual(created.breakouts.rooms.map((room) => room.label), ['Design', 'Build']);
  const rooms = created.breakouts.rooms;
  const roomOf = (clientId) => rooms.find((room) => room.memberIds.includes(clientId));

  const pushed = await first.next(
    (message) => message.type === 'breakouts:update' && message.payload.rooms.length === 2,
  );
  assert.equal(pushed.payload.rooms.every((room) => room.open === false), true);

  // A breakout room is not a room you can walk into directly.
  await assert.rejects(
    () => host.send('join', { roomId: rooms[0].id, name: 'Ada', role: 'host' }),
    /parent room/,
  );

  // Creating the rooms *suggests* where people could go, and moves nobody: the whole
  // point of the picker is that walking into a room is the participant's own choice.
  assert.equal(roomOf(firstJoin.clientId).id, rooms[0].id, 'the host spread is recorded');
  assert.equal(
    first.received.some((message) => message.type === 'breakout:update'),
    false,
    'but nobody is moved by a suggestion',
  );

  // Opening them announces them, and still moves nobody.
  await host.send('breakout:open', {});
  const opened = await first.next(
    (message) => message.type === 'breakouts:update' && message.payload.rooms.every((room) => room.open),
  );
  assert.ok(opened, 'the room is told the rooms are open');
  assert.equal(
    first.received.some((message) => message.type === 'breakout:update'),
    false,
    'opening does not take anybody anywhere',
  );

  // Bob chooses the second room - not the one he was suggested.
  await first.send('breakout:assign', { breakoutId: rooms[1].id });
  const firstMove = await first.next((message) => message.type === 'breakout:update');
  assert.equal(firstMove.payload.breakoutId, rooms[1].id);
  assert.equal(firstMove.payload.members.length, 3, 'the moved participant keeps the roster');
  assert.equal(firstMove.payload.state.room.id, 'split-room', 'the studio state stays the parent room');
  assert.ok(Array.isArray(firstMove.payload.state.chat));

  // Cleo chooses the first one, at the same time.
  await second.send('breakout:assign', { breakoutId: rooms[0].id });
  const secondMove = await second.next((message) => message.type === 'breakout:update');
  assert.equal(secondMove.payload.breakoutId, rooms[0].id);

  // Chat is scoped to the room you are in.
  await first.send('chat:send', { text: 'inside the breakout' });
  assert.equal(
    first.received.some((message) => message.type === 'chat:new' && message.payload.text === 'inside the breakout'),
    true,
  );
  await host.send('chat:send', { text: 'main room only' });
  await host.next((message) => message.type === 'chat:new' && message.payload.text === 'main room only');
  assert.equal(
    host.received.some((message) => message.type === 'chat:new' && message.payload.text === 'inside the breakout'),
    false,
    'the main room does not hear a breakout',
  );
  assert.equal(
    second.received.some((message) => message.type === 'chat:new' && message.payload.text === 'inside the breakout'),
    false,
    'one breakout does not hear another',
  );

  // The host moves one participant into the other room: a host's move *is* a move.
  const moved = await host.send('breakout:assign', { memberId: firstJoin.clientId, breakoutId: rooms[0].id });
  assert.equal(moved.member.breakoutId, rooms[0].id);
  const followUp = await first.next(
    (message) => message.type === 'breakout:update' && message.payload.breakoutId === rooms[0].id,
  );
  assert.equal(followUp.payload.breakoutId, rooms[0].id);

  // The participant can go home by themselves.
  await first.send('breakout:assign', { breakoutId: null });
  const home = await first.next((message) => message.type === 'breakout:update' && message.payload.breakoutId === null);
  assert.equal(home.payload.breakoutId, null);
  assert.equal(home.payload.members.find((member) => member.id === firstJoin.clientId).breakoutId, null);

  // Closing brings everyone back but keeps the groups.
  await host.send('breakout:close', {});
  const closed = await second.next(
    (message) => message.type === 'breakout:update' && message.payload.breakoutId === null,
  );
  assert.equal(closed.payload.breakoutId, null);
  assert.equal(closed.payload.breakouts.rooms.every((room) => !room.open), true);
  assert.equal(closed.payload.members.some((member) => member.breakoutId), true, 'assignments are kept');

  // Reopening does not put them straight back: they choose again, which is the point.
  await host.send('breakout:open', {});
  await second.next((message) => message.type === 'breakouts:update' && message.payload.rooms.every((room) => room.open));
  assert.equal(
    second.received.filter((message) => message.type === 'breakout:update').length,
    2,
    'reopening does not move anybody either',
  );

  const cleared = await host.send('breakout:clear', {});
  assert.equal(cleared.breakouts.rooms.length, 0);
  const afterClear = await second.next(
    (message) => message.type === 'breakout:update' && message.payload.breakouts.rooms.length === 0,
  );
  assert.equal(afterClear.payload.breakoutId, null);
  assert.equal(afterClear.payload.members.every((member) => member.breakoutId === null), true);
  assert.equal(hostJoin.role, 'host');

  host.close();
  first.close();
  second.close();
});

test('the host grants co-hosts without a password and rotates the room passwords', async () => {
  const host = connect();
  const viewer = connect();
  await Promise.all([host.open(), viewer.open()]);

  const joined = await host.send('join', { roomId: 'grant-room', name: 'Ada', role: 'host' });
  const viewerJoin = await viewer.send('join', { roomId: 'grant-room', name: 'Cleo' });
  assert.equal(viewerJoin.role, 'viewer');

  await assert.rejects(
    () => viewer.send('member:role', { memberId: viewerJoin.clientId, role: 'cohost' }),
    /only the host/,
  );
  await assert.rejects(() => viewer.send('room:update', { cohostPassword: 'hijack' }), /only the host/);

  const granted = await host.send('member:role', { memberId: viewerJoin.clientId, role: 'cohost' });
  assert.equal(granted.member.role, 'cohost');
  const seen = await viewer.next(
    (message) =>
      message.type === 'members:update' &&
      message.payload.some((member) => member.id === viewerJoin.clientId && member.role === 'cohost'),
  );
  assert.ok(seen.payload.length >= 2);

  const rotated = await host.send('room:update', {
    hostPassword: 'hostpass',
    cohostPassword: 'cohostpass',
  });
  assert.deepEqual(rotated.credentials, { hostPassword: 'hostpass', cohostPassword: 'cohostpass' });
  assert.notEqual(rotated.credentials.cohostPassword, joined.credentials.cohostPassword);

  // The old co-host password stops working; the new one does.
  const late = connect();
  await late.open();
  await assert.rejects(
    () =>
      late.send('join', {
        roomId: 'grant-room',
        name: 'Dee',
        role: 'cohost',
        password: joined.credentials.cohostPassword,
      }),
    /co-host password/,
  );
  const lateJoin = await late.send('join', {
    roomId: 'grant-room',
    name: 'Dee',
    role: 'cohost',
    password: 'cohostpass',
  });
  assert.equal(lateJoin.role, 'cohost');

  late.close();
  host.close();
  viewer.close();
});

test('breakout rooms are a host tool, and everyone can come home', async () => {
  const host = connect();
  const viewer = connect();
  await Promise.all([host.open(), viewer.open()]);
  await host.send('join', { roomId: 'bo-room', name: 'Ada', role: 'host' });
  const viewerJoin = await viewer.send('join', { roomId: 'bo-room', name: 'Cleo' });
  const hostJoin = await host.send('join', { roomId: 'bo-room', name: 'Ada' });

  const created = await host.send('breakout:create', { count: 2 });
  const rooms = created.breakouts.rooms;
  assert.equal(rooms[0].memberIds.includes(viewerJoin.clientId), true, 'participants are spread out');

  // A viewer cannot run the breakout rooms.
  await assert.rejects(() => viewer.send('breakout:create', { count: 3 }), /only the host or a co-host/);
  await assert.rejects(() => viewer.send('breakout:open', {}), /only the host or a co-host/);
  await assert.rejects(() => viewer.send('breakout:close', {}), /only the host or a co-host/);
  await assert.rejects(() => viewer.send('breakout:clear', {}), /only the host or a co-host/);
  await assert.rejects(() => viewer.send('breakout:shuffle', {}), /only the host or a co-host/);
  await assert.rejects(() => viewer.send('breakout:announce', { text: 'hi' }), /only the host or a co-host/);
  await assert.rejects(
    () => viewer.send('breakout:assign', { memberId: viewerJoin.clientId, breakoutId: rooms[0].id }),
    /not open yet/,
    'a closed breakout cannot be entered',
  );

  // The host can reshuffle the groups.
  const shuffled = await host.send('breakout:shuffle', {});
  assert.equal(shuffled.breakouts.rooms.reduce((total, room) => total + room.memberCount, 0), 1);
  const assigned = shuffled.breakouts.rooms.find((room) => room.memberIds.includes(viewerJoin.clientId));

  await host.send('breakout:open', { breakoutId: assigned.id });
  // The room is told it is open; nobody is moved into it.
  await viewer.next(
    (message) => message.type === 'breakouts:update' && message.payload.rooms.some((room) => room.id === assigned.id && room.open),
  );
  assert.equal(
    viewer.received.some((message) => message.type === 'breakout:update'),
    false,
    'opening a room does not move anyone into it',
  );
  assert.equal(
    viewer.received.some(
      (message) => message.type === 'breakouts:update' && message.payload.rooms.some((room) => room.id !== assigned.id && room.open),
    ),
    false,
    'only the room that was opened is open',
  );

  // A participant walks into the room themselves, and leaves it again.
  await viewer.send('breakout:assign', { breakoutId: assigned.id });
  const entered = await viewer.next((message) => message.type === 'breakout:update');
  assert.equal(entered.payload.breakoutId, assigned.id, 'a participant can choose any open room');
  await assert.rejects(
    () => viewer.send('breakout:assign', { memberId: hostJoin.clientId, breakoutId: null }),
    /only the host or a co-host/,
  );

  const announced = await host.send('breakout:announce', { text: 'two minutes left' });
  assert.equal(announced.delivered, 3, 'the main room and both breakouts are told');
  const heard = await viewer.next(
    (message) => message.type === 'chat:new' && /two minutes left/.test(message.payload.text),
  );
  assert.equal(heard.payload.kind, 'system');

  // A breakout room cannot be joined directly, and it is not listed as a room.
  await assert.rejects(
    () => viewer.send('join', { roomId: assigned.id, name: 'Cleo' }),
    /parent room/,
  );
  const httpBase = wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
  const listed = await fetch(`${httpBase}/api/rooms`).then((response) => response.json());
  assert.equal(listed.rooms.some((room) => room.id === assigned.id), false);

  const closed = await host.send('breakout:close', { breakoutId: assigned.id });
  assert.equal(closed.breakouts.rooms.find((room) => room.id === assigned.id).open, false);
  const home = await viewer.next(
    (message) => message.type === 'breakout:update' && message.payload.breakoutId === null,
  );
  assert.equal(home.payload.breakoutId, null);

  host.close();
  viewer.close();
});

test('the recording library is pushed, so the tab never needs a refresh', async () => {
  const client = connect();
  await client.open();
  await client.send('join', { roomId: 'library-room', name: 'Ada', role: 'host' });

  // A recording finishes: the server pushes the new library to the room.
  await quandrite.recordingStore.create({
    roomId: 'library-room',
    roomName: 'Library room',
    format: 'mp4',
    preset: '720p30',
    destinations: [],
  });
  await quandrite.signaling.broadcastRecordings('library-room');

  const pushed = await client.next((message) => message.type === 'recordings:update');
  assert.equal(pushed.payload.roomId, 'library-room');
  assert.equal(pushed.payload.recordings.length, 1);
  assert.equal(pushed.payload.recordings[0].roomId, 'library-room');
  assert.ok(pushed.payload.recordings[0].downloadUrl);

  client.close();
});

test('a breakout room has its own primary screen, and anybody in it can share to it', async () => {
  const host = connect();
  const guest = connect();
  const other = connect();
  await Promise.all([host.open(), guest.open(), other.open()]);
  await host.send('join', { roomId: 'screen-room', name: 'Ada', role: 'host' });
  const guestJoin = await guest.send('join', { roomId: 'screen-room', name: 'Bob' });
  const otherJoin = await other.send('join', { roomId: 'screen-room', name: 'Cleo' });

  const created = await host.send('breakout:create', { count: 2, labels: ['Design', 'Build'] });
  const rooms = created.breakouts.rooms;
  await host.send('breakout:open', {});

  // The broadcast is the parent's, and it stays the parent's.
  await host.send('source:add', { source: { id: 'host-cam', kind: 'camera', label: 'Ada camera' } });
  await host.send('program:set', { mode: 'single', sourceId: 'host-cam' });
  const broadcast = await host.next(
    (message) => message.type === 'program:update' && message.payload.sourceId === 'host-cam',
  );
  assert.equal(broadcast.payload.sourceId, 'host-cam', 'the parent has its own program');

  // Bob walks into Design and shares his screen there.
  await guest.send('breakout:assign', { breakoutId: rooms[0].id });
  const moved = await guest.next((message) => message.type === 'breakout:update');
  assert.equal(moved.payload.breakoutId, rooms[0].id);
  assert.deepEqual(moved.payload.roomState.sources, [], 'the room he walked into has its own empty screen');
  assert.equal(moved.payload.state.program.sourceId, 'host-cam', 'while the broadcast is still the parent\'s');

  await guest.send('source:add', { source: { id: 'bob-screen', kind: 'screen', label: 'Bob screen' } });
  const designSources = await guest.next(
    (message) => message.type === 'breakout:sources' && message.payload.some((source) => source.id === 'bob-screen'),
  );
  assert.ok(designSources, 'the breakout is told about the screen shared in it');

  // Nobody in the *other* breakout hears about it, and neither does the main room.
  assert.equal(
    other.received.some((message) => message.type === 'breakout:sources'),
    false,
    'another breakout is not told',
  );
  assert.equal(
    host.received.some((message) => message.type === 'breakout:sources'),
    false,
    'and neither is the main room',
  );
  assert.equal(
    host.received.some(
      (message) => message.type === 'sources:update' && message.payload.some((source) => source.id === 'bob-screen'),
    ),
    false,
    'the broadcast never sees it',
  );

  // Bob puts his own screen up in his own room - no host needed.
  await guest.send('program:set', { mode: 'single', sourceId: 'bob-screen' });
  const designProgram = await guest.next(
    (message) => message.type === 'breakout:program' && message.payload.sourceId === 'bob-screen',
  );
  assert.equal(designProgram.payload.sourceId, 'bob-screen', 'the breakout\'s screen is his to share');
  assert.equal(
    host.received.some((message) => message.type === 'program:update' && message.payload.sourceId === 'bob-screen'),
    false,
    'and the broadcast is untouched by it',
  );

  // ...but not somebody else's: the breakout screen is a shared table, not a free-for-all.
  await other.send('breakout:assign', { breakoutId: rooms[0].id });
  await other.send('source:add', { source: { id: 'cleo-cam', kind: 'camera', label: 'Cleo camera' } });
  await assert.rejects(
    () => guest.send('program:set', { mode: 'single', sourceId: 'cleo-cam' }),
    /your own screen up, but not somebody else's/,
  );
  // A bare mode change is a decision about the room, so it needs control there too.
  await assert.rejects(() => guest.send('program:set', { mode: 'grid' }), /not somebody else's/);
  // Cleo may put her own camera up.
  await other.send('program:set', { mode: 'single', sourceId: 'cleo-cam' });
  await guest.next((message) => message.type === 'breakout:program' && message.payload.sourceId === 'cleo-cam');

  // Walking out takes the screen with him: the room is not left showing it.
  await guest.send('breakout:assign', { breakoutId: null });
  const emptied = await other.next(
    (message) => message.type === 'breakout:sources' && !message.payload.some((source) => source.id === 'bob-screen'),
  );
  assert.ok(emptied, 'his screen leaves the room with him');

  host.close();
  guest.close();
  other.close();
});

test('a participant picks their own breakout room, and the host can rename one', async () => {
  const host = connect();
  const guest = connect();
  await Promise.all([host.open(), guest.open()]);
  await host.send('join', { roomId: 'pick-room', name: 'Ada', role: 'host' });
  const guestJoin = await guest.send('join', { roomId: 'pick-room', name: 'Bob' });

  const created = await host.send('breakout:create', { count: 2 });
  const rooms = created.breakouts.rooms;
  assert.equal(rooms.length, 2);

  // Closed rooms are not walkable-into yet, by anyone.
  await assert.rejects(
    () => guest.send('breakout:assign', { breakoutId: rooms[0].id }),
    /not open yet/,
  );

  // The host opens them, and the guest chooses the second one for themselves - the
  // assignment the host never made.
  await host.send('breakout:open', {});
  const moved = await guest.send('breakout:assign', { breakoutId: rooms[1].id });
  assert.equal(moved.member.breakoutId, rooms[1].id, 'the participant chose their own room');
  const roster = await host.next(
    (message) => message.type === 'members:update' && message.payload.some((member) => member.id === guestJoin.clientId && member.breakoutId === rooms[1].id),
  );
  assert.ok(roster, 'and the room sees where they went');
  const catalogue = await host.next(
    (message) => message.type === 'breakouts:update' && message.payload.rooms.some((room) => room.id === rooms[1].id && room.memberCount === 1),
  );
  assert.ok(catalogue, 'the room count follows');

  // Back to the main room is the same choice in reverse.
  const home = await guest.send('breakout:assign', { breakoutId: null });
  assert.equal(home.member.breakoutId, null);

  // Renaming: a host can, a participant cannot, and an empty name is refused.
  await assert.rejects(() => guest.send('breakout:rename', { breakoutId: rooms[0].id, label: 'Design' }), /only the host or a co-host/);
  await assert.rejects(() => host.send('breakout:rename', { breakoutId: rooms[0].id, label: '   ' }), /needs a name/);
  const renamed = await host.send('breakout:rename', { breakoutId: rooms[0].id, label: 'Design' });
  assert.equal(renamed.breakouts.rooms.find((room) => room.id === rooms[0].id).label, 'Design');
  // The breakout room itself is renamed too, so somebody inside it sees the new name.
  assert.match(quandrite.registry.get(rooms[0].id).name, /Design$/);
  const told = await guest.next(
    (message) => message.type === 'chat:new' && /is now called "Design"/.test(message.payload.text),
  );
  assert.ok(told, 'and the room is told about it');

  host.close();
  guest.close();
});

test('a private message reaches two people, and a picture has to be one of ours', async () => {
  const host = connect();
  const guest = connect();
  const other = connect();
  await Promise.all([host.open(), guest.open(), other.open()]);
  const hostJoin = await host.send('join', { roomId: 'dm-room', name: 'Ada', role: 'host' });
  const guestJoin = await guest.send('join', { roomId: 'dm-room', name: 'Bob' });
  await other.send('join', { roomId: 'dm-room', name: 'Cleo' });

  // A private message reaches the sender and the recipient, and nobody else.
  await host.send('chat:send', { text: 'just between us', to: guestJoin.clientId });
  const seen = await guest.next((message) => message.type === 'chat:new' && message.payload.text === 'just between us');
  assert.equal(seen.payload.to, guestJoin.clientId);
  assert.equal(seen.payload.authorName, 'Ada');
  const mine = await host.next((message) => message.type === 'chat:new' && message.payload.text === 'just between us');
  assert.equal(mine.payload.to, guestJoin.clientId);
  // The third person's next message is their own, never the private one.
  await other.send('chat:send', { text: 'hello everyone' });
  const thirdSaw = await other.next((message) => message.type === 'chat:new' && message.payload.authorName === 'Cleo');
  assert.equal(thirdSaw.payload.text, 'hello everyone');

  // The room's history never carries a private message, and the two people keep theirs.
  const studio = quandrite.registry.get('dm-room');
  assert.equal(studio.chat.some((entry) => entry.text === 'just between us'), false, 'the room does not see it');
  const threads = studio.privateThreadsFor(guestJoin.clientId);
  assert.equal(threads[hostJoin.clientId]?.length, 1, 'but the pair keeps it');
  assert.equal(threads[hostJoin.clientId][0].text, 'just between us');
  // Nobody else has a thread at all.
  const others = studio.privateThreadsFor('someone-else');
  assert.deepEqual(others, {}, 'and nobody else has one');

  // A private message to somebody who is not here is refused.
  await assert.rejects(() => host.send('chat:send', { text: 'hi', to: 'nobody' }), /not in this room/);

  // A picture has to be a real one, uploaded first: a made-up URL is refused.
  await assert.rejects(
    () => host.send('chat:send', { text: 'look', attachment: { url: 'https://example.com/tracker.gif', mime: 'image/gif' } }),
    /not available/,
  );
  const upload = await fetch(`${base}/api/rooms/dm-room/chat/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl: 'data:text/plain;base64,aGVsbG8=', name: 'not-a-picture.txt' }),
  });
  assert.equal(upload.status, 400, 'a text file is not a picture');
  const real = await fetch(`${base}/api/rooms/dm-room/chat/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl: `data:image/png;base64,${PIXEL_PNG}`, name: 'pixel.png', width: 1, height: 1 }),
  });
  assert.equal(real.status, 200, 'a real one is stored');
  const stored = await real.json();
  assert.match(stored.attachment.url, /^\/uploads\/dm-room-[0-9a-f-]+\.png$/, 'under a name the server invented');
  const served = await fetch(`${base}${stored.attachment.url}`);
  assert.equal(served.status, 200, 'and served back');
  await host.send('chat:send', { text: '', attachment: stored.attachment });
  const picture = await guest.next((message) => message.type === 'chat:new' && message.payload.attachment);
  assert.equal(picture.payload.attachment.url, stored.attachment.url, 'a picture travels as a URL');
  assert.equal(picture.payload.text, '', 'and needs no words');

  host.close();
  guest.close();
  other.close();
});

test('the host can mute and stop video for anyone, and nobody else can', async () => {
  const host = connect();
  const first = connect();
  const second = connect();
  await Promise.all([host.open(), first.open(), second.open()]);
  await host.send('join', { roomId: 'media-room', name: 'Ada', role: 'host' });
  const firstJoin = await first.send('join', { roomId: 'media-room', name: 'Bob' });
  const secondJoin = await second.send('join', { roomId: 'media-room', name: 'Cleo' });

  // A participant cannot switch anyone's media.
  await assert.rejects(
    () => first.send('member:media', { memberId: secondJoin.clientId, muted: true }),
    /only the host or a co-host/,
  );
  await assert.rejects(() => host.send('member:media', { memberId: firstJoin.clientId }), /nothing to change/);

  // The host mutes one participant, whose own client is told immediately.
  const muted = await host.send('member:media', { memberId: firstJoin.clientId, muted: true });
  assert.equal(muted.changed, 1);
  const told = await first.next((message) => message.type === 'member:media');
  assert.equal(told.muted, true);
  assert.equal(told.byName, 'Ada');
  const roster = await host.next(
    (message) =>
      message.type === 'members:update' &&
      message.payload.some((member) => member.id === firstJoin.clientId && member.muted),
  );
  assert.equal(roster.payload.find((member) => member.id === firstJoin.clientId).muted, true);

  // "Mute all" is one message that reaches everyone else.
  const all = await host.send('member:media', { all: true, muted: true });
  assert.equal(all.changed, 2);
  const secondTold = await second.next((message) => message.type === 'member:media' && message.muted === true);
  assert.equal(secondTold.muted, true);

  // Stopping every video is the same message with the other flag.
  const stopped = await host.send('member:media', { all: true, cameraEnabled: false });
  assert.equal(stopped.changed, 2);
  const cameraOff = await first.next(
    (message) => message.type === 'member:media' && message.cameraEnabled === false,
  );
  assert.equal(cameraOff.cameraEnabled, false);

  host.close();
  first.close();
  second.close();
});

test('a host mute of one person survives their reload, and a sweep does not', async () => {
  const host = connect();
  const guest = connect();
  await Promise.all([host.open(), guest.open()]);
  await host.send('join', { roomId: 'hold-room', name: 'Ada', role: 'host' });
  const guestJoin = await guest.send('join', { roomId: 'hold-room', name: 'Bob' });
  assert.equal(
    guestJoin.snapshot.members.find((member) => member.id === guestJoin.clientId).muted,
    false,
    'nobody arrives muted',
  );

  // The host mutes Bob: a decision about a person, not about the moment.
  await host.send('member:media', { memberId: guestJoin.clientId, muted: true });
  guest.close();

  // Bob reloads - a new connection, the same name.
  const back = connect();
  await back.open();
  const rejoin = await back.send('join', { roomId: 'hold-room', name: 'bob' });
  assert.equal(
    rejoin.snapshot.members.find((member) => member.id === rejoin.clientId).muted,
    true,
    'and comes back muted, however the name is typed',
  );

  // Unmuting is the member's own call, and it holds for that visit.
  await back.send('member:update', { patch: { muted: false } });
  const unmuted = await host.next(
    (message) =>
      message.type === 'members:update' &&
      message.payload.some((member) => member.id === rejoin.clientId && !member.muted),
  );
  assert.equal(unmuted.payload.find((member) => member.id === rejoin.clientId).muted, false);

  // A host who unmutes them clears the note: the next visit arrives unmuted.
  await host.send('member:media', { memberId: rejoin.clientId, muted: true });
  await host.send('member:media', { memberId: rejoin.clientId, muted: false });
  const third = connect();
  await third.open();
  const thirdJoin = await third.send('join', { roomId: 'hold-room', name: 'Bob' });
  assert.equal(
    thirdJoin.snapshot.members.find((member) => member.id === thirdJoin.clientId).muted,
    false,
    'the host clearing the note means they arrive unmuted',
  );

  // "Mute all" is a sweep: it says nothing about any one person, so a reload is unmuted.
  await host.send('member:media', { all: true, muted: true });
  const fourth = connect();
  await fourth.open();
  const fourthJoin = await fourth.send('join', { roomId: 'hold-room', name: 'Cleo' });
  assert.equal(
    fourthJoin.snapshot.members.find((member) => member.id === fourthJoin.clientId).muted,
    false,
    'a sweep is not a standing decision',
  );

  host.close();
  back.close();
  third.close();
  fourth.close();
});
