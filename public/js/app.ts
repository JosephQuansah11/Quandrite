/**
 * Quandrite studio UI.
 *
 * Wires the WebSocket protocol to the camera manager, program compositor,
 * publisher and meeting mesh, and renders the studio controls.
 */

import { $, el, clear, fmtDuration, fmtBytes, fmtTime, toast } from './dom.js';
import { QuandriteSocket } from './ws.js';
import { CameraManager } from './devices.js';
import { ProgramCompositor } from './compositor.js';
import { StreamPublisher } from './publisher.js';
import { MeetingMesh } from './webrtc.js';
import { CLIENT, REQUESTABLE_SCENE_TYPES, SERVER, canControlBroadcast } from '/shared/protocol.js';
import type {
  BreakoutCatalogue,
  ChatMessage,
  Member,
  Program,
  RecordingSnapshot,
  RoomSnapshot,
  Source,
  StreamSnapshot,
  StudioCredentials,
} from '/shared/protocol.js';

/** Everything the client keeps between messages. */
interface ClientState {
  socket: any;
  camera: any;
  compositor: any;
  publisher: any;
  meeting: any;
  clientId: string | null;
  roomId: string | null;
  name: string | null;
  role: string;
  overlayDefinitions: Record<string, any>;
  platforms: any[];
  members: Member[];
  sources: Source[];
  program: Program;
  scene: RoomSnapshot['scene'];
  destinations: any[];
  stream: StreamSnapshot | any;
  recording: RecordingSnapshot | any;
  presets: any[];
  /** The library as last pushed/fetched, so the tab paints instantly. */
  recordings: any[];
  credentials: StudioCredentials | null;
  breakouts: BreakoutCatalogue;
  breakoutId: string | null;
  peerStreams: Map<string, MediaStream>;
  roomPeers: Map<string, string> | null;
  panes: Record<string, boolean>;
  sceneForm: { type: string; screenKey?: string; music?: any };
  inCall: boolean;
  publishing: boolean;
  /** What to re-join with after a reconnect (kept in memory only). */
  join: { name: string; roomId: string; role: string; password: string } | null;
  reconnecting: boolean;
  mail: { enabled: boolean; from: string | null };
}

const state: ClientState = {
  socket: null,
  camera: null,
  compositor: null,
  publisher: null,
  meeting: null,
  clientId: null,
  roomId: null,
  name: null,
  role: 'viewer',
  overlayDefinitions: {},
  platforms: [],
  members: [],
  sources: [],
  program: { mode: 'single', sourceId: null, gridIds: [], onAir: [] },
  scene: null,
  destinations: [],
  stream: { status: 'offline' },
  recording: { status: 'idle' },
  presets: [],
  recordings: [],
  credentials: null,
  breakouts: { available: false, max: 8, active: false, endsAt: null, rooms: [] },
  breakoutId: null,
  peerStreams: new Map(),
  roomPeers: null,
  panes: loadPanes(),
  sceneForm: { type: 'title' },
  inCall: false,
  publishing: false,
  join: null,
  reconnecting: false,
  mail: { enabled: false, from: null },
};

const hasControl = () => canControlBroadcast(state.role);
const isHost = () => state.role === 'host';

function wsUrl() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

/**
 * Keep the compositor in step with the studio.
 *
 * The server owns the *list* of sources, the browser owns the *media* for the
 * ones it captured itself, so they are merged by id. Every render path calls
 * this, which is why a camera, screen share or overlay shows up on the program
 * preview immediately instead of after a re-join.
 */
const PANE_KEY = 'quandrite.panes';
const PANES = ['program', 'participants', 'sources', 'sidebar'];

function loadPanes() {
  const panes = { program: true, participants: true, sources: true, sidebar: true };
  try {
    const stored = JSON.parse(localStorage.getItem(PANE_KEY) || '{}');
    for (const pane of PANES) if (typeof stored[pane] === 'boolean') panes[pane] = stored[pane];
  } catch {
    // a corrupt preference just means the defaults
  }
  return panes;
}

/** Show or hide the stage panes, independently of the role gating. */
function applyPaneVisibility() {
  for (const pane of PANES) {
    const shown = state.panes[pane] !== false;
    for (const node of document.querySelectorAll(`[data-pane="${pane}"]`)) {
      node.classList.toggle('pane-hidden', !shown);
    }
    const toggle = document.querySelector(`#pane-toggles button[data-pane="${pane}"]`);
    if (toggle) toggle.setAttribute('aria-pressed', shown ? 'true' : 'false');
  }
  const layout = document.querySelector('main.layout');
  if (layout) layout.classList.toggle('sidebar-hidden', state.panes.sidebar === false);
}

function setPane(pane, shown) {
  if (!PANES.includes(pane)) return;
  state.panes[pane] = Boolean(shown);
  try {
    localStorage.setItem(PANE_KEY, JSON.stringify(state.panes));
  } catch {
    // private mode: the choice simply does not persist
  }
  applyPaneVisibility();
}

function togglePane(pane) {
  setPane(pane, state.panes[pane] === false);
}

/** The camera I have published into the studio, if any. */
function myCameraSource() {
  return state.camera.list().find((source) => source.kind === 'camera') || null;
}

/** Enable or disable the microphone on every local source at once. */
function setLocalAudio(enabled) {
  for (const source of state.camera.list()) {
    for (const track of source.stream?.getAudioTracks?.() || []) track.enabled = enabled;
  }
  state.meeting.setMicEnabled(enabled);
  const button = $('#btn-toggle-mic');
  if (button) button.textContent = enabled ? 'Mute' : 'Unmute';
}

function syncCompositorSources() {
  const local = new Map(state.camera.list().map((source) => [source.id, source]));
  state.compositor.setSources(
    state.sources.map((source) => {
      const media = local.get(source.id);
      return {
        ...source,
        stream: media?.stream || null,
        video: media?.video || null,
        meta: { ...(source.meta || {}), ...(media?.meta || {}) },
      };
    }),
  );
}

/** My location: a breakout room id, or the main room when it is null. */
function myRoomKey() {
  return state.breakoutId || 'main';
}

function roomKeyOf(member) {
  return member?.breakoutId || 'main';
}

/**
 * Who the meeting call should be connected to.
 *
 * The mesh only spans the room you are in: a breakout cannot hear the main room
 * or the other breakouts, and the host in the main room hears nobody who left.
 */
function meetingPeerIds() {
  const mine = myRoomKey();
  return state.members.filter((member) => roomKeyOf(member) === mine).map((member) => member.id);
}

function syncMeetingPeers() {
  if (state.inCall) state.meeting.sync(meetingPeerIds());
}

function breakoutLabel(breakoutId) {
  if (!breakoutId) return 'main room';
  return state.breakouts.rooms.find((room) => room.id === breakoutId)?.label || 'breakout room';
}

const SOURCE_KIND_LABELS = { virtual: 'participant' };

function sourceKindLabel(kind) {
  return SOURCE_KIND_LABELS[kind] || kind;
}

/** The members of the room I am in (the main room or the breakout I attend). */
function roomMembers(list = state.members) {
  const mine = myRoomKey();
  return list.filter((member) => roomKeyOf(member) === mine);
}

function roomName() {
  return state.breakoutId ? breakoutLabel(state.breakoutId) : 'the main room';
}

/**
 * Remember who is in my room, and announce arrivals to everyone in it - a
 * participant joining is visible to the host and to the whole room, whether
 * they are in the main room or in a breakout.
 */
function trackRoomPeers(members = state.members, { announce = false }: any = {}) {
  const next = new Map(roomMembers(members).map((member) => [member.id, member.name]));
  if (announce && state.roomPeers) {
    for (const [id, name] of next) {
      if (id !== state.clientId && !state.roomPeers.has(id)) toast(`${name} joined ${roomName()}`, 'ok');
    }
  }
  state.roomPeers = next;
}

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

/**
 * The strip of everyone in the room, with live video as soon as the call mesh
 * delivers it. It is visible to every role, so joining is never invisible.
 */
/** The source of mine that can be shown (a camera or a screen, not a mic). */
function myOwnSource() {
  return state.sources.find((source) => source.ownerId === state.clientId && source.kind !== 'audio') || null;
}

/** Ask the host to put one of my sources in the grid or on air. */
function askToBeShown(mode) {
  const source = myOwnSource();
  if (!source) {
    toast('Start your camera first', 'error');
    return;
  }
  send(CLIENT.SOURCE_UPDATE, { sourceId: source.id, patch: { request: mode } });
}

function withdrawRequest() {
  const source = myOwnSource();
  if (!source?.request) return;
  send(CLIENT.SOURCE_UPDATE, { sourceId: source.id, patch: { request: null } });
}

/**
 * The controls on my own tile in the room strip: microphone, camera and - for
 * viewers and visitors - the buttons that ask the host to show them.
 *
 * Built once and updated in place, so the video never flickers.
 */
function myTileActions() {
  return el('div', { class: 'tile-actions' }, [
    el('button', { class: 'tiny', dataset: { tile: 'mic' }, onclick: () => toggleMyMedia('mic') }),
    el('button', { class: 'tiny ghost', dataset: { tile: 'camera' }, onclick: () => toggleMyMedia('camera') }),
    el('button', { class: 'tiny ghost', dataset: { tile: 'grid' }, onclick: () => askToBeShown('grid') }),
    el('button', { class: 'tiny ghost', dataset: { tile: 'air' }, onclick: () => askToBeShown('air') }),
    el('button', { class: 'tiny ghost', dataset: { tile: 'withdraw' }, onclick: withdrawRequest }),
  ]);
}

/** Keep those buttons honest: labels, state and what is worth showing. */
function updateMyTileActions(tile, member) {
  const mic = tile.querySelector('[data-tile="mic"]');
  if (!mic) return;
  mic.textContent = member.muted ? '\u{1F507} Unmute' : '\u{1F3A4} Mute';
  mic.title = member.muted ? 'Turn your microphone on' : 'Mute your microphone';
  mic.classList.toggle('ghost', member.muted);

  const camera = tile.querySelector('[data-tile="camera"]');
  camera.textContent = member.cameraEnabled ? '\u{1F4F9} Stop video' : '\u{1F4F7} Start video';
  camera.title = member.cameraEnabled ? 'Stop publishing your camera' : 'Publish your camera';
  camera.classList.toggle('ghost', !member.cameraEnabled);

  const source = myOwnSource();
  const withdraw = tile.querySelector('[data-tile="withdraw"]');
  // The host and co-hosts place sources directly, so asking is for the rest.
  const canAsk = !hasControl() && Boolean(source) && !source.request;
  for (const mode of ['grid', 'air']) {
    const button = tile.querySelector(`[data-tile="${mode}"]`);
    button.classList.toggle('hidden', !canAsk);
    button.textContent = mode === 'grid' ? 'ask for grid' : 'ask for air';
  }
  withdraw.classList.toggle('hidden', !source?.request);
  if (source?.request) withdraw.textContent = `asked for ${source.request} \u2715`;
}

function renderParticipants() {
  const strip = $('#participant-strip');
  if (!strip) return;
  const members = roomMembers();

  const label = $('#participant-room-label');
  if (label) label.textContent = state.breakoutId ? breakoutLabel(state.breakoutId) : 'main room';
  const count = $('#participant-count');
  if (count) {
    const elsewhere = state.members.length - members.length;
    count.textContent = [`${members.length} here`, elsewhere > 0 ? `${elsewhere} elsewhere` : null]
      .filter(Boolean)
      .join(' \u00b7 ');
  }

  const seen = new Set();
  for (const member of members) {
    seen.add(member.id);
    const isMe = member.id === state.clientId;
    // My own video comes from my camera, everyone else's from the call mesh.
    const stream = state.peerStreams.get(member.id) || (isMe ? state.camera.primaryStream() : null);

    let tile = strip.querySelector(`[data-peer="${member.id}"]`);
    if (!tile) {
      const children = [
        el('div', { class: 'avatar' }),
        el('div', { class: 'name' }),
        el('div', { class: 'sub' }),
      ];
      // Everyone controls their own media right where they see themselves.
      if (isMe) children.push(myTileActions());
      tile = el('div', { class: 'participant-tile', dataset: { peer: member.id } }, children);
      strip.append(tile);
    }

    const video = tile.querySelector('video');
    if (stream && !video) {
      const node = el('video', { autoplay: true, playsInline: true, muted: true });
      node.srcObject = stream;
      tile.prepend(node);
      tile.classList.add('live');
    } else if (stream && video && video.srcObject !== stream) {
      video.srcObject = stream;
    } else if (!stream && video) {
      video.remove();
      tile.classList.remove('live');
    }

    tile.querySelector('.avatar').textContent = initials(member.name);
    const name = tile.querySelector('.name');
    name.textContent = `${member.name}${isMe ? ' (you)' : ''} `;
    name.append(el('span', { class: `role-badge role-${member.role}`, text: roleLabel(member.role) }));
    tile.querySelector('.sub').textContent = [
      member.muted ? 'muted' : 'mic on',
      member.cameraEnabled ? 'camera on' : 'camera off',
    ].join(' \u00b7 ');
    if (isMe) updateMyTileActions(tile, member);
  }

  for (const tile of [...strip.querySelectorAll('.participant-tile')]) {
    if (!seen.has(tile.dataset.peer)) tile.remove();
  }

  const empty = strip.querySelector('.participant-empty');
  if (!members.length && !empty) {
    strip.append(el('p', { class: 'participant-empty muted', text: 'No one is in this room yet.' }));
  } else if (members.length && empty) {
    empty.remove();
  }
}

// ------------------------------------------------------------------ bootstrap

function boot() {
  state.socket = new QuandriteSocket({ url: wsUrl() });
  state.camera = new CameraManager({ socket: state.socket });
  state.compositor = new ProgramCompositor({ canvas: $('#program-canvas') });
  state.publisher = new StreamPublisher({ socket: state.socket, compositor: state.compositor });
  state.meeting = new MeetingMesh({ socket: state.socket });

  state.compositor.start();

  wireSocket();
  wireCamera();
  wirePublisher();
  wireMeeting();
  wireControls();

  state.socket.connect();

  // Audio contexts need a user gesture; resume on the first interaction.
  const resumeAudio = () => state.compositor.resumeAudio();
  document.addEventListener('pointerdown', resumeAudio, { once: true });
  document.addEventListener('keydown', resumeAudio, { once: true });

  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('#join-room').value = params.get('room');
  if (params.get('name')) $('#join-name').value = params.get('name');

  // Nothing can be published before joining a room.
  updateControlAvailability();
  applyPaneVisibility();
  // Before joining there are no studio controls, so open on the roster.
  if (!hasControl()) activateTab('people');
}

function wireSocket() {
  const socket = state.socket;

  socket.on('open', () => {
    setPill('#connection-pill', 'online', 'online');
    // A dropped connection re-joins the room on its own: no page refresh.
    if (state.reconnecting && state.join) rejoinRoom();
  });

  socket.on('close', () => {
    setPill('#connection-pill', 'offline', 'reconnecting');
    if (state.roomId) state.reconnecting = true;
  });

  socket.on(SERVER.WELCOME, (message) => {
    state.clientId = message.clientId;
    state.overlayDefinitions = message.overlayDefinitions || {};
    state.platforms = message.platforms || [];
    state.mail = message.mail || { enabled: false, from: null };
    renderSceneButtons();
    renderPlatformOptions();
    renderCredentials();
  });

  socket.on(SERVER.CHAT_NEW, (message) => appendChat(message));

  socket.on(SERVER.MEMBERS_UPDATE, (members) => {
    state.members = members;
    const me = members.find((member) => member.id === state.clientId);
    if (me) {
      state.role = me.role;
      setPill('#role-pill', `role-${me.role}`, me.role);
      updateControlAvailability();
    }
    renderMembers();
    renderPeople();
    renderBreakouts();
    trackRoomPeers(members, { announce: true });
    renderParticipants();
    syncMeetingPeers();
  });

  socket.on(SERVER.BREAKOUTS_UPDATE, (breakouts) => {
    state.breakouts = breakouts || state.breakouts;
    renderBreakouts();
    renderPeople();
  });

  // The server moved this session between the main room and a breakout room.
  socket.on(SERVER.BREAKOUT_UPDATE, (message) => {
    state.breakoutId = message.breakoutId ?? null;
    state.breakouts = message.breakouts || state.breakouts;
    if (Array.isArray(message.members)) state.members = message.members;
    // The studio state always comes from the parent room and the chat from the
    // room just entered, so the roster is left as it is.
    applySnapshot(message.state, { roster: false });
    renderBreakouts();
    renderPeople();
    trackRoomPeers(state.members, { announce: false });
    renderParticipants();
    syncMeetingPeers();
    toast(
      state.breakoutId
        ? `You are in ${breakoutLabel(state.breakoutId)}`
        : 'You are back in the main room',
      'ok',
    );
  });

  socket.on(SERVER.SOURCES_UPDATE, (sources) => {
    const previous = new Map(state.sources.map((source) => [source.id, source.request ?? null]));
    state.sources = sources;
    // Refresh the preview first: a new camera/screen must appear on the program
    // picture even when it was added by another member.
    syncCompositorSources();
    renderSources();
    renderSceneFormForScreens();
    // The host hears about a request the moment it is made.
    announceRequests(previous);
    renderPeople();
  });

  socket.on(SERVER.PROGRAM_UPDATE, (program) => {
    state.program = program;
    state.compositor.setProgram(program);
    syncCompositorSources();
    renderProgramControls();
    renderSources();
  });

  socket.on(SERVER.SCENE_UPDATE, (scene) => {
    state.scene = scene;
    state.compositor.setScene(scene);
    renderSceneCurrent();
  });

  socket.on(SERVER.DESTINATIONS_UPDATE, (destinations) => {
    state.destinations = destinations;
    renderDestinations();
  });

  socket.on(SERVER.STREAM_UPDATE, (stream) => {
    state.stream = stream;
    renderStreamStatus();
  });

  socket.on(SERVER.RECORDING_UPDATE, (recording) => {
    state.recording = recording;
    renderStreamStatus();
    if (recording.status === 'ready') loadRecordings();
  });

  // The library is pushed, so the tab is always current.
  socket.on(SERVER.RECORDINGS_UPDATE, (message) => {
    if (message.roomId && message.roomId !== state.roomId) return;
    renderRecordings(message.recordings || []);
  });

  socket.on(SERVER.WEBRTC_SIGNAL, (message) => {
    state.meeting.handleSignal(message);
  });

  // The host or a co-host switched my microphone or camera for me.
  socket.on(SERVER.MEMBER_MEDIA, (message) => {
    if (message.muted !== undefined) setLocalAudio(!message.muted);
    if (message.cameraEnabled === false) {
      const source = myCameraSource();
      if (source) state.camera.removeSource(source.id);
    }
    const who = message.byName || 'The host';
    toast(
      message.muted === true
        ? `${who} muted you`
        : message.cameraEnabled === false
          ? `${who} stopped your video`
          : `${who} changed your media`,
      'info',
    );
  });

  socket.on('server-error', (message) => {
    if (message.message) toast(message.message, 'error');
  });
}

function setPill(selector, className, text) {
  const node = $(selector);
  if (!node) return;
  node.className = `pill ${className || ''}`.trim();
  node.textContent = text;
}

// --------------------------------------------------------------- join & room

async function joinRoom({ name, roomId, role, password, silent = false }) {
  state.name = name;
  state.roomId = roomId;
  // Kept so a reconnect can re-join without asking again (memory only).
  state.join = { name, roomId, role, password };
  const result = await state.socket.join({ roomId, name, role, password });
  state.role = result.role;
  state.clientId = result.clientId;
  state.roomId = result.roomId;
  state.credentials = result.credentials || null;
  state.breakoutId = null;

  applySnapshot(result.snapshot);
  setPill('#role-pill', `role-${result.role}`, result.role);
  setPill('#connection-pill', 'online', 'online');
  if (!silent) toast(`Joined ${result.roomId} as ${result.role}`, 'ok');
  updateControlAvailability();
  renderCredentials();
  // Hosts and co-hosts land on the studio controls; watchers land on the roster.
  activateTab(hasControl() ? 'scenes' : 'people');
  loadRecordings();
}

/** Re-join after a dropped connection, so a blip never needs a page refresh. */
async function rejoinRoom() {
  const join = state.join;
  if (!join) return;
  try {
    await joinRoom({ ...join, silent: true });
    state.reconnecting = false;
    toast('Reconnected', 'ok');
  } catch (error) {
    toast(`reconnect failed: ${error.message}`, 'error');
  }
}

function applySnapshot(snapshot, { roster = true }: any = {}) {
  if (!snapshot) return;
  // The roster belongs to the parent room: a breakout move keeps it as it is.
  if (roster) state.members = snapshot.members || [];
  state.sources = snapshot.sources || [];
  state.program = snapshot.program || state.program;
  state.scene = snapshot.scene || null;
  state.destinations = snapshot.destinations || [];
  state.stream = snapshot.stream || state.stream;
  state.recording = snapshot.recording || state.recording;
  state.presets = snapshot.presets || state.presets;
  state.breakouts = snapshot.breakouts || state.breakouts;

  state.compositor.setProgram(state.program);
  state.compositor.setScene(state.scene);
  state.compositor.setBadges({ label: snapshot.room?.name || 'Quandrite' });
  syncCompositorSources();

  clear($('#chat-log'));
  for (const message of snapshot.chat || []) appendChat(message);

  renderMembers();
  renderPeople();
  renderSources();
  renderDestinations();
  renderStreamStatus();
  renderSceneCurrent();
  renderProgramControls();
  renderPresetOptions();
  renderCredentials();
  renderBreakouts();
  trackRoomPeers(state.members, { announce: false });
  renderParticipants();
  applyRoleVisibility();
}

// ------------------------------------------------------------------ renderers

function renderMembers() {
  const list = $('#member-list');
  clear(list);
  for (const member of state.members) {
    const isMe = member.id === state.clientId;
    list.append(
      el('li', {}, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'title', text: `${member.name}${isMe ? ' (you)' : ''}` }),
          el('div', {
            class: 'sub',
            text: [
              member.role,
              member.muted ? 'muted' : 'mic on',
              member.cameraEnabled ? 'camera on' : 'camera off',
              member.screenSharing ? 'sharing screen' : null,
            ]
              .filter(Boolean)
              .join(' \u00b7 '),
          }),
        ]),
      ]),
    );
  }
  if (!state.members.length) {
    list.append(el('li', {}, [el('div', { class: 'grow', text: 'No one here yet.' })]));
  }
}

const ROLE_LABELS = { host: 'host', cohost: 'co-host', viewer: 'viewer', visitor: 'visitor' };

function roleLabel(role) {
  return ROLE_LABELS[role] || role || 'viewer';
}

/**
 * The People tab: everyone in the room (host, co-hosts, viewers and visitors)
 * with the role controls only the host is allowed to use.
 */
function renderPeople() {
  const list = $('#people-list');
  if (!list) return;
  clear(list);

  const host = state.members.find((member) => member.role === 'host');
  const cohosts = state.members.filter((member) => member.role === 'cohost');
  const watching = state.members.filter((member) => !canControlBroadcast(member.role));
  const summary = $('#people-summary');
  if (summary) {
    summary.textContent = state.members.length
      ? `${state.members.length} in the room \u00b7 host: ${host ? host.name : '-'} \u00b7 ${cohosts.length} co-host(s) \u00b7 ${watching.length} watching`
      : 'No one has joined yet.';
  }

  // Zoom-style header count and footer state.
  const count = $('#people-count');
  if (count) count.textContent = `(${state.members.length})`;
  const me = state.members.find((member) => member.id === state.clientId);
  const unmute = $('#btn-unmute-me');
  if (unmute) unmute.disabled = !me?.muted;
  const claim = $('#btn-claim-host');
  if (claim) claim.classList.toggle('hidden', isHost());

  for (const member of state.members) {
    const isMe = member.id === state.clientId;
    const inBreakout = Boolean(member.breakoutId);
    // Zoom-style row: the media controls come first, then the host's tools.
    const actions = el('div', { class: 'person-actions' }, [
      mediaButton(member, 'mic'),
      mediaButton(member, 'camera'),
    ]);

    if (isHost() && !isMe) {
      if (member.role !== 'cohost') actions.append(roleButton('co-host', 'cohost', member));
      if (member.role !== 'host') actions.append(roleButton('host', 'host', member));
      if (canControlBroadcast(member.role)) actions.append(roleButton('viewer', 'viewer', member));
    }
    // Moving people between rooms: the host moves anyone, everyone can move
    // themselves into an open breakout.
    if ((hasControl() || isMe) && (state.breakouts.rooms || []).length) actions.append(breakoutSelect(member));
    if (isMe) actions.append(...myShowControls());

    list.append(
      el('li', { class: 'person' }, [
        el('div', { class: 'person-avatar', text: initials(member.name) }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'title' }, [
            `${member.name}${isMe ? ' (you)' : ''}`,
            el('span', { class: `role-badge role-${member.role}`, text: roleLabel(member.role) }),
            (state.breakouts.rooms || []).length
              ? el('span', {
                  class: `role-badge location${inBreakout ? ' in-breakout' : ''}`,
                  text: inBreakout ? breakoutLabel(member.breakoutId) : 'main room',
                })
              : null,
          ]),
          el('div', {
            class: 'sub',
            text: [
              member.muted ? 'muted' : 'mic on',
              member.cameraEnabled ? 'camera on' : 'camera off',
              member.screenSharing ? 'sharing screen' : null,
              `joined ${fmtTime(member.joinedAt)}`,
            ]
              .filter(Boolean)
              .join(' \u00b7 '),
          }),
        ]),
        actions,
      ]),
    );
  }

  if (!state.members.length) {
    list.append(el('li', {}, [el('div', { class: 'grow muted', text: 'No one here yet.' })]));
  }
}

/**
 * Zoom-style mic/camera control.
 *
 * My own buttons switch my own media; the host and co-hosts can switch anyone
 * else's, which the other client applies immediately.
 */
function mediaButton(member, kind) {
  const isMe = member.id === state.clientId;
  const on = kind === 'mic' ? !member.muted : member.cameraEnabled;
  const action = kind === 'mic' ? (on ? 'Mute' : 'Unmute') : on ? 'Stop video' : 'Start video';
  const icon = kind === 'mic' ? (on ? '\u{1F3A4}' : '\u{1F507}') : on ? '\u{1F4F9}' : '\u{1F4F7}';

  if (!isMe && !hasControl()) {
    return el('span', {
      class: `media-state ${on ? 'on' : 'off'}`,
      text: `${icon} ${on ? 'on' : 'off'}`,
      title: `${member.name} \u00b7 ${on ? 'on' : 'off'}`,
    });
  }

  return el('button', {
    class: `tiny ${on ? '' : 'ghost'}`,
    dataset: { media: kind, member: member.id },
    title: `${action}${isMe ? ' (you)' : ` ${member.name}`}`,
    text: `${icon} ${action}`,
    onclick: () =>
      isMe
        ? toggleMyMedia(kind)
        : send(CLIENT.MEMBER_MEDIA, {
            memberId: member.id,
            ...(kind === 'mic' ? { muted: !member.muted } : { cameraEnabled: !member.cameraEnabled }),
          }),
  });
}

/** My own "show me" controls: ask the host for the grid or for the air. */
function myShowControls() {
  if (hasControl()) return [];
  const controls = [];
  for (const source of state.sources.filter(
    (entry) => entry.ownerId === state.clientId && entry.kind !== 'audio',
  )) {
    if (source.request) {
      controls.push(
        el('button', {
          class: 'tiny ghost',
          title: `Withdraw the request for ${source.label}`,
          text: `asked for ${source.request} \u2715`,
          onclick: () => send(CLIENT.SOURCE_UPDATE, { sourceId: source.id, patch: { request: null } }),
        }),
      );
      continue;
    }
    controls.push(
      el('button', {
        class: 'tiny',
        title: `Ask the host to put ${source.label} in the grid`,
        text: 'ask for grid',
        onclick: () => send(CLIENT.SOURCE_UPDATE, { sourceId: source.id, patch: { request: 'grid' } }),
      }),
      el('button', {
        class: 'tiny',
        title: `Ask the host to put ${source.label} on air`,
        text: 'ask for air',
        onclick: () => send(CLIENT.SOURCE_UPDATE, { sourceId: source.id, patch: { request: 'air' } }),
      }),
    );
  }
  return controls;
}

/** Host-only role change: grant a co-host without a password, or hand over host. */
function roleButton(text, role, member) {
  return el('button', {
    class: 'tiny',
    title: `Make ${member.name} a ${roleLabel(role)}`,
    text,
    onclick: async () => {
      const result = await send(CLIENT.MEMBER_ROLE, { memberId: member.id, role });
      if (result) toast(`${member.name} is now a ${roleLabel(role)}`, 'ok');
    },
  });
}

/** Show the host the room passwords so they can share them (never for others). */
function renderCredentials() {
  const host = $('#credential-host');
  const cohost = $('#credential-cohost');
  if (!host || !cohost) return;
  host.value = state.credentials?.hostPassword || '';
  cohost.value = state.credentials?.cohostPassword || '';
  // Mailing is only offered when the server has a transport configured.
  const mailRow = $('#credential-email-row');
  if (mailRow) mailRow.classList.toggle('hidden', !state.mail?.enabled);
  const status = $('#credential-status');
  if (status) {
    status.textContent = state.credentials
      ? 'Only the host can see these. Share the co-host password so people can claim the role themselves.'
      : 'Join as the host to see the room passwords.';
  }
}

/** Mail the host password to an address the host controls. */
async function emailHostPassword() {
  if (!isHost()) return;
  const email = $('#credential-email').value.trim();
  const status = $('#credential-mail');
  if (!email) {
    if (status) status.textContent = 'Type an email address first.';
    return;
  }
  if (!state.credentials?.hostPassword) {
    if (status) status.textContent = 'Join as the host first.';
    return;
  }

  if (status) status.textContent = 'Sending...';
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(state.roomId)}/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: state.credentials.hostPassword, role: 'host' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `mail failed (${response.status})`);
    if (status) status.textContent = `Sent to ${data.to} via ${data.via}.`;
    toast(`Host password emailed to ${data.to}`, 'ok');
  } catch (error) {
    if (status) status.textContent = error.message;
    toast(error.message, 'error');
  }
}

/**
 * The breakout catalogue: where I am, and - for the host - the rooms with their
 * open state and one-click open/close/join.
 */
function renderBreakouts() {
  const breakouts = state.breakouts || {};
  const rooms = breakouts.rooms || [];

  const pill = $('#breakout-pill');
  if (pill) {
    const inBreakout = Boolean(state.breakoutId);
    pill.classList.toggle('hidden', !inBreakout && rooms.length === 0);
    pill.className = inBreakout ? 'pill breakout' : 'pill';
    pill.textContent = inBreakout ? breakoutLabel(state.breakoutId) : 'main room';
  }

  const banner = $('#breakout-banner');
  if (banner) {
    banner.classList.toggle('hidden', !state.breakoutId);
    const text = $('#breakout-banner-text');
    if (text) text.textContent = `You are in ${breakoutLabel(state.breakoutId)} - only this room can hear you.`;
  }

  const summary = $('#breakout-summary');
  const list = $('#breakout-list');
  if (!list || !summary) return;
  clear(list);

  if (!rooms.length) {
    summary.textContent =
      breakouts.available === false
        ? 'Breakout rooms are not available on this server.'
        : 'No breakout rooms yet - pick how many and press Create.';
    return;
  }

  const remaining = breakouts.endsAt ? Math.max(0, breakouts.endsAt - Date.now()) : 0;
  summary.textContent = [
    `${rooms.length} room(s)`,
    rooms.some((room) => room.open) ? 'open' : 'closed',
    breakouts.active && breakouts.endsAt ? `closing in ${fmtDuration(remaining)}` : null,
    `you are in the ${state.breakoutId ? breakoutLabel(state.breakoutId) : 'main room'}`,
  ]
    .filter(Boolean)
    .join(' \u00b7 ');

  for (const room of rooms) {
    const item = el('li', { class: room.open ? '' : 'off' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'title', text: room.label }),
        el('div', {
          class: 'sub',
          text: `${room.open ? 'open' : 'closed'} \u00b7 ${room.memberCount} in the room${
            state.breakoutId === room.id ? ' \u00b7 you are here' : ''
          }`,
        }),
      ]),
    ]);

    if (hasControl()) {
      item.append(
        el('button', {
          class: 'tiny',
          title: room.open ? `Close ${room.label}` : `Open ${room.label}`,
          text: room.open ? 'close' : 'open',
          onclick: () =>
            send(room.open ? CLIENT.BREAKOUT_CLOSE : CLIENT.BREAKOUT_OPEN, { breakoutId: room.id }),
        }),
        el('button', {
          class: 'tiny',
          title: `Move yourself into ${room.label}`,
          text: 'join',
          onclick: () => send(CLIENT.BREAKOUT_ASSIGN, { breakoutId: room.id }),
        }),
      );
    }

    list.append(item);
  }
}

/** A picker that moves one member between the main room and the breakouts. */
function breakoutSelect(member) {
  const select = el('select', {
    class: 'tiny',
    title: `Move ${member.name} to another room`,
    onchange: (event) => {
      send(CLIENT.BREAKOUT_ASSIGN, { memberId: member.id, breakoutId: event.target.value || null });
    },
  });
  select.append(el('option', { value: '', text: 'main room' }));
  for (const room of state.breakouts.rooms || []) {
    select.append(el('option', { value: room.id, text: `${room.label}${room.open ? '' : ' (closed)'}` }));
  }
  select.value = member.breakoutId || '';
  return select;
}

/**
 * Hide every host-only pane from viewers and visitors: adding cameras and
 * screens, program switching, overlays, platforms, going live and passwords.
 */
function applyRoleVisibility() {
  for (const node of document.querySelectorAll('[data-requires]')) {
    const allowed = node.dataset.requires === 'host' ? isHost() : hasControl();
    node.classList.toggle('hidden', !allowed);
  }
}

/** Switch sidebar tab and paint it from the state we already have. */
function activateTab(name) {
  const tabs = $('#tabs');
  if (!tabs) return;
  for (const node of tabs.querySelectorAll('button')) node.classList.toggle('active', node.dataset.tab === name);
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('hidden', panel.dataset.panel !== name);
  }

  // A click must never show a stale panel: render its content right away and
  // only then refresh anything that comes from the network.
  if (name === 'scenes') {
    renderSceneButtons();
    renderSceneCurrent();
  } else if (name === 'people') {
    renderPeople();
    renderBreakouts();
    renderCredentials();
  } else if (name === 'platforms') {
    renderDestinations();
    renderStreamStatus();
    renderPresetOptions();
  } else if (name === 'meeting') {
    renderMembers();
  } else if (name === 'recordings') {
    renderRecordings(state.recordings);
    loadRecordings();
  }
}

/** Rebuild the scene form when the set of screens changed, so it stays accurate. */
function renderSceneFormForScreens() {
  if (state.sceneForm.type !== 'screenshare') return;
  const key = state.sources
    .filter((source) => source.kind === 'screen')
    .map((source) => source.id)
    .join(',');
  if (key === state.sceneForm.screenKey) return;
  renderSceneForm();
}

function renderSources() {
  const grid = $('#source-grid');
  clear(grid);
  $('#source-count').textContent = `(${state.sources.length})`;

  const localIds = new Set(state.camera.list().map((source) => source.id));
  const onAir = new Set(state.program.onAir || []);
  renderSourceRequests();

  if (!state.sources.length) {
    grid.append(el('p', { class: 'muted', text: 'No sources yet.' }));
    $('#program-empty').classList.remove('hidden');
    return;
  }
  $('#program-empty').classList.add('hidden');

  for (const source of state.sources) {
    const local = state.camera.get(source.id);
    const tile = el('div', { class: `source-tile ${onAir.has(source.id) ? 'on-air' : ''}` });

    if (local?.video) {
      tile.append(local.video);
    } else {
      tile.append(
        el('div', {
          class: 'muted',
          style: { padding: '18px 10px', textAlign: 'center', fontSize: '12px' },
          text: `${source.ownerName} \u00b7 ${sourceKindLabel(source.kind)}`,
        }),
      );
    }

    const bar = el('div', { class: 'tile-bar' }, [
      el('span', { class: 'name', text: source.label }),
      el('span', { class: 'muted', text: sourceKindLabel(source.kind) }),
    ]);

    // What the owner asked for, visible the moment it arrives.
    if (source.request) {
      bar.append(
        el('span', {
          class: 'request-badge',
          text: source.request === 'air' ? 'wants air' : 'wants grid',
          title: `${source.ownerName || 'The owner'} asked to be ${
            source.request === 'air' ? 'put on air' : 'added to the grid'
          }`,
        }),
      );
    }

    if (hasControl()) {
      bar.append(
        el('button', {
          class: `tiny${source.request === 'air' ? ' primary' : ''}`,
          title: source.request === 'air' ? 'Apply: put this source on the program' : 'Put this source on the program output',
          text: onAir.has(source.id) ? 'on air' : 'air',
          onclick: () => sendProgram({ mode: 'single', sourceId: source.id }),
        }),
        el('button', {
          class: `tiny${source.request === 'grid' ? ' primary' : ''}`,
          title: source.request === 'grid' ? 'Apply: add this source to the grid' : 'Toggle this source in the multi-camera grid',
          text: (state.program.gridIds || []).includes(source.id) ? 'grid \u2713' : 'grid',
          onclick: () => {
            const current = new Set(state.program.gridIds || []);
            if (current.has(source.id)) current.delete(source.id);
            else current.add(source.id);
            const gridIds = [...current];
            sendProgram(gridIds.length ? { mode: 'grid', gridIds } : { mode: 'single' });
          },
        }),
      );
    }

    if (localIds.has(source.id)) {
      bar.append(
        el('button', {
          class: 'tiny danger',
          title: 'Stop and remove this source',
          text: '\u2715',
          onclick: () => state.camera.removeSource(source.id),
        }),
      );
    }

    tile.append(bar);
    grid.append(tile);
  }
}

/** One line of requests with a one-click apply, for the host and co-hosts. */
function renderSourceRequests() {
  const host = $('#source-requests');
  if (!host) return;
  const requests = state.sources.filter((source) => source.request);
  clear(host);

  if (!requests.length) {
    host.classList.add('hidden');
    return;
  }
  host.classList.remove('hidden');
  host.append(el('span', { text: `${requests.length} request(s): ` }));
  for (const source of requests) {
    host.append(
      el('button', {
        class: 'tiny primary',
        title: `Put ${source.label} ${source.request === 'air' ? 'on air' : 'in the grid'}`,
        text: `${source.label} \u2192 ${source.request}`,
        onclick: () => applyRequest(source),
      }),
    );
  }
}

function renderProgramControls() {
  for (const button of $('#program-mode').querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.mode === state.program.mode);
  }
  const labels = (state.program.onAir || [])
    .map((id) => state.sources.find((source) => source.id === id)?.label || id)
    .join(', ');
  $('#on-air-label').textContent = `On air: ${labels || '-'}`;
}

function renderSceneCurrent() {
  const node = $('#scene-current');
  if (!state.scene) {
    node.textContent = 'No overlay on air.';
    node.className = 'scene-current muted';
    return;
  }
  const seconds = state.scene.persistent ? 'until cleared' : `${Math.round(state.scene.durationMs / 1000)}s`;
  const detail = Object.entries(state.scene.payload || {})
    .filter(([, value]) => value !== '' && value !== null && value !== false)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 40)}`)
    .join(' \u00b7 ');
  node.textContent = `${state.scene.type} (${seconds}) ${detail}`;
  node.className = 'scene-current';
}

function renderDestinations() {
  const list = $('#destination-list');
  clear(list);
  if (!state.destinations.length) {
    list.append(el('li', {}, [el('div', { class: 'grow muted', text: 'No platforms yet.' })]));
    return;
  }
  for (const destination of state.destinations) {
    const item = el('li', { class: destination.enabled ? '' : 'off' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'title', text: destination.label }),
        el('div', { class: 'sub', text: destination.url || destination.platform }),
      ]),
    ]);
    if (hasControl()) {
      item.append(
        el('button', {
          class: 'tiny',
          text: destination.enabled ? 'pause' : 'resume',
          onclick: () =>
            send(CLIENT.DESTINATION_UPDATE, {
              destinationId: destination.id,
              patch: { enabled: !destination.enabled },
            }),
        }),
        el('button', {
          class: 'tiny danger',
          text: '\u2715',
          onclick: () => send(CLIENT.DESTINATION_REMOVE, { destinationId: destination.id }),
        }),
      );
    }
    list.append(item);
  }
}

function renderStreamStatus() {
  const stream = state.stream || {};
  const recording = state.recording || {};
  const lines = [];

  lines.push(`Stream: ${stream.status || 'offline'}${stream.preset ? ` \u00b7 ${stream.preset}` : ''}`);
  if (stream.status === 'live') {
    lines.push(`Bitrate: ${stream.bitrateKbps || 0} kbps \u00b7 up ${fmtDuration(stream.uptimeMs)}`);
  }
  if (stream.destinationStatuses?.length) {
    lines.push(`Destinations: ${stream.destinationStatuses.map((entry) => entry.label).join(', ')}`);
  }
  if (stream.error) lines.push(`Problem: ${stream.error}`);
  lines.push(
    `Recording: ${recording.status}${recording.sizeBytes ? ` \u00b7 ${fmtBytes(recording.sizeBytes)}` : ''}${
      recording.durationMs ? ` \u00b7 ${fmtDuration(recording.durationMs)}` : ''
    }`,
  );
  if (recording.file) lines.push(`File: ${recording.file}`);
  $('#stream-status').textContent = lines.join('\n');

  const live = ['live', 'connecting', 'reconnecting', 'stopping'].includes(stream.status);
  setPill('#live-pill', live ? 'live' : '', live ? stream.status : 'off air');
  setPill('#rec-pill', recording.status === 'recording' ? 'rec' : '', recording.status);
  $('#canvas-live-badge').classList.toggle('hidden', !live);
  $('#canvas-rec-badge').classList.toggle('hidden', recording.status !== 'recording');
  $('#program-preset').textContent = stream.preset || '1080p30';
  $('#program-bitrate').textContent = `${stream.bitrateKbps || 0} kbps`;
  $('#program-uptime').textContent = fmtDuration(stream.uptimeMs || 0);

  state.compositor.setBadges({ live, recording: recording.status === 'recording' });
  updateControlAvailability();
}

function renderPresetOptions() {
  const select = $('#stream-preset');
  clear(select);
  for (const preset of state.presets) {
    select.append(
      el('option', { value: preset.label, text: `${preset.label} \u00b7 ${preset.bitrateKbps} kbps` }),
    );
  }
  if (state.stream?.preset) select.value = state.stream.preset;
}

function renderPlatformOptions() {
  const select = $('#destination-platform');
  clear(select);
  for (const platform of state.platforms) {
    select.append(el('option', { value: platform.id, text: platform.name }));
  }
  updatePlatformHelp();
}

function updatePlatformHelp() {
  const id = $('#destination-platform').value;
  const platform = state.platforms.find((entry) => entry.id === id);
  $('#destination-help').textContent = platform ? platform.keyHelp : '';
  $('#destination-key').required = Boolean(platform && !platform.requiresOverrideUrl);
  $('#destination-key').placeholder = platform?.keyLabel || 'stream key';
}

function appendChat(message) {
  const log = $('#chat-log');
  if (!log) return;
  const line =
    message.kind === 'system'
      ? el('div', { class: 'chat-line system', text: message.text })
      : el('div', { class: 'chat-line' }, [
          el('span', { class: 'who', text: `${message.authorName}: ` }),
          el('span', { text: message.text }),
          el('span', { class: 'at', text: fmtTime(message.at) }),
        ]);
  log.append(line);
  log.scrollTop = log.scrollHeight;
}

function updateControlAvailability() {
  const live = ['live', 'connecting', 'reconnecting', 'stopping'].includes(state.stream?.status);
  const canAddSources = hasControl() && Boolean(state.roomId);
  $('#btn-go-live').disabled = !hasControl() || live;
  $('#btn-stop-live').disabled = !hasControl() || !live;
  $('#btn-clear-scene').disabled = !hasControl();
  $('#btn-open-devices').disabled = !canAddSources;
  $('#btn-mute-all').disabled = !canAddSources;
  $('#btn-stop-all-video').disabled = !canAddSources;
  $('#btn-create-breakouts').disabled = !canAddSources;
  $('#btn-open-breakouts').disabled = !canAddSources;
  $('#btn-close-breakouts').disabled = !canAddSources;
  $('#btn-shuffle-breakouts').disabled = !canAddSources;
  $('#btn-clear-breakouts').disabled = !canAddSources;
  $('#btn-join-call').disabled = !state.roomId || state.inCall;
  for (const node of document.querySelectorAll('#program-mode button')) node.disabled = !hasControl();
  // Viewers and visitors never see the host-only panes at all.
  applyRoleVisibility();
}

// ------------------------------------------------------------------- actions

async function send(type, payload: any = {}) {
  try {
    return await state.socket.send(type, payload);
  } catch (error) {
    toast(error.message, 'error');
    return null;
  }
}

function sendProgram(program) {
  if (!requireControl('Only the host or a co-host can change the program output')) return Promise.resolve(null);
  return send(CLIENT.PROGRAM_SET, program);
}

/** Guard a host-only action and explain why it is refused. */
function requireControl(message = 'Only the host or a co-host can do that') {
  if (hasControl()) return true;
  toast(message, 'error');
  return false;
}

/**
 * The camera/microphone picker: what the machine can see, and what is already
 * published into the studio.
 */
async function renderDevicePicker() {
  const host = $('#device-list-picker');
  if (!host) return;
  const devices = await state.camera.enumerate();
  clear(host);

  const rows = [
    ...devices.video.map((device, index) => ({
      kind: 'camera',
      id: device.deviceId,
      label: device.label || `Camera ${index + 1}`,
    })),
    ...devices.audio.map((device, index) => ({
      kind: 'audio',
      id: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    })),
  ];

  if (!rows.length) {
    host.append(el('p', { class: 'muted', text: 'No cameras or microphones detected yet.' }));
    return;
  }

  for (const row of rows) {
    const published =
      row.kind === 'camera'
        ? Boolean(state.camera.get(`camera:${row.id}`))
        : state.camera.list().some((source) => source.kind === 'audio' && source.deviceId === row.id);
    const checkbox = el('input', { type: 'checkbox', value: `${row.kind}:${row.id}`, checked: !published });
    host.append(
      el('label', { class: 'picker-row' }, [
        checkbox,
        el('span', { class: 'picker-name', text: row.label }),
        el('span', { class: 'muted picker-kind', text: published ? 'in the studio' : sourceKindLabel(row.kind) }),
      ]),
    );
  }
}

async function openDeviceDialog() {
  const dialog = $('#device-dialog');
  if (!dialog) return;
  await renderDevicePicker();
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDeviceDialog() {
  const dialog = $('#device-dialog');
  if (!dialog) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

/**
 * Publish the ticked devices and send them where the operator asked.
 *
 * The host and co-hosts decide what the viewers receive; anyone else asks, and
 * the request reaches the host immediately.
 */
async function addSelectedDevices(mode) {
  const picker = $('#device-list-picker');
  const status = $('#device-dialog-status');
  const ticked = [...picker.querySelectorAll('input[type="checkbox"]:checked')].map((input) =>
    input.value.split(':'),
  );

  // Nothing ticked? Then act on what is already published, or on the first
  // camera, so these buttons always do what they say immediately.
  let picked = ticked;
  if (!picked.length) {
    const published = state.camera.list().filter((source) => source.kind !== 'virtual');
    if (published.length) {
      picked = published.map((source) => [source.kind === 'camera' ? 'camera' : 'audio', source.deviceId]);
    } else {
      const devices = await state.camera.enumerate();
      if (devices.video[0]) picked = [['camera', devices.video[0].deviceId]];
    }
  }
  if (!picked.length) {
    if (status) status.textContent = 'No camera or microphone is available yet.';
    return;
  }

  if (status) status.textContent = `Adding ${picked.length} device(s)...`;
  const added = [];
  for (const [kind, deviceId] of picked) {
    const source =
      kind === 'camera'
        ? await state.camera.addCamera({ deviceId, announce: true })
        : await state.camera.addMicrophone({ deviceId });
    if (source) added.push(source);
  }

  if (status) {
    status.textContent = added.length
      ? `Added ${added.length} device(s)${
          mode === 'studio' ? '.' : ` and sent them to the ${mode === 'air' ? 'program' : 'grid'}.`
        }`
      : 'Nothing could be added.';
  }
  await applyPlacement(mode, added);
  await renderDevicePicker();
  // Close the pane so the result is visible on the program preview at once.
  closeDeviceDialog();
}

/** Put the freshly published sources in the studio, the grid or on air. */
async function applyPlacement(mode, sources) {
  const ids = sources.map((source) => source.id);
  if (!ids.length || mode === 'studio') return;

  if (!hasControl()) {
    for (const id of ids) await send(CLIENT.SOURCE_UPDATE, { sourceId: id, patch: { request: mode } });
    toast(`Asked the host to put you ${mode === 'air' ? 'on air' : 'in the grid'}`, 'ok');
    return;
  }

  if (mode === 'air') {
    await sendProgram({ mode: 'single', sourceId: ids[ids.length - 1] });
    return;
  }
  const gridIds = [...new Set([...(state.program.gridIds || []), ...ids])];
  await sendProgram({ mode: 'grid', gridIds });
}

/** Apply one member's request to the program (host and co-hosts only). */
function applyRequest(source) {
  if (!requireControl('Only the host or a co-host can change the program')) return Promise.resolve(null);
  if (source.request === 'air') return sendProgram({ mode: 'single', sourceId: source.id });
  const gridIds = [...new Set([...(state.program.gridIds || []), source.id])];
  return sendProgram({ mode: 'grid', gridIds });
}

/** Tell the host, the moment it happens, when someone asks to be shown. */
function announceRequests(previous) {
  if (!hasControl()) return;
  for (const source of state.sources) {
    if (!source.request || previous.get(source.id) === source.request) continue;
    const what = source.request === 'air' ? 'on air' : 'in the grid';
    toast(`${source.ownerName || 'Someone'} wants ${source.label || 'their camera'} ${what}`, 'info', {
      actionLabel: 'Apply',
      onAction: () => applyRequest(source),
    });
  }
}

/** Zoom-style mic/camera toggle for myself: works in or out of the call. */
async function toggleMyMedia(kind) {
  if (kind === 'mic') {
    const me = state.members.find((member) => member.id === state.clientId);
    const mute = !(me?.muted ?? false);
    setLocalAudio(!mute);
    await send(CLIENT.MEMBER_UPDATE, { patch: { muted: mute } });
    renderPeople();
    return;
  }

  const source = myCameraSource();
  if (source) {
    await state.camera.removeSource(source.id);
    state.meeting.setCameraEnabled(false);
    await send(CLIENT.MEMBER_UPDATE, { patch: { cameraEnabled: false } });
    renderPeople();
    return;
  }

  const added = await state.camera.addCamera({ announce: true });
  if (!added) return;
  const track = added.stream?.getVideoTracks?.()[0];
  // A camera published mid-call has to be attached to the existing peers.
  if (state.inCall && track) state.meeting.attachTrack(track, added.stream);
  await send(CLIENT.MEMBER_UPDATE, { patch: { cameraEnabled: true } });
  if (!hasControl()) toast('Camera published - the host can put you in the grid', 'ok');
  renderPeople();
}

const SCENE_FIELDS = {
  title: [
    { name: 'headline', label: 'Headline', type: 'text', required: true, placeholder: 'Welcome to the show' },
    { name: 'subtitle', label: 'Subtitle', type: 'text', placeholder: 'with Ada and friends' },
    {
      name: 'position',
      label: 'Position',
      type: 'select',
      options: [
        ['lower-third', 'Lower third'],
        ['top', 'Top'],
        ['center', 'Centre'],
      ],
    },
    { name: 'durationMs', label: 'Duration (seconds)', type: 'number', value: 8 },
  ],
  announcement: [
    { name: 'message', label: 'Announcement', type: 'text', required: true, placeholder: 'Q&A in five minutes' },
    {
      name: 'priority',
      label: 'Priority',
      type: 'select',
      options: [
        ['normal', 'Normal'],
        ['high', 'Urgent'],
      ],
    },
    { name: 'durationMs', label: 'Duration (seconds)', type: 'number', value: 12 },
  ],
  screenshare: [
    { name: 'sourceId', label: 'Screen source', type: 'screenSelect' },
    { name: 'caption', label: 'Badge text', type: 'text', value: 'SCREEN SHARE' },
  ],
  song: [
    { name: 'title', label: 'Song title', type: 'text', required: true, placeholder: 'Now playing' },
    { name: 'artist', label: 'Artist', type: 'text' },
    { name: 'artworkUrl', label: 'Artwork URL', type: 'text', placeholder: 'https://...' },
    { name: 'lyrics', label: 'Lyric line', type: 'text' },
    { name: 'music', label: 'Play audio file with the stream', type: 'file' },
  ],
  break: [
    { name: 'message', label: 'Message', type: 'text', value: 'We are right back.' },
    { name: 'countdown', label: 'Countdown (seconds, 0 = none)', type: 'number', value: 300 },
  ],
  ended: [
    { name: 'headline', label: 'Headline', type: 'text', value: 'Thanks for watching' },
    { name: 'message', label: 'Message', type: 'text', value: 'This livestream has ended.' },
    { name: 'showReplay', label: 'Mention the replay', type: 'checkbox', value: true },
  ],
};

/** Copy a join link so it can be pasted into a chat or an email. */
async function inviteToRoom() {
  if (!state.roomId) return;
  const url = `${location.origin}/?room=${encodeURIComponent(state.roomId)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(`Room link copied: ${url}`, 'ok');
  } catch {
    toast(`Room link: ${url}`, 'info');
  }
}

/** Zoom's "Unmute me": turn my own microphone back on. */
function unmuteMe() {
  const me = state.members.find((member) => member.id === state.clientId);
  if (!me?.muted) {
    toast('Your microphone is already on', 'info');
    return;
  }
  toggleMyMedia('mic');
}

/** Zoom's "Claim host": prove the room password and take the seat. */
async function claimHost() {
  if (!state.roomId) return;
  const password = window.prompt('Host password for this room');
  if (!password) return;
  const join = state.join || { name: state.name || 'Guest', roomId: state.roomId, role: 'viewer' };
  try {
    await joinRoom({ ...join, role: 'host', password, silent: true });
    toast('You are the host now', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/**
 * The overlay buttons in the Scenes tab.
 *
 * The catalogue arrives with the welcome message, so this is also what primes
 * the scene form. It used to be called but never defined, which threw inside the
 * welcome handler and left the scenes (and the platform list that follows it)
 * empty until the page was reloaded.
 */
function renderSceneButtons() {
  const host = $('#scene-buttons');
  if (!host) return;
  const definitions = state.overlayDefinitions || {};
  const types = Object.keys(definitions).length ? Object.keys(definitions) : [...REQUESTABLE_SCENE_TYPES];
  if (!types.includes(state.sceneForm.type)) state.sceneForm.type = types[0];

  clear(host);
  for (const type of types) {
    const definition = definitions[type] || {};
    host.append(
      el('button', {
        class: state.sceneForm.type === type ? 'active' : '',
        title: definition.description || type,
        text: definition.label || type,
        onclick: () => {
          state.sceneForm.type = type;
          renderSceneButtons();
          renderSceneForm();
        },
      }),
    );
  }
  renderSceneForm();
}

function renderSceneForm() {
  const form = $('#scene-form');
  clear(form);
  const fields = SCENE_FIELDS[state.sceneForm.type] || [];
  if (state.sceneForm.type === 'screenshare') {
    state.sceneForm.screenKey = state.sources
      .filter((source) => source.kind === 'screen')
      .map((source) => source.id)
      .join(',');
  }

  for (const field of fields) {
    const label = el('label', { text: field.label });
    if (field.type === 'select') {
      const select = el('select', { name: field.name });
      for (const [value, text] of field.options) select.append(el('option', { value, text }));
      label.append(select);
    } else if (field.type === 'screenSelect') {
      const select = el('select', { name: field.name });
      const screens = state.sources.filter((source) => source.kind === 'screen');
      select.append(
        el('option', { value: '', text: screens.length ? 'First available screen' : 'No screen shared yet' }),
      );
      for (const screen of screens) select.append(el('option', { value: screen.id, text: screen.label }));
      label.append(select);
    } else if (field.type === 'checkbox') {
      const input = el('input', { type: 'checkbox', name: field.name, checked: field.value !== false });
      label.className = 'toggle';
      label.append(input);
    } else {
      const input = el('input', {
        type: field.type === 'number' ? 'number' : field.type === 'file' ? 'file' : 'text',
        name: field.name,
        placeholder: field.placeholder || '',
        value: field.value ?? '',
        required: Boolean(field.required),
      });
      if (field.type === 'file') input.accept = 'audio/*';
      label.append(input);
    }
    form.append(label);
  }

  form.append(el('button', { class: 'primary wide', type: 'submit', text: 'Put on program' }));
}

async function submitSceneForm(event) {
  event.preventDefault();
  if (!hasControl()) {
    toast('Only the host or a co-host can add overlays', 'error');
    return;
  }
  const form = $('#scene-form');
  const data = new FormData(form);
  const type = state.sceneForm.type;
  const scene = { type, payload: {} };

  if (type === 'title') {
    scene.payload.headline = data.get('headline');
    scene.payload.subtitle = data.get('subtitle');
    scene.payload.position = data.get('position');
    scene.durationMs = Number(data.get('durationMs') || 8) * 1000;
  } else if (type === 'announcement') {
    scene.payload.message = data.get('message');
    scene.payload.priority = data.get('priority');
    scene.durationMs = Number(data.get('durationMs') || 12) * 1000;
  } else if (type === 'screenshare') {
    scene.payload.sourceId = data.get('sourceId') || null;
    scene.payload.caption = data.get('caption');
  } else if (type === 'song') {
    scene.payload.title = data.get('title');
    scene.payload.artist = data.get('artist');
    scene.payload.artworkUrl = data.get('artworkUrl');
    scene.payload.lyrics = data.get('lyrics');
    const music = form.querySelector('input[name="music"]');
    if (music?.files?.length) {
      const audio = new Audio(URL.createObjectURL(music.files[0]));
      audio.loop = true;
      if (state.compositor.attachMusic(audio)) {
        audio.play().catch(() => {});
        state.sceneForm.music = audio;
      }
    }
  } else if (type === 'break') {
    scene.payload.message = data.get('message');
    scene.payload.countdownMs = Number(data.get('countdown') || 0) * 1000;
  } else if (type === 'ended') {
    scene.payload.headline = data.get('headline');
    scene.payload.message = data.get('message');
    scene.payload.showReplay = data.get('showReplay') !== null;
  }

  const result = await send(CLIENT.SCENE_SET, { scene });
  if (result) toast(`${type} is on the program output`, 'ok');
}

async function clearScene() {
  if (!hasControl()) return;
  if (state.sceneForm.music) {
    state.sceneForm.music.pause();
    state.compositor.detachMusic();
    state.sceneForm.music = null;
  }
  await send(CLIENT.SCENE_CLEAR, {});
}

async function goLive() {
  if (!hasControl()) {
    toast('Only the host or a co-host can start the livestream', 'error');
    return;
  }
  const preset = $('#stream-preset').value;
  const record = $('#stream-record').checked;
  state.compositor.resumeAudio();
  const result = await send(CLIENT.STREAM_START, { preset, record });
  if (!result) return;

  state.compositor.start();
  if (!state.publisher.start()) {
    toast('the encoder could not start in this browser', 'error');
    await send(CLIENT.STREAM_STOP, {});
    return;
  }
  state.publishing = true;
  toast(`Live now - sending to ${result.stream?.destinationStatuses?.length || 0} destination(s)`, 'ok');
}

async function endStream() {
  if (state.publishing) {
    state.publisher.stop();
    state.publishing = false;
  }
  await send(CLIENT.STREAM_STOP, {});
}

// -------------------------------------------------------------------- wiring

function wireControls() {
  $('#join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('#join-name').value.trim();
    const roomId = $('#join-room').value.trim().toLowerCase();
    const role = $('#join-role').value;
    const password = $('#join-password').value;
    if (!name || !roomId) return;
    try {
      await joinRoom({ name, roomId, role, password });
      history.replaceState(null, '', `/?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(name)}`);
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#join-role').addEventListener('change', () => {
    const needsPassword = ['host', 'cohost'].includes($('#join-role').value);
    $('#join-password').placeholder = needsPassword ? 'Role password' : 'Not needed to watch';
    $('#join-password').disabled = !needsPassword;
    if (!needsPassword) $('#join-password').value = '';
  });

  $('#tabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]');
    if (button) activateTab(button.dataset.tab);
  });

  $('#program-mode').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    sendProgram({ mode: button.dataset.mode });
  });

  $('#scene-form').addEventListener('submit', submitSceneForm);
  $('#btn-clear-scene').addEventListener('click', clearScene);
  $('#btn-go-live').addEventListener('click', goLive);
  $('#btn-stop-live').addEventListener('click', endStream);
  $('#destination-platform').addEventListener('change', updatePlatformHelp);

  $('#destination-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const destination = {
      platform: $('#destination-platform').value,
      streamKey: $('#destination-key').value.trim(),
      overrideUrl: $('#destination-url').value.trim(),
      label: $('#destination-label').value.trim(),
    };
    const result = await send(CLIENT.DESTINATION_ADD, { destination });
    if (result) {
      toast(`${destination.label || destination.platform} added`, 'ok');
      $('#destination-key').value = '';
      $('#destination-url').value = '';
      $('#destination-label').value = '';
    }
  });

  $('#chat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await send(CLIENT.CHAT_SEND, { text });
  });

  // Cameras & screens all live in one pop-up pane now.
  $('#btn-open-devices').addEventListener('click', () => {
    if (!requireControl()) return;
    openDeviceDialog();
  });
  $('#device-dialog-close').addEventListener('click', closeDeviceDialog);
  $('#btn-devices-studio').addEventListener('click', () => addSelectedDevices('studio'));
  $('#btn-devices-grid').addEventListener('click', () => addSelectedDevices('grid'));
  $('#btn-devices-air').addEventListener('click', () => addSelectedDevices('air'));

  $('#btn-devices-screen').addEventListener('click', async () => {
    if (!requireControl()) return;
    const source = await state.camera.addScreenShare({ audio: $('#screen-audio').checked });
    if (source) {
      await send(CLIENT.MEMBER_UPDATE, { patch: { screenSharing: true } });
      toast('Screen shared - use the Screen program mode to put it on air', 'ok');
      await renderDevicePicker();
    }
  });

  $('#btn-devices-bluetooth').addEventListener('click', async () => {
    if (!requireControl()) return;
    const result = await state.camera.pairBluetooth();
    if (result?.ok) {
      toast(
        result.added
          ? `Paired ${result.name || 'device'} - added ${result.added} camera(s)`
          : `Paired ${result.name || 'device'} - open this pane again once the OS exposes its camera`,
        result.added ? 'ok' : 'info',
      );
      await renderDevicePicker();
    }
  });

  // Every pane can be shown or hidden, and the choice sticks.
  $('#pane-toggles').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-pane]');
    if (button) togglePane(button.dataset.pane);
  });

  $('#btn-mute-all').addEventListener('click', async () => {
    if (!requireControl()) return;
    const result = await send(CLIENT.MEMBER_MEDIA, { all: true, muted: true });
    if (result) toast('Everyone is muted', 'ok');
  });

  $('#btn-stop-all-video').addEventListener('click', async () => {
    if (!requireControl()) return;
    const result = await send(CLIENT.MEMBER_MEDIA, { all: true, cameraEnabled: false });
    if (result) toast('All cameras stopped', 'ok');
  });

  $('#btn-join-call').addEventListener('click', joinCall);
  $('#btn-leave-call').addEventListener('click', leaveCall);
  // The meeting toolbar and the People view drive the same local media.
  $('#btn-toggle-mic').addEventListener('click', () => toggleMyMedia('mic'));
  $('#btn-toggle-cam').addEventListener('click', () => toggleMyMedia('camera'));

  $('#btn-refresh-recordings').addEventListener('click', loadRecordings);

  // Host-only: rotate the passwords people use to claim the host/co-host seats.
  $('#credential-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!isHost()) return;
    const hostPassword = $('#credential-host').value.trim();
    const cohostPassword = $('#credential-cohost').value.trim();
    const result = await send(CLIENT.ROOM_UPDATE, { hostPassword, cohostPassword });
    if (!result) return;
    state.credentials = result.credentials || state.credentials;
    renderCredentials();
    toast('Room passwords updated', 'ok');
  });

  $('#btn-copy-host-password').addEventListener('click', () => copyPassword('hostPassword'));
  $('#btn-copy-cohost-password').addEventListener('click', () => copyPassword('cohostPassword'));
  $('#btn-email-password').addEventListener('click', emailHostPassword);

  // The Participants footer, like Zoom's.
  $('#btn-invite').addEventListener('click', inviteToRoom);
  $('#btn-unmute-me').addEventListener('click', unmuteMe);
  $('#btn-claim-host').addEventListener('click', claimHost);

  // ---------------------------------------------------------- breakout rooms
  $('#btn-create-breakouts').addEventListener('click', async () => {
    if (!requireControl()) return;
    const count = Number($('#breakout-count').value) || 2;
    const minutes = Number($('#breakout-duration').value) || 0;
    const result = await send(CLIENT.BREAKOUT_CREATE, { count });
    if (!result) return;
    toast(`${result.breakouts.rooms.length} breakout room(s) created`, 'ok');
    // A duration means "open them now and close them when the timer runs out".
    if (minutes > 0) await send(CLIENT.BREAKOUT_OPEN, { durationMs: minutes * 60000 });
  });

  $('#btn-open-breakouts').addEventListener('click', async () => {
    if (!requireControl()) return;
    const minutes = Number($('#breakout-duration').value) || 0;
    const result = await send(CLIENT.BREAKOUT_OPEN, { durationMs: minutes * 60000 });
    if (result) toast('Breakout rooms open - everyone is in their room', 'ok');
  });

  $('#btn-close-breakouts').addEventListener('click', async () => {
    if (!requireControl()) return;
    const result = await send(CLIENT.BREAKOUT_CLOSE, {});
    if (result) toast('Breakout rooms closed - everyone is back', 'ok');
  });

  $('#btn-shuffle-breakouts').addEventListener('click', async () => {
    if (!requireControl()) return;
    const result = await send(CLIENT.BREAKOUT_SHUFFLE, {});
    if (result) toast('Groups reshuffled', 'ok');
  });

  $('#btn-clear-breakouts').addEventListener('click', async () => {
    if (!requireControl()) return;
    const result = await send(CLIENT.BREAKOUT_CLEAR, {});
    if (result) toast('Breakout rooms removed', 'ok');
  });

  $('#breakout-announce-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requireControl()) return;
    const input = $('#breakout-announce-text');
    const text = input.value.trim();
    if (!text) return;
    const result = await send(CLIENT.BREAKOUT_ANNOUNCE, { text });
    if (result) {
      input.value = '';
      toast(`Sent to ${result.delivered} room(s)`, 'ok');
    }
  });

  // Anyone can go back to the main room from the banner.
  $('#btn-leave-breakout').addEventListener('click', () =>
    send(CLIENT.BREAKOUT_ASSIGN, { breakoutId: null }),
  );
}

/** Copy a room password so the host can paste it into a chat or email. */
async function copyPassword(key) {
  const value = state.credentials?.[key];
  if (!value) {
    toast('No password to copy yet', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast(`${key === 'hostPassword' ? 'Host' : 'Co-host'} password copied`, 'ok');
  } catch {
    toast(`${key === 'hostPassword' ? 'Host' : 'Co-host'} password: ${value}`, 'info');
  }
}

function wireCamera() {
  state.camera.addEventListener('devices', ({ detail }) => {
    const host = $('#device-list');
    clear(host);
    const chips = [
      ...detail.video.map((device, index) => `\u{1F4F7} ${device.label || `Camera ${index + 1}`}`),
      ...detail.audio.map((device, index) => `\u{1F3A4} ${device.label || `Microphone ${index + 1}`}`),
    ];
    for (const chip of chips) host.append(el('span', { class: 'device-chip', text: chip }));
    if (!chips.length) host.append(el('span', { class: 'device-chip', text: 'No devices detected yet' }));
  });

  state.camera.addEventListener('change', () => {
    // A locally captured camera or screen is part of the program picture: push
    // it into the compositor straight away so the preview never lags behind.
    syncCompositorSources();
    renderSources();
    // My own tile shows my video and my controls, so refresh it at once.
    renderParticipants();
    // Keep an open picker honest about what is already published.
    const dialog = $('#device-dialog');
    if (dialog?.open) renderDevicePicker();
  });

  for (const type of ['error', 'warning']) {
    state.camera.addEventListener(type, ({ detail }) => toast(detail.message, type === 'error' ? 'error' : 'info'));
  }

  state.camera.addEventListener('bluetooth', ({ detail }) => {
    toast(`Bluetooth device "${detail.name}" paired - looking for its camera...`, 'ok');
  });
}

function wirePublisher() {
  state.publisher.addEventListener('error', ({ detail }) => toast(detail.message, 'error'));
}

function wireMeeting() {
  state.meeting.addEventListener('stream', ({ detail }) => {
    const grid = $('#remote-grid');
    const existing = grid.querySelector(`[data-peer="${detail.peerId}"]`);
    const name = state.members.find((member) => member.id === detail.peerId)?.name || 'Guest';

    if (!detail.stream) {
      existing?.remove();
      state.peerStreams.delete(detail.peerId);
      state.camera.removeParticipant(detail.peerId);
      renderParticipants();
      return;
    }

    state.peerStreams.set(detail.peerId, detail.stream);
    const tile = existing || el('div', { class: 'remote-tile', dataset: { peer: detail.peerId } });
    clear(tile);
    const video = el('video', { autoplay: true, playsInline: true });
    video.srcObject = detail.stream;
    tile.append(video, el('div', { class: 'name', text: name }));
    grid.append(tile);

    // Everyone sees the participant in the room straight away; the host and
    // co-hosts also announce them so they can be composited into the program
    // and put on air.
    state.camera
      .addParticipant({ peerId: detail.peerId, label: name, stream: detail.stream, announce: hasControl() })
      .then(() => renderParticipants())
      .catch(() => renderParticipants());
  });

  state.meeting.addEventListener('peer-state', ({ detail }) => {
    // A dead connection must not leave a frozen participant in the program.
    if (!['failed', 'closed'].includes(detail.state)) return;
    state.peerStreams.delete(detail.peerId);
    state.camera.removeParticipant(detail.peerId);
    renderParticipants();
  });

  state.meeting.addEventListener('error', ({ detail }) => toast(`call error: ${detail.message}`, 'error'));
}

async function joinCall() {
  try {
    let stream = state.camera.primaryStream();
    if (!stream) {
      // Anyone may publish their own camera now; the host still decides what
      // goes out to the viewers.
      const source = await state.camera.addCamera({ announce: true });
      stream = source?.stream || null;
    }
    if (!stream) {
      toast('a camera is required to join the call', 'error');
      return;
    }
    state.inCall = true;
    await state.meeting.join(stream, meetingPeerIds());
    renderParticipants();
    $('#btn-join-call').disabled = true;
    $('#btn-leave-call').disabled = false;
    $('#btn-toggle-mic').disabled = false;
    $('#btn-toggle-cam').disabled = false;
    send(CLIENT.MEMBER_UPDATE, { patch: { cameraEnabled: true, muted: false } });
    toast('Joined the call', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function leaveCall() {
  state.inCall = false;
  await state.meeting.leave();
  clear($('#remote-grid'));
  state.peerStreams.clear();
  renderParticipants();
  $('#btn-join-call').disabled = false;
  $('#btn-leave-call').disabled = true;
  $('#btn-toggle-mic').disabled = true;
  $('#btn-toggle-cam').disabled = true;
  send(CLIENT.MEMBER_UPDATE, { patch: { cameraEnabled: false, screenSharing: false } });
}

/** Render the library from a list (a server push or a fetch). */
function renderRecordings(recordings = []) {
  state.recordings = recordings;
  const list = $('#recording-list');
  if (!list) return;
  clear(list);
  if (!recordings.length) {
    list.append(el('li', {}, [el('div', { class: 'grow muted', text: 'No recordings yet.' })]));
    return;
  }
  for (const entry of recordings) {
    list.append(
      el('li', {}, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'title', text: entry.file }),
          el('div', {
            class: 'sub',
            text: `${entry.status} \u00b7 ${fmtBytes(entry.sizeBytes)} \u00b7 ${fmtDuration(
              entry.durationMs || 0,
            )} \u00b7 ${fmtTime(entry.createdAt)}`,
          }),
        ]),
        el('a', { class: 'tiny', href: entry.downloadUrl, download: '', text: entry.hasMp4 ? 'mp4' : 'file' }),
        el('a', { class: 'tiny', href: entry.streamUrl, target: '_blank', rel: 'noreferrer', text: 'play' }),
      ]),
    );
  }
}

async function loadRecordings() {
  if (!state.roomId) return;
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(state.roomId)}/recordings`);
    const data = await response.json();
    renderRecordings(data.recordings || []);
  } catch (error) {
    toast(`could not load recordings: ${error.message}`, 'error');
  }
}

window.addEventListener('beforeunload', () => {
  state.publisher?.stop();
  state.camera?.stopAll();
  state.meeting?.leave();
});

boot();
