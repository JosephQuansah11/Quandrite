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
  /** NTP-style exchange so the client can offset its clock to the server's. */
  TIME_SYNC: 'time:sync',
  CHAT_SEND: 'chat:send',
  MEMBER_UPDATE: 'member:update',
  MEMBER_ROLE: 'member:role',
  MEMBER_MEDIA: 'member:media',
  ROOM_UPDATE: 'room:update',
  BREAKOUT_CREATE: 'breakout:create',
  BREAKOUT_ASSIGN: 'breakout:assign',
  BREAKOUT_RENAME: 'breakout:rename',
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
  TIME_SYNC: 'time:sync',
  CHAT_NEW: 'chat:new',
  CHAT_HISTORY: 'chat:history',
  MEMBERS_UPDATE: 'members:update',
  MEMBER_MEDIA: 'member:media',
  BREAKOUTS_UPDATE: 'breakouts:update',
  BREAKOUT_UPDATE: 'breakout:update',
  /**
   * The breakout room's **own** primary screen.
   *
   * A breakout is a room of its own, so it has its own sources and its own program: a
   * screen shared inside one is shown to that room and nowhere else. The parent's
   * program is a separate thing - it is the broadcast - and it still travels to everyone
   * as `sources:update` / `program:update` / `scene:update`, because a host inside a
   * breakout still runs the show.
   */
  BREAKOUT_SOURCES: 'breakout:sources',
  BREAKOUT_PROGRAM: 'breakout:program',
  BREAKOUT_SCENE: 'breakout:scene',
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

/**
 * The body of a server push.
 *
 * Studio pushes (`members:update`, `sources:update`, `program:update`,
 * `breakout:update`, ...) carry their content in `payload`, and the client
 * transport dispatches the payload itself, so a handler sees the roster array or
 * the snapshot it asked for. The flat messages (`welcome`, `member:media`,
 * `webrtc:signal`, `pong`) carry no `payload` and are dispatched whole, and a
 * cleared scene (`payload: null`) stays `null` instead of falling back to the
 * envelope.
 */
export function pushPayload(message) {
  if (message === null || typeof message !== 'object') return message;
  return message.payload === undefined ? message : message.payload;
}

// ----------------------------------------------------------------- nanosecond

/**
 * Nanosecond timing for the media relay.
 *
 * Milliseconds are far too coarse to say anything useful about a relayed picture:
 * a hop that is fine is a fraction of a millisecond, and the difference between a
 * frame that is 3 ms old and one that is 9 ms old is invisible at `Date.now()`
 * resolution. So relayed pictures and voice slices are stamped in nanoseconds.
 *
 * A stamp is only worth something if two devices agree on what it means, and their
 * wall clocks do not (they can differ by seconds, and drift). So there is one
 * time base - the server's monotonic clock - and every client keeps an offset to
 * it (see `clockOffsetNs`, which is the usual round-trip estimate). A sender
 * converts its own reading into server time before stamping a frame, so stamps
 * from every device are directly comparable, and a receiver measures the lag
 * against its own estimate of that same clock.
 *
 * That gives two honest numbers per frame: how long it took to reach the server
 * (`srv - tns`) and how long it took to come back out (`now - srv`).
 */
export const NS_PER_MS = 1_000_000n;
export const NS_PER_SECOND = 1_000_000_000n;

/**
 * A monotonic nanosecond reading on this machine.
 *
 * The server has a real nanosecond clock (`process.hrtime.bigint()`); browsers
 * expose microseconds (`performance.now()`) at best, so a browser reading is
 * exact arithmetic on a microsecond-accurate clock. Both are monotonic, which is
 * what matters: neither can jump backwards mid-call the way a wall clock can.
 */
export function monotonicNs() {
  if (typeof process !== 'undefined' && typeof process.hrtime?.bigint === 'function') {
    return process.hrtime.bigint();
  }
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    // performance.now() is milliseconds as a float; scaling by 1e6 stays exact for
    // the first ~104 days of page life, which is plenty.
    return BigInt(Math.round(performance.now() * 1e6));
  }
  return BigInt(Date.now()) * NS_PER_MS;
}

/** A nanosecond reading as a decimal string, for the wire (JSON has no bigint). */
export function nsToWire(value: bigint) {
  return value.toString();
}

/** Read a wire stamp back, tolerating the millisecond numbers older clients send. */
export function nsFromWire(value: any): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.round(value));
  return null;
}

/**
 * Offset between my clock and the server's, from one exchange.
 *
 * The client stamps the request `t0`, the server stamps its reply `t1` on receipt
 * and `t2` on send, and the client stamps `t3` on arrival. Assuming the two legs
 * took the same time, the offset is the average of the two differences, and the
 * round trip is the error bound. Taken over several samples the lowest round trip
 * wins, because a queue somewhere in the middle can only add delay.
 */
export function clockOffsetNs({ t0, t1, t2, t3 }: any) {
  const sent = nsFromWire(t0);
  const got = nsFromWire(t1);
  const replied = nsFromWire(t2);
  const back = nsFromWire(t3);
  if (sent === null || got === null || replied === null || back === null) return null;
  const roundTripNs = back - sent;
  if (roundTripNs < 0n) return null;
  return { offsetNs: (got - sent + (replied - back)) / 2n, roundTripNs };
}

/** True when a frame is older than `limitNs` on the shared clock. */
export function isStaleNs(capturedNs: bigint | null, nowNs: bigint, limitNs: bigint) {
  if (capturedNs === null) return false;
  return nowNs - capturedNs > limitNs;
}

/**
 * Break a relayed frame's stamps into the two hops, in nanoseconds.
 *
 * `totalNs` is what the room feels - how old the picture is by the time it is
 * shown. `inboundNs` is the sender-to-server leg and `outboundNs` is the
 * server-to-me leg, which is what makes it possible to say *which* side of the
 * network is at fault: a lag of 400 ms that is 380 ms inbound is the sender's
 * uplink, while the same total mostly outbound is my own downlink.
 *
 * A null means the stamp was missing (an older sender), so nothing is known about
 * that hop rather than it being guessed at.
 */
export function relayLagNs(header: any, nowNs: bigint) {
  const capturedNs = nsFromWire(header?.tns);
  const srvNs = nsFromWire(header?.srv);
  return {
    capturedNs,
    srvNs,
    totalNs: capturedNs === null ? null : nowNs - capturedNs,
    inboundNs: capturedNs === null || srvNs === null ? null : srvNs - capturedNs,
    outboundNs: srvNs === null ? null : nowNs - srvNs,
  };
}

/**
 * A lag, written the way it reads best: nanoseconds when a hop is that short,
 * microseconds under a millisecond, milliseconds beyond that.
 */
export function formatLagNs(value: bigint | number | null | undefined) {
  if (value === null || value === undefined) return '';
  const ns = typeof value === 'bigint' ? value : BigInt(Math.round(value));
  const negative = ns < 0n;
  const size = negative ? -ns : ns;
  const sign = negative ? '-' : '';
  if (size < 1_000n) return `${sign}${size} ns`;
  if (size < NS_PER_MS) return `${sign}${(Number(size) / 1e3).toFixed(2)} \u00b5s`;
  if (size < NS_PER_SECOND) return `${sign}${(Number(size) / 1e6).toFixed(2)} ms`;
  return `${sign}${(Number(size) / 1e9).toFixed(2)} s`;
}

/** Lossy milliseconds, for display or for timers that want a number. */
export function nsToMs(value: bigint | number | null | undefined) {
  if (value === null || value === undefined) return 0;
  const ns = typeof value === 'bigint' ? value : BigInt(Math.round(value));
  return Number(ns / 1_000n) / 1000;
}

// --------------------------------------------------------------- media relay

/**
 * Magic that marks a binary frame as a relayed picture rather than a program
 * chunk. A WebM/Matroska program chunk starts with the EBML magic (0x1A45DFA3),
 * so the two can never be confused.
 */
export const RELAY_MAGIC = 'QMR1';
/** How many relayed pictures a second the server passes on, per sender. */
export const RELAY_MAX_FPS = 8;
/**
 * Voice needs a much steadier stream than pictures do: 20 ms of PCM is 50 frames
 * a second, and throttling it to the picture rate would chop the sound up.
 */
export const RELAY_AUDIO_MAX_FPS = 60;
/**
 * ...and voice may arrive in a small burst: browsers do not fire their audio
 * callbacks exactly on time, and dropping a slice is a click in someone's ear.
 */
export const RELAY_AUDIO_BURST = 6;
/**
 * The **legacy** PCM fallback rate: mono, 16-bit, 16 kHz - 32 KB/s, and easy to decode
 * anywhere.
 *
 * The relay prefers **Opus at 48 kHz** through WebCodecs, and a client without it now sends
 * **48 kHz 24-bit** PCM (see `shared/audio.ts`). This rate is what an older sender still
 * stamps on its slices, and what the receiver falls back to when a frame arrives without a
 * codec, so a room with an old client in it keeps working.
 */
export const RELAY_AUDIO_RATE = 16000;
/** A picture older than this is worthless: showing it only adds its own delay. */
export const RELAY_STALE_NS = 1_500_000_000n;
/** Voice is stricter still - half a second late is not a conversation. */
export const RELAY_AUDIO_STALE_NS = 600_000_000n;
/** How often a client re-measures its offset to the server clock. */
export const CLOCK_SYNC_INTERVAL_MS = 30_000;
/**
 * A newcomer should see the room straight away, so the server keeps the last
 * picture from each source and hands it over on join. These are stills rather
 * than live frames - the room's own staleness rule would drop them - so they are
 * marked `warm` and the receiver shows them until the live ones arrive.
 */
export const RELAY_WARM_FRAMES = 6;
export const RELAY_WARM_MAX_AGE_MS = 12_000;

const relayText = new TextEncoder();
const relayReader = new TextDecoder();

/**
 * Wrap one relayed picture: `magic | header length | header JSON | JPEG bytes`.
 *
 * The header says what the picture is (`from`, `fromName`, `sourceId`, `kind`,
 * `label`, `w`, `h`), so the room can match it to the right camera or screen.
 */
export function encodeRelayFrame(header: any = {}, payload: any = new Uint8Array()) {
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const json = relayText.encode(JSON.stringify(header || {}));
  const frame = new Uint8Array(8 + json.length + body.length);
  for (let index = 0; index < 4; index += 1) frame[index] = RELAY_MAGIC.charCodeAt(index);
  new DataView(frame.buffer).setUint32(4, json.length, false);
  frame.set(json, 8);
  frame.set(body, 8 + json.length);
  return frame;
}

/** True when `buffer` is a relayed picture (and not a program chunk). */
export function isRelayFrame(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 8) return false;
  for (let index = 0; index < 4; index += 1) {
    if (bytes[index] !== RELAY_MAGIC.charCodeAt(index)) return false;
  }
  return true;
}

/** @returns {{header: any, payload: Uint8Array} | null} */
export function decodeRelayFrame(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (!isRelayFrame(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(4, false);
  if (bytes.length < 8 + length) return null;
  let header: any = {};
  try {
    header = JSON.parse(relayReader.decode(bytes.subarray(8, 8 + length)));
  } catch {
    return null;
  }
  return { header, payload: bytes.subarray(8 + length) };
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
  /**
   * Where the host's spread suggests this member could go. It is shown in the picker and
   * moves nobody: a participant walks into a room themselves.
   */
  suggestedBreakoutId?: string | null;
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
  /** Set for a private message: the member it was sent to, and nobody else sees it. */
  to?: string | null;
  /** Set when the message carries a picture. */
  attachment?: ChatAttachment | null;
}

/**
 * A picture in a chat message.
 *
 * The picture itself is uploaded first and referred to by URL: a chat message travels
 * over the signalling socket, and a megabyte of base64 in every message would slow the
 * room down for everyone. The server hands back the URL, and only ever accepts URLs it
 * produced itself.
 */
export interface ChatAttachment {
  url: string;
  name: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
}

/** Pictures a chat message may carry, and how big they may be once decoded. */
export const CHAT_ATTACHMENT_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export const MAX_CHAT_ATTACHMENT_BYTES = 2 * 1024 * 1024;

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
  /** Rename the breakout room itself, so a member inside it sees the new name too. */
  rename?(roomId: string, name: string): boolean;
}
