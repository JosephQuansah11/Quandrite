/**
 * Choosing the picture quality.
 *
 * The point of the ladder is the trade: a sharp 1080p that stutters is worse than a
 * steady 360p, and a link that has just been struggling must not be handed a big
 * frame again the moment it takes one breath. These tests hold both halves to that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RELAY_LADDER, QualityLadder, ladderIndexForNetwork } from '../public/js/quality.ts';

test('the ladder runs from 1080p down, and each rung costs less than the one above', () => {
  assert.equal(RELAY_LADDER[0].name, '1080p', 'the best rung is 1080p');
  assert.equal(RELAY_LADDER[0].width, 1920);
  assert.equal(RELAY_LADDER[0].height, 1080);
  assert.equal(RELAY_LADDER.at(-1).name, '240p', 'and the worst is still watchable');
  for (let index = 1; index < RELAY_LADDER.length; index += 1) {
    const above = RELAY_LADDER[index - 1];
    const rung = RELAY_LADDER[index];
    assert.ok(rung.width < above.width, `${rung.name} is narrower than ${above.name}`);
    assert.ok(rung.kbps < above.kbps, `${rung.name} costs less than ${above.name}`);
    assert.ok(rung.fps >= above.fps, `${rung.name} may run at least as fast, being smaller`);
  }
});

test('the browser\'s own report chooses the opening rung, and is only a hint', () => {
  assert.equal(ladderIndexForNetwork({ downlink: 20, effectiveType: '4g' }), 0, 'a fast link opens at 1080p');
  assert.equal(ladderIndexForNetwork({ downlink: 2, effectiveType: '4g' }), 1, 'a couple of megabits opens at 720p');
  assert.equal(ladderIndexForNetwork({ downlink: 0.5, effectiveType: '3g' }), 3, 'half a megabit opens at 360p');
  assert.equal(ladderIndexForNetwork({ effectiveType: '2g' }), RELAY_LADDER.length - 1, '2g opens at the bottom');
  assert.equal(ladderIndexForNetwork({ saveData: true, downlink: 50 }), RELAY_LADDER.length - 1, 'save-data means the smallest rung, whatever the speed');
  assert.equal(ladderIndexForNetwork({ effectiveType: '4g' }), 1, 'with no numbers, a modern label is taken with care');
  assert.equal(ladderIndexForNetwork(null), 1, 'and a browser that says nothing is not assumed to be fast');
});

test('a struggling link steps down at once, and a comfortable one climbs slowly', () => {
  const ladder = new QualityLadder({ startIndex: 0, upAfterMs: 5000 });
  assert.equal(ladder.name, '1080p', 'it starts where it was told');

  // One bad pass is enough to step down: a stutter is felt immediately.
  assert.equal(ladder.note({ struggling: true, now: 1000 }).name, '720p');
  assert.equal(ladder.note({ struggling: true, now: 1100 }).name, '480p');
  assert.equal(ladder.note({ struggling: true, now: 1200 }).name, '360p');
  assert.equal(ladder.note({ struggling: true, now: 1300 }).name, '240p');
  assert.equal(ladder.note({ struggling: true, now: 1400 }).name, '240p', 'and it stops at the bottom');
  assert.equal(ladder.index, RELAY_LADDER.length - 1);

  // Climbing takes a sustained comfortable window, one rung at a time.
  assert.equal(ladder.note({ struggling: false, now: 2000 }).name, '240p', 'the first good pass only starts the clock');
  assert.equal(ladder.note({ struggling: false, now: 6000 }).name, '240p', 'still short of the window');
  assert.equal(ladder.note({ struggling: false, now: 7100 }).name, '360p', 'then one rung up');
  assert.equal(ladder.note({ struggling: false, now: 12000 }).name, '360p', 'and the clock starts again');
  assert.equal(ladder.note({ struggling: false, now: 13000 }).name, '480p');
});

test('one bad pass resets the climb, so a marginal link cannot oscillate', () => {
  const ladder = new QualityLadder({ startIndex: 2, upAfterMs: 5000 });
  ladder.note({ struggling: false, now: 0 });
  ladder.note({ struggling: false, now: 6000 });
  assert.equal(ladder.index, 1, 'it climbed after the comfortable window');
  // A single stutter on the way up drops it back and forgets the good run.
  ladder.note({ struggling: true, now: 6100 });
  assert.equal(ladder.index, 2, 'back down a rung');
  ladder.note({ struggling: false, now: 6200 });
  assert.equal(ladder.index, 2, 'and the clock starts from scratch');
  ladder.note({ struggling: false, now: 8000 });
  assert.equal(ladder.index, 2, 'so it does not climb again immediately');
  ladder.note({ struggling: false, now: 11500 });
  assert.equal(ladder.index, 1, 'only after another full window');
});

test('the ladder can be reset from a fresh network report', () => {
  const ladder = new QualityLadder({ startIndex: 4 });
  assert.equal(ladder.atCeiling, false);
  assert.equal(ladder.reset(ladderIndexForNetwork({ downlink: 20 })).name, '1080p', 'a better network starts higher');
  assert.equal(ladder.atCeiling, true, 'and 1080p is the ceiling');
  assert.equal(ladder.needsKbps(), RELAY_LADDER[0].kbps, 'the rung knows what it costs');
});
