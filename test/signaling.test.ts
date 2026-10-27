import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { createServer } from '../server/index.ts';
import { loadConfig } from '../server/config.ts';

const silent = { info() {}, warn() {}, error() {} };

let quandrite;
let wsUrl;
let requestCounter = 0;
const openClients = new Set<any>();

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

test('the host splits the room into breakouts and everyone follows', async () => {
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

  await host.send('breakout:open', {});
  const firstMove = await first.next((message) => message.type === 'breakout:update');
  const secondMove = await second.next((message) => message.type === 'breakout:update');
  assert.equal(firstMove.payload.breakoutId, roomOf(firstJoin.clientId).id);
  assert.equal(secondMove.payload.breakoutId, rooms[1].id);
  assert.equal(firstMove.payload.members.length, 3, 'the moved participant keeps the roster');
  assert.equal(firstMove.payload.state.room.id, 'split-room', 'the studio state stays the parent room');
  assert.ok(Array.isArray(firstMove.payload.state.chat));

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

  // The host moves one participant into the other room.
  const moved = await host.send('breakout:assign', { memberId: firstJoin.clientId, breakoutId: rooms[1].id });
  assert.equal(moved.member.breakoutId, rooms[1].id);
  const followUp = await first.next((message) => message.type === 'breakout:update' && message.payload.breakoutId === rooms[1].id);
  assert.equal(followUp.payload.breakoutId, rooms[1].id);

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

  // Reopening puts them straight back.
  await host.send('breakout:open', {});
  const again = await second.next(
    (message) => message.type === 'breakout:update' && message.payload.breakoutId === rooms[1].id,
  );
  assert.equal(again.payload.breakoutId, rooms[1].id);

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
  const moved = await viewer.next((message) => message.type === 'breakout:update');
  assert.equal(moved.payload.breakoutId, assigned.id);
  assert.equal(
    moved.payload.breakouts.rooms.find((room) => room.id !== assigned.id).open,
    false,
    'only the room that was opened is open',
  );

  // A participant may join their own open room and leave it again.
  await viewer.send('breakout:assign', { breakoutId: assigned.id });
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
