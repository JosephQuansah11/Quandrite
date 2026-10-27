/**
 * Studio: the authoritative state of one communication room / broadcast.
 *
 * It owns members, chat, the pool of media sources (multiple cameras, screen
 * shares, audio), which source(s) are on the program output, the current
 * overlay scene, the platform destinations, the outbound relay and the
 * recording. Every mutation emits a granular event that the signalling layer
 * fans out to connected clients.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createOverlay, OVERLAY_DEFINITIONS } from '../shared/overlays.js';
import { redactDestination, validateDestination } from '../shared/destinations.js';
import { PROGRAM_MODES, SOURCE_KINDS } from '../shared/protocol.js';
import { resolveProgramSources } from '../shared/layout.js';
import { listPresets } from './ffmpeg.js';
import { StreamRelay } from './relay.js';

const MAX_CHAT_LENGTH = 2000;
const MAX_MEMBER_NAME = 48;
const MAX_SOURCE_LABEL = 64;

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export class Studio extends EventEmitter {
  constructor({
    id,
    name,
    hostName = 'Host',
    config,
    recordingStore = null,
    relayFactory = null,
    logger = console,
  }) {
    super();
    this.id = id;
    this.name = cleanText(name, 80) || id;
    this.config = config;
    this.recordingStore = recordingStore;
    this.relayFactory = relayFactory;
    this.logger = logger;
    this.createdAt = Date.now();

    this.members = new Map();
    this.chat = [];
    this.sources = new Map();
    this.destinations = new Map();

    this.program = {
      mode: 'single',
      sourceId: null,
      gridIds: [],
      updatedAt: this.createdAt,
    };
    this.scene = null;
    this._sceneTimer = null;
    this._sceneRestore = null;

    this.stream = {
      status: 'offline',
      preset: config?.defaultPreset || '1080p30',
      startedAt: null,
      endedAt: null,
      error: null,
      publisherId: null,
      metrics: null,
    };
    this.relay = null;

    this.recording = {
      status: 'idle',
      id: null,
      startedAt: null,
      endedAt: null,
      file: null,
      durationMs: null,
      sizeBytes: 0,
      error: null,
    };
    this.hostId = null;
    this.hostName = cleanText(hostName, MAX_MEMBER_NAME) || 'Host';
  }

  // ---------------------------------------------------------------- members

  join({ clientId, name, role } = {}) {
    if (!clientId) throw new Error('clientId is required');
    const isFirst = this.members.size === 0 && !this.hostId;
    const memberName = cleanText(name, MAX_MEMBER_NAME) || (isFirst ? this.hostName : 'Guest');
    const requested = ['host', 'cohost', 'viewer'].includes(role) ? role : null;
    const effectiveRole = isFirst ? 'host' : requested || 'viewer';

    const member = {
      id: clientId,
      name: memberName,
      role: effectiveRole,
      joinedAt: Date.now(),
      muted: false,
      cameraEnabled: false,
      screenSharing: false,
      speaking: false,
      sourceIds: [],
    };
    this.members.set(clientId, member);
    if (effectiveRole === 'host') {
      this.hostId = clientId;
      this.hostName = memberName;
    }
    this.addChat({
      authorId: 'system',
      authorName: 'Quandrite',
      kind: 'system',
      text: `${member.name} joined the room`,
    });
    this.emit('members', this.membersSnapshot());
    return member;
  }

  leave(clientId) {
    const member = this.members.get(clientId);
    if (!member) return false;
    this.members.delete(clientId);
    for (const sourceId of [...member.sourceIds]) {
      this.removeSource(sourceId, { byId: clientId, silent: true });
    }
    if (this.stream.publisherId === clientId) {
      this.stream.publisherId = null;
    }
    if (this.hostId === clientId) {
      // Keep the room controllable: hand the host role to the earliest member.
      const next = [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (next) {
        next.role = 'host';
        this.hostId = next.id;
        this.hostName = next.name;
      } else {
        this.hostId = null;
      }
    }
    this.addChat({
      authorId: 'system',
      authorName: 'Quandrite',
      kind: 'system',
      text: `${member.name} left the room`,
    });
    this.emit('members', this.membersSnapshot());
    this.emit('sources', this.sourcesSnapshot());
    return true;
  }

  getMember(clientId) {
    return this.members.get(clientId) || null;
  }

  memberName(clientId) {
    return this.members.get(clientId)?.name || 'Guest';
  }

  updateMember(clientId, patch = {}) {
    const member = this.members.get(clientId);
    if (!member) return null;
    if (patch.muted !== undefined) member.muted = Boolean(patch.muted);
    if (patch.cameraEnabled !== undefined) member.cameraEnabled = Boolean(patch.cameraEnabled);
    if (patch.screenSharing !== undefined) member.screenSharing = Boolean(patch.screenSharing);
    if (patch.speaking !== undefined) member.speaking = Boolean(patch.speaking);
    if (patch.name !== undefined) member.name = cleanText(patch.name, MAX_MEMBER_NAME) || member.name;
    this.emit('members', this.membersSnapshot());
    return member;
  }

  addChat({ authorId, authorName, text, kind = 'text' } = {}) {
    const body = kind === 'system' ? cleanText(text, MAX_CHAT_LENGTH) : String(text ?? '').trim().slice(0, MAX_CHAT_LENGTH);
    if (!body) return null;
    const message = {
      id: randomUUID(),
      authorId: authorId || 'system',
      authorName: cleanText(authorName, MAX_MEMBER_NAME) || this.memberName(authorId),
      kind,
      text: body,
      at: Date.now(),
    };
    this.chat.push(message);
    const limit = this.config?.chatLimit ?? 500;
    if (this.chat.length > limit) this.chat.splice(0, this.chat.length - limit);
    this.emit('chat', message);
    return message;
  }

  // ---------------------------------------------------------------- sources

  /**
   * Register a media source published by a member.
   *
   * A source is one camera (including cameras paired to the machine over
   * Bluetooth and exposed by the OS), one screen share, or one audio track.
   * A single machine may register several at once - that is how multiple
   * cameras appear side by side in the program picture.
   */
  addSource({ id, ownerId, label, kind = 'camera', deviceId = null, groupId = null, meta = {} } = {}) {
    if (!ownerId) return { ok: false, error: 'ownerId is required' };
    if (!SOURCE_KINDS.includes(kind)) {
      return { ok: false, error: `unsupported source kind: ${kind}` };
    }
    const sourceId = cleanText(id, 80) || randomUUID();
    const existing = this.sources.get(sourceId);
    if (existing && existing.ownerId !== ownerId) {
      return { ok: false, error: 'source id is already in use' };
    }
    if (!existing && this.sources.size >= (this.config?.maxSourcesPerRoom ?? 24)) {
      return { ok: false, error: 'this room has reached its source limit' };
    }

    const member = this.members.get(ownerId);
    const source = {
      id: sourceId,
      ownerId,
      ownerName: member?.name || 'Guest',
      label: cleanText(label, MAX_SOURCE_LABEL) || `${kind} ${this.sources.size + 1}`,
      kind,
      deviceId: deviceId ? String(deviceId).slice(0, 200) : null,
      groupId: groupId ? String(groupId).slice(0, 200) : null,
      meta: typeof meta === 'object' && meta ? meta : {},
      active: true,
      addedAt: existing?.addedAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.sources.set(sourceId, source);
    if (member && !member.sourceIds.includes(sourceId)) member.sourceIds.push(sourceId);

    let programChanged = false;
    if (!this.program.sourceId && source.kind !== 'audio') {
      this.program = { ...this.program, sourceId, updatedAt: Date.now() };
      programChanged = true;
    }
    if (this.program.mode === 'screenshare' && source.kind === 'screen') {
      this.program = { ...this.program, sourceId, updatedAt: Date.now() };
      programChanged = true;
    }

    this.emit('sources', this.sourcesSnapshot());
    if (programChanged) this.emit('program', this.programSnapshot());
    return { ok: true, source };
  }

  updateSource(id, patch = {}, { byId } = {}) {
    const source = this.sources.get(id);
    if (!source) return { ok: false, error: 'source not found' };
    if (byId && source.ownerId !== byId) return { ok: false, error: 'not your source' };
    if (patch.label !== undefined) source.label = cleanText(patch.label, MAX_SOURCE_LABEL) || source.label;
    if (patch.active !== undefined) source.active = Boolean(patch.active);
    if (patch.meta && typeof patch.meta === 'object') source.meta = { ...source.meta, ...patch.meta };
    source.updatedAt = Date.now();
    this.emit('sources', this.sourcesSnapshot());
    return { ok: true, source };
  }

  removeSource(id, { byId, silent = false } = {}) {
    const source = this.sources.get(id);
    if (!source) return { ok: false, error: 'source not found' };
    if (byId && source.ownerId !== byId) return { ok: false, error: 'not your source' };

    this.sources.delete(id);
    const member = this.members.get(source.ownerId);
    if (member) member.sourceIds = member.sourceIds.filter((sourceId) => sourceId !== id);

    let programChanged = false;
    if (this.program.sourceId === id) {
      this.program = { ...this.program, sourceId: this._fallbackSourceId(), updatedAt: Date.now() };
      programChanged = true;
    }
    if (this.program.gridIds.includes(id)) {
      this.program = {
        ...this.program,
        gridIds: this.program.gridIds.filter((gridId) => gridId !== id),
        updatedAt: Date.now(),
      };
      programChanged = true;
    }

    if (!silent) this.emit('sources', this.sourcesSnapshot());
    if (programChanged) this.emit('program', this.programSnapshot());
    return { ok: true };
  }

  _fallbackSourceId() {
    const sources = [...this.sources.values()];
    const camera = sources.find((source) => source.kind === 'camera');
    if (camera) return camera.id;
    const screen = sources.find((source) => source.kind === 'screen');
    if (screen) return screen.id;
    return sources[0]?.id ?? null;
  }

  // ---------------------------------------------------------------- program

  /**
   * Choose what goes out on the program output.
   * @param {{mode?: string, sourceId?: string|null, gridIds?: string[]}} input
   */
  setProgram({ mode, sourceId, gridIds } = {}) {
    const next = { ...this.program };
    const explicitGrid = gridIds !== undefined;

    if (mode !== undefined) {
      if (!PROGRAM_MODES.includes(mode)) return { ok: false, error: `unsupported program mode: ${mode}` };
      next.mode = mode;
    }

    if (explicitGrid) {
      if (!Array.isArray(gridIds)) return { ok: false, error: 'gridIds must be an array' };
      next.gridIds = [...new Set(gridIds.map((id) => String(id)))].filter((id) => this.sources.has(id));
    }

    if (sourceId !== undefined) {
      if (sourceId === null) next.sourceId = null;
      else if (!this.sources.has(sourceId)) return { ok: false, error: 'source not found' };
      else next.sourceId = sourceId;
    }

    // "Grid mode" without an explicit list means "every camera and screen".
    if (next.mode === 'grid' && (!explicitGrid || next.gridIds.length === 0)) {
      next.gridIds = [...this.sources.values()]
        .filter((source) => source.kind !== 'audio')
        .map((source) => source.id);
      if (next.gridIds.length === 0) return { ok: false, error: 'no sources available for the grid' };
    }

    if (next.mode === 'screenshare') {
      const current = next.sourceId ? this.sources.get(next.sourceId) : null;
      if (!current || current.kind !== 'screen') {
        const screen = [...this.sources.values()].find((source) => source.kind === 'screen');
        if (!screen) return { ok: false, error: 'no screen share source available' };
        next.sourceId = screen.id;
      }
    }

    if (!next.sourceId && next.mode !== 'grid') next.sourceId = this._fallbackSourceId();

    next.updatedAt = Date.now();
    this.program = next;
    this.emit('program', this.programSnapshot());
    return { ok: true, program: this.programSnapshot() };
  }

  // ------------------------------------------------------------------ scene

  /**
   * Push an overlay onto the program picture.
   *
   * Supported types: title, announcement, screenshare, song, break, ended.
   * Timed overlays clear themselves; persistent ones stay until replaced.
   */
  setScene(input = {}) {
    const created = createOverlay(input);
    if (!created.ok) return { ok: false, errors: created.errors };
    const scene = created.value;

    if (this._sceneTimer) {
      clearTimeout(this._sceneTimer);
      this._sceneTimer = null;
    }

    if (scene.type === 'screenshare') {
      const sourceId =
        scene.payload.sourceId ||
        [...this.sources.values()].find((source) => source.kind === 'screen')?.id ||
        null;
      if (!sourceId) {
        return { ok: false, errors: ['no screen share source is available to put on air'] };
      }
      scene.payload.sourceId = sourceId;
      if (!this._sceneRestore) {
        this._sceneRestore = { mode: this.program.mode, sourceId: this.program.sourceId };
      }
      this.setProgram({ mode: 'screenshare', sourceId });
    }

    this.scene = scene;
    if (!scene.persistent && scene.expiresAt) {
      const delay = Math.max(0, scene.expiresAt - Date.now());
      this._sceneTimer = setTimeout(() => {
        if (this.scene && this.scene.id === scene.id) this.clearScene({ auto: true });
      }, delay);
      if (typeof this._sceneTimer.unref === 'function') this._sceneTimer.unref();
    }

    this.emit('scene', scene);
    return { ok: true, scene };
  }

  clearScene({ auto = false } = {}) {
    if (this._sceneTimer) {
      clearTimeout(this._sceneTimer);
      this._sceneTimer = null;
    }
    const previous = this.scene;
    this.scene = null;

    if (previous?.type === 'screenshare' && this._sceneRestore) {
      const restore = this._sceneRestore;
      this._sceneRestore = null;
      this.setProgram(restore);
    }

    this.emit('scene', null);
    return { ok: true, cleared: previous?.type ?? null, auto };
  }

  // ----------------------------------------------------------- destinations

  /** Add a platform to the fan-out. Restarts the relay when already live. */
  addDestination(input = {}) {
    const limit = this.config?.maxDestinationsPerRoom ?? 8;
    if (this.destinations.size >= limit) {
      return { ok: false, error: `a room can stream to at most ${limit} destinations` };
    }
    const validated = validateDestination(input);
    if (!validated.ok) return { ok: false, errors: validated.errors };

    const destination = {
      id: randomUUID(),
      ...validated.value,
      status: 'idle',
      addedAt: Date.now(),
      updatedAt: Date.now(),
      lastError: null,
    };
    this.destinations.set(destination.id, destination);
    this.emit('destinations', this.destinationsSnapshot());
    this._onDestinationsChanged();
    return { ok: true, destination: redactDestination(destination) };
  }

  updateDestination(id, patch = {}) {
    const destination = this.destinations.get(id);
    if (!destination) return { ok: false, error: 'destination not found' };

    const validated = validateDestination({
      platform: patch.platform ?? destination.platform,
      streamKey: patch.streamKey ?? destination.streamKey,
      overrideUrl: patch.overrideUrl ?? destination.overrideUrl,
      label: patch.label ?? destination.label,
      enabled: patch.enabled ?? destination.enabled,
    });
    if (!validated.ok) return { ok: false, errors: validated.errors };

    Object.assign(destination, validated.value, { updatedAt: Date.now() });
    this.emit('destinations', this.destinationsSnapshot());
    this._onDestinationsChanged();
    return { ok: true, destination: redactDestination(destination) };
  }

  removeDestination(id) {
    if (!this.destinations.delete(id)) return { ok: false, error: 'destination not found' };
    this.emit('destinations', this.destinationsSnapshot());
    this._onDestinationsChanged();
    return { ok: true };
  }

  enabledDestinations() {
    return [...this.destinations.values()].filter((destination) => destination.enabled);
  }

  _onDestinationsChanged() {
    if (!this.relay || this.stream.status === 'offline' || this.stream.status === 'ended') return;
    this._reconfigureRelay().catch((error) => {
      this.logger.error?.(`relay reconfigure failed: ${error.message}`);
    });
  }

  // ----------------------------------------------------------------- stream

  /**
   * Container used for the recording slave of the tee muxer.
   *
   * The tee muxer cannot write Matroska slaves ("error writing header"), so a
   * fan-out recording is always MP4. The relay always closes ffmpeg's stdin
   * gracefully, which lets the MP4 muxer write its index before exiting.
   */
  _recordingFormat() {
    return 'mp4';
  }

  _buildTargets(recordingEntry) {
    const targets = this.enabledDestinations().map((destination) => ({
      kind: 'rtmp',
      url: destination.url,
      onfail: 'ignore',
      destinationId: destination.id,
    }));
    if (recordingEntry && this.recordingStore) {
      targets.push({
        kind: 'file',
        path: this.recordingStore.absPath(recordingEntry),
        format: this._recordingFormat(),
        onfail: 'ignore',
        recordingId: recordingEntry.id,
      });
    }
    return targets;
  }

  _createRelay(targets, preset) {
    const options = {
      ffmpegBin: this.config.ffmpegBin,
      roomId: this.id,
      preset,
      targets,
      inputFormat: this.config.defaultInputFormat,
      audioBitrateKbps: this.config.audioBitrateKbps,
      relayOptions: this.config.relay,
      logger: this.logger,
    };
    const relay = this.relayFactory ? this.relayFactory(options) : new StreamRelay(options);

    relay.on('status', (snapshot) => {
      if (this.relay !== relay) return;
      this.stream.status = snapshot.status;
      this.stream.metrics = snapshot;
      if (snapshot.status === 'error') this.stream.error = snapshot.error;
      this.emit('stream', this.streamSnapshot());
    });

    relay.on('metrics', (snapshot) => {
      if (this.relay !== relay) return;
      this.stream.metrics = snapshot;
      this.emit('stream', this.streamSnapshot());
    });

    relay.on('log', (entry) => {
      if (this.relay !== relay) return;
      this.emit('log', entry);
    });

    relay.on('failed', (info) => {
      if (this.relay !== relay) return;
      this.logger.error?.(`relay failed in room ${this.id}: ${info.error}`);
      this.addChat({
        authorId: 'system',
        authorName: 'Quandrite',
        kind: 'system',
        text: `Livestream problem: ${info.error}`,
      });
    });

    relay.on('stopped', () => {
      if (this.relay !== relay) return;
      this._finalizeStream().catch((error) => {
        this.logger.error?.(`finalize failed in room ${this.id}: ${error.message}`);
      });
    });

    return relay;
  }

  /**
   * Go live: start the ffmpeg relay that fans the program feed out to every
   * enabled platform, optionally recording it at the same time.
   */
  async startStream({ preset, record = false, byId = null, resolution } = {}) {
    if (this.relay && ['connecting', 'live', 'reconnecting'].includes(this.stream.status)) {
      return { ok: false, error: 'the stream is already live' };
    }

    const destinations = this.enabledDestinations();
    if (destinations.length === 0 && !record) {
      return { ok: false, error: 'add a destination or enable recording before going live' };
    }

    const chosenPreset = resolution || preset || this.stream.preset || this.config.defaultPreset;
    if (!listPresets().some((entry) => entry.label === chosenPreset)) {
      return { ok: false, error: `unknown video preset: ${chosenPreset}` };
    }

    let recordingEntry = null;
    if (record) {
      if (!this.recordingStore) return { ok: false, error: 'recording is not available on this server' };
      recordingEntry = await this.recordingStore.create({
        roomId: this.id,
        roomName: this.name,
        format: this._recordingFormat(),
        preset: chosenPreset,
        destinations: destinations.map((destination) => destination.label),
      });
    }

    const targets = this._buildTargets(recordingEntry);
    this.relay = this._createRelay(targets, chosenPreset);
    this.stream = {
      status: 'connecting',
      preset: chosenPreset,
      startedAt: Date.now(),
      endedAt: null,
      error: null,
      publisherId: byId,
      metrics: null,
      recordRequested: Boolean(record),
    };

    if (recordingEntry) {
      this.recording = {
        status: 'recording',
        id: recordingEntry.id,
        startedAt: Date.now(),
        endedAt: null,
        file: recordingEntry.file,
        mp4: null,
        durationMs: null,
        sizeBytes: 0,
        error: null,
      };
      this.emit('recording', this.recordingSnapshot());
    }

    this.relay.start();
    this.emit('stream', this.streamSnapshot());
    this.addChat({
      authorId: 'system',
      authorName: 'Quandrite',
      kind: 'system',
      text: `Livestream starting - ${destinations.length} destination(s)${
        recordingEntry ? ' + recording' : ''
      }`,
    });

    return { ok: true, stream: this.streamSnapshot() };
  }

  /** Take the broadcast off the air and finalise the recording. */
  async stopStream({ byId = null, reason = 'stopped' } = {}) {
    if (!this.relay) return { ok: false, error: 'the stream is not live' };
    const relay = this.relay;
    this.stream.status = 'stopping';
    this.emit('stream', this.streamSnapshot());
    this.addChat({
      authorId: 'system',
      authorName: 'Quandrite',
      kind: 'system',
      text: `${byId ? this.memberName(byId) : 'The host'} stopped the livestream`,
    });
    await relay.stop({ reason });
    await this._finalizeStream();
    return { ok: true, stream: this.streamSnapshot() };
  }

  async _finalizeStream() {
    if (this._finalizePromise) return this._finalizePromise;

    this._finalizePromise = (async () => {
      this.stream.status = 'ended';
      this.stream.endedAt = Date.now();
      this.stream.publisherId = null;

      if (this.recording.status === 'recording' && this.recording.id && this.recordingStore) {
        this.recording.status = 'processing';
        this.emit('recording', this.recordingSnapshot());
        const entry = await this.recordingStore.finalize(this.recording.id);
        const ready = entry?.status === 'ready';
        this.recording = {
          status: ready ? 'ready' : 'error',
          id: this.recording.id,
          startedAt: this.recording.startedAt,
          endedAt: Date.now(),
          file: entry?.file ?? null,
          mp4: entry?.mp4 ?? null,
          durationMs: entry?.durationMs ?? null,
          sizeBytes: entry?.sizeBytes ?? 0,
          error: ready ? null : entry?.error ?? 'the recording could not be finalised',
        };
        this.emit('recording', this.recordingSnapshot());
        this.addChat({
          authorId: 'system',
          authorName: 'Quandrite',
          kind: 'system',
          text: ready ? 'Recording saved and available in the library' : 'Recording failed',
        });
      }

      this.relay = null;
      this.emit('stream', this.streamSnapshot());
      this._finalizePromise = null;
      return this.stream;
    })();

    return this._finalizePromise;
  }

  /** True when this client is the one allowed to feed the encoder. */
  isPublisher(clientId) {
    return Boolean(this.relay) && this.stream.publisherId === clientId;
  }

  /** Push one program chunk (WebM/Matroska) from the publisher into ffmpeg. */
  writeProgramChunk(clientId, chunk) {
    if (!this.isPublisher(clientId)) return false;
    return this.relay.write(chunk);
  }

  /**
   * Rebuild the relay so destination changes take effect mid-broadcast.
   *
   * The old process is stopped before the new one starts so the recording file
   * never has two writers.
   */
  _reconfigureRelay() {
    this._reconfigureChain = (this._reconfigureChain || Promise.resolve()).then(async () => {
      const previous = this.relay;
      if (!previous) return;
      const preset = this.stream.preset;
      const recordingEntry =
        this.recording.status === 'recording' && this.recording.id && this.recordingStore
          ? this.recordingStore.get(this.recording.id)
          : null;

      this.relay = null;
      await previous.stop({ reason: 'reconfigure' });
      if (this.stream.status === 'ended') return;

      this.relay = this._createRelay(this._buildTargets(recordingEntry), preset);
      this.relay.start();
      this.stream.status = 'connecting';
      this.emit('stream', this.streamSnapshot());
    });
    return this._reconfigureChain;
  }

  // -------------------------------------------------------------- snapshots

  membersSnapshot() {
    return [...this.members.values()].map((member) => ({ ...member }));
  }

  sourcesSnapshot() {
    return [...this.sources.values()].map((source) => ({ ...source }));
  }

  programSnapshot() {
    const onAir = resolveProgramSources({
      sources: this.sourcesSnapshot(),
      program: this.program,
    }).map((source) => source.id);
    return { ...this.program, onAir };
  }

  destinationsSnapshot() {
    return [...this.destinations.values()].map((destination) => redactDestination(destination));
  }

  sceneSnapshot() {
    if (!this.scene) return null;
    return {
      ...this.scene,
      blocksProgram: OVERLAY_DEFINITIONS[this.scene.type]?.blocksProgram ?? false,
    };
  }

  streamSnapshot() {
    const metrics = this.stream.metrics || null;
    return {
      ...this.stream,
      uptimeMs: this.stream.startedAt ? (this.stream.endedAt || Date.now()) - this.stream.startedAt : 0,
      bitrateKbps: metrics?.bitrateKbps ?? 0,
      bytesIn: metrics?.bytesIn ?? 0,
      restarts: metrics?.restarts ?? 0,
      recording: this.recording.status === 'recording',
      destinationStatuses: this.enabledDestinations().map((destination) => ({
        id: destination.id,
        label: destination.label,
        platform: destination.platform,
        url: destination.url ? redactDestination(destination).url : null,
      })),
    };
  }

  recordingSnapshot() {
    return { ...this.recording };
  }

  /** Full state handed to a client when it joins or reconnects. */
  snapshot() {
    return {
      room: {
        id: this.id,
        name: this.name,
        hostId: this.hostId,
        createdAt: this.createdAt,
      },
      members: this.membersSnapshot(),
      chat: this.chat.slice(-100),
      sources: this.sourcesSnapshot(),
      program: this.programSnapshot(),
      scene: this.sceneSnapshot(),
      destinations: this.destinationsSnapshot(),
      stream: this.streamSnapshot(),
      recording: this.recordingSnapshot(),
      presets: listPresets(),
    };
  }

  /** Periodic heartbeat so uptime/bitrate stay fresh for idle rooms. */
  tick() {
    if (this.stream.status === 'offline') return;
    this.emit('stream', this.streamSnapshot());
  }

  async dispose() {
    if (this._sceneTimer) {
      clearTimeout(this._sceneTimer);
      this._sceneTimer = null;
    }
    const relay = this.relay;
    this.relay = null;
    if (relay) {
      try {
        await relay.stop({ reason: 'room-closed' });
      } catch {
        // best effort
      }
    }
    this.removeAllListeners();
  }
}
