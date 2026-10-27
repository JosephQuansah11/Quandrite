/**
 * Multi-platform livestream destination catalogue.
 *
 * Quandrite pushes one encoded program feed to every enabled destination at
 * once (ffmpeg `tee` muxer), so this module owns the per-platform ingest URL
 * shapes plus the validation used by both the REST API and the browser form.
 *
 * RTMP ingest endpoints are provider controlled and occasionally change; every
 * entry therefore also accepts a full URL override so an operator can point at
 * a rotated/regional endpoint without a code change.
 */

export const PLATFORMS = Object.freeze([
  {
    id: 'youtube',
    name: 'YouTube Live',
    scheme: 'rtmp',
    baseUrl: 'rtmp://a.rtmp.youtube.com/live2',
    keyLabel: 'Stream key',
    keyHelp: 'YouTube Studio > Go Live > Stream key',
    recommendedBitrateKbps: 6000,
    maxBitrateKbps: 12000,
    urlOverrideAllowed: true,
  },
  {
    id: 'facebook',
    name: 'Facebook Live',
    scheme: 'rtmps',
    baseUrl: 'rtmps://live-api-s.facebook.com:443/rtmp',
    keyLabel: 'Persistent stream key',
    keyHelp: 'Facebook Live Producer > Stream key',
    recommendedBitrateKbps: 4000,
    maxBitrateKbps: 8000,
    urlOverrideAllowed: true,
  },
  {
    id: 'twitter',
    name: 'X / Twitter',
    scheme: 'rtmps',
    baseUrl: 'rtmps://faire1.pscp.tv:443/x',
    keyLabel: 'Stream key',
    keyHelp: 'X Media Studio > Producer > Stream key',
    recommendedBitrateKbps: 4000,
    maxBitrateKbps: 8000,
    urlOverrideAllowed: true,
  },
  {
    id: 'tiktok',
    name: 'TikTok Live',
    scheme: 'rtmps',
    baseUrl: 'rtmps://push-rtmp-l1-va01.tiktokcdn.com:443/live',
    keyLabel: 'Stream key',
    keyHelp: 'TikTok LIVE Studio > Stream key (regional endpoints vary - use the URL override if yours differs)',
    recommendedBitrateKbps: 3500,
    maxBitrateKbps: 6000,
    urlOverrideAllowed: true,
  },
  {
    id: 'twitch',
    name: 'Twitch',
    scheme: 'rtmp',
    baseUrl: 'rtmp://live.twitch.tv/app',
    keyLabel: 'Stream key',
    keyHelp: 'Twitch Dashboard > Settings > Stream',
    recommendedBitrateKbps: 6000,
    maxBitrateKbps: 8500,
    urlOverrideAllowed: true,
  },
  {
    id: 'custom',
    name: 'Custom RTMP / RTMPS',
    scheme: 'rtmp',
    baseUrl: '',
    keyLabel: 'Stream key (optional)',
    keyHelp: 'Any RTMP(S) ingest, for example your own media server',
    recommendedBitrateKbps: 4000,
    maxBitrateKbps: 20000,
    urlOverrideAllowed: true,
    requiresOverrideUrl: true,
  },
]);

const PLATFORM_BY_ID = new Map(PLATFORMS.map((platform) => [platform.id, platform]));

export function getPlatform(platformId) {
  return PLATFORM_BY_ID.get(platformId) || null;
}

export function listPlatforms() {
  return PLATFORMS.map((platform) => ({ ...platform }));
}

function joinUrl(baseUrl, streamKey) {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedKey = String(streamKey).replace(/^\/+/, '').trim();
  return trimmedKey ? `${trimmedBase}/${trimmedKey}` : trimmedBase;
}

/** @returns {{ok: true, url: string} | {ok: false, error: string}} */
export function validateRtmpUrl(url) {
  const value = String(url || '').trim();
  if (!value) return { ok: false, error: 'ingest URL is required' };
  if (/\s/.test(value)) return { ok: false, error: 'ingest URL must not contain whitespace' };
  if (!/^rtmps?:\/\//i.test(value)) {
    return { ok: false, error: 'ingest URL must start with rtmp:// or rtmps://' };
  }
  const rest = value.replace(/^rtmps?:\/\//i, '');
  const slash = rest.indexOf('/');
  if (slash <= 0 || rest.slice(slash + 1).length === 0) {
    return { ok: false, error: 'ingest URL must include a host and an application path' };
  }
  if (value.length > 1024) return { ok: false, error: 'ingest URL is too long' };
  return { ok: true, url: value };
}

/**
 * Build the concrete RTMP(S) URL ffmpeg should connect to.
 * @returns {{ok: true, url: string} | {ok: false, error: string}}
 */
export function resolveIngestUrl({ platform, streamKey = '', overrideUrl = '' }: any = {}) {
  const preset = getPlatform(platform);
  if (!preset) return { ok: false, error: `unknown platform: ${platform}` };

  const override = String(overrideUrl || '').trim();
  if (override) {
    const checked = validateRtmpUrl(override);
    if (!checked.ok) return checked;
    if (preset.id === 'custom') return { ok: true, url: override };
    return { ok: true, url: joinUrl(override, streamKey) };
  }

  if (!preset.baseUrl) {
    return { ok: false, error: `${preset.name} requires a full ingest URL` };
  }
  const key = String(streamKey || '').trim();
  if (!key) return { ok: false, error: `${preset.name} requires a stream key` };
  return { ok: true, url: joinUrl(preset.baseUrl, key) };
}

/**
 * Validate a destination as supplied by a client.
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
export function validateDestination(input: any = {}) {
  const errors = [];
  const platform = String(input.platform || '').trim().toLowerCase();
  const preset = getPlatform(platform);
  if (!preset) errors.push(`unknown platform: ${input.platform}`);

  const streamKey = String(input.streamKey ?? '').trim();
  const overrideUrl = String(input.overrideUrl ?? '').trim();
  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
  const label = String(input.label ?? '').trim().slice(0, 80);

  let url = '';
  if (!errors.length) {
    if (preset.requiresOverrideUrl && !overrideUrl) {
      errors.push(`${preset.name} requires a full ingest URL`);
    } else {
      const resolved: any = resolveIngestUrl({ platform, streamKey, overrideUrl });
      if (!resolved.ok) errors.push(resolved.error);
      else url = resolved.url;
    }
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      platform,
      label: label || preset.name,
      streamKey,
      overrideUrl,
      enabled,
      url,
      scheme: preset.scheme,
      recommendedBitrateKbps: preset.recommendedBitrateKbps,
    },
  };
}

/** Mask the secret part of an ingest URL so it is safe to log. */
export function maskIngestUrl(url) {
  const value = String(url || '');
  const match = /^(rtmps?:\/\/[^/]+\/[^/]*\/)(.+)$/i.exec(value);
  if (!match) return value;
  const secret = match[2];
  if (secret.length <= 4) return `${match[1]}${'*'.repeat(secret.length)}`;
  return `${match[1]}${'*'.repeat(Math.max(4, secret.length - 4))}${secret.slice(-4)}`;
}

/** Strip secrets from a destination before it leaves the server. */
export function redactDestination(destination) {
  if (!destination) return destination;
  const { url, streamKey, ...rest } = destination;
  return {
    ...rest,
    url: maskIngestUrl(url),
    hasStreamKey: Boolean(streamKey),
  };
}

/** Human readable one-liner used by the UI and the logs. */
export function describeDestination(destination) {
  const preset = getPlatform(destination?.platform);
  const name = destination?.label || preset?.name || destination?.platform || 'unknown';
  return `${name} (${maskIngestUrl(destination?.url)})`;
}
