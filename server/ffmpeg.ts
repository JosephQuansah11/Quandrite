/**
 * ffmpeg glue: encoding presets, tee (fan-out) target construction, probe and
 * remux argument builders.
 *
 * The whole multi-platform livestream strategy lives here: the program feed is
 * encoded exactly once and the `tee` muxer fans it out to every enabled RTMP
 * destination plus the local recording file.
 */

export const VIDEO_PRESETS = Object.freeze({
  '480p30': {
    label: '480p30',
    width: 854,
    height: 480,
    fps: 30,
    bitrateKbps: 1800,
    maxrateKbps: 2160,
    bufsizeKbps: 3600,
    preset: 'veryfast',
  },
  '720p30': {
    label: '720p30',
    width: 1280,
    height: 720,
    fps: 30,
    bitrateKbps: 3500,
    maxrateKbps: 4200,
    bufsizeKbps: 7000,
    preset: 'veryfast',
  },
  '720p60': {
    label: '720p60',
    width: 1280,
    height: 720,
    fps: 60,
    bitrateKbps: 4500,
    maxrateKbps: 5400,
    bufsizeKbps: 9000,
    preset: 'veryfast',
  },
  '1080p30': {
    label: '1080p30',
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 6000,
    maxrateKbps: 7200,
    bufsizeKbps: 12000,
    preset: 'veryfast',
  },
  '1080p60': {
    label: '1080p60',
    width: 1920,
    height: 1080,
    fps: 60,
    bitrateKbps: 9000,
    maxrateKbps: 10800,
    bufsizeKbps: 18000,
    preset: 'veryfast',
  },
});

export const DEFAULT_PRESET = '1080p30';

export function getPreset(name) {
  return VIDEO_PRESETS[name] || VIDEO_PRESETS[DEFAULT_PRESET];
}

export function listPresets() {
  return Object.values(VIDEO_PRESETS).map((preset) => ({ ...preset }));
}

/** Escape a path for use inside an ffmpeg `tee` muxer specification. */
export function escapeTeePath(target) {
  return String(target).replace(/([\\|:'])/g, '\\$1');
}

/** The tee muxer only accepts these two values for `onfail`. */
export const TEE_ONFAIL_VALUES = Object.freeze(['abort', 'ignore']);

export function normalizeOnfail(value) {
  return TEE_ONFAIL_VALUES.includes(value) ? value : 'ignore';
}

/**
 * Build the `-f tee` argument value.
 *
 * Each slave is described as `[f=format:onfail=...]target`. `onfail=ignore`
 * keeps one dead platform from killing the whole broadcast.
 *
 * @param {Array<{kind: 'rtmp'|'file', url?: string, path?: string, format?: string, onfail?: string}>} targets
 */
export function buildTeeSpec(targets = []) {
  return targets
    .map((target) => {
      const onfail = normalizeOnfail(target.onfail);
      if (target.kind === 'file') {
        return `[f=${target.format || 'matroska'}:onfail=${onfail}]${escapeTeePath(target.path)}`;
      }
      return `[f=flv:onfail=${onfail}]${target.url}`;
    })
    .join('|');
}

/**
 * Full ffmpeg argument list for the livestream relay.
 *
 * Input is the program feed arriving on stdin (WebM/Matroska produced by the
 * browser compositor), output is the tee fan-out.
 */
export function buildRelayArgs({
  inputFormat = 'matroska',
  preset = DEFAULT_PRESET,
  targets = [],
  audioBitrateKbps = 160,
  keyframeSeconds = 2,
}: any = {}) {
  const profile = getPreset(preset);
  const gop = Math.max(1, Math.round(profile.fps * keyframeSeconds));
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostats',
    '-f',
    inputFormat,
    '-i',
    'pipe:0',
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    profile.preset,
    '-tune',
    'zerolatency',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    `${profile.bitrateKbps}k`,
    '-maxrate',
    `${profile.maxrateKbps}k`,
    '-bufsize',
    `${profile.bufsizeKbps}k`,
    '-g',
    String(gop),
    '-keyint_min',
    String(gop),
    '-sc_threshold',
    '0',
    '-r',
    String(profile.fps),
    '-c:a',
    'aac',
    '-b:a',
    `${audioBitrateKbps}k`,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-max_muxing_queue_size',
    '1024',
    '-flush_packets',
    '1',
    '-f',
    'tee',
    buildTeeSpec(targets),
  ];
}

/** Arguments used to read container metadata (duration) without decoding. */
export function buildProbeArgs(file) {
  return ['-hide_banner', '-nostdin', '-i', file];
}

/** Stream copy remux, used to turn a crash-safe recording into an MP4. */
export function buildRemuxArgs(input, output) {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-y',
    '-i',
    input,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    output,
  ];
}

/** Parse the `Duration: HH:MM:SS.ss` line out of ffmpeg stderr. */
export function parseDurationSeconds(text) {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(text || ''));
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** Parse the last `time=HH:MM:SS.ss` progress marker out of ffmpeg stderr. */
export function parseLastTimeSeconds(text) {
  const matches = [...String(text || '').matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  if (!matches.length) return null;
  const [, hours, minutes, seconds] = matches[matches.length - 1];
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** Does this stderr tail indicate a fatal condition worth surfacing? */
export function detectRelayError(text) {
  const value = String(text || '');
  const patterns = [
    /Connection refused/i,
    /Unknown encoder/i,
    /No such file or directory/i,
    /Invalid data found/i,
    /Server error/i,
    /Immediate exit requested/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(value)) return value.split('\n').filter(Boolean).slice(-1)[0] || pattern.source;
  }
  return null;
}
