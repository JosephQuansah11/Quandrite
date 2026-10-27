/**
 * Room registry.
 *
 * A room is a communication space (chat + meeting) that doubles as a
 * livestream studio. Rooms are created explicitly through the REST API or
 * implicitly when a client joins an unknown id.
 */

import { randomUUID } from 'node:crypto';
import { Studio } from './studio.ts';

export class RoomRegistry {

  // --- state (typed loosely while the class is migrated) ---
  _sweeper: any;
  config: any;
  logger: any;
  recordingStore: any;
  rooms: any;
  constructor({ config, recordingStore = null, logger = console }: any = {}) {
    this.config = config;
    this.recordingStore = recordingStore;
    this.logger = logger;
    this.rooms = new Map();
    this._sweeper = null;
  }

  static newRoomId() {
    return randomUUID().slice(0, 8);
  }

  create({ id, name, hostName, hostPassword, cohostPassword, breakoutOf = null, breakoutIndex = null }: any = {}) {
    if (this.rooms.size >= (this.config?.maxRooms ?? 200)) {
      return { ok: false, error: 'the server has reached its room limit' };
    }
    let roomId = (id || RoomRegistry.newRoomId()).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(roomId)) {
      return { ok: false, error: 'room id may only contain letters, digits, dash and underscore' };
    }
    if (this.rooms.has(roomId)) {
      return { ok: false, error: `room ${roomId} already exists` };
    }

    const studio = new Studio({
      id: roomId,
      name: name || roomId,
      hostName: hostName || 'Host',
      // Explicit passwords win; otherwise the operator's environment defaults
      // apply, and a room without either generates its own.
      hostPassword: hostPassword ?? this.config?.hostPassword,
      cohostPassword: cohostPassword ?? this.config?.cohostPassword,
      breakoutOf,
      breakoutIndex,
      // A parent room opens and closes its own breakout rooms.
      breakoutRooms: {
        create: (options) => this.createBreakout(options),
        remove: (roomId) => this.delete(roomId),
      },
      config: this.config,
      recordingStore: this.recordingStore,
      logger: this.logger,
    });
    this.rooms.set(roomId, studio);
    return { ok: true, studio };
  }

  /** Get a room, creating it on demand when `createIfMissing` is true. */
  get(id, { createIfMissing = false, name, hostName }: any = {}) {
    const roomId = String(id || '').trim().toLowerCase();
    if (!roomId) return null;
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    if (!createIfMissing) return null;
    const created = this.create({ id: roomId, name: name || roomId, hostName });
    return created.ok ? created.studio : null;
  }

  /**
   * Open a breakout room for `parentId`.
   *
   * A breakout is a full room (its own chat and attendees) that the parent room
   * owns: it is created on demand and removed again when the parent clears it.
   */
  createBreakout({ id, name, parentId, index }: any = {}) {
    const created = this.create({ id, name, breakoutOf: parentId, breakoutIndex: index });
    if (!created.ok) {
      this.logger.warn?.(`could not open breakout room ${id}: ${created.error}`);
      return null;
    }
    return created.studio;
  }

  list() {
    return [...this.rooms.values()]
      .filter((studio) => !studio.breakoutOf)
      .map((studio) => ({
        id: studio.id,
        name: studio.name,
        createdAt: studio.createdAt,
        members: studio.members.size,
        sources: studio.sources.size,
        destinations: studio.destinations.size,
        breakouts: studio.breakouts.size,
        streamStatus: studio.stream.status,
        recordingStatus: studio.recording.status,
      }));
  }

  async delete(id) {
    const roomId = String(id || '').trim().toLowerCase();
    const studio = this.rooms.get(roomId);
    if (!studio) return false;
    this.rooms.delete(roomId);
    await studio.dispose();
    return true;
  }

  /** Heartbeat: refresh metrics and expire idle rooms. */
  tick() {
    for (const studio of this.rooms.values()) {
      // Breakout rooms live and die with their parent room.
      if (studio.breakoutOf) continue;
      if (studio.members.size === 0 && studio.stream.status === 'offline') {
        studio.emptySince = studio.emptySince ?? Date.now();
        if (Date.now() - studio.emptySince > (this.config?.emptyRoomTtlMs ?? 6 * 60 * 60 * 1000)) {
          this.delete(studio.id).catch(() => {});
        }
        continue;
      }
      studio.emptySince = null;
      studio.tick();
    }
  }

  startSweeper(intervalMs = 5000) {
    if (this._sweeper) return this._sweeper;
    this._sweeper = setInterval(() => this.tick(), intervalMs);
    if (typeof this._sweeper.unref === 'function') this._sweeper.unref();
    return this._sweeper;
  }

  stopSweeper() {
    if (this._sweeper) {
      clearInterval(this._sweeper);
      this._sweeper = null;
    }
  }

  async dispose() {
    this.stopSweeper();
    const studios = [...this.rooms.values()];
    this.rooms.clear();
    await Promise.all(studios.map((studio) => studio.dispose()));
  }
}

export default RoomRegistry;
