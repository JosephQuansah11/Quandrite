/**
 * Quandrite wire protocol.
 *
 * Shared by the browser client (`/shared/protocol.js`) and the Node server
 * (`server/signaling.js`) so that both sides agree on message names, roles and
 * scene vocabulary. This module is intentionally dependency free.
 */

export const PROTOCOL_VERSION = 2;

/** Message types a client may send to the server. */
export const CLIENT = Object.freeze({
  JOIN: 'join',
  LEAVE: 'leave',
  PING: 'ping',
  CHAT_SEND: 'chat:send',
  MEMBER_UPDATE: 'member:update',
  MEMBER_ROLE: 'member:role',
  MEMBER_MEDIA: 'member:media',
  ROOM_UPDATE: 'room:update',
  BREAKOUT_CREATE: 'breakout:create',
  BREAKOUT_ASSIGN: 'breakout:assign',
  BREAKOUT_SHUFFLE: 'breakout:shuffle',
  BREAKOUT_OPEN: 'breakout:open',
  BREAKOUT_CLOSE: 'breakout:close',
  BREAKOUT_CLEAR: 'breakout:clear',
  BREAKOUT_ANNOUNCE: 'breakout:announce',
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
  MEMBER_MEDIA: 'member:media',
  BREAKOUTS_UPDATE: 'breakouts:update',
  BREAKOUT_UPDATE: 'breakout:update',
  SOURCES_UPDATE: 'sources:update',
  PROGRAM_UPDATE: 'program:update',
  SCENE_UPDATE: 'scene:update',
  DESTINATIONS_UPDATE: 'destinations:update',
  STREAM_UPDATE: 'stream:update',
  RECORDING_UPDATE: 'recording:update',
  RECORDINGS_UPDATE: 'recordings:update',
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

/**
 * What a member can ask the host to do with one of their own sources.
 * `grid` = "put me in the multi-camera grid", `air` = "put me on the program".
 */
export const SOURCE_REQUESTS = Object.freeze(['grid', 'air']);

/**
 * Participant roles.
 *
 * `host` and `cohost` may drive the broadcast (and see the host-only panes);
 * `viewer` and `visitor` are passive - they watch, chat and join the call.
 * A room has exactly one host at a time.
 */
export const ROLES = Object.freeze(['host', 'cohost', 'viewer', 'visitor']);

/** Roles that can only be claimed with a room password. */
export const PASSWORD_ROLES = Object.freeze(['host', 'cohost']);

/** Roles that never drive the broadcast and never see host-only panes. */
export const PASSIVE_ROLES = Object.freeze(['viewer', 'visitor']);

/** Length limits for room passwords. */
export const MIN_PASSWORD_LENGTH = 4;
export const MAX_PASSWORD_LENGTH = 64;

/** Most breakout rooms a room can be split into at once. */
export const MAX_BREAKOUTS = 8;

/** The location a member is in when they are not in a breakout room. */
export const MAIN_ROOM = 'main';

/** Compare two members' locations (`null`/undefined means the main room). */
export function inSameRoom(a, b) {
  return (a ?? null) === (b ?? null);
}

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

/** True when claiming `role` requires the matching room password. */
export function requiresPassword(role) {
  return PASSWORD_ROLES.includes(role);
}

/** True for the roles that only watch (viewer, visitor). */
export function isPassiveRole(role) {
  return PASSIVE_ROLES.includes(role);
}

/** Coerce anything unknown to the safest role. */
export function normalizeRole(role) {
  return isRole(role) ? role : 'viewer';
}

export function isPasswordValid(secret) {
  return typeof secret === 'string' && secret.length >= MIN_PASSWORD_LENGTH && secret.length <= MAX_PASSWORD_LENGTH;
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
  if (!(Object.values(CLIENT) as string[]).includes(type)) {
    return { ok: false, error: `unsupported message type: ${type}` };
  }
  return { ok: true, value: raw };
}

// ------------------------------------------------------------------ contracts

/** A role that may drive the broadcast. */
export type Role = (typeof ROLES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type SourceRequest = (typeof SOURCE_REQUESTS)[number];
export type ProgramMode = (typeof PROGRAM_MODES)[number];
export type SceneType = (typeof SCENE_TYPES)[number];

export interface Member {
  id: string;
  name: string;
  role: Role;
  joinedAt: number;
  muted: boolean;
  cameraEnabled: boolean;
  screenSharing: boolean;
  speaking: boolean;
  sourceIds: string[];
  /** The breakout room the member is assigned to, `null` for the main room. */
  breakoutId: string | null;
}

export interface Source {
  id: string;
  ownerId: string;
  ownerName: string;
  label: string;
  kind: SourceKind;
  deviceId: string | null;
  groupId: string | null;
  meta: Record<string, unknown>;
  active: boolean;
  /** What the owner asked the host to do with this source. */
  request: SourceRequest | null;
  addedAt: number;
  updatedAt: number;
}

export interface Program {
  mode: ProgramMode;
  sourceId: string | null;
  gridIds: string[];
  updatedAt: number;
  /** Ids actually on the air, in draw order (filled in by the snapshot). */
  onAir?: string[];
}

export interface Breakout {
  id: string;
  label: string;
  index: number;
  open: boolean;
  openedAt: number | null;
  memberIds: string[];
  memberCount: number;
}

export interface BreakoutCatalogue {
  available: boolean;
  max: number;
  active: boolean;
  startedAt: number | null;
  endsAt: number | null;
  durationMs: number;
  rooms: Breakout[];
}

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  kind: 'text' | 'system';
  text: string;
  at: number;
}

export interface SceneSnapshot {
  id: string;
  type: SceneType;
  payload: Record<string, any>;
  createdAt: number;
  expiresAt: number | null;
  persistent: boolean;
  durationMs: number;
  createdBy: string | null;
  blocksProgram: boolean;
}

export interface StreamSnapshot {
  status: string;
  preset: string;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  publisherId: string | null;
  uptimeMs: number;
  bitrateKbps: number;
  bytesIn: number;
  restarts: number;
  recording: boolean;
  destinationStatuses: Array<{ id: string; label: string; platform: string; url: string | null }>;
  [key: string]: any;
}

export interface RecordingSnapshot {
  status: string;
  id: string | null;
  startedAt: number | null;
  endedAt: number | null;
  file: string | null;
  /** The remuxed MP4 twin, when the recording was converted. */
  mp4?: string | null;
  durationMs: number | null;
  sizeBytes: number;
  error: string | null;
}

export interface RoomInfo {
  id: string;
  name: string;
  hostId: string | null;
  hostName: string;
  createdAt: number;
  memberCount: number;
  cohostCount: number;
  viewerCount: number;
  requiresHostPassword: boolean;
}

/** Everything a client needs to render a room. */
export interface RoomSnapshot {
  room: RoomInfo;
  members: Member[];
  chat: ChatMessage[];
  breakouts: BreakoutCatalogue;
  sources: Source[];
  program: Program;
  scene: SceneSnapshot | null;
  destinations: any[];
  stream: StreamSnapshot;
  recording: RecordingSnapshot;
  presets: any[];
}

/** The passwords that guard the host and co-host seats. */
export interface StudioCredentials {
  hostPassword: string;
  cohostPassword: string;
}

/** The adapter a parent room uses to open and close its breakout rooms. */
export interface BreakoutRoomAdapter {
  create(options: { id: string; name: string; parentId: string; index: number }): any;
  remove(roomId: string): Promise<unknown> | unknown;
}
