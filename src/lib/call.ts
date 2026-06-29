import Peer from 'peerjs';
import type { DataConnection, MediaConnection } from 'peerjs';
import {
  createDecryptTransform,
  createEncryptTransform,
  createIdentityTransform,
  deriveMediaKey,
  supportsEncodedStreams,
  supportsScriptTransform,
} from './crypto';
import { generatePeerId, type RoomCode } from './roomcode';

export type CallStatus =
  | 'idle'
  | 'preparing'
  | 'waiting'
  | 'connecting'
  | 'in-call'
  | 'reconnecting'
  | 'peer-left'
  | 'ended'
  | 'error';

export type CallRole = 'host' | 'guest';

/** Coarse link quality, 0 = unknown, 1 = poor … 4 = excellent. */
export type QualityLevel = 0 | 1 | 2 | 3 | 4;

export interface CallCallbacks {
  onStatus: (status: CallStatus, detail?: string) => void;
  onLocalStream: (stream: MediaStream) => void;
  onRemoteStream: (stream: MediaStream) => void;
  /** Fires once the extra E2EE layer is negotiated with the peer. */
  onE2EE: (active: boolean) => void;
  /** Whether the remote peer is currently sending video (camera on). */
  onRemoteVideo: (enabled: boolean) => void;
  /** Periodic link-quality estimate derived from WebRTC stats. */
  onQuality: (level: QualityLevel) => void;
  onError: (message: string) => void;
}

/** Capability handshake message exchanged over the PeerJS data channel. */
interface CapabilityMessage {
  t: 'cap';
  e2ee: boolean;
}

function isCapabilityMessage(msg: unknown): msg is CapabilityMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { t?: unknown }).t === 'cap' &&
    typeof (msg as { e2ee?: unknown }).e2ee === 'boolean'
  );
}

/**
 * Camera on/off notice. Sent over the data channel because toggling
 * `track.enabled` keeps the track "live" (it just sends black frames), so the
 * receiver never gets a `mute` event — we have to tell the peer explicitly.
 */
interface CameraMessage {
  t: 'cam';
  on: boolean;
}

function isCameraMessage(msg: unknown): msg is CameraMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { t?: unknown }).t === 'cam' &&
    typeof (msg as { on?: unknown }).on === 'boolean'
  );
}

/** Time to wait for the capability handshake before falling back to DTLS-SRTP. */
const HANDSHAKE_TIMEOUT_MS = 4000;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class CallManager {
  private peer: Peer | null = null;
  private connection: MediaConnection | null = null;
  private data: DataConnection | null = null;
  private localStream: MediaStream | null = null;
  private mediaKey: CryptoKey | null = null;
  /** Chrome path: createEncodedStreams() on the main thread. */
  private readonly canEncodedStreams: boolean = supportsEncodedStreams();
  /** Safari path: RTCRtpScriptTransform driven by a worker. */
  private readonly canScriptTransform: boolean = supportsScriptTransform();
  /** Whether THIS browser can do frame-level encryption in either flavour. */
  private readonly localSupport: boolean =
    this.canEncodedStreams || this.canScriptTransform;
  /** Lazily-created worker that runs the Safari encoded-transform. */
  private transformWorker: Worker | null = null;
  /** Negotiated result: extra E2EE layer is used only if BOTH peers support it. */
  private useE2EE = false;
  private negotiated = false;
  private callStarted = false;
  private readonly appliedSenders = new WeakSet<RTCRtpSender>();
  private readonly appliedReceivers = new WeakSet<RTCRtpReceiver>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private prevLost = 0;
  private prevReceived = 0;
  private closedByUs = false;
  private peerGone = false;
  private cameraOn = true;

  /** Whether this browser locally supports the extra E2EE layer. */
  get localE2EESupported(): boolean {
    return this.localSupport;
  }

  async start(
    role: CallRole,
    room: RoomCode,
    cb: CallCallbacks,
  ): Promise<void> {
    try {
      cb.onStatus('preparing');
      this.mediaKey = await deriveMediaKey(room.secret);
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      cb.onLocalStream(this.localStream);

      const config: RTCConfiguration = { iceServers: ICE_SERVERS };
      // Chrome requires the connection to opt into insertable streams; transforms
      // are still only applied if the negotiation below decides both peers
      // support it. Safari needs no connection-level flag (it attaches a
      // per-sender/receiver RTCRtpScriptTransform instead).
      if (this.canEncodedStreams) config.encodedInsertableStreams = true;

      // Host keeps the shared peer id; guest gets a throwaway id.
      const peerId = role === 'host' ? room.peerId : generatePeerId();
      this.peer = new Peer(peerId, { config });

      this.peer.on('error', (err) => {
        cb.onStatus('error', err.type);
        cb.onError(this.describeError(err.type, err.message));
      });

      if (role === 'host') {
        this.peer.on('open', () => cb.onStatus('waiting'));
        // Guest opens a data channel and sends its capability before calling,
        // so this is resolved before the media 'call' event arrives.
        this.peer.on('connection', (data) => {
          this.data = data;
          data.on('open', () => this.sendCameraState());
          data.on('data', (msg) => {
            if (isCameraMessage(msg)) {
              cb.onRemoteVideo(msg.on);
              return;
            }
            if (this.negotiated || !isCapabilityMessage(msg)) return;
            this.negotiated = true;
            this.useE2EE = this.localSupport && msg.e2ee;
            data.send({ t: 'cap', e2ee: this.localSupport });
            cb.onE2EE(this.useE2EE);
          });
        });
        this.peer.on('call', (call) => {
          this.connection = call;
          call.answer(this.localStream ?? undefined);
          cb.onE2EE(this.useE2EE);
          this.wireConnection(call, cb);
        });
      } else {
        this.peer.on('open', () => {
          cb.onStatus('connecting');
          this.negotiateThenCall(room.peerId, cb);
        });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Не удалось получить доступ к камере/микрофону';
      cb.onStatus('error', message);
      cb.onError(message);
    }
  }

  /**
   * Guest side: exchange E2EE capability over a data channel, then place the
   * media call. Falls back to DTLS-SRTP only if the handshake does not complete.
   */
  private negotiateThenCall(hostId: string, cb: CallCallbacks): void {
    const data = this.peer!.connect(hostId, { reliable: true });
    this.data = data;

    const startMedia = () => {
      if (this.callStarted) return;
      this.callStarted = true;
      cb.onE2EE(this.useE2EE);
      const call = this.peer!.call(hostId, this.localStream!);
      this.connection = call;
      this.wireConnection(call, cb);
    };

    // If the data channel never establishes, fall back to DTLS-SRTP and proceed.
    const timer = setTimeout(() => {
      if (this.negotiated) return;
      this.negotiated = true;
      this.useE2EE = false;
      startMedia();
    }, HANDSHAKE_TIMEOUT_MS);

    data.on('open', () => {
      data.send({ t: 'cap', e2ee: this.localSupport });
      this.sendCameraState();
    });
    data.on('data', (msg) => {
      if (isCameraMessage(msg)) {
        cb.onRemoteVideo(msg.on);
        return;
      }
      if (this.negotiated || !isCapabilityMessage(msg)) return;
      this.negotiated = true;
      clearTimeout(timer);
      this.useE2EE = this.localSupport && msg.e2ee;
      startMedia();
    });
    data.on('error', () => {
      if (this.negotiated) return;
      this.negotiated = true;
      clearTimeout(timer);
      this.useE2EE = false;
      startMedia();
    });
  }

  private wireConnection(call: MediaConnection, cb: CallCallbacks): void {
    const pc = call.peerConnection;
    if (pc) {
      pc.addEventListener('track', (event) =>
        this.applyReceiverTransform(event.receiver),
      );
      this.applySenderTransform(pc);
      pc.addEventListener('connectionstatechange', () => {
        switch (pc.connectionState) {
          case 'connected':
            cb.onStatus('in-call');
            break;
          case 'disconnected':
            cb.onStatus('reconnecting');
            break;
          case 'failed':
            this.reportPeerLeft(cb);
            break;
        }
      });
    }

    call.on('stream', (remoteStream) => {
      cb.onRemoteStream(remoteStream);
      cb.onStatus('in-call');
      this.watchRemoteVideo(remoteStream, cb);
      this.startQualityMonitor(call, cb);
    });
    call.on('close', () => this.reportPeerLeft(cb));
    call.on('error', (err) => {
      cb.onStatus('error');
      cb.onError(err.message);
    });
  }

  /** Remote peer disconnected (not a local hangup). */
  private reportPeerLeft(cb: CallCallbacks): void {
    if (this.closedByUs || this.peerGone) return;
    this.peerGone = true;
    this.stopQualityMonitor();
    cb.onStatus('peer-left');
  }

  /**
   * Remote camera state is driven by explicit data-channel notices (see
   * CameraMessage); here we only handle the track ending (peer really gone).
   * We default to "on" until told otherwise.
   */
  private watchRemoteVideo(stream: MediaStream, cb: CallCallbacks): void {
    const track = stream.getVideoTracks()[0];
    cb.onRemoteVideo(!!track);
    track?.addEventListener('ended', () => cb.onRemoteVideo(false));
  }

  /** Tell the peer our current camera state (best-effort). */
  private sendCameraState(): void {
    try {
      this.data?.send({ t: 'cam', on: this.cameraOn });
    } catch {
      /* data channel not ready — peer will get state on next toggle */
    }
  }

  private startQualityMonitor(call: MediaConnection, cb: CallCallbacks): void {
    const pc = call.peerConnection;
    if (!pc || this.statsTimer) return;
    const sample = async () => {
      try {
        cb.onQuality(await this.sampleQuality(pc));
      } catch {
        cb.onQuality(0);
      }
    };
    void sample();
    this.statsTimer = setInterval(() => void sample(), 2000);
  }

  private stopQualityMonitor(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private async sampleQuality(pc: RTCPeerConnection): Promise<QualityLevel> {
    const stats = await pc.getStats();
    let rtt: number | null = null;
    let lost = 0;
    let received = 0;
    stats.forEach((report) => {
      if (
        report.type === 'candidate-pair' &&
        (report as RTCIceCandidatePairStats).nominated &&
        typeof (report as RTCIceCandidatePairStats).currentRoundTripTime ===
          'number'
      ) {
        rtt = (report as RTCIceCandidatePairStats).currentRoundTripTime ?? null;
      }
      if (report.type === 'inbound-rtp' && (report as RTCInboundRtpStreamStats).kind === 'video') {
        const r = report as RTCInboundRtpStreamStats;
        lost += r.packetsLost ?? 0;
        received += r.packetsReceived ?? 0;
      }
    });

    const deltaLost = Math.max(0, lost - this.prevLost);
    const deltaRecv = Math.max(0, received - this.prevReceived);
    this.prevLost = lost;
    this.prevReceived = received;
    const loss = deltaRecv + deltaLost > 0 ? deltaLost / (deltaRecv + deltaLost) : 0;

    if (received === 0 && rtt === null) return 0;
    const rttMs = rtt === null ? 0 : rtt * 1000;
    if (loss > 0.1 || rttMs > 500) return 1;
    if (loss > 0.05 || rttMs > 300) return 2;
    if (loss > 0.02 || rttMs > 150) return 3;
    return 4;
  }

  private getTransformWorker(): Worker {
    if (!this.transformWorker) {
      this.transformWorker = new Worker(
        new URL('./transform.worker.ts', import.meta.url),
        { type: 'module' },
      );
    }
    return this.transformWorker;
  }

  // Attach the encrypt/decrypt transform. Chrome path: createEncodedStreams()
  // must consume every encoded stream or media is blocked, so when the E2EE
  // layer is off we still pipe an identity transform. Safari path: we only set
  // an RTCRtpScriptTransform when E2EE is on; otherwise media flows untouched
  // (DTLS-SRTP fallback).
  private applySenderTransform(pc: RTCPeerConnection): void {
    if (!this.localSupport) return;
    for (const sender of pc.getSenders()) {
      if (!sender.track || this.appliedSenders.has(sender)) continue;
      if (this.canEncodedStreams && sender.createEncodedStreams) {
        const { readable, writable } = sender.createEncodedStreams();
        const transform =
          this.useE2EE && this.mediaKey
            ? createEncryptTransform(this.mediaKey)
            : createIdentityTransform();
        void readable.pipeThrough(transform).pipeTo(writable);
      } else if (this.canScriptTransform && this.useE2EE && this.mediaKey) {
        sender.transform = new RTCRtpScriptTransform(this.getTransformWorker(), {
          operation: 'encrypt',
          key: this.mediaKey,
        });
      }
      this.appliedSenders.add(sender);
    }
  }

  private applyReceiverTransform(receiver: RTCRtpReceiver): void {
    if (!this.localSupport || this.appliedReceivers.has(receiver)) return;
    if (this.canEncodedStreams && receiver.createEncodedStreams) {
      const { readable, writable } = receiver.createEncodedStreams();
      const transform =
        this.useE2EE && this.mediaKey
          ? createDecryptTransform(this.mediaKey)
          : createIdentityTransform();
      void readable.pipeThrough(transform).pipeTo(writable);
    } else if (this.canScriptTransform && this.useE2EE && this.mediaKey) {
      receiver.transform = new RTCRtpScriptTransform(this.getTransformWorker(), {
        operation: 'decrypt',
        key: this.mediaKey,
      });
    }
    this.appliedReceivers.add(receiver);
  }

  setMicEnabled(enabled: boolean): void {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = enabled));
  }

  setCameraEnabled(enabled: boolean): void {
    this.cameraOn = enabled;
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = enabled));
    this.sendCameraState();
  }

  /**
   * Re-arm per-session state after a peer left and the user chose to stay, so a
   * returning (or new) peer is detected and re-negotiates the E2EE layer.
   */
  resetForReconnect(): void {
    this.stopQualityMonitor();
    this.connection?.close();
    this.connection = null;
    this.peerGone = false;
    this.negotiated = false;
    this.callStarted = false;
    this.prevLost = 0;
    this.prevReceived = 0;
  }

  hangup(): void {
    this.closedByUs = true;
    this.stopQualityMonitor();
    this.connection?.close();
    this.connection = null;
    this.data?.close();
    this.data = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.peer?.destroy();
    this.peer = null;
    this.transformWorker?.terminate();
    this.transformWorker = null;
  }

  private describeError(type: string, fallback: string): string {
    switch (type) {
      case 'peer-unavailable':
        return 'Собеседник пока не в сети. Проверьте ссылку или подождите, пока он откроет звонок.';
      case 'unavailable-id':
        return 'Эта ссылка уже используется. Начните новый звонок.';
      case 'browser-incompatible':
        return 'Этот браузер не поддерживает звонки. Попробуйте Chrome или Safari.';
      case 'network':
        return 'Проблемы с сетью. Проверьте интернет-соединение.';
      default:
        return fallback || 'Не удалось соединиться. Попробуйте ещё раз.';
    }
  }
}
