import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../server/index.js';
import { loadConfig } from '../server/config.js';

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
  assert.match(html, /js\/app\.js/);

  for (const asset of ['/styles.css', '/js/app.js', '/js/compositor.js', '/shared/protocol.js', '/shared/overlays.js', '/shared/destinations.js', '/shared/layout.js']) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200, `${asset} is served`);
  }

  const protocol = await (await fetch(`${base}/shared/protocol.js`)).text();
  assert.match(protocol, /SCENE_TYPES/);

  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
});
