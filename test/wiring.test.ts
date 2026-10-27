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

import { CLIENT, SERVER, REQUESTABLE_SCENE_TYPES } from '../shared/protocol.ts';
import { REQUESTABLE_OVERLAY_TYPES } from '../shared/overlays.ts';

const rootDir = path.resolve(import.meta.dirname, '..');
const CLIENT_DIR = path.join(rootDir, 'public', 'js');
const HTML = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');

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
  assert.match(app, /closeDeviceDialog\(\);/, 'the picker closes so the change is visible');
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

test('cameras live in one pop-up pane and every pane can be hidden', () => {
  for (const id of [
    'pane-toggles',
    'device-dialog',
    'device-list-picker',
    'device-dialog-status',
    'device-dialog-close',
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
  for (const pane of ['program', 'participants', 'sources', 'sidebar']) {
    assert.ok(new RegExp(`data-pane="${pane}"`).test(HTML), `${pane} is a pane`);
  }
  assert.ok(!HTML.includes('id="btn-add-camera"'), 'the inline camera buttons are gone');
  assert.ok(!HTML.includes('id="btn-add-all-cameras"'), 'the inline camera buttons are gone');
  assert.ok(
    /id="pane-toggles"[\s\S]*data-pane="sources"[\s\S]*data-requires="control"/.test(HTML),
    'the camera pane toggle is host-only',
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
