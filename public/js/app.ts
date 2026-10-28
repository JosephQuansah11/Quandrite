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
import { ladderIndexForNetwork } from './quality.js';
import { RoomAudio } from './room-audio.js';
import { AudioRelay, forgetRelayedAudio, playRelayedAudio, relayHopsNs, relayedAudioAnalyser, relayedAudioStats, relayNowNs, resumeRelayedAudio, setRelayedAudioDucked, useRelayClock } from './relay-audio.js';
import { formatLagNs, isStaleNs, relayLagNs } from '/shared/protocol.js';
import { RELAY_STALE_NS } from '/shared/protocol.js';
import { gridColumnsFor } from '/shared/layout.js';
import { formatCountdown, overlayDrawModel, remainingCountdownMs } from '/shared/overlays.js';
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
  /**
   * Relayed pictures (the socket fallback) by sender, when peer-to-peer fails.
   * Each one carries the nanosecond lag it arrived with, split by hop.
   */
  relayFrames: Map<
    string,
    {
      url: string;
      sourceId: string | null;
      kind: string;
      lagNs: bigint | null;
      inboundNs: bigint | null;
      outboundNs: bigint | null;
      at: number;
    }
  >;
  /** The socket picture relay. */
  relay: any;
  /** The socket voice relay: the microphone when peer-to-peer cannot carry it. */
  audioRelay: any;
  /** Who is being heard, from their own audio (drives the tile waves). */
  speaking: any;
  /** What the main view shows: program, people, or both. */
  stageView: any;
  /** The viewer's own choice about the program sound. */
  programMuted: any;
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
  // Chat: the room's conversation, one private thread per person, and what has not been
  // read yet. A private thread only ever holds messages between me and that person.
  chat: [],
  privateChats: new Map(),
  unread: new Map(),
  chatTarget: '',
  pendingAttachment: null,
  /**
   * The breakout room's own primary screen.
   *
   * A breakout is a room of its own, so it has its own sources and its own program: a
   * screen shared inside one is shown to that room and nowhere else. `state.sources` and
   * friends stay the **broadcast** - the parent's picture, which a host runs from
   * wherever they are - and the stage shows whichever of the two the client is standing
   * in (`screenSources()`).
   */
  breakoutScreen: { sources: [], program: { mode: 'single', sourceId: null, gridIds: [], onAir: [] }, scene: null },
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
  audioRelay: null,
  speaking: null,
  stageView: null,
  programMuted: false,
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
let sceneWatchTimer: any = null;
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
/**
 * Mute or unmute **the microphone**, and only the microphone.
 *
 * A screen share has audio of its own - the sound of the tab or the system - and that
 * is not a microphone: muting yourself must not silence what you are presenting. So
 * the microphone tracks are found first (a microphone source, or the audio track that
 * came with a camera) and only those are switched.
 */
function microphoneTracks() {
  const tracks = [];
  for (const source of state.camera.list()) {
    if (source.kind !== 'audio' && source.kind !== 'camera') continue;
    tracks.push(...(source.stream?.getAudioTracks?.() || []));
  }
  return tracks;
}

function setLocalAudio(enabled) {
  const tracks = microphoneTracks();
  for (const track of tracks) track.enabled = enabled;
  // The mesh is told which tracks are the microphone, so it does not reach for the
  // shared screen's audio either.
  state.meeting.setMicEnabled(enabled, tracks);
  // Muting has to stop the relayed bytes too, not just the peer-to-peer ones - again
  // for the microphone only.
  state.audioRelay?.setMuted(!enabled);
  // A microphone that has just been switched on must be heard by the room at
  // once, even when it is the only thing I have published.
  if (enabled) {
    const stream = localMediaStream();
    if (stream) {
      // My own tile shows my wave too - from the same microphone, but never played
      // back at me.
      state.speaking?.track(state.clientId, stream, { monitor: false });
      publishToRoom(stream).catch(() => {});
    }
  } else {
    state.speaking?.forget(state.clientId);
  }
  const button = $('#btn-toggle-mic');
  if (button) iconOnly(button, enabled ? 'mic' : 'micOff', enabled ? 'Mute' : 'Unmute');
  const camera = $('#btn-toggle-cam');
  if (camera) {
    const on = Boolean(myCameraSource());
    iconOnly(camera, on ? 'camera' : 'cameraOff', on ? 'Stop video' : 'Start video');
  }
}

/** True while I am standing in a breakout room. */
function inBreakoutRoom() {
  return Boolean(state.breakoutId);
}

/**
 * The primary screen of the room I am standing in.
 *
 * In the main room that is the **broadcast** - the parent's program, the picture that
 * goes to the platforms. In a breakout it is that room's own screen: its own sources and
 * its own program, which nobody outside the breakout sees. The stage always shows the
 * room I am in, and the studio panes always show the broadcast.
 */
function screenSources() {
  return inBreakoutRoom() ? state.breakoutScreen.sources : state.sources;
}

function screenProgram() {
  return inBreakoutRoom() ? state.breakoutScreen.program : state.program;
}

function screenScene() {
  return inBreakoutRoom() ? state.breakoutScreen.scene : state.scene;
}

/** A source by id, looked up in the screen I am looking at. */
function screenSource(sourceId) {
  return screenSources().find((source) => source.id === sourceId) || null;
}

function syncCompositorSources() {
  const local = new Map(state.camera.list().map((source) => [source.id, source]));
  state.compositor.setSources(
    // Whatever screen the room I am in is showing: the broadcast in the main room, the
    // breakout's own screen inside a breakout.
    screenSources().map((source) => {
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
        // A relayed picture's decoded frames live on the local source, and they are
        // what the compositor draws - so they have to travel with it. Without them
        // it falls back to the <img>, which has no picture at all while it loads.
        frame: media?.frame || null,
        lastFrame: media?.lastFrame || null,
        meta: { ...(source.meta || {}), ...(media?.meta || {}) },
      };
    }),
  );
  // The outgoing video follows the program: a single camera or screen goes out as
  // its own real track, the canvas only carries what has to be composited.
  refreshProgramVideo();
  // The frame follows the picture, and says if a scene is covering it.
  syncProgramFrame();
  // ...and the "add a camera" hint only belongs on an empty program: it used to sit
  // there over a live picture.
  syncProgramHint();
}

/**
 * Is there anything on the program at all?
 *
 * A placed source is the picture, an incoming feed is the picture, and a scene on air
 * is a picture too (it covers whatever is underneath). Only when there is none of the
 * three is the program genuinely empty, and only then does the hint belong on it.
 */
function programHasPicture() {
  // The screen of the room I am in: inside a breakout the parent's feed is not it, and
  // the parent's sources are not either.
  if (!inBreakoutRoom() && state.programStream) return true;
  if (screenSources().length) return true;
  return Boolean(screenScene());
}

function syncProgramHint() {
  const hint = $('#program-empty');
  if (hint) hint.classList.toggle('hidden', programHasPicture());
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
 * A microphone that is not inside a camera.
 *
 * The microphone is usually captured together with the video, which is convenient -
 * until the camera goes away: switching the video off, or the camera ending by
 * itself, stops that stream and takes the voice with it. That is what "the sound
 * broke" looks like. So a microphone of its own is published before that happens.
 */
async function ensureStandaloneMicrophone() {
  const standalone = state.camera
    .list()
    .find((entry) => entry.kind === 'audio' && entry.stream?.getAudioTracks?.().length);
  if (standalone) return standalone;
  return state.camera.addMicrophone({});
}

/**
 * Keep the voice alive when the video goes.
 *
 * Called before a camera is switched off, and again if a camera ends by itself.
 * It is a no-op when I am muted (being quiet is a choice) or when a microphone of
 * its own is already published.
 */
async function keepVoiceAlive() {
  if (!state.roomId) return null;
  const me = state.members.find((member) => member.id === state.clientId);
  if (me?.muted) return null;
  const standalone = state.camera
    .list()
    .find((entry) => entry.kind === 'audio' && entry.stream?.getAudioTracks?.().length);
  if (standalone) return standalone;
  const mic = await ensureStandaloneMicrophone();
  const stream = mic?.stream || localMediaStream();
  if (!stream) return mic;
  state.speaking?.track(state.clientId, stream, { monitor: false });
  publishToRoom(stream).catch(() => {});
  syncRelay();
  return mic;
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
 *
 * Cameras and screens go out as pictures; microphones go out as 16 kHz voice. Both
 * ride the same socket and both stop the moment peer-to-peer is working, because a
 * direct connection is always better.
 */
function syncRelay() {
  if (!state.relay) return;
  if (!relayFallbackNeeded()) {
    if (state.relay.publishing) state.relay.stop();
    if (state.audioRelay?.publishing) state.audioRelay.stop();
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
  syncAudioRelay();
}

/** The kinds of source I actually captured: remote ones must never be relayed back. */
const LOCAL_MEDIA_KINDS = new Set(['camera', 'screen', 'audio']);

/**
 * Voice, once per microphone - not once per stream that happens to contain one.
 *
 * A camera with a microphone in it and the same microphone published on its own
 * are one voice (the device gives them different tracks, so the device id is what
 * is compared), and a *remote* source is somebody else's voice already: relaying
 * it back would send the room its own echo.
 */
function syncAudioRelay() {
  if (!state.audioRelay) return;
  const wanted = new Map();
  const mine = state.camera.list().filter((source) => LOCAL_MEDIA_KINDS.has(source.kind));
  // A dedicated microphone wins over the one built into a camera.
  mine.sort((a, b) => Number(b.kind === 'audio') - Number(a.kind === 'audio'));
  for (const source of mine) {
    const track = source.stream?.getAudioTracks?.()[0];
    if (!track || !source.stream) continue;
    const key = track.getSettings?.().deviceId || track.id;
    if (!wanted.has(key)) wanted.set(key, source);
  }
  for (const source of wanted.values()) {
    state.audioRelay.add({ id: source.id, label: source.label, stream: source.stream });
  }
  const ids = [...wanted.values()].map((source) => source.id);
  for (const id of state.audioRelay.ids) {
    if (!ids.includes(id)) state.audioRelay.remove(id);
  }
}

/** How many late pictures the relay threw away (shown in the studio). */
let relayStale = 0;
/**
 * The newest frame applied, per sender.
 *
 * Decoding is asynchronous, so two frames can be in flight at once and the older
 * one can finish last. Conflating here means the newest picture always wins and
 * the stale decode is simply thrown away - the same rule the sender applies, one
 * step further along the path.
 */
const relayFrameSeq = new Map<string, number>();

/**
 * A picture that arrived over the socket: show it where the live feed would have
 * gone, and hand it to the camera manager so it can be composited too.
 *
 * Every frame is measured in nanoseconds against the shared (server) clock, so the
 * tile can say how old the picture is *and* which hop it was lost on.
 */
async function renderRelayedFrame(header, payload): Promise<void> {
  const from = header?.from;
  if (!from) return;
  const nowNs = relayNowNs();
  const lag = relayLagNs(header, nowNs);
  // The newest picture is the only one worth showing: a late frame carries its
  // delay with it, so it is dropped instead of being painted. A `warm` frame is the
  // exception: it is the still the server kept for newcomers, deliberately older
  // than the live rule allows, and far better than an empty tile.
  if (!header?.warm && isStaleNs(lag.capturedNs, nowNs, RELAY_STALE_NS)) {
    relayStale += 1;
    return;
  }
  const seq = (relayFrameSeq.get(from) || 0) + 1;
  relayFrameSeq.set(from, seq);
  const blob = new Blob([payload], { type: 'image/jpeg' });
  // Decode it first, then swap. An <img> whose src has just changed has no
  // picture until it loads, and the compositor would draw its "connecting..."
  // placeholder over a live tile - which is the flash the program used to show on
  // every relayed frame. A decoded bitmap is always drawable, and it is the fast
  // path for drawImage as well.
  let bitmap = null;
  if (typeof createImageBitmap === 'function') {
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      bitmap = null;
    }
  }
  // A newer frame arrived while this one was decoding: it wins, and this one is
  // dropped rather than painted over it.
  if (relayFrameSeq.get(from) !== seq) {
    bitmap?.close?.();
    return;
  }
  const url = URL.createObjectURL(blob);
  const previous = state.relayFrames.get(from);
  // The old URL is only revoked once the new frame is in hand, so nothing that is
  // still on screen is ever pulled out from under the room.
  if (previous?.url) URL.revokeObjectURL(previous.url);
  state.relayFrames.set(from, {
    url,
    sourceId: header.sourceId || null,
    kind: header.kind || 'camera',
    lagNs: lag.totalNs,
    inboundNs: lag.inboundNs,
    outboundNs: lag.outboundNs,
    at: Date.now(),
  });
  showRelayedPicture(from, url, lag);
  if (header.sourceId) {
    state.camera
      .attachRemoteImage({
        id: header.sourceId,
        label: header.label || `${header.fromName || 'Guest'}'s picture`,
        peerId: from,
        url,
        bitmap,
        kind: header.kind === 'screen' ? 'screen' : 'virtual',
      })
      ?.video &&
      syncCompositorSources();
    renderGridPreview();
  } else if (bitmap) {
    // Nothing composited it: the frame is ours to release.
    bitmap.close?.();
  }
}

/** Put a relayed picture on a peer's tile without rebuilding the whole room. */
function showRelayedPicture(peerId, url, lag: any = null) {
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
  // The whole lag, in whatever unit reads best - microseconds while a hop is
  // healthy, milliseconds once it is not.
  setTransport(tile, `relay ${formatLagNs(lag?.totalNs)}`, 'relay');
  tile.title = lag?.inboundNs != null
    ? `to server ${formatLagNs(lag.inboundNs)} \u00b7 from server ${formatLagNs(lag.outboundNs)}`
    : '';
}

/**
 * Say which path a peer's picture is on.
 *
 * `P2P` is the WebRTC connection (fastest); `relay ~N ms` is the socket fallback
 * and how far behind the picture is - the number to watch when the network is
 * struggling.
 */
function setTransport(tile, text, kind = '') {
  const node = tile?.querySelector('.transport');
  if (!node) return;
  node.textContent = text || '';
  node.className = `transport ${kind}`.trim();
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
  // Inside a breakout the stage is that room's own screen, so the parent's program feed
  // is not shown at all - not just muted. A host in a breakout still runs the broadcast
  // from the studio panes, which is a different thing.
  if (!stream || inBreakoutRoom()) {
    if (node.srcObject) node.srcObject = null;
    node.classList.add('hidden');
    pill?.classList.add('hidden');
    // The program feed is no longer playing, so it is no longer measured.
    state.speaking?.forgetMeter('program');
    applyProgramAudioPolicy();
    syncProgramHint();
    return;
  }
  if (node.srcObject !== stream) node.srcObject = stream;
  node.classList.remove('hidden');
  pill?.classList.remove('hidden');
  // The feed's own sound is measured here: it is played by this element, not by the
  // mixer, so a howl on the program path has to be caught from its stream.
  state.speaking?.analyse('program', stream);
  // An incoming feed is a picture: the "add a camera" hint goes away.
  syncProgramHint();
  if (typeof node.play === 'function') node.play().catch(() => {});
  applyProgramAudioPolicy();
  // The frame takes the shape of the picture the room is watching.
  syncProgramFrame();
}

/**
 * The program mix already contains the room, so the room's own voices are ducked
 * while it plays here - otherwise every voice arrives twice.
 *
 * Ducking happens in the mixer's gains rather than on the tiles' elements: the
 * element only carries the picture, and a voice that is not in a tile (a microphone
 * with no camera) has to be ducked too.
 *
 * The mute button is the viewer's own choice and outranks that: muting the program
 * must actually mute it, whoever else is talking.
 */
function applyProgramAudioPolicy({ ducked = false }: any = {}) {
  const node = $('#program-feed');
  if (node) {
    // A howl arriving on the program feed is muted here: the element is not part of the
    // mixer's graph, so this is the only way to pull it down. The listener's own mute
    // still outranks everything.
    node.muted = Boolean(state.programMuted) || Boolean(state.breakoutId) || Boolean(ducked);
  }
  state.speaking?.setDucked((programAudioTakesOver() && !state.programMuted) || Boolean(ducked));
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
  // The room grid is the main view, and the strip is its side pane: both come from
  // the same roster, so both are painted together.
  renderRoomGrid();
  updateRoomToolbar();
  // Who I can message privately follows the roster.
  renderChatTargets();
  // My own camera is the small picture in the corner, so the room's own view is
  // everybody else: one tile each, all the same size.
  const members = roomMembers().filter((member) => member.id !== state.clientId);
  const strip = $('#participant-strip');
  if (!strip) return;

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
        // Which path the picture is on: P2P, or the socket relay and its delay.
        el('div', { class: 'transport' }),
        // A wave under the tile shows who is talking.
        el('div', { class: 'wave' }, waveBars()),
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
    // Say which path the picture is on: the live connection, or the relay (whose
    // delay is refreshed with every frame).
    if (stream) setTransport(tile, 'P2P', 'p2p');
    else if (!picture) setTransport(tile, '');
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
  // The socket relay: the fallback for cameras, screens and microphones when two
  // networks will not let the browsers reach each other.
  state.relay = new MediaRelay({
    socket: state.socket,
    // Start at the rung the browser thinks the link can carry; the relay's own
    // measurements take over from there.
    startIndex: ladderIndexForNetwork(navigator.connection),
  });
  state.audioRelay = new AudioRelay({ socket: state.socket });
  // Everybody's voice, mixed in one place: one audio context to resume, one gain
  // per peer to duck, and the same graph draws the speaking waves.
  state.speaking = new RoomAudio();
  state.speaking.addEventListener('change', () => applySpeaking());
  // The socket relay is a second audio context with its own output: without this, a
  // howl arriving over the fallback path was played and never noticed.
  state.speaking.meter('relay', relayedAudioAnalyser());
  // A howl is said out loud, and every path it can arrive on is pulled down while it
  // lasts: the mixer itself, the relayed voice, and the program feed's element.
  state.speaking.addEventListener('feedback', ({ detail }: any) => {
    const banner = $('#feedback-banner');
    const text = $('#feedback-banner-text');
    const where = detail.peerId === 'relay' ? ' on the relayed audio' : detail.peerId === 'program' ? ' in the program sound' : '';
    if (text) {
      // A howl is not always one loud note: saying *what gave it away* makes the two
      // signatures visible instead of mysterious.
      const why = detail.reason === 'rising' ? 'climbing out of control' : 'a single loud note';
      text.textContent = detail.active
        ? `Feedback detected${where} (${why}) - audio ducked until it stops`
        : 'Feedback stopped - audio restored';
    }
    banner?.classList.toggle('hidden', !detail.active);
    // The mixer ducks itself; the other two paths are this side's to pull down.
    setRelayedAudioDucked(detail.active);
    applyProgramAudioPolicy({ ducked: detail.active });
    if (detail.active) {
      // The usual cause is a speaker feeding a microphone, and the quickest cure is
      // to stop feeding it: my own microphone is held down as well - and held until the
      // howl is actually gone, so the loop cannot re-form underneath it.
      holdMyMicForFeedback();
      notify(
        'Feedback detected',
        detail.reason === 'rising'
          ? 'The room was climbing into a howl - audio ducked and your microphone held'
          : 'The room was ducked to stop the howl',
        { tag: 'feedback', force: true },
      );
    } else {
      releaseMyMicForFeedback();
    }
  });
  // Both relays time their frames against the server's clock, so the room can
  // compare stamps from different devices.
  useRelayClock(state.socket);

  state.compositor.start();

  // Peer-to-peer first; a picture relay only while a connection is not connected.
  setInterval(syncRelay, 4000);
  // If the browser reports the network changed (a phone moving between wifi and
  // mobile data, say), the ladder starts again from what it says.
  navigator.connection?.addEventListener?.('change', () => {
    const rung = state.relay?.noteNetworkHint?.(navigator.connection);
    if (rung) toast(`Network changed - sending at ${rung.name}`, 'info');
  });

  wireSocket();
  wireCamera();
  wirePublisher();
  wireMeeting();
  wireControls();
  // The bottom bar of the room: mute, video, share, record, leave.
  wireRoomToolbar();
  // Mute, pause and fill for the program, plus the break-countdown guard.
  wireProgramActions();

  state.socket.connect();

  /**
   * What the two paths are doing, from the browser console.
   *
   * `quandriteRelay.stats()` answers the question the fallback exists for: is the
   * room on the peer-to-peer path, or is the socket carrying it - and in
   * nanoseconds, where is the delay actually coming from? `clock` says how well the
   * offset to the server's clock is known, which is the error bar on every number
   * below it.
   */
  (window as any).quandriteRelay = {
    /**
     * The room's audio mixer itself, for testing from the console: feed it a stream
     * and watch the meters, the feedback detector and the gains.
     */
    mixer: state.speaking,
    /**
     * The relay's own meter. The relay plays its voice outside the mixer, so this is the
     * node the feedback detector watches for that path - driving it is how the fallback
     * path's howl handling can be checked from a test.
     */
    relayAnalyser: () => relayedAudioAnalyser(),
    /** The voice relay's sender: what it is publishing, and in which codec. */
    audioRelay: state.audioRelay,
    /**
     * What I am publishing, and whether each track is switched on: the quickest way
     * to see that muting the microphone left a shared screen's audio alone.
     */
    sources: () =>
      state.camera.list().map((source) => ({
        id: source.id,
        kind: source.kind,
        audio: (source.stream?.getAudioTracks?.() || []).map((track) => ({ enabled: track.enabled, label: track.label })),
        video: (source.stream?.getVideoTracks?.() || []).map((track) => ({ enabled: track.enabled })),
      })),
    stats: () => ({
      clock: {
        offsetNs: state.socket.clockOffsetNs?.toString() ?? null,
        accuracyNs: state.socket.clockAccuracyNs?.()?.toString() ?? null,
        samples: state.socket.clockSamples?.length ?? 0,
      },
      video: state.relay?.stats?.() ?? null,
      /**
       * What is actually going out: the program video track and stream identity.
       * These must stay put while the room changes around them - every change here
       * is a restart of the stream ffmpeg is reading, and a blink in the room.
       */
      program: state.compositor
        ? {
            videoTrackId: state.compositor.programVideoTrack?.()?.id ?? null,
            streamId: state.compositor.programStream?.()?.id ?? null,
            publisher: state.publisher?.stats?.() ?? null,
          }
        : null,
      audio: state.audioRelay
        ? { ids: state.audioRelay.ids, sent: state.audioRelay.sent, dropped: state.audioRelay.dropped }
        : null,
      received: relayedAudioStats(),
      /**
       * What the room's audio is doing: per connection, the device's own sample rate and
       * channels, the bitrate ceiling the sender was given, and the Opus parameters the
       * two sides settled on. Voice over the fallback path is reported in `received`
       * (`codec`, `encoded`, `decoded`).
       */
      audioQuality: state.meeting?.audioQuality?.() ?? null,
      /**
       * The room's own audio: one context, a gain per voice. `state` should be
       * `running`, and a peer's `gain` 0 means they are muted or ducked - which is
       * what to look at first when somebody cannot be heard.
       */
      roomAudio: state.speaking?.describe?.() ?? null,
      hops: relayHopsNs()
        ? {
            total: formatLagNs(relayHopsNs().totalNs),
            toServer: formatLagNs(relayHopsNs().inboundNs),
            fromServer: formatLagNs(relayHopsNs().outboundNs),
          }
        : null,
      paths: [...document.querySelectorAll('#participant-strip .participant-tile')].map((tile: any) => ({
        peer: tile.dataset.peer,
        path: tile.querySelector('.transport')?.textContent || '',
      })),
    }),
  };

  // Audio contexts and the program feed both need a user gesture; resume on the
  // first interaction so the room hears the program straight away.
  const resumeAudio = () => {
    state.compositor.resumeAudio();
    // Relayed voice needs the same gesture as the program audio.
    resumeRelayedAudio();
    // ...and so does the room mix, which is how everyone's voice is heard.
    state.speaking?.resume();
    const feed = $('#program-feed');
    if (feed?.srcObject && typeof feed.play === 'function') feed.play().catch(() => {});
  };
  document.addEventListener('pointerdown', resumeAudio, { once: true });
  document.addEventListener('keydown', resumeAudio, { once: true });
  // Coming back to the tab is the common way audio "breaks": phones and background
  // tabs suspend the audio context, and nothing resumes it by itself.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Coming back to a tab is where audio most often stays silent: the browser may
    // have dropped the incoming media while the page was away, so the whole mix is
    // re-attached rather than merely resumed.
    state.speaking?.rebuild();
    resumeRelayedAudio();
    state.compositor.resumeAudio();
    const feed = $('#program-feed');
    if (feed?.srcObject && typeof feed.play === 'function') feed.play().catch(() => {});
    // Coming back to the room means the thread on screen is being read, so the unread
    // count for it goes away.
    if (chatVisible()) markChatRead(chatTargetKey());
    renderNotifyButton();
  });

  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('#join-room').value = params.get('room');
  if (params.get('name')) $('#join-name').value = params.get('name');

  // Nothing can be published before joining a room.
  updateControlAvailability();
  applyPaneVisibility();
  updateJoinControls();
  // The socket is connecting now: say so, with a way to retry by hand.
  showConnectionBanner('Connecting to the studio server...');
  // Before joining there are no studio controls, so show who is here - that is the
  // viewer's own view, not a studio tab.
  if (!hasControl()) setStageView('people', { remember: false });
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
  // The private threads I am part of, handed over on joining.
  socket.on(SERVER.CHAT_HISTORY, (payload) => applyChatHistory(payload));

  // Relayed over the socket (the peer-to-peer fallback): a camera or screen
  // picture, or a slice of voice.
  socket.on('media:frame', ({ header, payload }) => {
    if (header?.kind === 'audio') playRelayedAudio(header, payload);
    // Decoding is asynchronous, so the handler must not reject into nowhere.
    else renderRelayedFrame(header, payload).catch(() => {});
  });

  socket.on(SERVER.MEMBERS_UPDATE, (members) => {
    state.members = members;
    // Anyone who left takes their relayed picture and voice with them.
    for (const [peerId, frame] of state.relayFrames) {
      if (members.some((member) => member.id === peerId)) continue;
      if (frame?.url) URL.revokeObjectURL(frame.url);
      state.relayFrames.delete(peerId);
      relayFrameSeq.delete(peerId);
      forgetRelayedAudio(peerId);
      state.speaking?.forget(peerId);
    }
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
    const before = state.breakouts || { rooms: [] };
    state.breakouts = breakouts || state.breakouts;
    announceBreakouts(before, state.breakouts);
    renderBreakouts();
    renderPeople();
  });

  // The server moved this session between the main room and a breakout room.
  socket.on(SERVER.BREAKOUT_UPDATE, (message) => {
    const previous = state.breakoutId;
    state.breakoutId = message.breakoutId ?? null;
    state.breakouts = message.breakouts || state.breakouts;
    if (Array.isArray(message.members)) state.members = message.members;
    // The studio state always comes from the parent room and the chat from the
    // room just entered, so the roster is left as it is.
    applySnapshot(message.state, { roster: false });
    // The room I have just walked into brings its own primary screen: its sources, its
    // program and its overlay, so the stage is right immediately rather than after the
    // next push.
    applyRoomScreen(message.roomState);
    renderBreakouts();
    renderPeople();
    trackRoomPeers(state.members, { announce: false });
    renderParticipants();
    syncMeetingPeers();
    // Moving rooms changes the meeting mesh and whether the program is audible.
    syncProgramFeed();
    if (previous !== state.breakoutId) renderProgramControls();
    toast(
      state.breakoutId
        ? `You are in ${breakoutLabel(state.breakoutId)}`
        : 'You are back in the main room',
      'ok',
    );
  });

  socket.on(SERVER.BREAKOUT_SOURCES, (sources) => {
    state.breakoutScreen.sources = sources || [];
    syncCompositorSources();
    renderRoomGrid();
    renderGridPreview();
  });
  socket.on(SERVER.BREAKOUT_PROGRAM, (program) => {
    state.breakoutScreen.program = program || state.breakoutScreen.program;
    state.compositor.setProgram(state.breakoutScreen.program);
    syncCompositorSources();
    renderProgramControls();
  });
  socket.on(SERVER.BREAKOUT_SCENE, (scene) => {
    state.breakoutScreen.scene = scene || null;
    // Only the room that is showing it cares: the broadcast's own overlays are the
    // parent's (`scene:update`).
    if (inBreakoutRoom()) {
      state.compositor.setScene(scene || null);
      syncCompositorSources();
    }
  });

  socket.on(SERVER.SOURCES_UPDATE, (sources) => {
    const previous = new Map(state.sources.map((source) => [source.id, source.request ?? null]));
    state.sources = sources;
    // Somebody asked to be on air: the host should hear about it wherever they are.
    if (hasControl()) {
      for (const source of sources) {
        const before = previous.get(source.id);
        if (source.request && before !== source.request) {
          notify(
            `${source.ownerName || 'Someone'} asked for ${source.request === 'air' ? 'the air' : 'the grid'}`,
            source.label || 'a source is waiting',
            { tag: 'requests' },
          );
        }
      }
    }
    // Refresh the preview first: a new camera/screen must appear on the program
    // picture even when it was added by another member.
    syncCompositorSources();
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
    // ...and it may be covering the program, which the frame has to say.
    syncProgramFrame();
  });

  socket.on(SERVER.DESTINATIONS_UPDATE, (destinations) => {
    state.destinations = destinations;
    renderDestinations();
  });

  socket.on(SERVER.STREAM_UPDATE, (stream) => {
    const was = state.stream?.status;
    state.stream = stream;
    renderStreamStatus();
    // The broadcast is the room's main event: say when it starts and when it ends.
    if (stream?.status === 'live' && was !== 'live') {
      notify('You are live', 'The broadcast is going out', { tag: 'stream' });
    } else if (was === 'live' && stream?.status && stream.status !== 'live' && stream.status !== 'stopping') {
      notify('The broadcast stopped', 'The room is off air', { tag: 'stream' });
    }
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
  socket.on(SERVER.MEMBER_MEDIA, async (message) => {
    if (message.muted !== undefined) setLocalAudio(!message.muted);
    if (message.cameraEnabled === false) {
      const source = myCameraSource();
      if (source) {
        // The same rule when the host stops my video: my voice stays.
        await keepVoiceAlive();
        await state.camera.removeSource(source.id);
      }
    }
    const who = message.byName || 'The host';
    const what =
      message.muted === true
        ? `${who} muted you`
        : message.cameraEnabled === false
          ? `${who} stopped your video`
          : `${who} changed your media`;
    toast(what, message.muted === true || message.cameraEnabled === false ? 'info' : 'info');
    // This one is worth saying even when the tab is in front: it explains why the
    // microphone went quiet.
    notify(what, 'You can turn it back on whenever you like', { tag: 'moderation', force: true });
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
    // The studio's own tabs are the host's; a viewer has the room and the bar, and the
    // stage view is already set to the people's view for them.
    if (hasControl()) activateTab('scenes');
    // If the room's record says I was muted or stopped before I got here, it stays
    // true now: a reload must not undo what the host decided.
    applyRoomModeration();
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
  // The room is the view; the studio panes are a drawer over it.
  setRoomOpen(inRoom && !needsPassword);
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
  state.speaking?.stop();
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
  // Chat belongs to the room: leaving takes the threads, the unread counts and the
  // half-written picture with it.
  state.chat = [];
  state.privateChats.clear();
  state.unread.clear();
  state.chatTarget = '';
  setPendingAttachment(null);
  renderChatLog();
  renderChatTargets();
  renderChatBadges();
  setPill('#role-pill', '', 'guest');
  setPill('#breakout-pill', 'hidden', 'main room');
  updateControlAvailability();
  updateJoinControls();
  renderMembers();
  renderPeople();
  renderParticipants();
  renderBreakouts();
  renderCredentials();
  renderDestinations();
  renderStreamStatus();
  renderSceneCurrent();
  renderProgramControls();
  clear($('#remote-grid'));
  renderProgramFeed();
  // Back to the view the next room should open on, and no studio tab to reach for.
  setStageView(defaultStageView(), { remember: false });
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

/**
 * Enforce what the room already decided about my microphone.
 *
 * A host's mute is a decision, not an announcement: if the roster says I am muted and my
 * microphone is switched on - because I reloaded, or reconnected, or the page was
 * reopened - it goes off here too. My own unmute updates the roster first, so this
 * never fights me.
 */
function applyRoomModeration() {
  const me = state.members.find((member) => member.id === state.clientId);
  if (!me?.muted) return;
  if (!microphoneTracks().some((track) => track.enabled)) return;
  setLocalAudio(false);
  renderPeople();
  toast('The host muted you - unmute when you are ready', 'info');
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
  appendChatHistory(snapshot.chat || []);
  renderChatTargets();
  renderChatBadges();

  renderMembers();
  renderPeople();
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

/**
 * The room: everyone in it, as the grid of tiles that fills the window.
 *
 * Built from the same data as the side strip, but this is the view that matters, so
 * it also carries what is being *presented* - a screen share or the program becomes
 * a bigger tile of its own, the way a call app shows the thing being talked about.
 *
 * Tiles are reused, never rebuilt: a stream event fires for every track and every
 * renegotiation, and recreating a `<video>` under a playing stream is what makes
 * cameras flicker.
 */
function renderRoomGrid() {
  const grid = $('#remote-grid');
  if (!grid) return;
  // My own picture is the small one in the corner: the room is everybody *else*, so
  // the tiles stay a grid of participants rather than one of them being me twice.
  const members = roomMembers().filter((member) => member.id !== state.clientId);
  const seen = new Set();

  for (const member of members) {
    seen.add(member.id);
    const isMe = false;
    const stream = member.cameraEnabled ? state.peerStreams.get(member.id) : null;
    let tile = grid.querySelector(`[data-peer="${member.id}"]`);
    if (!tile) {
      tile = el('div', { class: 'room-tile', dataset: { peer: member.id } }, [
        el('div', { class: 'avatar' }),
        el('div', { class: 'wave' }, waveBars()),
        el('div', { class: 'name' }),
      ]);
      grid.append(tile);
    }

    const video = tile.querySelector('video');
    if (stream && !video) {
      // The picture only: the voice is mixed in RoomAudio, so this element is always
      // muted and never depends on the browser's autoplay policy.
      const node = el('video', { autoplay: true, playsInline: true, muted: true });
      node.srcObject = stream;
      tile.prepend(node);
      tile.classList.add('live');
    } else if (stream && video) {
      if (video.srcObject !== stream) video.srcObject = stream;
    } else if (!stream && video) {
      video.remove();
      tile.classList.remove('live');
    }

    // A relayed picture stands in for the live feed when peer-to-peer cannot.
    const frame = state.relayFrames.get(member.id);
    const picture = !stream && (member.cameraEnabled || frame) ? frame?.url || null : null;
    let image = tile.querySelector('img.tile-picture');
    if (picture && !image) {
      image = el('img', { class: 'tile-picture', alt: '' });
      tile.prepend(image);
    }
    if (image) {
      if (picture) image.src = picture;
      else {
        image.remove();
        tile.classList.toggle('live', Boolean(stream));
      }
    }

    tile.querySelector('.avatar').textContent = initials(member.name);
    // A muted participant is really silent in the mix, not just labelled so.
    state.speaking?.setMuted(member.id, Boolean(member.muted));
    // Whoever is on air says so on their own tile - the label belongs on the thing
    // it describes, not in a box somewhere else.
    const onAir = memberIsOnAir(member);
    let badge = tile.querySelector('.badge-air');
    if (onAir && !badge) {
      badge = el('span', { class: 'badge-air' }, ['on air']);
      tile.append(badge);
    } else if (!onAir && badge) {
      badge.remove();
    }
    const name = tile.querySelector('.name');
    clear(name);
    name.append(roleDot(member.role), `${member.name}${isMe ? ' (you)' : ''}`);
    if (member.muted) name.append(el('span', { class: 'pill-badge' }, ['muted']));
    // A host moderates from the tile: mute them, stop their video, right where they are.
    tileTools(tile, member);
  }

  for (const tile of [...grid.querySelectorAll('[data-peer]')]) {
    if (!seen.has(tile.dataset.peer)) tile.remove();
  }

  // What is on air, as its own tile: the program the host is sending, or the screen
  // somebody is sharing. It spans two columns so it reads as the main thing.
  const programTile = grid.querySelector('[data-program]');
  if (programTile) programTile.remove();

  // A grid of participants should be a *grid*: every tile the same size, in as many
  // columns as fit the shape of the space. Tiles are 16:9, so the number of columns
  // is the one that comes closest to filling the box without leaving a ragged row.
  const width = grid.clientWidth || 0;
  const height = grid.clientHeight || 0;
  const tileCount = Math.max(1, members.length);
  const columns = roomGridColumns({ count: tileCount, width, height });
  grid.style.setProperty('--room-columns', String(columns));

  const empty = $('#room-empty');
  if (empty) empty.classList.toggle('hidden', members.length > 0);
  const count = $('#room-heading-count');
  if (count) count.textContent = `${members.length} here`;
  const heading = $('#room-heading-name');
  if (heading) heading.textContent = state.roomId ? `Room ${state.roomId}` : 'Quandrite room';
  const sub = $('#room-heading-sub');
  if (sub) sub.textContent = state.breakoutId ? breakoutLabel(state.breakoutId) : 'main room';
  renderSelfView();
  applySpeaking();
}

/** What is on air, in a few words. */
function onAirLabel() {
  const onAir = state.program.onAir || [];
  const source = state.sources.find((entry) => onAir.includes(entry.id));
  if (source) {
    return `${source.ownerName ? `${source.ownerName} \u00b7 ` : ''}${source.label || sourceKindLabel(source.kind)}`;
  }
  return state.program.mode === 'screenshare' ? 'shared screen' : 'program';
}

/** Is anything this person is publishing on air right now? */
function memberIsOnAir(member) {
  const onAir = state.program.onAir || [];
  if (!onAir.length) return false;
  const mine = state.sources.filter(
    (source) => source.ownerId === member.id || source.meta?.peerId === member.id,
  );
  return mine.some((source) => onAir.includes(source.id));
}

/**
 * How many columns make a *perfect* grid of `count` tiles.
 *
 * Tiles are 16:9, so the answer is the column count whose rows come closest to
 * filling the space without leaving one tile alone on a row - which is what makes a
 * room of five look deliberate rather than accidental.
 */
function roomGridColumns({ count, width, height }) {
  if (count <= 1) return 1;
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  let best = Math.ceil(Math.sqrt(count));
  let bestScore = -Infinity;
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    // How square the whole block would be, with a nudge for filling the last row.
    const blockAspect = (columns * 16) / (rows * 9);
    const squareness = -Math.abs(Math.log(blockAspect / aspect));
    const fullness = count / (columns * rows);
    const score = squareness + fullness * 0.35;
    if (score > bestScore) {
      bestScore = score;
      best = columns;
    }
  }
  // Never wider than the space allows: a tile has to stay watchable.
  const maxColumns = Math.max(1, Math.floor(width / 180) || best);
  return Math.max(1, Math.min(best, maxColumns));
}

/** My own picture, small, in the corner - or nothing when my camera is off. */
function renderSelfView() {
  const card = $('#self-view');
  if (!card) return;
  // My camera, specifically: a shared screen is not a self portrait, and mirroring
  // one would reverse the text in it.
  const stream = myCameraSource()?.stream || null;
  card.hidden = !stream;
  if (!stream) return;
  const video = $('#self-view-video');
  if (video && video.srcObject !== stream) video.srcObject = stream;
  const name = $('#self-view-name');
  if (name) name.textContent = `${state.name || 'You'} (you)`;
  applySelfViewMirror();
  // ...and back where it was dragged to, if it has been moved.
  applySelfViewPosition();
}

/**
 * Whether my own preview is a mirror.
 *
 * It is by default - that is what people expect from a self view - but it can be
 * flipped, because some people would rather see exactly what the room sees. The
 * choice is remembered, and it only ever affects *my* preview: the picture that goes
 * out is never mirrored.
 */
const SELF_MIRROR_KEY = 'quandrite.selfMirror';
function selfViewMirrored() {
  try {
    return localStorage.getItem(SELF_MIRROR_KEY) !== 'plain';
  } catch {
    return true;
  }
}

function applySelfViewMirror() {
  const card = $('#self-view');
  if (!card) return;
  const mirrored = selfViewMirrored();
  card.classList.toggle('unmirrored', !mirrored);
  card.title = mirrored
    ? 'Drag to move your picture; click to see it as the room does'
    : 'Drag to move your picture; click to mirror it';
}

function toggleSelfViewMirror() {
  const next = selfViewMirrored() ? 'plain' : 'mirror';
  try {
    localStorage.setItem(SELF_MIRROR_KEY, next);
  } catch {
    // a browser that will not store it is fine
  }
  applySelfViewMirror();
  toast(next === 'mirror' ? 'Your preview is mirrored' : 'Your preview is as the room sees it', 'info');
}

/**
 * Where my own picture sits.
 *
 * The position is kept as a fraction of the room it can travel across, not as pixels:
 * `1,1` is the bottom-right corner whatever the window is doing, so a layout change or
 * a smaller window never strands the picture half off the edge.
 */
const SELF_POS_KEY = 'quandrite.selfViewPos';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function selfViewPosition() {
  try {
    const raw = localStorage.getItem(SELF_POS_KEY);
    if (!raw) return null;
    const [x, y] = String(raw).split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
  } catch {
    return null;
  }
}

function rememberSelfViewPosition(x, y) {
  try {
    localStorage.setItem(SELF_POS_KEY, `${clamp(x, 0, 1).toFixed(4)},${clamp(y, 0, 1).toFixed(4)}`);
  } catch {
    // a browser that will not store it is fine
  }
}

/** The pixels the picture may travel across inside the room. */
function selfViewBounds() {
  const card = $('#self-view');
  const stage = $('#room-stage');
  if (!card || !stage) return null;
  const area = stage.getBoundingClientRect();
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  return {
    area,
    width,
    height,
    maxX: Math.max(0, area.width - width),
    maxY: Math.max(0, area.height - height),
  };
}

/** Set while a placement is waiting for the browser to measure the room. */
let selfViewPlacementPending = false;

/** Put the picture back where it was put, clamped to the room it is in now. */
function applySelfViewPosition() {
  const card = $('#self-view');
  if (!card || card.hidden) return;
  const pos = selfViewPosition();
  const bounds = selfViewBounds();
  if (!pos || !bounds) return;
  // A join paints before the browser has measured anything, and a room that has not
  // been measured yet would put the picture at 0,0. Wait a frame and try again.
  if (bounds.area.width < 2 || bounds.area.height < 2 || !bounds.width || !bounds.height) {
    if (!selfViewPlacementPending) {
      selfViewPlacementPending = true;
      requestAnimationFrame(() => {
        selfViewPlacementPending = false;
        applySelfViewPosition();
      });
    }
    return;
  }
  card.style.left = `${Math.round(pos.x * bounds.maxX)}px`;
  card.style.top = `${Math.round(pos.y * bounds.maxY)}px`;
  // The corner it starts in is a CSS default; once it has been moved, the pixels rule.
  card.style.right = 'auto';
  card.style.bottom = 'auto';
}

/**
 * Drag my own picture anywhere in the room.
 *
 * A drag moves it and is remembered; a *click* - the pointer that did not travel - still
 * flips the mirror, so the two gestures live on the same card without one stealing the
 * other. Arrow keys do the same job from the keyboard, for anyone who cannot drag.
 */
function wireSelfViewDrag() {
  const card = $('#self-view');
  if (!card) return;
  let drag = null;

  card.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const bounds = selfViewBounds();
    if (!bounds) return;
    const box = card.getBoundingClientRect();
    drag = {
      id: event.pointerId,
      // Where the pointer is inside the card, so it does not jump under the hand.
      grabX: event.clientX - box.left,
      grabY: event.clientY - box.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      bounds,
      last: null,
    };
    try {
      card.setPointerCapture(event.pointerId);
    } catch {
      // a browser without pointer capture still gets the move events
    }
    card.classList.add('dragging');
    event.preventDefault();
  });

  card.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    // A few pixels of travel is a shaky click, not a drag.
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    const { area, maxX, maxY } = drag.bounds;
    const left = clamp(event.clientX - area.left - drag.grabX, 0, maxX);
    const top = clamp(event.clientY - area.top - drag.grabY, 0, maxY);
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.right = 'auto';
    card.style.bottom = 'auto';
    drag.last = { x: maxX ? left / maxX : 0, y: maxY ? top / maxY : 0 };
  });

  const finish = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const { moved, last } = drag;
    drag = null;
    try {
      card.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    card.classList.remove('dragging');
    if (!moved) {
      toggleSelfViewMirror();
      return;
    }
    if (last) rememberSelfViewPosition(last.x, last.y);
  };
  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', finish);

  card.addEventListener('keydown', (event) => {
    const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleSelfViewMirror();
      return;
    }
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    const bounds = selfViewBounds();
    if (!bounds) return;
    const box = card.getBoundingClientRect();
    const left = clamp(box.left - bounds.area.left + step[0] * 16, 0, bounds.maxX);
    const top = clamp(box.top - bounds.area.top + step[1] * 16, 0, bounds.maxY);
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.right = 'auto';
    card.style.bottom = 'auto';
    rememberSelfViewPosition(bounds.maxX ? left / bounds.maxX : 0, bounds.maxY ? top / bounds.maxY : 0);
  });

  // A window that changes size keeps the picture where it was put, relatively...
  window.addEventListener('resize', () => applySelfViewPosition());
  // ...and so does the room itself: it is hidden while the landing page is up and
  // measured as nothing until it opens, so the picture is re-placed every time the
  // stage changes size - which is when a position could have gone stale.
  if (typeof ResizeObserver === 'function') {
    const stage = $('#room-stage');
    if (stage) {
      const observer = new ResizeObserver(() => applySelfViewPosition());
      observer.observe(stage);
    }
  }
}


const ROLE_LABELS = { host: 'host', cohost: 'co-host', viewer: 'viewer', visitor: 'visitor' };

function roleLabel(role) {
  return ROLE_LABELS[role] || role || 'viewer';
}


/**
 * Keep the bottom bar honest about what it would do.
 *
 * The buttons mirror the state the rest of the studio already keeps - whether I am
 * in the call, whether my camera is on, whether I am muted - so there is one answer
 * to each question rather than two that can disagree.
 */
function updateRoomToolbar() {
  const me = state.members.find((member) => member.id === state.clientId);
  const muted = Boolean(me?.muted);
  const camera = Boolean(myCameraSource());
  const sharing = state.camera.list().some((source) => source.kind === 'screen');

  const mic = $('#btn-room-mic');
  if (mic) {
    mic.disabled = !state.inCall;
    mic.classList.toggle('on', !muted && state.inCall);
    mic.setAttribute('aria-pressed', String(!muted && state.inCall));
    const label = mic.querySelector('.room-tool-label');
    if (label) label.textContent = muted ? 'Unmute' : 'Mute';
  }
  const cam = $('#btn-room-cam');
  if (cam) {
    cam.disabled = !state.inCall;
    cam.classList.toggle('on', camera);
    cam.setAttribute('aria-pressed', String(camera));
    const label = cam.querySelector('.room-tool-label');
    if (label) label.textContent = camera ? 'Stop video' : 'Start video';
  }
  const share = $('#btn-room-share');
  if (share) share.classList.toggle('on', sharing);
  const leave = $('#btn-room-leave');
  if (leave) leave.disabled = !state.roomId;
  const studio = $('#btn-room-studio');
  if (studio) {
    const open = !$('#studio-panes')?.classList.contains('hidden');
    studio.setAttribute('aria-pressed', String(Boolean(open)));
    studio.textContent = open ? 'Close studio' : 'Studio';
  }
  const record = $('#btn-room-record');
  if (record) {
    const recording = state.recording?.status === 'recording';
    record.classList.toggle('on', recording);
    const label = record.querySelector('.room-tool-label');
    if (label) label.textContent = recording ? 'Recording' : 'Record';
  }
}

/** Open one of the studio's tabs, showing the studio first. */
function openStudioTab(name) {
  const panes = $('#studio-panes');
  if (panes?.classList.contains('hidden')) panes.classList.remove('hidden');
  $(`#tabs button[data-tab="${name}"]`)?.click();
  updateRoomToolbar();
}

/**
 * Hold my own microphone down while the room is howling.
 *
 * The loop is nearly always the same: a speaker plays the room, a microphone hears
 * it, and the round trip gets louder each time. Ducking what comes *out* breaks the
 * loop from one end; holding what goes *in* down breaks it from the other, and is what
 * stops it coming straight back when the room is turned up again.
 *
 * The hold follows the howl rather than a stopwatch: it starts when the howl does and
 * ends when the howl has been gone for a moment. A fixed timer was what let a loop
 * re-form - the microphone came back while the room was still ringing, and the whole
 * thing started again. The tracks are only disabled, so nothing is lost and nothing has
 * to be re-acquired.
 */
let feedbackMicHeld: any[] = [];
let feedbackMicReleaseTimer: any = null;
let feedbackMicMaxTimer: any = null;
/** How long after the howl stops before the microphone is trusted again. */
const FEEDBACK_MIC_GRACE_MS = 500;
/** A stuck state must not leave somebody muted: this is the backstop. */
const FEEDBACK_MIC_MAX_MS = 10_000;

function holdMyMicForFeedback() {
  if (!state.inCall) return;
  const me = state.members.find((member) => member.id === state.clientId);
  if (me?.muted) return;
  // Already held: the hold simply continues, and the backstop is pushed out.
  if (!feedbackMicHeld.length) {
    feedbackMicHeld = microphoneTracks().filter((track) => track.enabled);
    if (!feedbackMicHeld.length) return;
    for (const track of feedbackMicHeld) track.enabled = false;
  }
  if (feedbackMicReleaseTimer) {
    clearTimeout(feedbackMicReleaseTimer);
    feedbackMicReleaseTimer = null;
  }
  if (feedbackMicMaxTimer) clearTimeout(feedbackMicMaxTimer);
  feedbackMicMaxTimer = setTimeout(() => releaseMyMicForFeedback(), FEEDBACK_MIC_MAX_MS);
}

/** The howl has stopped: give it a moment, then let the microphone back on. */
function releaseMyMicForFeedback() {
  if (!feedbackMicHeld.length) return;
  if (feedbackMicReleaseTimer) clearTimeout(feedbackMicReleaseTimer);
  feedbackMicReleaseTimer = setTimeout(() => {
    feedbackMicReleaseTimer = null;
    const held = feedbackMicHeld;
    feedbackMicHeld = [];
    if (feedbackMicMaxTimer) {
      clearTimeout(feedbackMicMaxTimer);
      feedbackMicMaxTimer = null;
    }
    // Only if I am still in the call and still unmuted: the user's choice wins.
    const current = state.members.find((member) => member.id === state.clientId);
    if (!state.inCall || current?.muted) return;
    for (const track of held) track.enabled = true;
    toast('Microphone back on', 'ok');
  }, FEEDBACK_MIC_GRACE_MS);
}

/**
 * Show or hide the studio panes, optionally opening a tab of them.
 */
function toggleStudio(open = null, tab = null) {
  const panes = $('#studio-panes');
  if (!panes) return;
  const next = open === null ? panes.classList.contains('hidden') : Boolean(open);
  // The studio is a host's and co-host's place. A viewer has the program, the people
  // and the bar, and nothing here can open it for them.
  if (next && !hasControl()) return;
  panes.classList.toggle('hidden', !next);
  // It is a popup over the room, so the room keeps its space rather than shrinking.
  $('#studio')?.classList.toggle('studio-open', next);
  if (next && tab) openStudioTab(tab);
  updateRoomToolbar();
}

/**
 * What the main view shows: the program, the people, or both.
 *
 * This is one container switching between its own children - the same view is never
 * a different page - and a host gets the split by default, because they need to see
 * what is going out and who is in the room at the same time.
 */
function setStageView(view, { remember = true } = {}) {
  const stage = $('#room-stage');
  if (!stage) return;
  // A viewer watches: the split is a host's view, and asking for it is refused rather
  // than silently drawn.
  const allowed = ['program', 'people', 'split'];
  let wanted = allowed.includes(view) ? view : 'people';
  if (wanted === 'split' && !hasControl()) wanted = 'people';
  stage.classList.remove('view-program', 'view-people', 'view-split');
  stage.classList.add(`view-${wanted}`);
  for (const button of $$('#stage-view button')) {
    button.classList.toggle('active', button.dataset.view === wanted);
  }
  if (remember) {
    state.stageView = wanted;
    try {
      localStorage.setItem('quandrite.stageView', wanted);
    } catch {
      // a browser that will not store it is fine
    }
  }
  // The tiles have a new amount of room to fill.
  renderRoomGrid();
  renderGridPreview();
}

/** The view to open with: hosts see both, everyone else sees the room. */
function defaultStageView() {
  if (state.stageView) return state.stageView;
  try {
    const saved = localStorage.getItem('quandrite.stageView');
    if (saved) return saved;
  } catch {
    // ignore
  }
  return hasControl() ? 'split' : 'people';
}

/**
 * The Share picker, in front of the room.
 *
 * The panel itself is the one the studio's Share tab uses: it is *moved* into the
 * dialog while it is open and put back when it closes, so there is one set of
 * checkboxes and one set of handlers, and nobody is sent to another page to tick
 * them.
 */
function openShareDialog() {
  const dialog = $('#share-dialog');
  const body = $('#share-dialog-body');
  const panel = document.querySelector('.tab-panel[data-panel="share"]');
  if (!dialog || !body || !panel) return;
  if (!body.contains(panel)) body.append(panel);
  panel.classList.remove('hidden');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  renderDevicePicker?.();
}

function closeShareDialog() {
  const dialog = $('#share-dialog');
  const panel = document.querySelector('#share-dialog-body .tab-panel[data-panel="share"]');
  if (panel) {
    // Put it back where it lives, so the studio's tab keeps working.
    const home = document.querySelector('#tabs')?.parentElement;
    if (home) home.append(panel);
    panel.classList.add('hidden');
  }
  if (dialog?.open) dialog.close();
}

/**
 * Chat, in front of the room.
 *
 * A viewer has no studio - that is the point - but the conversation is not a studio
 * tool, so the same Chat panel is moved into this dialog while it is open and put
 * back when it closes. One log, one form, one set of handlers.
 */
function openChatDialog() {
  const dialog = $('#chat-dialog');
  const body = $('#chat-dialog-body');
  const panel = document.querySelector('.tab-panel[data-panel="chat"]');
  if (!dialog || !body || !panel) return;
  if (!body.contains(panel)) body.append(panel);
  panel.classList.remove('hidden');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  const input = $('#chat-input');
  if (input) setTimeout(() => input.focus(), 0);
  // Opening the chat reads it, and shows who it can go to.
  renderChatTargets();
  renderChatLog();
  markChatRead(chatTargetKey());
  renderChatBadges();
}

function closeChatDialog() {
  const dialog = $('#chat-dialog');
  const panel = document.querySelector('#chat-dialog-body .tab-panel[data-panel="chat"]');
  if (panel) {
    const home = document.querySelector('#tabs')?.parentElement;
    if (home) home.append(panel);
    panel.classList.add('hidden');
  }
  if (dialog?.open) dialog.close();
}

/**
 * The people panel, in front of the room.
 *
 * The roster is not a studio tab any more (the studio's tabs are the things you *do*),
 * but a host has to be able to reach it: this is where a participant is muted, a video
 * is stopped, a role is granted, breakouts are made and the room's passwords live. The
 * same panel is moved into this dialog while it is open and put back when it closes.
 */
function openPeopleDialog() {
  const dialog = $('#people-dialog');
  const body = $('#people-dialog-body');
  const panel = document.querySelector('.tab-panel[data-panel="people"]');
  if (!dialog || !body || !panel) return;
  if (!body.contains(panel)) body.append(panel);
  panel.classList.remove('hidden');
  renderPeople();
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closePeopleDialog() {
  const dialog = $('#people-dialog');
  const panel = document.querySelector('#people-dialog-body .tab-panel[data-panel="people"]');
  if (panel) {
    const home = document.querySelector('#tabs')?.parentElement;
    if (home) home.append(panel);
    panel.classList.add('hidden');
  }
  if (dialog?.open) dialog.close();
}

/** Keep the newest message in view. */
function scrollChatToEnd() {
  const log = $('#chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

/**
 * Desktop notifications.
 *
 * A studio is a background thing: people share a screen, talk, and look at something
 * else. So a message, a mute, or the broadcast starting is worth a notification when the
 * tab is not the one being looked at - and worth nothing when it is, because the room
 * already says it. They are off until somebody turns them on: asking for the permission
 * on page load is how a browser gets a permanent "block" from an annoyed person.
 */
const NOTIFY_KEY = 'quandrite.notify';

function notificationsSupported() {
  return typeof Notification === 'function';
}

function notificationsWanted() {
  try {
    return localStorage.getItem(NOTIFY_KEY) === 'on';
  } catch {
    return false;
  }
}

function notificationsOn() {
  return notificationsWanted() && notificationsSupported() && Notification.permission === 'granted';
}

function setNotificationsWanted(on) {
  try {
    if (on) localStorage.setItem(NOTIFY_KEY, 'on');
    else localStorage.removeItem(NOTIFY_KEY);
  } catch {
    // a browser that will not store it is fine
  }
  renderNotifyButton();
}

/** The bell: off, on, or waiting for the browser's permission. */
function renderNotifyButton() {
  const button = $('#btn-room-notify');
  if (!button) return;
  const supported = notificationsSupported();
  button.classList.toggle('hidden', !supported);
  const on = notificationsOn();
  button.classList.toggle('on', on);
  button.setAttribute('aria-pressed', String(on));
  const label = button.querySelector('.room-tool-label');
  const denied = supported && Notification.permission === 'denied';
  const text = denied ? 'Blocked' : on ? 'Alerts on' : 'Notify';
  if (label) label.textContent = text;
  button.title = denied
    ? 'This browser has blocked notifications for this site - allow them in the address bar'
    : on
      ? 'Desktop notifications are on - click to turn them off'
      : 'Turn desktop notifications on (messages, mutes, going live)';
}

/** Ask for the permission, from a click: a browser only grants it that way. */
async function enableNotifications() {
  if (!notificationsSupported()) {
    toast('This browser cannot show notifications', 'error');
    return;
  }
  if (Notification.permission === 'denied') {
    toast('Notifications are blocked for this site - allow them in the address bar', 'error');
    return;
  }
  if (Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission().catch(() => 'denied');
    if (permission !== 'granted') {
      toast('Notifications were not allowed', 'info');
      renderNotifyButton();
      return;
    }
  }
  setNotificationsWanted(true);
  toast('Desktop notifications are on', 'ok');
  notify('Notifications are on', 'You will be told about messages, mutes and going live', { force: true });
}

function toggleNotifications() {
  if (notificationsOn()) {
    setNotificationsWanted(false);
    toast('Desktop notifications are off', 'info');
    return;
  }
  enableNotifications();
}

/**
 * Show a notification, if it is wanted and if the room cannot be seen.
 *
 * `force` is for the things that are about *me* - being muted, being stopped - which are
 * worth saying even when the tab is in front, because they explain why the microphone
 * went quiet. `onClick` is for the ones that point at something to do: the notification
 * focuses the tab and opens it.
 */
function notify(title, body = '', { tag = 'quandrite', force = false, onClick = null } = {}) {
  if (!notificationsOn()) return false;
  if (!force && document.visibilityState === 'visible' && document.hasFocus()) return false;
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      window.focus();
      notification.close();
      if (typeof onClick === 'function') onClick();
    };
    return true;
  } catch {
    // A browser that refuses to show one is not a reason to break the room.
    return false;
  }
}

/** The bottom bar's own controls, each delegating to the studio's one behaviour. */
function wireRoomToolbar() {
  $('#btn-room-mic')?.addEventListener('click', () => toggleMyMedia('mic'));
  $('#btn-room-cam')?.addEventListener('click', () => toggleMyMedia('camera'));
  // Share opens the picker in front of the room, never a page of its own.
  $('#btn-room-share')?.addEventListener('click', () => openShareDialog());
  $('#btn-share-close')?.addEventListener('click', () => closeShareDialog());
  $('#share-dialog')?.addEventListener('close', () => closeShareDialog());
  $('#btn-room-record')?.addEventListener('click', () => {
    if (state.recording?.status === 'recording') toast('Recording - stop it from the Go live tab', 'info');
    openStudioTab('platforms');
  });
  $('#btn-room-more')?.addEventListener('click', () => toggleStudio());
  // People and Chat are part of the meeting bar, next to the things you do. Chat is a
  // popup rather than the studio, so a viewer - who has no studio - still has it; the
  // People popup is where the roster and the moderation live, and the top-right
  // switcher is still how the *stage* is set to the room's own view.
  // Breakout rooms: the Rooms button opens the picker, which is also where a
  // notification about the rooms points.
  $('#btn-room-breakout')?.addEventListener('click', () => openBreakoutPicker());
  $('#btn-breakout-close')?.addEventListener('click', () => closeBreakoutPicker());
  $('#breakout-dialog')?.addEventListener('close', () => closeBreakoutPicker());
  $('#btn-room-people')?.addEventListener('click', () => openPeopleDialog());
  $('#btn-people-close')?.addEventListener('click', () => closePeopleDialog());
  $('#people-dialog')?.addEventListener('close', () => closePeopleDialog());
  $('#btn-room-chat')?.addEventListener('click', () => openChatDialog());
  $('#btn-chat-close')?.addEventListener('click', () => closeChatDialog());
  $('#chat-dialog')?.addEventListener('close', () => closeChatDialog());
  $('#btn-room-studio')?.addEventListener('click', () => toggleStudio());
  $('#stage-view')?.addEventListener('click', (event) => {
    const button = (event.target as Element).closest('button[data-view]');
    if (button) setStageView((button as any).dataset.view);
  });
  $('#btn-room-leave')?.addEventListener('click', () => {
    if (state.inCall) leaveCall();
    else leaveRoom();
  });
  // My own picture is a mirror, and clicking it flips that - dragging it moves it
  // anywhere in the room, and that is remembered.
  wireSelfViewDrag();
  updateRoomToolbar();
  renderNotifyButton();
  renderChatTargets();
  renderChatBadges();
}

/**
 * The room is the view; the studio is a drawer over it.
 *
 * Opening the studio never closes the room, and closing it never leaves the room
 * blank: the grid is always underneath.
 */
function setRoomOpen(inRoom) {
  const studio = $('#studio');
  if (!studio) return;
  studio.classList.toggle('hidden', !inRoom);
  document.body.classList.toggle('in-room', Boolean(inRoom));
  if (!inRoom) toggleStudio(false);
  else {
    // A host opens on the split - the program beside the people - and everyone else
    // on the room. It is remembered per browser.
    setStageView(defaultStageView(), { remember: false });
    updateRoomToolbar();
  }
}



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
  chat: '<path d="M4 5h16v11H8l-4 4z"/>',
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
 * Icon only, with the words in the tooltip.
 *
 * The meeting bar already says "Mute" and "Stop video" in full, so the studio's own
 * controls do not need to repeat them - they are the same two actions, and the icon
 * carries the state (a struck-through microphone means muted).
 */
function iconOnly(button, name, label) {
  if (!button) return;
  button.innerHTML = icon(name);
  button.title = label;
  button.setAttribute('aria-label', label);
}

/**
 * Who is who at a glance: a coloured dot next to the name.
 *
 * Cyan is the host, purple is a co-host, and green is everybody who is watching
 * (viewers and visitors).
 */
/**
 * The bars of the speaking wave. The movement itself is a CSS animation, so the
 * meter only has to say *who* is talking, never how loud.
 */
function waveBars(count = 4) {
  return Array.from({ length: count }, (_, index) => el('i', { dataset: { bar: String(index) } }));
}

/**
 * Mark the tiles of everyone being heard.
 *
 * One class toggle per tile from the meter's latest reading: the wave is drawn by
 * the browser, so this costs nothing per frame.
 */
function applySpeaking() {
  const speaking = state.speaking?.speaking || new Set();
  for (const tile of $$('[data-peer]')) {
    tile.classList.toggle('speaking', speaking.has((tile as any).dataset.peer));
  }
}

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
  // The popup's own heading says the same, since it is what the host sees open.
  const dialogCount = $('#people-dialog-count');
  if (dialogCount) {
    dialogCount.textContent = state.members.length
      ? `${state.members.length} in the room`
      : 'nobody yet';
  }
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
    // Message somebody privately, from the roster: the chat opens on that thread.
    if (!isMe) {
      const unread = chatUnread(member.id);
      actions.append(
        el('button', {
          class: `tiny ${unread ? '' : 'ghost'}`,
          dataset: { message: member.id },
          title: `Message ${member.name} privately`,
          html: `${icon('chat', { size: 13 })}<span>Message${unread ? ` (${unread})` : ''}</span>`,
          onclick: () => openChatWith(member.id),
        }),
      );
    }
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
function mediaButton(member, kind, { compact = false } = {}) {
  const isMe = member.id === state.clientId;
  const on = kind === 'mic' ? !member.muted : member.cameraEnabled;
  const action = kind === 'mic' ? (on ? 'Mute' : 'Unmute') : on ? 'Stop video' : 'Start video';
  const name = kind === 'mic' ? (on ? 'mic' : 'micOff') : on ? 'camera' : 'cameraOff';

  if (!isMe && !hasControl()) {
    // A viewer is told the state; a compact control has no room for the words, and the
    // tile already carries a "muted" badge, so nothing is drawn at all.
    if (compact) return null;
    return el('span', {
      class: `media-state ${on ? 'on' : 'off'}`,
      html: `${icon(name, { size: 13 })}<span>${on ? 'on' : 'off'}</span>`,
      title: `${member.name} \u00b7 ${on ? 'on' : 'off'}`,
    });
  }

  const title = `${action}${isMe ? ' (you)' : ` ${member.name}`}`;
  return el('button', {
    class: compact ? `tiny ghost icon-only ${on ? '' : 'off'}` : `tiny ${on ? '' : 'ghost'}`,
    dataset: { media: kind, member: member.id, requires: 'control' },
    title,
    'aria-label': title,
    html: compact ? icon(name, { size: 15 }) : `${icon(name)}<span>${action}</span>`,
    onclick: () =>
      isMe
        ? toggleMyMedia(kind)
        : send(CLIENT.MEMBER_MEDIA, {
            memberId: member.id,
            ...(kind === 'mic' ? { muted: !member.muted } : { cameraEnabled: !member.cameraEnabled }),
          }),
  });
}

/**
 * The host's controls on somebody's tile.
 *
 * Muting and stopping a participant should not mean finding them in a list: they are
 * right there in the grid, so the two buttons are on the tile. The tile is repainted on
 * every roster update, so the buttons are matched by a key and left alone when nothing
 * about them changed - a button that is being clicked must not be replaced under the
 * pointer.
 */
function tileTools(tile, member) {
  let tools = tile.querySelector('.tile-tools');
  if (!hasControl()) {
    tools?.remove();
    return;
  }
  if (!tools) {
    tools = el('div', { class: 'tile-tools', dataset: { requires: 'control' } });
    tile.append(tools);
  }
  const key = `${member.muted ? 'm' : 'u'}:${member.cameraEnabled ? 'on' : 'off'}`;
  if (tools.dataset.key === key) return;
  tools.dataset.key = key;
  clear(tools);
  const mic = mediaButton(member, 'mic', { compact: true });
  const camera = mediaButton(member, 'camera', { compact: true });
  if (mic) tools.append(mic);
  if (camera) tools.append(camera);
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
    // In a breakout the pill is a way out: one click, from anywhere in the room.
    pill.title = inBreakout
      ? `Leave ${breakoutLabel(state.breakoutId)} and go back to the main room`
      : 'You are in the main room';
    pill.disabled = !inBreakout;
    pill.classList.toggle('clickable', inBreakout);
  }
  // The Rooms button is the way in, and the picker follows the state while it is open.
  renderBreakoutButton();
  if ($('#breakout-dialog')?.open) renderBreakoutPicker();

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
    // Who is in the room now, and how many the host's spread suggested - two different
    // numbers, because the suggestion does not put anybody anywhere.
    const inRoom = state.members.filter((member) => member.breakoutId === room.id).length;
    const suggested = state.members.filter((member) => member.suggestedBreakoutId === room.id).length;
    const item = el('li', { class: room.open ? '' : 'off' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'title', text: room.label }),
        el('div', {
          class: 'sub',
          text: [
            room.open ? 'open' : 'closed',
            `${inRoom} in the room`,
            suggested ? `${suggested} suggested` : null,
            state.breakoutId === room.id ? 'you are here' : null,
          ]
            .filter(Boolean)
            .join(' \u00b7 '),
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
        // Renaming: what the room is *for* is what people choosing one need to read.
        el('button', {
          class: 'tiny ghost',
          dataset: { rename: room.id },
          title: `Rename ${room.label}`,
          text: 'rename',
          onclick: () => startBreakoutRename(item, room),
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

/**
 * Rename a breakout room in place.
 *
 * The row turns into an input rather than opening a dialog: it is one word, and the host
 * is looking at the list it belongs to. Enter saves, Escape changes nothing.
 */
function startBreakoutRename(item, room) {
  const title = item.querySelector('.title');
  if (!title || item.querySelector('.breakout-rename')) return;
  const input = el('input', {
    class: 'breakout-rename',
    type: 'text',
    maxlength: '48',
    value: room.label,
    'aria-label': `New name for ${room.label}`,
  });
  const save = async (commit) => {
    const value = input.value.trim();
    input.remove();
    if (!commit || !value || value === room.label) return;
    const result = await send(CLIENT.BREAKOUT_RENAME, { breakoutId: room.id, label: value });
    if (result) toast(`${room.label} is now called ${value}`, 'ok');
    renderBreakouts();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      save(false);
    }
  });
  input.addEventListener('blur', () => save(true));
  title.replaceWith(input);
  input.focus();
  input.select();
}

/** A picker that moves one member between the main room and the breakouts. */
/**
 * Which breakout room to join.
 *
 * A host creates the rooms and opens them; *choosing* one is the participant's, not an
 * assignment. The same picker is what the Rooms button opens and what a notification
 * about the rooms points at, so "go and pick one" is one click from either place.
 */
function openBreakoutPicker() {
  const dialog = $('#breakout-dialog');
  if (!dialog) return;
  renderBreakoutPicker();
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeBreakoutPicker() {
  const dialog = $('#breakout-dialog');
  if (dialog?.open) dialog.close();
}

/** The rooms I can walk into, and where I am now. */
function renderBreakoutPicker() {
  const picker = $('#breakout-picker');
  if (!picker) return;
  const rooms = state.breakouts?.rooms || [];
  clear(picker);

  const summary = $('#breakout-dialog-summary');
  if (summary) {
    const open = rooms.filter((room) => room.open).length;
    summary.textContent = open ? `${open} open` : rooms.length ? 'closed for now' : 'none yet';
  }

  const choice = (id, label, detail, { disabled = false, here = false } = {}) =>
    el('button', {
      type: 'button',
      class: `breakout-choice${here ? ' here' : ''}${disabled ? ' off' : ''}`,
      dataset: { breakout: id || 'main' },
      disabled,
      title: disabled ? 'That room is not open yet' : `Join ${label}`,
      onclick: () => {
        send(CLIENT.BREAKOUT_ASSIGN, { breakoutId: id });
        closeBreakoutPicker();
      },
    }, [
      el('span', { class: 'breakout-choice-name', text: label }),
      el('span', { class: 'breakout-choice-detail muted', text: here ? `${detail} - you are here` : detail }),
    ]);

  picker.append(
    choice(
      null,
      state.breakoutId ? 'Leave this room - back to the main room' : 'Main room',
      `${mainRoomCount()} in the room`,
      { here: !state.breakoutId },
    ),
  );
  if (!rooms.length) {
    picker.append(
      el('p', {
        class: 'muted',
        text: 'The host has not opened any breakout rooms yet. You will be told when they do.',
      }),
    );
    return;
  }
  for (const room of rooms) {
    // Who is *in* the room, not who the host suggested for it: a suggestion that looks
    // like an attendance would be a lie. The whole roster is counted, not just the room I
    // am in - the point of the list is to see where everybody else went.
    const inRoom = state.members.filter((member) => member.breakoutId === room.id).length;
    const suggested = myMemberRecord()?.suggestedBreakoutId === room.id;
    const detail = [
      `${inRoom} in the room`,
      room.open ? null : 'not open yet',
      suggested && state.breakoutId !== room.id ? 'suggested for you' : null,
    ]
      .filter(Boolean)
      .join(' - ');
    picker.append(
      choice(room.id, room.label, detail, {
        disabled: !room.open && state.breakoutId !== room.id,
        here: state.breakoutId === room.id,
      }),
    );
  }
}

/** My own member record, as the room has it. */
function myMemberRecord() {
  return state.members.find((member) => member.id === state.clientId) || null;
}

/** How many people are in the main room - the roster, not just my own room. */
function mainRoomCount() {
  return state.members.filter((member) => !member.breakoutId).length;
}

/**
 * Breakout rooms appeared, or opened.
 *
 * This is the notification the whole thing hangs on: a participant who is talking to
 * somebody does not see the studio change, so they are told - and the notification
 * points at the Rooms button, opening the picker when it is clicked.
 */
function announceBreakouts(before, after) {
  const wasRooms = (before?.rooms || []).length;
  const rooms = after?.rooms || [];
  const openNow = rooms.filter((room) => room.open).length;
  const wasOpen = (before?.rooms || []).filter((room) => room.open).length;
  const mine = (id) => rooms.find((room) => room.id === id)?.label || 'your room';

  if (!wasRooms && rooms.length) {
    notify(
      'Breakout rooms are ready',
      `${rooms.map((room) => room.label).join(', ')} - pick the one you want to join`,
      { tag: 'breakouts', onClick: openBreakoutPicker },
    );
  }
  if (wasOpen === 0 && openNow > 0) {
    notify(
      'Breakout rooms are open',
      'Choose a room to join, or stay in the main room',
      { tag: 'breakouts', onClick: openBreakoutPicker },
    );
  }
  // A rename is worth knowing about when the name is what you were looking at.
  for (const room of rooms) {
    const previous = (before?.rooms || []).find((entry) => entry.id === room.id);
    if (previous && previous.label !== room.label) {
      notify(`${previous.label} is now ${room.label}`, 'The breakout room was renamed', {
        tag: `breakout-${room.id}`,
      });
    }
  }
  if (state.breakoutId && !rooms.some((room) => room.id === state.breakoutId)) {
    notify('Back to the main room', `${mine(state.breakoutId)} was closed`, { tag: 'breakouts' });
  }
}

/** The Rooms button: only there when the room actually has breakout rooms. */
function renderBreakoutButton() {
  const button = $('#btn-room-breakout');
  if (!button) return;
  const rooms = state.breakouts?.rooms || [];
  button.classList.toggle('hidden', rooms.length === 0);
  const open = rooms.filter((room) => room.open).length;
  const waiting = Boolean(open) && !state.breakoutId;
  const badge = $('#breakout-unread');
  if (badge) {
    badge.textContent = String(open);
    // The badge is "there is somewhere to go", not a count of unread messages.
    badge.classList.toggle('hidden', !waiting);
  }
  button.classList.toggle('on', Boolean(state.breakoutId));
  button.title = open
    ? `${open} breakout room(s) open - pick one to join`
    : rooms.length
      ? 'Breakout rooms exist but are closed'
      : 'Breakout rooms - pick one to join';
  const label = button.querySelector('.room-tool-label');
  if (label) label.textContent = state.breakoutId ? breakoutLabel(state.breakoutId) : 'Rooms';
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
  // A role can change mid-session - a seat is handed over, a viewer is made a
  // co-host - so the view is re-checked here as well: a viewer is never left looking
  // at a split, and never left with a studio they cannot use.
  if (!hasControl()) {
    if (state.stageView === 'split') setStageView('people');
    toggleStudio(false);
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

/**
 * Refresh what the studio shows about sources.
 *
 * There is no Cameras pane any more - devices are added from the Share picker, and
 * arranged in the grid preview - so this is just the two things that still belong to
 * the host's view of the room: who is asking to go on air, and the grid itself.
 */
function renderSources() {
  renderSourceRequests();
  renderGridPreview();
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
  // The bar shows the screen I am looking at: the broadcast in the main room, the
  // breakout's own screen inside a breakout.
  const program = screenProgram();
  for (const button of $('#program-mode').querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.mode === program.mode);
  }
  const labels = (program.onAir || [])
    .map((id) => screenSource(id)?.label || id)
    .join(', ');
  // Where the on-air label used to be: it now sits on the tiles themselves - the room
  // grid marks whoever is on air, and so does the grid preview - so there is nothing
  // to write here. `labels` is still handy in the console for a quick look.
  void labels;
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
  // Two different things, said plainly: whether the broadcast is going out to any
  // platform, and whether this room is being recorded. The recording status is
  // translated first, because the server's own words ("idle") are not an explanation.
  const recordingWord = {
    idle: 'not recording',
    recording: 'recording',
    starting: 'starting',
    stopping: 'saving',
    ready: 'saved',
    failed: 'recording failed',
  }[recording.status || 'idle'] || recording.status;
  setPill('#live-pill', live ? 'live' : '', live ? stream.status : 'off air');
  setPill('#rec-pill', recording.status === 'recording' ? 'rec' : '', recordingWord);
  const livePill = $('#live-pill');
  if (livePill) {
    livePill.title = live
      ? `Sending to ${(state.destinations || []).length} platform(s) - status: ${stream.status}`
      : 'Nothing is being sent to any platform: the room is just a room';
  }
  const recPill = $('#rec-pill');
  if (recPill) {
    recPill.title = (recording.status || 'idle') === 'idle'
      ? 'This room is not being recorded'
      : `Recording status: ${recording.status}`;
  }
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

/** The key of the room's own conversation, as opposed to a private thread. */
const CHAT_ROOM_KEY = 'room';

/** Who a message belongs to: the room, or the thread with the other person. */
function chatThreadKey(message) {
  if (!message?.to) return CHAT_ROOM_KEY;
  return message.authorId === state.clientId ? message.to : message.authorId;
}

function chatThread(key) {
  if (key === CHAT_ROOM_KEY) return state.chat;
  if (!state.privateChats.has(key)) state.privateChats.set(key, []);
  return state.privateChats.get(key);
}

function memberName(id) {
  return state.members.find((member) => member.id === id)?.name || 'someone who left';
}

/** The thread on screen right now. */
function chatTargetKey() {
  return state.chatTarget || CHAT_ROOM_KEY;
}

/** Is the log actually in front of me? A hidden tab or a closed popup is not. */
function chatVisible() {
  const log = $('#chat-log');
  if (!log) return false;
  const panel = log.closest('.tab-panel');
  if (panel?.classList.contains('hidden')) return false;
  const dialog = log.closest('dialog');
  if (dialog && !dialog.open) return false;
  return true;
}

function chatUnread(key) {
  return state.unread.get(key) || 0;
}

function bumpUnread(key) {
  state.unread.set(key, chatUnread(key) + 1);
  renderChatBadges();
  renderChatTargets();
}

function markChatRead(key = chatTargetKey()) {
  if (!state.unread.has(key)) return;
  state.unread.delete(key);
  renderChatBadges();
  renderChatTargets();
}

/** The unread count on the Chat button, so a message is never missed. */
function renderChatBadges() {
  const total = [...state.unread.values()].reduce((sum, count) => sum + count, 0);
  const badge = $('#chat-unread');
  if (badge) {
    badge.textContent = String(total);
    badge.classList.toggle('hidden', total === 0);
  }
  const button = $('#btn-room-chat');
  if (button) {
    button.title = total ? `${total} unread message(s) - open the chat` : 'Chat with the room';
  }
}

/** Who the next message goes to: everyone, or one person. */
function renderChatTargets() {
  const select = $('#chat-target');
  if (!select) return;
  const others = roomMembers().filter((member) => member.id !== state.clientId);
  const current = state.chatTarget || '';
  clear(select);
  select.append(el('option', { value: '', text: 'Everyone in the room' }));
  for (const member of others) {
    const unread = chatUnread(member.id);
    select.append(
      el('option', {
        value: member.id,
        text: `${member.name}${unread ? ` (${unread} new)` : ''} \u00b7 private`,
      }),
    );
  }
  // Somebody who left mid-conversation: the thread stays reachable while it is open.
  if (current && !others.some((member) => member.id === current)) {
    select.append(el('option', { value: current, text: `${memberName(current)} \u00b7 left the room` }));
  }
  select.value = current;
  const hint = $('#chat-hint');
  if (hint) hint.textContent = current ? 'Private - only you two can see this' : 'Everyone in the room sees this';
  const input = $('#chat-input');
  if (input) input.placeholder = current ? `Message ${memberName(current)} privately` : 'Message the room';
}

function chatPicture(attachment) {
  const image = el('img', {
    class: 'chat-picture',
    src: attachment.url,
    alt: attachment.name || 'picture',
    loading: 'lazy',
  });
  return el(
    'a',
    {
      class: 'chat-picture-link',
      href: attachment.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: `${attachment.name || 'picture'} \u00b7 open in a new tab`,
    },
    [image],
  );
}

function chatLine(message) {
  if (message.kind === 'system') {
    return el('div', { class: 'chat-line system', text: message.text });
  }
  const parts = [
    el('span', {
      class: 'who',
      text: `${message.authorName}${message.to ? ' (private)' : ''}: `,
    }),
  ];
  if (message.text) parts.push(el('span', { text: message.text }));
  if (message.attachment) parts.push(chatPicture(message.attachment));
  parts.push(el('span', { class: 'at', text: fmtTime(message.at) }));
  return el('div', { class: 'chat-line' }, parts);
}

/** Paint the thread that is selected, newest at the bottom. */
function renderChatLog() {
  const log = $('#chat-log');
  if (!log) return;
  const key = chatTargetKey();
  clear(log);
  const messages = key === CHAT_ROOM_KEY ? state.chat : state.privateChats.get(key) || [];
  if (!messages.length) {
    log.append(
      el('div', {
        class: 'chat-empty muted',
        text:
          key === CHAT_ROOM_KEY
            ? 'No messages yet. Say hello, or attach a picture.'
            : `No private messages with ${memberName(key)} yet.`,
      }),
    );
  }
  for (const message of messages) log.append(chatLine(message));
  log.scrollTop = log.scrollHeight;
}

/**
 * A message arrived.
 *
 * It goes into its own thread - the room's, or the private one with the other person -
 * and only the thread on screen is repainted. Anything else is counted as unread and
 * announced, so a message in a closed chat or a background tab is not missed.
 */
function appendChat(message) {
  if (!message) return;
  const key = chatThreadKey(message);
  chatThread(key).push(message);
  const visible = chatVisible() && key === chatTargetKey();
  if (visible) {
    renderChatLog();
    markChatRead(key);
  } else {
    bumpUnread(key);
  }
  if (message.kind !== 'system') announceChat(message, key, visible);
}

/** Say it out loud when the message cannot be seen. */
function announceChat(message, key, visible) {
  if (visible) return;
  if (message.authorId === state.clientId) return;
  const isPrivate = key !== CHAT_ROOM_KEY;
  notify(
    isPrivate ? `Private message from ${message.authorName}` : `${message.authorName} in the room chat`,
    message.text || (message.attachment ? 'sent a picture' : ''),
    { tag: isPrivate ? `chat-${key}` : 'chat-room' },
  );
}

/** The room's history, as handed over on joining. */
function appendChatHistory(messages = []) {
  state.chat = [];
  for (const message of messages) state.chat.push(message);
  renderChatLog();
}

/** Private threads handed over on joining, so a reload does not lose a conversation. */
function applyChatHistory(payload) {
  const threads = payload?.threads || {};
  state.privateChats = new Map();
  for (const [peerId, messages] of Object.entries(threads)) {
    state.privateChats.set(peerId, Array.isArray(messages) ? messages : []);
  }
  renderChatTargets();
  renderChatLog();
}

/** Open the chat on one conversation - what "Message" in the roster does. */
function openChatWith(memberId) {
  state.chatTarget = memberId || '';
  openChatDialog();
  renderChatTargets();
  markChatRead(chatTargetKey());
}

/** How wide or tall a chat picture may be once it is scaled down. */
const CHAT_IMAGE_MAX_EDGE = 1280;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('the file could not be read'));
    reader.readAsDataURL(file);
  });
}

/**
 * Scale a picture down, and hand back a data URL the server will accept.
 *
 * A phone screenshot is several megabytes; scaled to 1280px it is a couple of hundred
 * kilobytes, which is what makes sending one instant. A photograph becomes a JPEG and
 * anything else keeps its format - a screenshot of a slide should stay sharp, and
 * resizing a GIF would throw its animation away, so GIFs go as they are.
 */
async function prepareChatImage(file) {
  if (!file || !/^image\//.test(String(file.type))) return null;
  if (file.type === 'image/gif') {
    return { dataUrl: await readAsDataUrl(file), width: 0, height: 0, name: file.name, mime: file.type };
  }
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const scale = Math.min(1, CHAT_IMAGE_MAX_EDGE / Math.max(bitmap.width || 1, bitmap.height || 1));
  const width = Math.max(1, Math.round((bitmap.width || 1) * scale));
  const height = Math.max(1, Math.round((bitmap.height || 1) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const dataUrl = canvas.toDataURL(mime, 0.85);
  return { dataUrl, width, height, name: file.name || 'picture', mime };
}

/** Upload a picture, then show it waiting to be sent. */
async function attachChatImage(file) {
  if (!state.roomId) return;
  let prepared;
  try {
    prepared = await prepareChatImage(file);
  } catch {
    prepared = null;
  }
  if (!prepared) {
    toast('That file is not a picture this room can send', 'error');
    return;
  }
  const response = await fetch(`/api/rooms/${encodeURIComponent(state.roomId)}/chat/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dataUrl: prepared.dataUrl,
      name: prepared.name,
      width: prepared.width,
      height: prepared.height,
    }),
  }).catch(() => null);
  const body = response ? await response.json().catch(() => null) : null;
  if (!response?.ok || !body?.attachment) {
    toast(body?.error || 'the picture could not be uploaded', 'error');
    return;
  }
  setPendingAttachment(body.attachment);
}

/** Show (or clear) the picture waiting to be sent. */
function setPendingAttachment(attachment) {
  state.pendingAttachment = attachment || null;
  const box = $('#chat-pending');
  if (!box) return;
  box.classList.toggle('hidden', !attachment);
  if (!attachment) {
    const image = $('#chat-pending-image');
    if (image) image.removeAttribute('src');
    return;
  }
  const image = $('#chat-pending-image');
  if (image) image.src = attachment.url;
  const name = $('#chat-pending-name');
  if (name) name.textContent = attachment.name || 'picture';
  const size = $('#chat-pending-size');
  if (size) {
    size.textContent = `${Math.max(1, Math.round(attachment.bytes / 1024))} KB${attachment.width ? ` \u00b7 ${attachment.width}\u00d7${attachment.height}` : ''}`;
  }
}


function updateControlAvailability() {
  const live = ['live', 'connecting', 'reconnecting', 'stopping'].includes(state.stream?.status);
  const canAddSources = hasControl() && Boolean(state.roomId);
  $('#btn-go-live').disabled = !hasControl() || live;
  $('#btn-stop-live').disabled = !hasControl() || !live;
  $('#btn-clear-scene').disabled = !hasControl();
  // The Cameras pane is gone; devices are added from Share, so this button no longer
  // exists and nothing needs disabling.
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
  // The broadcast needs control; a breakout's own screen does not - anyone there may put
  // their own source up (the server decides, and says so if it refuses).
  if (!inBreakoutRoom() && !requireControl('Only the host or a co-host can change the program output')) {
    return Promise.resolve(null);
  }
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
  // The picker comes to the front, over the room: nobody is sent to another page to
  // choose a camera.
  openShareDialog();
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

  // Inside a breakout there is nobody to ask: the room's screen is its own, so sharing
  // your screen puts it up there - for that room, and nobody else.
  if (!hasControl() && !inBreakoutRoom()) {
    for (const id of ids) await send(CLIENT.SOURCE_UPDATE, { sourceId: id, patch: { request: mode } });
    toast(`Asked the host to put you ${mode === 'air' ? 'on air' : 'in the grid'}`, 'ok');
    return;
  }

  if (mode === 'air') {
    await sendProgram({ mode: 'single', sourceId: ids[ids.length - 1] });
    if (inBreakoutRoom()) toast(`Your screen is up in ${breakoutLabel(state.breakoutId)}`, 'ok');
    return;
  }
  const gridIds = [...new Set([...(screenProgram().gridIds || []), ...ids])];
  await sendProgram({ mode: 'grid', gridIds });
}

/** Apply one member's request to the program (host and co-hosts only). */
function applyRequest(source) {
  if (!requireControl('Only the host or a co-host can change the program')) return Promise.resolve(null);
  if (source.request === 'air') return sendProgram({ mode: 'single', sourceId: source.id });
  const gridIds = [...new Set([...(state.program.gridIds || []), source.id])];
  return sendProgram({ mode: 'grid', gridIds });
}

/**
 * Take on the primary screen of the room I have walked into.
 *
 * In the main room that is the broadcast again, so the room's own screen is cleared and
 * the compositor goes back to the parent's program. Inside a breakout it is that room's
 * sources and program, which is what the stage then shows.
 */
function applyRoomScreen(roomState) {
  if (inBreakoutRoom() && roomState) {
    state.breakoutScreen.sources = roomState.sources || [];
    state.breakoutScreen.program = roomState.program || state.breakoutScreen.program;
    state.breakoutScreen.scene = roomState.scene || null;
  } else {
    state.breakoutScreen.sources = [];
    state.breakoutScreen.program = { mode: 'single', sourceId: null, gridIds: [], onAir: [] };
    state.breakoutScreen.scene = null;
  }
  state.compositor.setProgram(screenProgram());
  state.compositor.setScene(screenScene());
  syncCompositorSources();
  renderProgramControls();
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
    // Turning the video off must not turn the voice off: the microphone is usually
    // inside the camera's stream, so one of its own is published first.
    await keepVoiceAlive();
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

/**
 * The program's own controls, and the guard that stops a break becoming a blackout.
 *
 * A countdown is a countdown, not a blackout: when it runs out the room goes back
 * to whatever it was watching. If anything *else* is covering the program, the
 * frame says so - and a host can take it off air from right there.
 */
function wireProgramActions() {
  const mute = $('#btn-program-mute');
  mute?.addEventListener('click', () => {
    state.programMuted = !state.programMuted;
    mute.setAttribute('aria-pressed', String(state.programMuted));
    mute.textContent = state.programMuted ? 'Unmute sound' : 'Mute sound';
    applyProgramAudioPolicy();
  });

  const pause = $('#btn-program-pause');
  pause?.addEventListener('click', () => {
    const node = $('#program-feed');
    if (!node) return;
    const nowPaused = !node.paused;
    if (nowPaused) node.pause();
    else node.play().catch(() => {});
    pause.setAttribute('aria-pressed', String(nowPaused));
    pause.textContent = nowPaused ? 'Resume video' : 'Pause video';
  });

  const fill = $('#btn-program-fill');
  fill?.addEventListener('click', () => {
    const on = document.body.classList.toggle('program-fill');
    fill.setAttribute('aria-pressed', String(on));
    fill.textContent = on ? 'Exit fill' : 'Fill screen';
  });

  $('#btn-program-clear')?.addEventListener('click', () => {
    clearScene().catch(() => {});
  });

  watchSceneExpiry();
}

/**
 * Keep the frame honest: its shape follows the picture that is on air, and the
 * sound follows the mute button (a breakout room always keeps the program quiet,
 * because its own conversation matters more).
 */
function syncProgramFrame() {
  // The program bar is the host's: the mode buttons and the stream's own numbers.
  const bar = document.querySelector('.program-bar');
  if (bar) bar.hidden = !hasControl();
  const frame = document.querySelector('.program-frame');
  if (frame) {
    const track = state.compositor?.programVideoTrack?.();
    const settings = track?.getSettings?.() || {};
    const width = Number(settings.width) || 0;
    const height = Number(settings.height) || 0;
    // A screen share is often wider or taller than 16:9, and the frame follows it -
    // so the picture is surrounded by itself and never by empty black.
    frame.style.setProperty('--program-aspect', width && height ? `${width} / ${height}` : '16 / 9');
  }

  const notice = $('#program-blocked');
  if (notice) {
    const covering = sceneCoversProgram(state.scene);
    notice.classList.toggle('hidden', !covering);
    if (covering) {
      const label = $('#program-blocked-text');
      if (label) {
        label.textContent = `"${state.scene?.type || 'a scene'}" is covering the program - the room cannot see the picture.`;
      }
      const clear = $('#btn-program-clear');
      if (clear) clear.disabled = !hasControl();
    }
  }
}

/** True when the on-air scene covers the program picture completely. */
function sceneCoversProgram(scene) {
  if (!scene) return false;
  try {
    return Boolean(overlayDrawModel(scene, { width: 1920, height: 1080, now: Date.now() }).blocksProgram);
  } catch {
    return false;
  }
}

/**
 * Nothing on air may outlive its own countdown.
 *
 * A break announcement is the usual case: the host sets five minutes, the room
 * sees the countdown, and when it reaches zero the room must be looking at what it
 * was looking at before - without anybody having to be told.
 */
function watchSceneExpiry() {
  if (sceneWatchTimer) return;
  sceneWatchTimer = setInterval(() => {
    if (!state.scene) return;
    const counted = Number(state.scene.payload?.countdownMs || 0) > 0;
    if (!counted || remainingCountdownMs(state.scene) > 0) {
      syncProgramFrame();
      return;
    }
    if (hasControl()) {
      toast('Break over - back to the program', 'ok');
      clearScene().catch(() => {});
    }
    syncProgramFrame();
  }, 1000);
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
    if (!button) return;
    // Share is a picker, not a pane: it opens in front of the room.
    if (button.dataset.tab === 'share') {
      openShareDialog();
      return;
    }
    activateTab(button.dataset.tab);
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
    const attachment = state.pendingAttachment;
    // A picture on its own is a message: there is nothing to type.
    if (!text && !attachment) return;
    input.value = '';
    setPendingAttachment(null);
    const result = await send(CLIENT.CHAT_SEND, {
      text,
      to: state.chatTarget || null,
      attachment,
    });
    if (!result) toast('the message did not send', 'error');
  });

  // Who the message goes to. A private thread is between two people, and the room's own
  // conversation is the default.
  $('#chat-target')?.addEventListener('change', (event) => {
    state.chatTarget = (event.target as any).value || '';
    renderChatTargets();
    renderChatLog();
    markChatRead(chatTargetKey());
    $('#chat-input')?.focus();
  });

  // Pictures: the button opens the file picker, and a paste into the message box
  // attaches what was on the clipboard.
  $('#btn-chat-attach')?.addEventListener('click', () => $('#chat-file')?.click());
  $('#chat-file')?.addEventListener('change', (event) => {
    const file = (event.target as any).files?.[0];
    (event.target as any).value = '';
    if (file) attachChatImage(file);
  });
  $('#btn-chat-pending-cancel')?.addEventListener('click', () => setPendingAttachment(null));
  $('#chat-input')?.addEventListener('paste', (event) => {
    const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    event.preventDefault();
    attachChatImage(file);
  });
  // Dropping a picture on the chat does the same as pasting one.
  const chatPanel = document.querySelector('.tab-panel[data-panel="chat"]');
  chatPanel?.addEventListener('dragover', (event) => event.preventDefault());
  chatPanel?.addEventListener('drop', (event) => {
    const file = (event as any).dataTransfer?.files?.[0];
    if (!file) return;
    event.preventDefault();
    attachChatImage(file);
  });

  // Desktop notifications, off until somebody asks for them.
  $('#btn-room-notify')?.addEventListener('click', () => toggleNotifications());

  // Cameras & screens live in the Share picker: the room's Share button and the
  // studio's Share tab both bring it forward, and anyone can publish from there.
  void 0;
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

  // Anyone can go back to the main room: from the banner, or from the pill in the top bar
  // - wherever they happen to be looking.
  $('#btn-leave-breakout').addEventListener('click', leaveBreakoutRoom);
  $('#breakout-pill').addEventListener('click', leaveBreakoutRoom);
}

/** Leave the breakout room I am in, and go back to the main room. */
function leaveBreakoutRoom() {
  if (!state.breakoutId) return;
  const from = breakoutLabel(state.breakoutId);
  send(CLIENT.BREAKOUT_ASSIGN, { breakoutId: null });
  toast(`Left ${from} - you are back in the main room`, 'info');
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
  // The devices chip list lived in the Cameras pane, which is gone: the Share picker
  // is where devices are listed now, and it renders them from the same enumeration.

  state.camera.addEventListener('change', () => {
    // A locally captured camera or screen is part of the program picture: push
    // it into the compositor straight away so the preview never lags behind.
    syncCompositorSources();
    // My own tile shows my video and my controls, so refresh it at once.
    renderParticipants();
    // Whatever I capture goes to the whole room, whether or not I ever pressed
    // "Join call": a viewer's camera is seen by everyone in the room.
    const captured = localMediaStream();
    if (captured) publishToRoom(captured).catch(() => {});
    else if (state.meeting.active) {
      state.meeting.setCameraEnabled(false);
      // A camera that ended by itself (unplugged, taken by another app) must not
      // take the microphone with it.
      keepVoiceAlive().catch(() => {});
    }
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
        renderRoomGrid();
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
    // The room grid owns the tiles now: it reuses them, so a stream event never
    // rebuilds the element under a playing video (which is what made them flicker).
    renderRoomGrid();
    // Their voice goes into the room mix, whether or not their camera is on - a
    // microphone on its own used to have no element to play through at all.
    state.speaking?.track(detail.peerId, detail.stream, { muted: Boolean(member?.muted) });
    applySpeaking();

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
    state.speaking?.forget(detail.peerId);
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
    // The room's record decides whether joining the call turns my microphone on: if the
    // host muted me, I join the call muted rather than overruling them by pressing a
    // button. Unmuting is one click away, and it is mine to make.
    const me = state.members.find((member) => member.id === state.clientId);
    const held = Boolean(me?.muted);
    setLocalAudio(!held);
    renderParticipants();
    $('#btn-join-call').disabled = true;
    send(CLIENT.MEMBER_UPDATE, { patch: { cameraEnabled: true, muted: held } });
    toast(
      held
        ? 'You are in the call, muted - the host muted you. Unmute when you are ready.'
        : 'You are live in the call',
      held ? 'info' : 'ok',
    );
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
