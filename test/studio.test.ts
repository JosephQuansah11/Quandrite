import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { Studio } from '../server/studio.ts';
import { RecordingStore } from '../server/recordings.ts';
import { loadConfig } from '../server/config.ts';

const silent = { info() {}, warn() {}, error() {} };

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `quandrite-${name}-`));
}

// The tests poke at internals, so the helper hands back a loosely typed studio.
function makeStudio(overrides: any = {}): any {
  const config = loadConfig({ recordingsDir: tmpDir('studio'), ...(overrides.config || {}) });
  // A stand-in for the room registry: breakout rooms are just ids plus chat.
  const breakoutRooms = new Map();
  const adapter =
    overrides.breakoutRooms === undefined
      ? {
          create: ({ id }) => {
            const room = {
              id,
              chat: [],
              addChat: (message) => {
                room.chat.push(message);
                return message;
              },
            };
            breakoutRooms.set(id, room);
            return room;
          },
          remove: async (id) => breakoutRooms.delete(id),
        }
      : overrides.breakoutRooms;

  const studio = new Studio({
    id: 'room-1',
    name: 'Test studio',
    hostName: 'Ada',
    hostPassword: overrides.hostPassword ?? null,
    cohostPassword: overrides.cohostPassword ?? null,
    breakoutRooms: adapter,
    config,
    logger: silent,
    recordingStore: overrides.recordingStore ?? null,
  });
  (studio as any).breakoutRoomStore = breakoutRooms;
  return studio;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the first member becomes host and roles are claimed with a password', () => {
  const studio = makeStudio();
  const host = studio.join({ clientId: 'a', name: 'Ada' });
  const cohost = studio.join({
    clientId: 'b',
    name: 'Bob',
    role: 'cohost',
    password: studio.credentials.cohostPassword,
  });
  const viewer = studio.join({ clientId: 'c', name: 'Cleo' });
  const visitor = studio.join({ clientId: 'd', name: 'Dee', role: 'visitor' });

  assert.equal(host.role, 'host');
  assert.equal(cohost.role, 'cohost');
  assert.equal(viewer.role, 'viewer');
  assert.equal(visitor.role, 'visitor');
  assert.equal(studio.hostId, 'a');
  assert.equal(studio.members.size, 4);
  assert.ok(studio.chat.some((message) => message.text.includes('Ada joined')));
});

test('the host and co-host seats refuse a wrong password', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });

  assert.throws(
    () => studio.join({ clientId: 'b', name: 'Bob', role: 'cohost', password: 'wrong' }),
    /co-host password/,
  );
  assert.throws(
    () => studio.join({ clientId: 'b', name: 'Bob', role: 'host' }),
    /already has a host|host password/,
  );
  assert.throws(
    () => studio.join({ clientId: 'b', name: 'Bob', role: 'host', password: 'wrong' }),
    /already has a host|host password/,
  );
  assert.equal(studio.members.size, 1, 'a refused claim never joins the room');

  // Several people can hold the co-host seat at once.
  const first = studio.join({
    clientId: 'b',
    name: 'Bob',
    role: 'cohost',
    password: studio.credentials.cohostPassword,
  });
  const second = studio.join({
    clientId: 'c',
    name: 'Cleo',
    role: 'cohost',
    password: studio.credentials.cohostPassword,
  });
  assert.equal(first.role, 'cohost');
  assert.equal(second.role, 'cohost');
  assert.equal(studio.members.size, 3);
});

test('an operator-set host password is enforced from the very first join', () => {
  const studio = makeStudio({ hostPassword: 'top-secret', cohostPassword: 'team' });

  assert.throws(() => studio.join({ clientId: 'a', name: 'Ada', role: 'host' }), /host password/);
  const passive = studio.join({ clientId: 'a', name: 'Ada' });
  assert.equal(passive.role, 'viewer', 'without the password the first joiner only watches');

  const host = studio.join({ clientId: 'b', name: 'Bo', role: 'host', password: 'top-secret' });
  assert.equal(host.role, 'host');
  assert.equal(studio.hostPasswordRequired, true);

  const cohost = studio.join({ clientId: 'c', name: 'Cleo', role: 'cohost', password: 'team' });
  assert.equal(cohost.role, 'cohost');
});

test('a viewer can upgrade itself with the co-host password', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.join({ clientId: 'b', name: 'Bob' });

  assert.equal(studio.claimRole('b', { role: 'cohost', password: 'nope' }).ok, false);
  assert.equal(studio.getMember('b').role, 'viewer', 'a refused claim changes nothing');

  const claimed = studio.claimRole('b', { role: 'cohost', password: studio.credentials.cohostPassword });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.member.role, 'cohost');
  assert.equal(studio.claimRole('ghost', { role: 'cohost', password: 'x' }).ok, false);
});

test('re-joining never silently takes a role away', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });

  assert.equal(studio.claimRole('a', { role: 'viewer' }).member.role, 'host', 'the host keeps the seat');
  assert.equal(studio.claimRole('a', {}).member.role, 'host', 'no role requested means no change');
  assert.equal(studio.getMember('a').role, 'host');
});

test('there is only ever one host, and the host can hand the seat over', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.join({ clientId: 'b', name: 'Bob' });

  assert.equal(studio.setMemberRole('b', 'a', 'host').ok, false, 'only the host may change roles');

  const handed = studio.setMemberRole('a', 'b', 'host');
  assert.equal(handed.ok, true);
  assert.equal(studio.hostId, 'b');
  assert.equal(studio.getMember('a').role, 'cohost', 'the outgoing host keeps a co-host seat');
  assert.equal(studio.membersSnapshot().filter((member) => member.role === 'host').length, 1);
});

test('the host grants and revokes a co-host without a password', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.join({ clientId: 'b', name: 'Bob' });

  assert.equal(studio.setMemberRole('a', 'b', 'cohost').ok, true);
  assert.equal(studio.getMember('b').role, 'cohost');
  assert.equal(studio.setMemberRole('a', 'b', 'viewer').ok, true);
  assert.equal(studio.getMember('b').role, 'viewer');
  assert.equal(studio.setMemberRole('a', 'a', 'viewer').ok, false, 'the host cannot demote itself');
  assert.equal(studio.setMemberRole('a', 'ghost', 'cohost').ok, false);
});

test('leaving hands the host seat to a co-host before anyone else', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.join({ clientId: 'b', name: 'Bob' });
  studio.join({ clientId: 'c', name: 'Cleo' });
  studio.setMemberRole('a', 'c', 'cohost');

  studio.leave('a');
  assert.equal(studio.hostId, 'c', 'the co-host takes over from the earliest plain member');
});

test('a participant can publish their own camera, but not drive the program', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.join({ clientId: 'v', name: 'Vic', role: 'viewer' });

  // Their own camera is theirs to publish.
  const added = studio.addSource({ id: 'cam-v', ownerId: 'v', kind: 'camera', label: 'Vic camera' });
  assert.equal(added.ok, true);
  assert.equal(studio.program.sourceId, null, 'a participant camera never takes the program by itself');

  // ... and theirs to ask about.
  const asked = studio.updateSource('cam-v', { request: 'grid' }, { byId: 'v' });
  assert.equal(asked.ok, true);
  assert.equal(asked.source.request, 'grid');
  assert.equal(studio.updateSource('cam-v', { request: 'hologram' }, { byId: 'v' }).ok, false);
  assert.equal(studio.updateSource('cam-v', { request: 'air' }, { byId: 'a' }).ok, false, 'not your source');

  // The host's camera still takes the empty program.
  studio.addSource({ id: 'cam-a', ownerId: 'a', kind: 'camera' });
  assert.equal(studio.program.sourceId, 'cam-a');

  // Applying the request satisfies it.
  const applied = studio.setProgram({ mode: 'grid', gridIds: ['cam-a', 'cam-v'] });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.program.onAir, ['cam-a', 'cam-v']);
  assert.equal(studio.sources.get('cam-v').request, null, 'a satisfied request clears itself');
});

test('a participant feed joins the grid without stealing the single slot', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.addSource({ id: 'cam-1', ownerId: 'a', kind: 'camera' });
  studio.join({ clientId: 'b', name: 'Bob' });

  // The host announces the participant's live video on their behalf.
  const added = studio.addSource({ id: 'participant:b', ownerId: 'a', kind: 'virtual', label: 'Bob' });
  assert.equal(added.ok, true);
  assert.equal(added.source.kind, 'virtual');
  assert.equal(studio.program.sourceId, 'cam-1', 'a participant does not take the single slot');

  const grid = studio.setProgram({ mode: 'grid' });
  assert.deepEqual(grid.program.onAir, ['cam-1', 'participant:b'], 'participants join the grid');

  const onAir = studio.setProgram({ mode: 'single', sourceId: 'participant:b' });
  assert.deepEqual(onAir.program.onAir, ['participant:b'], 'the host can put a participant on air');

  // When the participant leaves, their feed leaves the program too.
  studio.removeSource('participant:b', { byId: 'a' });
  assert.deepEqual(studio.programSnapshot().onAir, ['cam-1'], 'the program falls back to the camera');
  assert.equal(studio.sources.size, 1);
});

test('the host role is handed over when the host leaves', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.join({ clientId: 'b', name: 'Bob' });
  studio.leave('a');
  assert.equal(studio.getMember('b').role, 'host');
  assert.equal(studio.hostId, 'b');
});

test('a single machine can register several cameras and a screen at once', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });

  const first = studio.addSource({ id: 'cam-1', ownerId: 'a', label: 'Front camera', kind: 'camera' });
  studio.addSource({ id: 'cam-2', ownerId: 'a', label: 'Bluetooth action cam', kind: 'camera', deviceId: 'bt-1' });
  studio.addSource({ id: 'cam-3', ownerId: 'a', label: 'Phone camera', kind: 'camera' });
  studio.addSource({ id: 'screen-1', ownerId: 'a', label: 'Screen', kind: 'screen' });

  assert.equal(first.ok, true);
  assert.equal(studio.sources.size, 4);
  assert.deepEqual(studio.getMember('a').sourceIds, ['cam-1', 'cam-2', 'cam-3', 'screen-1']);
  assert.equal(studio.program.sourceId, 'cam-1', 'the first camera goes on air automatically');
});

test('sources are validated and owned', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.join({ clientId: 'b', name: 'Bob' });
  studio.addSource({ id: 'cam-1', ownerId: 'a', kind: 'camera' });

  assert.equal(studio.addSource({ ownerId: 'a', kind: 'hologram' }).ok, false);
  assert.equal(studio.addSource({ id: 'cam-1', ownerId: 'b', kind: 'camera' }).ok, false);
  assert.equal(studio.removeSource('cam-1', { byId: 'b' }).ok, false);
  assert.equal(studio.removeSource('cam-1', { byId: 'a' }).ok, true);
  assert.equal(studio.sources.size, 0);
  assert.equal(studio.program.sourceId, null);
});

test('removing the on-air camera falls back to another camera', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.addSource({ id: 'cam-1', ownerId: 'a', kind: 'camera' });
  studio.addSource({ id: 'cam-2', ownerId: 'a', kind: 'camera' });
  assert.equal(studio.program.sourceId, 'cam-1');
  studio.removeSource('cam-1', { byId: 'a' });
  assert.equal(studio.program.sourceId, 'cam-2');
});

test('program can switch between one camera, the whole grid and a screen', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.addSource({ id: 'cam-1', ownerId: 'a', kind: 'camera' });
  studio.addSource({ id: 'cam-2', ownerId: 'a', kind: 'camera' });
  studio.addSource({ id: 'screen-1', ownerId: 'a', kind: 'screen' });

  assert.deepEqual(studio.setProgram({ mode: 'single', sourceId: 'cam-2' }).program.onAir, ['cam-2']);

  const grid = studio.setProgram({ mode: 'grid', gridIds: ['cam-1', 'cam-2'] });
  assert.equal(grid.ok, true);
  assert.deepEqual(grid.program.onAir, ['cam-1', 'cam-2']);

  const auto = studio.setProgram({ mode: 'grid' });
  assert.deepEqual(auto.program.onAir, ['cam-1', 'cam-2', 'screen-1']);

  const screen = studio.setProgram({ mode: 'screenshare' });
  assert.equal(screen.ok, true);
  assert.deepEqual(screen.program.onAir, ['screen-1']);

  assert.equal(studio.setProgram({ mode: 'hologram' }).ok, false);
  assert.equal(studio.setProgram({ sourceId: 'nope' }).ok, false);
});

test('overlays are validated, broadcast and expire on schedule', async () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  const seen = [];
  studio.on('scene', (scene) => seen.push(scene));

  assert.equal(studio.setScene({ type: 'title' }).ok, false, 'a title needs a headline');

  const applied = studio.setScene({
    type: 'title',
    payload: { headline: 'Welcome', subtitle: 'live from Accra' },
    durationMs: 60,
  });
  assert.equal(applied.ok, true);
  assert.equal(studio.sceneSnapshot().type, 'title');
  assert.equal(studio.sceneSnapshot().payload.headline, 'Welcome');

  await sleep(150);
  assert.equal(studio.scene, null, 'a timed overlay clears itself');
  assert.deepEqual(seen.map((scene) => scene?.type ?? null), ['title', null]);
});

test('the screenshare scene takes the screen to air and restores the camera after', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.addSource({ id: 'cam-1', ownerId: 'a', kind: 'camera' });
  studio.addSource({ id: 'screen-1', ownerId: 'a', kind: 'screen' });

  const applied = studio.setScene({ type: 'screenshare', payload: { caption: 'DEMO' } });
  assert.equal(applied.ok, true);
  assert.equal(studio.program.mode, 'screenshare');
  assert.deepEqual(studio.programSnapshot().onAir, ['screen-1']);

  studio.clearScene();
  assert.equal(studio.scene, null);
  assert.equal(studio.program.mode, 'single');
  assert.equal(studio.program.sourceId, 'cam-1');
});

test('the end of livestream card blocks the program picture', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.setScene({ type: 'ended', payload: { headline: 'See you next time' } });
  const scene = studio.sceneSnapshot();
  assert.equal(scene.type, 'ended');
  assert.equal(scene.blocksProgram, true);
  assert.equal(scene.payload.headline, 'See you next time');
  assert.equal(scene.persistent, true);
});

test('destinations can be added, paused, removed and are capped', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });

  const youtube = studio.addDestination({ platform: 'youtube', streamKey: 'yt-key' });
  assert.equal(youtube.ok, true);
  assert.equal(studio.enabledDestinations().length, 1);
  assert.ok(!JSON.stringify(youtube.destination).includes('yt-key'), 'the stream key is never echoed back');

  assert.equal(studio.addDestination({ platform: 'youtube' }).ok, false, 'a key is required');

  const paused = studio.updateDestination(youtube.destination.id, { enabled: false });
  assert.equal(paused.ok, true);
  assert.equal(studio.enabledDestinations().length, 0);

  assert.equal(studio.removeDestination(youtube.destination.id).ok, true);
  assert.equal(studio.destinations.size, 0);

  const limited = makeStudio({ config: { maxDestinationsPerRoom: 2 } });
  limited.join({ clientId: 'a', name: 'Ada' });
  limited.addDestination({ platform: 'youtube', streamKey: '1' });
  limited.addDestination({ platform: 'facebook', streamKey: '2' });
  const third = limited.addDestination({ platform: 'twitch', streamKey: '3' });
  assert.equal(third.ok, false);
  assert.match(third.error, /at most 2 destinations/);
});

test('going live needs a destination or recording', async () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });

  const empty = await studio.startStream({ byId: 'a' });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /add a destination or enable recording/);

  const recordWithoutStore = await studio.startStream({ record: true, byId: 'a' });
  assert.equal(recordWithoutStore.ok, false);
  assert.match(recordWithoutStore.error, /recording is not available/);

  const unknownPreset = await studio.startStream({ byId: 'a', preset: '8k' });
  assert.equal(unknownPreset.ok, false);
  assert.match(unknownPreset.error, /add a destination or enable recording/);

  studio.addDestination({ platform: 'youtube', streamKey: 'key' });
  const badPreset = await studio.startStream({ byId: 'a', preset: '8k' });
  assert.equal(badPreset.ok, false);
  assert.match(badPreset.error, /unknown video preset/);

  const targets = studio._buildTargets(null);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].kind, 'rtmp');
  assert.equal(targets[0].url, 'rtmp://a.rtmp.youtube.com/live2/key');
  assert.equal(targets[0].onfail, 'ignore');
  assert.ok(typeof targets[0].destinationId === 'string');
  assert.equal(studio.writeProgramChunk('a', Buffer.from('x')), false, 'no relay means no writes');
});

test('startStream wires a relay, marks the publisher and finalises the recording', async () => {
  const store = new RecordingStore({ dir: tmpDir('recordings'), ffmpegBin: null, remuxToMp4: false, logger: silent });
  await store.load();

  const studio = makeStudio({ recordingStore: store });
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.addDestination({ platform: 'youtube', streamKey: 'key' });

  const spawned = [];
  studio.relayFactory = ({ targets, preset }) => {
    const relay: any = new EventEmitter();
    relay.targets = targets;
    relay.preset = preset;
    relay.started = false;
    relay.writes = [];
    relay.start = () => {
      relay.started = true;
      setTimeout(() => relay.emit('status', { status: 'live', bitrateKbps: 4200, bytesIn: 0 }), 5);
    };
    relay.write = (chunk) => {
      relay.writes.push(chunk.length);
      return true;
    };
    relay.whenDrained = () => Promise.resolve();
    relay.stop = async () => {
      setTimeout(() => relay.emit('stopped', { code: 0 }), 5);
      return { code: 0 };
    };
    spawned.push(relay);
    return relay;
  };

  // Pretend ffmpeg wrote the recording so finalisation has something to measure.
  const originalCreate = store.create.bind(store);
  store.create = async (options) => {
    const entry = await originalCreate(options);
    fs.writeFileSync(store.absPath(entry), Buffer.alloc(2048, 7));
    return entry;
  };
  store.probeDurationMs = async () => 4200;

  const result = await studio.startStream({ byId: 'a', record: true, preset: '720p30' });
  assert.equal(result.ok, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].started, true);
  assert.equal(spawned[0].preset, '720p30');
  assert.equal(spawned[0].targets.length, 2, 'one rtmp destination plus the recording file');
  assert.equal(spawned[0].targets[1].kind, 'file');
  assert.equal(spawned[0].targets[1].format, 'mp4', 'the tee muxer only supports mp4 recording slaves');

  await sleep(20);
  assert.equal(studio.stream.status, 'live');
  assert.equal(studio.recording.status, 'recording');

  assert.equal(studio.writeProgramChunk('b', Buffer.from('nope')), false, 'only the publisher may feed the encoder');
  assert.equal(studio.writeProgramChunk('a', Buffer.from('yes')), true);
  assert.deepEqual(spawned[0].writes, [3]);

  const stopping = await studio.stopStream({ byId: 'a' });
  assert.equal(stopping.ok, true);
  assert.equal(studio.stream.status, 'ended');
  assert.equal(studio.recording.status, 'ready');
  assert.equal(studio.recording.durationMs, 4200);
  assert.equal(studio.recording.sizeBytes, 2048);
  assert.ok(studio.recording.file.endsWith('.mp4'));
  assert.equal(studio.relay, null);

  const again = await studio.stopStream({ byId: 'a' });
  assert.equal(again.ok, false, 'stopping twice is rejected');
});

test('adding a destination mid-broadcast rebuilds the relay with the new target', async () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.addDestination({ platform: 'youtube', streamKey: 'one' });

  const relays = [];
  studio.relayFactory = ({ targets, preset }) => {
    const relay: any = new EventEmitter();
    relay.targets = targets;
    relay.preset = preset;
    relay.start = () => relay.emit('status', { status: 'live' });
    relay.write = () => true;
    relay.whenDrained = () => Promise.resolve();
    relay.stop = async () => {
      relay.emit('stopped', { code: 0 });
      return { code: 0 };
    };
    relays.push(relay);
    return relay;
  };

  await studio.startStream({ byId: 'a' });
  assert.equal(relays.length, 1);

  studio.addDestination({ platform: 'facebook', streamKey: 'two' });
  await studio._reconfigureChain;

  assert.equal(relays.length, 2, 'a second relay was spawned');
  assert.equal(relays[1].targets.length, 2, 'the new relay fans out to both platforms');
  assert.equal(studio.stream.status, 'connecting');
  await studio.dispose();
});

test('only the host can rotate the room passwords', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.join({ clientId: 'b', name: 'Bob', role: 'cohost', password: studio.credentials.cohostPassword });

  assert.equal(studio.updateCredentials('b', { cohostPassword: 'newpass' }).ok, false);
  const short = studio.updateCredentials('a', { cohostPassword: 'no' });
  assert.equal(short.ok, false);
  assert.match(short.errors.join('; '), /between 4 and 64/);

  const rotated = studio.updateCredentials('a', { hostPassword: 'hostpass', cohostPassword: 'cohostpass' });
  assert.equal(rotated.ok, true);
  assert.deepEqual(rotated.credentials, { hostPassword: 'hostpass', cohostPassword: 'cohostpass' });
  assert.equal(studio.hostPasswordRequired, true, 'a set host password is enforced from then on');
  assert.equal(
    studio.join({ clientId: 'c', name: 'Cleo', role: 'cohost', password: 'cohostpass' }).role,
    'cohost',
  );
});

test('room passwords never appear in the shared snapshot', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  const snapshot = studio.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes(studio.credentials.hostPassword));
  assert.ok(!serialized.includes(studio.credentials.cohostPassword));
  assert.equal(snapshot.room.hostName, 'Ada');
  assert.equal(snapshot.room.memberCount, 1);
  assert.equal(snapshot.room.cohostCount, 0);
  assert.equal(snapshot.room.viewerCount, 0);
  assert.equal(snapshot.room.requiresHostPassword, false);

  studio.join({ clientId: 'b', name: 'Bob', role: 'visitor' });
  const after = studio.snapshot();
  assert.equal(after.room.memberCount, 2);
  assert.equal(after.room.viewerCount, 1, 'visitors count as watchers');
});

test('a room splits into breakout rooms and spreads the participants', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.join({ clientId: 'b', name: 'Bob' });
  studio.join({ clientId: 'c', name: 'Cleo' });
  studio.join({ clientId: 'd', name: 'Dan' });

  const created = studio.createBreakouts({ count: 3 });
  assert.equal(created.ok, true);
  assert.equal(created.breakouts.rooms.length, 3);
  assert.deepEqual(
    created.breakouts.rooms.map((room) => room.id),
    ['room-1-b1', 'room-1-b2', 'room-1-b3'],
  );
  assert.equal(studio.breakoutRoomStore.size, 3, 'every breakout is a room of its own');
  assert.equal(created.breakouts.rooms.every((room) => room.open === false), true);
  assert.equal(studio.getMember('a').breakoutId, null, 'the host stays in the main room');
  assert.equal(studio.getMember('b').breakoutId, 'room-1-b1');
  assert.equal(studio.getMember('c').breakoutId, 'room-1-b2');
  assert.equal(studio.getMember('d').breakoutId, 'room-1-b3');
  assert.deepEqual(created.breakouts.rooms.map((room) => room.memberCount), [1, 1, 1]);
  assert.equal(studio.createBreakouts({ count: 2 }).ok, false, 'breakouts are created once');

  const snapshot = studio.snapshot();
  assert.equal(snapshot.breakouts.rooms.length, 3);
  assert.equal(snapshot.members.find((member) => member.id === 'b').breakoutId, 'room-1-b1');
});

test('the host moves people between rooms and the assignments stick', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.join({ clientId: 'b', name: 'Bob' });
  studio.join({ clientId: 'c', name: 'Cleo' });
  studio.createBreakouts({ count: 2, labels: ['Design', 'Build'] });

  const moved = studio.assignBreakout('c', 'room-1-b1');
  assert.equal(moved.ok, true);
  assert.equal(moved.member.breakoutId, 'room-1-b1');
  assert.deepEqual(studio.breakouts.get('room-1-b1').memberIds, ['b', 'c']);
  assert.equal(studio.assignBreakout('ghost', 'room-1-b1').ok, false);
  assert.equal(studio.assignBreakout('c', 'room-1-b9').ok, false);

  assert.equal(studio.assignBreakout('c', null).ok, true);
  assert.equal(studio.getMember('c').breakoutId, null);
  assert.deepEqual(studio.breakouts.get('room-1-b1').memberIds, ['b']);

  studio.assignBreakout('b', 'room-1-b1');
  studio.leave('b');
  assert.deepEqual(studio.breakouts.get('room-1-b1').memberIds, [], 'a departing member leaves their room');
});

test('opening and closing breakout rooms keeps the groups for next time', () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.join({ clientId: 'b', name: 'Bob' });
  studio.createBreakouts({ count: 2 });

  const opened = studio.setBreakoutsOpen(true);
  assert.equal(opened.ok, true);
  assert.equal(opened.breakouts.rooms.every((room) => room.open), true);
  assert.equal(opened.breakouts.rooms.every((room) => room.openedAt !== null), true);

  const closed = studio.setBreakoutsOpen(false);
  assert.equal(closed.breakouts.rooms.every((room) => !room.open), true);
  assert.equal(studio.getMember('b').breakoutId, 'room-1-b1', 'the assignment survives the close');
  assert.equal(studio.setBreakoutsOpen(true, { breakoutId: 'nope' }).ok, false);

  const shuffled = studio.autoAssignBreakouts();
  assert.equal(shuffled.ok, true);
  assert.equal(shuffled.breakouts.rooms.reduce((total, room) => total + room.memberCount, 0), 1);
  assert.equal(studio.autoAssignBreakouts({ b: 'room-1-b2' }).ok, true);
  assert.equal(studio.getMember('b').breakoutId, 'room-1-b2');
});

test('breakout rooms are removed with their parent room', async () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.createBreakouts({ count: 2 });

  const cleared = await studio.clearBreakouts();
  assert.equal(cleared.removed.length, 2);
  assert.equal(studio.breakoutRoomStore.size, 0);
  assert.equal(studio.getMember('a').breakoutId, null);
  assert.equal(studio.breakoutsSnapshot().rooms.length, 0);
  assert.equal(studio.createBreakouts({ count: 2 }).ok, true, 'breakouts can be created again');

  await studio.dispose();
  assert.equal(studio.breakoutRoomStore.size, 0, 'disposing the room removes its breakouts');
});

test('a timed breakout session closes itself', async () => {
  const studio = makeStudio();
  studio.join({ clientId: 'a', name: 'Ada' });
  studio.join({ clientId: 'b', name: 'Bob' });
  studio.createBreakouts({ count: 2 });

  studio.setBreakoutsOpen(true, { durationMs: 1000 });
  const live = studio.breakoutsSnapshot();
  assert.equal(live.active, true);
  assert.ok(live.endsAt > Date.now());

  await sleep(1200);
  const done = studio.breakoutsSnapshot();
  assert.equal(done.active, false, 'the timer cleared the session');
  assert.equal(done.rooms.every((room) => !room.open), true);
  assert.equal(studio.getMember('b').breakoutId, 'room-1-b1');
});

test('a breakout room cannot be split again or created without a registry', () => {
  const child = makeStudio({ breakoutRooms: null });
  child.join({ clientId: 'a', name: 'Ada' });
  assert.equal(child.createBreakouts({ count: 2 }).ok, false);
  assert.match(child.createBreakouts({ count: 2 }).error, /not available/);
  assert.equal(child.breakoutsSnapshot().available, false);
});
