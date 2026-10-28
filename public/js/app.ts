/**
 * Quandrite studio UI.
 *
 * Wires the WebSocket protocol to the camera manager, program compositor,
 * publisher and meeting mesh, and renders the studio controls.
 */

import { $, $$, el, clear, fmtDuration, fmtBytes, fmtTime, toast } from './dom.js';
import { QuandriteSocket } from './ws.js';
import { CameraManager } from './devices.js';
import { ProgramCompositor } from './compositor.js';
import { StreamPublisher } from './publisher.js';
import { MeetingMesh } from './webrtc.js';
import { MediaRelay } from './relay.js';
import { gridColumnsFor } from '/shared/layout.js';
import { formatCountdown, remainingCountdownMs } from '/shared/overlays.js';
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
  /** The room as the server describes it (name, host seat, password state). */
  room: any;
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
  /** Every feed the room has sent, by MediaStream id, so sources can be matched. */
  peerStreamIds: Map<string, { peerId: string; stream: MediaStream }>;
  /** Relayed pictures (the socket fallback) by sender, when peer-to-peer fails. */
  relayFrames: Map<string, { url: string; sourceId: string | null; kind: string; at: number }>;
  /** The socket picture relay. */
  relay: any;
  /** The studio program feed received from the room's program owner. */
  programStream: MediaStream | null;
  roomPeers: Map<string, string> | null;
  panes: Record<string, boolean>;
  /** How the room is shown: slide, grid or list (null = pick by room size). */
  peopleView: string | null;
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
  room: null,
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
  peerStreamIds: new Map(),
  relayFrames: new Map(),
  relay: null,
  programStream: null,
  roomPeers: null,
  panes: loadPanes(),
  peopleView: loadPeopleView(),
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
const PANES = ['program', 'grid', 'participants', 'sources', 'sidebar'];
/** How the room is shown, and the size above which a list is the only sane view. */
const PEOPLE_VIEW_KEY = 'quandrite.peopleView';
const PEOPLE_VIEWS = ['slide', 'grid', 'list'];
const PEOPLE_LIST_LIMIT = 50;
/** Where we remember that the host chose to set the room password later. */
const PASSWORD_PROMPT_KEY = 'quandrite.passwordPrompt';
/** The one-second repaint that keeps a running countdown counting. */
let sceneTicker: any = null;
/** The password page is a one-shot on the way in, never a reconnect interrupt. */
let passwordPageHandled = false;

function loadPanes() {
  const panes = { program: true, grid: true, participants: true, sources: true, sidebar: true };
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
    // A collapsed pane keeps its head - and its arrow - so it can be brought back
    // without stealing space in the top bar.
    for (const node of document.querySelectorAll(`[data-pane="${pane}"]`)) {
      node.classList.toggle('pane-collapsed', !shown);
    }
    const horizontal = pane === 'sidebar';
    for (const button of document.querySelectorAll(`button.pane-toggle[data-pane="${pane}"]`)) {
      button.setAttribute('aria-pressed', shown ? 'true' : 'false');
      // A real chevron: pointing down while the pane is open, sideways once it is
      // collapsed and only its head is left.
      button.innerHTML = icon(shown ? (horizontal ? 'chevronLeft' : 'chevronDown') : 'chevronRight');
      button.title = shown
        ? `Collapse this pane (${horizontal ? 'to the side' : 'down'})`
        : 'Expand this pane';
    }
  }
  const layout = document.querySelector('main.layout');
  if (layout) layout.classList.toggle('sidebar-collapsed', state.panes.sidebar === false);
  // A pane that was just un-hidden has to be painted on the spot.
  renderGridPreview();
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

/** The view the user picked, remembered like the panes are. */
function loadPeopleView() {
  try {
    const value = localStorage.getItem(PEOPLE_VIEW_KEY);
    return PEOPLE_VIEWS.includes(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * How the people in the room are shown.
 *
 * A big room (more than {@link PEOPLE_LIST_LIMIT}) is a list with everyone's
 * controls - slides and grids stop being readable - while a smaller room slides
 * by default and can be switched to a grid.
 */
function peopleViewFor(count) {
  if (state.peopleView) return state.peopleView;
  return count > PEOPLE_LIST_LIMIT ? 'list' : 'slide';
}

function setPeopleView(view) {
  if (!PEOPLE_VIEWS.includes(view)) return;
  state.peopleView = view;
  try {
    localStorage.setItem(PEOPLE_VIEW_KEY, view);
  } catch {
    // private mode: the choice simply does not persist
  }
  renderParticipants();
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
  // A microphone that has just been switched on must be heard by the room at
  // once, even when it is the only thing I have published.
  if (enabled) {
    const stream = localMediaStream();
    if (stream) publishToRoom(stream).catch(() => {});
  }
  const button = $('#btn-toggle-mic');
  if (button) iconLabel(button, enabled ? 'mic' : 'micOff', enabled ? 'Mute' : 'Unmute');
}

function syncCompositorSources() {
  const local = new Map(state.camera.list().map((source) => [source.id, source]));
  state.compositor.setSources(
    state.sources.map((source) => {
      // My own captures are keyed by source id; someone else's media arrives
      // through the room mesh, so it is matched by owner (and, once the sharer
      // has announced it, by the stream they published it with).
      const media =
        local.get(source.id) ||
        local.get(`stream:${source.meta?.streamId}`) ||
        local.get(`participant:${source.ownerId}`);
      return {
        ...source,
        stream: media?.stream || null,
        video: media?.video || null,
        meta: { ...(source.meta || {}), ...(media?.meta || {}) },
      };
    }),
  );
  // The outgoing video follows the program: a single camera or screen goes out as
  // its own real track, the canvas only carries what has to be composited.
  refreshProgramVideo();
}

/**
 * Keep the encoder on the real on-air video.
 *
 * A live broadcast that switches camera (or goes to the grid, or puts an overlay
 * up) needs the encoder to follow, and the encoder is bound to the tracks it
 * started with - so the publisher rebuilds the recorder for the new source.
 */
function refreshProgramVideo() {
  try {
    state.publisher?.syncVideoTrack?.();
  } catch {
    // nothing is live: nothing to re-point
  }
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

/**
 * The stream the room should see and hear from me: my camera, my screen, or just
 * my microphone. Publishing any of them is what puts me in the mesh.
 */
function localMediaStream() {
  const sources = state.camera.list();
  const visual = sources.find(
    (entry) => (entry.kind === 'camera' || entry.kind === 'screen') && entry.stream,
  );
  if (visual?.stream) return visual.stream;
  // A microphone on its own is enough: "unmute me" has to be heard.
  return sources.find((entry) => entry.stream?.getAudioTracks?.().length)?.stream || null;
}

/** The microphone I publish, added on demand the first time I speak. */
async function ensureMicrophone() {
  const existing = state.camera.list().find((entry) => entry.stream?.getAudioTracks?.().length);
  if (existing) return existing;
  return state.camera.addMicrophone({});
}

/**
 * Start (or keep) the room mesh.
 *
 * Turning a camera or a screen on is enough to publish it: nobody has to press
 * "Join call" first, so a viewer's video reaches the whole room the moment it
 * exists. Joining with no media yet is fine too - the connections are cheap and
 * the first track turns them into a picture.
 */
async function ensureMesh() {
  if (!state.roomId || !state.clientId) return false;
  if (!state.meeting.active) {
    await state.meeting.join(localMediaStream(), meetingPeerIds());
    return true;
  }
  state.meeting.sync(meetingPeerIds());
  return true;
}

/** Keep the mesh in step with the room I am in. */
function syncMeetingPeers() {
  if (!state.roomId) return;
  ensureMesh().catch(() => {});
}

/**
 * Is the socket picture relay needed?
 *
 * Peer-to-peer is always tried first - it is faster and costs the server nothing -
 * so the relay only starts when a connection exists but is not connected: that is
 * exactly the case where two networks will not let the browsers reach each other.
 */
function relayFallbackNeeded() {
  if (!state.roomId || !state.meeting?.active) return false;
  const peers = [...(state.meeting.peers?.values?.() || [])];
  if (!peers.length) return false;
  return peers.some((peer) => peer.pc?.connectionState !== 'connected');
}

/**
 * Start, refresh or stop the socket relay to match what I publish and whether the
 * peer connections are actually carrying it.
 */
function syncRelay() {
  if (!state.relay) return;
  if (!relayFallbackNeeded()) {
    if (state.relay.publishing) state.relay.stop();
    return;
  }
  for (const source of state.camera.list()) {
    if (source.kind !== 'camera' && source.kind !== 'screen') continue;
    if (!source.stream) continue;
    state.relay.add({ id: source.id, kind: source.kind, label: source.label, stream: source.stream });
  }
  // Forget the ones that are gone (a camera that was switched off).
  for (const id of state.relay.ids) {
    if (!state.camera.get(id)) state.relay.remove(id);
  }
}

/**
 * A picture that arrived over the socket: show it where the live feed would have
 * gone, and hand it to the camera manager so it can be composited too.
 */
function renderRelayedFrame(header, payload) {
  const from = header?.from;
  if (!from) return;
  const url = URL.createObjectURL(new Blob([payload], { type: 'image/jpeg' }));
  const previous = state.relayFrames.get(from);
  if (previous?.url) URL.revokeObjectURL(previous.url);
  state.relayFrames.set(from, {
    url,
    sourceId: header.sourceId || null,
    kind: header.kind || 'camera',
    at: Date.now(),
  });
  showRelayedPicture(from, url);
  if (header.sourceId) {
    state.camera
      .attachRemoteImage({
        id: header.sourceId,
        label: header.label || `${header.fromName || 'Guest'}'s picture`,
        peerId: from,
        url,
        kind: header.kind === 'screen' ? 'screen' : 'virtual',
      })
      ?.video &&
      syncCompositorSources();
    renderGridPreview();
  }
}

/** Put a relayed picture on a peer's tile without rebuilding the whole room. */
function showRelayedPicture(peerId, url) {
  const tile = document.querySelector(`#participant-strip [data-peer="${peerId}"]`);
  if (!tile) {
    renderParticipants();
    return;
  }
  let picture = tile.querySelector('img.tile-picture');
  if (!picture) {
    picture = el('img', { class: 'tile-picture', alt: '' });
    tile.querySelector('video')?.remove();
    tile.prepend(picture);
  }
  picture.src = url;
  tile.classList.add('live');
}

/**
 * Put a freshly captured stream in front of the room: start the mesh if this is
 * the first media I have, then hand every track to each peer.
 */
async function publishToRoom(stream) {
  if (!stream) return false;
  await ensureMesh();
  if (!state.meeting.active) return false;
  state.meeting.setCameraEnabled(true);
  for (const track of stream.getTracks?.() || []) state.meeting.attachTrack(track, stream);
  return true;
}

/** Who owns the program picture: the host runs the studio, everyone else watches. */
function programOwnerId() {
  const host = state.members.find((member) => member.role === 'host');
  return host?.id || null;
}

function iOwnProgram() {
  return Boolean(state.clientId) && programOwnerId() === state.clientId;
}

/**
 * Send the studio program to the room, or stop sending it.
 *
 * The owner is the host: their compositor is the picture and the mix the room
 * should see. Everyone else receives it over WebRTC, so the program arrives in
 * tens of milliseconds instead of queueing behind the RTMP relay. The feed goes
 * to the whole studio, because a breakout still watches the parent's program.
 */
function syncProgramFeed() {
  const stream = state.roomId && iOwnProgram() ? state.compositor.programStream() : null;
  state.meeting.setProgramStream(stream, state.members.map((member) => member.id));
  // The owner watches its own canvas, never its own feed.
  if (stream) state.programStream = null;
  renderProgramFeed();
}

/**
 * Does the program's audio take over this client?
 *
 * In the main room, yes: that is the sound everyone came for, and the meeting
 * tiles go quiet so a voice never arrives twice. In a breakout the room's own
 * conversation wins - the program picture is there, its audio is not.
 */
function programAudioTakesOver() {
  return Boolean(state.programStream) && !state.breakoutId;
}

/**
 * Show the program feed received from the room's owner.
 *
 * The local canvas keeps drawing the owner's own picture; for everyone else the
 * incoming feed sits on top of it, because that is the real program - overlays,
 * badges, countdowns and all.
 */
function renderProgramFeed() {
  const node = $('#program-feed');
  if (!node) return;
  const pill = $('#program-feed-pill');
  const stream = state.programStream;
  if (!stream) {
    if (node.srcObject) node.srcObject = null;
    node.classList.add('hidden');
    pill?.classList.add('hidden');
    applyProgramAudioPolicy();
    return;
  }
  if (node.srcObject !== stream) node.srcObject = stream;
  // A breakout keeps its own conversation; only the main room hears the mix.
  node.muted = Boolean(state.breakoutId);
  node.classList.remove('hidden');
  pill?.classList.remove('hidden');
  if (typeof node.play === 'function') node.play().catch(() => {});
  applyProgramAudioPolicy();
}

/**
 * The program mix already contains the room, so the meeting tiles go quiet while
 * the program feed is playing here - otherwise every voice arrives twice.
 */
function applyProgramAudioPolicy() {
  const quiet = programAudioTakesOver();
  for (const video of $$('#remote-grid video')) video.muted = quiet;
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
  iconLabel(mic, member.muted ? 'micOff' : 'mic', member.muted ? 'Unmute' : 'Mute');
  mic.title = member.muted ? 'Turn your microphone on' : 'Mute your microphone';
  mic.classList.toggle('ghost', member.muted);

  const camera = tile.querySelector('[data-tile="camera"]');
  iconLabel(camera, member.cameraEnabled ? 'camera' : 'cameraOff', member.cameraEnabled ? 'Stop video' : 'Start video');
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

  // How the room is shown: a slide, a grid, or - in a big room - a list that
  // still carries everyone's controls.
  const view = peopleViewFor(members.length);
  strip.className = `participant-strip ${view}`;
  for (const button of $$('#people-view button')) {
    button.classList.toggle('active', button.dataset.view === view);
  }

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
    // My own video comes from my camera, everyone else's from the room mesh. A
    // camera that has been switched off shows the avatar again, even though the
    // peer connection is still up.
    const stream = member.cameraEnabled
      ? state.peerStreams.get(member.id) || (isMe ? state.camera.primaryStream() : null)
      : null;

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

    // No live feed? A relayed picture (the socket fallback) stands in for it, so
    // a camera or screen still shows up when the networks refuse peer-to-peer.
    const frame = state.relayFrames.get(member.id);
    // A relayed picture is proof they are publishing, even before the member's
    // own "camera on" reaches us.
    const picture = !stream && (member.cameraEnabled || frame) ? frame?.url || null : null;
    let image = tile.querySelector('img.tile-picture');
    if (picture && !image) {
      image = el('img', { class: 'tile-picture', alt: '' });
      tile.prepend(image);
      tile.classList.add('live');
    }
    if (image) {
      if (picture) image.src = picture;
      else {
        image.remove();
        tile.classList.toggle('live', Boolean(stream));
      }
    }

    tile.querySelector('.avatar').textContent = initials(member.name);
    const name = tile.querySelector('.name');
    // The dot carries the role; the word is only in the top bar.
    name.textContent = '';
    name.append(roleDot(member.role), `${member.name}${isMe ? ' (you)' : ''}`);
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
  // The socket picture relay: the fallback for cameras and screens when two
  // networks will not let the browsers reach each other.
  state.relay = new MediaRelay({ socket: state.socket });

  state.compositor.start();

  // Peer-to-peer first; a picture relay only while a connection is not connected.
  setInterval(syncRelay, 4000);

  wireSocket();
  wireCamera();
  wirePublisher();
  wireMeeting();
  wireControls();

  state.socket.connect();

  // Audio contexts and the program feed both need a user gesture; resume on the
  // first interaction so the room hears the program straight away.
  const resumeAudio = () => {
    state.compositor.resumeAudio();
    const feed = $('#program-feed');
    if (feed?.srcObject && typeof feed.play === 'function') feed.play().catch(() => {});
  };
  document.addEventListener('pointerdown', resumeAudio, { once: true });
  document.addEventListener('keydown', resumeAudio, { once: true });

  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('#join-room').value = params.get('room');
  if (params.get('name')) $('#join-name').value = params.get('name');

  // Nothing can be published before joining a room.
  updateControlAvailability();
  applyPaneVisibility();
  updateJoinControls();
  // The socket is connecting now: say so, with a way to retry by hand.
  showConnectionBanner('Connecting to the studio server...');
  // Before joining there are no studio controls, so open on the roster.
  if (!hasControl()) activateTab('people');
}

function wireSocket() {
  const socket = state.socket;

  socket.on('open', () => {
    setPill('#connection-pill', 'online', 'online');
    hideConnectionBanner();
    // A dropped connection re-joins the room on its own: no page refresh.
    if (state.reconnecting && state.join) rejoinRoom();
  });

  socket.on('close', () => {
    setPill('#connection-pill', 'offline', 'reconnecting');
    if (state.roomId) state.reconnecting = true;
    // Say it out loud, with a way out: a dropped socket must never look like a
    // dead app, and the room is kept so re-joining costs one click.
    showConnectionBanner(
      state.roomId
        ? 'Connection lost - retrying. Your room and your seat are kept; press Retry now to reconnect at once.'
        : 'Connection lost - retrying. Press Retry now to reconnect at once.',
    );
  });

  socket.on('socket-error', () => {
    showConnectionBanner('Could not reach the studio server. Is it running? Press Retry now.');
  });

  socket.on(SERVER.WELCOME, (message) => {
    state.clientId = message.clientId;
    state.overlayDefinitions = message.overlayDefinitions || {};
    state.platforms = message.platforms || [];
    state.mail = message.mail || { enabled: false, from: null };
    // STUN/TURN from the server: without a relay a call only works when both
    // sides can reach each other directly.
    if (Array.isArray(message.iceServers) && message.iceServers.length) {
      state.meeting.setIceServers(message.iceServers);
    }
    renderSceneButtons();
    renderPlatformOptions();
    renderCredentials();
  });

  socket.on(SERVER.CHAT_NEW, (message) => appendChat(message));

  // A picture relayed over the socket (the peer-to-peer fallback).
  socket.on('media:frame', ({ header, payload }) => renderRelayedFrame(header, payload));

  socket.on(SERVER.MEMBERS_UPDATE, (members) => {
    state.members = members;
    const me = members.find((member) => member.id === state.clientId);
    if (me) {
      const wasHost = isHost();
      state.role = me.role;
      setPill('#role-pill', `role-${me.role}`, me.role);
      updateControlAvailability();
      // Being handed the seat mid-session never interrupts with the password page:
      // the People tab offers it there.
      if (!wasHost && me.role === 'host') renderCredentials();
    }
    renderMembers();
    renderPeople();
    renderBreakouts();
    trackRoomPeers(members, { announce: true });
    renderParticipants();
    syncMeetingPeers();
    // The host seat can move: the program owner follows it.
    syncProgramFeed();
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
    // Moving rooms changes the meeting mesh and whether the program is audible.
    syncProgramFeed();
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
    // The grid preview follows the program the studio just published.
    renderGridPreview();
  });

  socket.on(SERVER.SCENE_UPDATE, (scene) => {
    state.scene = scene;
    state.compositor.setScene(scene);
    renderSceneCurrent();
    // An overlay (or its end) changes what has to be composited, so the outgoing
    // video may go back to the real camera track - or need the canvas again.
    refreshProgramVideo();
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

// ------------------------------------------------------------ connection state

/** A visible, actionable line about the socket - never a silent dead page. */
function showConnectionBanner(text) {
  const banner = $('#connection-banner');
  if (!banner) return;
  const label = $('#connection-banner-text');
  if (label && text) label.textContent = text;
  banner.classList.remove('hidden');
}

function hideConnectionBanner() {
  $('#connection-banner')?.classList.add('hidden');
}

/**
 * Retry the socket by hand. If we already have a room, the re-join happens as
 * soon as the socket opens again, so one click is enough.
 */
function retryConnection() {
  showConnectionBanner('Reconnecting to the studio server...');
  if (state.roomId) state.reconnecting = true;
  if (state.socket.connected && state.join) rejoinRoom();
  else state.socket.connect();
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
  // The room mesh and the program feed follow the room, not a button press.
  await ensureMesh().catch(() => {});
  syncProgramFeed();
  if (!silent) toast(`Joined ${result.roomId} as ${result.role}`, 'ok');
  // A brand new room has no password: the host gets the password page, once, on
  // the way in. A silent re-join (a reconnect) never interrupts with it.
  passwordPageHandled = Boolean(silent);
  try {
    updateControlAvailability();
    renderCredentials();
    if (isHost() && roomNeedsHostPassword() && !passwordPageHandled && !passwordPromptedLater()) {
      showPasswordPage();
    } else {
      updateJoinControls();
    }
    // Hosts and co-hosts land on the studio controls; watchers land on the roster.
    activateTab(hasControl() ? 'scenes' : 'people');
    loadRecordings();
  } catch (error) {
    // A rendering problem must never look like a failed join: the room is joined
    // either way, so say what broke and keep the socket usable.
    console.error('post-join render failed', error);
    toast(`Joined, but part of the studio did not render: ${error.message}`, 'error');
  }
}

/**
 * Three screens, one at a time: the landing page before a room, the password page
 * while a brand new host protects the seat, and the studio itself.
 */
function updateJoinControls() {
  const inRoom = Boolean(state.roomId);
  const needsPassword = inRoom && !passwordPageHandled && roomNeedsHostPassword() && !passwordPromptedLater();
  const landing = $('#landing');
  if (landing) landing.classList.toggle('hidden', inRoom);
  const passwordPage = $('#password-page');
  if (passwordPage) passwordPage.classList.toggle('hidden', !needsPassword);
  const studio = $('#studio');
  if (studio) studio.classList.toggle('hidden', !inRoom || needsPassword);
  const leave = $('#btn-leave-room');
  if (leave) leave.classList.toggle('hidden', !inRoom);
  // Sharing is a room action: anyone in the room can publish their camera or
  // screen, and the host can place what arrives.
  const share = $('#btn-share');
  if (share) share.classList.toggle('hidden', !inRoom || needsPassword);
  const join = $('#btn-join');
  if (join) join.textContent = inRoom ? 'Rejoin' : 'Join';
  renderIdentity();
}

/** My name and my room, in the top bar. */
function renderIdentity() {
  const name = $('#name-pill');
  if (name) name.textContent = state.name || 'not joined';
  const room = $('#room-pill');
  if (room) room.textContent = state.roomId ? `room ${state.roomId}` : 'no room';
}

/** Leave the room without reloading, so another room can be joined at once. */
async function leaveRoom() {
  if (!state.roomId) return;
  // Take my own cameras and microphones out of the studio first: after leaving
  // the room the server would refuse the removal.
  for (const source of state.camera.list()) {
    if (source.kind !== 'virtual') await state.camera.removeSource(source.id).catch(() => {});
  }
  try {
    await state.socket.send(CLIENT.LEAVE);
  } catch {
    // Leaving locally is still the right thing to do.
  }
  resetClientRoom();
  toast('Left the room', 'ok');
}

/** Back to the pre-join state, so the join bar is ready for the next room. */
function resetClientRoom() {
  state.roomId = null;
  state.role = 'viewer';
  state.clientId = null;
  state.credentials = null;
  state.breakoutId = null;
  state.join = null;
  state.reconnecting = false;
  state.members = [];
  state.sources = [];
  state.program = { mode: 'single', sourceId: null, gridIds: [], onAir: [], updatedAt: Date.now() };
  state.room = null;
  state.scene = null;
  state.stream = { status: 'offline' };
  state.recording = { status: 'idle' };
  state.roomPeers = null;
  state.inCall = false;
  // Back to the landing page: the password page is offered again next time.
  passwordPageHandled = false;
  state.programStream = null;
  state.peerStreams.clear();
  state.peerStreamIds.clear();
  state.meeting.leave().catch(() => {});
  state.meeting.setProgramStream(null);
  state.breakouts = {
    available: false,
    max: 8,
    active: false,
    startedAt: null,
    endsAt: null,
    durationMs: 0,
    rooms: [],
  };

  state.compositor.setProgram(state.program);
  state.compositor.setScene(null);
  syncCompositorSources();
  clear($('#chat-log'));
  setPill('#role-pill', '', 'guest');
  setPill('#breakout-pill', 'hidden', 'main room');
  updateControlAvailability();
  updateJoinControls();
  renderMembers();
  renderPeople();
  renderSources();
  renderParticipants();
  renderBreakouts();
  renderCredentials();
  renderDestinations();
  renderStreamStatus();
  renderSceneCurrent();
  renderProgramControls();
  clear($('#remote-grid'));
  renderProgramFeed();
  activateTab('people');
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
  state.room = snapshot.room || state.room;
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
 * Inline icons, drawn in the button's own colour.
 *
 * Emoji render differently on every platform (and cannot be recoloured), so the
 * microphone, camera and the pane arrows are proper vector icons.
 */
const ICONS = {
  mic: '<path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18.5V21"/><path d="M8.5 21h7"/>',
  micOff:
    '<path d="M9 9.5V6a3 3 0 0 1 5.6-1.5"/><path d="M15 11.5V12a3 3 0 0 1-4.4 2.6"/><path d="M19 11a7 7 0 0 1-10.6 6"/><path d="M12 18.5V21"/><path d="M8.5 21h7"/><path d="M3.5 3.5l17 17"/>',
  camera: '<path d="M3 7.5h10.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H3z"/><path d="M15.5 11.2 21 8v8l-5.5-3.2z"/>',
  cameraOff:
    '<path d="M3 7.5h8"/><path d="M15.5 11.2 21 8v8l-3-1.7"/><path d="M3.5 3.5l17 17"/>',
  screen: '<path d="M3 5h18v11H3z"/><path d="M8 20h8"/><path d="M12 16v4"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  chevronLeft: '<path d="M14.5 6l-6 6 6 6"/>',
};

/** @returns {string} an inline SVG for one of {@link ICONS}. */
function icon(name, { size = 14 }: any = {}) {
  const body = ICONS[name] || '';
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Icon + label for a button that changes with the media state. */
function iconLabel(button, name, label) {
  if (!button) return;
  button.innerHTML = `${icon(name)}<span>${label}</span>`;
}

/**
 * Who is who at a glance: a coloured dot next to the name.
 *
 * Cyan is the host, purple is a co-host, and green is everybody who is watching
 * (viewers and visitors).
 */
function roleDot(role) {
  const label = roleLabel(role);
  return el('span', {
    class: `role-dot role-${role || 'viewer'}`,
    title: `role: ${label}`,
    'aria-label': `role: ${label}`,
  });
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
            // Role is the dot; the word stays in the top bar only.
            roleDot(member.role),
            `${member.name}${isMe ? ' (you)' : ''}`,
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
  const name = kind === 'mic' ? (on ? 'mic' : 'micOff') : on ? 'camera' : 'cameraOff';

  if (!isMe && !hasControl()) {
    return el('span', {
      class: `media-state ${on ? 'on' : 'off'}`,
      html: `${icon(name, { size: 13 })}<span>${on ? 'on' : 'off'}</span>`,
      title: `${member.name} \u00b7 ${on ? 'on' : 'off'}`,
    });
  }

  return el('button', {
    class: `tiny ${on ? '' : 'ghost'}`,
    dataset: { media: kind, member: member.id },
    title: `${action}${isMe ? ' (you)' : ` ${member.name}`}`,
    html: `${icon(name)}<span>${action}</span>`,
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

/**
 * A readable, memorable suggestion. The server generates its own passwords when
 * it creates a room; this is only what we offer the host in the dialog.
 */
function suggestPassword() {
  const words = [
    'amber', 'cedar', 'delta', 'ember', 'flint', 'garnet', 'harbor', 'indigo',
    'juniper', 'kelp', 'lumen', 'marble', 'nectar', 'onyx', 'pepper', 'quartz',
    'raven', 'sable', 'timber', 'umber', 'violet', 'willow', 'zephyr',
  ];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

/** True while the host seat can still be taken by anyone who asks for it. */
function roomNeedsHostPassword() {
  return Boolean(isHost() && state.roomId && state.room?.requiresHostPassword === false);
}

/**
 * The password page.
 *
 * A brand new host protects the seat on its own page, between the join form and
 * the studio: joining gets you in, this page decides whether the seat is guarded,
 * and then you land in the room. Skipping is fine - the *People* tab offers the
 * same thing inside the room, where the host can change it at any time.
 */
function showPasswordPage() {
  const suggested = suggestPassword();
  const suggestedField = $('#password-suggested');
  if (suggestedField) suggestedField.value = suggested;
  const hostField = $('#password-host');
  if (hostField) hostField.value = suggested;
  const cohostField = $('#password-cohost');
  if (cohostField) cohostField.value = '';
  const status = $('#password-status');
  if (status) {
    status.textContent =
      'Anyone with the co-host password can claim that role themselves; leave it empty to keep it as it is.';
  }
  updateJoinControls();
}

/** Enter the room without a password (it can still be set from the People tab). */
function skipPasswordPage() {
  rememberPasswordLater();
  passwordPageHandled = true;
  updateJoinControls();
  toast('You can set the room password any time in the People tab', 'info');
}

/** Did the host already choose to deal with the password later, for this room? */
function passwordPromptedLater() {
  if (!state.roomId) return false;
  try {
    return localStorage.getItem(`${PASSWORD_PROMPT_KEY}.${state.roomId}`) === 'later';
  } catch {
    return false;
  }
}

/** Remember, per room, that the host chose to set the room password later. */
function rememberPasswordLater() {
  if (!state.roomId) return;
  try {
    localStorage.setItem(`${PASSWORD_PROMPT_KEY}.${state.roomId}`, 'later');
  } catch {
    // private mode: the page simply comes back next time
  }
}

/** Save the room passwords (host only) and refresh everything that shows them. */
async function saveRoomPasswords({ hostPassword, cohostPassword }: any = {}) {
  if (!isHost()) {
    toast('Only the host can set the room passwords', 'error');
    return null;
  }
  if (!hostPassword && !cohostPassword) {
    toast('Type a password first', 'error');
    return null;
  }
  const result = await send(CLIENT.ROOM_UPDATE, { hostPassword, cohostPassword });
  if (result?.credentials) {
    state.credentials = result.credentials;
    // Saving a host password makes the seat password-protected from now on.
    if (hostPassword && state.room) state.room.requiresHostPassword = true;
    renderCredentials();
    if (state.credentials.hostPassword) {
      // The password page is done with either way; the studio takes over.
      passwordPageHandled = true;
      updateJoinControls();
    }
    toast('Room passwords saved', 'ok');
  }
  return result;
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
    if (!state.credentials) {
      status.textContent = 'Join as the host to see the room passwords.';
    } else if (roomNeedsHostPassword()) {
      // The one case that matters: the host seat is not protected by a password.
      status.textContent =
        'This room has no password yet - press Generate passwords, then Set the room password, so the host seat is not handed to whoever joins an empty room first.';
    } else {
      status.textContent =
        'Only the host can see these. Share the co-host password so people can claim the role themselves.';
    }
  }
  const generate = $('#btn-generate-passwords');
  if (generate) generate.classList.toggle('hidden', !isHost());
  const save = $('#btn-save-passwords');
  if (save) save.textContent = roomNeedsHostPassword() ? 'Set the room password' : 'Save passwords';
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
  } else if (name === 'share') {
    // Cameras & screens: what is published, what can be, and where it goes.
    renderDeviceDialogActions();
    renderDevicePicker().catch(() => {});
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
  renderGridPreview();

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

/**
 * The sources the grid would composite, in order - the same rule the server
 * uses, so the preview matches the program picture.
 */
function gridPreviewSources() {
  const byId = new Map(state.sources.map((source) => [source.id, source]));
  const chosen = (state.program.gridIds || []).map((id) => byId.get(id)).filter(Boolean);
  const list = chosen.length
    ? chosen
    : state.sources.filter(
        (source) => source.kind === 'camera' || source.kind === 'screen' || source.kind === 'virtual',
      );
  return list.filter((source) => source.kind !== 'audio');
}

/**
 * The grid preview: the multi-camera picture laid out exactly like the program
 * grid, so the host and co-hosts can see the arrangement before it goes out.
 *
 * Host and co-host only - viewers and visitors get the program preview alone.
 * Each tile carries a live picture (sharing the capture's stream) and clicking
 * one puts that source on air.
 */
function renderGridPreview() {
  const host = $('#grid-preview');
  if (!host) return;
  const panel = $('#grid-panel');
  // Viewers have no grid preview, and a collapsed pane needs no work.
  if (!hasControl() || panel?.classList.contains('pane-collapsed')) return;

  const sources = gridPreviewSources();
  const summary = $('#grid-preview-summary');
  if (summary) {
    summary.textContent = sources.length
      ? `${sources.length} tile(s) \u00b7 ${
          state.program.mode === 'grid' ? 'live on the grid' : 'not on the grid yet'
        }`
      : 'No cameras or screens yet.';
  }
  host.style.gridTemplateColumns = `repeat(${gridColumnsFor(sources.length)}, minmax(0, 1fr))`;

  const onAir = new Set(state.program.onAir || []);
  const seen = new Set();
  for (const source of sources) {
    seen.add(source.id);
    let tile = host.querySelector(`[data-grid="${source.id}"]`);
    if (!tile) {
      tile = el('div', { class: 'grid-preview-tile', dataset: { grid: source.id } }, [
        el('div', { class: 'grid-preview-bar' }),
      ]);
      host.append(tile);
    }

    // A second <video> sharing the stream: the source tile in the Cameras pane
    // keeps the original element, so neither disturbs the other. My own captures
    // come from the camera manager; a source published on someone else's machine
    // shows that person's call video.
    const stream =
      state.camera?.get(source.id)?.stream || state.peerStreams.get(source.ownerId) || null;
    let video = tile.querySelector('video');
    if (stream && !video) {
      video = el('video', { autoplay: true, playsInline: true, muted: true });
      video.srcObject = stream;
      tile.prepend(video);
    } else if (stream && video && video.srcObject !== stream) {
      video.srcObject = stream;
    } else if (!stream && video) {
      video.remove();
      video = null;
    }

    const placeholder = tile.querySelector('.grid-preview-placeholder');
    if (!stream && !placeholder) {
      tile.prepend(
        el('div', {
          class: 'grid-preview-placeholder',
          text: `${source.ownerName} \u00b7 ${sourceKindLabel(source.kind)}`,
        }),
      );
    } else if (stream && placeholder) {
      placeholder.remove();
    }

    const live = onAir.has(source.id);
    const bar = tile.querySelector('.grid-preview-bar');
    clear(bar);
    bar.append(
      el('span', { class: 'name', text: source.label }),
      el('span', { class: live ? 'grid-live' : 'muted', text: live ? 'on air' : sourceKindLabel(source.kind) }),
    );
    tile.classList.toggle('on-air', live);
    tile.title = `Put ${source.label} on air`;
    tile.onclick = () => sendProgram({ mode: 'single', sourceId: source.id });
  }

  for (const tile of [...host.querySelectorAll('.grid-preview-tile')]) {
    if (!seen.has(tile.dataset.grid)) tile.remove();
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
  if (sceneTicker) {
    clearTimeout(sceneTicker);
    sceneTicker = null;
  }
  if (!state.scene) {
    node.textContent = 'No overlay on air.';
    node.className = 'scene-current muted';
    return;
  }
  const seconds = state.scene.persistent ? 'until cleared' : `${Math.round(state.scene.durationMs / 1000)}s`;
  // A countdown has to be seen counting, so the line is repainted once a second
  // while one is running - the picture does the same on the canvas.
  const countdownMs = remainingCountdownMs(state.scene);
  const detail = Object.entries(state.scene.payload || {})
    .filter(([, value]) => value !== '' && value !== null && value !== false && value !== 0)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 40)}`)
    .join(' \u00b7 ');
  const head = countdownMs > 0
    ? `${state.scene.type} (${seconds}) \u00b7 countdown ${formatCountdown(countdownMs)}`
    : `${state.scene.type} (${seconds})`;
  node.textContent = `${head} ${detail}`;
  node.className = 'scene-current';
  if (countdownMs > 0) sceneTicker = setTimeout(renderSceneCurrent, 1000);
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
    // A socket that is down is the one error worth shouting about, and worth a
    // way out: show the banner and try to bring the connection back.
    if (/not connected/i.test(error.message)) {
      showConnectionBanner('Not connected to the studio server - reconnecting...');
      state.socket.connect();
    }
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

/**
 * Open the Share tab.
 *
 * Cameras & screens live in a tab of the studio rather than in a dialog, so the
 * room's Share button simply brings that tab forward - nothing covers the room.
 */
function openSharePanel() {
  activateTab('share');
}

/** The Share tab's actions and hint follow the role. */
function renderDeviceDialogActions() {
  const control = hasControl();
  const labels = control
    ? { studio: 'Add to studio', grid: 'Add to grid', air: 'Put on air' }
    : { studio: 'Publish to the room', grid: 'ask for grid', air: 'ask for air' };
  for (const [mode, label] of Object.entries(labels)) {
    const button = $(`#btn-devices-${mode}`);
    if (button) button.textContent = label;
  }
  const hint = $('#share-status');
  if (hint) {
    hint.textContent = control
      ? 'Tick what to publish, then choose where it goes: the studio, the grid, or straight on air.'
      : 'Tick what to publish: everyone in the room sees and hears it, and the host can put it on the grid or on air.';
  }
}

/** Kept for the wiring that used to close the picker; the Share tab needs none. */
function closeDeviceDialog() {
  return false;
}

/**
 * Publish the ticked devices and send them where the operator asked.
 *
 * The host and co-hosts decide what the viewers receive; anyone else asks, and
 * the request reaches the host immediately.
 */
async function addSelectedDevices(mode) {
  const picker = $('#device-list-picker');
  const status = $('#share-status');
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
  // Tell the room the camera/microphone is on, or every other client keeps
  // showing the avatar even though the media is flowing.
  if (added.length) {
    const patch: any = {};
    if (added.some((source) => source.kind === 'camera' || source.kind === 'screen')) patch.cameraEnabled = true;
    if (added.some((source) => source.stream?.getAudioTracks?.().length)) patch.muted = false;
    if (Object.keys(patch).length) await send(CLIENT.MEMBER_UPDATE, { patch });
  }
  await applyPlacement(mode, added);
  await renderDevicePicker();
  // The pane stays open on purpose: the host works through several devices and
  // placements in a row, so closing it after every click would be busywork.
  if (status) {
    status.textContent = `${status.textContent} Pick the next device, or press Close when you are done.`;
  }
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
    // Unmuting has to be heard: make sure there is a microphone to publish.
    if (!mute) await ensureMicrophone();
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
  // A camera published at any time joins the room mesh, so everyone in the room
  // sees it - being "in the call" is not a prerequisite.
  await publishToRoom(added.stream);
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
    { name: 'countdown', label: 'Countdown (seconds, 0 = none)', type: 'number', value: 0 },
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
    // A countdown on the announcement banner ("doors open in 05:00").
    scene.payload.countdownMs = Number(data.get('countdown') || 0) * 1000;
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
      // The password page (if this room needs one) comes up on its own after the
      // join, between the form and the studio.
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
    $('#join-password-row')?.classList.toggle('hidden', !needsPassword);
  });

  // The password page: set one and enter, or skip and set it inside the room.
  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('#password-status');
    const result = await saveRoomPasswords({
      hostPassword: $('#password-host').value.trim(),
      cohostPassword: $('#password-cohost').value.trim(),
    });
    if (!result && status) status.textContent = 'The password was not saved - try again.';
    else toast('Room password saved', 'ok');
  });

  $('#btn-skip-password').addEventListener('click', skipPasswordPage);
  $('#btn-new-suggestion').addEventListener('click', () => {
    const suggested = suggestPassword();
    $('#password-suggested').value = suggested;
    $('#password-host').value = suggested;
  });
  $('#btn-use-suggestion').addEventListener('click', () => {
    $('#password-host').value = $('#password-suggested').value;
  });

  // Collapse and expand panes from the arrow in each pane's own head.
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('button.pane-toggle[data-pane]');
    if (button) togglePane(button.dataset.pane);
  });

  // Slide, grid or list for the people in the room.
  $('#people-view').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (button) setPeopleView(button.dataset.view);
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

  // Cameras & screens live in the studio's Share tab: the room's Share button and
  // the Cameras pane both bring it forward, and anyone can publish from there.
  $('#btn-open-devices').addEventListener('click', () => {
    if (!requireControl()) return;
    openSharePanel();
  });
  $('#btn-share').addEventListener('click', openSharePanel);
  // Publishing is open to everyone; the placement buttons ask for the host when
  // the client cannot place things itself (see applyPlacement).
  $('#btn-devices-studio').addEventListener('click', () => addSelectedDevices('studio'));
  $('#btn-devices-grid').addEventListener('click', () => addSelectedDevices('grid'));
  $('#btn-devices-air').addEventListener('click', () => addSelectedDevices('air'));

  $('#btn-devices-screen').addEventListener('click', async () => {
    const source = await state.camera.addScreenShare({ audio: $('#screen-audio').checked });
    if (source) {
      await send(CLIENT.MEMBER_UPDATE, { patch: { screenSharing: true } });
      toast(
        hasControl()
          ? 'Screen shared - use the Screen program mode to put it on air'
          : 'Screen shared with the room - the host can put it on air',
        'ok',
      );
      await renderDevicePicker();
    }
  });

  $('#btn-devices-bluetooth').addEventListener('click', async () => {
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

  // (The pane arrows are wired with the landing controls: each pane's own head
  // carries the collapse button.)

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
    await saveRoomPasswords({
      hostPassword: $('#credential-host').value.trim(),
      cohostPassword: $('#credential-cohost').value.trim(),
    });
  });

  // Fill both fields with strong suggestions, ready to save.
  $('#btn-generate-passwords').addEventListener('click', () => {
    $('#credential-host').value = suggestPassword();
    $('#credential-cohost').value = suggestPassword();
    toast('Passwords generated - press Save passwords to apply them', 'info');
  });

  $('#btn-leave-room').addEventListener('click', leaveRoom);
  $('#btn-retry-connection').addEventListener('click', retryConnection);

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
      ...detail.video.map((device, index) => [
        icon('camera', { size: 12 }),
        device.label || `Camera ${index + 1}`,
      ]),
      ...detail.audio.map((device, index) => [
        icon('mic', { size: 12 }),
        device.label || `Microphone ${index + 1}`,
      ]),
    ];
    for (const [glyph, label] of chips) {
      const chip = el('span', { class: 'device-chip', html: glyph });
      chip.append(el('span', { text: label }));
      host.append(chip);
    }
    if (!chips.length) host.append(el('span', { class: 'device-chip', text: 'No devices detected yet' }));
  });

  state.camera.addEventListener('change', () => {
    // A locally captured camera or screen is part of the program picture: push
    // it into the compositor straight away so the preview never lags behind.
    syncCompositorSources();
    renderSources();
    // My own tile shows my video and my controls, so refresh it at once.
    renderParticipants();
    // Whatever I capture goes to the whole room, whether or not I ever pressed
    // "Join call": a viewer's camera is seen by everyone in the room.
    const captured = localMediaStream();
    if (captured) publishToRoom(captured).catch(() => {});
    else if (state.meeting.active) state.meeting.setCameraEnabled(false);
    // The relay follows what I publish (it only runs when peer-to-peer cannot).
    syncRelay();
    // Keep an open Share tab honest about what is already published.
    if ($('#tabs button[data-tab="share"]')?.classList.contains('active')) {
      renderDevicePicker().catch(() => {});
    }
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
    const member = state.members.find((entry) => entry.id === detail.peerId);
    const name = member?.name || 'Guest';

    if (!detail.stream) {
      // One feed ended. Only drop the participant when nothing of theirs is left:
      // a screen can stop while their camera keeps running.
      if (detail.streamId) {
        state.peerStreamIds.delete(detail.streamId);
        state.camera.removeSource(`stream:${detail.streamId}`).catch(() => {});
      }
      const remaining = [...state.peerStreamIds.values()].find((entry) => entry.peerId === detail.peerId);
      if (remaining) {
        state.peerStreams.set(detail.peerId, remaining.stream);
      } else {
        state.peerStreams.delete(detail.peerId);
        state.camera.removeParticipant(detail.peerId);
        grid.querySelector(`[data-peer="${detail.peerId}"]`)?.remove();
      }
      renderParticipants();
      renderGridPreview();
      syncCompositorSources();
      return;
    }

    if (detail.streamId) {
      state.peerStreamIds.set(detail.streamId, { peerId: detail.peerId, stream: detail.stream });
    }
    state.peerStreams.set(detail.peerId, detail.stream);
    const existing = grid.querySelector(`[data-peer="${detail.peerId}"]`);
    const tile = existing || el('div', { class: 'remote-tile', dataset: { peer: detail.peerId } });
    clear(tile);
    const video = el('video', { autoplay: true, playsInline: true });
    video.srcObject = detail.stream;
    // The program mix carries the room, so these tiles stay quiet while it plays.
    video.muted = programAudioTakesOver();
    tile.append(video, el('div', { class: 'name' }, [roleDot(member?.role || 'viewer'), name]));
    grid.append(tile);

    // A screen share (or anything that is not the peer's own camera) is attached
    // under its own id, so it can be composited and a co-host can put it on air.
    const announced = state.sources.find((entry) => entry.meta?.streamId === detail.streamId);
    if (announced && announced.kind !== 'camera') {
      state.camera
        .attachRemoteSource({
          id: `stream:${detail.streamId}`,
          label: `${name} \u00b7 ${sourceKindLabel(announced.kind)}`,
          stream: detail.stream,
          peerId: detail.peerId,
          kind: announced.kind,
        })
        .then(() => {
          syncCompositorSources();
          renderSources();
          renderGridPreview();
        })
        .catch(() => {});
    }

    // Everyone sees the participant in the room straight away; the host and
    // co-hosts also announce them so they can be composited into the program
    // and put on air.
    state.camera
      .addParticipant({ peerId: detail.peerId, label: name, stream: detail.stream, announce: hasControl() })
      .then(() => {
        renderParticipants();
        renderGridPreview();
      })
      .catch(() => {
        renderParticipants();
        renderGridPreview();
      });
  });

  state.meeting.addEventListener('peer-state', ({ detail }) => {
    // A dead connection must not leave a frozen participant in the program.
    if (!['failed', 'closed'].includes(detail.state)) return;
    for (const [streamId, entry] of [...state.peerStreamIds]) {
      if (entry.peerId !== detail.peerId) continue;
      state.peerStreamIds.delete(streamId);
      state.camera.removeSource(`stream:${streamId}`).catch(() => {});
    }
    state.peerStreams.delete(detail.peerId);
    state.camera.removeParticipant(detail.peerId);
    // A dead connection falls back to the socket relay.
    syncRelay();
    renderParticipants();
    renderGridPreview();
    syncCompositorSources();
  });

  // The studio program arriving from the room's owner: the whole room sees and
  // hears the real picture, not a reconstruction of it.
  state.meeting.addEventListener('program-stream', ({ detail }) => {
    state.programStream = detail.stream || null;
    renderProgramFeed();
  });

  state.meeting.addEventListener('error', ({ detail }) => toast(`call error: ${detail.message}`, 'error'));
}

/**
 * "Join call" is about being heard: the room mesh is always up, so joining turns
 * my microphone on (publishing a camera first when I have none).
 */
async function joinCall() {
  try {
    let stream = localMediaStream();
    if (!stream) {
      // Anyone may publish their own camera now; the host still decides what
      // goes out to the viewers.
      const source = await state.camera.addCamera({ announce: true });
      stream = source?.stream || null;
    }
    if (!stream) {
      // No camera? A microphone alone is enough to be heard in the call.
      const microphone = await ensureMicrophone();
      stream = microphone?.stream || null;
    }
    if (!stream) {
      toast('a camera or a microphone is required to join the call', 'error');
      return;
    }
    state.inCall = true;
    await ensureMesh();
    setLocalAudio(true);
    renderParticipants();
    $('#btn-join-call').disabled = true;
    $('#btn-leave-call').disabled = false;
    $('#btn-toggle-mic').disabled = false;
    $('#btn-toggle-cam').disabled = false;
    send(CLIENT.MEMBER_UPDATE, { patch: { cameraEnabled: true, muted: false } });
    toast('You are live in the call', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/**
 * Leaving the call stops publishing me - it does not close the room. The mesh is
 * the room, so everyone still sees and hears the program and each other.
 */
async function leaveCall() {
  state.inCall = false;
  setLocalAudio(false);
  state.meeting.setCameraEnabled(false);
  // A member's camera is meeting media, so it leaves with them; the host keeps
  // the camera that is on the air.
  if (!hasControl()) {
    for (const source of state.camera.list()) {
      if (source.kind === 'camera') await state.camera.removeSource(source.id).catch(() => {});
    }
  }
  renderParticipants();
  $('#btn-join-call').disabled = false;
  $('#btn-leave-call').disabled = true;
  $('#btn-toggle-mic').disabled = true;
  $('#btn-toggle-cam').disabled = true;
  send(CLIENT.MEMBER_UPDATE, { patch: { cameraEnabled: false, muted: true } });
  toast('Microphone off - you still see and hear the room', 'info');
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
