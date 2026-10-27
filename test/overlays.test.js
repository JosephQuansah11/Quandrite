import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OVERLAY_DEFINITIONS,
  REQUESTABLE_OVERLAY_TYPES,
  createOverlay,
  formatCountdown,
  overlayDrawModel,
  validateOverlay,
  wrapText,
} from '../shared/overlays.js';

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
  assert.equal(created.value.id, 'scene-1');
  assert.equal(created.value.createdAt, 1_000_000);
  assert.equal(created.value.expiresAt, 1_012_000);

  const persistent = createOverlay({ type: 'break', payload: {} }, { now: 5, idFactory: () => 'scene-2' });
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

test('wrapText and formatCountdown behave predictably', () => {
  assert.deepEqual(wrapText('one two three four', 7), ['one two', 'three', 'four']);
  assert.deepEqual(wrapText('', 10), []);
  assert.equal(formatCountdown(0), '00:00');
  assert.equal(formatCountdown(65_000), '01:05');
  assert.equal(formatCountdown(3_661_000), '1:01:01');
});
