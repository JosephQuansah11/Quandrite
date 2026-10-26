/**
 * WebSocket signalling.
 *
 * Carries chat, studio control (program/scene/destinations), WebRTC SDP and ICE
 * exchange for the meeting, and the binary program feed that the host's
 * compositor streams into the encoder.
 */

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { CLIENT, SERVER, PROTOCOL_VERSION, canControlBroadcast, validateEnvelope } from '../shared/protocol.js';
import { OVERLAY_DEFINITIONS, REQUESTABLE_OVERLAY_TYPES } from '../shared/overlays.js';
import { listPlatforms } from '../shared/destinations.js';

export class SignalingServer {
  constructor({ server, registry, config, logger = console, path = '/ws' } = {}) {
    this.registry = registry;
    this.config = config;
    this.logger = logger;
    this.sessions = new Map();
    this.roomClients = new Map();

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
        this._onProgramChunk(session, data);
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
    });
  }

  _onClose(session) {
    this.sessions.delete(session.id);
    const studio = session.studio;
    if (!studio) return;
    const clients = this.roomClients.get(studio.id);
    if (clients) {
      clients.delete(session.id);
      if (clients.size === 0) this.roomClients.delete(studio.id);
    }
    studio.leave(session.id);
  }

  _attachRoom(studio) {
    if (studio.__quandriteBound) return;
    studio.__quandriteBound = true;
    const emit = (type, payload) => this._broadcast(studio.id, { type, payload });
    studio.on('chat', (message) => emit(SERVER.CHAT_NEW, message));
    studio.on('members', (members) => emit(SERVER.MEMBERS_UPDATE, members));
    studio.on('sources', (sources) => emit(SERVER.SOURCES_UPDATE, sources));
    studio.on('program', (program) => emit(SERVER.PROGRAM_UPDATE, program));
    studio.on('scene', (scene) => emit(SERVER.SCENE_UPDATE, scene));
    studio.on('destinations', (destinations) => emit(SERVER.DESTINATIONS_UPDATE, destinations));
    studio.on('stream', (stream) => emit(SERVER.STREAM_UPDATE, stream));
    studio.on('recording', (recording) => emit(SERVER.RECORDING_UPDATE, recording));
    studio.on('log', (entry) => emit(SERVER.RELAY_LOG, entry));
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

  _requireRoom(session) {
    if (!session.studio) {
      this._fail(session, null, 'join a room first');
      return false;
    }
    return true;
  }

  _requireControl(session) {
    if (!canControlBroadcast(session.role)) {
      this._fail(session, null, 'only the host or a co-host can control the broadcast');
      return false;
    }
    return true;
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

    if (session.studio && session.studio !== studio) {
      this.roomClients.get(session.studio.id)?.delete(session.id);
      session.studio.leave(session.id);
    }

    this._attachRoom(studio);
    if (!this.roomClients.has(studio.id)) this.roomClients.set(studio.id, new Set());
    this.roomClients.get(studio.id).add(session.id);

    const member = studio.join({ clientId: session.id, name: message.name, role: message.role });
    session.studio = studio;
    session.roomId = studio.id;
    session.role = member.role;
    session.name = member.name;

    this._ack(session, id, {
      roomId: studio.id,
      clientId: session.id,
      name: member.name,
      role: member.role,
      snapshot: studio.snapshot(),
    });
    return undefined;
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
    await new Promise((resolve) => this.wss.close(() => resolve()));
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
          this.roomClients.get(session.studio.id)?.delete(session.id);
          session.studio.leave(session.id);
        }
        session.studio = null;
        session.roomId = null;
        this._ack(session, id, { left: true });
        return undefined;
      }
      case CLIENT.PING:
        this._send(session, { type: SERVER.PONG, at: Date.now(), id });
        return undefined;
      case CLIENT.CHAT_SEND: {
        if (!this._requireRoom(session)) return undefined;
        const posted = session.studio.addChat({
          authorId: session.id,
          authorName: session.name,
          text: message.text,
        });
        if (!posted) return this._fail(session, id, 'message is empty');
        this._ack(session, id, { chatId: posted.id });
        return undefined;
      }
      case CLIENT.MEMBER_UPDATE: {
        if (!this._requireRoom(session)) return undefined;
        session.studio.updateMember(session.id, message.patch || {});
        this._ack(session, id, { updated: true });
        return undefined;
      }
      case CLIENT.SOURCE_ADD: {
        if (!this._requireRoom(session)) return undefined;
        const result = session.studio.addSource({ ...(message.source || {}), ownerId: session.id });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { source: result.source });
        return undefined;
      }
      case CLIENT.SOURCE_UPDATE: {
        if (!this._requireRoom(session)) return undefined;
        const result = session.studio.updateSource(message.sourceId, message.patch || {}, {
          byId: session.id,
        });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { source: result.source });
        return undefined;
      }
      case CLIENT.SOURCE_REMOVE: {
        if (!this._requireRoom(session)) return undefined;
        const result = session.studio.removeSource(message.sourceId, { byId: session.id });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { removed: message.sourceId });
        return undefined;
      }
      case CLIENT.PROGRAM_SET: {
        if (!this._requireControl(session)) return undefined;
        const result = session.studio.setProgram({
          mode: message.mode,
          sourceId: message.sourceId,
          gridIds: message.gridIds,
        });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { program: result.program });
        return undefined;
      }
      case CLIENT.SCENE_SET: {
        if (!this._requireControl(session)) return undefined;
        const result = session.studio.setScene({ ...(message.scene || {}), createdBy: session.id });
        if (!result.ok) return this._fail(session, id, result.errors.join('; '));
        this._ack(session, id, { scene: result.scene });
        return undefined;
      }
      case CLIENT.SCENE_CLEAR: {
        if (!this._requireControl(session)) return undefined;
        const result = session.studio.clearScene();
        this._ack(session, id, { cleared: result.cleared });
        return undefined;
      }
      case CLIENT.DESTINATION_ADD: {
        if (!this._requireControl(session)) return undefined;
        const result = session.studio.addDestination(message.destination || {});
        if (!result.ok) return this._fail(session, id, result.errors?.join('; ') || result.error);
        this._ack(session, id, { destination: result.destination });
        return undefined;
      }
      case CLIENT.DESTINATION_UPDATE: {
        if (!this._requireControl(session)) return undefined;
        const result = session.studio.updateDestination(message.destinationId, message.patch || {});
        if (!result.ok) return this._fail(session, id, result.errors?.join('; ') || result.error);
        this._ack(session, id, { destination: result.destination });
        return undefined;
      }
      case CLIENT.DESTINATION_REMOVE: {
        if (!this._requireControl(session)) return undefined;
        const result = session.studio.removeDestination(message.destinationId);
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { removed: message.destinationId });
        return undefined;
      }
      case CLIENT.STREAM_START: {
        if (!this._requireControl(session)) return undefined;
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
        if (!this._requireControl(session)) return undefined;
        const result = await session.studio.stopStream({ byId: session.id });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { stream: result.stream });
        return undefined;
      }
      case CLIENT.RECORD_START: {
        if (!this._requireControl(session)) return undefined;
        if (session.studio.relay) {
          return this._fail(session, id, 'a broadcast is already running - stop it before recording again');
        }
        const result = await session.studio.startStream({ record: true, byId: session.id });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { stream: result.stream });
        return undefined;
      }
      case CLIENT.RECORD_STOP: {
        if (!this._requireControl(session)) return undefined;
        const result = await session.studio.stopStream({ byId: session.id, reason: 'recording-stop' });
        if (!result.ok) return this._fail(session, id, result.error);
        this._ack(session, id, { stream: result.stream });
        return undefined;
      }
      case CLIENT.WEBRTC_SIGNAL: {
        if (!this._requireRoom(session)) return undefined;
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
