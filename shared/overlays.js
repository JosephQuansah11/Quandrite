/**
 * Livestream overlay / scene catalogue.
 *
 * A "scene" is the overlay currently pushed onto the program preview. The same
 * pure functions drive the browser canvas compositor and the server side state
 * machine, so what the host previews is exactly what is encoded to the
 * platforms.
 *
 * Supported scenes: title, announcement, screenshare, song, break, ended.
 */

export const OVERLAY_DEFINITIONS = Object.freeze({
  title: {
    label: 'Title',
    description: 'Lower-third headline and subtitle',
    defaultDurationMs: 8000,
    persistent: false,
    blocksProgram: false,
    accent: '#38bdf8',
  },
  announcement: {
    label: 'Announcement',
    description: 'Banner across the top of the picture',
    defaultDurationMs: 12000,
    persistent: false,
    blocksProgram: false,
    accent: '#2563eb',
  },
  screenshare: {
    label: 'Screen share',
    description: 'Put a shared screen on the program output',
    defaultDurationMs: 0,
    persistent: true,
    blocksProgram: false,
    accent: '#22d3ee',
  },
  song: {
    label: 'Song',
    description: 'Now playing card with artwork and artist',
    defaultDurationMs: 0,
    persistent: true,
    blocksProgram: false,
    accent: '#a855f7',
  },
  break: {
    label: 'Break',
    description: 'Full screen break card with optional countdown',
    defaultDurationMs: 0,
    persistent: true,
    blocksProgram: true,
    accent: '#f59e0b',
  },
  ended: {
    label: 'End of livestream',
    description: 'Full screen sign-off card',
    defaultDurationMs: 0,
    persistent: true,
    blocksProgram: true,
    accent: '#ef4444',
  },
});

export const REQUESTABLE_OVERLAY_TYPES = Object.freeze(Object.keys(OVERLAY_DEFINITIONS));

const TITLE_POSITIONS = Object.freeze(['lower-third', 'top', 'center']);
const ANNOUNCEMENT_PRIORITIES = Object.freeze(['normal', 'high']);
const MAX_TEXT = 400;

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanMultiline(value, max = MAX_TEXT) {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, max);
}

function clampDuration(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.round(number), 12 * 60 * 60 * 1000);
}

/**
 * Validate + normalise an overlay request.
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
export function validateOverlay(input = {}) {
  const type = String(input.type || '').trim().toLowerCase();
  const definition = OVERLAY_DEFINITIONS[type];
  if (!definition) {
    return { ok: false, errors: [`unknown overlay type: ${input.type}`] };
  }

  const raw = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const errors = [];
  const payload = {};

  switch (type) {
    case 'title': {
      payload.headline = cleanText(raw.headline, 120);
      payload.subtitle = cleanText(raw.subtitle, 180);
      payload.position = TITLE_POSITIONS.includes(raw.position) ? raw.position : 'lower-third';
      payload.accent = /^#[0-9a-f]{6}$/i.test(raw.accent || '') ? raw.accent : definition.accent;
      if (!payload.headline) errors.push('title.headline is required');
      break;
    }
    case 'announcement': {
      payload.message = cleanText(raw.message, 240);
      payload.priority = ANNOUNCEMENT_PRIORITIES.includes(raw.priority) ? raw.priority : 'normal';
      if (!payload.message) errors.push('announcement.message is required');
      break;
    }
    case 'screenshare': {
      payload.sourceId = cleanText(raw.sourceId, 80) || null;
      payload.caption = cleanText(raw.caption, 120);
      break;
    }
    case 'song': {
      payload.title = cleanText(raw.title, 140);
      payload.artist = cleanText(raw.artist, 140);
      payload.artworkUrl = cleanText(raw.artworkUrl, 512);
      payload.lyrics = cleanMultiline(raw.lyrics, 400);
      if (!payload.title) errors.push('song.title is required');
      if (payload.artworkUrl && !/^(https?:|data:image\/)/i.test(payload.artworkUrl)) {
        errors.push('song.artworkUrl must be an http(s) or data:image URL');
      }
      break;
    }
    case 'break': {
      payload.message = cleanText(raw.message, 200) || 'We are right back.';
      payload.countdownMs = Math.min(
        Math.max(0, Math.round(Number(raw.countdownMs) || 0)),
        12 * 60 * 60 * 1000,
      );
      break;
    }
    case 'ended': {
      payload.headline = cleanText(raw.headline, 120) || 'Thanks for watching';
      payload.message = cleanText(raw.message, 240) || 'This livestream has ended.';
      payload.showReplay = raw.showReplay === undefined ? true : Boolean(raw.showReplay);
      break;
    }
    default:
      break;
  }

  if (errors.length) return { ok: false, errors };

  const persistentRequested = input.persistent === true || raw.persistent === true;
  const durationMs = persistentRequested
    ? 0
    : clampDuration(input.durationMs ?? raw.durationMs, definition.defaultDurationMs);

  return {
    ok: true,
    value: {
      type,
      payload,
      durationMs,
      persistent: durationMs === 0,
      blocksProgram: definition.blocksProgram,
    },
  };
}

let overlayCounter = 0;

/**
 * Create the scene object stored on the studio.
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
export function createOverlay(input = {}, { now = Date.now(), idFactory } = {}) {
  const validated = validateOverlay(input);
  if (!validated.ok) return validated;
  const { type, payload, durationMs, persistent, blocksProgram } = validated.value;
  overlayCounter += 1;
  const id = idFactory ? idFactory() : `${type}-${now.toString(36)}-${overlayCounter.toString(36)}`;
  return {
    ok: true,
    value: {
      id,
      type,
      payload,
      durationMs,
      persistent,
      blocksProgram,
      createdAt: now,
      expiresAt: persistent ? null : now + durationMs,
      createdBy: input.createdBy ? String(input.createdBy) : null,
    },
  };
}

/** Soft word wrap used by the canvas compositor for long overlay text. */
export function wrapText(value, maxChars = 32) {
  const limit = Math.max(1, Math.floor(maxChars));
  const words = String(value ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= limit) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Format a millisecond countdown as MM:SS (or H:MM:SS when long). */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

const rect = (x, y, w, h, fill, extra = {}) => ({
  kind: 'rect',
  x: Math.round(x),
  y: Math.round(y),
  w: Math.round(w),
  h: Math.round(h),
  fill,
  ...extra,
});

const text = (x, y, value, extra = {}) => ({
  kind: 'text',
  x: Math.round(x),
  y: Math.round(y),
  text: String(value ?? ''),
  ...extra,
});

function drawTitle(payload, W, H) {
  const boxW = W * 0.62;
  const boxH = H * 0.16;
  const x = W * 0.06;
  let y = H * 0.72;
  if (payload.position === 'top') y = H * 0.06;
  if (payload.position === 'center') y = (H - boxH) / 2;
  return [
    rect(x, y, boxW, boxH, 'rgba(6,10,22,0.82)', {
      radius: H * 0.018,
      stroke: 'rgba(255,255,255,0.08)',
    }),
    rect(x, y, H * 0.012, boxH, payload.accent || OVERLAY_DEFINITIONS.title.accent),
    text(x + H * 0.035, y + boxH * 0.42, payload.headline, {
      size: H * 0.055,
      weight: 700,
      color: '#f8fafc',
      align: 'left',
      baseline: 'middle',
      maxWidth: boxW - H * 0.08,
    }),
    ...(payload.subtitle
      ? [
          text(x + H * 0.035, y + boxH * 0.74, payload.subtitle, {
            size: H * 0.028,
            weight: 400,
            color: '#c7d2fe',
            align: 'left',
            baseline: 'middle',
            maxWidth: boxW - H * 0.08,
          }),
        ]
      : []),
  ];
}

function drawAnnouncement(payload, W, H) {
  const bannerH = H * 0.11;
  const high = payload.priority === 'high';
  return [
    rect(0, 0, W, bannerH, high ? 'rgba(220,38,38,0.92)' : 'rgba(37,99,235,0.92)'),
    text(W / 2, bannerH / 2, payload.message, {
      size: H * 0.04,
      weight: 600,
      color: '#ffffff',
      align: 'center',
      baseline: 'middle',
      maxWidth: W * 0.9,
    }),
  ];
}

function drawScreenshare(payload, W, H) {
  const pad = H * 0.03;
  const badgeH = H * 0.06;
  const badgeW = W * 0.22;
  return [
    rect(pad, pad, badgeW, badgeH, 'rgba(8,145,178,0.9)', { radius: badgeH / 2 }),
    text(pad + badgeW / 2, pad + badgeH / 2, payload.caption || 'SCREEN SHARE', {
      size: H * 0.028,
      weight: 700,
      color: '#ecfeff',
      align: 'center',
      baseline: 'middle',
      maxWidth: badgeW * 0.9,
    }),
  ];
}

function drawSong(payload, W, H) {
  const cardW = W * 0.46;
  const cardH = H * 0.26;
  const x = W * 0.05;
  const y = H - cardH - H * 0.08;
  const art = cardH * 0.68;
  const ax = x + cardH * 0.16;
  const ay = y + (cardH - art) / 2;
  const ops = [
    rect(x, y, cardW, cardH, 'rgba(9,12,28,0.88)', {
      radius: H * 0.022,
      stroke: 'rgba(168,85,247,0.35)',
    }),
  ];

  if (payload.artworkUrl) {
    ops.push({
      kind: 'image',
      x: Math.round(ax),
      y: Math.round(ay),
      w: Math.round(art),
      h: Math.round(art),
      src: payload.artworkUrl,
      radius: H * 0.012,
    });
  } else {
    ops.push(rect(ax, ay, art, art, 'rgba(168,85,247,0.25)', { radius: H * 0.012 }));
    ops.push(
      text(ax + art / 2, ay + art / 2, '\u266b', {
        size: art * 0.5,
        weight: 700,
        color: '#e9d5ff',
        align: 'center',
        baseline: 'middle',
      }),
    );
  }

  const tx = ax + art + H * 0.03;
  const maxWidth = x + cardW - tx - H * 0.03;
  ops.push(
    text(tx, y + cardH * 0.26, 'NOW PLAYING', {
      size: H * 0.024,
      weight: 700,
      color: '#c084fc',
      align: 'left',
      baseline: 'middle',
      maxWidth,
    }),
    text(tx, y + cardH * 0.5, payload.title, {
      size: H * 0.036,
      weight: 700,
      color: '#f8fafc',
      align: 'left',
      baseline: 'middle',
      maxWidth,
    }),
  );

  if (payload.artist) {
    ops.push(
      text(tx, y + cardH * 0.7, payload.artist, {
        size: H * 0.026,
        weight: 400,
        color: '#94a3b8',
        align: 'left',
        baseline: 'middle',
        maxWidth,
      }),
    );
  }
  if (payload.lyrics) {
    ops.push(
      text(tx, y + cardH * 0.88, payload.lyrics.split('\n')[0], {
        size: H * 0.022,
        weight: 400,
        color: '#a5b4fc',
        align: 'left',
        baseline: 'middle',
        maxWidth,
      }),
    );
  }
  return ops;
}

function drawBreak(payload, W, H) {
  const ops = [
    rect(0, 0, W, H, 'rgba(2,6,23,0.94)'),
    rect(0, H * 0.435, W, H * 0.006, OVERLAY_DEFINITIONS.break.accent),
    text(W / 2, H * 0.4, 'ON A SHORT BREAK', {
      size: H * 0.075,
      weight: 800,
      color: '#fbbf24',
      align: 'center',
      baseline: 'middle',
      maxWidth: W * 0.9,
    }),
    text(W / 2, H * 0.54, payload.message, {
      size: H * 0.036,
      weight: 400,
      color: '#e2e8f0',
      align: 'center',
      baseline: 'middle',
      maxWidth: W * 0.8,
    }),
  ];
  if (payload.countdownMs > 0) {
    ops.push(
      text(W / 2, H * 0.66, formatCountdown(payload.countdownMs), {
        size: H * 0.05,
        weight: 700,
        color: '#f8fafc',
        align: 'center',
        baseline: 'middle',
      }),
    );
  }
  return ops;
}

function drawEnded(payload, W, H) {
  const ops = [
    rect(0, 0, W, H, '#05070f'),
    text(W / 2, H * 0.44, payload.headline, {
      size: H * 0.08,
      weight: 800,
      color: '#f8fafc',
      align: 'center',
      baseline: 'middle',
      maxWidth: W * 0.85,
    }),
    text(W / 2, H * 0.57, payload.message, {
      size: H * 0.034,
      weight: 400,
      color: '#cbd5f5',
      align: 'center',
      baseline: 'middle',
      maxWidth: W * 0.8,
    }),
  ];
  if (payload.showReplay) {
    ops.push(
      text(W / 2, H * 0.67, 'The replay will be available shortly.', {
        size: H * 0.028,
        weight: 400,
        color: '#64748b',
        align: 'center',
        baseline: 'middle',
      }),
    );
  }
  return ops;
}

const DRAWERS = Object.freeze({
  title: drawTitle,
  announcement: drawAnnouncement,
  screenshare: drawScreenshare,
  song: drawSong,
  break: drawBreak,
  ended: drawEnded,
});

/**
 * Convert a scene into resolution independent drawing instructions.
 *
 * The browser compositor executes these ops on its canvas, while the server
 * uses `blocksProgram` to know whether camera / screen pixels are still
 * visible underneath the overlay.
 */
export function overlayDrawModel(scene, { width, height } = {}) {
  const W = Math.max(1, Math.round(width || 1280));
  const H = Math.max(1, Math.round(height || 720));
  const definition = scene ? OVERLAY_DEFINITIONS[scene.type] : null;
  const drawer = scene ? DRAWERS[scene.type] : null;
  if (!scene || !definition || !drawer) {
    return { type: 'idle', blocksProgram: false, ops: [] };
  }
  return {
    type: scene.type,
    blocksProgram: Boolean(definition.blocksProgram),
    ops: drawer(scene.payload || {}, W, H),
  };
}
