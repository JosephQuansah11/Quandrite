import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeGridLayout,
  computeProgramLayout,
  gridColumnsFor,
  resolveProgramSources,
} from '../shared/layout.ts';

test('gridColumnsFor picks sensible column counts', () => {
  assert.equal(gridColumnsFor(1), 1);
  assert.equal(gridColumnsFor(2), 2);
  assert.equal(gridColumnsFor(3), 2);
  assert.equal(gridColumnsFor(4), 2);
  assert.equal(gridColumnsFor(5), 3);
  assert.equal(gridColumnsFor(6), 3);
  assert.equal(gridColumnsFor(9), 3);
  assert.equal(gridColumnsFor(16), 4);
});

test('computeGridLayout tiles the frame without overlapping', () => {
  const tiles = computeGridLayout(4, { width: 1000, height: 1000, gap: 10, padding: 10 });
  assert.equal(tiles.length, 4);
  const [first, second, third] = tiles;
  assert.equal(first.x, 10);
  assert.equal(first.y, 10);
  assert.equal(second.x, first.x + first.w + 10);
  assert.equal(third.y, first.y + first.h + 10);
  for (const tile of tiles) {
    assert.ok(tile.x + tile.w <= 1000, 'tile stays inside the frame');
    assert.ok(tile.y + tile.h <= 1000, 'tile stays inside the frame');
  }

  assert.deepEqual(computeGridLayout(0), []);
});

test('computeProgramLayout switches between single, grid and screenshare', () => {
  assert.deepEqual(computeProgramLayout({ mode: 'single', sourceCount: 1, width: 1920, height: 1080 }), [
    { index: 0, x: 0, y: 0, w: 1920, h: 1080 },
  ]);
  assert.deepEqual(computeProgramLayout({ mode: 'screenshare', sourceCount: 1, width: 1280, height: 720 }), [
    { index: 0, x: 0, y: 0, w: 1280, h: 720 },
  ]);
  assert.equal(computeProgramLayout({ mode: 'grid', sourceCount: 4, width: 1280, height: 720 }).length, 4);
  assert.deepEqual(computeProgramLayout({ mode: 'grid', sourceCount: 0 }), []);
});

const SOURCES = [
  { id: 'cam-1', kind: 'camera', label: 'Camera 1' },
  { id: 'cam-2', kind: 'camera', label: 'Camera 2' },
  { id: 'screen-1', kind: 'screen', label: 'Screen' },
  { id: 'mic-1', kind: 'audio', label: 'Microphone' },
];

test('resolveProgramSources honours the selected single camera', () => {
  const onAir = resolveProgramSources({
    sources: SOURCES,
    program: { mode: 'single', sourceId: 'cam-2' },
  });
  assert.deepEqual(onAir.map((source) => source.id), ['cam-2']);
});

test('resolveProgramSources falls back to the first camera', () => {
  const onAir = resolveProgramSources({ sources: SOURCES, program: { mode: 'single', sourceId: null } });
  assert.deepEqual(onAir.map((source) => source.id), ['cam-1']);
});

test('resolveProgramSources shows every grid member together', () => {
  const onAir = resolveProgramSources({
    sources: SOURCES,
    program: { mode: 'grid', gridIds: ['cam-2', 'cam-1'] },
  });
  assert.deepEqual(onAir.map((source) => source.id), ['cam-2', 'cam-1']);
});

test('grid mode without an explicit list uses every camera and screen', () => {
  const onAir = resolveProgramSources({ sources: SOURCES, program: { mode: 'grid', gridIds: [] } });
  assert.deepEqual(onAir.map((source) => source.id), ['cam-1', 'cam-2', 'screen-1']);
});

const PARTICIPANTS = [
  { id: 'cam-1', kind: 'camera', label: 'Camera 1' },
  { id: 'participant:b', kind: 'virtual', label: 'Bob' },
  { id: 'mic-1', kind: 'audio', label: 'Microphone' },
];

test('participants who joined the call are part of the grid', () => {
  const grid = resolveProgramSources({ sources: PARTICIPANTS, program: { mode: 'grid', gridIds: [] } });
  assert.deepEqual(grid.map((source) => source.id), ['cam-1', 'participant:b']);

  const chosen = resolveProgramSources({
    sources: PARTICIPANTS,
    program: { mode: 'grid', gridIds: ['participant:b', 'cam-1'] },
  });
  assert.deepEqual(chosen.map((source) => source.id), ['participant:b', 'cam-1']);

  const single = resolveProgramSources({
    sources: PARTICIPANTS,
    program: { mode: 'single', sourceId: 'participant:b' },
  });
  assert.deepEqual(single.map((source) => source.id), ['participant:b']);

  const fallback = resolveProgramSources({ sources: PARTICIPANTS, program: { mode: 'single' } });
  assert.deepEqual(fallback.map((source) => source.id), ['cam-1'], 'a camera still wins the single slot');
});

test('screenshare mode prefers the requested screen and ignores cameras', () => {
  const onAir = resolveProgramSources({
    sources: SOURCES,
    program: { mode: 'screenshare', sourceId: 'screen-1' },
  });
  assert.deepEqual(onAir.map((source) => source.id), ['screen-1']);

  const auto = resolveProgramSources({ sources: SOURCES, program: { mode: 'screenshare' } });
  assert.deepEqual(auto.map((source) => source.id), ['screen-1']);

  const none = resolveProgramSources({ sources: [SOURCES[0]], program: { mode: 'screenshare' } });
  assert.deepEqual(none, []);
});
