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
import { CLIENT, SERVER, canControlBroadcast } from '/shared/protocol.js';

const state = {
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
  sceneForm: { type: 'title' },
  inCall: false,
  publishing: false,
};

const hasControl = () => canControlBroadcast(state.role);

function wsUrl() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
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
}

function wireSocket() {
  const socket = state.socket;

  socket.on('open', () => {
    setPill('#connection-pill', 'online', 'online');
  });

  socket.on('close', () => {
    setPill('#connection-pill', 'offline', 'reconnecting');
  });

  socket.on(SERVER.WELCOME, (message) => {
    state.clientId = message.clientId;
    state.overlayDefinitions = message.overlayDefinitions || {};
    state.platforms = message.platforms || [];
    renderSceneButtons();
    renderPlatformOptions();
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
    if (state.inCall) state.meeting.sync(members.map((member) => member.id));
  });

  socket.on(SERVER.SOURCES_UPDATE, (sources) => {
    state.sources = sources;
    renderSources();
  });

  socket.on(SERVER.PROGRAM_UPDATE, (program) => {
    state.program = program;
    state.compositor.setProgram(program);
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

  socket.on(SERVER.WEBRTC_SIGNAL, (message) => {
    state.meeting.handleSignal(message);
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

async function joinRoom({ name, roomId, role }) {
  state.name = name;
  state.roomId = roomId;
  const result = await state.socket.join({ roomId, name, role });
  state.role = result.role;
  state.clientId = result.clientId;
  state.roomId = result.roomId;

  applySnapshot(result.snapshot);
  setPill('#role-pill', `role-${result.role}`, result.role);
  setPill('#connection-pill', 'online', 'online');
  toast(`Joined ${result.roomId} as ${result.role}`, 'ok');
  updateControlAvailability();
  loadRecordings();
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  state.members = snapshot.members || [];
  state.sources = snapshot.sources || [];
  state.program = snapshot.program || state.program;
  state.scene = snapshot.scene || null;
  state.destinations = snapshot.destinations || [];
  state.stream = snapshot.stream || state.stream;
  state.recording = snapshot.recording || state.recording;
  state.presets = snapshot.presets || state.presets;

  state.compositor.setProgram(state.program);
  state.compositor.setScene(state.scene);
  state.compositor.setBadges({ label: snapshot.room?.name || 'Quandrite' });

  clear($('#chat-log'));
  for (const message of snapshot.chat || []) appendChat(message);

  renderMembers();
  renderSources();
  renderDestinations();
  renderStreamStatus();
  renderSceneCurrent();
  renderProgramControls();
  renderPresetOptions();
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

function renderSources() {
  const grid = $('#source-grid');
  clear(grid);
  $('#source-count').textContent = `(${state.sources.length})`;

  const localIds = new Set(state.camera.list().map((source) => source.id));
  const onAir = new Set(state.program.onAir || []);

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
          text: `${source.ownerName} \u00b7 ${source.kind}`,
        }),
      );
    }

    const bar = el('div', { class: 'tile-bar' }, [
      el('span', { class: 'name', text: source.label }),
      el('span', { class: 'muted', text: source.kind }),
    ]);

    if (hasControl()) {
      bar.append(
        el('button', {
          class: 'tiny',
          title: 'Put this source on the program output',
          text: onAir.has(source.id) ? 'on air' : 'air',
          onclick: () => sendProgram({ mode: 'single', sourceId: source.id }),
        }),
        el('button', {
          class: 'tiny',
          title: 'Toggle this source in the multi-camera grid',
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
  $('#btn-go-live').disabled = !hasControl() || live;
  $('#btn-stop-live').disabled = !hasControl() || !live;
  $('#btn-clear-scene').disabled = !hasControl();
  $('#btn-add-camera').disabled = !state.roomId;
  $('#btn-add-all-cameras').disabled = !state.roomId;
  $('#btn-share-screen').disabled = !state.roomId;
  for (const node of document.querySelectorAll('#program-mode button')) node.disabled = !hasControl();
}

// ------------------------------------------------------------------- actions

async function send(type, payload = {}) {
  try {
    return await state.socket.send(type, payload);
  } catch (error) {
    toast(error.message, 'error');
    return null;
  }
}

function sendProgram(program) {
  if (!hasControl()) {
    toast('Only the host or a co-host can change the program output', 'error');
    return Promise.resolve(null);
  }
  return send(CLIENT.PROGRAM_SET, program);
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

function renderSceneForm() {
  const form = $('#scene-form');
  clear(form);
  const fields = SCENE_FIELDS[state.sceneForm.type] || [];

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
    if (!name || !roomId) return;
    try {
      await joinRoom({ name, roomId, role });
      history.replaceState(null, '', `/?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(name)}`);
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#tabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]');
    if (!button) return;
    for (const node of $('#tabs').querySelectorAll('button')) node.classList.toggle('active', node === button);
    for (const panel of document.querySelectorAll('.tab-panel')) {
      panel.classList.toggle('hidden', panel.dataset.panel !== button.dataset.tab);
    }
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

  $('#btn-add-camera').addEventListener('click', async () => {
    const devices = await state.camera.enumerate();
    const next = devices.video.find((device) => !state.camera.get(`camera:${device.deviceId}`));
    await state.camera.addCamera({ deviceId: next?.deviceId ?? null });
  });

  $('#btn-add-all-cameras').addEventListener('click', async () => {
    const added = await state.camera.addAllCameras();
    toast(added.length ? `Added ${added.length} camera(s)` : 'No new cameras found', added.length ? 'ok' : 'error');
  });

  $('#btn-share-screen').addEventListener('click', async () => {
    const source = await state.camera.addScreenShare({ audio: $('#screen-audio').checked });
    if (source) {
      await send(CLIENT.MEMBER_UPDATE, { patch: { screenSharing: true } });
      toast('Screen shared - use the Screen program mode to put it on air', 'ok');
    }
  });

  $('#btn-pair-bluetooth').addEventListener('click', async () => {
    const result = await state.camera.pairBluetooth();
    if (result?.ok) toast(`Paired ${result.name || 'device'} - added ${result.added} camera(s)`, 'ok');
  });

  $('#btn-join-call').addEventListener('click', joinCall);
  $('#btn-leave-call').addEventListener('click', leaveCall);
  $('#btn-toggle-mic').addEventListener('click', () => {
    const next = !state.meeting.micEnabled;
    state.meeting.setMicEnabled(next);
    $('#btn-toggle-mic').textContent = next ? 'Mute' : 'Unmute';
    send(CLIENT.MEMBER_UPDATE, { patch: { muted: !next } });
  });
  $('#btn-toggle-cam').addEventListener('click', () => {
    const next = !state.meeting.cameraEnabled;
    state.meeting.setCameraEnabled(next);
    $('#btn-toggle-cam').textContent = next ? 'Camera off' : 'Camera on';
    send(CLIENT.MEMBER_UPDATE, { patch: { cameraEnabled: next } });
  });

  $('#btn-refresh-recordings').addEventListener('click', loadRecordings);
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

  state.camera.addEventListener('change', ({ detail }) => {
    state.compositor.setSources(detail);
    renderSources();
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
    if (!detail.stream) {
      existing?.remove();
      return;
    }
    const name = state.members.find((member) => member.id === detail.peerId)?.name || 'Guest';
    const tile = existing || el('div', { class: 'remote-tile', dataset: { peer: detail.peerId } });
    clear(tile);
    const video = el('video', { autoplay: true, playsInline: true });
    video.srcObject = detail.stream;
    tile.append(video, el('div', { class: 'name', text: name }));
    grid.append(tile);
  });

  state.meeting.addEventListener('error', ({ detail }) => toast(`call error: ${detail.message}`, 'error'));
}

async function joinCall() {
  try {
    let stream = state.camera.primaryStream();
    if (!stream) {
      const source = await state.camera.addCamera({});
      stream = source?.stream || null;
    }
    if (!stream) {
      toast('a camera is required to join the call', 'error');
      return;
    }
    state.inCall = true;
    await state.meeting.join(stream, state.members.map((member) => member.id));
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
  $('#btn-join-call').disabled = false;
  $('#btn-leave-call').disabled = true;
  $('#btn-toggle-mic').disabled = true;
  $('#btn-toggle-cam').disabled = true;
  send(CLIENT.MEMBER_UPDATE, { patch: { cameraEnabled: false, screenSharing: false } });
}

async function loadRecordings() {
  if (!state.roomId) return;
  const list = $('#recording-list');
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(state.roomId)}/recordings`);
    const data = await response.json();
    clear(list);
    if (!data.recordings?.length) {
      list.append(el('li', {}, [el('div', { class: 'grow muted', text: 'No recordings yet.' })]));
      return;
    }
    for (const entry of data.recordings) {
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
