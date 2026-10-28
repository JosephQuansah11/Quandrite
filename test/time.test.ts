/**
 * Nanosecond timing for the media relay.
 *
 * The point of carrying nanoseconds is that milliseconds cannot describe a healthy
 * hop - and the point of the clock exchange is that a stamp from another device is
 * only a number if both sides agree what clock it is on. These tests hold both
 * halves to that promise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RELAY_AUDIO_STALE_NS,
  RELAY_STALE_NS,
  clockOffsetNs,
  formatLagNs,
  isStaleNs,
  monotonicNs,
  nsFromWire,
  nsToMs,
  nsToWire,
  relayLagNs,
} from '../shared/protocol.ts';

test('the monotonic clock is nanoseconds, and never goes backwards', () => {
  const first = monotonicNs();
  assert.equal(typeof first, 'bigint', 'a nanosecond reading is exact, not a float');

  let previous = first;
  for (let index = 0; index < 200; index += 1) {
    const now = monotonicNs();
    assert.ok(now >= previous, 'readings only move forward');
    previous = now;
  }
  assert.ok(previous > first, 'and they do move');

  // The whole reason for nanoseconds: a burst of work far shorter than a
  // millisecond still has to be visible. Reading the clock a few hundred times
  // takes microseconds, which is a number milliseconds cannot express.
  const spread = previous - first;
  assert.ok(spread > 0n, `the readings differ (${spread} ns)`);
  assert.ok(spread < 5_000_000_000n, 'and stay inside the same few seconds');
});

test('a nanosecond stamp survives the wire exactly', () => {
  // A stamp is a 19-digit number of nanoseconds, well past what a double can hold
  // exactly - so it travels as a decimal string.
  const stamp = 1_764_000_000_123_456_789n;
  assert.ok(stamp > BigInt(Number.MAX_SAFE_INTEGER), 'bigger than a safe integer');
  const wire = nsToWire(stamp);
  assert.equal(typeof wire, 'string', 'it goes out as text');
  assert.equal(nsFromWire(wire), stamp, 'and comes back to the very nanosecond');
  // The same number as a double would have been rounded, which is the bug avoided.
  assert.notEqual(BigInt(Math.round(Number(stamp))), stamp, 'a double would have lost it');


test('the clock exchange turns two clocks into one', () => {
  // The client's clock is 7.5 seconds behind the server's, and the two legs of the
  // round trip took 2 ms and 4 ms.
  const offset = 7_500_000_000n;
  const sentLeg = 2_000_000n;
  const backLeg = 4_000_000n;
  const t0 = 1_000_000_000n;
  const t1 = t0 + sentLeg + offset;
  const t2 = t1 + 50_000n;
  const t3 = t0 + sentLeg + backLeg + 50_000n;

  const sample = clockOffsetNs({ t0, t1, t2, t3 });
  assert.ok(sample, 'a symmetric-looking exchange gives a sample');
  assert.equal(sample.roundTripNs, sentLeg + backLeg + 50_000n, 'the round trip is measured');
  // The estimate is off by half the difference between the two legs, because a
  // slow leg looks exactly like a wrong offset. That is the error bound, and the
  // round trip reports it - which is why the best round trip is the sample kept.
  const error = sample.offsetNs - offset;
  assert.ok(error < 0n, 'a slow return leg makes the estimate lag the truth');
  assert.ok(-error <= sample.roundTripNs / 2n, 'and the error stays inside half the round trip');

  // A reply with the server's clock missing is not usable at all.
  assert.equal(clockOffsetNs({ t0, t1: null, t2, t3 }), null, 'an unanswered exchange gives nothing');
  assert.equal(clockOffsetNs({ t0, t1, t2, t3: t0 - 1n }), null, 'and neither does a clock that went backwards');
  // An instant reply is not an error: the round trip is simply zero.
  assert.equal(clockOffsetNs({ t0, t1: t0, t2: t0, t3: t0 })?.roundTripNs, 0n, 'a same-instant exchange is just fast');
});

test('lag is broken down by hop, and unknown hops stay unknown', () => {
  const captured = 5_000_000_000n;
  const arrived = captured + 3_000_000n; // 3 ms to the server
  const now = arrived + 2_500_000n; // 2.5 ms back out again
  const lag = relayLagNs({ tns: nsToWire(captured), srv: nsToWire(arrived) }, now);

  assert.equal(lag.totalNs, 5_500_000n, 'the room sees 5.5 ms of lag');
  assert.equal(lag.inboundNs, 3_000_000n, 'of which 3 ms was getting to the server');
  assert.equal(lag.outboundNs, 2_500_000n, 'and 2.5 ms was coming back');
  assert.equal(lag.inboundNs + lag.outboundNs, lag.totalNs, 'the two hops add up to the total');

  // A sender that predates the nanosecond stamps: nothing is claimed about it.
  const unstamped = relayLagNs({ t: Date.now() }, now);
  assert.equal(unstamped.totalNs, null, 'no stamp, no claim about the total');
  assert.equal(unstamped.inboundNs, null, 'and none about the hops');
  assert.equal(isStaleNs(unstamped.capturedNs, now, RELAY_STALE_NS), false, 'an unstamped frame is never dropped for age');

  // The server's stamp can be missing on its own (an older server), and the total
  // is still worth having.
  const noServerStamp = relayLagNs({ tns: nsToWire(captured) }, now);
  assert.equal(noServerStamp.totalNs, 5_500_000n, 'the total is still known');
  assert.equal(noServerStamp.inboundNs, null, 'but the split is not');
});

test('staleness is a nanosecond comparison, not a rounded one', () => {
  const now = 1_000_000_000_000n;
  assert.equal(isStaleNs(now - 1_499_999_999n, now, RELAY_STALE_NS), false, 'just inside the limit');
  assert.equal(isStaleNs(now - 1_500_000_001n, now, RELAY_STALE_NS), true, 'just outside it');
  // Voice is stricter than pictures, and both are stricter than a second.
  assert.ok(RELAY_AUDIO_STALE_NS < RELAY_STALE_NS, 'voice tolerates less delay than pictures');
  assert.equal(isStaleNs(now - 700_000_000n, now, RELAY_AUDIO_STALE_NS), true, '700 ms of voice is too old');
  assert.equal(isStaleNs(now - 700_000_000n, now, RELAY_STALE_NS), false, 'but fine for a picture');
  assert.equal(isStaleNs(null, now, RELAY_STALE_NS), false, 'no stamp means no age');
});

test('a lag is written in the unit that reads best', () => {
  assert.equal(formatLagNs(412n), '412 ns', 'nanoseconds while a hop is that short');
  assert.equal(formatLagNs(1_500n), '1.50 \u00b5s', 'microseconds under a millisecond');
  assert.equal(formatLagNs(38_420_000n), '38.42 ms', 'milliseconds beyond that');
  assert.equal(formatLagNs(2_500_000_000n), '2.50 s', 'seconds when something is badly wrong');
  assert.equal(formatLagNs(-2_500n), '-2.50 \u00b5s', 'and a negative reading says so');
  assert.equal(formatLagNs(null), '', 'nothing to say, nothing shown');
});

test('nanoseconds convert to milliseconds for timers and display', () => {
  assert.equal(nsToMs(38_420_000n), 38.42, 'milliseconds as a number');
  assert.equal(nsToMs(0n), 0, 'zero is zero');
  assert.equal(nsToMs(null), 0, 'and nothing is zero');
});

  // Older clients sent milliseconds as a number, and those still read.
  assert.equal(nsFromWire(1_764_000_000_123), 1_764_000_000_123n, 'numbers are tolerated');
  assert.equal(nsFromWire('nonsense'), null, 'junk is refused');
  assert.equal(nsFromWire(undefined), null, 'and so is a missing stamp');
  assert.equal(nsFromWire(Number.NaN), null, 'or a NaN');
});
