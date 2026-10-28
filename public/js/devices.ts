/**
 * Camera / screen / audio source manager.
 *
 * Browsers expose every camera the operating system knows about through
 * `enumerateDevices()`, including cameras that were paired over Bluetooth
 * (phone-as-webcam apps, action cameras, Continuity Camera). Quandrite adds any
 * number of them at the same time, keeps one decoder per source, and hands the
 * resulting streams to the program compositor.
 */

import { CLIENT } from '/shared/protocol.js';
import { microphoneConstraints, screenAudioConstraints } from '/shared/audio.js';

let sourceCounter = 0;

function nextSourceId(prefix) {
  sourceCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${sourceCounter.toString(36)}`;
}

function friendlyLabel(device, index, kind) {
  if (device?.label) return device.label;
  return `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${index + 1}`;
}

export class CameraManager extends EventTarget {

  // --- state (typed loosely while the class is migrated) ---
  devices: any;
  logger: any;
  socket: any;
  sources: any;
  constructor({ socket, logger = console }: any = {}) {
    super();
    this.socket = socket;
    this.logger = logger;
    this.sources = new Map();
    this.devices = { video: [], audio: [] };

    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        this.enumerate().catch(() => {});
      });
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get mediaDevicesSupported() {
    return Boolean(navigator.mediaDevices?.getUserMedia);
  }

  /** List cameras and microphones currently visible to the browser. */
  async enumerate() {
    if (!navigator.mediaDevices?.enumerateDevices) return { video: [], audio: [] };
    const devices = await navigator.mediaDevices.enumerateDevices();
    this.devices = {
      video: devices.filter((device) => device.kind === 'videoinput'),
      audio: devices.filter((device) => device.kind === 'audioinput'),
    };
    this._emit('devices', this.devices);
    return this.devices;
  }

  list() {
    return [...this.sources.values()];
  }

  get(id) {
    return this.sources.get(id) || null;
  }

  /** The single stream the meeting call should publish. */
  primaryStream() {
    const camera = this.list().find((source) => source.kind === 'camera');
    return camera?.stream || null;
  }

  async _registerSource({
    id,
    kind,
    label,
    deviceId = null,
    groupId = null,
    stream,
    meta = {},
    announce = true,
    stopTracksOnRemove = true,
    quiet = false,
  }) {
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // autoplay can be blocked until the first user gesture; the tile still renders
    }

    const source = {
      id,
      kind,
      label,
      deviceId,
      groupId,
      stream,
      video,
      meta,
      addedAt: Date.now(),
      announced: Boolean(announce),
      stopTracksOnRemove,
    };
    this.sources.set(id, source);

    // Meeting-only media (a viewer's camera) is kept local: the server only
    // accepts program sources from the host and co-hosts.
    if (announce) {
      try {
        await this.socket.send(CLIENT.SOURCE_ADD, {
          // `streamId` is the MediaStream id: it lets every other client match the
          // media this source publishes over the room mesh back to the source,
          // so a co-host can put a viewer's camera or screen on the program.
          source: { id, kind, label, deviceId, groupId, meta: { ...meta, streamId: stream?.id || null } },
        });
      } catch (error) {
        // Someone else already announced it (two hosts can see the same peer),
        // so leave the removal to them.
        source.announced = false;
        if (!quiet) this._emit('warning', { message: `could not announce source: ${error.message}` });
      }
    }

    this._emit('change', this.list());
    return source;
  }

  /**
   * Attach one camera (plus its microphone when available) to the studio.
   * @param {{deviceId?: string|null, label?: string, withAudio?: boolean, announce?: boolean}} options
   */
  async addCamera({ deviceId = null, label = null, withAudio = true, announce = true }: any = {}) {
    if (!this.mediaDevicesSupported) {
      this._emit('warning', { message: 'this browser does not support camera capture' });
      return null;
    }

    const baseVideo = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    if (deviceId) baseVideo.deviceId = { exact: deviceId };
    const constraints = {
      video: baseVideo,
      // A microphone is speech: the three processors help, and one channel is all it has.
      // 48 kHz keeps the whole path at one rate instead of quietly resampling.
      audio: withAudio ? microphoneConstraints() : false,
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      if (error?.name === 'OverconstrainedError' || error?.name === 'NotFoundError') {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: deviceId ? { deviceId: { exact: deviceId } } : true,
            audio: withAudio,
          });
        } catch (retryError) {
          this._emit('error', { message: `camera unavailable: ${retryError.message}` });
          return null;
        }
      } else {
        this._emit('error', { message: `camera unavailable: ${error.message}` });
        return null;
      }
    }

    const track = stream.getVideoTracks()[0];
    // Say what the pixels are for: the encoder keeps a camera smooth and a shared
    // screen sharp, and the same hint travels with the track over WebRTC.
    if (track && 'contentHint' in track) track.contentHint = 'motion';
    const settings = track?.getSettings?.() || {};
    const resolvedDeviceId = settings.deviceId || deviceId || null;
    const id = deviceId ? `camera:${deviceId}` : nextSourceId('camera');

    if (this.sources.has(id)) {
      for (const existing of stream.getTracks()) existing.stop();
      return this.sources.get(id);
    }

    const index = this.devices.video.findIndex((entry) => entry.deviceId === resolvedDeviceId);
    const device = this.devices.video[index];
    return this._registerSource({
      id,
      kind: 'camera',
      label: label || friendlyLabel(device, index < 0 ? 0 : index, 'videoinput'),
      deviceId: resolvedDeviceId,
      groupId: device?.groupId || null,
      stream,
      announce,
      meta: {
        width: settings.width || null,
        height: settings.height || null,
        frameRate: settings.frameRate || null,
        hasAudio: stream.getAudioTracks().length > 0,
      },
    });
  }

  /** Attach every camera the machine can see (multi-camera livestreams). */
  async addAllCameras() {
    await this.enumerate();
    const added = [];
    for (const device of this.devices.video) {
      if (this.sources.has(`camera:${device.deviceId}`)) continue;
      const source = await this.addCamera({ deviceId: device.deviceId });
      if (source) added.push(source);
    }
    if (!added.length && this.devices.video.length === 0) {
      const fallback = await this.addCamera({});
      if (fallback) added.push(fallback);
    }
    return added;
  }

  /** Share a screen (optionally with system/tab audio) as a source. */
  async addScreenShare({ audio = true }: any = {}) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this._emit('error', { message: 'this browser cannot share a screen' });
      return null;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        // A shared screen's sound may be music, and every one of the microphone's
        // processors would damage it: no echo cancellation, no noise suppression, no
        // automatic gain, and stereo kept.
        audio: audio ? screenAudioConstraints() : false,
      });
    } catch (error) {
      if (error?.name !== 'NotAllowedError') {
        this._emit('error', { message: `screen share failed: ${error.message}` });
      }
      return null;
    }

    const track = stream.getVideoTracks()[0];
    // Say what the pixels are for: the encoder keeps a camera smooth and a shared
    // screen sharp, and the same hint travels with the track over WebRTC.
    if (track && 'contentHint' in track) track.contentHint = 'detail';
    const settings = track?.getSettings?.() || {};
    const id = nextSourceId('screen');

    // When the user stops sharing from the browser chrome, drop the source too.
    track?.addEventListener('ended', () => this.removeSource(id));

    const source = await this._registerSource({
      id,
      kind: 'screen',
      label: `Screen (${settings.displaySurface || 'share'})`,
      deviceId: settings.deviceId || null,
      stream,
      meta: {
        width: settings.width || null,
        height: settings.height || null,
        hasAudio: stream.getAudioTracks().length > 0,
      },
    });
    this._emit('screenshare', source);
    return source;
  }

  /** Attach a microphone as an audio-only source (used for program audio). */
  async addMicrophone({ deviceId = null, label = null }: any = {}) {
    if (!this.mediaDevicesSupported) return null;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: microphoneConstraints(deviceId),
        video: false,
      });
    } catch (error) {
      this._emit('error', { message: `microphone unavailable: ${error.message}` });
      return null;
    }
    const id = deviceId ? `audio:${deviceId}` : nextSourceId('audio');
    if (this.sources.has(id)) {
      for (const track of stream.getTracks()) track.stop();
      return this.sources.get(id);
    }
    return this._registerSource({ id, kind: 'audio', label: label || 'Microphone', deviceId, stream });
  }

  async removeSource(id) {
    const source = this.sources.get(id);
    if (!source) return false;
    this.sources.delete(id);
    // Remote feeds belong to the peer connection: never stop their tracks here.
    if (source.stopTracksOnRemove !== false) {
      for (const track of source.stream?.getTracks?.() || []) {
        try {
          track.stop();
        } catch {
          // already stopped
        }
      }
    }
    if (source.video) source.video.srcObject = null;
    // Relayed pictures hold decoded frames: let them go with the source.
    for (const frame of [source.frame, source.lastFrame]) frame?.close?.();
    source.frame = null;
    source.lastFrame = null;
    if (source.announced) {
      try {
        await this.socket.send(CLIENT.SOURCE_REMOVE, { sourceId: id });
      } catch (error) {
        this._emit('warning', { message: `could not remove source on the server: ${error.message}` });
      }
    }
    this._emit('change', this.list());
    return true;
  }

  /**
   * Attach a participant's live video, which arrives over the meeting mesh, as a
   * program source. Everyone sees it in the room; the host and co-hosts also
   * announce it so it can be composited into the program and put on air.
   */
  async addParticipant({ peerId, label = null, stream, announce = true }) {
    if (!peerId || !stream) return null;
    const id = `participant:${peerId}`;
    const existing = this.sources.get(id);
    if (existing) {
      // A newer track set replaces the old one without a second announcement.
      existing.stream = stream;
      if (existing.video) existing.video.srcObject = stream;
      this._emit('change', this.list());
      return existing;
    }
    return this._registerSource({
      id,
      kind: 'virtual',
      label: label || 'Participant',
      stream,
      meta: { peerId },
      announce,
      stopTracksOnRemove: false,
      quiet: true,
    });
  }

  /**
   * A peer's picture that arrived over the socket instead of peer to peer.
   *
   * Two things are kept, because they are used differently: the `<img>` for the
   * room tile, and - when the browser can decode it - an `ImageBitmap` for the
   * compositor. A decoded bitmap is always drawable; an `<img>` whose `src` has
   * just changed has no picture at all until it loads, which is what used to make
   * the program flash dark on every relayed frame.
   *
   * The previous frame is kept too, so a refresh can never leave the program with
   * nothing to draw: there is always at least one fully decoded frame to show.
   */
  attachRemoteImage({ id, label = null, peerId = null, url, kind = 'virtual', bitmap = null }) {
    if (!id || !url) return null;
    let source = this.sources.get(id);
    if (!source) {
      const image = document.createElement('img');
      image.alt = '';
      image.className = 'relayed-picture';
      source = {
        id,
        kind,
        label: label || 'Shared picture',
        deviceId: null,
        groupId: null,
        stream: null,
        video: image,
        meta: { peerId, relayed: true },
        addedAt: Date.now(),
        announced: false,
        stopTracksOnRemove: false,
      };
      this.sources.set(id, source);
    }
    if (source.video?.tagName === 'IMG') source.video.src = url;
    if (bitmap) {
      // Exactly two frames are held - the newest and the one before it - and
      // anything older is closed, so a long call cannot leak bitmaps.
      if (source.lastFrame && source.lastFrame !== bitmap) source.lastFrame.close?.();
      source.lastFrame = source.frame || null;
      source.frame = bitmap;
    }
    this._emit('change', this.list());
    return source;
  }

  /** Detach a participant feed (the mesh owns its tracks). */
  removeParticipant(peerId) {
    return this.removeSource(`participant:${peerId}`);
  }

  /**
   * Attach the media a peer published for one of their announced sources (a
   * screen share, say) under a key of its own, so the compositor can draw it and
   * a co-host can put it on the program.
   */
  attachRemoteSource({ id, label = null, stream, peerId = null, kind = 'virtual' }) {
    if (!id || !stream) return null;
    const existing = this.sources.get(id);
    if (existing) {
      existing.stream = stream;
      if (existing.video) existing.video.srcObject = stream;
      this._emit('change', this.list());
      return existing;
    }
    return this._registerSource({
      id,
      kind,
      label: label || 'Shared feed',
      stream,
      meta: { peerId, remote: true },
      announce: false,
      stopTracksOnRemove: false,
      quiet: true,
    });
  }

  /** Participant feeds currently attached, in join order. */
  participants() {
    return this.list().filter((source) => source.kind === 'virtual');
  }

  stopAll() {
    for (const [id, source] of this.sources) {
      if (source.stopTracksOnRemove !== false) {
        for (const track of source.stream?.getTracks?.() || []) {
          try {
            track.stop();
          } catch {
            // ignore
          }
        }
      }
      this.sources.delete(id);
    }
    this._emit('change', []);
  }

  /**
   * Help the operator pair a Bluetooth camera.
   *
   * Browsers cannot open a video stream straight off a BLE device, so this
   * triggers the pairing flow and then waits for the OS to expose the newly
   * paired camera as a video input before attaching it.
   */
  async pairBluetooth() {
    if (!navigator.bluetooth?.requestDevice) {
      this._emit('warning', {
        message:
          'Web Bluetooth is unavailable here - pair the camera in your operating system settings, then press "Add all cameras".',
      });
      return { ok: false, reason: 'unsupported' };
    }
    try {
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
      this._emit('bluetooth', { name: device.name || 'Bluetooth device', id: device.id });
      const added = await this._attachNewCameras();
      return { ok: true, name: device.name, added: added.length };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  /**
   * Re-enumerate until a newly paired camera shows up, then attach it.
   *
   * A camera that appears over Bluetooth can take a moment before the operating
   * system lists it as a video input, so this polls instead of sampling once.
   */
  async _attachNewCameras({ attempts = 8, delayMs = 750 }: any = {}) {
    const known = new Set((await this.enumerate()).video.map((device) => device.deviceId));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const devices = await this.enumerate();
      const fresh = devices.video.filter(
        (device) => !known.has(device.deviceId) && !this.sources.has(`camera:${device.deviceId}`),
      );
      if (fresh.length) {
        const added = [];
        for (const device of fresh) {
          const source = await this.addCamera({ deviceId: device.deviceId });
          if (source) added.push(source);
        }
        return added;
      }
    }
    return [];
  }
}

export default CameraManager;
