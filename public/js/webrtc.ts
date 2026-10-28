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

/**
 * Marks the signal payloads that belong to the program feed, so the studio
 * output travels on its own peer connection instead of sharing the meeting's.
 */
const PROGRAM_KIND = 'program';

export class MeetingMesh extends EventTarget {

  // --- state (typed loosely while the class is migrated) ---
  active: any;
  cameraEnabled: any;
  clientId: any;
  iceServers: any;
  localStream: any;
  logger: any;
  micEnabled: any;
  peerIds: any;
  peers: any;
  socket: any;
  /** The peer connections that carry the studio program feed (video + audio). */
  programPeers: any;
  /** The program stream this client sends, when it owns the program. */
  programStream: any;
  /** Who the program goes to (the whole studio, not just the room). */
  programPeerIds: any;
  constructor({ socket, clientId, logger = console, iceServers = ICE_SERVERS }: any = {}) {
    super();
    this.socket = socket;
    this.clientId = clientId;
    this.logger = logger;
    this.iceServers = iceServers;
    this.peers = new Map();
    this.programPeers = new Map();
    this.programStream = null;
    this.programPeerIds = new Set();
    this.peerIds = new Set();
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
    this.peerIds = new Set(peerIds.filter((id) => id !== this.clientId));
    for (const peerId of this.peerIds) this._ensurePeer(peerId);
    this._syncProgramPeers();
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
      this._dropPeerStreams(peerId, peer);
    }
    this.peers.clear();
    this._closeProgramPeers();
    this.peerIds = new Set();
    this.localStream = null;
    this._emit('left', {});
  }

  /** Reconcile the mesh with the current member list. */
  sync(peerIds = []) {
    if (!this.active) return;
    const wanted = new Set(peerIds.filter((id) => id !== this.clientId));
    this.peerIds = wanted;
    for (const id of wanted) this._ensurePeer(id);
    for (const [id, peer] of this.peers) {
      if (!wanted.has(id)) {
        try {
          peer.pc.close();
        } catch {
          // ignore
        }
        this.peers.delete(id);
        this._dropPeerStreams(id, peer);
      }
    }
    // The program feed spans the whole studio, so it is pruned against its own
    // list: a peer in a breakout still receives the parent's program.
    const programWanted = this._programPeerSet();
    for (const id of [...this.programPeers.keys()]) {
      if (!programWanted.has(id)) this._closeProgramPeer(id);
    }
    this._syncProgramPeers();
  }

  /**
   * The server refuses a signal to somebody who is no longer in the room.
   *
   * That is a normal race - a peer leaves between the roster update and the
   * offer - so it closes the connection quietly instead of warning about it.
   */
  _peerGone(error) {
    return /not in this room/i.test(error?.message || '');
  }

  /**
   * The ICE servers the studio server handed us.
   *
   * STUN is what finds a route between two peers; a TURN server is what relays
   * the media when their networks will not allow a direct connection. Without one
   * a call only works when both sides can reach each other, which is why the
   * server's list wins over the built-in defaults.
   */
  setIceServers(servers = []) {
    if (!Array.isArray(servers) || !servers.length) return false;
    const same = JSON.stringify(servers) === JSON.stringify(this.iceServers);
    if (same) return false;
    this.iceServers = servers;
    // Existing connections keep the servers they were built with, so they are
    // rebuilt - the roster sync reopens them with the new set.
    const ids = [...this.peers.keys()];
    for (const id of ids) {
      const peer = this.peers.get(id);
      try {
        peer?.pc?.close();
      } catch {
        // already closed
      }
      this.peers.delete(id);
      this._dropPeerStreams(id, peer);
    }
    this._closeProgramPeers();
    for (const id of ids) this._ensurePeer(id);
    return true;
  }

  /** Announce every feed from a peer as gone, one at a time. */
  _dropPeerStreams(peerId, peer) {
    for (const streamId of [...(peer?.streams?.keys?.() || [])]) {
      peer.streams.delete(streamId);
      this._emit('stream', { peerId, streamId, stream: null });
    }
  }

  _ensurePeer(peerId) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const polite = this.clientId < peerId;
    const peer = {
      id: peerId,
      pc,
      polite,
      makingOffer: false,
      ignoreOffer: false,
      remoteStream: null,
      /** Every feed this peer publishes, by MediaStream id. */
      streams: new Map(),
    };
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
        // Somebody who left the room between the roster update and this offer:
        // drop the connection quietly rather than logging a failure.
        if (this._peerGone(error)) {
          try {
            pc.close();
          } catch {
            // already closed
          }
          this.peers.delete(peerId);
          this._dropPeerStreams(peerId, peer);
          return;
        }
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
      // Every feed keeps its own id: one peer can publish a camera and a screen
      // at the same time, and the room has to tell them apart.
      peer.streams.set(stream.id, stream);
      this._emit('stream', { peerId, streamId: stream.id, stream, track });
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

  // ------------------------------------------------------------ program feed

  /**
   * Publish the studio program (composited picture + mixed program audio).
   *
   * Every member of the room gets its own connection for this, so the program
   * never queues behind a camera renegotiation and never travels through the
   * RTMP relay: the picture and the sound arrive peer to peer, in tens of
   * milliseconds. `null` stops sending and tears the connections down.
   *
   * `peerIds` is who receives it. It defaults to the meeting mesh (the room you
   * are in), but the program belongs to the parent room, so it is handed the
   * whole studio - breakouts included - when that is wider.
   */
  setProgramStream(stream, peerIds = null) {
    if (Array.isArray(peerIds)) {
      this.programPeerIds = new Set(peerIds.filter((id) => id && id !== this.clientId));
    }
    const next = stream || null;
    if (this.programStream === next) {
      // Same stream: nothing to re-add, but the peer set may have changed.
      this._syncProgramPeers();
      return this;
    }
    this.programStream = next;
    if (!this.programStream) {
      this._closeProgramPeers();
      return this;
    }
    this._syncProgramPeers();
    return this;
  }

  /** Who the program feed goes to: its own list when it has one. */
  _programPeerSet() {
    return this.programPeerIds.size ? this.programPeerIds : this.peerIds;
  }

  /** Open a program connection for every peer that has none yet. */
  _syncProgramPeers() {
    if (!this.active || !this.programStream) return;
    for (const peerId of this._programPeerSet()) this._ensureProgramPeer(peerId);
    for (const [, peer] of this.programPeers) this._publishProgramTracks(peer);
  }

  _ensureProgramPeer(peerId) {
    if (!peerId || peerId === this.clientId) return null;
    const existing = this.programPeers.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const polite = this.clientId < peerId;
    const peer = { id: peerId, pc, polite, makingOffer: false, ignoreOffer: false, remoteStream: null };
    this.programPeers.set(peerId, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        await this._signal(peerId, { description: pc.localDescription, kind: PROGRAM_KIND });
      } catch (error) {
        // A peer that left between the roster update and this offer is normal.
        if (this._peerGone(error)) {
          this._closeProgramPeer(peerId);
          return;
        }
        this.logger.warn?.('program negotiation failed', error);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._signal(peerId, { candidate: candidate.toJSON(), kind: PROGRAM_KIND }).catch(() => {});
    };

    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track]);
      peer.remoteStream = stream;
      this._emit('program-stream', { peerId, stream });
    };

    pc.onconnectionstatechange = () => {
      if (!['failed', 'closed'].includes(pc.connectionState)) return;
      this._closeProgramPeer(peerId);
    };

    this._publishProgramTracks(peer);
    return peer;
  }

  /** Add (or swap) the program tracks on one connection. */
  _publishProgramTracks(peer) {
    if (!this.programStream) return;
    for (const track of this.programStream.getTracks()) {
      const sender = peer.pc.getSenders().find((entry) => entry.track?.kind === track.kind);
      if (sender) {
        sender.replaceTrack(track).catch(() => {});
        continue;
      }
      try {
        peer.pc.addTrack(track, this.programStream);
      } catch {
        // a connection that is already closing is fine
      }
    }
  }

  _closeProgramPeer(peerId) {
    const peer = this.programPeers.get(peerId);
    if (!peer) return;
    this.programPeers.delete(peerId);
    try {
      peer.pc.close();
    } catch {
      // already closed
    }
    this._emit('program-stream', { peerId, stream: null });
  }

  _closeProgramPeers() {
    for (const peerId of [...this.programPeers.keys()]) this._closeProgramPeer(peerId);
  }

  _signal(to, data) {
    return this.socket.send(CLIENT.WEBRTC_SIGNAL, { to, data });
  }

  /**
   * Handle an inbound `webrtc:signal` push.
   *
   * A payload marked `kind: 'program'` belongs to the studio program feed and is
   * answered on that connection, so the program and the meeting never cross.
   */
  async handleSignal(message) {
    const { from, data } = message;
    if (!from || !data) return;
    const program = data.kind === PROGRAM_KIND;
    const peer = program ? this._ensureProgramPeer(from) : this._ensurePeer(from);
    if (!peer) return;
    const { pc } = peer;
    const echo = program ? { kind: PROGRAM_KIND } : {};

    try {
      if (data.description) {
        const offerCollision =
          data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          await this._signal(from, { description: pc.localDescription, ...echo });
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

  /**
   * Add a track that was published after the call started (turning a camera on
   * mid-meeting): senders of the same kind are swapped, new kinds are added and
   * the peer connection renegotiates itself.
   */
  attachTrack(track, stream) {
    if (!track) return;
    // A client that started with no media at all (a viewer) still has a local
    // stream once something is published, so the mic/camera switches work.
    if (!this.localStream) this.localStream = stream || new MediaStream([track]);
    if (this.localStream && !this.localStream.getTracks().includes(track)) {
      this.localStream = new MediaStream([...this.localStream.getTracks(), track]);
    }
    for (const [, peer] of this.peers) {
      const sender = peer.pc.getSenders().find((entry) => entry.track?.kind === track.kind);
      if (sender) {
        sender.replaceTrack(track).catch(() => {});
      } else {
        try {
          peer.pc.addTrack(track, stream || this.localStream || new MediaStream([track]));
        } catch {
          // a peer that is already closing is fine
        }
      }
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
