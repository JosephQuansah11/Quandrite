/**
 * The feedback detector.
 *
 * This is the part that decides whether a room howls, so it is tested directly rather
 * than through a browser: `RoomAudio` needs no audio context to be asked what it thinks
 * of a set of levels, and the numbers below are the ones measured from a real loop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RoomAudio } from '../public/js/room-audio.ts';

/** One level per 50 ms pass, straight off a live broad howl as it climbed. */
const CLIMB = [0.0127, 0.0463, 0.0681, 0.1024, 0.1368, 0.1547, 0.1678];
/** ...and a voice: loud, but its swell turns over instead of climbing. */
const VOICE = [0.05, 0.09, 0.13, 0.14, 0.13, 0.11, 0.08];
/** A room getting louder over seconds, which is not feedback. */
const SLOW_SWELL = [0.1, 0.104, 0.108, 0.112, 0.116, 0.12, 0.124];
/** Loud and steady: somebody talking at a constant level. */
const STEADY = [0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15];

const judge = (levels, { level = levels[levels.length - 1], narrowShare = 0.5 } = {}) =>
  new RoomAudio()._judge({ level, narrowShare, history: [...levels] });

test('a howl is caught by its climb, not only by being one loud note', () => {
  // The case that a narrow-only detector misses: a broad, resonant howl. It is not one
  // clean note at all - its spectrum is wide - but it climbs and climbs.
  const broad = judge(CLIMB, { narrowShare: 0.52 });
  assert.equal(broad.rising, true, 'an unbroken climb is a howl');
  assert.equal(broad.narrow, false, 'and it is not narrow: this is not why it was caught');
  assert.equal(broad.howling, true);

  // The classic howl: one loud note. Still caught, by the other test.
  const narrow = judge([0.3, 0.32, 0.33, 0.34, 0.35, 0.36, 0.37], { narrowShare: 0.02 });
  assert.equal(narrow.narrow, true);
  assert.equal(narrow.howling, true);
});

test('a voice is not a howl, however loud it is', () => {
  assert.equal(judge(STEADY).howling, false, 'loud and steady is a voice');
  assert.equal(judge(VOICE).howling, false, 'a swell that turns over is a voice');
  assert.equal(judge(SLOW_SWELL).howling, false, 'getting louder over seconds is not a loop');
  // A loud voice with a wide spectrum, mid-word: neither test should fire.
  assert.equal(judge([0.02, 0.06, 0.11, 0.14, 0.12, 0.09, 0.05], { narrowShare: 0.4 }).howling, false);
});

test('the climb has to be real and unbroken', () => {
  const mixer = new RoomAudio();
  assert.equal(mixer._rising({ history: CLIMB.slice(-6) }), true, 'six passes of climbing');
  assert.equal(mixer._rising({ history: CLIMB.slice(-5) }), false, 'five is not enough to judge');
  // One dip in the middle is a voice, or a measurement, not a loop.
  const dipped = [...CLIMB];
  dipped[3] = dipped[2] * 0.5;
  assert.equal(mixer._rising({ history: dipped.slice(-6) }), false, 'a dip breaks the climb');
  // Climbing, but by so little that it is a room warming up rather than a loop.
  assert.equal(mixer._rising({ history: SLOW_SWELL.slice(-6) }), false, 'a crawl is not a climb');
  // Silence is not evidence, and it is not a floor to climb from either.
  assert.equal(mixer._rising({ history: [0, 0, 0, 0, 0, 0] }), false, 'silence is not a howl');
});

test('the detector keeps only the passes it needs, and ducks hard', () => {
  const mixer = new RoomAudio();
  const entry: any = { level: 0.1 };
  for (let pass = 0; pass < 20; pass += 1) {
    entry.level = 0.1 + pass / 100;
    mixer._record(entry);
  }
  assert.ok(entry.history.length <= mixer.feedbackRisePasses + 2, 'the history does not grow forever');
  assert.equal(mixer.feedbackGain, 0.02, 'the duck is deep enough to break a loop');
  assert.ok(mixer.feedbackAttackS <= 0.02, 'and fast enough to catch it on the way up');
  assert.ok(mixer.feedbackReleaseS > mixer.feedbackAttackS, 'while the release is gentle');
  assert.equal(mixer.intervalMs, 50, 'the meters are read often enough to see a howl rising');
  assert.ok(mixer.feedbackRiseLevel < mixer.feedbackLevel, 'a howl is judged while it is still quiet');
});

test('a muted voice cannot howl the room, because it is not played', () => {
  const mixer = new RoomAudio();
  const entry: any = { id: 'peer', monitor: true, muted: true, level: 0.05, narrowShare: 0.5, history: [], howlStreak: 0 };
  mixer.entries.set('peer', entry);
  mixer._peakShape = () => ({ peakShare: 0.5, narrowShare: 0.02 });
  for (const level of CLIMB) {
    entry.level = level;
    mixer._watchFeedback(1000);
  }
  assert.equal(mixer.feedbackActive, false, 'nobody is ducked for a voice nobody can hear');
});

test('both signatures are reported, so a room can be told what happened', () => {
  const mixer = new RoomAudio();
  const seen = [];
  mixer.addEventListener('feedback', (event: any) => seen.push(event.detail));
  // Drive the detector by hand: two passes of a broad climb, then silence.
  mixer._howling = false;
  mixer._feedbackUntil = 0;
  const entry = { id: 'peer', monitor: true, level: 0.05, narrowShare: 0.5, history: [], howlStreak: 0 };
  mixer.entries.set('peer', entry);
  const peakShape = mixer._peakShape.bind(mixer);
  mixer._peakShape = () => ({ peakShare: 0.5, narrowShare: 0.5 });
  for (const level of CLIMB) {
    entry.level = level;
    // `_watchFeedback` records the pass itself - recording it here as well would put
    // every level in twice and make the climb look flat.
    mixer._watchFeedback(1000);
  }
  mixer._peakShape = peakShape;
  assert.equal(mixer.feedbackActive, true, 'the room is held down');
  assert.equal(mixer._feedbackReason, 'rising', 'and it knows it was the climb that gave it away');
  assert.deepEqual(
    seen[0],
    { active: true, peerId: 'peer', reason: 'rising' },
    'the room is told, so it can say what happened',
  );
  assert.deepEqual(
    seen[seen.length - 1],
    { active: true, peerId: 'peer', reason: 'rising' },
    'and told once, not once per pass',
  );
});
