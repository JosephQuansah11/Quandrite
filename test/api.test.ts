import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../server/index.ts';
import { loadConfig } from '../server/config.ts';

const silent = { info() {}, warn() {}, error() {} };

let quandrite;
let base;

before(async () => {
  const config = loadConfig({
    recordingsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'quandrite-api-')),
  });
  quandrite = createServer({ config, logger: silent });
  const address = await quandrite.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await quandrite.close();
});

test('health reports the ffmpeg binary and recordings directory', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'quandrite');
  assert.ok(body.ffmpeg.length > 0);
  assert.ok(body.recordingsDir.length > 0);
});

test('capabilities advertise every platform, preset and overlay', async () => {
  const body = await (await fetch(`${base}/api/capabilities`)).json();
  const platforms = body.platforms.map((platform) => platform.id);
  for (const required of ['youtube', 'facebook', 'twitter', 'tiktok']) {
    assert.ok(platforms.includes(required), `${required} is offered`);
  }
  assert.deepEqual(body.overlayTypes, ['title', 'announcement', 'screenshare', 'song', 'break', 'ended']);
  assert.ok(body.presets.length >= 5);
  assert.equal(body.websocketPath, '/ws');
  assert.deepEqual(body.roles, ['host', 'cohost', 'viewer', 'visitor']);
  assert.deepEqual(body.passwordRoles, ['host', 'cohost']);
  assert.ok(body.minPasswordLength >= 4);
  assert.equal(body.maxBreakouts, 8);
});

test('rooms can be created, listed, fetched and deleted', async () => {
  const created = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'launch', name: 'Product launch', hostName: 'Ada' }),
  });
  assert.equal(created.status, 201);
  const { room } = await created.json();
  assert.equal(room.room.id, 'launch');
  assert.equal(room.room.name, 'Product launch');
  assert.equal(room.program.mode, 'single');
  assert.deepEqual(room.destinations, []);

  const list = await (await fetch(`${base}/api/rooms`)).json();
  assert.ok(list.rooms.some((entry) => entry.id === 'launch'));

  const single = await fetch(`${base}/api/rooms/launch`);
  assert.equal(single.status, 200);

  const duplicate = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'launch' }),
  });
  assert.equal(duplicate.status, 400);

  const invalid = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'not a room!' }),
  });
  assert.equal(invalid.status, 400);

  assert.equal((await fetch(`${base}/api/rooms/ghost`)).status, 404);
  assert.equal((await fetch(`${base}/api/rooms/launch/recordings`)).status, 200);

  const removed = await fetch(`${base}/api/rooms/launch`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal((await fetch(`${base}/api/rooms/launch`)).status, 404);
  assert.equal((await fetch(`${base}/api/rooms/launch`, { method: 'DELETE' })).status, 404);
});

test('the recording library is exposed without leaking its index', async () => {
  const list = await (await fetch(`${base}/api/recordings`)).json();
  assert.ok(Array.isArray(list.recordings));

  assert.equal((await fetch(`${base}/api/recordings/does-not-exist`, { method: 'DELETE' })).status, 404);

  const index = await fetch(`${base}/recordings/index.json`);
  assert.equal(index.status, 404, 'the internal index is never served');

  const missing = await fetch(`${base}/recordings/nope.mkv`);
  assert.equal(missing.status, 404);
});

test('the studio UI and its shared modules are served', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Quandrite/);
  assert.match(html, /id="program-canvas"/);
  // Vite bundles the client, so the page points at a hashed entry rather than at the
  // individual modules it used to fetch: one script, one stylesheet.
  const entry = html.match(/src="([^"]+\.js)"/);
  assert.ok(entry, 'the page loads a script');
  assert.equal((await fetch(`${base}${entry[1]}`)).status, 200, `${entry[1]} is served`);
  const styles = html.match(/href="([^"]+\.css)"/);
  assert.ok(styles, 'the page loads a stylesheet');
  assert.equal((await fetch(`${base}${styles[1]}`)).status, 200, `${styles[1]} is served`);

  // Sources are never served: the browser only ever gets the bundle.
  assert.equal((await fetch(`${base}/shared/protocol.ts`)).status, 404);
  assert.equal((await fetch(`${base}/src/main.tsx`)).status, 404);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
});

test('the React app is served beside the current one while the port finishes', async () => {
  const page = await fetch(`${base}/next/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="root"/, 'the new client mounts into #root');
  // A page of that app, refreshed directly, is still that app.
  assert.equal((await fetch(`${base}/next/room/abc`)).status, 200);
});

test('a room snapshot exposes its breakout state', async () => {
  await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'split', name: 'Split room' }),
  });

  const room = await (await fetch(`${base}/api/rooms/split`)).json();
  assert.deepEqual(room.room.breakouts.rooms, []);
  assert.equal(room.room.breakouts.available, true);
  assert.equal(room.room.breakouts.max, 8);
  assert.equal(room.room.breakouts.active, false);

  // Breakout rooms are never listed as rooms of their own.
  const list = await (await fetch(`${base}/api/rooms`)).json();
  assert.equal(list.rooms.some((entry) => entry.id === 'split-b1'), false);

  await fetch(`${base}/api/rooms/split`, { method: 'DELETE' });
});

test('room creation hands the role passwords to the creator only', async () => {
  const created = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'keyed', hostPassword: 'hostpass', cohostPassword: 'cohostpass' }),
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.deepEqual(body.credentials, { hostPassword: 'hostpass', cohostPassword: 'cohostpass' });
  assert.equal(body.room.room.requiresHostPassword, true);

  const fetched = await (await fetch(`${base}/api/rooms/keyed`)).json();
  assert.ok(!JSON.stringify(fetched).includes('hostpass'), 'the snapshot never leaks the host password');
  assert.ok(!JSON.stringify(fetched).includes('cohostpass'), 'the snapshot never leaks the co-host password');

  await fetch(`${base}/api/rooms/keyed`, { method: 'DELETE' });
});
