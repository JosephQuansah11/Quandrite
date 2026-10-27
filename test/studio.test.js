import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { Studio } from '../server/studio.js';
import { RecordingStore } from '../server/recordings.js';
import { loadConfig } from '../server/config.js';

const silent = { info() {}, warn() {}, error() {} };

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `quandrite-${name}-`));
}

function makeStudio(overrides = {}) {
  const config = loadConfig({ recordingsDir: tmpDir('studio'), ...(overrides.config || {}) });
  return new Studio({
    id: 'room-1',
    name: 'Test studio',
    hostName: 'Ada',
    config,
    logger: silent,
    recordingStore: overrides.recordingStore ?? null,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the first member becomes host and later members keep their requested role', () => {
  const studio = makeStudio();
  const host = studio.join({ clientId: 'a', name: 'Ada' });
  const cohost = studio.join({ clientId: 'b', name: 'Bob', role: 'cohost' });
  const viewer = studio.join({ clientId: 'c', name: 'Cleo' });

  assert.equal(host.role, 'host');
  assert.equal(cohost.role, 'cohost');
  assert.equal(viewer.role, 'viewer');
  assert.equal(studio.hostId, 'a');
  assert.equal(studio.members.size, 3);
  assert.ok(studio.chat.some((message) => message.text.includes('Ada joined')));
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
    const relay = new EventEmitter();
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
    const relay = new EventEmitter();
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
