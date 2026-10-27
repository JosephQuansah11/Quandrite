/**
 * Quandrite wire protocol.
 *
 * Shared by the browser client (`/shared/protocol.js`) and the Node server
 * (`server/signaling.js`) so that both sides agree on message names, roles and
 * scene vocabulary. This module is intentionally dependency free.
 */

export const PROTOCOL_VERSION = 1;

/** Message types a client may send to the server. */
export const CLIENT = Object.freeze({
  JOIN: 'join',
  LEAVE: 'leave',
  PING: 'ping',
  CHAT_SEND: 'chat:send',
  MEMBER_UPDATE: 'member:update',
  SOURCE_ADD: 'source:add',
  SOURCE_UPDATE: 'source:update',
  SOURCE_REMOVE: 'source:remove',
  PROGRAM_SET: 'program:set',
  SCENE_SET: 'scene:set',
  SCENE_CLEAR: 'scene:clear',
  DESTINATION_ADD: 'destination:add',
  DESTINATION_UPDATE: 'destination:update',
  DESTINATION_REMOVE: 'destination:remove',
  STREAM_START: 'stream:start',
  STREAM_STOP: 'stream:stop',
  RECORD_START: 'record:start',
  RECORD_STOP: 'record:stop',
  WEBRTC_SIGNAL: 'webrtc:signal',
});

/** Message types the server may send to a client. */
export const SERVER = Object.freeze({
  WELCOME: 'welcome',
  ACK: 'ack',
  ERROR: 'error',
  PONG: 'pong',
  CHAT_NEW: 'chat:new',
  CHAT_HISTORY: 'chat:history',
  MEMBERS_UPDATE: 'members:update',
  SOURCES_UPDATE: 'sources:update',
  PROGRAM_UPDATE: 'program:update',
  SCENE_UPDATE: 'scene:update',
  DESTINATIONS_UPDATE: 'destinations:update',
  STREAM_UPDATE: 'stream:update',
  RECORDING_UPDATE: 'recording:update',
  WEBRTC_SIGNAL: 'webrtc:signal',
  RELAY_LOG: 'relay:log',
});

/** Overlay / scene types that can be pushed onto the livestream preview. */
export const SCENE_TYPES = Object.freeze([
  'idle',
  'title',
  'announcement',
  'screenshare',
  'song',
  'break',
  'ended',
]);

/** Scene types a host can explicitly request (everything except the neutral state). */
export const REQUESTABLE_SCENE_TYPES = Object.freeze(
  SCENE_TYPES.filter((type) => type !== 'idle'),
);

/** Kinds of media a participant can publish into the studio. */
export const SOURCE_KINDS = Object.freeze(['camera', 'screen', 'audio', 'virtual']);

/** Participant roles. `host` and `cohost` may drive the broadcast. */
export const ROLES = Object.freeze(['host', 'cohost', 'viewer']);

/** How the program (on-air) picture is composed. */
export const PROGRAM_MODES = Object.freeze(['single', 'grid', 'screenshare']);

/** Lifecycle of the outbound relay to the streaming platforms. */
export const STREAM_STATUSES = Object.freeze([
  'offline',
  'connecting',
  'live',
  'reconnecting',
  'stopping',
  'ended',
  'error',
]);

/** Lifecycle of the recording writer. */
export const RECORDING_STATUSES = Object.freeze(['idle', 'recording', 'processing', 'ready', 'error']);

/** Roles allowed to change what goes out on the air. */
export function canControlBroadcast(role) {
  return role === 'host' || role === 'cohost';
}

export function isRole(role) {
  return ROLES.includes(role);
}

export function isSceneType(type) {
  return SCENE_TYPES.includes(type);
}

export function isSourceKind(kind) {
  return SOURCE_KINDS.includes(kind);
}

/**
 * Validate an arbitrary value as a protocol message envelope.
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateEnvelope(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'message must be a JSON object' };
  }
  const { type } = raw;
  if (typeof type !== 'string' || type.length === 0) {
    return { ok: false, error: 'message.type must be a non-empty string' };
  }
  if (!Object.values(CLIENT).includes(type)) {
    return { ok: false, error: `unsupported message type: ${type}` };
  }
  return { ok: true, value: raw };
}
