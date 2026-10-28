/**
 * Studio: the authoritative state of one communication room / broadcast.
 *
 * It owns members, chat, the pool of media sources (multiple cameras, screen
 * shares, audio), which source(s) are on the program output, the current
 * overlay scene, the platform destinations, the outbound relay, the recording
 * and - for a parent room - its breakout rooms. Every mutation emits a granular
 * event that the signalling layer
 * fans out to connected clients.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createOverlay, OVERLAY_DEFINITIONS } from '../shared/overlays.ts';
import { redactDestination, validateDestination } from '../shared/destinations.ts';
import {
  MAX_BREAKOUTS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PROGRAM_MODES,
  SOURCE_KINDS,
  SOURCE_REQUESTS,
  canControlBroadcast,
  isPasswordValid,
  isPassiveRole,
  isRole,
  normalizeRole,
} from '../shared/protocol.ts';
import { resolveProgramSources } from '../shared/layout.ts';
import { listPresets } from './ffmpeg.ts';
import { StreamRelay } from './relay.ts';
import type {
  BreakoutRoomAdapter,
  ChatMessage,
  Member,
  Program,
  RecordingSnapshot,
  Source,
  StudioCredentials,
} from '../shared/protocol.ts';

const MAX_CHAT_LENGTH = 2000;
const MAX_MEMBER_NAME = 48;
const MAX_SOURCE_LABEL = 64;
const MAX_BREAKOUT_LABEL = 48;

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** How a room recognises a name again: case and stray spacing do not matter. */
function nameKey(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The key for a private conversation.
 *
 * The two member ids in a fixed order, so both sides of the thread find the same list
 * however the pair is spelled. The separator cannot appear in a client id.
 */
function privateThreadKey(a, b) {
  return [String(a), String(b)].sort().join('\u0000');
}

/** Trim and bound a room password; empty becomes null (not configured). */
function cleanSecret(value) {
  const secret = String(value ?? '').slice(0, MAX_PASSWORD_LENGTH);
  return secret.length ? secret : null;
}

/** A readable shared secret for a room that has no configured password. */
function makePassword() {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

export interface StudioOptions {
  id: string;
  name?: string;
  hostName?: string;
  hostPassword?: string | null;
  cohostPassword?: string | null;
  breakoutOf?: string | null;
  breakoutIndex?: number | null;
  breakoutRooms?: BreakoutRoomAdapter | null;
  config?: any;
  recordingStore?: any;
  relayFactory?: any;
  logger?: any;
}

export class Studio extends EventEmitter {
  id: string;
  name: string;
  config: any;
  recordingStore: any;
  relayFactory: any;
  logger: any;
  createdAt: number;
  members: Map<string, Member>;
  chat: ChatMessage[];
  /**
   * Names (lower-cased) the host has muted one at a time. A sweep is not remembered, a
   * decision about a person is - see `rememberMute`.
   */
  mutedNames: Set<string>;
  /**
   * Names (lower-cased) with a hand raised.
   *
   * A raised hand is a state, so it is remembered the same way a mute is: a person who
   * reloads comes back with their hand still up, rather than losing their place in the
   * queue because their browser blinked.
   */
  handNames: Set<string>;
  /** Private conversations, keyed by `privateThreadKey`. */
  privateChats: Map<string, ChatMessage[]>;
  sources: Map<string, Source>;
  destinations: Map<string, any>;
  program: Program;
  scene: any;
  stream: any;
  recording: RecordingSnapshot;
  relay: any;
  hostId: string | null;
  hostName: string;
  breakoutOf: string | null;
  breakoutRooms: BreakoutRoomAdapter | null;
  breakouts: Map<string, any>;
  breakoutSession: any;
  credentials: StudioCredentials;
  hostPasswordRequired: boolean;
  emptySince?: number | null;
  _hostClaimed: boolean;
  _sceneTimer: any;
  _sceneRestore: any;
  _breakoutTimer: any;
  _finalizePromise: any;
  _reconfigureChain: any;

  constructor({
    id,
    name,
    hostName = 'Host',
    hostPassword = null,
    cohostPassword = null,
    breakoutOf = null,
    breakoutRooms = null,
    config,
    recordingStore = null,
    relayFactory = null,
    logger = console,
  }: StudioOptions) {
    super();
    this.id = id;
    this.name = cleanText(name, 80) || id;
    this.config = config;
    this.recordingStore = recordingStore;
    this.relayFactory = relayFactory;
    this.logger = logger;
    this.createdAt = Date.now();

    this.members = new Map();
    // Names the host has muted one by one: a decision about a person, which is meant to
    // hold if they close the tab and come back. "Mute all" is a sweep, not a policy, so
    // it is not remembered here.
    this.mutedNames = new Set();
    // Hands up, by name, for the same reason a mute is: it is a state about a person, not
    // about the moment they happened to be in the room.
    this.handNames = new Set();
    this.chat = [];
    /**
     * Private conversations, keyed by the pair of members in them. They are never part of
     * the room's chat: a private message reaches two people, and the room's history is
     * for everyone.
     */
    this.privateChats = new Map();
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

    // Breakout rooms: a parent splits itself into child rooms (each a Studio of
    // its own, so chat and the meeting work) and tracks who is where.
    this.breakoutOf = breakoutOf ? String(breakoutOf) : null;
    this.breakoutRooms = breakoutRooms;
    this.breakouts = new Map();
    this.breakoutSession = null;
    this._breakoutTimer = null;

    // Role passwords. An operator can configure them per room (or through the
    // environment); otherwise the room generates its own and reveals them to
    // whoever ends up as host so they can be shared with co-hosts.
    const configuredHostPassword = cleanSecret(hostPassword);
    const configuredCohostPassword = cleanSecret(cohostPassword);
    this.credentials = {
      hostPassword: configuredHostPassword || makePassword(),
      cohostPassword: configuredCohostPassword || makePassword(),
    };
    // When the operator set a host password it is enforced from the very first
    // join; a generated one lets the room bootstrap a host first.
    this.hostPasswordRequired = Boolean(configuredHostPassword);
    this._hostClaimed = false;
  }

  // ---------------------------------------------------------------- members

  /**
   * Decide which role a joiner ends up with.
   *
   * - `host` is a single seat: it needs the host password, and only one person
   *   holds it at a time (the host hands it over with `setMemberRole`).
   * - `cohost` can be claimed by anyone holding the co-host password - several
   *   people at once - or granted by the host without any password.
   * - `viewer` / `visitor` never need a password and never drive the broadcast.
   *
   * @returns {{ok: true, role: string} | {ok: false, error: string}}
   */
  resolveRole({ role = null, password = null, isFirst = false }: any = {}) {
    const requested = isRole(role) ? role : null;

    // Bootstrap: the first person in a room with no operator-set password takes
    // the host seat, so a room that was opened on demand is never left without
    // an owner. From then on the seat needs the host password.
    if (isFirst && !this._hostClaimed && !this.hostPasswordRequired) return { ok: true, role: 'host' };

    if (requested === 'host') {
      // The password is the stronger claim: it always wins, so a host that
      // reconnects takes the seat back from whoever was handed it meanwhile.
      if (this.passwordMatches(password, this.credentials.hostPassword)) {
        return { ok: true, role: 'host' };
      }
      if (this.hostId) {
        return { ok: false, error: 'this room already has a host - ask them to hand the role over' };
      }
      return { ok: false, error: 'the host password is not correct' };
    }

    if (requested === 'cohost') {
      if (!this.passwordMatches(password, this.credentials.cohostPassword)) {
        return { ok: false, error: 'the co-host password is not correct - the host can also promote you' };
      }
      return { ok: true, role: 'cohost' };
    }

    if (requested) return { ok: true, role: requested };

    // No role requested in a room that already has an owner: just watch.
    return { ok: true, role: 'viewer' };
  }

  passwordMatches(supplied, expected) {
    if (!expected) return false;
    return typeof supplied === 'string' && supplied.length > 0 && supplied === expected;
  }

  join({ clientId, name, role, password = null }: any = {}) {
    if (!clientId) throw new Error('clientId is required');
    const isFirst = this.members.size === 0 && !this.hostId;
    const claim = this.resolveRole({ role, password, isFirst });
    if (!claim.ok) throw new Error(claim.error);

    const memberName = cleanText(name, MAX_MEMBER_NAME) || (isFirst ? this.hostName : 'Guest');
    const effectiveRole = claim.role;

    const member = {
      id: clientId,
      name: memberName,
      role: effectiveRole,
      joinedAt: Date.now(),
      // Somebody the host muted individually arrives muted: the decision is about them,
      // not about the moment they were in the room.
      muted: this.mutedNames.has(nameKey(memberName)),
      cameraEnabled: false,
      screenSharing: false,
      // ...and so does somebody who had their hand up when they reloaded.
      handRaised: this.handNames.has(nameKey(memberName)),
      speaking: false,
      sourceIds: [],
      breakoutId: null,
      // Where the host's spread *suggests* they go: shown in the picker, moves nobody.
      suggestedBreakoutId: null,
    };
    this.members.set(clientId, member);
    if (effectiveRole === 'host') {
      // Only one seat: whoever held it steps down to co-host.
      const previous = this.hostId ? this.members.get(this.hostId) : null;
      if (previous && previous.id !== clientId) previous.role = 'cohost';
      this.hostId = clientId;
      this.hostName = memberName;
      this._hostClaimed = true;
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
    const breakout = member.breakoutId ? this.breakouts.get(member.breakoutId) : null;
    if (breakout) breakout.memberIds = breakout.memberIds.filter((id) => id !== clientId);
    for (const sourceId of [...member.sourceIds]) {
      this.removeSource(sourceId, { byId: clientId, silent: true });
    }
    if (this.stream.publisherId === clientId) {
      this.stream.publisherId = null;
    }
    if (this.hostId === clientId) {
      // Keep the room controllable: hand the host seat to the earliest co-host,
      // otherwise to the earliest member. When the room empties the seat stays
      // open until someone claims it with the host password.
      const members = [...this.members.values()];
      const next =
        members
          .filter((candidate) => candidate.role === 'cohost')
          .sort((a, b) => a.joinedAt - b.joinedAt)[0] ||
        members.sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (next) {
        next.role = 'host';
        this.hostId = next.id;
        this.hostName = next.name;
        this._hostClaimed = true;
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
    if (breakout) this.emit('breakouts', this.breakoutsSnapshot());
    return true;
  }

  getMember(clientId) {
    return this.members.get(clientId) || null;
  }

  memberName(clientId) {
    return this.members.get(clientId)?.name || 'Guest';
  }

  updateMember(clientId, patch: any = {}) {
    const member = this.members.get(clientId);
    if (!member) return null;
    if (patch.muted !== undefined) member.muted = Boolean(patch.muted);
    if (patch.cameraEnabled !== undefined) member.cameraEnabled = Boolean(patch.cameraEnabled);
    if (patch.screenSharing !== undefined) member.screenSharing = Boolean(patch.screenSharing);
    if (patch.handRaised !== undefined) member.handRaised = Boolean(patch.handRaised);
    if (patch.speaking !== undefined) member.speaking = Boolean(patch.speaking);
    if (patch.name !== undefined) member.name = cleanText(patch.name, MAX_MEMBER_NAME) || member.name;
    this.emit('members', this.membersSnapshot());
    return member;
  }

  /**
   * Remember - or forget - a host's mute of one person.
   *
   * Muting somebody is a decision about them, and it should not be undone by a reload:
   * the name goes on a list, and the next person to join under that name arrives muted.
   * Nobody is locked out of their own microphone - anyone can unmute themselves at any
   * time, and the host unmuting them clears the note. The list is by name, which is what
   * a room has to identify somebody by; a person who changes their name arrives
   * unmuted, which is a fair price for not holding onto identities.
   */
  rememberMute(clientId, muted) {
    const member = this.members.get(clientId);
    if (!member) return false;
    const key = nameKey(member.name);
    if (!key) return false;
    if (muted) this.mutedNames.add(key);
    else this.mutedNames.delete(key);
    return true;
  }

  /**
   * Remember - or forget - that a person has their hand up.
   *
   * The same note-taking as `rememberMute`, for the same reason: a hand is a state about a
   * person, and a reload should not quietly take it down. Nobody is stuck with it either -
   * the hand is the person's own to lower.
   */
  rememberHand(clientId, raised) {
    const member = this.members.get(clientId);
    if (!member) return false;
    const key = nameKey(member.name);
    if (!key) return false;
    if (raised) this.handNames.add(key);
    else this.handNames.delete(key);
    return true;
  }

  /**
   * Grant, revoke or hand over roles. Only the host may do this, which is how a
   * co-host is granted *without* a password.
   *
   * @param {string} byId      the acting member (must be the host)
   * @param {string} memberId  the member being changed
   * @param {string} role      `host` (hand over), `cohost`, `viewer` or `visitor`
   */
  setMemberRole(byId, memberId, role) {
    if (this.hostId !== byId) return { ok: false, error: 'only the host can change roles' };
    if (!isRole(role)) return { ok: false, error: `unsupported role: ${role}` };
    const target = this.members.get(memberId);
    if (!target) return { ok: false, error: 'member not found' };
    const nextRole = normalizeRole(role);
    const host = this.members.get(this.hostId) || null;

    if (nextRole === 'host') {
      if (target.id === this.hostId) return { ok: false, error: 'already the host' };
      const previous = host;
      target.role = 'host';
      this.hostId = target.id;
      this.hostName = target.name;
      this._hostClaimed = true;
      if (previous && previous.id !== target.id) previous.role = 'cohost';
      this.addChat({
        authorId: 'system',
        authorName: 'Quandrite',
        kind: 'system',
        text: `${target.name} is now the host`,
      });
    } else if (nextRole === 'cohost') {
      if (target.role === 'cohost') return { ok: true, member: { ...target } };
      target.role = 'cohost';
      this.addChat({
        authorId: 'system',
        authorName: 'Quandrite',
        kind: 'system',
        text: `${host?.name || 'The host'} made ${target.name} a co-host`,
      });
    } else {
      if (target.id === this.hostId) {
        return { ok: false, error: 'hand the host role to someone else before changing your own role' };
      }
      if (target.role !== nextRole) {
        target.role = nextRole;
        this.addChat({
          authorId: 'system',
          authorName: 'Quandrite',
          kind: 'system',
          text: `${target.name} is now a ${nextRole}`,
        });
      }
    }

    this.emit('members', this.membersSnapshot());
    return { ok: true, member: { ...target } };
  }

  /**
   * Rotate the room passwords. Host only; the new values are never broadcast -
   * they are returned to the host that changed them.
   */
  updateCredentials(byId, { hostPassword, cohostPassword }: any = {}) {
    if (this.hostId !== byId) return { ok: false, error: 'only the host can change the room passwords' };

    const next = { ...this.credentials };
    const errors = [];
    for (const [key, value] of Object.entries({ hostPassword, cohostPassword })) {
      if (value === undefined || value === null || value === '') continue;
      const secret = cleanSecret(value);
      if (!isPasswordValid(secret)) {
        errors.push(`${key} must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`);
        continue;
      }
      next[key] = secret;
    }
    if (errors.length) return { ok: false, errors };
    if (!hostPassword && !cohostPassword) return { ok: false, error: 'no password supplied' };

    this.credentials = next;
    if (hostPassword) this.hostPasswordRequired = true;
    this.addChat({
      authorId: 'system',
      authorName: 'Quandrite',
      kind: 'system',
      text: 'The room passwords were updated',
    });
    return { ok: true, credentials: this.credentialsSnapshot() };
  }

  /** Passwords for the host only - never part of a shared snapshot. */
  credentialsSnapshot() {
    return { hostPassword: this.credentials.hostPassword, cohostPassword: this.credentials.cohostPassword };
  }

  /**
   * Change the role of someone already in the room - a re-join that claims a
   * seat, or an upgrade from viewer to co-host with the room password.
   */
  claimRole(clientId, { role = null, password = null }: any = {}) {
    const member = this.members.get(clientId);
    if (!member) return { ok: false, error: 'join the room first' };
    // Re-joining never silently takes a role away - stepping down is the host's
    // call through `setMemberRole` - so an unprivileged request keeps what you
    // already hold.
    if (!isRole(role) || role === member.role) return { ok: true, member: { ...member } };
    if (isPassiveRole(role) && canControlBroadcast(member.role)) {
      return { ok: true, member: { ...member } };
    }

    const claim = this.resolveRole({ role, password, isFirst: false });
    if (!claim.ok) return claim;
    if (claim.role === member.role) return { ok: true, member: { ...member } };

    if (claim.role === 'host') {
      const previous = this.members.get(this.hostId);
      member.role = 'host';
      this.hostId = member.id;
      this.hostName = member.name;
      this._hostClaimed = true;
      if (previous && previous.id !== member.id) previous.role = 'cohost';
      this.addChat({
        authorId: 'system',
        authorName: 'Quandrite',
        kind: 'system',
        text: `${member.name} is now the host`,
      });
    } else {
      member.role = claim.role;
      this.addChat({
        authorId: 'system',
        authorName: 'Quandrite',
        kind: 'system',
        text: `${member.name} is now a ${claim.role}`,
      });
    }

    this.emit('members', this.membersSnapshot());
    return { ok: true, member: { ...member } };
  }

  isHost(clientId) {
    return Boolean(clientId) && this.hostId === clientId;
  }

  /** Everyone who is not driving the broadcast - viewers and visitors. */
  passiveMembers() {
    return [...this.members.values()].filter((member) => !canControlBroadcast(member.role));
  }

  // --------------------------------------------------------------- breakouts

  get isBreakout() {
    return Boolean(this.breakoutOf);
  }

  /**
   * Split the room into breakout rooms.
   *
   * Every breakout is a room of its own (its own chat and attendees) owned by
   * this studio. Participants are distributed round-robin, or by the supplied
   * assignment map, while the host stays in the main room so they can move
   * between breakouts.
   */
  createBreakouts({ count = 2, labels = [], assignments = null }: any = {}) {
    if (this.isBreakout) return { ok: false, error: 'a breakout room cannot be split again' };
    if (!this.breakoutRooms?.create) {
      return { ok: false, error: 'breakout rooms are not available on this server' };
    }
    if (this.breakouts.size) {
      return { ok: false, error: 'this room already has breakout rooms - remove them first' };
    }

    const total = Math.max(1, Math.min(MAX_BREAKOUTS, Math.floor(Number(count) || 2)));
    const created = [];
    for (let index = 0; index < total; index += 1) {
      const id = `${this.id}-b${index + 1}`;
      const label = cleanText(labels[index], MAX_BREAKOUT_LABEL) || `Breakout ${index + 1}`;
      const room = this.breakoutRooms.create({ id, name: `${this.name} - ${label}`, parentId: this.id, index: index + 1 });
      if (!room) {
        for (const entry of created) this.breakoutRooms.remove?.(entry.id);
        this.breakouts.clear();
        return { ok: false, error: 'the server could not open the breakout rooms' };
      }
      const record = { id, label, index: index + 1, open: false, openedAt: null, memberIds: [], createdAt: Date.now() };
      this.breakouts.set(id, record);
      created.push(record);
    }

    this.autoAssignBreakouts(assignments);
    this.addChat({
      authorId: 'system',
      authorName: 'Quandrite',
      kind: 'system',
      text: `${total} breakout room(s) created - assign people, then open them`,
    });
    this.emit('breakouts', this.breakoutsSnapshot());
    return { ok: true, breakouts: this.breakoutsSnapshot() };
  }

  /** Spread the participants across the breakout rooms (host stays home). */
  /**
   * Suggest where each member could go.
   *
   * A suggestion, not a move: `suggestedBreakoutId` is what the picker shows as "your
   * room", and nobody is taken anywhere by it. Opening the rooms tells everybody they can
   * choose; a host who wants somebody in a particular room moves them from the roster
   * (`assignBreakout`), which *is* a move.
   */
  autoAssignBreakouts(assignments = null) {
    const ids = [...this.breakouts.keys()];
    if (!ids.length) return { ok: false, error: 'there are no breakout rooms yet' };

    const explicit = assignments instanceof Map ? assignments : new Map(Object.entries(assignments || {}));
    let cursor = 0;
    for (const member of [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)) {
      if (member.id === this.hostId && !explicit.has(member.id)) {
        this._suggestBreakout(member, null);
        continue;
      }
      const target = explicit.has(member.id) ? explicit.get(member.id) : ids[cursor % ids.length];
      cursor += 1;
      this._suggestBreakout(member, target);
    }

    this.emit('members', this.membersSnapshot());
    this.emit('breakouts', this.breakoutsSnapshot());
    return { ok: true, breakouts: this.breakoutsSnapshot() };
  }

  /** Record where a member *could* go, without moving them. */
  _suggestBreakout(member, breakoutId) {
    const target = breakoutId ? this.breakouts.get(breakoutId) : null;
    member.suggestedBreakoutId = target ? target.id : null;
    if (!target) return member;
    if (!target.memberIds.includes(member.id)) target.memberIds.push(member.id);
    return member;
  }

  /** Send one member to a breakout room, or back to the main room (`null`). */
  assignBreakout(memberId, breakoutId = null) {
    const member = this.members.get(memberId);
    if (!member) return { ok: false, error: 'member not found' };
    if (breakoutId !== null && breakoutId !== undefined && !this.breakouts.has(breakoutId)) {
      return { ok: false, error: 'breakout room not found' };
    }
    if (member.breakoutId === (breakoutId ?? null)) return { ok: true, member: { ...member } };

    this._placeMember(member, breakoutId ?? null);
    this.emit('members', this.membersSnapshot());
    this.emit('breakouts', this.breakoutsSnapshot());
    return { ok: true, member: { ...member } };
  }

  /** Move a member's assignment, keeping the breakout rosters in step. */
  _placeMember(member, breakoutId) {
    const previous = member.breakoutId ? this.breakouts.get(member.breakoutId) : null;
    if (previous) previous.memberIds = previous.memberIds.filter((id) => id !== member.id);

    const target = breakoutId ? this.breakouts.get(breakoutId) : null;
    member.breakoutId = target ? target.id : null;
    if (target && !target.memberIds.includes(member.id)) target.memberIds.push(member.id);
    return member;
  }

  /**
   * Rename a breakout room.
   *
   * Rooms start as "Breakout 1", "Breakout 2" - the least a host has to decide to get
   * going - but the point of a name is that the people *choosing* where to go can see
   * where they are going, so the host can call them what the session is actually about.
   * The breakout room's own name follows, so somebody inside it sees the new one too.
   */
  renameBreakout(breakoutId, label) {
    const breakout = this.breakouts.get(breakoutId);
    if (!breakout) return { ok: false, error: 'breakout room not found' };
    const next = cleanText(label, MAX_BREAKOUT_LABEL);
    if (!next) return { ok: false, error: 'a breakout room needs a name' };
    if (next === breakout.label) return { ok: true, breakouts: this.breakoutsSnapshot() };

    const before = breakout.label;
    breakout.label = next;
    const room = this.breakoutRooms?.rename?.(breakoutId, `${this.name} - ${next}`);
    if (room === false) return { ok: false, error: 'the breakout room could not be renamed' };

    this.addChat({
      authorId: 'system',
      authorName: 'Quandrite',
      kind: 'system',
      text: `"${before}" is now called "${next}"`,
    });
    this.emit('breakouts', this.breakoutsSnapshot());
    return { ok: true, breakouts: this.breakoutsSnapshot() };
  }

  /**
   * Open or close breakout rooms.
   *
   * Closing keeps the assignments so the same groups can be reopened; attendees
   * are sent back to the main room by the signalling layer.
   */
  setBreakoutsOpen(open, { breakoutId = null, durationMs = 0 }: any = {}) {
    const targets = breakoutId
      ? [this.breakouts.get(breakoutId)].filter(Boolean)
      : [...this.breakouts.values()];
    if (!targets.length) return { ok: false, error: 'breakout room not found' };

    for (const breakout of targets) {
      breakout.open = Boolean(open);
      breakout.openedAt = open ? Date.now() : null;
    }

    if (open && durationMs > 0) this._scheduleBreakoutClose(durationMs);
    else if (!open && !breakoutId) this._clearBreakoutTimer();

    this.addChat({
      authorId: 'system',
      authorName: 'Quandrite',
      kind: 'system',
      text: open
        ? `${targets.map((breakout) => breakout.label).join(', ')} open - join your room`
        : `${targets.map((breakout) => breakout.label).join(', ')} closed - back to the main room`,
    });
    this.emit('members', this.membersSnapshot());
    this.emit('breakouts', this.breakoutsSnapshot());
    return { ok: true, breakouts: this.breakoutsSnapshot() };
  }

  /** Remove every breakout room and bring the assignments home. */
  async clearBreakouts() {
    this._clearBreakoutTimer();
    const removed = [...this.breakouts.values()];
    this.breakouts.clear();
    this.breakoutSession = null;
    for (const member of this.members.values()) member.breakoutId = null;

    for (const breakout of removed) {
      try {
        await this.breakoutRooms?.remove?.(breakout.id);
      } catch {
        // a room that is already gone is fine
      }
    }

    this.emit('members', this.membersSnapshot());
    this.emit('breakouts', this.breakoutsSnapshot());
    return { ok: true, removed: removed.map((breakout) => breakout.id) };
  }

  /** The breakout catalogue: what exists, what is open, who is where. */
  breakoutsSnapshot() {
    const rooms = [...this.breakouts.values()].map((breakout) => ({
      id: breakout.id,
      label: breakout.label,
      index: breakout.index,
      open: breakout.open,
      openedAt: breakout.openedAt ?? null,
      memberIds: [...breakout.memberIds],
      memberCount: breakout.memberIds.length,
    }));
    return {
      available: Boolean(this.breakoutRooms?.create),
      max: MAX_BREAKOUTS,
      active: Boolean(this.breakoutSession),
      startedAt: this.breakoutSession?.startedAt ?? null,
      endsAt: this.breakoutSession?.endsAt ?? null,
      durationMs: this.breakoutSession?.durationMs ?? 0,
      rooms,
    };
  }

  /** Rooms that carry chat on their own (the parent plus every breakout). */
  chatRooms() {
    return [this.id, ...[...this.breakouts.keys()]];
  }

  /** Auto-close the breakout session when the timer runs out. */
  _scheduleBreakoutClose(durationMs) {
    this._clearBreakoutTimer();
    const duration = Math.max(1000, Math.floor(Number(durationMs) || 0));
    const startedAt = Date.now();
    this.breakoutSession = { startedAt, durationMs: duration, endsAt: startedAt + duration };
    this._breakoutTimer = setTimeout(() => {
      this._breakoutTimer = null;
      this.breakoutSession = null;
      this.setBreakoutsOpen(false);
    }, duration);
    if (typeof this._breakoutTimer.unref === 'function') this._breakoutTimer.unref();
  }

  _clearBreakoutTimer() {
    if (this._breakoutTimer) {
      clearTimeout(this._breakoutTimer);
      this._breakoutTimer = null;
    }
    this.breakoutSession = null;
  }

  /**
   * Post a chat message.
   *
   * Three kinds of message share one shape: the room's own conversation, a **private**
   * one (with `to`), and a system notice. A private message is kept in a thread keyed by
   * the pair, never in the room's chat, and the emitted event carries `to` so the
   * signalling layer can deliver it to those two people and nobody else. A message may
   * carry a picture, in which case it may have no words at all.
   */
  addChat({ authorId, authorName, text, kind = 'text', to = null, attachment = null }: any = {}) {
    const body =
      kind === 'system'
        ? cleanText(text, MAX_CHAT_LENGTH)
        : String(text ?? '').trim().slice(0, MAX_CHAT_LENGTH);
    if (!body && !attachment) return null;
    const message = {
      id: randomUUID(),
      authorId: authorId || 'system',
      authorName: cleanText(authorName, MAX_MEMBER_NAME) || this.memberName(authorId),
      kind,
      text: body,
      at: Date.now(),
      to: to || null,
      attachment: attachment || null,
    };

    if (message.to) {
      const key = privateThreadKey(authorId, message.to);
      const thread = this.privateChats.get(key) || [];
      thread.push(message);
      const limit = this.config?.chatLimit ?? 500;
      if (thread.length > limit) thread.splice(0, thread.length - limit);
      this.privateChats.set(key, thread);
    } else {
      this.chat.push(message);
      const limit = this.config?.chatLimit ?? 500;
      if (this.chat.length > limit) this.chat.splice(0, this.chat.length - limit);
    }
    this.emit('chat', message);
    return message;
  }

  /**
   * The private threads a member is part of, keyed by the other person.
   *
   * A reload should not lose a conversation, so the threads come with the join. Only the
   * two people in a thread ever see it.
   */
  privateThreadsFor(clientId) {
    const threads: any = {};
    for (const [key, messages] of this.privateChats) {
      const pair = key.split('\u0000');
      if (!pair.includes(clientId)) continue;
      const peer = pair[0] === clientId ? pair[1] : pair[0];
      threads[peer] = messages.slice(-100);
    }
    return threads;
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
  addSource({ id, ownerId, label, kind = 'camera', deviceId = null, groupId = null, meta = {} }: any = {}) {
    if (!ownerId) return { ok: false, error: 'ownerId is required' };
    if (!SOURCE_KINDS.includes(kind)) {
      return { ok: false, error: `unsupported source kind: ${kind}` };
    }
    const owner = this.members.get(ownerId);
    if (!owner) return { ok: false, error: 'join the room before publishing a source' };
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
      // What the owner would like the host to do with this source.
      request: null,
      addedAt: existing?.addedAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.sources.set(sourceId, source);
    if (member && !member.sourceIds.includes(sourceId)) member.sourceIds.push(sourceId);

    let programChanged = false;
    // A camera or screen added by the host or a co-host goes on air when the
    // program is empty. A participant's own camera waits to be asked for, so
    // nobody can put themselves on the program.
    if (
      !this.program.sourceId &&
      (source.kind === 'camera' || source.kind === 'screen') &&
      canControlBroadcast(owner.role)
    ) {
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

  updateSource(id, patch: any = {}, { byId }: any = {}) {
    const source = this.sources.get(id);
    if (!source) return { ok: false, error: 'source not found' };
    if (byId && source.ownerId !== byId) return { ok: false, error: 'not your source' };
    if (patch.label !== undefined) source.label = cleanText(patch.label, MAX_SOURCE_LABEL) || source.label;
    if (patch.active !== undefined) source.active = Boolean(patch.active);
    if (patch.request !== undefined) {
      if (patch.request === null || patch.request === '') source.request = null;
      else if (!SOURCE_REQUESTS.includes(patch.request)) {
        return { ok: false, error: `unsupported request: ${patch.request}` };
      } else source.request = patch.request;
    }
    if (patch.meta && typeof patch.meta === 'object') source.meta = { ...source.meta, ...patch.meta };
    source.updatedAt = Date.now();
    this.emit('sources', this.sourcesSnapshot());
    return { ok: true, source };
  }

  removeSource(id, { byId, silent = false }: any = {}) {
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
  setProgram({ mode, sourceId, gridIds }: any = {}) {
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
    const program = this.programSnapshot();

    // A request is satisfied the moment its source is on the program, so the
    // host never has to clear it by hand.
    const onAir = new Set(program.onAir);
    let satisfied = false;
    for (const source of this.sources.values()) {
      if (source.request && onAir.has(source.id)) {
        source.request = null;
        satisfied = true;
      }
    }

    this.emit('program', program);
    if (satisfied) this.emit('sources', this.sourcesSnapshot());
    return { ok: true, program };
  }

  // ------------------------------------------------------------------ scene

  /**
   * Push an overlay onto the program picture.
   *
   * Supported types: title, announcement, screenshare, song, break, ended.
   * Timed overlays clear themselves; persistent ones stay until replaced.
   */
  setScene(input: any = {}) {
    const created: any = createOverlay(input);
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

  clearScene({ auto = false }: any = {}) {
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
  addDestination(input: any = {}) {
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

  updateDestination(id, patch: any = {}) {
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
    const targets: any[] = this.enabledDestinations().map((destination) => ({
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
  async startStream({ preset, record = false, byId = null, resolution }: any = {}) {
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
  async stopStream({ byId = null, reason = 'stopped' }: any = {}) {
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
        hostName: this.hostName,
        createdAt: this.createdAt,
        memberCount: this.members.size,
        cohostCount: [...this.members.values()].filter((member) => member.role === 'cohost').length,
        viewerCount: this.passiveMembers().length,
        requiresHostPassword: this.hostPasswordRequired,
      },
      members: this.membersSnapshot(),
      chat: this.chat.slice(-100),
      breakouts: this.breakoutsSnapshot(),
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
    this._clearBreakoutTimer();
    const breakouts = [...this.breakouts.values()];
    this.breakouts.clear();
    for (const breakout of breakouts) {
      try {
        await this.breakoutRooms?.remove?.(breakout.id);
      } catch {
        // the child room may already be gone
      }
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
