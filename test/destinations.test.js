import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeDestination,
  getPlatform,
  listPlatforms,
  maskIngestUrl,
  redactDestination,
  resolveIngestUrl,
  validateDestination,
  validateRtmpUrl,
} from '../shared/destinations.js';

test('the four requested platforms plus custom ingests are available', () => {
  const ids = listPlatforms().map((platform) => platform.id);
  for (const required of ['youtube', 'facebook', 'twitter', 'tiktok']) {
    assert.ok(ids.includes(required), `${required} is supported`);
  }
  assert.ok(ids.includes('custom'));
});

test('ingest urls are built from the platform base url and the stream key', () => {
  assert.deepEqual(resolveIngestUrl({ platform: 'youtube', streamKey: 'abcd-1234' }), {
    ok: true,
    url: 'rtmp://a.rtmp.youtube.com/live2/abcd-1234',
  });
  assert.equal(
    resolveIngestUrl({ platform: 'facebook', streamKey: 'key/1' }).url,
    'rtmps://live-api-s.facebook.com:443/rtmp/key/1',
  );
  assert.equal(
    resolveIngestUrl({ platform: 'tiktok', streamKey: 'tk' }).url,
    'rtmps://push-rtmp-l1-va01.tiktokcdn.com:443/live/tk',
  );
});

test('a regional url override replaces the built-in base url', () => {
  const result = resolveIngestUrl({
    platform: 'tiktok',
    streamKey: 'tk',
    overrideUrl: 'rtmps://push-rtmp-l2-eu01.tiktokcdn.com:443/live',
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'rtmps://push-rtmp-l2-eu01.tiktokcdn.com:443/live/tk');
});

test('unknown platforms and missing keys are rejected', () => {
  assert.equal(resolveIngestUrl({ platform: 'nope', streamKey: 'x' }).ok, false);
  assert.match(resolveIngestUrl({ platform: 'youtube', streamKey: '' }).error, /stream key/);
  assert.match(resolveIngestUrl({ platform: 'custom' }).error, /requires a full ingest URL/);
});

test('rtmp url validation', () => {
  assert.equal(validateRtmpUrl('rtmp://host/app/key').ok, true);
  assert.equal(validateRtmpUrl('rtmps://host:443/app/key').ok, true);
  assert.match(validateRtmpUrl('https://host/app/key').error, /rtmp/);
  assert.match(validateRtmpUrl('rtmp://host').error, /application path/);
  assert.match(validateRtmpUrl('rtmp://host/app/ke y').error, /whitespace/);
});

test('validateDestination returns a normalised destination', () => {
  const ok = validateDestination({ platform: 'YouTube', streamKey: ' abc ', label: 'Main' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.platform, 'youtube');
  assert.equal(ok.value.url, 'rtmp://a.rtmp.youtube.com/live2/abc');
  assert.equal(ok.value.label, 'Main');
  assert.equal(ok.value.enabled, true);
  assert.equal(ok.value.recommendedBitrateKbps, 6000);

  const bad = validateDestination({ platform: 'youtube' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);

  const custom = validateDestination({ platform: 'custom', overrideUrl: 'rtmp://10.0.0.5/live/x' });
  assert.equal(custom.ok, true);
  assert.equal(custom.value.url, 'rtmp://10.0.0.5/live/x');
});

test('stream keys are masked before they leave the server', () => {
  const masked = maskIngestUrl('rtmp://a.rtmp.youtube.com/live2/secret-key-1234');
  assert.ok(!masked.includes('secret'));
  assert.match(masked, /\*{4,}1234$/);

  const redacted = redactDestination({
    platform: 'youtube',
    url: 'rtmp://a.rtmp.youtube.com/live2/secret-key-1234',
    streamKey: 'secret-key-1234',
    label: 'Main',
  });
  assert.equal(redacted.streamKey, undefined);
  assert.equal(redacted.hasStreamKey, true);
  assert.ok(!JSON.stringify(redacted).includes('secret'));

  assert.equal(getPlatform('youtube').name, 'YouTube Live');
  assert.match(describeDestination({ platform: 'youtube', label: 'Main', url: 'rtmp://a/b/secret-key' }), /Main/);
});
