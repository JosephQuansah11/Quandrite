import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VIDEO_PRESETS,
  buildProbeArgs,
  buildRelayArgs,
  buildRemuxArgs,
  buildTeeSpec,
  detectRelayError,
  escapeTeePath,
  getPreset,
  listPresets,
  normalizeOnfail,
  parseDurationSeconds,
  parseLastTimeSeconds,
} from '../server/ffmpeg.js';

test('presets cover the resolutions a streamer needs', () => {
  assert.deepEqual(Object.keys(VIDEO_PRESETS), ['480p30', '720p30', '720p60', '1080p30', '1080p60']);
  assert.equal(getPreset('1080p60').fps, 60);
  assert.equal(getPreset('nonsense').label, '1080p30', 'unknown presets fall back to the default');
  assert.equal(listPresets().length, 5);
});

test('tee spec fans out to every rtmp target plus the recording file', () => {
  const spec = buildTeeSpec([
    { kind: 'rtmp', url: 'rtmp://a.example/app/key1' },
    { kind: 'rtmp', url: 'rtmps://b.example:443/rtmp/key2' },
    { kind: 'file', path: '/tmp/rec one.mkv', format: 'matroska' },
  ]);
  const parts = spec.split('|');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], '[f=flv:onfail=ignore]rtmp://a.example/app/key1');
  assert.equal(parts[1], '[f=flv:onfail=ignore]rtmps://b.example:443/rtmp/key2');
  assert.ok(parts[2].startsWith('[f=matroska:onfail=ignore]'));
  assert.ok(parts[2].includes('rec one'), 'the space in the path is preserved');
});

test('only the onfail values the tee muxer understands are emitted', () => {
  // ffmpeg aborts the whole fan-out on an unknown value, so never emit one.
  assert.equal(normalizeOnfail('warn'), 'ignore');
  assert.equal(normalizeOnfail(undefined), 'ignore');
  assert.equal(normalizeOnfail('abort'), 'abort');
  assert.equal(normalizeOnfail('ignore'), 'ignore');
  const spec = buildTeeSpec([{ kind: 'file', path: '/tmp/a.mkv', format: 'matroska', onfail: 'warn' }]);
  assert.equal(spec, '[f=matroska:onfail=ignore]/tmp/a.mkv');
  assert.ok(!/onfail=warn/.test(buildRelayArgs({ targets: [{ kind: 'rtmp', url: 'rtmp://a/b/c', onfail: 'nonsense' }] }).join(' ')));
});

test('tee paths escape muxer separators', () => {
  assert.equal(escapeTeePath('/tmp/a|b:c'), '/tmp/a\\|b\\:c');
});

test('relay args encode once and tee to the targets', () => {
  const args = buildRelayArgs({
    preset: '1080p30',
    targets: [
      { kind: 'rtmp', url: 'rtmp://a.example/app/key' },
      { kind: 'file', path: '/tmp/out.mkv', format: 'matroska' },
    ],
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('-f matroska -i pipe:0'), 'reads the program feed from stdin');
  assert.ok(joined.includes('-map 0:v:0 -map 0:a:0?'), 'maps video and optional audio');
  assert.ok(joined.includes('-c:v libx264'));
  assert.ok(joined.includes('-c:a aac'));
  assert.ok(joined.includes('-b:v 6000k'), 'uses the preset bitrate');
  assert.ok(joined.includes('-g 60'), '2 second keyframe interval at 30fps');
  assert.ok(joined.includes('-sc_threshold 0'));
  assert.equal(args.at(-3), '-f', 'the output format comes last');
  assert.equal(args.at(-2), 'tee', 'the last output is the tee muxer');
  assert.match(args.at(-1), /^\[f=flv:onfail=ignore\]rtmp:\/\//);
  assert.equal(args.filter((arg) => arg === '-i').length, 1, 'exactly one input = a single encode');
});

test('relay args respect a different preset and audio bitrate', () => {
  const args = buildRelayArgs({
    preset: '720p60',
    audioBitrateKbps: 128,
    targets: [{ kind: 'rtmp', url: 'rtmp://a/b/c' }],
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('-b:v 4500k'));
  assert.ok(joined.includes('-r 60'));
  assert.ok(joined.includes('-g 120'));
  assert.ok(joined.includes('-b:a 128k'));
});

test('probe and remux argument builders', () => {
  assert.deepEqual(buildProbeArgs('/tmp/a.mkv'), ['-hide_banner', '-nostdin', '-i', '/tmp/a.mkv']);
  const remux = buildRemuxArgs('/tmp/a.mkv', '/tmp/a.mp4');
  assert.deepEqual(remux.slice(-5), ['-c', 'copy', '-movflags', '+faststart', '/tmp/a.mp4']);
});

test('ffmpeg stderr parsing', () => {
  const banner = 'Input #0, matroska,webm, from \'a.mkv\':\n  Duration: 00:01:23.45, start: 0.000000, bitrate: 1200 kb/s';
  assert.equal(parseDurationSeconds(banner), 83.45);
  assert.equal(parseDurationSeconds('no duration here'), null);

  const progress = 'frame= 120 fps=30 time=00:00:04.00 bitrate=1000kbits/s\nframe= 300 time=00:00:10.00';
  assert.equal(parseLastTimeSeconds(progress), 10);

  assert.match(detectRelayError('rtmp://host: Connection refused'), /Connection refused/);
  assert.equal(detectRelayError('everything is fine'), null);
});
