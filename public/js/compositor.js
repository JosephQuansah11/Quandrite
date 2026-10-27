/**
 * Program compositor.
 *
 * Draws the picture that actually goes out: the selected camera, a grid of all
 * cameras, or a screen share - with the current overlay scene (title,
 * announcement, song, break, end card) on top, plus LIVE/REC badges. It also
 * mixes every source's audio into one program audio track.
 */

import { overlayDrawModel, wrapText } from '/shared/overlays.js';
import { computeProgramLayout, resolveProgramSources } from '/shared/layout.js';

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

export class ProgramCompositor {
  constructor({ canvas, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, fps = 30 } = {}) {
    if (!canvas) throw new Error('ProgramCompositor needs a canvas');
    this.canvas = canvas;
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = canvas.getContext('2d');
    this.fps = fps;
    this.width = width;
    this.height = height;

    this.sources = [];
    this.program = { mode: 'single', sourceId: null, gridIds: [], onAir: [] };
    this.scene = null;
    this.badges = { live: false, recording: false, label: 'Quandrite', clock: true };

    this.canvasStream = null;
    this.videoTrack = null;
    this.audioContext = null;
    this.audioDestination = null;
    this._audioNodes = new Map();
    this._music = null;
    this._images = new Map();
    this._running = false;
    this._rafId = null;
    this._lastFrame = 0;
    this.frameInterval = 1000 / fps;
  }

  setSources(sources = []) {
    this.sources = sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      label: source.label,
      stream: source.stream,
      video: source.video,
      meta: source.meta || {},
    }));
    this._syncAudioGraph();
  }

  setProgram(program = {}) {
    this.program = {
      mode: program.mode || 'single',
      sourceId: program.sourceId ?? null,
      gridIds: Array.isArray(program.gridIds) ? program.gridIds : [],
      onAir: Array.isArray(program.onAir) ? program.onAir : [],
    };
  }

  setScene(scene) {
    this.scene = scene || null;
  }

  setBadges(badges = {}) {
    this.badges = { ...this.badges, ...badges };
  }

  /** Sources currently on the air, in draw order (same rule the server uses). */
  activeSources() {
    return resolveProgramSources({ sources: this.sources, program: this.program });
  }

  start() {
    if (this._running) return this;
    this._running = true;
    this._ensureAudio();
    this.canvasStream = this.canvas.captureStream(this.fps);
    this.videoTrack = this.canvasStream.getVideoTracks()[0] || null;
    const loop = (timestamp) => {
      if (!this._running) return;
      this._rafId = requestAnimationFrame(loop);
      if (timestamp - this._lastFrame < this.frameInterval) return;
      this._lastFrame = timestamp;
      this.draw();
    };
    this._rafId = requestAnimationFrame(loop);
    return this;
  }

  stop() {
    this._running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this.videoTrack) {
      try {
        this.videoTrack.stop();
      } catch {
        // ignore
      }
      this.videoTrack = null;
    }
    this.canvasStream = null;
  }

  /** The stream handed to the publisher: canvas video + mixed program audio. */
  programStream() {
    if (!this.canvasStream) this.start();
    const tracks = [];
    if (this.videoTrack) tracks.push(this.videoTrack);
    const audioTracks = this.audioDestination?.stream?.getAudioTracks?.() || [];
    tracks.push(...audioTracks);
    return new MediaStream(tracks);
  }

  _ensureAudio() {
    if (this.audioContext) return this.audioContext;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    this.audioContext = new Ctor();
    this.audioDestination = this.audioContext.createMediaStreamDestination();
    return this.audioContext;
  }

  /**
   * Browsers start audio contexts suspended until a user gesture; call this from
   * a click handler so program audio is actually captured.
   */
  resumeAudio() {
    const context = this._ensureAudio();
    if (!context) return false;
    if (context.state === 'suspended' && typeof context.resume === 'function') {
      context.resume().catch(() => {});
    }
    return true;
  }

  /** Keep the audio mixer in sync with the current source list. */
  _syncAudioGraph() {
    const context = this._ensureAudio();
    if (!context) return;

    const liveIds = new Set(this.sources.map((source) => source.id));
    for (const [id, entry] of this._audioNodes) {
      if (!liveIds.has(id)) {
        try {
          entry.node.disconnect();
          entry.gain.disconnect();
        } catch {
          // already detached
        }
        this._audioNodes.delete(id);
      }
    }

    for (const source of this.sources) {
      if (this._audioNodes.has(source.id)) continue;
      const audioTracks = source.stream?.getAudioTracks?.() || [];
      if (!audioTracks.length) continue;
      try {
        const node = context.createMediaStreamSource(source.stream);
        const gain = context.createGain();
        gain.gain.value = 1;
        node.connect(gain);
        gain.connect(this.audioDestination);
        this._audioNodes.set(source.id, { node, gain });
      } catch {
        // a source without usable audio is fine
      }
    }
  }

  /** Mute or unmute one source's contribution to the program audio. */
  setSourceAudioEnabled(id, enabled) {
    const entry = this._audioNodes.get(id);
    if (entry) entry.gain.gain.value = enabled ? 1 : 0;
  }

  /** Route a music element (used by the Song scene) into the program audio. */
  attachMusic(audioElement, { gain = 0.85 } = {}) {
    const context = this._ensureAudio();
    if (!context || !audioElement) return false;
    this.detachMusic();
    try {
      const node = context.createMediaElementSource(audioElement);
      const gainNode = context.createGain();
      gainNode.gain.value = gain;
      node.connect(gainNode);
      gainNode.connect(this.audioDestination);
      gainNode.connect(context.destination);
      this._music = { node, gain: gainNode };
      return true;
    } catch {
      return false;
    }
  }

  detachMusic() {
    if (!this._music) return;
    try {
      this._music.node.disconnect();
      this._music.gain.disconnect();
    } catch {
      // already detached
    }
    this._music = null;
  }

  // --------------------------------------------------------------- drawing

  draw() {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#04070f';
    ctx.fillRect(0, 0, W, H);

    const model = overlayDrawModel(this.scene, { width: W, height: H });
    if (!model.blocksProgram) this._drawSources(ctx, W, H);
    this._drawOps(ctx, model.ops);
    this._drawBadges(ctx, W, H);
    ctx.restore();
  }

  _drawSources(ctx, W, H) {
    const sources = this.activeSources().filter((source) => source.kind !== 'audio');
    if (sources.length === 0) {
      this._drawPlaceholder(ctx, W, H);
      return;
    }
    const layout = computeProgramLayout({
      mode: this.program.mode,
      sourceCount: sources.length,
      width: W,
      height: H,
      gap: Math.round(H * 0.008),
    });
    sources.forEach((source, index) => {
      const rect = layout[index];
      if (rect) this._drawTile(ctx, source, rect, W, H);
    });
  }

  _drawPlaceholder(ctx, W, H) {
    const gradient = ctx.createLinearGradient(0, 0, W, H);
    gradient.addColorStop(0, '#0a1226');
    gradient.addColorStop(1, '#050810');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(H * 0.04)}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillText('Add a camera or share your screen', W / 2, H / 2);
  }

  _drawTile(ctx, source, rect, W, H) {
    const video = source.video;
    ctx.save();
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, Math.round(H * 0.008));
    ctx.clip();
    ctx.fillStyle = '#05080f';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    const ready = video && video.readyState >= 2 && video.videoWidth > 0;
    if (ready) {
      const scale = Math.max(rect.w / video.videoWidth, rect.h / video.videoHeight);
      const drawW = video.videoWidth * scale;
      const drawH = video.videoHeight * scale;
      try {
        ctx.drawImage(video, rect.x + (rect.w - drawW) / 2, rect.y + (rect.h - drawH) / 2, drawW, drawH);
      } catch {
        // a frame may not be decodable yet
      }
    } else {
      ctx.fillStyle = '#334155';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.round(H * 0.028)}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(source.label || 'connecting...', rect.x + rect.w / 2, rect.y + rect.h / 2);
    }

    if (this.program.mode === 'grid') {
      const barHeight = Math.round(H * 0.045);
      ctx.fillStyle = 'rgba(6,10,22,0.72)';
      ctx.fillRect(rect.x, rect.y + rect.h - barHeight, rect.w, barHeight);
      ctx.fillStyle = '#dbeafe';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.round(H * 0.024)}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(
        truncate(source.label || source.kind, 26),
        rect.x + H * 0.015,
        rect.y + rect.h - barHeight / 2,
      );
    }

    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  }

  _drawOps(ctx, ops) {
    for (const op of ops) {
      if (op.kind === 'rect') {
        ctx.save();
        if (op.opacity !== undefined) ctx.globalAlpha = op.opacity;
        roundRect(ctx, op.x, op.y, op.w, op.h, op.radius || 0);
        ctx.fillStyle = op.fill;
        ctx.fill();
        if (op.stroke) {
          ctx.strokeStyle = op.stroke;
          ctx.lineWidth = Math.max(1, op.h * 0.01);
          ctx.stroke();
        }
        ctx.restore();
      } else if (op.kind === 'text') {
        this._drawText(ctx, op);
      } else if (op.kind === 'image') {
        const image = this._image(op.src);
        ctx.save();
        roundRect(ctx, op.x, op.y, op.w, op.h, op.radius || 0);
        ctx.clip();
        if (image?.complete && image.naturalWidth) {
          ctx.drawImage(image, op.x, op.y, op.w, op.h);
        } else {
          ctx.fillStyle = 'rgba(168,85,247,0.25)';
          ctx.fillRect(op.x, op.y, op.w, op.h);
        }
        ctx.restore();
      }
    }
  }

  _drawText(ctx, op) {
    const size = Math.max(10, op.size || 32);
    const weight = op.weight || 500;
    ctx.save();
    ctx.font = `${weight} ${size}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = op.color || '#f8fafc';
    ctx.textAlign = op.align || 'left';
    ctx.textBaseline = op.baseline || 'alphabetic';

    const maxWidth = op.maxWidth || this.width * 0.9;
    const measured = ctx.measureText(op.text).width;
    if (measured <= maxWidth) {
      ctx.fillText(op.text, op.x, op.y);
      ctx.restore();
      return;
    }

    const charsPerLine = Math.max(8, Math.floor(op.text.length * (maxWidth / measured)));
    const lines = wrapText(op.text, charsPerLine);
    const lineHeight = size * 1.22;
    const startY = op.y - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, index) => ctx.fillText(line, op.x, startY + index * lineHeight));
    ctx.restore();
  }

  _image(src) {
    if (!src) return null;
    const cached = this._images.get(src);
    if (cached) return cached;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = src;
    this._images.set(src, image);
    return image;
  }

  _drawBadges(ctx, W, H) {
    const pad = Math.round(H * 0.025);
    const badgeHeight = Math.round(H * 0.055);
    let x = W - pad;
    const y = H - pad - badgeHeight;

    if (this.badges.recording) {
      const width = Math.round(H * 0.115);
      x -= width;
      roundRect(ctx, x, y, width, badgeHeight, badgeHeight / 2);
      ctx.fillStyle = 'rgba(245,158,11,0.94)';
      ctx.fill();
      ctx.fillStyle = '#1c1206';
      ctx.font = `800 ${Math.round(H * 0.026)}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('REC', x + width / 2, y + badgeHeight / 2 + 1);
      x -= Math.round(H * 0.012);
    }

    if (this.badges.live) {
      const width = Math.round(H * 0.135);
      x -= width;
      roundRect(ctx, x, y, width, badgeHeight, badgeHeight / 2);
      ctx.fillStyle = 'rgba(220,38,38,0.96)';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x + badgeHeight * 0.45, y + badgeHeight / 2, badgeHeight * 0.14, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `800 ${Math.round(H * 0.026)}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('LIVE', x + badgeHeight * 0.72, y + badgeHeight / 2 + 1);
    }

    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = '#93a4c8';
    ctx.font = `600 ${Math.round(H * 0.022)}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(this.badges.label || 'Quandrite', W - pad, y - Math.round(H * 0.015));
    ctx.restore();
  }
}

/** Rounded rectangle path helper (ctx.roundRect is not universal yet). */
function roundRect(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

export default ProgramCompositor;

