/**
 * Peer-to-peer meeting mesh.
 *
 * Every participant holds one RTCPeerConnection per other participant and the
 * SDP/ICE payloads travel over the existing WebSocket (`webrtc:signal`). The
 * mesh carries the meeting audio/video, while the livestream program feed uses
 * the compositor + relay path.
 */

import { CLIENT } from '/shared/protocol.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class MeetingMesh extends EventTarget {
  constructor({ socket, clientId, logger = console, iceServers = ICE_SERVERS } = {}) {
    super();
    this.socket = socket;
    this.clientId = clientId;
    this.logger = logger;
    this.iceServers = iceServers;
    this.peers = new Map();
    this.localStream = null;
    this.active = false;
    this.micEnabled = true;
    this.cameraEnabled = true;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Start publishing `localStream` and connect to every known peer. */
  async join(localStream, peerIds = []) {
    this.localStream = localStream;
    this.active = true;
    for (const peerId of peerIds) {
      if (peerId !== this.clientId) this._ensurePeer(peerId);
    }
    this._emit('joined', { peers: [...this.peers.keys()] });
    return this;
  }

  async leave() {
    this.active = false;
    for (const [peerId, peer] of this.peers) {
      try {
        peer.pc.close();
      } catch {
        // already closed
      }
      this._emit('stream', { peerId, stream: null });
    }
    this.peers.clear();
    this.localStream = null;
    this._emit('left', {});
  }

  /** Reconcile the mesh with the current member list. */
  sync(peerIds = []) {
    if (!this.active) return;
    const wanted = new Set(peerIds.filter((id) => id !== this.clientId));
    for (const id of wanted) this._ensurePeer(id);
    for (const [id, peer] of this.peers) {
      if (!wanted.has(id)) {
        try {
          peer.pc.close();
        } catch {
          // ignore
        }
        this.peers.delete(id);
        this._emit('stream', { peerId: id, stream: null });
      }
    }
  }

  _ensurePeer(peerId) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const polite = this.clientId < peerId;
    const peer = { id: peerId, pc, polite, makingOffer: false, ignoreOffer: false, remoteStream: null };
    this.peers.set(peerId, peer);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        await this._signal(peerId, { description: pc.localDescription });
      } catch (error) {
        this.logger.warn?.('negotiation failed', error);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._signal(peerId, { candidate: candidate.toJSON() }).catch(() => {});
    };

    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track]);
      peer.remoteStream = stream;
      this._emit('stream', { peerId, stream, track });
    };

    pc.onconnectionstatechange = () => {
      this._emit('peer-state', { peerId, state: pc.connectionState });
      if (pc.connectionState === 'failed') {
        try {
          pc.restartIce();
        } catch {
          // ignore
        }
      }
    };

    return peer;
  }

  _signal(to, data) {
    return this.socket.send(CLIENT.WEBRTC_SIGNAL, { to, data });
  }

  /** Handle an inbound `webrtc:signal` push. */
  async handleSignal(message) {
    const { from, data } = message;
    if (!from || !data) return;
    const peer = this._ensurePeer(from);
    const { pc } = peer;

    try {
      if (data.description) {
        const offerCollision =
          data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          await this._signal(from, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (error) {
          if (!peer.ignoreOffer) throw error;
        }
      }
    } catch (error) {
      this.logger.warn?.(`webrtc signalling failed for ${from}`, error);
      this._emit('error', { peerId: from, message: error.message });
    }
  }

  /** Swap the outgoing camera track (used when sharing a screen in the call). */
  async replaceVideoTrack(track) {
    for (const [, peer] of this.peers) {
      const sender = peer.pc.getSenders().find((entry) => entry.track?.kind === 'video');
      if (sender) await sender.replaceTrack(track);
    }
  }

  setMicEnabled(enabled) {
    this.micEnabled = enabled;
    if (!this.localStream) return;
    for (const track of this.localStream.getAudioTracks()) track.enabled = enabled;
    this._emit('local-state', { micEnabled: enabled, cameraEnabled: this.cameraEnabled });
  }

  setCameraEnabled(enabled) {
    this.cameraEnabled = enabled;
    if (!this.localStream) return;
    for (const track of this.localStream.getVideoTracks()) track.enabled = enabled;
    this._emit('local-state', { micEnabled: this.micEnabled, cameraEnabled: enabled });
  }
}

export default MeetingMesh;
