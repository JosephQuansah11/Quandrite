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
const LIB_DIR = path.join(rootDir, 'src', 'lib');

/**
 * Read a client module by name.
 *
 * The engine modules have moved to `src/lib` as part of the port, so a test that names
 * `webrtc` gets it from wherever it lives now rather than from a path that may be gone.
 */
function readClient(name: string): string {
  for (const dir of [CLIENT_DIR, LIB_DIR]) {
    const file = path.join(dir, `${name}.ts`);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  throw new Error(`no client module named ${name}`);
}

const HTML = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(rootDir, 'public', 'styles.css'), 'utf8');

/** Every TypeScript source under a directory, so the new React code is covered too. */
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SRC_DIR = path.join(rootDir, 'src');

function clientFiles() {
  return [...walk(CLIENT_DIR), ...walk(SRC_DIR)];
}

function moduleFiles() {
  return [...walk(path.join(rootDir, 'shared')), ...walk(path.join(rootDir, 'server')), ...clientFiles()];
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

/** The first of these paths that exists, so `@/ui/Button` finds `Button.tsx`. */
function firstExisting(...candidates: string[]) {
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return candidates[0];
}

/**
 * Where a specifier points on disk.
 *
 * Three spellings reach the same file: the server imports `.ts` sources directly, the
 * current client asks for the `.js` twin of its neighbours (which is how Node's
 * resolver wrote it), and the React app uses the `@shared` / `@` aliases Vite resolves.
 * The engine modules have already moved to `src/lib`, so a sibling that is not there
 * any more is looked for there - the same bridge the legacy build uses.
 */
function resolveSpecifier(file, specifier) {
  if (specifier.startsWith('@shared/')) {
    const base = path.join(rootDir, 'shared', specifier.slice('@shared/'.length));
    return firstExisting(`${base}.ts`, `${base}.tsx`);
  }
  if (specifier.startsWith('@/')) {
    const base = path.join(SRC_DIR, specifier.slice(2));
    return firstExisting(`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx'));
  }
  if (specifier.startsWith('/shared/')) {
    return firstExisting(path.join(rootDir, specifier.slice(1).replace(/\.js$/, '.ts')));
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    // Extensionless specifiers (the React app) and `.js` ones (the current client) both
    // land on a `.ts`/`.tsx` file, next to the importer or in the moved engine modules.
    const raw = path.join(path.dirname(file), specifier).replace(/\.(js|ts|tsx)$/, '');
    const name = path.basename(raw);
    return firstExisting(
      `${raw}.ts`,
      `${raw}.tsx`,
      path.join(SRC_DIR, 'lib', `${name}.ts`),
      path.join(SRC_DIR, 'lib', `${name}.tsx`),
    );
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
        // `import { type Tool }` and `import type { Tool }` name the same export.
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
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
  // Both pages while the port is running: the current client's and the React app's,
  // whose `#root` the new entry mounts into.
  const rootPage = path.join(rootDir, 'index.html');
  const newHtml = fs.existsSync(rootPage) ? fs.readFileSync(rootPage, 'utf8') : '';
  const ids = new Set(
    [...HTML.matchAll(/id="([^"]+)"/g), ...newHtml.matchAll(/id="([^"]+)"/g)].map((match) => match[1]),
  );
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
  // The built page is what a browser is served, and Vite gives its assets hashed
  // names - so the check is against the page that was actually built, not the sources.
  const built = path.join(rootDir, 'build', 'public', 'index.html');
  const html = fs.existsSync(built) ? fs.readFileSync(built, 'utf8') : HTML;
  const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(assets.length >= 2);
  for (const asset of assets) {
    assert.ok(
      fs.existsSync(path.join(rootDir, 'build', 'public', asset.replace(/^\//, ''))),
      `${asset} exists`,
    );
  }
});

test('the scene form in the UI covers every overlay type', () => {
  const source = readClient('app');
  const block = /const SCENE_FIELDS = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(block, 'SCENE_FIELDS is declared in app.ts');
  const keys = [...block[1].matchAll(/^\s{2}([a-z]+):\s*\[/gm)].map((match) => match[1]);
  assert.deepEqual(keys.sort(), [...REQUESTABLE_OVERLAY_TYPES].sort());
  assert.deepEqual([...REQUESTABLE_SCENE_TYPES].sort(), [...REQUESTABLE_OVERLAY_TYPES].sort());
});

test('host-only panes are marked and hidden from viewers and visitors', () => {
  const source = readClient('app');
  assert.match(source, /function applyRoleVisibility\(\)/, 'the role visibility helper exists');
  assert.match(source, /dataset\.requires/, 'the helper reads the data-requires markers');

  const marked = [...HTML.matchAll(/data-requires="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(marked.includes('control'), 'camera/screen controls are control-only');
  assert.ok(marked.includes('host'), 'the password pane is host-only');

  for (const id of [
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

  const source = readClient('app');
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
  // People, Chat and Share are not tabs: People and Chat are on the meeting bar (Chat
  // opening in front of the room), and Share is the picker that opens in front of it.
  assert.ok(!HTML.includes('data-tab="people"'), 'People is not a studio tab');
  assert.ok(!HTML.includes('data-tab="chat"'), 'nor is Chat');
  assert.ok(!HTML.includes('data-tab="share"'), 'nor is Share');
  assert.match(HTML, /id="btn-room-people"/, 'People is on the meeting bar');
  assert.match(HTML, /id="btn-room-chat"/, 'and so is Chat');
  assert.match(HTML, /option value="visitor"/, 'visitors can join without a password');

  const source = readClient('app');
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
  // The panel is for everyone - a breakout room is somewhere to go - and the controls
  // inside it are the host's.
  assert.match(HTML, /<div id="breakout-panel" class="credentials">/, 'the breakout panel is for everyone');
  assert.match(
    HTML,
    /data-requires="control"[\s\S]{0,300}?id="btn-create-breakouts"/,
    'with creating and opening the rooms gated to the host',
  );

  const source = readClient('app');
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
  const socket = readClient('ws');
  assert.match(socket, /join\(\{ roomId, name, role, password \}\)/, 'the password is forwarded on join');

  const app = readClient('app');
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

  // A viewer asks to be shown from the People list; a host moderates on the tile they
  // are looking at. My own microphone and camera are the meeting bar's, in the room.
  assert.match(app, /function myShowControls\(\)/, 'the people list carries the asking controls');
  assert.match(app, /Ask the host to put \$\{source\.label\} in the grid/, 'a viewer can ask for the grid');
  assert.match(app, /function tileTools\(tile, member\)/, 'and a host moderates on the tile itself');
});

test('the program preview is refreshed whenever sources or the program change', () => {
  const source = readClient('app');
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

test('cameras live in the Share picker and every pane collapses from its own head', () => {
  for (const id of [
    'device-list-picker',
    'share-status',
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

  // Devices are added from the Share picker, not from a pane of their own: the
  // picker's list is the one place to tick what to publish.
  assert.ok(HTML.includes('id="device-list-picker"'), 'the share picker holds the devices');
  assert.ok(!HTML.includes('id="sources-panel"'), 'the Cameras pane is gone');
  assert.ok(!HTML.includes('id="btn-open-devices"'), 'and so is its button');
  assert.ok(!HTML.includes('id="source-grid"'), 'with nothing left of it behind');

  // The panes that remain are addressable, and the old inline buttons are gone. The
  // people are no longer one of them: they are the room's own view.
  for (const pane of ['grid', 'sidebar']) {
    assert.ok(new RegExp(`data-pane="${pane}"`).test(HTML), `${pane} is a pane`);
  }
  assert.ok(!new RegExp('data-pane="participants"').test(HTML), 'the people are not a pane any more');
  assert.ok(!new RegExp('data-pane="sources"').test(HTML), 'the sources pane is no longer one');
  assert.ok(!HTML.includes('id="btn-add-camera"'), 'the inline camera buttons are gone');
  assert.ok(!HTML.includes('id="btn-add-all-cameras"'), 'the inline camera buttons are gone');
  assert.ok(
    /class="panel grid-panel" id="grid-panel" data-pane="grid" data-requires="control"/.test(HTML),
    'the grid arrangement is host-only, and its arrow lives in its own head',
  );

  const source = readClient('app');
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

  const source = readClient('app');
  assert.match(source, /function showConnectionBanner\(/, 'the banner can be shown');
  assert.match(source, /function retryConnection\(/, 'the connection can be retried by hand');
  assert.match(source, /socket\.on\('close'[\s\S]*?showConnectionBanner\(/, 'a dropped socket is announced');
  assert.match(source, /socket\.on\('socket-error'[\s\S]*?showConnectionBanner\(/, 'a failed socket is announced');
  assert.match(source, /socket\.on\('open'[\s\S]*?hideConnectionBanner\(\)/, 'a live socket clears the banner');
  assert.match(source, /state\.reconnecting = true;[\s\S]{0,200}rejoinRoom\(\)/, 'the room is re-joined automatically');
  assert.match(source, /function retryConnection\(\)[\s\S]*?state\.socket\.connect\(\)/, 'retry opens the socket again');
  // The join bar stays: Join, and the room's own Leave is on the meeting bar - one
  // Leave button, not three.
  assert.ok(HTML.includes('id="btn-join"'), 'the join button is addressable');
  assert.equal((HTML.match(/id="btn-leave/g) || []).length, 1, 'there is exactly one Leave button');
  assert.ok(HTML.includes('id="btn-room-leave"'), 'and it is the one on the meeting bar');
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
  const socket = readClient('ws');
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

  const source = readClient('app');
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
  const source = readClient('app');
  // Three screens, one at a time: landing, password page, studio.
  assert.match(source, /if \(landing\) landing\.classList\.toggle\('hidden', inRoom\)/, 'the landing gives way to a room');
  assert.match(
    source,
    /\$\('#password-page'\)[\s\S]{0,90}?classList\.toggle\('hidden', !needsPassword\)/,
    'the password page is its own screen',
  );
  assert.match(
    source,
    /setRoomOpen\(inRoom && !needsPassword\)/,
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

  const mesh = readClient('webrtc');
  assert.match(mesh, /setProgramStream\(stream, peerIds = null\)/, 'the mesh can carry the program');
  assert.match(mesh, /programPeers/, 'the program gets its own peer connections');
  assert.match(mesh, /const PROGRAM_KIND = 'program'/, 'and its own signal marker');
  assert.match(mesh, /data\.kind === PROGRAM_KIND/, 'program signals are routed apart from the meeting');
  assert.match(mesh, /_emit\('program-stream'/, 'incoming program tracks are announced');
  assert.match(mesh, /_publishProgramTracks\(peer\)/, 'the program tracks are added to each peer');

  const app = readClient('app');
  assert.match(app, /function programOwnerId\(\)/, 'the host owns the program picture');
  assert.match(app, /function syncProgramFeed\(\)/, 'the feed follows the owner');
  assert.match(app, /function renderProgramFeed\(\)/, 'the received feed is rendered');
  assert.match(app, /function applyProgramAudioPolicy\(\{ ducked = false \}: any = \{\}\)/, 'the room audio never doubles up');
  assert.match(app, /function programAudioTakesOver\(\)/, 'the breakout keeps its own audio');
  assert.match(app, /state\.meeting\.setProgramStream\(stream, state\.members\.map/, 'the feed reaches the whole studio');
  assert.match(app, /state\.meeting\.addEventListener\('program-stream'/, 'the feed is received');
  assert.match(app, /SERVER\.MEMBERS_UPDATE[\s\S]*?syncProgramFeed\(\)/, 'a new host takes the program over');
  assert.match(app, /await ensureMesh\(\)\.catch[\s\S]{0,40}?syncProgramFeed\(\)/, 'joining a room starts both');
});

test('a camera published by anyone is seen by everyone in the room', () => {
  const app = readClient('app');
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
  assert.match(
    app,
    /state\.speaking\?\.setDucked\(\(programAudioTakesOver\(\) && !state\.programMuted\) \|\| Boolean\(ducked\)\)/,
    'the room goes quiet under the program mix, through the mixer - and stays quiet under a howl',
  );
});

test('an announcement countdown is offered in the form and ticks', () => {
  const app = readClient('app');
  assert.match(app, /name: 'countdown', label: 'Countdown \(seconds, 0 = none\)'/, 'the announcement form has it');
  assert.match(app, /scene\.payload\.countdownMs = Number\(data\.get\('countdown'\)/, 'it is sent in milliseconds');
  assert.match(
    app,
    /import \{ formatCountdown, overlayDrawModel, remainingCountdownMs \} from '\/shared\/overlays\.js'/,
    'the client reuses the shared countdown maths',
  );
  assert.match(app, /sceneTicker = setTimeout\(renderSceneCurrent, 1000\)/, 'the status line repaints each second');

  const compositor = readClient('compositor');
  assert.match(
    compositor,
    /overlayDrawModel\(this\.scene, \{ width: W, height: H, now: Date\.now\(\) \}\)/,
    'the canvas ticks the countdown too',
  );
});

test('the room is the view: the grid fills it, the studio is a drawer', () => {
  const room = /<main class="room"[^>]*>([\s\S]*?)<\/main>/.exec(HTML);
  assert.ok(room, 'the room exists');
  const body = room[1];
  // People first: the grid is in the room, not behind a tab.
  assert.match(body, /<div id="remote-grid" class="room-grid"><\/div>/, 'the room grid is in the room');
  assert.match(body, /<footer class="room-toolbar" id="room-toolbar">/, 'with the controls along the bottom');
  for (const button of ['btn-room-mic', 'btn-room-cam', 'btn-room-share', 'btn-room-record', 'btn-room-more', 'btn-room-leave']) {
    assert.match(body, new RegExp(`id="${button}"`), `${button} is on the bar`);
  }
  assert.match(body, /<div class="self-view" id="self-view"[^>]*hidden>/, 'and my own picture has a corner');
  assert.match(body, /<div class="studio-panes layout hidden" id="studio-panes">/, 'the studio panes start out of the way');
  assert.doesNotMatch(HTML, /class="remote-grid"/, 'the old grid div is gone');
  assert.equal((HTML.match(/id="remote-grid"/g) || []).length, 1, 'and there is only one room grid');

  // The studio holds the *actions* - the studio's own tabs, and under them the grid
  // arrangement. The people and the program are not in here: they are the room.
  const panes = /<div class="studio-panes layout hidden" id="studio-panes">([\s\S]*?)<\/div>\s*<\/main>/.exec(HTML);
  assert.ok(panes, 'the studio drawer holds the panes');
  const order = ['sidebar', 'grid-panel']
    .map((name) => ({ name, at: panes[1].indexOf(name) }));
  for (const entry of order) assert.ok(entry.at >= 0, `${entry.name} is still there`);
  assert.ok(order[1].at > order[0].at, 'the studio comes up, and the grid preview is under it');
  assert.ok(!panes[1].includes('participants-panel'), 'the "in this room" panel is gone from the studio');
  assert.ok(!panes[1].includes('program-panel'), 'the program preview is out of the studio');
  assert.ok(!panes[1].includes('sources-panel'), 'and so are the cameras');

  const css = CSS;
  assert.match(css, /grid-template-columns: repeat\(var\(--room-columns, 3\), minmax\(0, 1fr\)\);/, 'the grid takes its column count from the app');
  assert.match(css, /grid-auto-rows: 1fr;/, 'and every row is the same height');
  assert.match(css, /\.room-tile \{[\s\S]{0,200}?aspect-ratio: 16 \/ 9;/, 'tiles keep their shape');
  assert.match(css, /\.room-tile \.badge-air \{/, 'whoever is on air says so on their tile');
  assert.match(css, /\.room-tile\.speaking \{ border-color: var\(--ok\);/, 'and whoever is talking is outlined');
  assert.match(css, /\.room-toolbar \{[\s\S]{0,220}?border-radius: 999px;/, 'the toolbar floats');
  assert.match(css, /\.self-view \{[\s\S]{0,260}?position: absolute; right: 10px; bottom: 68px;/, 'the self view sits above the meeting bar');

  const app = readClient('app');
  assert.match(app, /function renderRoomGrid\(\)/, 'one renderer paints the room');
  assert.match(app, /function wireRoomToolbar\(\)/, 'one place wires the bar');
  assert.match(app, /function updateRoomToolbar\(\)/, 'and one place keeps it honest');
  assert.match(app, /const members = roomMembers\(\)\.filter\(\(member\) => member\.id !== state\.clientId\);/, 'my own camera is not a participant tile');
  assert.match(app, /function roomGridColumns\(\{ count, width, height \}\)/, 'the grid is laid out as a grid');
  assert.match(app, /state\.speaking\?\.setMuted\(member\.id, Boolean\(member\.muted\)\);/, 'the room is heard through one mixer, and a muted member is really silent');
});

test('the studio comes up, the grid preview fills what is under it', () => {
  const layout = /<div class="studio-panes layout hidden" id="studio-panes">([\s\S]*?)<\/div>\s*<\/main>/.exec(HTML);
  assert.ok(layout, 'the layout exists');
  const order = ['sidebar', 'grid-panel']
    .map((name) => ({ name, at: layout[1].indexOf(name) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.name);
  assert.deepEqual(order, ['sidebar', 'grid-panel'], 'the studio first, the grid arrangement under it');
  assert.ok(
    /\.layout > \.sidebar \{ grid-row: 1; \}[\s\S]{0,120}?\.layout > \.stage \{ grid-row: 2;/.test(CSS),
    'one column, studio on top and the grid under it',
  );
  assert.ok(
    /\.stage > \.grid-panel \{[\s\S]{0,140}?grid-template-rows: auto auto minmax\(0, 1fr\);/.test(CSS),
    'and the grid panel fills the height it is given',
  );
  // Every pane collapses from an arrow in its own head, and comes back the same
  // way - the top bar keeps only who/where/state/leave. The people are not a pane any
  // more: they are the room, and the grid preview is what is left in the studio.
  for (const pane of ['grid', 'sidebar']) {
    assert.ok(
      new RegExp(`class="pane-toggle" data-pane="${pane}"`).test(HTML),
      `${pane} has a collapse arrow`,
    );
  }
  assert.ok(!HTML.includes('id="pane-toggles"'), 'the top bar no longer carries pane toggles');
  assert.match(CSS, /\.panel\.pane-collapsed > \*:not\(\.panel-head\) \{ display: none !important; \}/, 'a collapsed pane keeps its head');
  assert.match(CSS, /\.room-grid\.slide/, 'people can slide');
  assert.match(CSS, /\.room-grid\.grid/, 'people can be a grid');
  assert.match(CSS, /\.room-grid\.list/, 'a big room can be a list');
  assert.match(HTML, /id="tabs"[\s\S]*?data-tab="scenes"[\s\S]*?data-tab="recordings"/, 'the sidebar is tabs');
});

test('the microphone of anyone in the room is published when it is switched on', () => {
  const app = readClient('app');
  assert.match(app, /async function ensureMicrophone\(\{ announce = Boolean\(state\.roomId\) \}: any = \{\}\)/, 'a microphone is added on demand');
  assert.match(app, /if \(!mute\) await ensureMicrophone\(\)/, 'unmuting makes sure there is one');
  assert.match(
    app,
    /function setLocalAudio\(enabled\)[\s\S]*?if \(enabled\)[\s\S]{0,400}?publishToRoom\(stream\)/,
    'switching it on publishes it to the room',
  );
  assert.match(app, /await ensureMicrophone\(\);/, 'the call can be joined with a mic alone');
  assert.match(
    app,
    /find\(\(entry\) => entry\.stream\?\.getAudioTracks\?\.\(\)\.length\)/,
    'an audio-only stream is publishable',
  );
});

test('every published feed keeps its identity, so screens can go on the program', () => {
  const devices = readClient('devices');
  assert.match(devices, /streamId: stream\?\.id \|\| null/, 'the sharer announces the stream it published');
  assert.match(devices, /attachRemoteSource\(\{ id, label = null, stream, peerId = null, kind = 'virtual' \}\)/, 'a peer feed can be attached under its own id');

  const mesh = readClient('webrtc');
  assert.match(mesh, /peer\.streams\.set\(stream\.id, stream\)/, 'the mesh keeps every feed a peer publishes');
  assert.match(mesh, /this\._emit\('stream', \{ peerId, streamId: stream\.id, stream, track \}\)/, 'and names it');
  assert.match(mesh, /_dropPeerStreams\(peerId, peer\)/, 'and drops them one at a time');

  const app = readClient('app');
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
  for (const id of ['name-pill', 'room-pill', 'connection-pill', 'role-pill']) {
    assert.ok(header[0].includes(`id="${id}"`), `${id} is in the top bar`);
  }
  assert.ok(!header[0].includes('id="join-form"'), 'the join fields left the top bar');
  assert.ok(!header[0].includes('id="pane-toggles"'), 'the pane toggles left the top bar');
  // Leaving is one button, and it is on the meeting bar where the meeting controls
  // are - not duplicated up here.
  assert.ok(!header[0].includes('id="btn-leave-room"'), 'the top bar carries no Leave button');
  assert.match(CSS, /\.room-tool\.danger \{/, 'the meeting bar\'s Leave is the red one');

  const app = readClient('app');
  assert.match(app, /function renderIdentity\(\)/, 'the top bar says who and where');
  assert.match(app, /function showPasswordPage\(\)/, 'the password lives on its own page');
  assert.match(app, /function skipPasswordPage\(\)/, 'which can be skipped');
  assert.match(app, /passwordPageHandled/, 'and is a one-shot on the way in');
  assert.match(app, /landing\.classList\.toggle\('hidden', inRoom\)/, 'the landing gives way to the studio');
});

test('the platform and the room get the real on-air video, not a canvas re-render', () => {
  const compositor = readClient('compositor');
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

  const publisher = readClient('publisher');
  assert.match(publisher, /syncVideoTrack\(\)/, 'a live broadcast follows the on-air video');
  assert.match(publisher, /const source = stream \|\| this\.compositor\.programStream\(\);/, 'the encoder takes a stream');

  const app = readClient('app');
  assert.match(app, /function refreshProgramVideo\(\)/, 'the studio re-points the encoder');
  assert.match(app, /state\.publisher\?\.syncVideoTrack\?\.\(\)/, 'through the publisher');
});

test('a big room is a list with controls; a small one slides or grids', () => {
  // The switch sits in the room bar, next to the room it belongs to, and appears with
  // the People view rather than living in a panel of its own.
  const bar = /<header class="room-bar">([\s\S]*?)<\/header>/.exec(HTML);
  assert.ok(bar, 'the room bar exists');
  assert.match(bar[1], /id="people-view"/, 'the room has a view switch');
  assert.ok(!/id="studio-panes"[\s\S]*?id="participant-strip"/.test(HTML), 'and it is not in the studio any more');
  for (const view of ['slide', 'grid', 'list']) {
    assert.ok(bar[1].includes(`data-view="${view}"`), `${view} is offered`);
  }
  const app = readClient('app');
  assert.match(app, /const PEOPLE_LIST_LIMIT = 50;/, 'fifty people is the turning point');
  assert.match(
    app,
    /function peopleViewFor\(count\)[\s\S]*?return count > PEOPLE_LIST_LIMIT \? 'list' : 'slide';/,
    'a big room defaults to the list, a small one to slides',
  );
  assert.match(app, /function setPeopleView\(view\)/, 'the choice can be made');
  assert.match(app, /grid\.className = `room-grid \$\{view\}`;/, 'and is applied to the room grid');
  assert.match(
    app,
    /\$\('#people-view'\)\?\.classList\.toggle\('hidden', wanted === 'program'\);/,
    'the switch shows itself with the People view',
  );
});

test('a coloured dot says who is host, who is co-host and who is watching', () => {
  const app = readClient('app');
  assert.match(app, /function roleDot\(role\)/, 'there is a role dot');
  assert.match(app, /class: `role-dot role-\$\{role \|\| 'viewer'\}`/, 'it is coloured by role');
  // The room tiles, the People list and the meeting tiles all carry it.
  const uses = app.match(/roleDot\(/g) || [];
  assert.ok(uses.length >= 3, `the dot is used everywhere people are listed (${uses.length})`);
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
  const app = readClient('app');
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
  assert.match(app, /function iconOnly\(button, name, label\) \{/, 'state-changing controls are icons');
  assert.ok((app.match(/iconOnly\(/g) || []).length >= 2, 'and the meeting controls use them');
  assert.match(app, /const name = kind === 'mic' \? \(on \? 'mic' : 'micOff'\)/, 'the People controls too');
  assert.match(app, /button\.innerHTML = icon\(shown \? \(horizontal \? 'chevronLeft' : 'chevronDown'\) : 'chevronRight'\)/, 'the pane arrows are chevrons');
  assert.ok(!/\\u\{1F3A4\}|\\u\{1F4F7\}|\\u\{1F507\}|\\u\{1F4F9\}/.test(app), 'no emoji are left');
  assert.match(CSS, /\.icon \{ vertical-align: -2px; \}/, 'icons line up with the text');
  assert.ok(!/>V<\/button>/.test(HTML) && !/&lt;<\/button>/.test(HTML), 'no letter arrows in the markup');
});

test('the client takes STUN and TURN from the server', () => {
  const app = readClient('app');
  assert.match(app, /state\.meeting\.setIceServers\(message\.iceServers\)/, 'the welcome configures the mesh');
  const mesh = readClient('webrtc');
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

  const app = readClient('app');
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
  assert.match(app, /if \(!hasControl\(\) && !inBreakoutRoom\(\)\) \{\s*\n\s*for \(const id of ids\) await send\(CLIENT\.SOURCE_UPDATE, \{ sourceId: id, patch: \{ request: mode \} \}\)/, 'placing becomes a request - unless it is a breakout, where the room\'s screen is its own');
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

  const socket = readClient('ws');
  assert.match(socket, /_handleBinary\(event\.data\)/, 'binary frames are looked at');
  assert.match(socket, /this\._emit\('media:frame', decoded\)/, 'a relayed picture becomes an event');
  assert.match(socket, /sendRelayFrame\(header, payload\)/, 'and can be posted');

  const relay = readClient('relay');
  assert.match(relay, /export class MediaRelay extends EventTarget/, 'the relay is a module');
  assert.match(relay, /canvas\.toBlob\(resolve, 'image\/jpeg', this\.quality\)/, 'it encodes JPEG frames');

  const app = readClient('app');
  assert.match(app, /function syncRelay\(\)/, 'the studio starts and stops it');
  assert.match(app, /function relayFallbackNeeded\(\)[\s\S]*?connectionState !== 'connected'/, 'only when peer-to-peer is not connected');
  assert.match(app, /socket\.on\('media:frame'/, 'and renders what arrives');
  assert.match(app, /attachRemoteImage\(\{/, 'relayed pictures can be composited too');
  const compositor = readClient('compositor');
  assert.match(compositor, /const isImage = video\?\.tagName === 'IMG';/, 'the compositor draws a relayed picture');

  const server = fs.readFileSync(path.join(rootDir, 'server', 'signaling.ts'), 'utf8');
  assert.match(server, /if \(isRelayFrame\(buffer\)\)/, 'the server tells the two binary kinds apart');
  assert.match(server, /_onRelayFrame\(session, buffer\)/, 'and fans relayed pictures out to the room');
});

test('the relay drops late pictures instead of queueing them', () => {
  const relay = readClient('relay');
  // Conflation: one frame at a time, and the newest wins.
  assert.match(relay, /if \(this\._busy\) \{\s*\n\s*this\.dropped \+= 1;\s*\n\s*return;/, 'a busy encoder drops the frame');
  assert.match(relay, /maxBufferedBytes = 64 \* 1024/, 'the socket is kept almost empty');
  assert.match(relay, /bufferedAmount \?\? 0\) > this\.maxBufferedBytes/, 'a filling socket drops frames too');
  assert.match(relay, /_adapt\(elapsedMs\)/, 'the rate follows what the network carries');
  assert.match(relay, /this\.fps = Math\.max\(1, this\.fps - 1\)/, 'it slows down when struggling');
  assert.match(relay, /this\.fps = Math\.min\(rung\.fps, this\.fps \+ 0\.25\)/, 'and walks back up when comfortable, as far as the rung allows');
  assert.match(relay, /const chosen = this\.ladder\.note\(\{ struggling, now: Date\.now\(\) \}\);/, 'the rung itself moves with the link');
  assert.match(relay, /const scale = Math\.min\(1, \(this\.ladder\.rung\.width \|\| this\.canvasWidth\) \/ video\.videoWidth\);/, 'each frame is scaled to the rung being sent');
  assert.match(relay, /this\._windowBytes \+= payload\.byteLength;/, 'what actually went out is measured');
  assert.match(relay, /noteNetworkHint\(connection\)/, 'and a network change starts the ladder again');

  const quality = readClient('quality');
  assert.match(quality, /\{ name: '1080p', width: 1920, height: 1080, fps: 3, quality: 0\.68, kbps: 3200 \}/, '1080p is the top rung');
  assert.match(quality, /if \(connection\.saveData\) return ladder\.length - 1;/, 'save-data is honoured');
  assert.match(quality, /if \(struggling\) \{\s*\n\s*\/\/ Down at once/, 'a struggling link steps down at once');
  assert.match(quality, /if \(this\.index > 0 && now - this\.comfortableSince >= this\.upAfterMs\)/, 'and climbs only after a comfortable window');

  const mesh = readClient('webrtc');
  assert.match(mesh, /export const SCREEN_MAX_BITRATE_BPS = 6_000_000;/, 'a screen share is allowed real bandwidth');
  assert.match(mesh, /export const CAMERA_MAX_BITRATE_BPS = 2_500_000;/, 'and a camera a sensible ceiling');
  assert.match(mesh, /encoding\.maxBitrate = maxBitrate;/, 'the sender is told what the feed is worth');
  assert.match(mesh, /const detail = kind === 'screen' \|\| hinted === 'detail';/, 'the track\'s own hint wins over the kind of connection');
  assert.match(mesh, /params\.degradationPreference = detail \? 'maintain-resolution' : 'balanced';/, 'a screen keeps its pixels and drops frames instead');
  assert.match(mesh, /if \(track && !hinted && 'contentHint' in track\) track\.contentHint = detail \? 'detail' : 'motion';/, 'and the encoder is told what the pixels are for, once');
  assert.match(mesh, /if \(pc\.connectionState === 'connected'\) this\._tuneConnection\(peer\);/, 'applied once the path is up, where it sticks');

  const devices = readClient('devices');
  assert.match(devices, /track\.contentHint = 'motion';/, 'a camera says motion');
  assert.match(devices, /track\.contentHint = 'detail';/, 'a shared screen says detail');
  assert.match(devices, /width: \{ ideal: 1920 \}, height: \{ ideal: 1080 \}/, 'and the camera is asked for 1080p');
  assert.match(relay, /tns: nsToWire\(capturedNs\)/, 'every picture carries a nanosecond capture stamp');
  assert.match(relay, /this\._capturedNs = this\.socket\.serverNowNs\?\.\(\) \?\? monotonicNs\(\);/, 'taken when the frame was drawn, not when it finished encoding');

  const app = readClient('app');
  assert.match(app, /const lag = relayLagNs\(header, nowNs\);/, 'measured on the shared nanosecond clock');
  assert.match(app, /if \(!header\?\.warm && isStaleNs\(lag\.capturedNs, nowNs, RELAY_STALE_NS\)\) \{\s*\n\s*relayStale \+= 1;\s*\n\s*return;/, 'so a picture that arrives too late is thrown away, in nanoseconds (unless it is a warm still)');
  // A relayed picture says how far behind it is - and which hop it was lost on - on the
  // tile it lands on, rather than in a line under it.
  assert.match(app, /function showRelayedPicture\(peerId, url, lag: any = null\)/, 'a relayed picture lands on a tile');
  assert.match(app, /const tile = document\.querySelector\(`#remote-grid \[data-peer="\$\{peerId\}"\]`\);/, 'the room grid is where it lands');
  assert.match(app, /tile\.title = lag\?\.inboundNs != null/, 'and the tile reports the lag');
  assert.match(app, /to server \$\{formatLagNs\(lag\.inboundNs\)\}/, 'including which hop it was lost on');
  assert.match(
    app,
    /path: tile\.querySelector\('video'\) \? 'video' : tile\.querySelector\('img\.tile-picture'\) \? 'relay' : 'none',/,
    'and the diagnostics report which path each tile is on',
  );
});

test('the voice relay keeps the delay flat, like the pictures', () => {
  const audio = readClient('relay-audio');
  // Capture: 21 ms slices at 48 kHz, and a silent sink so nobody hears themselves.
  assert.match(audio, /const AUDIO_FRAME_SAMPLES = 1024;/, 'voice travels in 21 ms slices');
  assert.match(audio, /context\.createScriptProcessor\(AUDIO_FRAME_SAMPLES, channels, channels\)/, 'taken from the microphone, or in stereo from a shared screen');
  assert.match(audio, /sink\.gain\.value = 0;/, 'and never played back into the room speakers');
  assert.match(audio, /kind: 'audio',/, 'tagged as voice, so the server gives it its own budget');
  assert.match(audio, /rate: RELAY_PCM_RATE,/, 'at the standard 48 kHz, whatever the device mixed at');
  assert.match(audio, /codec: bits === 24 \? 'pcm24' : 'pcm16',/, 'and sent as raw samples at the depth the socket can carry');
  assert.match(audio, /pcm\.buffer,/, '...which is what goes on the wire');
  // Never queue: drop instead, and skip the quiet parts (of the PCM fallback).
  assert.match(audio, /if \(backlog > this\.maxBufferedBytes\) \{\s*\n\s*this\.dropped \+= 1;/, 'a behind socket drops voice rather than queueing it');
  assert.match(audio, /if \(quiet && now < this\.silentUntil\) return;/, 'silence is not worth its bytes');
  assert.match(audio, /this\.silentUntil = quiet \? now \+ AUDIO_SILENCE_KEEPALIVE_MS : 0;/, 'but a keepalive proves we are still here');
  assert.match(audio, /if \(\(this\.muted && entry\.microphone\) \|\| track\?\.enabled === false\) return false;/, 'muting stops the microphone bytes, not a shared screen\'s sound');
  assert.match(audio, /const microphone = kind === 'audio' \|\| kind === 'camera';/, 'which is how a source is known to be a microphone');
  // Playback: a small jitter window, pushed forward, never grown.
  assert.match(audio, /export const AUDIO_JITTER_MIN_S = 0\.05;/, 'keep a little voice queued ahead of the clock');
  assert.match(audio, /export const AUDIO_JITTER_MAX_S = 0\.35;/, 'and jump forward instead of drifting behind');
  assert.match(audio, /if \(endsAt < now \+ AUDIO_JITTER_MIN_S \|\| endsAt > now \+ AUDIO_JITTER_MAX_S\)/, 'the clock is pushed forward, never extended');
  assert.match(audio, /if \(isStaleNs\(lag\.capturedNs, nowNs, RELAY_AUDIO_STALE_NS\)\) \{/, 'a slice that arrives too late is thrown away, in nanoseconds');
  assert.match(audio, /const lag = relayLagNs\(header, nowNs\);/, 'voice is measured on the same shared clock');
  assert.match(audio, /tns: nsToWire\(this\.socket\.serverNowNs\?\.\(\) \?\? monotonicNs\(\)\)/, 'and stamped in nanoseconds too');
  assert.match(audio, /bits === 24 \? readPcm24\(view, i \* RELAY_PCM_BYTES\) \/ RELAY_PCM_MAX : view\.getInt16\(i \* 2, true\) \/ 32768/, '24-bit samples are read safely from the frame buffer, and the older 16-bit slice still decodes');
  // A shared context, resumed on the same gesture as the program audio.
  assert.match(audio, /export function resumeRelayedAudio\(\)/, 'the same user gesture starts it');

  const app = readClient('app');
  assert.match(app, /if \(header\?\.kind === 'audio'\) playRelayedAudio\(header, payload\);/, 'voice frames are played');
  assert.match(app, /function syncAudioRelay\(\)/, 'and the microphone joins the relay');
  assert.match(app, /const LOCAL_MEDIA_KINDS = new Set\(\['camera', 'screen', 'audio'\]\);/, 'only what I captured is relayed');
  assert.match(app, /filter\(\(source\) => LOCAL_MEDIA_KINDS\.has\(source\.kind\)\)/, 'a remote source is never sent back as an echo');
  assert.match(app, /const key = track\.getSettings\?\.\(\)\.deviceId \|\| track\.id;/, 'and one microphone is one voice, whatever stream holds it');
  assert.match(app, /mine\.sort\(\(a, b\) => Number\(b\.kind === 'audio'\) - Number\(a\.kind === 'audio'\)\);/, 'the dedicated microphone wins');
  assert.match(app, /state\.audioRelay\?\.setMuted\(!enabled\);/, 'muting stops the relayed bytes too');
  assert.match(app, /resumeRelayedAudio\(\);/, 'the first gesture resumes relayed voice');
  assert.match(app, /quandriteRelay/, 'and the console can report on both paths');
  assert.match(app, /forgetRelayedAudio\(peerId\);/, 'a peer who leaves takes their voice clock with them');

  const server = fs.readFileSync(path.join(rootDir, 'server', 'signaling.ts'), 'utf8');
  assert.match(server, /const bucket = session\.relayAudioTokens \|\|/, 'the server gives voice a burst allowance');
  assert.match(server, /RELAY_AUDIO_MAX_FPS,/, 'at a rate voice can live with');
});

test('the program picture does not blink when a relayed frame arrives', () => {
  const app = readClient('app');
  // The decoded frame is what the compositor draws, so it has to reach it.
  assert.match(app, /frame: media\?\.frame \|\| null,/, 'decoded frames travel with the source');
  assert.match(app, /lastFrame: media\?\.lastFrame \|\| null,/, 'and so does the one before it');
  assert.match(app, /bitmap = await createImageBitmap\(blob\);/, 'a picture is decoded before it is swapped in');
  assert.match(app, /if \(relayFrameSeq\.get\(from\) !== seq\) \{\s*\n\s*bitmap\?\.close\?\.\(\);\s*\n\s*return;/, 'and a slow decode cannot paint over a newer frame');
  assert.match(app, /relayFrameSeq\.delete\(peerId\);/, 'a peer who leaves is forgotten');

  const devices = readClient('devices');
  assert.match(devices, /source\.lastFrame = source\.frame \|\| null;/, 'two frames are kept, so a refresh is never blank');
  assert.match(devices, /source\.lastFrame\.close\?\.\(\);/, 'and the older one is released');

  const compositor = readClient('compositor');
  assert.match(compositor, /const decoded = source\.frame \|\| source\.lastFrame \|\| null;/, 'the compositor draws a decoded frame');
  assert.match(compositor, /const ready = Boolean\(decoded\) \|\|/, 'so a live tile never falls back to the placeholder');
  assert.match(compositor, /if \(source\.meta\?\.relayed\) return this\.videoTrack;/, 'a relayed picture never becomes the outgoing track');
  assert.match(compositor, /const same = current && current\.length === tracks\.length && tracks\.every\(\(track\) => current\.includes\(track\)\);/, 'the program stream object stays stable while its tracks do');
  assert.match(compositor, /if \(!same\) this\._programStream = new MediaStream\(tracks\);/, 'a new stream only when the tracks really changed');

  const publisher = readClient('publisher');
  assert.match(publisher, /this\._rebuildTimer = setTimeout\(\(\) => \{/, 'a burst of changes is coalesced into one rebuild');
  assert.match(publisher, /if \(!settled \|\| settled === live\) return;/, 'and a change that settles back needs no rebuild');
  assert.match(publisher, /rebuilds: this\._rebuilds,/, 'the rebuild count is reported');
});

test('a camera tile is never rebuilt under the video that is playing', () => {
  const app = readClient('app');
  // A stream event fires for every track and every renegotiation; rebuilding the
  // element each time is what makes the room's cameras flicker.
  assert.match(app, /if \(!tile\) \{\s*\n\s*tile = el\('div', \{ class: 'room-tile', dataset: \{ peer: member\.id \} \}/, 'the tile is reused');
  assert.match(app, /if \(video\.srcObject !== stream\) video\.srcObject = stream;/, 'and the feed is only re-pointed when it really changed');
  assert.doesNotMatch(app, /clear\(tile\);\s*\n\s*const video = el\('video'/, 'the old rebuild is gone');
  assert.match(app, /state\.speaking\?\.track\(detail\.peerId, detail\.stream, \{ muted: Boolean\(member\?\.muted\) \}\);/, 'each participant is mixed for the room and metered for the wave');
  assert.match(app, /state\.speaking\?\.forget\(detail\.peerId\);/, 'and forgotten when they go');
  assert.match(app, /function applySpeaking\(\)/, 'one class toggle drives every wave');
  assert.match(app, /el\('div', \{ class: 'wave' \}, waveBars\(\)\)/, 'the wave sits under the tile');

  const css = CSS;
  assert.match(css, /\.speaking \.wave i \{ color: var\(--ok\); animation-play-state: running; \}/, 'and animates only for whoever is talking');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.wave i \{ animation: none; height: 8px; \}/, 'with respect for reduced motion');

  const audio = readClient('room-audio');
  // The room's voices are mixed in one place: one context to resume, one gain per
  // peer, and the meter that draws the waves comes from the same graph.
  assert.match(audio, /export class RoomAudio extends EventTarget/, 'the room has one mixer');
  assert.match(audio, /source\.connect\(analyser\);/, 'every voice is metered');
  assert.match(audio, /gain\.connect\(this\.master\);/, 'and played, unless it is my own microphone');
  assert.match(audio, /this\.master\.connect\(context\.destination\);/, 'everything audible goes through one master gain');
  assert.match(
    audio,
    /const wanted = monitor && !muted && !this\.ducked \? 1 : 0;[\s\S]{0,60}?gain\.gain\.value = wanted;/,
    'a muted or ducked voice is really silent',
  );
  assert.match(audio, /const wanted = entry\.monitor && !entry\.muted && !this\.ducked \? 1 : 0;/, 'and the gain follows the state');
  assert.match(audio, /if \(now - this\._lastResumeAt > 2000\) \{/, 'a suspended context is brought back by the watchdog');
  assert.match(audio, /rebuild\(\) \{/, 'and the whole mix can be re-attached');
  assert.match(audio, /if \(this\._lastState === 'suspended' && state === 'running'\) this\.rebuild\(\);/, 'which happens the moment audio comes back');
  assert.match(audio, /track: track \? \{ muted: track\.muted, readyState: track\.readyState, enabled: track\.enabled \} : null,/, 'and the incoming track\'s health is reported');
  assert.match(audio, /state: this\.state,/, 'the mixer reports what it is doing');

  const appSource = readClient('app');
  assert.match(appSource, /const node = el\('video', \{ autoplay: true, playsInline: true, muted: true \}\);/, 'tile videos carry the picture only, never the sound');
  assert.match(appSource, /state\.speaking\?\.track\(detail\.peerId, detail\.stream, \{ muted: Boolean\(member\?\.muted\) \}\);/, 'a peer with a microphone but no camera is still heard');
  assert.match(appSource, /state\.speaking\?\.track\(state\.clientId, stream, \{ monitor: false \}\);/, 'and I never hear myself');
  assert.match(appSource, /state\.speaking\?\.setDucked\(\(programAudioTakesOver\(\) && !state\.programMuted\) \|\| Boolean\(ducked\)\);/, 'the program mix ducks the room in the mixer, not on the elements');
  assert.match(appSource, /document\.addEventListener\('visibilitychange', \(\) => \{/, 'coming back to the tab resumes the audio');
  assert.match(appSource, /roomAudio: state\.speaking\?\.describe\?\.\(\) \?\? null,/, 'and the mixer reports itself for diagnosis');
});

test('the program frame is the shape of the picture, with sound and picture controls', () => {
  const css = CSS;
  assert.match(css, /aspect-ratio: var\(--program-aspect, 16 \/ 9\);/, 'the frame takes the picture\'s own shape');
  assert.doesNotMatch(css, /\.program-frame \{[\s\S]{0,400}?height: 90vh;/, 'not a box the height of a phone screen');
  assert.match(css, /body\.program-fill \.layout > \.panel:not\(\.program-panel\)/, 'a share can take the whole screen');
  assert.match(css, /body\.program-fill #program-canvas,/, 'and the picture is never wrapped in empty black');

  const html = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="btn-program-mute"/, 'the sound can be muted');
  assert.match(html, /id="btn-program-pause"/, 'the picture can be paused');
  assert.match(html, /id="btn-program-fill"/, 'and the program can fill the screen');
  assert.match(html, /id="program-blocked"/, 'a scene covering the program is announced');

  const app = readClient('app');
  assert.match(app, /frame\.style\.setProperty\('--program-aspect'/, 'the client sets the frame\'s shape from the on-air video');
  assert.match(app, /node\.muted = Boolean\(state\.programMuted\) \|\| Boolean\(state\.breakoutId\) \|\| Boolean\(ducked\);/, 'muting the program really mutes it');
  assert.match(app, /function watchSceneExpiry\(\)/, 'nothing on air outlives its own countdown');
  assert.match(app, /if \(!counted \|\| remainingCountdownMs\(state\.scene\) > 0\)/, 'a running countdown is left alone');
  assert.match(app, /toast\('Break over - back to the program', 'ok'\);/, 'and when it ends the room goes back to the program');
});

test('a newcomer is shown the room as it already is', () => {
  const server = fs.readFileSync(path.join(rootDir, 'server', 'signaling.ts'), 'utf8');
  assert.match(server, /this\._rememberRelayFrame\(roomId, decoded\.header, frame\);/, 'the server keeps the newest picture from each source');
  assert.match(server, /this\._sendWarmFrames\(session, session\.attendedRoomId \|\| studio\.id\);/, 'and hands it to whoever joins');
  assert.match(server, /const warm = encodeRelayFrame\(\{ \.\.\.decoded\.header, warm: true \}, decoded\.payload\);/, 'marked as a still, not a live frame');

  const app = readClient('app');
  assert.match(app, /if \(!header\?\.warm && isStaleNs\(lag\.capturedNs, nowNs, RELAY_STALE_NS\)\) \{/, 'so the live staleness rule does not throw it away');
});

test('stopping the video never stops the voice', () => {
  const app = readClient('app');
  // The microphone is usually captured inside the camera's stream, so removing the
  // camera removes the voice - which is exactly what "the sound broke" looks like.
  assert.match(app, /async function ensureStandaloneMicrophone\(\)/, 'a microphone of its own can be made');
  assert.match(app, /async function keepVoiceAlive\(\)/, 'and the voice is kept alive');
  assert.match(app, /if \(me\?\.muted\) return null;/, 'unless I have chosen to be quiet');
  assert.match(app, /await keepVoiceAlive\(\);\s*\n\s*await state\.camera\.removeSource\(source\.id\);/, 'the microphone is published before the camera goes');
  assert.match(app, /keepVoiceAlive\(\)\.catch\(\(\) => \{\}\);/, 'and a camera that ends by itself does not take the voice with it');
  assert.match(app, /await keepVoiceAlive\(\);/, 'the same when the host stops my video');
});

test('everything happens in the room: a split view, and popups over it', () => {
  const room = /<main class="room"[^>]*>([\s\S]*?)<\/main>/.exec(HTML);
  assert.ok(room, 'the room exists');
  const body = room[1];
  // The main container holds both halves of the view.
  assert.match(body, /<section class="room-stage" id="room-stage">/, 'the main view is one container');
  assert.match(body, /<div class="stage-view program-view">/, 'holding the program');
  assert.match(body, /<div class="stage-view people-view">/, 'and the people');
  assert.match(body, /<div class="segmented" id="stage-view" role="group"/, 'with a switcher');
  for (const view of ['program', 'people', 'split']) {
    assert.match(body, new RegExp(`data-view="${view}"`), `${view} can be chosen`);
  }
  // The program picture lives in the room, not behind the studio drawer.
  assert.match(body, /<canvas id="program-canvas"/, 'the program picture is in the room');
  assert.equal((HTML.match(/id="program-canvas"/g) || []).length, 1, 'and only once');
  // The share picker is a dialog in front of the room.
  assert.match(HTML, /<dialog id="share-dialog" class="share-dialog">/, 'share opens in front');
  assert.match(HTML, /<div id="share-dialog-body"><\/div>/, 'and holds the picker');
  // Feedback is said out loud.
  assert.match(body, /<div id="feedback-banner" class="feedback-banner hidden">/, 'feedback is announced');
  // People and chat belong on the meeting bar.
  for (const button of ['btn-room-people', 'btn-room-chat']) {
    assert.match(body, new RegExp(`id="${button}"`), `${button} is on the bar`);
  }

  const css = CSS;
  assert.match(css, /\.room-stage\.view-split \{[\s\S]{0,160}?grid-template-columns: minmax\(0, 1\.15fr\) minmax\(0, 1fr\);/, 'the split puts them side by side');
  assert.match(css, /\.room-stage\.view-program \.people-view \{ display: none; \}/, 'and the switcher hides one or the other');
  // The studio docks beside the room and the room keeps its own column: opening the
  // studio must never hide the meeting, which is what a floating pane over the whole
  // room did.
  assert.match(css, /\.room\.studio-open \{[\s\S]{0,120}?grid-template-columns: minmax\(0, 1fr\) minmax\(320px, 440px\);/, 'the studio docks beside the room');
  assert.match(css, /\.room\.studio-open > \.room-stage \{ grid-column: 1; \}/, 'and the stage keeps its own column');
  assert.match(css, /\.room\.studio-open > \.studio-panes \{ grid-column: 2; grid-row: 2; \}/, 'with the panes in the other');
  assert.match(css, /\.room \{ position: relative; \}/, 'the room is the container they share');
  assert.match(css, /\.share-dialog::backdrop, \.chat-dialog::backdrop, \.people-dialog::backdrop \{/, 'the popups have backdrops');

  const app = readClient('app');
  assert.match(app, /function setStageView\(view, \{ remember = true \} = \{\}\)/, 'the view can be switched');
  assert.match(app, /return hasControl\(\) \? 'split' : 'people';/, 'a host opens on the split');
  assert.match(app, /function openShareDialog\(\)/, 'share opens a dialog');
  assert.match(app, /if \(!body\.contains\(panel\)\) body\.append\(panel\);/, 'moving the one picker into it');
  assert.match(app, /if \(home\) home\.append\(panel\);/, 'and putting it back when it closes');
  assert.match(app, /if \(button\.dataset\.tab === 'share'\) \{\s*\n\s*openShareDialog\(\);/, 'the studio tab opens the same picker');
});

test('feedback is heard, ducked and then restored', () => {
  const audio = readClient('room-audio');
  // A howl is loud and narrow; a voice is loud but spread out. Both matter.
  assert.match(audio, /_peakShape\(entry\) \{/, 'the shape of the sound is measured');
  assert.match(audio, /if \(entry\.freq\[index\] >= strong\) loud \+= 1;/, 'by counting how few frequencies carry it');
  assert.match(audio, /const narrow = entry\.level >= this\.feedbackLevel && entry\.narrowShare <= this\.feedbackNarrowShare;/, 'loud and narrow is one way a howl shows itself');
  assert.match(audio, /const rising = entry\.level >= this\.feedbackRiseLevel && this\._rising\(entry\);/, 'a fast, sustained climb is the other');
  assert.match(audio, /return \{ narrow, rising, howling: narrow \|\| rising \};/, 'either one is a howl');
  assert.match(audio, /entry\.howlStreak = judged\.howling \? entry\.howlStreak \+ 1 : 0;/, 'sustained, so a single note in speech is not one');
  assert.match(audio, /this\._setMaster\(this\.feedbackGain, this\.feedbackAttackS\);/, 'the room is pulled down hard and fast when it starts');
  assert.match(audio, /feedbackGain = 0\.02,/, 'deep enough that a howl cannot sustain itself');
  assert.match(audio, /if \(this\._howling && now > this\._feedbackUntil\) \{\s*\n\s*this\._howling = false;\s*\n\s*this\._feedbackReason = null;\s*\n\s*this\._setMaster\(1, this\.feedbackReleaseS\);/, 'and let back up slowly when it stops');
  assert.match(audio, /this\.master\.gain\.setTargetAtTime\(value, this\.context\.currentTime, timeConstant\);/, 'ramped, because a click is its own kind of unpleasant');
  assert.match(audio, /dispatchEvent\(new CustomEvent\('feedback', \{ detail: \{ active: true, peerId: culprit, reason \} \}\)\);/, 'and whoever it was is named, with what gave it away');

  const app = readClient('app');
  assert.match(app, /state\.speaking\.addEventListener\('feedback'/, 'the room shows the warning');
  assert.match(app, /function holdMyMicForFeedback\(\) \{/, 'and my own microphone is held down');
  assert.match(app, /function releaseMyMicForFeedback\(\) \{/, 'until the howl is gone, rather than for a fixed time');
  assert.match(app, /feedbackMicReleaseTimer = setTimeout\(\(\) => \{/, 'with a short grace before it comes back');
  assert.match(app, /const FEEDBACK_MIC_MAX_MS = 10_000;/, 'and a backstop, so nobody is left muted by a stuck state');
  assert.match(app, /feedbackMicHeld = microphoneTracks\(\)\.filter\(\(track\) => track\.enabled\);/, 'which breaks the loop from the microphone end');
  assert.match(app, /for \(const track of feedbackMicHeld\) track\.enabled = false;/, 'switching off only the microphone');
  assert.match(app, /for \(const track of held\) track\.enabled = true;/, 'and switching back exactly those');
  assert.match(app, /toast\('Microphone back on', 'ok'\);/, 'and turns back on afterwards');
  assert.match(app, /mixer: state\.speaking,/, 'the mixer is reachable for testing and diagnosis');
});

test('audio is promoted on both stacks: WebRTC and the relay', () => {
  const webrtc = readClient('webrtc');
  const relay = readClient('relay-audio');
  const devices = readClient('devices');
  const app = readClient('app');
  const audio = fs.readFileSync(path.join(rootDir, 'shared', 'audio.ts'), 'utf8');

  // WebRTC: the Opus parameters live in the SDP, so the local description is rewritten
  // before it is set - on both the offer and the answer, and on the program connections
  // (which carry music, not speech).
  assert.match(webrtc, /await pc\.setLocalDescription\(this\._tuneOpus\(await pc\.createOffer\(\)\)\);/, 'the offer is tuned before it is set');
  assert.match(webrtc, /this\._tuneOpus\(await pc\.createAnswer\(\), \{ kind: data\.kind \}\)/, 'and so is the answer');
  assert.match(webrtc, /this\._tuneOpus\(await pc\.createOffer\(\), \{ kind: PROGRAM_KIND \}\)/, 'a program offer is tuned as music');
  assert.match(webrtc, /sdp: preferOpus\(description\.sdp, \{[\s\S]{0,220}?usedtx: false,/, 'with DTX off, so quiet passages are part of the sound');
  assert.match(webrtc, /stereo: music,/, 'and stereo only where it is music');

  // ...and the sender is given a ceiling, which is what the encoder obeys.
  assert.match(webrtc, /_tuneAudioSender\(sender, \{ kind = 'camera' \} = \{\}\) \{/, 'audio senders are tuned too');
  assert.match(webrtc, /const music = kind === 'screen' \|\| kind === 'program';/, 'a screen or the program is music');
  assert.match(webrtc, /encoding\.maxBitrate = maxBitrate;/, 'the ceiling is set');
  assert.match(webrtc, /encoding\.priority = 'high';/, 'and voice is high priority');
  assert.match(webrtc, /else if \(sender\.track\?\.kind === 'audio'\) \{\s*\n\s*if \(this\._tuneAudioSender/, 'every audio sender on a settled connection is tuned');
  assert.match(webrtc, /audioQuality\(\) \{/, 'and the result is reportable');
  assert.match(webrtc, /opus: opusParameters\(peer\.pc\?\.localDescription\?\.sdp\) \|\| opusParameters\(peer\.pc\?\.remoteDescription\?\.sdp\)/, 'from the descriptions both ways');

  // The relay: Opus at 48 kHz, with PCM kept as the fallback.
  assert.match(relay, /entry\.encoder = this\._makeEncoder\(entry\);/, 'an Opus encoder is made where WebCodecs is there');
  assert.match(relay, /codec: 'opus',\s*\n\s*sampleRate: entry\.rate,/, 'configured at the capture rate');
  assert.match(relay, /numberOfChannels: entry\.channels,/, 'and with the right channel count');
  assert.match(relay, /bitrate: entry\.microphone \? RELAY_OPUS_VOICE_BITRATE_BPS : RELAY_OPUS_MUSIC_BITRATE_BPS,/, 'voice and music get different bitrates');
  assert.match(relay, /new AudioData\(\{[\s\S]{0,240}?format: 'f32-planar',/, 'captured frames are handed over as AudioData');
  assert.match(relay, /codec: 'opus',\s*\n\s*label: entry\.label,/, 'and posted with the codec in the header');
  assert.match(relay, /if \(header\.codec === 'opus'\) return decodeRelayedOpus\(from, header, bytes, ctx\);/, 'the receiving end decodes Opus');
  assert.match(relay, /decoder\.configure\(\{ codec: 'opus', sampleRate: rate, numberOfChannels: channels \}\);/, 'with a per-sender decoder');
  assert.match(relay, /return scheduleRelayedBuffer\(from, buffer, ctx\);/, 'and the PCM fallback still schedules the same way');
  assert.match(relay, /context = new Ctor\(\{ sampleRate: RELAY_CAPTURE_RATE \}\);/, 'the relay context runs at 48 kHz');
  assert.match(relay, /codecs: \[\.\.\.sendCodecs\],/, 'and the codecs in use are reported');
  // The PCM fallback is the same standard as the rest of the voice path: 48 kHz, 24-bit.
  assert.match(audio, /export const RELAY_PCM_RATE = RELAY_CAPTURE_RATE;/, 'the fallback runs at the capture rate');
  assert.match(audio, /export const RELAY_PCM_BITS = 24;/, 'and at 24 bits, the depth a studio records at');
  assert.match(relay, /const pcm = this\._toPcm\(mono, bits\);/, 'the fallback encodes at the depth it can afford');
  assert.match(relay, /const value =\s*\n\s*Math\.round\(clamped < 0 \? clamped \* \(RELAY_PCM_MAX \+ 1\) : clamped \* RELAY_PCM_MAX\) & 0xffffff;/, 'little-endian, sign-extended, full scale at both ends');
  assert.match(relay, /function readPcm24\(view: DataView, at: number\)/, 'and the receiving end reads it back');

  // Devices: a microphone is processed, a shared screen is not.
  assert.match(devices, /audio: withAudio \? microphoneConstraints\(\) : false,/, 'a camera\'s microphone is opened as speech');
  assert.match(devices, /audio: microphoneConstraints\(deviceId\),/, 'and a standalone microphone the same way');
  assert.match(devices, /audio: audio \? screenAudioConstraints\(\) : false,/, 'a shared screen keeps its sound untouched');
  assert.match(audio, /echoCancellation: false,\s*\n\s*noiseSuppression: false,\s*\n\s*autoGainControl: false,/, 'which is the opposite of the microphone');

  // The studio can see what it is actually sending.
  assert.match(app, /audioQuality: state\.meeting\?\.audioQuality\?\.\(\) \?\? null,/, 'the studio reports the negotiated audio');
});

test('the stage shows the screen of the room I am standing in', () => {
  const app = readClient('app');
  const server = fs.readFileSync(path.join(rootDir, 'server', 'signaling.ts'), 'utf8');

  // The server keeps the two apart: the parent's screen travels to everyone (a host
  // inside a breakout still runs the show), and a breakout's own screen travels to that
  // breakout alone.
  assert.match(server, /studio\.on\('sources', \(sources\) => emit\(SERVER\.BREAKOUT_SOURCES, sources\)\);/, 'a breakout broadcasts its own sources to itself');
  assert.match(server, /studio\.on\('program', \(program\) => emit\(SERVER\.BREAKOUT_PROGRAM, program\)\);/, 'and its own program');
  assert.match(server, /studio\.on\('scene', \(scene\) => emit\(SERVER\.BREAKOUT_SCENE, scene\)\);/, 'and its own overlay');
  assert.match(server, /_roomFor\(session\) \{[\s\S]{0,320}?this\._attachRoom\(room\);/, 'media, chat and screen all go to the room the session is standing in');
  assert.match(server, /const result = this\._roomFor\(session\)\.addSource\(\{ \.\.\.\(message\.source \|\| \{\}\), ownerId: session\.id \}\);/, 'a source is published into that room');
  assert.match(server, /const result = room\.setProgram\(\{/, 'and so is the program');
  assert.match(server, /_mayDriveProgram\(session, room, message\) \{[\s\S]{0,420}?return ids\.every\(\(id\) => room\.sources\.get\(id\)\?\.ownerId === session\.id\);/, 'where anybody may put their own sources up, and only control moves other people\'s');
  assert.match(server, /if \(previous && previous !== studio\) previous\.leave\?\.\(session\.id\);/, 'and walking out takes their sources with them');
  assert.match(server, /if \(chatRoom !== studio\) chatRoom\.join\(\{ clientId: session\.id, name: session\.name, role: 'viewer' \}\);/, 'a breakout keeps a roster, so its members can publish into it');
  assert.match(server, /roomState: \{[\s\S]{0,200}?sources: chatRoom\.sourcesSnapshot\?\.\(\) \?\? \[\],/, 'the room you walk into hands over its screen at once');

  // The client keeps them apart too: `state.*` is the broadcast, `breakoutScreen` is the
  // room I am in, and the stage asks for whichever that is.
  assert.match(app, /breakoutScreen: \{ sources: \[\], program: \{ mode: 'single'/, 'the breakout screen is its own state');
  assert.match(app, /function screenSources\(\) \{\s*\n\s*return inBreakoutRoom\(\) \? state\.breakoutScreen\.sources : state\.sources;/, 'and the stage follows the room I am in');
  assert.match(app, /screenSources\(\)\.map\(\(source\) => \{/, 'the compositor draws the screen of the room I am in');
  assert.match(app, /socket\.on\(SERVER\.BREAKOUT_SOURCES, \(sources\) => \{/, 'the breakout\'s own sources are received');
  assert.match(app, /socket\.on\(SERVER\.BREAKOUT_PROGRAM, \(program\) => \{/, 'and its own program');
  assert.match(app, /applyRoomScreen\(message\.roomState\);/, 'walking in takes on that room\'s screen');
  assert.match(app, /const program = screenProgram\(\);/, 'the program bar reflects the screen on show');
  assert.match(app, /if \(!stream \|\| inBreakoutRoom\(\)\) \{/, 'and the parent\'s feed is not drawn over a breakout\'s own screen');
  assert.match(app, /if \(!inBreakoutRoom\(\) && !requireControl\('Only the host or a co-host can change the program output'\)\)/, 'sharing into a breakout needs no host');
});

test('a howl is caught on every path it can arrive on, not just the mixer', () => {
  const audio = readClient('room-audio');
  const relay = readClient('relay-audio');
  const app = readClient('app');

  // The mixer watches audio it does not play: the relay's output and the program feed.
  assert.match(audio, /meter\(id: string, analyser: any\) \{/, 'a meter from somebody else\'s output can be watched');
  assert.match(audio, /analyse\(id: string, stream: any\) \{/, 'and so can a stream played elsewhere');
  assert.match(audio, /for \(const meter of this\.meters\.values\(\)\) \{/, 'the detector samples them');
  assert.match(audio, /const judged = this\._judge\(meter\);/, 'with the same two signatures');
  assert.match(audio, /const judged = this\._judge\(entry\);/, 'on voices too');
  assert.match(audio, /meters: \[\.\.\.this\.meters\.values\(\)\]\.map\(\(meter\) => \(\{/, 'and reports them for diagnosis');
  // A howl has to be visible *while* the room is ducked, or the duck would hide it.
  assert.match(relay, /const analyser = ctx\.createAnalyser\(\);[\s\S]{0,260}?analyser\.connect\(master\);/, 'the relay meters before its gain');
  assert.match(relay, /export function relayedAudioAnalyser\(\)/, 'and hands the meter over');
  assert.match(relay, /export function setRelayedAudioDucked\(ducked: boolean\)/, 'with a way to pull it down');
  assert.match(relay, /const \{ analyser \} = relayOutput\(ctx\);[\s\S]{0,80}?source\.connect\(analyser\);/, 'relayed voice no longer goes straight to the speakers');

  // The app wires both paths up and ducks all of them together.
  assert.match(app, /state\.speaking\.meter\('relay', relayedAudioAnalyser\(\)\);/, 'the relay is watched from the start');
  assert.match(app, /state\.speaking\?\.analyse\('program', stream\);/, 'and the program feed when it arrives');
  assert.match(app, /state\.speaking\?\.forgetMeter\('program'\);/, 'and forgotten when it stops');
  assert.match(app, /setRelayedAudioDucked\(detail\.active\);/, 'a howl pulls the relayed voice down');
  assert.match(app, /applyProgramAudioPolicy\(\{ ducked: detail\.active \}\);/, 'and the program feed with it');
  assert.match(app, /node\.muted = Boolean\(state\.programMuted\) \|\| Boolean\(state\.breakoutId\) \|\| Boolean\(ducked\);/, 'which mutes that element, since it is not in the graph');
  assert.match(app, /const where = detail\.peerId === 'relay'/, 'the banner says which path it came from');
  assert.match(app, /notify\(\s*\n\s*'Feedback detected',\s*\n\s*detail\.reason === 'rising'/, 'and it is worth a notification, saying which signature caught it');

  // The threshold has to be one a real howl reaches: a loud voice, not a deafening one.
  assert.match(audio, /feedbackLevel = 0\.12,/, 'the level a howl has to reach');
  assert.match(audio, /feedbackNarrowShare = 0\.06,/, 'and how narrow it has to be');
});

test('the studio is only the actions, and the meeting controls are always usable', () => {
  const studio = /<div class="studio-panes layout hidden" id="studio-panes">([\s\S]*?)<\/div>\s*<\/main>/.exec(HTML);
  assert.ok(studio, 'the studio exists');
  const panes = studio[1];
  // The program preview and the cameras pane are gone: the picture is in the room,
  // and devices are added from Share.
  assert.ok(!panes.includes('program-panel'), 'no program preview in the studio');
  assert.ok(!panes.includes('sources-panel'), 'no cameras pane in the studio');
  assert.ok(!panes.includes('on-air-label'), 'and no on-air box');
  assert.ok(panes.includes('grid-panel'), 'the grid arrangement is still there');
  assert.ok(!panes.includes('participant-strip'), 'and the people are not: they are the room');
  // The host's program controls moved to the room, with the picture.
  assert.match(HTML, /<div class="program-bar">/, 'the program bar is in the room');
  assert.match(HTML, /id="program-mode" data-requires="control"/, 'with the mode buttons, host-only');
  assert.match(HTML, /<canvas id="program-canvas"/, 'and the picture itself');

  // My own controls are mine to use, whether or not I have joined the call, and they
  // are icons: the meeting bar already says the words.
  assert.match(HTML, /<button id="btn-toggle-mic" class="ghost icon-only" title="Mute or unmute your microphone"/, 'the mic button is never disabled');
  assert.match(HTML, /<button id="btn-toggle-cam" class="ghost icon-only" title="Start or stop your video"/, 'and neither is the camera');
  assert.match(HTML, /id="btn-toggle-mic"[\s\S]{0,400}?<svg class="icon"/, 'both carry an icon');
  assert.ok(!/id="btn-toggle-mic"[\s\S]{0,600}?<span>Mute<\/span>/.test(HTML), 'and no label');
  assert.ok(!/id="btn-toggle-cam"[\s\S]{0,600}?<span>Stop video<\/span>/.test(HTML), 'neither of them');
  const app = readClient('app');
  assert.doesNotMatch(app, /\$\('#btn-toggle-mic'\)\.disabled/, 'nothing disables the mic button');
  assert.doesNotMatch(app, /\$\('#btn-toggle-cam'\)\.disabled/, 'nothing disables the camera button');

  // Who is on air is said on the tile that is on air.
  assert.match(app, /function memberIsOnAir\(member\)/, 'a member can be on air');
  assert.match(app, /badge = el\('span', \{ class: 'badge-air' \}, \['on air'\]\);/, 'and their tile says so');
  assert.match(CSS, /\.room-tile \.badge-air \{/, 'which is styled');
});

test('a viewer gets the program and the people, never the split or the studio', () => {
  // The Split view and the Studio are for the people running the room.
  assert.match(HTML, /<button type="button" data-view="split" data-requires="control">Split<\/button>/, 'split is host-only');
  assert.match(HTML, /id="btn-room-studio"[^>]*data-requires="control"/, 'the studio button is host-only');
  assert.match(HTML, /id="btn-room-more"[^>]*data-requires="control"/, 'and so is the … menu');
  assert.match(HTML, /id="btn-room-record"[^>]*data-requires="control"/, 'and Record, which opens the studio');
  assert.match(HTML, /id="studio-panes">/, 'and the studio drawer itself');

  // What a viewer does get: the two views, the meeting bar, and the chat popup.
  assert.match(HTML, /<button type="button" data-view="program">Program<\/button>/, 'program is for everyone');
  assert.match(HTML, /<button type="button" data-view="people" class="active">People<\/button>/, 'and so are the people');
  assert.match(HTML, /<button type="button" id="btn-room-chat" class="room-tool" title="Chat with the room">/, 'chat is on the bar');
  assert.match(HTML, /<dialog id="chat-dialog" class="chat-dialog">/, 'and opens in front of the room');
  assert.match(HTML, /<div id="chat-dialog-body"><\/div>/, 'holding the same chat panel');

  const app = readClient('app');
  assert.match(app, /if \(wanted === 'split' && !hasControl\(\)\) wanted = 'people';/, 'a viewer asking for split gets the people');
  assert.match(app, /if \(next && !hasControl\(\)\) return;/, 'and nothing opens the studio for them');
  assert.match(app, /function openChatDialog\(\)/, 'chat is a popup, not a pane');
  assert.match(app, /if \(!body\.contains\(panel\)\) body\.append\(panel\);/, 'moving the one chat panel into it');
  assert.match(app, /state\.stageView === 'split'\) setStageView\('people'\);/, 'and a seat handed over re-checks the view');
});

test('my own camera is mirrored, and nothing that goes out is', () => {
  // The mirror: my own preview, and only that.
  assert.match(CSS, /\.self-view video \{ transform: scaleX\(-1\); \}/, 'the self view is a mirror');
  assert.match(CSS, /\.self-view\.unmirrored video \{ transform: none; \}/, 'and can be flipped back');
  assert.match(
    CSS,
    /\.room-tile video,\s*\n\.room-tile img,/,
    'the room tiles are the real picture, never mirrored',
  );
  assert.match(
    CSS,
    /\.grid-preview-tile video \{ transform: none; \}/,
    'and so is what the grid would put out',
  );

  const app = readClient('app');
  // A shared screen is not a self portrait: the self view shows the camera, so a
  // screen share can never end up mirrored.
  assert.match(app, /const stream = myCameraSource\(\)\?\.stream \|\| null;/, 'the self view is the camera');
  assert.match(app, /const SELF_MIRROR_KEY = 'quandrite\.selfMirror';/, 'the choice is remembered');
  assert.match(app, /card\.classList\.toggle\('unmirrored', !mirrored\);/, 'and applied to the card');
  // A click still flips it; a drag moves it instead, and the two do not steal from
  // each other: only a pointer that did not travel counts as a click.
  assert.match(app, /function wireSelfViewDrag\(\)/, 'the picture can be dragged');
  assert.match(app, /if \(!moved\) \{\s*\n\s*toggleSelfViewMirror\(\);\s*\n\s*return;/, 'a click that did not travel still flips the mirror');
  assert.match(app, /if \(!drag\.moved && Math\.hypot\(dx, dy\) < 4\) return;/, 'and a few pixels of shake is not a drag');
  assert.match(app, /card\.addEventListener\('pointerdown', \(event\) => \{[\s\S]{0,200}?if \(event\.button !== 0\) return;/, 'dragging is a left-button gesture');
  // Where it is put is remembered as a fraction, so a resize cannot strand it.
  assert.match(app, /const SELF_POS_KEY = 'quandrite\.selfViewPos';/, 'the position is remembered');
  assert.match(app, /localStorage\.setItem\(SELF_POS_KEY, `\$\{clamp\(x, 0, 1\)\.toFixed\(4\)\},\$\{clamp\(y, 0, 1\)\.toFixed\(4\)\}`\);/, 'as a fraction of the room');
  assert.match(app, /card\.style\.left = `\$\{Math\.round\(pos\.x \* bounds\.maxX\)\}px`;/, 'and put back in the same relative spot');
  assert.match(app, /const left = clamp\(event\.clientX - area\.left - drag\.grabX, 0, maxX\);/, 'a drag is clamped to the room');
  assert.match(app, /window\.addEventListener\('resize', \(\) => applySelfViewPosition\(\)\);/, 'and a resize re-places it');
  // The keyboard can do it too.
  assert.match(app, /const steps = \{ ArrowLeft: \[-1, 0\], ArrowRight: \[1, 0\], ArrowUp: \[0, -1\], ArrowDown: \[0, 1\] \};/, 'the arrow keys move it');
  const page = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
  assert.match(page, /id="self-view" tabindex="0" role="button"/, 'and the card can take focus');
  const css = fs.readFileSync(path.join(rootDir, 'public', 'styles.css'), 'utf8');
  assert.match(css, /cursor: grab; touch-action: none; user-select: none;/, 'the cursor says it can be grabbed');
  assert.match(css, /\.self-view\.dragging \{ cursor: grabbing; \}/, 'and says when it is being dragged');
});

test('chat can be private, and can carry a picture', () => {
  const app = readClient('app');
  const html = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(rootDir, 'public', 'styles.css'), 'utf8');
  const server = fs.readFileSync(path.join(rootDir, 'server', 'signaling.ts'), 'utf8');
  const studio = fs.readFileSync(path.join(rootDir, 'server', 'studio.ts'), 'utf8');
  const api = fs.readFileSync(path.join(rootDir, 'server', 'api.ts'), 'utf8');

  // --- private chat: two people, and nobody else -------------------------------
  assert.match(studio, /privateThreadKey\(a, b\) \{[\s\S]{0,140}?\.sort\(\)\.join\('\\u0000'\)/, 'a thread is keyed by the pair, in a fixed order');
  assert.match(studio, /if \(message\.to\) \{[\s\S]{0,420}?this\.privateChats\.set\(key, thread\);/, 'a private message is kept in its own thread');
  assert.match(studio, /\} else \{\s*\n\s*this\.chat\.push\(message\);/, 'and never joins the room history');
  assert.match(studio, /privateThreadsFor\(clientId\) \{/, 'and the threads come back on joining');
  assert.match(server, /if \(message\?\.to\) \{[\s\S]{0,300}?this\._send\(target, \{ type: SERVER\.CHAT_NEW, payload: message \}\);/, 'the server delivers it to the two people only');
  assert.match(server, /if \(!room\.members\.has\(to\)\) return this\._fail\(session, id, 'that person is not in this room'\);/, 'and only within the room');
  assert.match(server, /const posted = \(to \? session\.studio : room\)\.addChat\(\{/, 'a private thread belongs to the room, not to a breakout');
  assert.match(server, /payload: \{ threads: studio\.privateThreadsFor\(session\.id\) \},/, 'the history is sent to that member alone');

  // The client keeps one thread per person, and counts what it has not read.
  assert.match(app, /return message\.authorId === state\.clientId \? message\.to : message\.authorId;/, 'a message belongs to the thread with the other person');
  assert.match(app, /function renderChatTargets\(\)/, 'who to message is a choice');
  assert.match(app, /select\.append\(el\('option', \{ value: '', text: 'Everyone in the room' \}\)\);/, 'with the room as the default');
  assert.match(app, /function bumpUnread\(key\)/, 'an unseen message is counted');
  assert.match(app, /function renderChatBadges\(\)/, 'and shown on the Chat button');
  assert.match(html, /id="chat-target"/, 'the picker is in the panel');
  assert.match(html, /id="chat-unread" class="room-tool-badge hidden"/, 'with a badge on the bar');
  assert.match(app, /to: state\.chatTarget \|\| null,/, 'and the message is sent to the chosen thread');
  assert.match(app, /function openChatWith\(memberId\)/, 'the roster can open a private thread');
  assert.match(app, /dataset: \{ message: member\.id \}/, 'one button per person');
});

test('participants choose a breakout room, and a host can rename one', () => {
  const app = readClient('app');
  const html = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(rootDir, 'public', 'styles.css'), 'utf8');
  const server = fs.readFileSync(path.join(rootDir, 'server', 'signaling.ts'), 'utf8');
  const studio = fs.readFileSync(path.join(rootDir, 'server', 'studio.ts'), 'utf8');
  const rooms = fs.readFileSync(path.join(rootDir, 'server', 'rooms.ts'), 'utf8');

  // Anyone may walk into a room that is open - it is a choice, not an assignment.
  assert.match(server, /const movingSelf = memberId === session\.id;[\s\S]{0,340}?if \(breakoutId && !session\.studio\.breakouts\.get\(breakoutId\)\?\.open\) \{\s*\n\s*return this\._fail\(session, id, 'that breakout room is not open yet'\);/, 'joining is allowed for any open room, by the member themselves');

  // The picker: the Rooms button - always on the bar, because a room is somewhere to go -
  // the dialog, and one row per room.
  assert.match(
    html,
    /<button type="button" id="btn-room-breakout" class="room-tool" title="Breakout rooms[^"]*">/,
    'the Rooms button is on the meeting bar, rooms or not',
  );
  assert.match(app, /button\.classList\.remove\('hidden'\);/, 'and is never hidden again');
  assert.match(html, /<dialog id="breakout-dialog" class="breakout-dialog">/, 'and a picker to open');
  assert.match(app, /function openBreakoutPicker\(\)/, 'which lists the rooms');
  assert.match(app, /send\(CLIENT\.BREAKOUT_ASSIGN, \{ breakoutId: id \}\);/, 'and joining is one click');
  assert.match(app, /dataset: \{ breakout: id \|\| 'main' \}/, 'with the main room always offered');
  assert.match(app, /disabled: !room\.open && state\.breakoutId !== room\.id,/, 'a closed room cannot be walked into');
  assert.match(app, /function renderBreakoutButton\(\)/, 'the button follows the rooms');
  assert.match(app, /badge\.classList\.toggle\('hidden', !waiting\);/, 'and shows when there is somewhere to go');
  assert.match(app, /\$\('#btn-room-breakout'\)\?\.addEventListener\('click', \(\) => openBreakoutPicker\(\)\);/, 'the button opens the picker');
  assert.match(css, /\.breakout-choice \{/, 'and the rows are styled');

  // The notification, which points at the picker.
  assert.match(app, /function announceBreakouts\(before, after\) \{/, 'the rooms are announced when they change');
  assert.match(app, /'Breakout rooms are ready',[\s\S]{0,200}?\{ tag: 'breakouts', onClick: openBreakoutPicker \},/, 'a new room tells people to pick one, and the notification opens the picker');
  assert.match(app, /'Breakout rooms are open',[\s\S]{0,200}?\{ tag: 'breakouts', onClick: openBreakoutPicker \},/, 'and so does opening them');
  assert.match(app, /if \(typeof onClick === 'function'\) onClick\(\);/, 'clicking a notification runs what it points at');
  assert.match(app, /announceBreakouts\(before, state\.breakouts\);/, 'and it is driven by the breakouts update');

  // Renaming, for the host.
  assert.match(studio, /renameBreakout\(breakoutId, label\) \{/, 'a breakout room can be renamed');
  assert.match(studio, /const next = cleanText\(label, MAX_BREAKOUT_LABEL\);/, 'with the name cleaned and bounded');
  assert.match(studio, /text: `"\$\{before\}" is now called "\$\{next\}"`,/, 'and the room is told');
  assert.match(studio, /this\.breakoutRooms\?\.rename\?\.\(breakoutId, `\$\{this\.name\} - \$\{next\}`\);/, 'including the breakout room itself');
  assert.match(rooms, /rename: \(roomId, name\) => \{/, 'which the registry implements');
  assert.match(server, /case CLIENT\.BREAKOUT_RENAME: \{[\s\S]{0,160}?if \(!this\._requireControl\(session, id\)\) return undefined;/, 'renaming needs control');
  assert.match(app, /function startBreakoutRename\(item, room\) \{/, 'the host renames in place');
  assert.match(app, /dataset: \{ rename: room\.id \}/, 'from the room\'s own row');
  assert.match(app, /send\(CLIENT\.BREAKOUT_RENAME, \{ breakoutId: room\.id, label: value \}\);/, 'and it is sent as a rename');
  assert.match(app, /if \(event\.key === 'Enter'\)/, 'Enter saves');
  assert.match(app, /\} else if \(event\.key === 'Escape'\)/, 'and Escape changes nothing');
  assert.match(css, /\.breakout-rename \{/, 'the input is styled');
});

test('a participant can leave a breakout room from wherever they are looking', () => {
  const app = readClient('app');
  const html = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(rootDir, 'public', 'styles.css'), 'utf8');

  // The banner is over the stage, not inside one view: a participant in a breakout is
  // usually looking at the grid, and the way out has to be reachable from there.
  const stage = /<section class="room-stage" id="room-stage">[\s\S]*?<\/section>/.exec(html);
  assert.ok(stage, 'there is a stage');
  assert.ok(stage[0].includes('id="breakout-banner"'), 'the banner is in the stage, not in a view');
  assert.match(
    html,
    /<div id="breakout-banner" class="breakout-banner hidden">[\s\S]{0,200}?<button type="button" id="btn-leave-breakout" class="tiny">Leave this room/,
    'and it says what the button does',
  );
  const programView = /<div class="stage-view program-view">[\s\S]*?<div class="stage-view people-view">/.exec(html);
  assert.ok(programView && !programView[0].includes('breakout-banner'), 'and it is no longer hidden inside the program view');
  assert.match(css, /\.breakout-banner \{[\s\S]{0,160}?position: absolute; top: 10px; left: 50%/, 'it floats over the stage');

  // The pill in the top bar says where I am, and clicking it leaves.
  assert.match(html, /<button type="button" id="breakout-pill" class="pill hidden">/, 'the location pill is a button');
  assert.match(app, /pill\.disabled = !inBreakout;/, 'only clickable while I am in a room');
  assert.match(app, /pill\.title = inBreakout\s*\n\s*\? `Leave \$\{breakoutLabel\(state\.breakoutId\)\} and go back to the main room`/, 'and it says so');
  assert.match(app, /\$\('#breakout-pill'\)\.addEventListener\('click', leaveBreakoutRoom\);/, 'clicking it leaves');
  assert.match(app, /\$\('#btn-leave-breakout'\)\.addEventListener\('click', leaveBreakoutRoom\);/, 'and so does the banner button');

  // One behaviour, in one place, with the server call it makes.
  assert.match(app, /function leaveBreakoutRoom\(\) \{[\s\S]{0,200}?send\(CLIENT\.BREAKOUT_ASSIGN, \{ breakoutId: null \}\);/, 'leaving is the same message however it is asked for');
  assert.match(app, /toast\(`Left \$\{from\} - you are back in the main room`, 'info'\);/, 'and it is confirmed');
  assert.match(app, /state\.breakoutId \? 'Leave this room - back to the main room' : 'Main room',/, 'the picker says the same thing in words');
  assert.match(css, /\.pill\.clickable \{ cursor: pointer; \}/, 'the pill looks clickable');
});

test('a picture can be sent in chat, and only one of ours', () => {
  const app = readClient('app');
  const html = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(rootDir, 'public', 'styles.css'), 'utf8');
  const server = fs.readFileSync(path.join(rootDir, 'server', 'signaling.ts'), 'utf8');
  const api = fs.readFileSync(path.join(rootDir, 'server', 'api.ts'), 'utf8');

  // Uploading: a data URL in, a URL of ours out.
  assert.match(api, /'\/rooms\/:id\/chat\/upload',/, 'there is an upload endpoint');
  assert.match(api, /function decodeImageDataUrl\(dataUrl\)/, 'which reads a data URL');
  assert.match(api, /if \(!CHAT_ATTACHMENT_TYPES\.includes\(mime\)\) return null;/, 'only for the picture types the room accepts');
  assert.match(api, /const looksRight =[\s\S]{0,460}?if \(!looksRight\) return null;/, 'and only when the bytes really are that picture');
  assert.match(api, /const file = `\$\{studio\.id\}-\$\{randomUUID\(\)\}\.\$\{parsed\.extension\}`;/, 'the file name is the server\'s, never the client\'s');
  assert.match(api, /if \(parsed\.bytes\.length > MAX_CHAT_ATTACHMENT_BYTES\)/, 'and a huge picture is refused');
  // A message can only point at a picture this server stored for this room.
  assert.match(server, /const prefix = `\/uploads\/\$\{studio\.id\}-`;/, 'a message may only refer to this room\'s uploads');
  assert.match(server, /const file = path\.basename\(url\.slice\(prefix\.length\)\);/, 'with the name rebuilt, so nothing can walk out of the directory');
  assert.match(server, /if \(message\.attachment && !attachment\) return this\._fail\(session, id, 'that picture is not available'\);/, 'and a made-up URL is refused');
  const index = fs.readFileSync(path.join(rootDir, 'server', 'index.ts'), 'utf8');
  assert.match(index, /app\.use\(\s*\n\s*'\/uploads',/, 'uploads are served back');
  assert.match(index, /max-age=604800, immutable/, 'and cached, because the name never changes');

  // The client scales the picture down, shows it before sending, and can paste one.
  assert.match(app, /const CHAT_IMAGE_MAX_EDGE = 1280;/, 'pictures are scaled down before they are sent');
  assert.match(app, /context\.drawImage\(bitmap, 0, 0, width, height\);/, 'on a canvas');
  assert.match(app, /const dataUrl = canvas\.toDataURL\(mime, 0\.85\);/, 'which is what keeps a screenshot small');
  assert.match(app, /async function attachChatImage\(file\)/, 'attaching uploads it');
  assert.match(app, /function setPendingAttachment\(attachment\)/, 'and shows it waiting to be sent');
  assert.match(app, /if \(!text && !attachment\) return;/, 'a picture on its own is a message');
  assert.match(app, /\$\('#chat-input'\)\?\.addEventListener\('paste', \(event\) => \{/, 'a pasted picture attaches');
  assert.match(app, /chatPanel\?\.addEventListener\('drop', \(event\) => \{/, 'and so does a dropped one');
  assert.match(app, /parts\.push\(chatPicture\(message\.attachment\)\);/, 'a message with a picture renders it');
  assert.match(html, /id="btn-chat-attach"/, 'there is an attach button');
  assert.match(css, /\.chat-picture \{/, 'and the picture is styled to fit the column');
});

test('notifications are opt-in, and never say what can be seen', () => {
  const app = readClient('app');
  const html = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');

  assert.match(app, /const NOTIFY_KEY = 'quandrite\.notify';/, 'the choice is remembered');
  assert.match(app, /function notify\(title, body = '', \{ tag = 'quandrite', force = false, onClick = null \} = \{\}\)/, 'there is one way to notify');
  assert.match(app, /if \(!force && document\.visibilityState === 'visible' && document\.hasFocus\(\)\) return false;/, 'nothing is announced that can already be seen');
  assert.match(app, /if \(!notificationsOn\(\)\) return false;/, 'and nothing at all unless it was asked for');
  assert.match(app, /const permission = await Notification\.requestPermission\(\)\.catch\(\(\) => 'denied'\);/, 'the permission is asked for from a click');
  assert.match(app, /function enableNotifications\(\)/, 'which is what the bell does');
  assert.match(app, /notify\(what, 'You can turn it back on whenever you like', \{ tag: 'moderation', force: true \}\);/, 'a mute is announced even with the tab in front');
  assert.match(app, /isPrivate \? `Private message from \$\{message\.authorName\}` : `\$\{message\.authorName\} in the room chat`/, 'a message that cannot be seen is announced');
  assert.match(app, /notify\('You are live', 'The broadcast is going out', \{ tag: 'stream' \}\);/, 'and so is going live');
  assert.match(app, /asked for \$\{source\.request === 'air' \? 'the air' : 'the grid'\}/, 'and a request for the air, for a host');
  assert.match(html, /id="btn-room-notify"/, 'the bell is on the meeting bar');
  assert.match(app, /\$\('#btn-room-notify'\)\?\.addEventListener\('click', \(\) => toggleNotifications\(\)\);/, 'and it toggles them');
  assert.match(app, /const text = denied \? 'Blocked' : on \? 'Alerts on' : 'Notify';/, 'and says which state it is in');
});

test('a host can mute and stop a participant, and it is enforced', () => {
  const app = readClient('app');
  const html = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(rootDir, 'server', 'signaling.ts'), 'utf8');
  const studio = fs.readFileSync(path.join(rootDir, 'server', 'studio.ts'), 'utf8');

  // The server owns the decision: a host or co-host may switch somebody else's media.
  assert.match(server, /case CLIENT\.MEMBER_MEDIA: \{[\s\S]{0,120}?if \(!this\._requireControl\(session, id\)\) return undefined;/, 'moderating needs control');
  assert.match(server, /message\.all\s*\n?\s*\? \[\.\.\.session\.studio\.members\.keys\(\)\]\.filter\(\(memberId\) => memberId !== session\.id\)/, '"everyone" means everyone else');
  assert.match(server, /this\._send\(target, \{ type: SERVER\.MEMBER_MEDIA, byName: session\.name, \.\.\.patch \}\);/, 'and the member is told, so their own tracks really stop');

  // The member's client applies it rather than just believing the label.
  assert.match(app, /socket\.on\(SERVER\.MEMBER_MEDIA, async \(message\) => \{[\s\S]{0,200}?setLocalAudio\(!message\.muted\);/, 'my microphone is switched off when I am muted');
  assert.match(app, /if \(message\.cameraEnabled === false\) \{[\s\S]{0,240}?await keepVoiceAlive\(\);[\s\S]{0,120}?await state\.camera\.removeSource\(source\.id\);/, 'and my video stops without taking my voice with it');
  assert.match(app, /const what =\s*\n\s*message\.muted === true\s*\n\s*\? `\$\{who\} muted you`/, 'and I am told who did it');

  // A decision survives a reload: the roster is re-applied on the way in.
  assert.match(app, /function applyRoomModeration\(\)/, 'the room\'s record is applied on joining');
  assert.match(app, /if \(!me\?\.muted\) return;[\s\S]{0,160}?setLocalAudio\(false\);/, 'so a muted microphone does not come back on by itself');
  assert.match(app, /applyRoomModeration\(\);[\s\S]{0,60}?loadRecordings\(\);/, 'as part of the join');
  // ...and joining the call does not overrule the host either - or me: a microphone I
  // switched off before joining stays off.
  assert.match(app, /const mine = microphoneTracks\(\)\.length > 0 && !myMicEnabled\(\);/, 'my own pre-join choice is a mute too');
  assert.match(app, /const held = Boolean\(me\?\.muted\) \|\| mine;[\s\S]{0,120}?setLocalAudio\(!held\);/, 'so joining the call respects the record');
  assert.match(app, /send\(CLIENT\.MEMBER_UPDATE, \{ patch: \{ cameraEnabled: Boolean\(myCameraSource\(\)\), muted: held \} \}\);/, 'and says what the video is actually doing, rather than announcing an unmute');
  // The server keeps an individual mute, by name, so a reload does not undo it.
  assert.match(studio, /this\.mutedNames = new Set\(\);/, 'the room remembers who was muted');
  assert.match(studio, /muted: this\.mutedNames\.has\(nameKey\(memberName\)\),/, 'and they arrive muted');
  assert.match(studio, /rememberMute\(clientId, muted\) \{/, 'the note is written and cleared by the host');
  assert.match(studio, /function nameKey\(name\) \{/, 'a name is compared without case or stray spacing');
  assert.match(server, /if \(!message\.all && patch\.muted !== undefined\) \{[\s\S]{0,120}?session\.studio\.rememberMute\(memberId, patch\.muted\);/, 'a mute of one person is remembered, a sweep is not');

  // A host does it from the tile, not from a list they have to go and find.
  assert.match(app, /function tileTools\(tile, member\) \{[\s\S]{0,120}?if \(!hasControl\(\)\) \{/, 'the tile controls are the host\'s');
  assert.match(app, /const mic = mediaButton\(member, 'mic', \{ compact: true \}\);/, 'a mute button per tile');
  assert.match(app, /const camera = mediaButton\(member, 'camera', \{ compact: true \}\);/, 'and a stop-video button');
  assert.match(app, /tileTools\(tile, member\);/, 'drawn with the tile');
  assert.match(app, /dataset: \{ media: kind, member: member\.id, requires: 'control' \}/, 'and marked as a control, so a viewer never gets one');
  assert.match(app, /if \(tools\.dataset\.key === key\) return;/, 'the buttons are left alone unless their state changed');

  // The roster is reachable again - it is the popup the People button opens.
  assert.match(html, /<dialog id="people-dialog" class="people-dialog">/, 'there is a People popup');
  assert.match(app, /\$\('#btn-room-people'\)\?\.addEventListener\('click', \(\) => openPeopleDialog\(\)\);/, 'which the meeting bar opens');
  assert.match(app, /function openPeopleDialog\(\)[\s\S]{0,320}?document\.querySelector\('\.tab-panel\[data-panel="people"\]'\)/, 'showing the same panel, so breakouts and passwords come with it');
  assert.match(app, /function closePeopleDialog\(\)[\s\S]{0,260}?home\.append\(panel\);/, 'and putting it back where it lives');
  const css = fs.readFileSync(path.join(rootDir, 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.room-tile \.tile-tools \{/, 'the tile controls are styled');
  assert.match(css, /\.room-tile:hover \.tile-tools,[\s\S]{0,60}?\.room-tile:focus-within \.tile-tools \{ opacity: 1; \}/, 'and appear when the tile is pointed at');
  assert.match(css, /@media \(hover: none\) \{[\s\S]{0,80}?\.room-tile \.tile-tools \{ opacity: 1; \}/, 'always, where there is no hover');
});

test('the program hint only sits on an empty program', () => {
  const app = readClient('app');
  // It used to be a static element, so it drew "add a camera" over a live picture.
  assert.match(app, /function programHasPicture\(\)/, 'the program is asked whether it has a picture');
  assert.match(app, /if \(!inBreakoutRoom\(\) && state\.programStream\) return true;/, 'an incoming feed is one, unless I am in a breakout - where the stage is that room\'s own screen');
  assert.match(app, /if \(screenSources\(\)\.length\) return true;/, 'a placed source is one');
  assert.match(app, /return Boolean\(screenScene\(\)\);/, 'and a scene on air is one too');
  assert.match(app, /const hint = \$\('#program-empty'\);[\s\S]{0,80}?hint\.classList\.toggle\('hidden', programHasPicture\(\)\)/, 'which is what hides the hint');
  assert.match(app, /syncProgramFrame\(\);[\s\S]{0,220}?syncProgramHint\(\);/, 'and it is refreshed with the frame');
  assert.match(app, /node\.classList\.remove\('hidden'\);[\s\S]{0,400}?syncProgramHint\(\);/, 'including when a feed arrives');
});

test('muting is about the microphone, and the status pills say what they mean', () => {
  const app = readClient('app');
  // A screen share has audio of its own, and muting me must not silence it.
  assert.match(app, /function microphoneTracks\(\)/, 'the microphone tracks are identified first');
  assert.match(app, /if \(source\.kind !== 'audio' && source\.kind !== 'camera'\) continue;/, 'a microphone, or the one in a camera - never a screen');
  assert.match(app, /state\.meeting\.setMicEnabled\(enabled, tracks\);/, 'and the mesh is told which they are');
  const mesh = readClient('webrtc');
  assert.match(mesh, /setMicEnabled\(enabled, tracks = null\)/, 'so it does not reach for every audio track');
  assert.match(mesh, /this\.localStream\?\.getAudioTracks\?\.\(\) \|\| \[\]/, 'only falling back to the published stream');

  // The two pills are the broadcast and the recording, and they say so in words.
  assert.match(app, /livePill\.title = live\s*\n\s*\? `Sending to \$\{\(state\.destinations \|\| \[\]\)\.length\} platform\(s\)/, 'the live pill explains itself');
  assert.match(app, /'Nothing is being sent to any platform: the room is just a room'/, 'and says what off air means');
  assert.match(app, /const recordingWord = \{\s*\n\s*idle: 'not recording',/, 'the recording pill says "not recording", not "idle"');
  // The word has to travel through setPill: it sets the text itself, so writing to the
  // node first and calling setPill after would put the raw status back.
  assert.match(app, /setPill\('#rec-pill', recording\.status === 'recording' \? 'rec' : '', recordingWord\);/, 'and the word is what the pill is set to');
  assert.match(app, /recPill\.title = \(recording\.status \|\| 'idle'\) === 'idle'\s*\n\s*\? 'This room is not being recorded'/, 'with a tooltip that explains it');
});

test('the server keeps the socket alive and reaps dead ones', () => {

  const source = fs.readFileSync(path.join(rootDir, 'server', 'index.ts'), 'utf8');
  assert.match(source, /signaling\.startHeartbeat\(\)/, 'the heartbeat is started with the server');
  // The served client is always the build, so say so when it is missing.
  assert.match(source, /no client build found in/, 'a missing client build is reported');
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.dev, 'vite', 'npm run dev serves the client through Vite');
  assert.equal(pkg.scripts.prestart, 'npm run build', 'npm start builds the client first');
  assert.match(pkg.scripts.build, /vite build/, 'the client is built by Vite');
  const signaling = fs.readFileSync(path.join(rootDir, 'server', 'signaling.ts'), 'utf8');
  assert.match(signaling, /startHeartbeat\(intervalMs = 30000\)/, 'the heartbeat pings every 30s');
  assert.match(signaling, /socket\.terminate\(\)/, 'a socket that stopped answering is dropped');
});

test('joining a meeting is the initial state, and my own media is mine', () => {
  const landing = /<section id="landing"[\s\S]*?<\/section>/.exec(HTML);
  assert.ok(landing, 'there is a landing page');
  const prejoin = /<div class="prejoin" id="prejoin-controls">([\s\S]*?)<\/div>/.exec(HTML);
  assert.ok(prejoin, 'the landing page - the initial state - carries the way into the call');
  for (const id of ['btn-toggle-mic', 'btn-toggle-cam', 'btn-join-call']) {
    assert.ok(prejoin[1].includes(`id="${id}"`), `${id} is on the initial state`);
  }
  assert.ok(landing[0].includes('id="prejoin-controls"'), 'and the row is inside the landing card');
  assert.match(CSS, /\.prejoin \{ display: flex;/, 'the row is styled');
  assert.match(HTML, /<video id="prejoin-preview"[\s\S]{0,120}?hidden><\/video>/, 'with a preview of what the camera will publish');
  assert.match(CSS, /\.prejoin-preview \{[\s\S]{0,260}?transform: scaleX\(-1\);/, 'which is mirrored, like my own tile');

  // The row left the studio: it used to sit behind a host-only tab, where a viewer - the
  // one person who needs it most - could never reach it.
  const studio = /<div class="studio-panes layout hidden" id="studio-panes">([\s\S]*?)<\/div>\s*<\/main>/.exec(HTML);
  assert.ok(studio, 'the studio exists');
  assert.ok(!studio[1].includes('btn-join-call'), 'the studio no longer holds the way into the call');
  assert.ok(!studio[1].includes('btn-toggle-mic'), 'nor the microphone toggle');

  // The meeting bar's own microphone and camera are the same icons, where the words
  // "Mute" and "Stop video" used to be, and nothing disables them.
  assert.match(
    HTML,
    /<button type="button" id="btn-room-mic" class="room-tool icon-only" title="Mute or unmute your microphone"[\s\S]{0,220}?<svg class="icon"/,
    "the bar's microphone is an icon",
  );
  assert.match(
    HTML,
    /<button type="button" id="btn-room-cam" class="room-tool icon-only" title="Start or stop your video"[\s\S]{0,220}?<svg class="icon"/,
    'and so is the camera',
  );
  assert.ok(!/id="btn-room-mic"[^>]*disabled/.test(HTML), "the bar's microphone is never disabled");
  assert.ok(!/id="btn-room-cam"[^>]*disabled/.test(HTML), 'and neither is the camera');
  assert.match(CSS, /\.room-tool\.icon-only \{/, 'the icon buttons are styled for the bar');

  const app = readClient('app');
  assert.match(app, /function renderMyMediaButtons\(\)/, 'one painter keeps both sets of controls honest');
  assert.match(app, /function myMicEnabled\(\)/, 'my microphone is read from my own tracks');
  assert.match(app, /const mute = myMicEnabled\(\);/, 'so the toggle follows what it is really doing');
  assert.match(app, /iconOnly\(barMic, micOn \? 'mic' : 'micOff'/, "the bar's icon carries the state");
  assert.doesNotMatch(app, /mic\.disabled = !state\.inCall/, 'nothing gates my own media on having joined the call');
  assert.match(app, /function myScreenSource\(\)/, 'and my screen share is known the same way');
  assert.match(app, /preview\.hidden = !stream;/, 'the pre-join preview shows the camera only while it is on');

  // Joining happens on the initial state: one press enters the room and then the call.
  assert.match(app, /async function joinCallFromLanding\(\)/, 'the landing page joins the room and the call');
  assert.match(app, /await submitJoinForm\(\);[\s\S]{0,80}?await joinCall\(\);/, 'in that order');
  assert.match(app, /\$\('#btn-join-call'\)\.addEventListener\('click', joinCallFromLanding\);/, 'and the button is wired to it');
  assert.match(app, /async function submitJoinForm\(\)/, 'the form has one reader');
  assert.match(
    app,
    /\$\('#join-form'\)\.addEventListener\('submit', async \(event\) => \{\s*\n\s*event\.preventDefault\(\);\s*\n\s*await submitJoinForm\(\);/,
    'which both ways in use',
  );
  assert.match(app, /\$\('#btn-join-call'\)\.disabled = Boolean\(state\.inCall\);/, 'Join call is usable before a room exists - it enters one');

  // Media turned on before the room existed is handed over when the room arrives.
  assert.match(app, /async function announceLocalMedia\(\)/, 'pre-join media is handed to the room');
  assert.match(app, /await state\.camera\.announceSource\(source\.id\)/, 'by announcing it');
  assert.match(app, /await announceLocalMedia\(\)\.catch\(\(\) => \{\}\);/, 'as part of joining');
  assert.match(app, /const added = await state\.camera\.addCamera\(\{ announce: Boolean\(state\.roomId\) \}\)/, 'a pre-join camera is not announced to a room that does not exist');
  const devices = readClient('devices');
  assert.match(devices, /async announceSource\(sourceId\) \{/, 'the camera manager can announce a source later');
});

test('a screen share happens once: the second share replaces the first', () => {
  const app = readClient('app');
  const devices = readClient('devices');

  // The library enforces it, so no caller can stack two screens up.
  assert.match(devices, /await this\.endScreenShares\(\);/, 'a new share ends the old one first');
  assert.match(devices, /async endScreenShares\(\) \{\s*\n\s*const sharing = this\.list\(\)\.filter\(\(source\) => source\.kind === 'screen'\);/, 'every screen of mine');
  assert.match(devices, /for \(const source of sharing\) await this\.removeSource\(source\.id\)/, 'is stopped, not just forgotten');

  // ...and the UI is a toggle, so the same press ends what it started.
  assert.match(app, /const sharing = myScreenSource\(\);\s*\n\s*if \(sharing\) \{/, 'the picker ends the share it started');
  assert.match(app, /await state\.camera\.removeSource\(sharing\.id\)/, 'by removing the source');
  assert.match(app, /function renderScreenShareButton\(\)/, 'and says what the next press will do');
  assert.match(app, /button\.textContent = sharing \? 'Stop sharing' : 'Share screen';/, 'stop or start');
  assert.match(app, /renderScreenShareButton\(\);/, 'which is repainted with the picker');
});



test('the meeting bar sits with the program frame, and the rooms are visible', () => {
  // The bar is inside the stage, immediately after the program view: the controls sit
  // under the picture they control, in the stage's own column when the studio is docked
  // beside the room, and they are a sibling of the views - so People keeps them.
  const stage = /<section class="room-stage" id="room-stage">([\s\S]*?)<\/section>/.exec(HTML);
  assert.ok(stage, 'there is a stage');
  const body = stage[1];
  assert.ok(body.includes('id="room-toolbar"'), 'the meeting bar is in the stage');
  const programView = body.indexOf('stage-view program-view');
  const bar = body.indexOf('<footer class="room-toolbar" id="room-toolbar">');
  const peopleView = body.indexOf('stage-view people-view');
  assert.ok(programView >= 0 && bar > programView, 'and it comes after the program frame');
  assert.ok(peopleView > bar, 'as a sibling of the views, so the People view keeps it');
  assert.match(CSS, /\.room-stage \{[\s\S]{0,220}?grid-template-rows: minmax\(0, 1fr\) auto;/, 'the stage keeps the last row for it');
  assert.match(CSS, /\.room-stage > \.room-toolbar \{ grid-column: 1 \/ -1; \}/, 'and it spans the stage');
  assert.match(CSS, /\.room \{[\s\S]{0,120}?grid-template-rows: auto minmax\(0, 1fr\);/, 'the room itself is the bar and the stage');

  // Breakout rooms are visible from both places they are used from.
  assert.match(HTML, /<button data-tab="rooms">Rooms<\/button>/, 'the studio has a Rooms tab');
  const rooms = /<div class="tab-panel hidden" data-panel="rooms">([\s\S]*?)<\/div>\s*<\/div>/.exec(HTML);
  assert.ok(rooms, 'which holds the breakout panel');
  assert.ok(rooms[1].includes('id="breakout-list"'), 'with the list of rooms');
  assert.ok(rooms[1].includes('id="btn-choose-breakout"'), 'and a way in for everyone');
  assert.ok(!/data-panel="people"[\s\S]{0,900}?id="breakout-list"/.test(HTML), 'and it is no longer buried in the roster');

  const app = readClient('app');
  assert.match(app, /name === 'rooms'[\s\S]{0,140}?renderBreakouts\(\);/, 'the tab paints the rooms on the spot');
  assert.match(app, /\$\('#btn-choose-breakout'\)\?\.addEventListener\('click', \(\) => openBreakoutPicker\(\)\);/, 'and the studio offers the same picker as the bar');
});

test('audio survives the paths that used to break it', () => {
  const mixer = readClient('room-audio');
  const relay = readClient('relay-audio');
  const devices = readClient('devices');
  const app = readClient('app');
  const server = fs.readFileSync(path.join(rootDir, 'server', 'signaling.ts'), 'utf8');

  // A voice that arrives *while* the room is ducked (the program mix is carrying it) has
  // to come back up when the duck ends. The gain ramp only fires on a change, so the entry
  // must start at exactly the value the mixer would ask for.
  assert.match(mixer, /const wanted = monitor && !muted && !this\.ducked \? 1 : 0;/, 'a new voice starts at the gain the mixer would ask for');
  assert.match(mixer, /gain\.gain\.value = wanted;/, 'which is what its gain is set to');
  assert.match(mixer, /requested: wanted,/, 'and what it is recorded as wanting');
  // The meters outlive the voices, so the sample timer must not stop with the last voice:
  // the relayed voice would lose its meter and the mixer would stop reporting.
  assert.match(mixer, /if \(!this\.entries\.size && !this\.meters\.size\) this\.stop\(\);/, 'the meters keep the mixer sampling');

  // The PCM fallback says how deep it is, and the far end reads exactly that - reading
  // 16-bit samples as 24-bit is noise, not a rounding error.
  assert.match(relay, /const bits = header\.codec === 'pcm24' \|\| Number\(header\.bits\) === 24 \? 24 : 16;/, 'a slice that does not say is read as 16-bit');
  assert.match(relay, /codec: bits === 24 \? 'pcm24' : 'pcm16',/, 'and a slice that is sent says what it is');
  // 24-bit is three bytes a sample; when the socket is behind, the depth steps down so the
  // voice still goes out instead of being dropped.
  assert.match(relay, /_pcmBits\(\) \{[\s\S]{0,140}?return backlog > this\.maxBufferedBytes \/ 2 \? 16 : RELAY_PCM_BITS;/, 'the depth follows the socket');
  assert.match(relay, /const bits = this\._pcmBits\(\);[\s\S]{0,80}?this\._toPcm\(mono, bits\)/, 'and the slice is encoded at that depth');

  // Voice slices must not evict the warm *pictures* a newcomer is shown: a camera's
  // microphone shares its source id.
  assert.match(server, /if \(header\?\.kind === 'audio'\) return;/, 'only pictures are remembered for a newcomer');

  // Media captured before a room exists must not be announced into nothing: the source is
  // announced when the room arrives instead.
  assert.match(devices, /async addMicrophone\(\{ deviceId = null, label = null, announce = true \}: any = \{\}\)/, 'a microphone can be captured without a room');
  assert.match(app, /async function ensureMicrophone\(\{ announce = Boolean\(state\.roomId\) \}: any = \{\}\)/, 'which is how the pre-join microphone is opened');
});
