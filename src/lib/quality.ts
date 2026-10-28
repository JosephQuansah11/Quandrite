/**
 * How good the picture can be right now.
 *
 * Two things are true at once: people want a sharp 1080p picture, and a link that
 * cannot carry it must not be given it - a 1080p that stutters is worse than a
 * steady 360p. So quality is a *ladder*, and the link picks the rung.
 *
 * The steps down are quick (a stutter is felt immediately) and the steps up are
 * slow and only after the link has been comfortable for a while, because climbing
 * too eagerly is what makes a marginal connection oscillate between sharp-but-broken
 * and soft-but-smooth. The hysteresis is the whole point of this module.
 *
 * `kbps` is what a rung honestly costs as JPEG over the socket - measured, not
 * guessed - so a rung is only chosen when the link has shown it can carry it.
 */

/** Best first: the rungs the relay may send at. */
export const RELAY_LADDER = [
  { name: '1080p', width: 1920, height: 1080, fps: 3, quality: 0.68, kbps: 3200 },
  { name: '720p', width: 1280, height: 720, fps: 4, quality: 0.64, kbps: 1900 },
  { name: '480p', width: 854, height: 480, fps: 5, quality: 0.6, kbps: 900 },
  { name: '360p', width: 640, height: 360, fps: 6, quality: 0.56, kbps: 480 },
  { name: '240p', width: 426, height: 240, fps: 6, quality: 0.5, kbps: 240 },
];

/**
 * Where to start, from what the browser will say about the connection.
 *
 * The Network Information API is a hint, not a measurement - `downlink` is in
 * megabits per second and coarse - so it only chooses the opening rung; the
 * ladder's own measurements take over from there. `saveData` means the user has
 * asked for less, which is honoured.
 */
export function ladderIndexForNetwork(connection: any, ladder = RELAY_LADDER) {
  if (!connection) return ladder.length > 1 ? 1 : 0;
  if (connection.saveData) return ladder.length - 1;
  const downlinkMbps = Number(connection.downlink);
  if (!Number.isFinite(downlinkMbps) || downlinkMbps <= 0) {
    // No numbers to go on: judge by the label the browser gives the link.
    const type = String(connection.effectiveType || '');
    if (type === 'slow-2g' || type === '2g') return ladder.length - 1;
    if (type === '3g') return Math.min(ladder.length - 1, 2);
    return ladder.length > 1 ? 1 : 0;
  }
  const kbps = downlinkMbps * 1000;
  for (let index = 0; index < ladder.length; index += 1) {
    if (kbps >= ladder[index].kbps) return index;
  }
  return ladder.length - 1;
}

/**
 * The ladder itself: which rung to send at, given how the sending is going.
 *
 * It is fed after every pass - how long the pass took, how many bytes went out and
 * how many frames had to be dropped - and answers with the rung to use next.
 */
export class QualityLadder {
  ladder: any;
  index: any;
  upAfterMs: any;
  downAfterMs: any;
  comfortableSince: any;
  _rung: any;

  constructor({ ladder = RELAY_LADDER, startIndex = 0, upAfterMs = 5000, downAfterMs = 600 }: any = {}) {
    this.ladder = ladder;
    this.index = Math.max(0, Math.min(ladder.length - 1, startIndex));
    this.upAfterMs = upAfterMs;
    this.downAfterMs = downAfterMs;
    this.comfortableSince = null;
    this._rung = ladder[this.index];
  }

  get rung() {
    return this._rung;
  }

  get name() {
    return this._rung?.name || '';
  }

  /** True while the picture is already as good as this link can carry. */
  get atCeiling() {
    return this.index === 0;
  }

  /** Start again at a rung, e.g. when the browser reports the network changed. */
  reset(index = this.index) {
    this.index = Math.max(0, Math.min(this.ladder.length - 1, index));
    this._rung = this.ladder[this.index];
    this.comfortableSince = null;
    return this._rung;
  }

  /**
   * One measurement.
   *
   * `struggling` is the sender's own verdict - slow passes, a filling socket,
   * frames dropped - and `now` is only passed in so tests can drive time.
   */
  note({ struggling = false, now = Date.now() }: any = {}) {
    if (struggling) {
      // Down at once: a stutter is felt in the same second it starts.
      this.comfortableSince = null;
      if (this.index < this.ladder.length - 1) this.index += 1;
      this._rung = this.ladder[this.index];
      return this._rung;
    }
    if (this.comfortableSince === null) {
      this.comfortableSince = now;
      return this._rung;
    }
    if (this.index > 0 && now - this.comfortableSince >= this.upAfterMs) {
      // Up one rung, then start the clock again: a link that can carry more will
      // keep climbing, one step per comfortable window.
      this.index -= 1;
      this._rung = this.ladder[this.index];
      this.comfortableSince = now;
    }
    return this._rung;
  }

  /** What the rung needs, in the same units the measurements are in. */
  needsKbps() {
    return this._rung?.kbps || 0;
  }
}

export default QualityLadder;
