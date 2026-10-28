/**
 * Static wiring checks.
 *
 * These guard the seams that a browser-only bug would otherwise hide: module
 * imports, protocol constants, DOM ids referenced from the client, and the
 * overlay catalogue staying in step with the scene forms in the UI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CLIENT, SERVER, REQUESTABLE_SCENE_TYPES, decodeRelayFrame, encodeRelayFrame, isRelayFrame, pushPayload } from '../shared/protocol.ts';
import { REQUESTABLE_OVERLAY_TYPES } from '../shared/overlays.ts';

const rootDir = path.resolve(import.meta.dirname, '..');
const CLIENT_DIR = path.join(rootDir, 'public', 'js');
const HTML = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(rootDir, 'public', 'styles.css'), 'utf8');

function clientFiles() {
  return fs
    .readdirSync(CLIENT_DIR)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.join(CLIENT_DIR, file));
}

function moduleFiles() {
  const files = [];
  for (const dir of ['shared', 'server', 'public/js']) {
    for (const file of fs.readdirSync(path.join(rootDir, dir))) {
      if (file.endsWith('.ts')) files.push(path.join(rootDir, dir, file));
    }
  }
  return files;
}

function exportedNames(file) {
  const source = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(
    /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/g,
  )) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default/.test(source)) names.add('default');
  return names;
}

/**
 * Where a specifier points on disk.
 *
 * The browser loads the compiled `.js` twins of the shared modules and of its
 * own siblings, while the server imports the `.ts` sources directly, so both
 * spellings resolve to the same source file.
 */
function resolveSpecifier(file, specifier) {
  if (specifier.startsWith('/shared/')) {
    return path.join(rootDir, specifier.slice(1).replace(/\.js$/, '.ts'));
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return path.join(path.dirname(file), specifier.replace(/\.js$/, '.ts'));
  }
  return null;
}

test('every module import resolves to a real export', () => {
  const problems = [];
  for (const file of moduleFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/import\s+([^;]+?)\s+from\s+'([^']+)'/g)) {
      const [, clause, specifier] = match;
      const target = resolveSpecifier(file, specifier);
      if (!target) continue;

      if (!fs.existsSync(target)) {
        problems.push(`${path.relative(rootDir, file)} imports missing module ${specifier}`);
        continue;
      }

      const braces = /\{([^}]*)\}/.exec(clause);
      if (!braces) continue;
      const available = exportedNames(target);
      for (const part of braces[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name && !available.has(name)) {
          problems.push(`${path.relative(rootDir, file)} imports '${name}' which ${specifier} does not export`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('the client only uses protocol constants the server defines', () => {
  const problems = [];
  for (const file of clientFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\b(CLIENT|SERVER)\.([A-Z_]+)\b/g)) {
      const table = match[1] === 'CLIENT' ? CLIENT : SERVER;
      if (!(match[2] in table)) {
        problems.push(`${path.basename(file)} uses ${match[1]}.${match[2]} which does not exist`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every DOM id the client reaches for exists in the page', () => {
  const ids = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const problems = [];
  for (const file of clientFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)['"]\)/g)) {
      if (!ids.has(match[1])) problems.push(`${path.basename(file)} -> #${match[1]}`);
    }
    for (const match of source.matchAll(/getElementById\(['"]([A-Za-z0-9_-]+)['"]\)/g)) {
      if (!ids.has(match[1])) problems.push(`${path.basename(file)} -> #${match[1]}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the page loads assets that actually exist', () => {
  const assets = [...HTML.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(assets.length >= 2);
  // The browser is served the compiled client from `build/`, not the sources.
  for (const asset of assets) {
    assert.ok(fs.existsSync(path.join(rootDir, 'build', 'public', asset.replace(/^\//, ''))), `${asset} exists`);
  }
});

test('the scene form in the UI covers every overlay type', () => {
  const source = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  const block = /const SCENE_FIELDS = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(block, 'SCENE_FIELDS is declared in app.ts');
  const keys = [...block[1].matchAll(/^\s{2}([a-z]+):\s*\[/gm)].map((match) => match[1]);
  assert.deepEqual(keys.sort(), [...REQUESTABLE_OVERLAY_TYPES].sort());
  assert.deepEqual([...REQUESTABLE_SCENE_TYPES].sort(), [...REQUESTABLE_OVERLAY_TYPES].sort());
});

test('host-only panes are marked and hidden from viewers and visitors', () => {
  const source = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(source, /function applyRoleVisibility\(\)/, 'the role visibility helper exists');
  assert.match(source, /dataset\.requires/, 'the helper reads the data-requires markers');

  const marked = [...HTML.matchAll(/data-requires="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(marked.includes('control'), 'camera/screen controls are control-only');
  assert.ok(marked.includes('host'), 'the password pane is host-only');

  for (const id of [
    'sources-panel',
    'program-mode',
    'scene-form',
    'destination-form',
    'broadcast-box',
    'room-credentials',
  ]) {
    assert.ok(
      new RegExp(`id="${id}"[^>]*data-requires=`).test(HTML),
      `${id} is gated by role`,
    );
  }
});

test('the grid preview belongs to the host and co-hosts; the program preview to everyone', () => {
  assert.ok(/id="grid-panel"[^>]*data-requires="control"/.test(HTML), 'the grid preview pane is control-only');
  assert.ok(HTML.includes('id="grid-preview"'), 'the grid preview has a body');
  assert.ok(HTML.includes('id="grid-preview-summary"'), 'the grid preview says what it shows');
  assert.ok(
    /class="panel grid-panel" id="grid-panel" data-pane="grid" data-requires="control"/.test(HTML),
    'the grid pane is control-only, and its arrow lives in its own head',
  );

  const source = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(source, /function renderGridPreview\(\)/, 'the grid preview renders');
  assert.match(source, /function gridPreviewSources\(\)/, 'it previews the grid sources');
  assert.match(source, /import \{ gridColumnsFor \} from '\/shared\/layout\.js'/, 'it reuses the program grid maths');
  assert.match(
    source,
    /if \(!hasControl\(\) \|\| panel\?\.classList\.contains\('pane-collapsed'\)\) return;/,
    'viewers and visitors never get a grid preview',
  );
  assert.match(source, /state\.program\.gridIds/, 'it follows the grid the studio holds');
  assert.match(source, /renderGridPreview\(\);/, 'the preview is refreshed with the sources');
  assert.match(source, /state\.peerStreams\.get\(source\.ownerId\)/, 'a remote source shows its owner call video');

  // The program preview is deliberately not gated: it is the whole output.
  assert.ok(HTML.includes('id="program-canvas"'), 'everyone gets the program preview');
  assert.ok(!/data-pane="program"[^>]*data-requires=/.test(HTML), 'the program pane is for every role');
});

test('the page offers a People tab with the roster, roles and passwords', () => {
  for (const id of [
    'people-list',
    'people-summary',
    'credential-form',
    'credential-host',
    'credential-cohost',
    'join-password',
    'btn-devices-bluetooth',
  ]) {
    assert.ok(HTML.includes(`id="${id}"`), `${id} exists in the page`);
  }
  assert.match(HTML, /data-tab="people"/, 'the People tab is in the tab strip');
  assert.match(HTML, /option value="visitor"/, 'visitors can join without a password');

  const source = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(source, /CLIENT\.MEMBER_ROLE/, 'the roster can grant roles');
  assert.match(source, /CLIENT\.ROOM_UPDATE/, 'the host can rotate the passwords');
});

test('the page offers breakout controls and scopes the call to the room', () => {
  for (const id of [
    'breakout-panel',
    'breakout-count',
    'breakout-duration',
    'breakout-summary',
    'breakout-list',
    'breakout-announce-form',
    'breakout-announce-text',
    'btn-create-breakouts',
    'btn-open-breakouts',
    'btn-close-breakouts',
    'btn-shuffle-breakouts',
    'btn-clear-breakouts',
    'btn-leave-breakout',
    'breakout-banner',
    'breakout-banner-text',
    'breakout-pill',
  ]) {
    assert.ok(HTML.includes(`id="${id}"`), `${id} exists in the page`);
  }
  assert.ok(/id="breakout-panel"[^>]*data-requires="control"/.test(HTML), 'the breakout panel is host-only');

  const source = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(source, /function meetingPeerIds\(\)/, 'the call is scoped to the current room');
  assert.match(source, /roomKeyOf/, 'members are compared by room');

  const membersHandler = /SERVER\.MEMBERS_UPDATE,[\s\S]*?\n  \}\);/.exec(source);
  assert.ok(membersHandler, 'the members:update handler exists');
  assert.match(membersHandler[0], /syncMeetingPeers\(\)/, 'the roster re-syncs the call');

  for (const constant of [
    'BREAKOUT_CREATE',
    'BREAKOUT_ASSIGN',
    'BREAKOUT_SHUFFLE',
    'BREAKOUT_OPEN',
    'BREAKOUT_CLOSE',
    'BREAKOUT_CLEAR',
    'BREAKOUT_ANNOUNCE',
  ]) {
    assert.match(source, new RegExp(`CLIENT\\.${constant}`), `${constant} is wired up`);
  }
  assert.match(source, /SERVER\.BREAKOUT_UPDATE/, 'the move push is handled');
  assert.match(source, /SERVER\.BREAKOUTS_UPDATE/, 'the catalogue push is handled');
});

test('the participants panel and the camera picker act immediately', () => {
  for (const id of ['people-count', 'btn-invite', 'btn-unmute-me', 'btn-claim-host']) {
    assert.ok(HTML.includes(`id="${id}"`), `${id} exists in the page`);
  }

  // The join call must carry the password, or a host claim from the UI fails.
  const socket = fs.readFileSync(path.join(CLIENT_DIR, 'ws.ts'), 'utf8');
  assert.match(socket, /join\(\{ roomId, name, role, password \}\)/, 'the password is forwarded on join');

  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(app, /Nothing ticked\? Then act on what is already published/, 'the picker acts on what is published');
  // The picker stays open: the host works through several devices in a row.
  const addSelected = /async function addSelectedDevices\([\s\S]*?\n\}/.exec(app);
  assert.ok(addSelected, 'addSelectedDevices is declared');
  assert.ok(
    !/closeDeviceDialog\(\)/.test(addSelected[0]),
    'acting on a device never closes the pane - the actions stay available',
  );
  assert.match(app, /function activateTab\(name\)[\s\S]*renderPeople\(\);/, 'a tab click paints its panel');
  assert.match(app, /name === 'recordings'[\s\S]*renderRecordings\(state\.recordings\)/, 'the library paints from cache');
  assert.match(app, /function claimHost\(\)/, 'the host seat can be claimed from the panel');
  assert.match(app, /function inviteToRoom\(\)/, 'invite copies a room link');
  assert.match(app, /function unmuteMe\(\)/, 'unmute me turns the microphone back on');
  assert.match(app, /class: 'person-avatar'/, 'rows carry a Zoom-style avatar');

  // Every participant controls their own media on their own tile.
  assert.match(app, /function myTileActions\(\)/, 'my tile carries mic and camera buttons');
  assert.match(app, /function updateMyTileActions\(/, 'the tile buttons are updated in place');
  assert.match(app, /dataset: \{ tile: 'mic' \}/, 'the tile has a microphone button');
  assert.match(app, /dataset: \{ tile: 'camera' \}/, 'the tile has a camera button');
  assert.match(app, /dataset: \{ tile: 'grid' \}/, 'a viewer can ask for the grid from their tile');
  assert.match(app, /dataset: \{ tile: 'air' \}/, 'a viewer can ask for the air from their tile');
  assert.match(app, /if \(isMe\) children\.push\(myTileActions\(\)\)/, 'only my tile gets the controls');
});

test('the program preview is refreshed whenever sources or the program change', () => {
  const source = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(source, /function syncCompositorSources\(\)/, 'the compositor sync helper exists');

  const handler = (constant, param) =>
    new RegExp(`SERVER\\.${constant},\\s*\\(${param}\\)\\s*=>\\s*\\{([\\s\\S]*?)\\n  \\}\\);`).exec(source);

  const sourcesUpdate = handler('SOURCES_UPDATE', 'sources');
  assert.ok(sourcesUpdate, 'the sources:update handler exists');
  assert.match(sourcesUpdate[1], /syncCompositorSources\(\)/, 'sources:update refreshes the preview');

  const programUpdate = handler('PROGRAM_UPDATE', 'program');
  assert.ok(programUpdate, 'the program:update handler exists');
  assert.match(programUpdate[1], /syncCompositorSources\(\)/, 'program:update refreshes the preview');

  const cameraChange = /state\.camera\.addEventListener\('change',[\s\S]*?\n  \}\);/.exec(source);
  assert.ok(cameraChange, 'the camera change handler exists');
  assert.match(cameraChange[0], /syncCompositorSources\(\)/, 'a new local camera refreshes the preview');

  const snapshot = /function applySnapshot\([\s\S]*?\n\}/.exec(source);
  assert.ok(snapshot, 'applySnapshot exists');
  assert.match(snapshot[0], /syncCompositorSources\(\)/, 'joining a room refreshes the preview');
});

test('cameras live in one pop-up pane and every pane collapses from its own head', () => {
  for (const id of [
    'device-list-picker',
    'share-status',
    'btn-open-devices',
    'btn-devices-studio',
    'btn-devices-grid',
    'btn-devices-air',
    'btn-devices-screen',
    'btn-devices-bluetooth',
    'source-requests',
    'btn-mute-all',
    'btn-stop-all-video',
  ]) {
    assert.ok(HTML.includes(`id="${id}"`), `${id} exists in the page`);
  }

  // The four panes are addressable, and the old inline buttons are gone.
  for (const pane of ['program', 'grid', 'participants', 'sources', 'sidebar']) {
    assert.ok(new RegExp(`data-pane="${pane}"`).test(HTML), `${pane} is a pane`);
  }
  assert.ok(!HTML.includes('id="btn-add-camera"'), 'the inline camera buttons are gone');
  assert.ok(!HTML.includes('id="btn-add-all-cameras"'), 'the inline camera buttons are gone');
  assert.ok(
    /class="panel sources-panel" id="sources-panel" data-pane="sources" data-requires="control"/.test(HTML),
    'the camera pane is host-only, and its arrow lives in its own head',
  );

  const source = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(source, /function applyPaneVisibility\(\)/, 'panes can be hidden');
  assert.match(source, /localStorage\.setItem\(PANE_KEY/, 'the choice persists');
  assert.match(source, /function renderDevicePicker\(\)/, 'the picker lists devices');
  assert.match(source, /function addSelectedDevices\(mode\)/, 'the picker publishes devices');
  assert.match(source, /function applyPlacement\(/, 'placement goes to the studio, grid or air');
  assert.match(source, /function mediaButton\(/, 'the people view has mic and camera controls');
  assert.match(source, /CLIENT\.MEMBER_MEDIA/, 'the host can switch someone else media');
  assert.match(source, /function announceRequests\(/, 'the host hears about requests at once');
  assert.match(source, /function applyRequest\(/, 'a request can be applied in one click');
  assert.match(source, /SERVER\.MEMBER_MEDIA/, 'a forced change is applied locally');
  assert.match(source, /attachTrack\(/, 'a camera published mid-call is attached');
});

test('a dropped socket is visible, retryable and never loses the room', () => {
  assert.ok(HTML.includes('id="connection-banner"'), 'the page has a connection banner');
  assert.ok(HTML.includes('id="btn-retry-connection"'), 'the banner has a retry button');
  assert.ok(HTML.includes('id="connection-banner-text"'), 'the banner says what is happening');

  const source = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(source, /function showConnectionBanner\(/, 'the banner can be shown');
  assert.match(source, /function retryConnection\(/, 'the connection can be retried by hand');
  assert.match(source, /socket\.on\('close'[\s\S]*?showConnectionBanner\(/, 'a dropped socket is announced');
  assert.match(source, /socket\.on\('socket-error'[\s\S]*?showConnectionBanner\(/, 'a failed socket is announced');
  assert.match(source, /socket\.on\('open'[\s\S]*?hideConnectionBanner\(\)/, 'a live socket clears the banner');
  assert.match(source, /state\.reconnecting = true;[\s\S]{0,200}rejoinRoom\(\)/, 'the room is re-joined automatically');
  assert.match(source, /function retryConnection\(\)[\s\S]*?state\.socket\.connect\(\)/, 'retry opens the socket again');
  // The join bar stays: Rejoin and Leave, never a dead end.
  assert.ok(HTML.includes('id="btn-join"'), 'the join button is addressable');
  assert.ok(HTML.includes('id="btn-leave-room"'), 'the room can be left');
  assert.match(source, /function updateJoinControls\(\)/, 'the join bar reflects the room');
  assert.match(source, /async function leaveRoom\(\)/, 'leaving does not need a reload');
  assert.match(source, /function resetClientRoom\(\)/, 'the client returns to its pre-join state');
  assert.match(source, /joinRoom[\s\S]*?updateJoinControls\(\)/, 'joining updates the join bar');
});

test('a server push reaches its handler as the payload, never as the envelope', () => {
  // `members:update` and `sources:update` carry an array, so handing the handler
  // the envelope made `members.find` and `sources.map` throw in the browser.
  const sources = pushPayload({ type: SERVER.SOURCES_UPDATE, payload: [{ id: 'cam-1' }] });
  assert.ok(Array.isArray(sources), 'a wrapped push is dispatched as its payload');
  assert.deepEqual(sources, [{ id: 'cam-1' }]);

  const members = pushPayload({ type: SERVER.MEMBERS_UPDATE, payload: [] });
  assert.ok(Array.isArray(members), 'an empty roster is still an array');

  const moved = pushPayload({
    type: SERVER.BREAKOUT_UPDATE,
    payload: { breakoutId: 'breakout-1', members: [], breakouts: null, state: null },
  });
  assert.equal(moved.breakoutId, 'breakout-1', 'the move push is dispatched as its body');

  // A cleared scene is a real `null` payload, not a missing one.
  assert.equal(pushPayload({ type: SERVER.SCENE_UPDATE, payload: null }), null, 'a cleared scene stays null');

  // The flat messages carry no `payload`, so they are dispatched whole.
  assert.equal(pushPayload({ type: SERVER.WELCOME, clientId: 'me' }).clientId, 'me', 'welcome is whole');
  assert.equal(pushPayload({ type: SERVER.MEMBER_MEDIA, byName: 'Ada', muted: true }).muted, true, 'member:media is whole');
  assert.equal(
    pushPayload({ type: SERVER.WEBRTC_SIGNAL, from: 'peer', data: { candidate: {} } }).from,
    'peer',
    'webrtc:signal is whole',
  );

  // The transport is the one place that decides this, for every push.
  const socket = fs.readFileSync(path.join(CLIENT_DIR, 'ws.ts'), 'utf8');
  assert.match(socket, /this\._emit\(message\.type, pushPayload\(message\)\)/, 'the socket dispatches the payload');
});

test('a host with no room password sets one on its own page', () => {
  const page = /<section id="password-page"[\s\S]*?<\/section>/.exec(HTML);
  assert.ok(page, 'the page exists');
  for (const id of ['password-suggested', 'password-host', 'password-cohost', 'password-form', 'btn-skip-password']) {
    assert.ok(page[0].includes(`id="${id}"`), `${id} is on the password page`);
  }
  assert.ok(!HTML.includes('id="password-dialog"'), 'the old in-room dialog is gone');
  assert.ok(HTML.includes('id="btn-generate-passwords"'), 'passwords can also be generated from the People tab');

  const source = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(source, /function showPasswordPage\(\)/, 'the page is shown on the way in');
  assert.match(source, /function roomNeedsHostPassword\(\)[\s\S]*?requiresHostPassword === false/,
    'it keys off the room needing a password, not a generated one');
  assert.match(source, /function suggestPassword\(/, 'a suggestion is generated');
  assert.match(source, /function saveRoomPasswords\(/, 'passwords are saved through one path');
  assert.match(source, /CLIENT\.ROOM_UPDATE, \{ hostPassword, cohostPassword \}/, 'the save uses the protocol');
  assert.match(source, /if \(!isHost\(\)\)[\s\S]{0,80}Only the host can set the room passwords/, 'only the host may set them');
  assert.match(source, /showPasswordPage\(\);/, 'joining a fresh room as host opens the page');
  assert.match(source, /passwordPromptedLater\(\)/, 'saying later is remembered per room');
  // The People tab says so too, and the host can generate and save there.
  assert.match(source, /This room has no password yet/, 'the People tab explains the risk');
  assert.match(source, /btn-generate-passwords'\)\.addEventListener/, 'the generator is wired');
});

test('the password page sits between the join form and the room', () => {
  const source = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  // Three screens, one at a time: landing, password page, studio.
  assert.match(source, /if \(landing\) landing\.classList\.toggle\('hidden', inRoom\)/, 'the landing gives way to a room');
  assert.match(
    source,
    /\$\('#password-page'\)[\s\S]{0,90}?classList\.toggle\('hidden', !needsPassword\)/,
    'the password page is its own screen',
  );
  assert.match(
    source,
    /\$\('#studio'\)[\s\S]{0,90}?classList\.toggle\('hidden', !inRoom \|\| needsPassword\)/,
    'and the studio waits for it',
  );
  assert.match(source, /function skipPasswordPage\(\)/, 'Later enters the room without one');
  assert.match(source, /passwordPageHandled = Boolean\(silent\)/, 'a reconnect never interrupts with the page');
  assert.match(source, /if \(state\.credentials\.hostPassword\) \{\s*\n\s*\/\/ The password page is done with/, 'saving enters the room');
  assert.ok(!/closePasswordDialog|openPasswordDialog|maybeOfferRoomPassword/.test(source), 'no dialog is left behind');
});

test('the program preview reaches the whole room as picture and sound', () => {
  assert.ok(HTML.includes('id="program-feed"'), 'the page can show the received program feed');
  assert.ok(HTML.includes('id="program-feed-pill"'), 'and says when it is the live program');

  const mesh = fs.readFileSync(path.join(CLIENT_DIR, 'webrtc.ts'), 'utf8');
  assert.match(mesh, /setProgramStream\(stream, peerIds = null\)/, 'the mesh can carry the program');
  assert.match(mesh, /programPeers/, 'the program gets its own peer connections');
  assert.match(mesh, /const PROGRAM_KIND = 'program'/, 'and its own signal marker');
  assert.match(mesh, /data\.kind === PROGRAM_KIND/, 'program signals are routed apart from the meeting');
  assert.match(mesh, /_emit\('program-stream'/, 'incoming program tracks are announced');
  assert.match(mesh, /_publishProgramTracks\(peer\)/, 'the program tracks are added to each peer');

  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(app, /function programOwnerId\(\)/, 'the host owns the program picture');
  assert.match(app, /function syncProgramFeed\(\)/, 'the feed follows the owner');
  assert.match(app, /function renderProgramFeed\(\)/, 'the received feed is rendered');
  assert.match(app, /function applyProgramAudioPolicy\(\)/, 'the room audio never doubles up');
  assert.match(app, /function programAudioTakesOver\(\)/, 'the breakout keeps its own audio');
  assert.match(app, /state\.meeting\.setProgramStream\(stream, state\.members\.map/, 'the feed reaches the whole studio');
  assert.match(app, /state\.meeting\.addEventListener\('program-stream'/, 'the feed is received');
  assert.match(app, /SERVER\.MEMBERS_UPDATE[\s\S]*?syncProgramFeed\(\)/, 'a new host takes the program over');
  assert.match(app, /await ensureMesh\(\)\.catch[\s\S]{0,40}?syncProgramFeed\(\)/, 'joining a room starts both');
});

test('a camera published by anyone is seen by everyone in the room', () => {
  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(app, /async function ensureMesh\(\)/, 'the mesh starts without pressing Join call');
  assert.match(app, /async function publishToRoom\(stream\)/, 'a captured stream goes to the room');
  assert.match(app, /state\.camera\.addEventListener\('change'[\s\S]*?publishToRoom\(captured\)/, 'capturing media publishes it');
  assert.match(app, /function meetingPeerIds\(\)[\s\S]*?roomKeyOf/, 'the peer list is the room I am in');
  assert.ok(
    !/if \(state\.inCall\) state\.meeting\.sync/.test(app),
    'the mesh is the room, not the call button',
  );
  assert.match(
    app,
    /const stream = member\.cameraEnabled[\s\S]{0,140}?state\.peerStreams\.get\(member\.id\)/,
    'a camera that is switched off shows the avatar again',
  );
  assert.match(app, /video\.muted = programAudioTakesOver\(\)/, 'meeting tiles stay quiet under the program mix');
});

test('an announcement countdown is offered in the form and ticks', () => {
  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(app, /name: 'countdown', label: 'Countdown \(seconds, 0 = none\)'/, 'the announcement form has it');
  assert.match(app, /scene\.payload\.countdownMs = Number\(data\.get\('countdown'\)/, 'it is sent in milliseconds');
  assert.match(
    app,
    /import \{ formatCountdown, remainingCountdownMs \} from '\/shared\/overlays\.js'/,
    'the client reuses the shared countdown maths',
  );
  assert.match(app, /sceneTicker = setTimeout\(renderSceneCurrent, 1000\)/, 'the status line repaints each second');

  const compositor = fs.readFileSync(path.join(CLIENT_DIR, 'compositor.ts'), 'utf8');
  assert.match(
    compositor,
    /overlayDrawModel\(this\.scene, \{ width: W, height: H, now: Date\.now\(\) \}\)/,
    'the canvas ticks the countdown too',
  );
});

test('the program picture owns the width, the room sits under it, the rest is tabs', () => {
  const layout = /<main class="layout"[^>]*>([\s\S]*?)<\/main>/.exec(HTML);
  assert.ok(layout, 'the layout exists');
  // The program and the people are the first two blocks of the page.
  const order = ['program-panel', 'participants-panel', 'grid-panel', 'sources-panel', 'sidebar']
    .map((name) => ({ name, at: layout[1].indexOf(name) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.name);
  assert.deepEqual(
    order.slice(0, 2),
    ['program-panel', 'participants-panel'],
    'the program comes first, the room right under it',
  );
  assert.ok(order.includes('sidebar'), 'the studio controls live in the tabbed sidebar');
  assert.ok(
    /\.layout > \.program-panel,\s*\n\.layout > \.participants-panel \{ grid-column: 1 \/ -1; \}/.test(CSS),
    'both span the whole width',
  );
  // Every pane collapses from an arrow in its own head, and comes back the same
  // way - the top bar keeps only who/where/state/leave.
  for (const pane of ['program', 'participants', 'grid', 'sources', 'sidebar']) {
    assert.ok(
      new RegExp(`class="pane-toggle" data-pane="${pane}"`).test(HTML),
      `${pane} has a collapse arrow`,
    );
  }
  assert.ok(!HTML.includes('id="pane-toggles"'), 'the top bar no longer carries pane toggles');
  assert.match(CSS, /\.panel\.pane-collapsed > \*:not\(\.panel-head\) \{ display: none !important; \}/, 'a collapsed pane keeps its head');
  assert.match(CSS, /\.participant-strip\.slide/, 'people can slide');
  assert.match(CSS, /\.participant-strip\.grid/, 'people can be a grid');
  assert.match(CSS, /\.participant-strip\.list/, 'a big room can be a list');
  assert.match(HTML, /id="tabs"[\s\S]*?data-tab="scenes"[\s\S]*?data-tab="recordings"/, 'the sidebar is tabs');
});

test('the microphone of anyone in the room is published when it is switched on', () => {
  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(app, /async function ensureMicrophone\(\)/, 'a microphone is added on demand');
  assert.match(app, /if \(!mute\) await ensureMicrophone\(\)/, 'unmuting makes sure there is one');
  assert.match(
    app,
    /function setLocalAudio\(enabled\)[\s\S]*?if \(enabled\)[\s\S]{0,120}?publishToRoom\(stream\)/,
    'switching it on publishes it to the room',
  );
  assert.match(app, /const microphone = await ensureMicrophone\(\)/, 'the call can be joined with a mic alone');
  assert.match(
    app,
    /find\(\(entry\) => entry\.stream\?\.getAudioTracks\?\.\(\)\.length\)/,
    'an audio-only stream is publishable',
  );
});

test('every published feed keeps its identity, so screens can go on the program', () => {
  const devices = fs.readFileSync(path.join(CLIENT_DIR, 'devices.ts'), 'utf8');
  assert.match(devices, /streamId: stream\?\.id \|\| null/, 'the sharer announces the stream it published');
  assert.match(devices, /attachRemoteSource\(\{ id, label = null, stream, peerId = null, kind = 'virtual' \}\)/, 'a peer feed can be attached under its own id');

  const mesh = fs.readFileSync(path.join(CLIENT_DIR, 'webrtc.ts'), 'utf8');
  assert.match(mesh, /peer\.streams\.set\(stream\.id, stream\)/, 'the mesh keeps every feed a peer publishes');
  assert.match(mesh, /this\._emit\('stream', \{ peerId, streamId: stream\.id, stream, track \}\)/, 'and names it');
  assert.match(mesh, /_dropPeerStreams\(peerId, peer\)/, 'and drops them one at a time');

  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(app, /local\.get\(`stream:\$\{source\.meta\?\.streamId\}`\)/, 'a source is matched to the feed it published');
  assert.match(app, /entry\.meta\?\.streamId === detail\.streamId/, 'a received feed is matched to its source');
  assert.match(app, /attachRemoteSource\(\{[\s\S]{0,400}?kind: announced\.kind/, 'a viewer screen is attached for the program');
});

test('the landing page gets you in; the top bar keeps only who, where, state and leave', () => {
  const landing = /<section id="landing"[\s\S]*?<\/section>/.exec(HTML);
  assert.ok(landing, 'there is a landing page');
  for (const id of ['join-form', 'join-name', 'join-room', 'join-role', 'join-password', 'btn-join']) {
    assert.ok(landing[0].includes(`id="${id}"`), `${id} is on the landing page`);
  }
  // A brand new room has no host yet: the password page that follows the join
  // form is where the seat gets protected.
  const passwordPage = /<section id="password-page"[\s\S]*?<\/section>/.exec(HTML);
  assert.ok(passwordPage, 'there is a password page');
  assert.ok(passwordPage[0].includes('id="password-host"'), 'it sets the host password');
  assert.ok(passwordPage[0].includes('id="btn-skip-password"'), 'and can be skipped');
  assert.ok(!/id="password-page"[^>]*data-pane/.test(HTML), 'the page is not a studio pane');

  const header = /<header class="topbar">[\s\S]*?<\/header>/.exec(HTML);
  assert.ok(header, 'there is a top bar');
  for (const id of ['name-pill', 'room-pill', 'connection-pill', 'role-pill', 'btn-leave-room']) {
    assert.ok(header[0].includes(`id="${id}"`), `${id} is in the top bar`);
  }
  assert.ok(!header[0].includes('id="join-form"'), 'the join fields left the top bar');
  assert.ok(!header[0].includes('id="pane-toggles"'), 'the pane toggles left the top bar');
  assert.match(header[0], /id="btn-leave-room"[\s\S]*?<svg/, 'leave carries an exit icon');
  assert.match(CSS, /\.leave-button \{[^}]*background: #dc2626; border-color: #ef4444; color: #fff;/, 'and it is red with white text');

  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(app, /function renderIdentity\(\)/, 'the top bar says who and where');
  assert.match(app, /function showPasswordPage\(\)/, 'the password lives on its own page');
  assert.match(app, /function skipPasswordPage\(\)/, 'which can be skipped');
  assert.match(app, /passwordPageHandled/, 'and is a one-shot on the way in');
  assert.match(app, /landing\.classList\.toggle\('hidden', inRoom\)/, 'the landing gives way to the studio');
});

test('the platform and the room get the real on-air video, not a canvas re-render', () => {
  const compositor = fs.readFileSync(path.join(CLIENT_DIR, 'compositor.ts'), 'utf8');
  assert.match(compositor, /programVideoTrack\(\)/, 'the program picks a video track');
  assert.match(compositor, /if \(this\.scene\) return this\.videoTrack;/, 'an overlay needs the canvas');
  assert.match(
    compositor,
    /if \(sources\.length !== 1\) return this\.videoTrack;/,
    'a grid needs the canvas',
  );
  assert.match(
    compositor,
    /return source\.stream\?\.getVideoTracks\?\.\(\)\[0\] \|\| this\.videoTrack;/,
    'a single camera or screen goes out as its own track',
  );
  assert.match(compositor, /const video = this\.programVideoTrack\(\);/, 'the program stream uses it');

  const publisher = fs.readFileSync(path.join(CLIENT_DIR, 'publisher.ts'), 'utf8');
  assert.match(publisher, /syncVideoTrack\(\)/, 'a live broadcast follows the on-air video');
  assert.match(publisher, /const source = stream \|\| this\.compositor\.programStream\(\);/, 'the encoder takes a stream');

  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(app, /function refreshProgramVideo\(\)/, 'the studio re-points the encoder');
  assert.match(app, /state\.publisher\?\.syncVideoTrack\?\.\(\)/, 'through the publisher');
});

test('a big room is a list with controls; a small one slides or grids', () => {
  assert.ok(HTML.includes('id="people-view"'), 'the room has a view switch');
  for (const view of ['slide', 'grid', 'list']) {
    assert.ok(HTML.includes(`data-view="${view}"`), `${view} is offered`);
  }
  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(app, /const PEOPLE_LIST_LIMIT = 50;/, 'fifty people is the turning point');
  assert.match(
    app,
    /function peopleViewFor\(count\)[\s\S]*?return count > PEOPLE_LIST_LIMIT \? 'list' : 'slide';/,
    'a big room defaults to the list, a small one to slides',
  );
  assert.match(app, /function setPeopleView\(view\)/, 'the choice can be made');
  assert.match(app, /strip\.className = `participant-strip \$\{view\}`;/, 'and is applied to the room');
});

test('a coloured dot says who is host, who is co-host and who is watching', () => {
  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(app, /function roleDot\(role\)/, 'there is a role dot');
  assert.match(app, /class: `role-dot role-\$\{role \|\| 'viewer'\}`/, 'it is coloured by role');
  // The room tiles, the People tab and the meeting tiles all carry it.
  const uses = app.match(/roleDot\(/g) || [];
  assert.ok(uses.length >= 4, `the dot is used everywhere people are listed (${uses.length})`);
  assert.match(app, /name\.append\(\s*roleDot\(member\.role\)/, 'the tiles in the room use it');

  assert.match(CSS, /\.role-dot\.role-host \{ background: var\(--accent\); \}/, 'the host dot is cyan');
  assert.match(CSS, /\.role-dot\.role-cohost \{ background: var\(--accent-2\); \}/, 'the co-host dot is purple');
  assert.match(
    CSS,
    /\.role-dot\.role-viewer,\s*\n\.role-dot\.role-visitor \{ background: var\(--ok\); \}/,
    'viewers and visitors are green',
  );
});

test('roles are dots, and the controls are proper icons', () => {
  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  // The word only survives in the top bar's role pill.
  assert.match(app, /name\.append\(roleDot\(member\.role\), `\$\{member\.name\}/, 'room tiles show the dot alone');
  assert.ok(
    !/el\('span', \{ class: `role-badge role-\$\{member\.role\}`/.test(app),
    'no role words in the tiles or the people list',
  );
  assert.ok(HTML.includes('id="role-pill"'), 'the top bar still names the role');
  // Icons: microphone, camera and the pane arrows are vectors, not emoji.
  for (const name of ['mic', 'micOff', 'camera', 'cameraOff', 'chevronDown', 'chevronRight', 'chevronLeft']) {
    assert.ok(new RegExp(`\\b${name}:`).test(app), `${name} icon exists`);
  }
  assert.match(app, /function icon\(name, \{ size = 14 \}/, 'icons are rendered inline');
  assert.match(app, /iconLabel\(mic, member\.muted \? 'micOff' : 'mic'/, 'the tile microphone button uses one');
  assert.match(app, /iconLabel\(camera, member\.cameraEnabled \? 'camera' : 'cameraOff'/, 'and so does the camera button');
  assert.match(app, /const name = kind === 'mic' \? \(on \? 'mic' : 'micOff'\)/, 'the People controls too');
  assert.match(app, /button\.innerHTML = icon\(shown \? \(horizontal \? 'chevronLeft' : 'chevronDown'\) : 'chevronRight'\)/, 'the pane arrows are chevrons');
  assert.ok(!/\\u\{1F3A4\}|\\u\{1F4F7\}|\\u\{1F507\}|\\u\{1F4F9\}/.test(app), 'no emoji are left');
  assert.match(CSS, /\.icon \{ vertical-align: -2px; \}/, 'icons line up with the text');
  assert.ok(!/>V<\/button>/.test(HTML) && !/&lt;<\/button>/.test(HTML), 'no letter arrows in the markup');
});

test('the client takes STUN and TURN from the server', () => {
  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(app, /state\.meeting\.setIceServers\(message\.iceServers\)/, 'the welcome configures the mesh');
  const mesh = fs.readFileSync(path.join(CLIENT_DIR, 'webrtc.ts'), 'utf8');
  assert.match(mesh, /setIceServers\(servers = \[\]\)/, 'the mesh accepts a server list');
  assert.match(mesh, /this\.iceServers = servers;/, 'and uses it for new connections');
  const config = fs.readFileSync(path.join(rootDir, 'server', 'config.ts'), 'utf8');
  assert.match(config, /export function iceServersFrom\(config/, 'the server builds the list');
  assert.match(config, /QUANDRITE_TURN_URLS/, 'a TURN relay is configured by environment');
  assert.match(config, /QUANDRITE_TLS_CERT/, 'and HTTPS is available for camera access off localhost');
  const index = fs.readFileSync(path.join(rootDir, 'server', 'index.ts'), 'utf8');
  assert.match(index, /https\.createServer\(/, 'the server can serve over TLS');
});

test('the Share button in the room opens the camera picker for everyone', () => {
  const header = /<header class="topbar">[\s\S]*?<\/header>/.exec(HTML);
  assert.ok(header, 'there is a top bar');
  assert.ok(header[0].includes('id="btn-share"'), 'the room has a Share button');
  assert.ok(HTML.includes('data-panel="share"'), 'the Share tab holds the camera picker');
  assert.ok(!HTML.includes('id="device-dialog"'), 'there is no dialog over the room');
  for (const id of ['btn-devices-studio', 'btn-devices-grid', 'btn-devices-air', 'btn-devices-screen']) {
    assert.ok(HTML.includes(`id="${id}"`), `${id} is in the picker`);
  }
  assert.match(CSS, /\.share-button \{/, 'and it is styled as an action');

  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(app, /\$\('#btn-share'\)\.addEventListener\('click', openSharePanel\)/, 'Share opens the picker');
  assert.match(app, /function renderDeviceDialogActions\(\)/, 'the picker adapts to the role');
  assert.match(app, /\{ studio: 'Publish to the room', grid: 'ask for grid', air: 'ask for air' \}/, 'viewers publish and ask');
  assert.match(
    app,
    /const share = \$\('#btn-share'\);[\s\S]{0,90}?toggle\('hidden', !inRoom \|\| needsPassword\)/,
    'Share appears in the room',
  );
  // Publishing is open to everyone now: placing asks the host instead.
  assert.ok(
    !/\$\('#btn-devices-screen'\)\.addEventListener\('click', async \(\) => \{\s*\n\s*if \(!requireControl\(\)\) return;/.test(app),
    'anyone may share their screen',
  );
  assert.match(app, /if \(!hasControl\(\)\) \{\s*\n\s*for \(const id of ids\) await send\(CLIENT\.SOURCE_UPDATE, \{ sourceId: id, patch: \{ request: mode \} \}\)/, 'placing becomes a request');
});

test('a picture relayed over the socket reaches the room', () => {
  // The frame format is shared by both sides, and it can never be mistaken for a
  // program chunk (WebM starts with the EBML magic, not with QMR1).
  const header = { sourceId: 'camera:1', kind: 'camera', label: 'Cam', w: 480, h: 270 };
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const frame = encodeRelayFrame(header, payload);
  assert.ok(isRelayFrame(frame), 'it is recognisable');
  assert.equal(isRelayFrame(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])), false, 'a WebM chunk is not');
  const decoded = decodeRelayFrame(frame);
  assert.deepEqual(decoded.header, header, 'the header survives');
  assert.deepEqual([...decoded.payload], [...payload], 'and so does the picture');
  assert.equal(decodeRelayFrame(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])), null, 'nonsense decodes to nothing');

  const socket = fs.readFileSync(path.join(CLIENT_DIR, 'ws.ts'), 'utf8');
  assert.match(socket, /_handleBinary\(event\.data\)/, 'binary frames are looked at');
  assert.match(socket, /this\._emit\('media:frame', decoded\)/, 'a relayed picture becomes an event');
  assert.match(socket, /sendRelayFrame\(header, payload\)/, 'and can be posted');

  const relay = fs.readFileSync(path.join(CLIENT_DIR, 'relay.ts'), 'utf8');
  assert.match(relay, /export class MediaRelay extends EventTarget/, 'the relay is a module');
  assert.match(relay, /canvas\.toBlob\(resolve, 'image\/jpeg', this\.quality\)/, 'it encodes JPEG frames');

  const app = fs.readFileSync(path.join(CLIENT_DIR, 'app.ts'), 'utf8');
  assert.match(app, /function syncRelay\(\)/, 'the studio starts and stops it');
  assert.match(app, /function relayFallbackNeeded\(\)[\s\S]*?connectionState !== 'connected'/, 'only when peer-to-peer is not connected');
  assert.match(app, /socket\.on\('media:frame'/, 'and renders what arrives');
  assert.match(app, /attachRemoteImage\(\{/, 'relayed pictures can be composited too');
  const compositor = fs.readFileSync(path.join(CLIENT_DIR, 'compositor.ts'), 'utf8');
  assert.match(compositor, /const isImage = video\?\.tagName === 'IMG';/, 'the compositor draws a relayed picture');

  const server = fs.readFileSync(path.join(rootDir, 'server', 'signaling.ts'), 'utf8');
  assert.match(server, /if \(isRelayFrame\(buffer\)\)/, 'the server tells the two binary kinds apart');
  assert.match(server, /_onRelayFrame\(session, buffer\)/, 'and fans relayed pictures out to the room');
});

test('the server keeps the socket alive and reaps dead ones', () => {
  const source = fs.readFileSync(path.join(rootDir, 'server', 'index.ts'), 'utf8');
  assert.match(source, /signaling\.startHeartbeat\(\)/, 'the heartbeat is started with the server');
  // The served client is always the build, so say so when it is missing.
  assert.match(source, /no client build found in/, 'a missing client build is reported');
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.predev, 'npm run build', 'npm run dev builds the client first');
  assert.equal(pkg.scripts.prestart, 'npm run build', 'npm start builds the client first');
  const signaling = fs.readFileSync(path.join(rootDir, 'server', 'signaling.ts'), 'utf8');
  assert.match(signaling, /startHeartbeat\(intervalMs = 30000\)/, 'the heartbeat pings every 30s');
  assert.match(signaling, /socket\.terminate\(\)/, 'a socket that stopped answering is dropped');
});
