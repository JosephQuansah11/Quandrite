/**
 * Room audio: everybody's voice, in one place.
 *
 * Remote audio used to be played by the tiles' own `<video>` elements, and that is
 * fragile in three ways that all look the same to a user - "the sound broke":
 *
 *  - an unmuted media element will not start until the page has been interacted
 *    with, so a stream that arrives first is simply silent;
 *  - the element is *removed* when a camera goes off, and the voice goes with it -
 *    a microphone on its own had no element to play through at all;
 *  - there is no way to duck one voice, or the whole room, without touching the
 *    element that also carries the picture.
 *
 * So the voices are mixed here instead: one `AudioContext`, one graph per peer
 * (`source -> analyser -> gain -> output`), and the tiles keep the pictures and stay
 * muted. The same graph measures the level, which is what draws the speaking wave.
 *
 * Because it is one context, recovery is one thing rather than three: it is resumed
 * on the first gesture, again whenever the page becomes visible, and by a watchdog
 * that notices a suspended context (backgrounded tabs and phones suspend audio, and
 * that is the most common way a call "breaks").
 */
export class RoomAudio extends EventTarget {
  // --- state (typed loosely, matching the other client modules) ---
  context: any;
  ducked: any;
  entries: any;
  /** How loud the room is allowed to be while a howl is being suppressed. */
  feedbackGain: any;
  /** The level and shape that count as a howl rather than a voice. */
  feedbackLevel: any;
  feedbackNarrowShare: any;
  feedbackHoldMs: any;
  master: any;
  /** Audio played outside this mixer, measured here (the relay's voice, the program feed). */
  meters: any;
  _feedbackUntil: any;
  _howling: any;
  /** Which signature fired: `narrow` (one loud note) or `rising` (a fast climb). */
  _feedbackReason: any;
  feedbackRiseLevel: any;
  feedbackRiseFactor: any;
  feedbackRiseStep: any;
  feedbackRisePasses: any;
  feedbackAttackS: any;
  feedbackReleaseS: any;
  holdMs: any;
  intervalMs: any;
  logger: any;
  threshold: any;
  timer: any;
  _lastResumeAt: any;
  _lastState: any;
  _speaking: any;

  constructor({
    logger = console,
    threshold = 0.012,
    holdMs = 700,
    // Feedback builds in a couple of hundred milliseconds, so the meter is read often
    // enough to catch it while it is still rising rather than after it hurts.
    intervalMs = 50,
    feedbackLevel = 0.12,
    feedbackNarrowShare = 0.06,
    /**
     * How loud a howl has to be for the *rise* test to have finished judging it. A howl
     * gets loud in a fraction of a second, so by the time it is this loud the climb has
     * already happened - and a word that merely starts loudly does not usually get here.
     */
    feedbackRiseLevel = 0.06,
    /** Every pass of a howl is a little louder than the last... */
    feedbackRiseStep = 1.08,
    /** ...for this many passes: 300 ms of unbroken climb is a loop, not a syllable. */
    feedbackRisePasses = 6,
    /** ...and the window as a whole has climbed by at least this much (4 dB). */
    feedbackRiseFactor = 1.6,
    /** Deep enough to break the loop: -34 dB is a howl that cannot sustain itself. */
    feedbackGain = 0.02,
    /** Pulled down in a hundredth of a second - this is a reflex, not a fade. */
    feedbackAttackS = 0.01,
    /** ...and let back up slowly, so the room does not surge the moment it stops. */
    feedbackReleaseS = 0.25,
    feedbackHoldMs = 1500,
  }: any = {}) {
    super();
    this.logger = logger;
    this.threshold = threshold;
    this.holdMs = holdMs;
    this.intervalMs = intervalMs;
    this.context = null;
    this.entries = new Map();
    /**
     * Audio that is played outside this mixer - the socket relay's voice, the program
     * feed - measured here so a howl on those paths is caught too. Each is either an
     * analyser somebody else owns or a stream analysed only.
     */
    this.meters = new Map();
    this.timer = null;
    this._speaking = new Set();
    this.ducked = false;
    this._lastResumeAt = 0;
    this._lastState = null;
    // Feedback has two signatures, and a room needs both to be safe:
    //
    //  - a **narrow** one note, loud - the classic howl, and what a badly placed
    //    microphone does first;
    //  - a **fast, sustained rise** - which is what a howl sounds like when the room is
    //    resonant and it is not one clean tone at all. A voice can be loud, and a voice
    //    can get louder, but it does not climb steadily for four passes in a row.
    this.feedbackLevel = feedbackLevel;
    this.feedbackNarrowShare = feedbackNarrowShare;
    this.feedbackRiseLevel = feedbackRiseLevel;
    this.feedbackRiseFactor = feedbackRiseFactor;
    this.feedbackRiseStep = feedbackRiseStep;
    this.feedbackRisePasses = feedbackRisePasses;
    this.feedbackGain = feedbackGain;
    this.feedbackAttackS = feedbackAttackS;
    this.feedbackReleaseS = feedbackReleaseS;
    this.feedbackHoldMs = feedbackHoldMs;
    this.master = null;
    this._howling = false;
    this._feedbackUntil = 0;
  }

  /** The ids currently being heard. */
  get speaking() {
    return new Set(this._speaking);
  }

  /** What the browser says the audio graph is doing. */
  get state() {
    if (!this.context) return 'unavailable';
    return this.context.state;
  }

  level(id: string) {
    return this.entries.get(id)?.level || 0;
  }

  /**
   * Bring one participant's audio into the room.
   *
   * `monitor` is false for my own microphone: I want the wave under my tile, but I
   * certainly do not want to hear myself.
   */
  /**
   * Watch a meter that is not a voice mixed here.
   *
   * Voice arrives by three paths: this mixer (peer to peer), the socket relay, and the
   * program feed the room's owner sends. Only the first was ever analysed, so a howl on
   * either of the other two played on and on with nothing to notice it. A meter is an
   * analyser belonging to somebody else's output - the relay's, say - and the detector
   * treats it exactly like a voice.
   */
  meter(id: string, analyser: any) {
    if (!id || !analyser) return false;
    const existing = this.meters.get(id);
    if (existing?.analyser === analyser) return false;
    this.meters.set(id, {
      id,
      analyser,
      data: new Uint8Array(analyser.fftSize || 512),
      freq: new Uint8Array(analyser.frequencyBinCount || 256),
      howlStreak: 0,
      peakShare: 0,
      narrowShare: 1,
      level: 0,
    });
    this._ensureTimer();
    return true;
  }

  /**
   * Watch a stream that is played somewhere else.
   *
   * The program feed is an `<audio>`/`<video>` element rather than a node in this graph,
   * so it cannot be ducked from here - but its stream can still be *measured*, which is
   * what tells the room there is a howl to duck at all.
   */
  analyse(id: string, stream: any) {
    if (!id || !stream) return false;
    const existing = this.meters.get(id);
    if (existing?.stream === stream) return false;
    if (existing) this.forgetMeter(id);
    if (!(stream.getAudioTracks?.() || []).length) return false;
    const context = this._ensureContext();
    if (!context) return false;
    try {
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      // Analysis only: this stream is audible through its own element, and connecting it
      // here as well would play it twice.
      source.connect(analyser);
      this.meters.set(id, {
        id,
        stream,
        source,
        analyser,
        data: new Uint8Array(analyser.fftSize),
        freq: new Uint8Array(analyser.frequencyBinCount),
        howlStreak: 0,
        peakShare: 0,
        narrowShare: 1,
        level: 0,
      });
    } catch (error) {
      this.logger.warn?.('could not measure a stream', error);
      return false;
    }
    this._ensureTimer();
    this.resume();
    return true;
  }

  forgetMeter(id: string) {
    const meter = this.meters.get(id);
    if (!meter) return false;
    try {
      meter.source?.disconnect();
      meter.analyser?.disconnect?.();
    } catch {
      // already gone
    }
    this.meters.delete(id);
    return true;
  }

  track(id: string, stream: any, { monitor = true, muted = false }: any = {}) {
    if (!id || !stream) return false;
    const existing = this.entries.get(id);
    if (existing?.stream === stream) {
      this.setMuted(id, muted);
      return false;
    }
    if (existing) this.forget(id);
    if (!(stream.getAudioTracks?.() || []).length) return false;
    const context = this._ensureContext();
    if (!context) return false;
    try {
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      // The gain is where a voice is turned down: a muted participant, or the whole
      // room while the program mix is carrying it.
      const gain = context.createGain();
      gain.gain.value = muted || this.ducked || !monitor ? 0 : 1;
      source.connect(analyser);
      analyser.connect(gain);
      if (monitor) {
        // Everything audible goes through one master gain, so a howl can be pulled
        // down in one place and put back in one place.
        if (!this.master) {
          this.master = context.createGain();
          this.master.gain.value = 1;
          this.master.connect(context.destination);
        }
        gain.connect(this.master);
      }
      this.entries.set(id, {
        id,
        stream,
        source,
        analyser,
        gain,
        monitor,
        muted,
        data: new Uint8Array(analyser.fftSize),
        // The frequency view is what tells a howl from a voice.
        freq: new Uint8Array(analyser.frequencyBinCount),
        howlStreak: 0,
        peakShare: 0,
        level: 0,
        heldUntil: 0,
        /** The gain last asked for, so a ramp is not re-issued on every pass. */
        requested: monitor && !muted ? 1 : 0,
      });
    } catch (error) {
      this.logger.warn?.('could not mix a stream', error);
      return false;
    }
    this._ensureTimer();
    this.resume();
    this._publish();
    return true;
  }

  forget(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    try {
      entry.source.disconnect();
      entry.analyser.disconnect();
      entry.gain.disconnect();
    } catch {
      // already gone
    }
    this.entries.delete(id);
    if (this._speaking.delete(id)) this._publish();
    if (!this.entries.size) this.stop();
    return true;
  }

  /** Turn one voice up or down (a muted participant is really silent). */
  setMuted(id: string, muted: boolean) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.muted = Boolean(muted);
    this._applyGains();
    return true;
  }

  /** Duck the whole room: the program mix already carries everyone's voice. */
  setDucked(ducked: boolean) {
    this.ducked = Boolean(ducked);
    this._applyGains();
  }

  _applyGains() {
    for (const entry of this.entries.values()) {
      const wanted = entry.monitor && !entry.muted && !this.ducked ? 1 : 0;
      // Only when it changes: `setTargetAtTime` approaches its target rather than
      // arriving, so `gain.value` never equals it and a naive check would re-ramp on
      // every pass - and the entry would creep towards zero instead of reaching it.
      if (entry.requested === wanted) continue;
      entry.requested = wanted;
      try {
        // Ramped, not jumped: a click in the ear is its own kind of unpleasant. Short
        // enough that a mute still feels immediate.
        entry.gain.gain.setTargetAtTime(wanted, this.context.currentTime, 0.015);
      } catch {
        entry.gain.gain.value = wanted;
      }
    }
  }

  /**
   * Re-attach every voice.
   *
   * A page that has been backgrounded or frozen can come back with its audio graph
   * intact but silent: the browser may have dropped the incoming media while the tab
   * was away, and a source node that lost its stream never recovers by itself.
   * Rebuilding the graph from the same streams costs almost nothing, and it is the
   * difference between "the sound came back" and "the sound broke".
   */
  rebuild() {
    const entries = [...this.entries.values()].map((entry) => ({
      id: entry.id,
      stream: entry.stream,
      monitor: entry.monitor,
      muted: entry.muted,
    }));
    for (const entry of entries) this.forget(entry.id);
    for (const entry of entries) this.track(entry.id, entry.stream, { monitor: entry.monitor, muted: entry.muted });
    this.resume();
    return this.entries.size;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.entries.keys()]) this.forget(id);
    this._speaking.clear();
  }

  /** One pass over every meter: who is loud enough to be speaking right now. */
  sample(now = Date.now()) {
    for (const entry of this.entries.values()) {
      entry.analyser.getByteTimeDomainData(entry.data);
      let sum = 0;
      for (let index = 0; index < entry.data.length; index += 1) {
        const value = (entry.data[index] - 128) / 128;
        sum += value * value;
      }
      entry.level = Math.sqrt(sum / entry.data.length);
      if (entry.level >= this.threshold) entry.heldUntil = now + this.holdMs;
      const speaking = now < entry.heldUntil;
      if (speaking && !this._speaking.has(entry.id)) this._speaking.add(entry.id);
      else if (!speaking && this._speaking.has(entry.id)) this._speaking.delete(entry.id);
    }
    this._watchFeedback(now);
    // Audio the browser suspended is audio nobody can hear, so it is brought back
    // rather than waiting for the user to notice. Once every couple of seconds is
    // plenty, and it costs nothing while the context is already running.
    if (now - this._lastResumeAt > 2000) {
      this._lastResumeAt = now;
      this.resume();
    }
    // The moment a suspended context starts running again is the moment audio most
    // often stays silent, so the graph is rebuilt right then.
    const state = this.state;
    if (this._lastState === 'suspended' && state === 'running') this.rebuild();
    this._lastState = state;
    this._publish();
    return this.speaking;
  }

  /**
   * How narrow a stream's loudest note is.
   *
   * A voice spreads its energy across many frequencies; a howl puts almost all of it
   * in one, which is what makes feedback sound like a note rather than a person. The
   * measure is how *few* of the spectrum's bins carry most of the peak's energy -
   * comparing the peak with the whole spectrum does not work, because the quiet bins
   * add up and drown the answer.
   */
  _peakShape(entry) {
    entry.analyser.getByteFrequencyData(entry.freq);
    let peak = 0;
    for (let index = 0; index < entry.freq.length; index += 1) {
      if (entry.freq[index] > peak) peak = entry.freq[index];
    }
    if (peak <= 0) return { peakShare: 0, narrowShare: 1 };
    const strong = peak * 0.6;
    let loud = 0;
    for (let index = 0; index < entry.freq.length; index += 1) {
      if (entry.freq[index] >= strong) loud += 1;
    }
    return { peakShare: peak / 255, narrowShare: loud / entry.freq.length };
  }

  /** The levels a meter has reported lately, for the rise test. */
  _history(entry) {
    if (!entry.history) entry.history = [];
    return entry.history;
  }

  /**
   * Is this climbing like a howl?
   *
   * A voice can be loud, and a voice can get louder, but a voice's swell *turns over*:
   * it rises for a moment and then flattens or falls. A feedback loop does the opposite -
   * every round trip is louder than the last, so the level climbs **unbroken for a third
   * of a second** and keeps going. That is what this looks for: not a fixed number of dB
   * (a broad howl climbs steadily rather than by a fixed ratio), but an unbroken climb
   * that has added up to something real.
   */
  _rising(entry) {
    const history = this._history(entry);
    if (history.length < this.feedbackRisePasses) return false;
    const window = history.slice(-this.feedbackRisePasses);
    const newest = window[window.length - 1];
    const quietest = Math.min(...window.filter((level) => level > 0));
    if (!Number.isFinite(quietest) || quietest <= 0) return false;
    for (let index = 1; index < window.length; index += 1) {
      if (window[index] < window[index - 1] * this.feedbackRiseStep) return false;
    }
    return newest >= quietest * this.feedbackRiseFactor;
  }

  /** Record one pass of a level, so the rise test has something to look at. */
  _record(entry) {
    const history = this._history(entry);
    history.push(entry.level);
    // A few passes are all the test ever needs, and a long tail would let a voice that
    // happened to swell linger as evidence.
    if (history.length > this.feedbackRisePasses + 2) history.shift();
  }

  /** Both signatures, judged together: what this meter is doing right now. */
  _judge(entry) {
    const narrow = entry.level >= this.feedbackLevel && entry.narrowShare <= this.feedbackNarrowShare;
    const rising = entry.level >= this.feedbackRiseLevel && this._rising(entry);
    return { narrow, rising, howling: narrow || rising };
  }

  /**
   * Listen for a howl, and get out of its way.
   *
   * Feedback builds in milliseconds and hurts immediately, so the room is pulled down
   * (hard, and fast - a howl that is only *quieter* keeps feeding itself) the moment
   * either signature appears on any voice *or any of the other audio paths*, and turned
   * back up once the howl has been gone for a moment. Both the rise and the fall are
   * ramped, because a click is its own kind of unpleasant.
   */
  _watchFeedback(now) {
    let howling = false;
    let culprit = null;
    let reason = null;
    for (const entry of this.entries.values()) {
      const shape = this._peakShape(entry);
      entry.peakShare = shape.peakShare;
      entry.narrowShare = shape.narrowShare;
      // Every pass is recorded, *including* the quiet ones a howl climbs out of: the
      // climb is what is being judged, and it starts below any threshold worth naming.
      this._record(entry);
      const judged = this._judge(entry);
      entry.howlStreak = judged.howling ? entry.howlStreak + 1 : 0;
      // Two passes in a row: a single loud note in speech is not feedback. Only voices
      // that are actually *played* can feed a loop - a muted participant talking into a
      // loud microphone cannot howl the room, so it is not judged at all.
      if (entry.howlStreak >= 2 && entry.monitor && !entry.muted) {
        howling = true;
        culprit = culprit || entry.id;
        reason = reason || (judged.narrow ? 'narrow' : 'rising');
      }
    }
    // ...and the same test on the audio this mixer does not play: the relayed voice and
    // the program feed. A howl there used to be heard and never noticed.
    for (const meter of this.meters.values()) {
      const level = this._sampleMeter(meter);
      const shape = this._peakShape(meter);
      meter.peakShare = shape.peakShare;
      meter.narrowShare = shape.narrowShare;
      this._record(meter);
      const judged = this._judge(meter);
      meter.howlStreak = judged.howling ? meter.howlStreak + 1 : 0;
      if (meter.howlStreak >= 2) {
        howling = true;
        culprit = culprit || meter.id;
        reason = reason || (judged.narrow ? 'narrow' : 'rising');
      }
    }
    if (howling) {
      this._feedbackUntil = now + this.feedbackHoldMs;
      // Held down for as long as it lasts, not merely set once: something else may have
      // touched the master, and a howl is not the moment to be polite about it.
      this._setMaster(this.feedbackGain, this.feedbackAttackS);
      if (!this._howling || this._feedbackReason !== reason) {
        this._howling = true;
        this._feedbackReason = reason;
        this.dispatchEvent(new CustomEvent('feedback', { detail: { active: true, peerId: culprit, reason } }));
      }
      return;
    }
    if (this._howling && now > this._feedbackUntil) {
      this._howling = false;
      this._feedbackReason = null;
      this._setMaster(1, this.feedbackReleaseS);
      this.dispatchEvent(new CustomEvent('feedback', { detail: { active: false, peerId: null, reason: null } }));
    }
  }

  /** One level reading for a meter, so it can be judged like a voice. */
  _sampleMeter(meter) {
    meter.analyser.getByteTimeDomainData(meter.data);
    let sum = 0;
    for (let index = 0; index < meter.data.length; index += 1) {
      const value = (meter.data[index] - 128) / 128;
      sum += value * value;
    }
    meter.level = Math.sqrt(sum / meter.data.length);
    return meter.level;
  }

  _setMaster(value, timeConstant = 0.05) {
    if (!this.master) return;
    try {
      // Ramped, not jumped: a click in the ear is its own kind of unpleasant. The
      // *attack* is nearly instant - a howl that is only slightly quieter keeps feeding
      // itself - while the release is slow enough not to surge.
      this.master.gain.setTargetAtTime(value, this.context.currentTime, timeConstant);
    } catch {
      this.master.gain.value = value;
    }
  }

  /** True while a howl is being held down. */
  get feedbackActive() {
    return this._howling;
  }

  _publish() {
    this.dispatchEvent(new CustomEvent('change', { detail: { speaking: this.speaking, state: this.state } }));
  }

  _ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), this.intervalMs);
  }

  _ensureContext() {
    if (this.context) return this.context;
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.context = new Ctor();
    } catch {
      return null;
    }
    return this.context;
  }

  /**
   * Browsers keep audio suspended until the user interacts, and suspend it again
   * when the page is hidden. Called on both, and by the watchdog above.
   */
  resume() {
    const context = this._ensureContext();
    if (!context) return false;
    if (context.state === 'suspended') {
      context.resume().then(() => this._publish()).catch(() => {});
      return true;
    }
    return false;
  }

  /** A line for the studio's own diagnostics. */
  describe() {
    return {
      state: this.state,
      ducked: this.ducked,
      // A howl being held down, how loud the room is allowed to be while it is, and
      // which signature caught it.
      feedback: {
        active: this._howling,
        reason: this._feedbackReason ?? null,
        masterGain: this.master?.gain?.value ?? null,
      },
      // The audio played outside this mixer, watched for the same reason.
      meters: [...this.meters.values()].map((meter) => ({
        id: meter.id,
        level: Number((meter.level || 0).toFixed(4)),
        narrowShare: Number((meter.narrowShare ?? 1).toFixed(3)),
        howlStreak: meter.howlStreak || 0,
      })),
      peers: [...this.entries.values()].map((entry) => {
        const track = entry.stream?.getAudioTracks?.()[0] || null;
        return {
          id: entry.id,
          monitor: entry.monitor,
          muted: entry.muted,
          gain: entry.gain.gain.value,
          level: Number(entry.level.toFixed(4)),
          peakShare: Number((entry.peakShare || 0).toFixed(3)),
          narrowShare: Number((entry.narrowShare ?? 1).toFixed(3)),
          // What the browser says about the incoming track: `muted` is how it tells
          // us the media stopped arriving, which is the first thing to check when a
          // voice cannot be heard.
          track: track ? { muted: track.muted, readyState: track.readyState, enabled: track.enabled } : null,
        };
      }),
    };
  }
}

export default RoomAudio;

