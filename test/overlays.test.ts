import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OVERLAY_DEFINITIONS,
  REQUESTABLE_OVERLAY_TYPES,
  createOverlay,
  formatCountdown,
  overlayDrawModel,
  remainingCountdownMs,
  validateOverlay,
  wrapText,
} from '../shared/overlays.ts';

test('every requested overlay type is supported', () => {
  assert.deepEqual(REQUESTABLE_OVERLAY_TYPES, [
    'title',
    'announcement',
    'screenshare',
    'song',
    'break',
    'ended',
  ]);
  for (const type of REQUESTABLE_OVERLAY_TYPES) {
    assert.ok(OVERLAY_DEFINITIONS[type].label, `${type} has a label`);
  }
});

test('unknown overlay types are rejected', () => {
  const result = validateOverlay({ type: 'fireworks' });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /unknown overlay type/);
});

test('title overlays require a headline and default to 8 seconds', () => {
  const missing = validateOverlay({ type: 'title', payload: { subtitle: 'nope' } });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(','), /headline is required/);

  const ok = validateOverlay({ type: 'title', payload: { headline: '  Live from Accra  ' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.payload.headline, 'Live from Accra');
  assert.equal(ok.value.durationMs, 8000);
  assert.equal(ok.value.persistent, false);
  assert.equal(ok.value.blocksProgram, false);
});

test('a requested duration of zero makes an overlay persistent', () => {
  const result = validateOverlay({
    type: 'title',
    payload: { headline: 'Always on' },
    durationMs: 0,
  });
  assert.equal(result.value.durationMs, 8000, 'zero falls back to the default duration');

  const persistent = validateOverlay({
    type: 'title',
    payload: { headline: 'Always on' },
    persistent: true,
  });
  assert.equal(persistent.value.durationMs, 0);
  assert.equal(persistent.value.persistent, true);
});

test('break and ended cards block the program picture', () => {
  const brk = validateOverlay({ type: 'break', payload: { message: 'Back in 5', countdownMs: 300000 } });
  assert.equal(brk.ok, true);
  assert.equal(brk.value.blocksProgram, true);
  assert.equal(brk.value.payload.countdownMs, 300000);

  const ended = validateOverlay({ type: 'ended', payload: {} });
  assert.equal(ended.ok, true);
  assert.equal(ended.value.blocksProgram, true);
  assert.equal(ended.value.payload.headline, 'Thanks for watching');
  assert.equal(ended.value.payload.showReplay, true);
});

test('song overlays validate artwork urls', () => {
  const bad = validateOverlay({ type: 'song', payload: { title: 'Track', artworkUrl: 'javascript:alert(1)' } });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(','), /artworkUrl/);

  const good = validateOverlay({
    type: 'song',
    payload: { title: 'Track', artist: 'Band', artworkUrl: 'https://example.com/a.png' },
  });
  assert.equal(good.ok, true);
  assert.equal(good.value.payload.artist, 'Band');
});

test('createOverlay stamps ids and expiry times', () => {
  const created = createOverlay(
    { type: 'announcement', payload: { message: 'Q&A in five minutes' }, durationMs: 12000 },
    { now: 1_000_000, idFactory: () => 'scene-1' },
  );
  assert.equal(created.ok, true);
  const value: any = created.value;
  assert.equal(value.id, 'scene-1');
  assert.equal(value.createdAt, 1_000_000);
  assert.equal(value.expiresAt, 1_012_000);

  const persistent: any = createOverlay({ type: 'break', payload: {} }, { now: 5, idFactory: () => 'scene-2' });
  assert.equal(persistent.value.expiresAt, null);
});

test('overlayDrawModel produces drawable ops at any resolution', () => {
  const scene = {
    type: 'title',
    payload: { headline: 'Hello world', subtitle: 'and welcome', position: 'lower-third', accent: '#38bdf8' },
  };
  const model = overlayDrawModel(scene, { width: 1920, height: 1080 });
  assert.equal(model.type, 'title');
  assert.equal(model.blocksProgram, false);
  assert.ok(model.ops.length >= 3);
  const texts = model.ops.filter((op) => op.kind === 'text').map((op) => op.text);
  assert.deepEqual(texts, ['Hello world', 'and welcome']);
  for (const op of model.ops) assert.ok(op.x >= 0 && op.y >= 0);

  const small = overlayDrawModel(scene, { width: 640, height: 360 });
  const bigText = model.ops.find((op) => op.kind === 'text');
  const smallText = small.ops.find((op) => op.kind === 'text');
  assert.ok(smallText.size < bigText.size, 'text scales with the canvas height');
});

test('overlayDrawModel handles each scene type and the idle state', () => {
  assert.deepEqual(overlayDrawModel(null, { width: 100, height: 100 }), {
    type: 'idle',
    blocksProgram: false,
    ops: [],
  });

  const cases = [
    ['announcement', { message: 'Hello', priority: 'high' }],
    ['screenshare', { caption: 'SCREEN SHARE' }],
    ['song', { title: 'Track', artist: 'Band', lyrics: 'line one\nline two' }],
    ['break', { message: 'Back soon', countdownMs: 65000 }],
    ['ended', { headline: 'Bye', message: 'Thanks', showReplay: true }],
  ];

  for (const [type, payload] of cases) {
    const model = overlayDrawModel({ type, payload }, { width: 1280, height: 720 });
    assert.equal(model.type, type);
    assert.ok(model.ops.length > 0, `${type} draws something`);
  }

  const brk = overlayDrawModel({ type: 'break', payload: { countdownMs: 65000 } }, { width: 1280, height: 720 });
  assert.equal(brk.blocksProgram, true);
  assert.ok(
    brk.ops.some((op) => op.kind === 'text' && op.text === '01:05'),
    'break shows a formatted countdown',
  );

  const song = overlayDrawModel(
    { type: 'song', payload: { title: 'Track', artworkUrl: 'https://example.com/a.png' } },
    { width: 1280, height: 720 },
  );
  assert.ok(song.ops.some((op) => op.kind === 'image'), 'song draws artwork when provided');
});

test('an announcement can carry a countdown that really counts down', () => {
  const requested = validateOverlay({
    type: 'announcement',
    payload: { message: 'Doors open soon', countdownMs: 300000 },
  });
  assert.equal(requested.ok, true);
  assert.equal(requested.value.payload.countdownMs, 300000);

  const plain = validateOverlay({ type: 'announcement', payload: { message: 'Hello' } });
  assert.equal(plain.value.payload.countdownMs, 0, 'no countdown unless one is asked for');

  const negative = validateOverlay({
    type: 'announcement',
    payload: { message: 'Hello', countdownMs: -5 },
  });
  assert.equal(negative.value.payload.countdownMs, 0);

  const scene = {
    type: 'announcement',
    payload: { message: 'Doors open', countdownMs: 300000 },
    createdAt: 1_000_000,
  };
  const atStart = overlayDrawModel(scene, { width: 1280, height: 720, now: 1_000_000 });
  assert.ok(
    atStart.ops.some((op) => op.kind === 'text' && op.text === '05:00'),
    'the banner shows the countdown',
  );

  const oneMinuteLater = overlayDrawModel(scene, { width: 1280, height: 720, now: 1_060_000 });
  assert.ok(
    oneMinuteLater.ops.some((op) => op.kind === 'text' && op.text === '04:00'),
    'and it ticks down on the picture',
  );

  const finished = overlayDrawModel(scene, { width: 1280, height: 720, now: 1_600_000 });
  assert.ok(
    !finished.ops.some((op) => op.kind === 'text' && op.text === '00:00'),
    'a finished countdown is not drawn at all',
  );
});

test('remainingCountdownMs subtracts the time already elapsed', () => {
  assert.equal(remainingCountdownMs({ payload: { countdownMs: 0 } }, 5), 0);
  assert.equal(remainingCountdownMs({ payload: { countdownMs: 65000 } }, 5), 65000, 'no timestamp: as requested');
  assert.equal(remainingCountdownMs({ payload: { countdownMs: 65000 }, createdAt: 1000 }, 1000), 65000);
  assert.equal(remainingCountdownMs({ payload: { countdownMs: 65000 }, createdAt: 1000 }, 5000), 61000);
  assert.equal(remainingCountdownMs({ payload: { countdownMs: 65000 }, createdAt: 1000 }, 999999), 0, 'never negative');
});

test('a countdown ends the scene, so the program resumes by itself', () => {
  // A break with a countdown is a promise to come back: the countdown is the
  // lifetime, and the card leaves the air when it reaches zero.
  const brk = validateOverlay({ type: 'break', payload: { message: 'Back soon', countdownMs: 120000 } });
  assert.equal(brk.ok, true);
  assert.equal(brk.value.durationMs, 120000);
  assert.equal(brk.value.persistent, false, 'a countdown scene is not persistent');

  const created: any = createOverlay(
    { type: 'announcement', payload: { message: 'Doors open soon', countdownMs: 300000 }, durationMs: 12000 },
    { now: 1_000_000, idFactory: () => 'scene-cd' },
  );
  assert.equal(created.value.durationMs, 300000, 'the longer of the countdown and the duration wins');
  assert.equal(created.value.expiresAt, 1_300_000, 'and that is when it clears itself');

  // Without a countdown nothing changes: a persistent card stays until cleared.
  const persistent = validateOverlay({ type: 'break', payload: { message: 'Back soon' }, persistent: true });
  assert.equal(persistent.value.persistent, true);
  assert.equal(persistent.value.durationMs, 0);
});

test('wrapText and formatCountdown behave predictably', () => {
  assert.deepEqual(wrapText('one two three four', 7), ['one two', 'three', 'four']);
  assert.deepEqual(wrapText('', 10), []);
  assert.equal(formatCountdown(0), '00:00');
  assert.equal(formatCountdown(65_000), '01:05');
  assert.equal(formatCountdown(3_661_000), '1:01:01');
});
