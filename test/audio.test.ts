/**
 * Audio quality: the SDP rewrite, the parameters it produces, and the constraints.
 *
 * These are the numbers both ends have to agree on, and the ones that decide whether a
 * room sounds like a studio or like a phone call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MUSIC_BITRATE_BPS,
  RELAY_OPUS_MUSIC_BITRATE_BPS,
  RELAY_OPUS_VOICE_BITRATE_BPS,
  VOICE_BITRATE_BPS,
  microphoneConstraints,
  opusParameters,
  preferOpus,
  screenAudioConstraints,
} from '../shared/audio.ts';

/** A minimal but realistic audio m-line, the way a browser offers Opus. */
const OFFER = [
  'v=0',
  'o=- 1 1 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  '',
].join('\r\n');

test('the Opus parameters a studio needs are written into the SDP', () => {
  const tuned = preferOpus(OFFER, {
    maxaveragebitrate: MUSIC_BITRATE_BPS,
    stereo: true,
    usedtx: false,
    useinbandfec: true,
  });

  // The dynamic payload type is found from the rtpmap, and only that line is rewritten.
  assert.match(tuned, /a=fmtp:111 [^\r\n]*maxaveragebitrate=128000/, 'the bitrate ceiling is raised');
  assert.match(tuned, /a=fmtp:111 [^\r\n]*stereo=1;/, 'stereo is asked for');
  assert.match(tuned, /a=fmtp:111 [^\r\n]*sprop-stereo=1;/, 'and announced, so the far end can use it');
  assert.match(tuned, /a=fmtp:111 [^\r\n]*usedtx=0;/, 'DTX is off: quiet passages are part of the sound');
  assert.match(tuned, /a=fmtp:111 [^\r\n]*useinbandfec=1;/, 'in-band FEC stays on');
  assert.match(tuned, /a=rtpmap:63 red\/48000\/2/, 'and nothing else in the SDP is touched');
  assert.equal((tuned.match(/a=fmtp:111 /g) || []).length, 1, 'there is still exactly one fmtp line');

  // The other payload type must not be rewritten by accident.
  assert.doesNotMatch(tuned, /a=fmtp:63/, 'red is left alone');
});

test('a voice connection is tuned as voice, and a screen as music', () => {
  const voice = opusParameters(preferOpus(OFFER, { maxaveragebitrate: VOICE_BITRATE_BPS, stereo: false }));
  assert.equal(voice.payloadType, 111);
  assert.equal(voice.channels, 2, 'the rtpmap says what the codec can do');
  assert.equal(voice.maxaveragebitrate, VOICE_BITRATE_BPS);
  assert.equal(voice.stereo, false, 'a microphone is mono');
  assert.equal(voice.usedtx, false);

  const music = opusParameters(
    preferOpus(OFFER, { maxaveragebitrate: MUSIC_BITRATE_BPS, stereo: true }),
  );
  assert.equal(music.stereo, true);
  assert.equal(music.maxaveragebitrate, MUSIC_BITRATE_BPS);
  assert.ok(RELAY_OPUS_MUSIC_BITRATE_BPS > RELAY_OPUS_VOICE_BITRATE_BPS, 'and music is given more room');
});

test('the Opus parameters replace what was there, and an fmtp line is created when missing', () => {
  // A browser that sends no fmtp at all still gets one, right after its rtpmap.
  const bare = OFFER.split('\r\n').filter((line) => !line.startsWith('a=fmtp:111')).join('\r\n');
  const tuned = preferOpus(bare, { maxaveragebitrate: 96000 });
  const lines = tuned.split('\r\n');
  const rtpmap = lines.findIndex((line) => line.startsWith('a=rtpmap:111'));
  assert.equal(lines[rtpmap + 1].startsWith('a=fmtp:111 '), true, 'the fmtp goes where a parser expects it');

  // ...and a parameter that was already there is overwritten rather than duplicated.
  const twice = preferOpus(preferOpus(OFFER, { maxaveragebitrate: 64000 }), { maxaveragebitrate: 128000 });
  assert.equal((twice.match(/maxaveragebitrate=/g) || []).length, 1, 'one value, not two');
  assert.match(twice, /maxaveragebitrate=128000/);
});

test('an SDP without Opus is handed back untouched', () => {
  const pcmu = 'm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=rtpmap:0 PCMU/8000\r\n';
  assert.equal(preferOpus(pcmu, { maxaveragebitrate: 128000 }), pcmu, 'no Opus, no rewrite');
  assert.equal(preferOpus('', {}), '', 'and nothing is not an error');
  assert.equal(preferOpus(null, {}), '', 'nor is null');
  assert.equal(opusParameters(pcmu), null, 'and it reports no Opus');
});

test('a microphone is processed and a shared screen is not', () => {
  const mic = microphoneConstraints('device-1');
  assert.equal(mic.deviceId.exact, 'device-1', 'the chosen device is honoured');
  assert.equal(mic.echoCancellation, true, 'a microphone gets echo cancellation');
  assert.equal(mic.noiseSuppression, true, 'and noise suppression');
  assert.equal(mic.autoGainControl, true, 'and a steady level');
  assert.equal(mic.channelCount, 1, 'a microphone is one channel');
  assert.equal(mic.sampleRate, 48000, 'at the rate the whole path runs at');

  const screen = screenAudioConstraints();
  assert.equal(screen.echoCancellation, false, 'system sound is not echo-cancelled');
  assert.equal(screen.noiseSuppression, false, 'nor is music denoised');
  assert.equal(screen.autoGainControl, false, 'nor levelled');
  assert.equal(screen.channelCount, 2, 'and stereo is kept');
  assert.deepEqual(microphoneConstraints(), microphoneConstraints(null), 'no device is the default');
});
