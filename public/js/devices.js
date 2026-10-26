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
  constructor({ socket, logger = console } = {}) {
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

  async _registerSource({ id, kind, label, deviceId = null, groupId = null, stream, meta = {} }) {
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

    const source = { id, kind, label, deviceId, groupId, stream, video, meta, addedAt: Date.now() };
    this.sources.set(id, source);

    try {
      await this.socket.send(CLIENT.SOURCE_ADD, {
        source: { id, kind, label, deviceId, groupId, meta },
      });
    } catch (error) {
      this._emit('warning', { message: `could not announce source: ${error.message}` });
    }

    this._emit('change', this.list());
    return source;
  }

  /**
   * Attach one camera (plus its microphone when available) to the studio.
   * @param {{deviceId?: string|null, label?: string, withAudio?: boolean}} options
   */
  async addCamera({ deviceId = null, label = null, withAudio = true } = {}) {
    if (!this.mediaDevicesSupported) {
      this._emit('warning', { message: 'this browser does not support camera capture' });
      return null;
    }

    const baseVideo = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    if (deviceId) baseVideo.deviceId = { exact: deviceId };
    const constraints = {
      video: baseVideo,
      audio: withAudio ? { echoCancellation: true } : false,
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
  async addScreenShare({ audio = true } = {}) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this._emit('error', { message: 'this browser cannot share a screen' });
      return null;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio,
      });
    } catch (error) {
      if (error?.name !== 'NotAllowedError') {
        this._emit('error', { message: `screen share failed: ${error.message}` });
      }
      return null;
    }

    const track = stream.getVideoTracks()[0];
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
  async addMicrophone({ deviceId = null, label = null } = {}) {
    if (!this.mediaDevicesSupported) return null;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : { echoCancellation: true },
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
    for (const track of source.stream?.getTracks?.() || []) {
      try {
        track.stop();
      } catch {
        // already stopped
      }
    }
    if (source.video) source.video.srcObject = null;
    try {
      await this.socket.send(CLIENT.SOURCE_REMOVE, { sourceId: id });
    } catch (error) {
      this._emit('warning', { message: `could not remove source on the server: ${error.message}` });
    }
    this._emit('change', this.list());
    return true;
  }

  stopAll() {
    for (const [id, source] of this.sources) {
      for (const track of source.stream?.getTracks?.() || []) {
        try {
          track.stop();
        } catch {
          // ignore
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
   * triggers the pairing flow and then re-enumerates: once the OS exposes the
   * newly paired camera as a video input it is added automatically.
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
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const added = await this.addAllCameras();
      return { ok: true, name: device.name, added: added.length };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }
}

export default CameraManager;
