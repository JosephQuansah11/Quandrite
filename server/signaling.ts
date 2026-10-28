/**
 * WebSocket signalling.
 *
 * Carries chat, studio control (program/scene/destinations), WebRTC SDP and ICE
 * exchange for the meeting, and the binary program feed that the host's
 * compositor streams into the encoder.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { CHAT_ATTACHMENT_TYPES, CLIENT, MAX_CHAT_ATTACHMENT_BYTES, SERVER, PROTOCOL_VERSION, RELAY_AUDIO_BURST, RELAY_AUDIO_MAX_FPS, RELAY_MAX_FPS, RELAY_WARM_FRAMES, RELAY_WARM_MAX_AGE_MS, canControlBroadcast, decodeRelayFrame, encodeRelayFrame, isRelayFrame, monotonicNs, nsToWire, validateEnvelope } from '../shared/protocol.ts';
import { OVERLAY_DEFINITIONS, REQUESTABLE_OVERLAY_TYPES } from '../shared/overlays.ts';
import { listPlatforms } from '../shared/destinations.ts';

export class SignalingServer {

  // --- state (typed loosely while the class is migrated) ---
  _heartbeat: any;
  config: any;
  logger: any;
  registry: any;
  roomClients: any;
  /** The newest picture from each source, per room, so a newcomer sees the room. */
  relayFrames: any;
  sessions: any;
  wss: any;
  mailer: any;
  recordingStore: any;
  constructor({
    server,
    registry,
    config,
    logger = console,
    path = '/ws',
    mailer = null,
    recordingStore = null,
  }: any = {}) {
    this.registry = registry;
    this.config = config;
    this.logger = logger;
    this.mailer = mailer;
    this.recordingStore = recordingStore;
    this.sessions = new Map();
    this.roomClients = new Map();
    // The newest picture from each source, per room, for whoever joins next.
    this.relayFrames = new Map();

    this.wss = new WebSocketServer({ server, path, maxPayload: config.maxChunkBytes });
    this.wss.on('connection', (socket, request) => this._onConnection(socket, request));
    this.wss.on('error', (error) => this.logger.error?.(`websocket server error: ${error.message}`));
  }

  get clientCount() {
    return this.sessions.size;
  }

  _onConnection(socket, request) {
    const session = {
      id: randomUUID(),
      socket,
      roomId: null,
      name: 'Guest',
      role: 'viewer',
      studio: null,
      attendedRoomId: null,
      breakoutId: null,
      remote: request?.socket?.remoteAddress || null,
      chunks: 0,
    };
    this.sessions.set(session.id, session);
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this._onBinary(session, data);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(data.toString('utf8'));
      } catch {
        this._send(session, { type: SERVER.ERROR, message: 'messages must be JSON' });
        return;
      }
      this._handle(session, parsed).catch((error) => {
        this.logger.error?.(`signalling error: ${error.stack || error.message}`);
        this._send(session, {
          type: SERVER.ERROR,
          id: parsed?.id,
          message: error.message || 'internal error',
        });
      });
    });

    socket.on('close', () => this._onClose(session));
    socket.on('error', (error) => {
      this.logger.warn?.(`websocket error for ${session.id}: ${error.message}`);
    });

    this._send(session, {
      type: SERVER.WELCOME,
      protocolVersion: PROTOCOL_VERSION,
      clientId: session.id,
      sceneTypes: REQUESTABLE_OVERLAY_TYPES,
      overlayDefinitions: OVERLAY_DEFINITIONS,
      platforms: listPlatforms(),
      // STUN/TURN, so the meeting mesh can cross networks instead of only working
      // between devices that can reach each other directly.
      iceServers: this.config.iceServers || [],
      // Whether the host password can be mailed from here.
      mail: { enabled: Boolean(this.mailer?.enabled), from: this.mailer?.from || null },
    });
  }

  _onClose(session) {
    this.sessions.delete(session.id);
    const studio = session.studio;
    if (!studio) return;
    this._dropFromRoom(session);
    studio.leave(session.id);
  }

  /** Remove a session from whichever room it is currently attending. */
  _dropFromRoom(session) {
    const roomId = session.attendedRoomId || session.studio?.id;
    if (!roomId) return;
    const clients = this.roomClients.get(roomId);
    if (!clients) return;
    clients.delete(session.id);
    if (clients.size === 0) this.roomClients.delete(roomId);
  }

  /**
   * Bind a room's events to the wire.
   *
   * A parent room broadcasts its studio state and its roster to the whole tree
   * (itself plus every breakout room); a breakout room only carries its own
   * chat, because the parent still owns the program and the roster.
   */
  _attachRoom(studio) {
    if (studio.__quandriteBound) return;
    studio.__quandriteBound = true;
    const emit = (type, payload) => this._broadcast(studio.id, { type, payload });

    /**
     * A chat message, delivered to whoever it is for.
     *
     * A private message goes to exactly two people - the one who sent it and the one it
     * is for - and to nobody else, which is why the delivery is decided here rather than
     * in a broadcast. Everything else is the room's conversation.
     */
    const chat = (message) => {
      if (message?.to) {
        for (const memberId of [message.authorId, message.to]) {
          const target = this.sessions.get(memberId);
          if (target && target.studio === studio) {
            this._send(target, { type: SERVER.CHAT_NEW, payload: message });
          }
        }
        return;
      }
      emit(SERVER.CHAT_NEW, message);
    };

    if (studio.isBreakout) {
      // A breakout is a room of its own: its chat, and its **own primary screen**. What
      // happens here is broadcast here and nowhere else - the parent's program is a
      // separate thing, and it keeps travelling to everyone as `sources:update` and
      // friends.
      studio.on('chat', chat);
      studio.on('sources', (sources) => emit(SERVER.BREAKOUT_SOURCES, sources));
      studio.on('program', (program) => emit(SERVER.BREAKOUT_PROGRAM, program));
      studio.on('scene', (scene) => emit(SERVER.BREAKOUT_SCENE, scene));
      return;
    }

    const tree = (type, payload) => this._broadcastTree(studio.id, { type, payload });
    studio.on('chat', chat);
    studio.on('members', (members) => tree(SERVER.MEMBERS_UPDATE, members));
    studio.on('breakouts', (state) => {
      tree(SERVER.BREAKOUTS_UPDATE, state);
      // Opening, closing, reassigning or the timer expiring all land here, so
      // this is where attendees are moved between rooms.
      this._syncBreakoutSessions(studio);
    });
    studio.on('sources', (sources) => tree(SERVER.SOURCES_UPDATE, sources));
    studio.on('program', (program) => tree(SERVER.PROGRAM_UPDATE, program));
    studio.on('scene', (scene) => tree(SERVER.SCENE_UPDATE, scene));
    studio.on('destinations', (destinations) => tree(SERVER.DESTINATIONS_UPDATE, destinations));
    studio.on('stream', (stream) => tree(SERVER.STREAM_UPDATE, stream));
    studio.on('recording', (recording) => {
      tree(SERVER.RECORDING_UPDATE, recording);
      // The library is pushed as soon as a recording is finished, so the tab
      // never needs a refresh.
      if (recording?.status === 'ready' || recording?.status === 'error') {
        this.broadcastRecordings(studio.id).catch(() => {});
      }
    });
    studio.on('log', (entry) => tree(SERVER.RELAY_LOG, entry));
  }

  /** Send to a parent room and every breakout room it owns. */
  _broadcastTree(roomId, message) {
    this._broadcast(roomId, message);
    const studio = this.registry.get(roomId);
    if (!studio) return;
    for (const breakout of studio.breakouts.values()) this._broadcast(breakout.id, message);
  }

  /** Push a room's recording library so the Library tab is always current. */
  async broadcastRecordings(roomId) {
    if (!this.recordingStore) return;
    await this.recordingStore.load();
    const recordings = this.recordingStore
      .list({ roomId })
      .map((entry) => this.recordingStore.toPublic(entry));
    this._broadcastTree(roomId, { type: SERVER.RECORDINGS_UPDATE, payload: { roomId, recordings } });
  }

  // --------------------------------------------------------------- breakouts

  /** Attach the chat of every breakout room the parent owns. */
  _attachBreakouts(studio) {
    for (const breakout of studio.breakouts.values()) {
      const room = this.registry.get(breakout.id);
      if (room) this._attachRoom(room);
    }
  }

  /**
   * The room a session should be in: the breakout its member walked into, or the main
   * room. The assignment the host made is a suggestion shown in the picker - it does not
   * move anybody, which is what makes choosing a room the participant's own decision.
   */
  _desiredRoomId(session) {
    const studio = session.studio;
    if (!studio) return null;
    const member = studio.getMember(session.id);
    const breakout = member?.breakoutId ? studio.breakouts.get(member.breakoutId) : null;
    return breakout?.open ? breakout.id : studio.id;
  }

  /**
   * Move sessions between the main room and the breakouts.
   *
   * Called after any breakout change (create, assign, open, close, clear, timer)
   * so attendees follow their assignment without re-joining.
   */
  _syncBreakoutSessions(studio) {
    for (const session of this.sessions.values()) {
      if (session.studio !== studio) continue;
      const roomId = this._desiredRoomId(session);
      if (!roomId) continue;
      if ((session.attendedRoomId || studio.id) === roomId) continue;
      this._moveSession(session, roomId);
    }
  }

  /**
   * Move one session into `roomId` (the main room or a breakout) and hand it
   * everything it needs to carry on: the roster, the breakout catalogue, the
   * chat of the room it just walked into and the studio state.
   */
  _moveSession(session, roomId) {
    const studio = session.studio;
    this._dropFromRoom(session);
    if (!this.roomClients.has(roomId)) this.roomClients.set(roomId, new Set());
    this.roomClients.get(roomId).add(session.id);

    const target = roomId === studio.id ? studio : this.registry.get(roomId);
    if (target && target !== studio) this._attachRoom(target);
    const previousRoomId = session.attendedRoomId;
    session.attendedRoomId = roomId;
    session.breakoutId = roomId === studio.id ? null : roomId;

    const chatRoom = target || studio;
    // A breakout has a roster of its own, so the people standing in it can publish into
    // it - that is what gives the room its own screen. A plain `viewer` role is claimed:
    // what somebody may do in the *broadcast* is decided by the parent's roster, and
    // nobody should be asked for a password to walk into a breakout.
    const previous = previousRoomId && previousRoomId !== roomId ? this.registry.get(previousRoomId) : null;
    // Walking out of a breakout takes you off that room's roster - and its screen with
    // it. The parent is never left: the session is still in the room.
    if (previous && previous !== studio) previous.leave?.(session.id);
    if (chatRoom !== studio) chatRoom.join({ clientId: session.id, name: session.name, role: 'viewer' });

    this._send(session, {
      type: SERVER.BREAKOUT_UPDATE,
      payload: {
        breakoutId: session.breakoutId,
        breakouts: studio.breakoutsSnapshot(),
        members: studio.membersSnapshot(),
        // The studio state always comes from the parent; the chat comes from
        // the room the session just walked into.
        state: { ...studio.snapshot(), chat: chatRoom.chat.slice(-100) },
        // ...and the room's own primary screen, so the stage is right immediately.
        roomState: {
          sources: chatRoom.sourcesSnapshot?.() ?? [],
          program: chatRoom.programSnapshot?.() ?? null,
          scene: chatRoom.sceneSnapshot?.() ?? null,
        },
      },
    });
  }

  _broadcast(roomId, message) {
    const clients = this.roomClients.get(roomId);
    if (!clients) return;
    const payload = JSON.stringify(message);
    for (const clientId of clients) {
      const session = this.sessions.get(clientId);
      if (session?.socket?.readyState === 1) session.socket.send(payload);
    }
  }

  _send(session, message) {
    if (session.socket.readyState !== 1) return;
    session.socket.send(JSON.stringify(message));
  }

  _ack(session, id, result) {
    if (!id) return;
    this._send(session, { type: SERVER.ACK, id, ok: true, result });
  }

  _fail(session, id, message) {
    this._send(session, { type: SERVER.ERROR, id, message });
  }

  _requireRoom(session, id) {
    if (!session.studio) {
      this._fail(session, id, 'join a room first');
      return false;
    }
    return true;
  }

  _requireControl(session, id) {
    // Always trust the studio's copy of the role: the host can grant or revoke
    // co-host mid-session, so the session's snapshot of it goes stale.
    const role = session.studio?.getMember(session.id)?.role ?? session.role;
    if (!canControlBroadcast(role)) {
      this._fail(session, id, 'only the host or a co-host can control the broadcast');
      return false;
    }
    return true;
  }

  _requireHost(session, id) {
    if (!session.studio?.isHost(session.id)) {
      this._fail(session, id, 'only the host can do that');
      return false;
    }
    return true;
  }

  /**
   * The room a session's media, chat and screen belong to: its breakout, or the parent.
   *
   * A breakout is a real room - its own chat, its own sources, its own program - so
   * everything a session does with the room it is standing in goes here. What stays with
   * the parent is the *broadcast*: the picture that goes to the platforms, which a host
   * runs from wherever they are.
   */
  _roomFor(session) {
    if (!session.breakoutId) return session.studio;
    const room = this.registry.get(session.breakoutId);
    if (!room) return session.studio;
    this._attachRoom(room);
    return room;
  }

  /** The same question, asked without an error: may this session drive that screen? */
  _hasControl(session) {
    const role = session.studio?.getMember(session.id)?.role ?? session.role;
    return canControlBroadcast(role);
  }

  /**
   * May this session set the program of `room`?
   *
   * The broadcast is the host's and the co-hosts'. A **breakout's** screen is a shared
   * table instead: anybody in the room may put *their own* sources on it - that is what
   * "share your screen with this group" means - and only a host or co-host may move
   * anybody else's.
   */
  _mayDriveProgram(session, room, message) {
    if (room === session.studio) return this._hasControl(session);
    if (this._hasControl(session)) return true;
    const ids = [message.sourceId, ...(Array.isArray(message.gridIds) ? message.gridIds : [])].filter(Boolean);
    // A bare mode change is not "share my screen": it is a decision about the room, so
    // it needs control.
    if (!ids.length) return false;
    return ids.every((id) => room.sources.get(id)?.ownerId === session.id);
  }

  async _handleJoin(session, message, id) {
    const roomId = String(message.roomId || '').trim().toLowerCase();
    if (!roomId) return this._fail(session, id, 'roomId is required');

    const studio = this.registry.get(roomId, {
      createIfMissing: true,
      name: message.roomName,
      hostName: message.name,
    });
    if (!studio) return this._fail(session, id, `room ${roomId} is not available`);
    if (studio.isBreakout) {
      return this._fail(session, id, 'breakout rooms are entered from their parent room');
    }

    // Claim the seat before joining the room so a wrong password changes nothing.
    const existing = studio.getMember(session.id);
    const claim = existing
      ? studio.claimRole(session.id, { role: message.role, password: message.password })
      : studio.resolveRole({
          role: message.role,
          password: message.password,
          isFirst: studio.members.size === 0 && !studio.hostId,
        });
    if (!claim.ok) return this._fail(session, id, claim.error);

    if (session.studio && session.studio !== studio) {
      this._dropFromRoom(session);
      session.studio.leave(session.id);
    }

    this._attachRoom(studio);
    if (!this.roomClients.has(studio.id)) this.roomClients.set(studio.id, new Set());
    this.roomClients.get(studio.id).add(session.id);
    session.attendedRoomId = studio.id;
    session.breakoutId = null;

    const member = existing
      ? studio.getMember(session.id)
      : studio.join({
          clientId: session.id,
          name: message.name,
          role: message.role,
          password: message.password,
        });
    session.studio = studio;
    session.roomId = studio.id;
    session.role = member.role;
    session.name = member.name;

    this._ack(session, id, {
      roomId: studio.id,
      clientId: session.id,
      name: member.name,
      role: member.role,
      // Only the host may see the passwords, so they can share them.
      credentials: studio.isHost(session.id) ? studio.credentialsSnapshot() : null,
      snapshot: studio.snapshot(),
    });

    // A member who reconnects into an open breakout room goes back there.
    this._syncBreakoutSessions(studio);
    // Whatever the room is already showing, hand it over now: a newcomer should
    // open onto the room, not onto empty tiles waiting for the next frame.
    this._sendWarmFrames(session, session.attendedRoomId || studio.id);
    // Private conversations are mine: nobody else is sent them, and a reload should not
    // lose one.
    this._send(session, {
      type: SERVER.CHAT_HISTORY,
      payload: { threads: studio.privateThreadsFor(session.id) },
    });
    return undefined;
  }

  /**
   * Accept a chat picture only if this server stored it for this room.
   *
   * A message carries a URL rather than the picture itself, and a URL from a client is
   * never trusted: it has to be one of ours (`/uploads/<room>-<random>.<ext>`), the file
   * has to exist, and it has to be a picture of a sane size. That keeps a message from
   * pointing at somebody else's server - a tracking pixel in a chat room is not a
   * feature - and keeps the room's storage to what the room actually sent.
   */
  _acceptAttachment(session, attachment) {
    if (!attachment || typeof attachment !== 'object') return null;
    const studio = session.studio;
    if (!studio || !this.config?.uploadsDir) return null;
    const url = String(attachment.url || '');
    const prefix = `/uploads/${studio.id}-`;
    if (!url.startsWith(prefix)) return null;
    // Rebuild from the file name: nothing a client sends can walk out of the directory.
    const file = path.basename(url.slice(prefix.length));
    if (!file || file !== url.slice(prefix.length)) return null;
    const full = path.join(this.config.uploadsDir, `${studio.id}-${file}`);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CHAT_ATTACHMENT_BYTES) return null;
    const mime = String(attachment.mime || '');
    if (!CHAT_ATTACHMENT_TYPES.includes(mime)) return null;
    return {
      url: `/uploads/${studio.id}-${file}`,
      name: String(attachment.name || 'picture').replace(/[\r\n\t]/g, ' ').slice(0, 80),
      mime,
      bytes: stat.size,
      width: Math.max(0, Math.min(20000, Number(attachment.width) || 0)),
      height: Math.max(0, Math.min(20000, Number(attachment.height) || 0)),
    };
  }

  /** Binary frames are either the program feed or a relayed picture. */
  _onBinary(session, data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (isRelayFrame(buffer)) {
      this._onRelayFrame(session, buffer);
      return;
    }
    this._onProgramChunk(session, buffer);
  }

  /**
   * A camera, screen or microphone feed relayed over the socket.
   *
   * Peer-to-peer is always tried first; when two networks will not let the
   * browsers reach each other (strict NAT, corporate Wi-Fi, mobile data), the
   * room still has to see and hear the room - so the sender posts low-rate JPEG
   * pictures and 20 ms slices of PCM here and the server fans them out.
   *
   * Pictures and voice get separate budgets: voice is small but needs a steady
   * 50 frames a second, while pictures are big and are deliberately thinned out.
   */
  _onRelayFrame(session, buffer) {
    const studio = session.studio;
    if (!studio) return;
    // Stamp the frame with the server's own clock before anything else, so the
    // room can tell the two hops apart in nanoseconds: how long it took to get
    // here, and how long it takes to get out again.
    const arrivedNs = monotonicNs();
    const decoded = decodeRelayFrame(buffer);
    if (!decoded) return;

    // A relay is a fallback, not a second full-quality feed. Pictures get a hard
    // interval; voice gets a small burst allowance, because browser audio
    // callbacks jitter and a dropped slice is a click in someone's ear.
    const now = Date.now();
    const isAudio = decoded.header?.kind === 'audio';
    if (isAudio) {
      const bucket = session.relayAudioTokens || (session.relayAudioTokens = { tokens: RELAY_AUDIO_BURST, at: now });
      bucket.tokens = Math.min(
        RELAY_AUDIO_BURST,
        bucket.tokens + ((now - bucket.at) / 1000) * RELAY_AUDIO_MAX_FPS,
      );
      bucket.at = now;
      if (bucket.tokens < 1) return;
      bucket.tokens -= 1;
    } else {
      if (now - (session.lastRelayAt || 0) < 1000 / RELAY_MAX_FPS) return;
      session.lastRelayAt = now;
    }

    const frame = encodeRelayFrame(
      { ...decoded.header, from: session.id, fromName: session.name, srv: nsToWire(arrivedNs) },
      decoded.payload,
    );
    const roomId = session.attendedRoomId || studio.id;
    this._rememberRelayFrame(roomId, decoded.header, frame);
    for (const clientId of this.roomClients.get(roomId) || []) {
      if (clientId === session.id) continue;
      const target = this.sessions.get(clientId);
      if (target?.socket?.readyState === 1) target.socket.send(frame);
    }
  }

  /**
   * Keep the newest picture from each source, so somebody joining a live room does
   * not stare at an empty tile until the next frame happens to arrive.
   */
  _rememberRelayFrame(roomId, header, frame) {
    if (!roomId) return;
    const cache = this.relayFrames.get(roomId) || new Map();
    this.relayFrames.set(roomId, cache);
    cache.set(header?.sourceId || `peer:${header?.from}`, { frame, at: Date.now() });
    while (cache.size > RELAY_WARM_FRAMES) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, entry] of cache) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      cache.delete(oldestKey);
    }
  }

  /** Hand a newcomer the room as it is, not as it will be in a moment. */
  _sendWarmFrames(session, roomId) {
    const cache = this.relayFrames.get(roomId);
    if (!cache || session.socket?.readyState !== 1) return 0;
    const now = Date.now();
    let sent = 0;
    for (const entry of cache.values()) {
      if (now - entry.at > RELAY_WARM_MAX_AGE_MS) continue;
      const decoded = decodeRelayFrame(entry.frame);
      if (!decoded) continue;
      // Marked as a still: it is older than the live rule allows, and that is the
      // point - it is what the room looked like a moment ago.
      const warm = encodeRelayFrame({ ...decoded.header, warm: true }, decoded.payload);
      session.socket.send(warm);
      sent += 1;
    }
    return sent;
  }

  /** Binary frames are the program feed produced by the host compositor. */
  _onProgramChunk(session, data) {
    const studio = session.studio;
    if (!studio) return;
    if (!studio.isPublisher(session.id)) {
      if (!session.publisherWarned) {
        session.publisherWarned = true;
        this._fail(session, null, 'you are not the active publisher for this broadcast');
      }
      return;
    }

    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const ok = studio.writeProgramChunk(session.id, chunk);
    session.chunks += 1;

    if (!ok && studio.relay) {
      const relay = studio.relay;
      session.socket.pause();
      relay.whenDrained().then(() => {
        if (session.socket.readyState === 1) session.socket.resume();
      });
    }
  }

  startHeartbeat(intervalMs = 30000) {
    this._heartbeat = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (session.socket.isAlive === false) {
          session.socket.terminate();
          continue;
        }
        session.socket.isAlive = false;
        try {
          session.socket.ping();
        } catch {
          // socket already gone
        }
      }
    }, intervalMs);
    if (typeof this._heartbeat.unref === 'function') this._heartbeat.unref();
    return this._heartbeat;
  }

  async close() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
    for (const session of this.sessions.values()) {
      try {
        session.socket.close(1001, 'server shutting down');
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
    this.roomClients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  async _handle(session, raw) {
    const envelope = validateEnvelope(raw);
    if (!envelope.ok) {
      this._fail(session, raw?.id, envelope.error);
      return;
    }
    const message = envelope.value;
    const id = message.id;

    switch (message.type) {
      case CLIENT.JOIN:
        return this._handleJoin(session, message, id);
      case CLIENT.LEAVE: {
        if (session.studio) {
          this._dropFromRoom(session);
          session.studio.leave(session.id);
        }
        session.studio = null;
        session.roomId = null;
        session.attendedRoomId = null;
        session.breakoutId = null;
        this._ack(session, id, { left: true });
        return undefined;
      }
      case CLIENT.PING:
        this._send(session, { type: SERVER.PONG, at: Date.now(), id });
        return undefined;
      /**
       * The clock exchange behind the relay's nanosecond stamps.
       *
       * The reply carries the server's monotonic clock twice - on receipt and on
       * send - so the client can subtract half the round trip and know its offset.
       * Answered before anything else, because the round trip is the error bound.
       */
      case CLIENT.TIME_SYNC: {
        const onReceipt = monotonicNs();
        this._send(session, {
          type: SERVER.TIME_SYNC,
          id,
          t1: nsToWire(onReceipt),
          t2: nsToWire(monotonicNs()),
        });
        return undefined;
      }
      case CLIENT.CHAT_SEND: {
        if (!this._requireRoom(session, id)) return undefined;
        // Chat belongs to the room the session is actually in: a breakout has
        // its own conversation.
        const room = this._roomFor(session);
        // A private message has to have somebody to be private *with*: the target must
        // be in the same room, and it cannot be me.
        const to = message.to ? String(message.to) : null;
        if (to) {
          if (to === session.id) return this._fail(session, id, 'that is you');
          if (!room.members.has(to)) return this._fail(session, id, 'that person is not in this room');
        }
        // A picture has to be one this server stored for this room: a chat message can
        // never point somewhere else.
        const attachment = this._acceptAttachment(session, message.attachment);
        if (message.attachment && !attachment) return this._fail(session, id, 'that picture is not available');

        // A private thread belongs to the room, not to a breakout: a conversation should
        // still be there after coming back from one.
        const posted = (to ? session.studio : room).addChat({
          authorId: session.id,
          authorName: session.name,
          text: message.text,
          to,
          attachment,
        });
        if (!posted) return this._fail(session, id, 'message is empty');
        this._ack(session, id, { chatId: posted.id });
        return undefined;
      }
      case CLIENT.BREAKOUT_CREATE: {
        if (!this._requireRoom(session, id)) return undefined;
        if (!this._requireControl(session, id)) return undefined;
        const result = session.studio.createBreakouts({
          count: message.count,
          labels: Array.isArray(message.labels) ? message.labels : [],
          assignments: message.assignments || null,
        });
        if (!result.ok) return this._fail(session, id, result.error);
        this._attachBreakouts(session.studio);
        this._syncBreakoutSessions(session.studio);
        this._ack(session, id, { breakouts: result.breakouts });
        return undefined;
      }
      case CLIENT.BREAKOUT_ASSIGN: {
        if (!this._requireRoom(session, id)) return undefined;
        const memberId = message.memberId || session.id;
        const movingSelf = memberId === session.id;
        if (movingSelf) {
          // Anyone may join the breakout they are assigned to, or come home.
          const breakoutId = message.breakoutId ?? null;
          if (breakoutId && !session.studio.breakouts.get(breakoutId)?.open) {
            return this._fail(session, id, 'that breakout room is not open yet');
          }
        } else if (!this._requireControl(session, id)) {
          return undefined;
        }

        const result = session.studio.assignBreakout(memberId, message.breakoutId ?? null);
        if (!result.ok) return this._fail(session, id, result.error);
        this._syncBreakoutSessions(session.studio);
        this._ack(session, id, { member: result.member, breakouts: session.studio.breakoutsSnapshot() });
        return undefined;
      }
      case CLIENT.BREAKOUT_RENAME: {
        if (!this._requireRoom(session, id)) return undefined;
        if (!this._requireControl(session, id)) return undefined;
        const result = session.studio.renameBreakout(message.breakoutId, message.label);
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { breakouts: result.breakouts });
        return undefined;
      }
      case CLIENT.BREAKOUT_SHUFFLE: {
        if (!this._requireRoom(session, id)) return undefined;
        if (!this._requireControl(session, id)) return undefined;
        const result = session.studio.autoAssignBreakouts(message.assignments || null);
        if (!result.ok) return this._fail(session, id, result.error);
        this._syncBreakoutSessions(session.studio);
        this._ack(session, id, { breakouts: result.breakouts });
        return undefined;
      }
      case CLIENT.BREAKOUT_OPEN: {
        if (!this._requireRoom(session, id)) return undefined;
        if (!this._requireControl(session, id)) return undefined;
        const result = session.studio.setBreakoutsOpen(true, {
          breakoutId: message.breakoutId || null,
          durationMs: Number(message.durationMs) || 0,
        });
        if (!result.ok) return this._fail(session, id, result.error);
        this._attachBreakouts(session.studio);
        // Opening the rooms does *not* move anybody: the assignment the host made is a
        // suggestion, and walking into a room is the participant's own choice - they are
        // told the rooms are open and pick one from the Rooms button. A host who wants
        // somebody in a particular room moves them from the roster, which does move them.
        this._ack(session, id, { breakouts: result.breakouts });
        return undefined;
      }
      case CLIENT.BREAKOUT_CLOSE: {
        if (!this._requireRoom(session, id)) return undefined;
        if (!this._requireControl(session, id)) return undefined;
        const result = session.studio.setBreakoutsOpen(false, { breakoutId: message.breakoutId || null });
        if (!result.ok) return this._fail(session, id, result.error);
        this._syncBreakoutSessions(session.studio);
        this._ack(session, id, { breakouts: result.breakouts });
        return undefined;
      }
      case CLIENT.BREAKOUT_CLEAR: {
        if (!this._requireRoom(session, id)) return undefined;
        if (!this._requireControl(session, id)) return undefined;
        const result = await session.studio.clearBreakouts();
        this._syncBreakoutSessions(session.studio);
        this._ack(session, id, { breakouts: session.studio.breakoutsSnapshot(), removed: result.removed });
        return undefined;
      }
      case CLIENT.BREAKOUT_ANNOUNCE: {
        if (!this._requireRoom(session, id)) return undefined;
        if (!this._requireControl(session, id)) return undefined;
        const text = String(message.text ?? '').trim();
        if (!text) return this._fail(session, id, 'the announcement is empty');

        const studio = session.studio;
        const rooms = [studio, ...[...studio.breakouts.keys()].map((id) => this.registry.get(id)).filter(Boolean)];
        let delivered = 0;
        for (const room of rooms) {
          const posted = room.addChat({
            authorId: 'system',
            authorName: session.name,
            kind: 'system',
            text: `Announcement: ${text}`,
          });
          if (posted) delivered += 1;
        }
        this._ack(session, id, { delivered });
        return undefined;
      }
      case CLIENT.MEMBER_UPDATE: {
        if (!this._requireRoom(session, id)) return undefined;
        session.studio.updateMember(session.id, message.patch || {});
        this._ack(session, id, { updated: true });
        return undefined;
      }
      case CLIENT.MEMBER_ROLE: {
        if (!this._requireRoom(session, id)) return undefined;
        if (!this._requireHost(session, id)) return undefined;
        const result = session.studio.setMemberRole(session.id, message.memberId, message.role);
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { member: result.member });
        return undefined;
      }
      case CLIENT.ROOM_UPDATE: {
        if (!this._requireRoom(session, id)) return undefined;
        if (!this._requireHost(session, id)) return undefined;
        const result = session.studio.updateCredentials(session.id, {
          hostPassword: message.hostPassword,
          cohostPassword: message.cohostPassword,
        });
        if (!result.ok) return this._fail(session, id, result.errors?.join('; ') || result.error);
        this._ack(session, id, { credentials: result.credentials });
        return undefined;
      }
      case CLIENT.MEMBER_MEDIA: {
        if (!this._requireRoom(session, id)) return undefined;
        if (!this._requireControl(session, id)) return undefined;
        const patch: any = {};
        if (message.muted !== undefined) patch.muted = Boolean(message.muted);
        if (message.cameraEnabled !== undefined) patch.cameraEnabled = Boolean(message.cameraEnabled);
        if (!Object.keys(patch).length) return this._fail(session, id, 'nothing to change');

        // `all: true` is one message for "mute everyone" / "stop every video".
        const targets = message.all
          ? [...session.studio.members.keys()].filter((memberId) => memberId !== session.id)
          : [message.memberId];
        if (!targets.length || !targets[0]) return this._fail(session, id, 'memberId is required');

        let changed = 0;
        for (const memberId of targets) {
          const member = session.studio.updateMember(memberId, patch);
          if (!member) continue;
          changed += 1;
          // A mute of one person is a decision about them, and it holds if they come
          // back. A sweep ("mute all") is not: it says nothing about any one person.
          if (!message.all && patch.muted !== undefined) {
            session.studio.rememberMute(memberId, patch.muted);
          }
          // Tell the member's own client so it really turns the track off.
          const target = this.sessions.get(memberId);
          if (target && target.studio === session.studio) {
            this._send(target, { type: SERVER.MEMBER_MEDIA, byName: session.name, ...patch });
          }
        }
        if (!changed) return this._fail(session, id, 'member not found');
        this._ack(session, id, { changed });
        return undefined;
      }
      case CLIENT.SOURCE_ADD: {
        // Anyone may publish their own camera or screen; the program stays with
        // the host and co-hosts. It goes to the room the session is standing in, so a
        // screen shared inside a breakout belongs to that breakout.
        if (!this._requireRoom(session, id)) return undefined;
        const result = this._roomFor(session).addSource({ ...(message.source || {}), ownerId: session.id });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { source: result.source });
        return undefined;
      }
      case CLIENT.SOURCE_UPDATE: {
        if (!this._requireRoom(session, id)) return undefined;
        const result = this._roomFor(session).updateSource(message.sourceId, message.patch || {}, {
          byId: session.id,
        });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { source: result.source });
        return undefined;
      }
      case CLIENT.SOURCE_REMOVE: {
        if (!this._requireRoom(session, id)) return undefined;
        const result = this._roomFor(session).removeSource(message.sourceId, { byId: session.id });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { removed: message.sourceId });
        return undefined;
      }
      case CLIENT.PROGRAM_SET: {
        // The broadcast needs control; a breakout's own screen does not, as long as it is
        // your own source being put up (see `_mayDriveProgram`).
        if (!this._requireRoom(session, id)) return undefined;
        const room = this._roomFor(session);
        if (!this._mayDriveProgram(session, room, message)) {
          return this._fail(
            session,
            id,
            room === session.studio
              ? 'only the host or a co-host can control the broadcast'
              : 'in a breakout you can put your own screen up, but not somebody else\'s',
          );
        }
        const result = room.setProgram({
          mode: message.mode,
          sourceId: message.sourceId,
          gridIds: message.gridIds,
        });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { program: result.program });
        return undefined;
      }
      case CLIENT.SCENE_SET: {
        if (!this._requireControl(session, id)) return undefined;
        const result = session.studio.setScene({ ...(message.scene || {}), createdBy: session.id });
        if (!result.ok) return this._fail(session, id, result.errors.join('; '));
        this._ack(session, id, { scene: result.scene });
        return undefined;
      }
      case CLIENT.SCENE_CLEAR: {
        if (!this._requireControl(session, id)) return undefined;
        const result = session.studio.clearScene();
        this._ack(session, id, { cleared: result.cleared });
        return undefined;
      }
      case CLIENT.DESTINATION_ADD: {
        if (!this._requireControl(session, id)) return undefined;
        const result = session.studio.addDestination(message.destination || {});
        if (!result.ok) return this._fail(session, id, result.errors?.join('; ') || result.error);
        this._ack(session, id, { destination: result.destination });
        return undefined;
      }
      case CLIENT.DESTINATION_UPDATE: {
        if (!this._requireControl(session, id)) return undefined;
        const result = session.studio.updateDestination(message.destinationId, message.patch || {});
        if (!result.ok) return this._fail(session, id, result.errors?.join('; ') || result.error);
        this._ack(session, id, { destination: result.destination });
        return undefined;
      }
      case CLIENT.DESTINATION_REMOVE: {
        if (!this._requireControl(session, id)) return undefined;
        const result = session.studio.removeDestination(message.destinationId);
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { removed: message.destinationId });
        return undefined;
      }
      case CLIENT.STREAM_START: {
        if (!this._requireControl(session, id)) return undefined;
        const result = await session.studio.startStream({
          preset: message.preset,
          record: Boolean(message.record),
          byId: session.id,
        });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { stream: result.stream });
        return undefined;
      }
      case CLIENT.STREAM_STOP: {
        if (!this._requireControl(session, id)) return undefined;
        const result = await session.studio.stopStream({ byId: session.id });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { stream: result.stream });
        return undefined;
      }
      case CLIENT.RECORD_START: {
        if (!this._requireControl(session, id)) return undefined;
        if (session.studio.relay) {
          return this._fail(session, id, 'a broadcast is already running - stop it before recording again');
        }
        const result = await session.studio.startStream({ record: true, byId: session.id });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { stream: result.stream });
        return undefined;
      }
      case CLIENT.RECORD_STOP: {
        if (!this._requireControl(session, id)) return undefined;
        const result = await session.studio.stopStream({ byId: session.id, reason: 'recording-stop' });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { stream: result.stream });
        return undefined;
      }
      case CLIENT.WEBRTC_SIGNAL: {
        if (!this._requireRoom(session, id)) return undefined;
        const target = this.sessions.get(message.to);
        if (!target || target.studio !== session.studio) {
          return this._fail(session, id, 'peer is not in this room');
        }
        this._send(target, {
          type: SERVER.WEBRTC_SIGNAL,
          from: session.id,
          fromName: session.name,
          data: message.data,
        });
        this._ack(session, id, { delivered: true });
        return undefined;
      }
      default:
        this._fail(session, id, `unhandled message type: ${message.type}`);
        return undefined;
    }
  }
}

export default SignalingServer;
