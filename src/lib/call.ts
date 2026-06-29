import Peer from 'peerjs';
import type { DataConnection, MediaConnection } from 'peerjs';
import {
  computeSafetyCode,
  createDecryptTransform,
  createEncryptTransform,
  createIdentityTransform,
  deriveAuthKey,
  deriveMediaKey,
  randomNonce,
  signTranscript,
  supportsEncodedStreams,
  supportsScriptTransform,
  verifyTranscript,
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
  /** Safety code, bound to the DTLS fingerprints once the call connects. */
  onSafetyCode: (code: string) => void;
  onError: (message: string) => void;
}

/**
 * Authenticated capability handshake over the PeerJS data channel. The guest
 * sends `hello`, the host replies with `auth` carrying an HMAC over the
 * transcript, and the guest closes with `confirm` carrying its own HMAC. Only a
 * peer that knows the room secret can produce a valid MAC, so the exchange both
 * gates admission (host answers media only after `confirm` verifies) and makes
 * the negotiated `e2ee` flag tamper-evident (downgrade-resistant).
 */
interface HelloMessage {
  t: 'hello';
  e2ee: boolean;
  nonce: string;
}

interface AuthMessage {
  t: 'auth';
  e2ee: boolean;
  nonce: string;
  mac: string;
}

interface ConfirmMessage {
  t: 'confirm';
  mac: string;
}

function isHelloMessage(msg: unknown): msg is HelloMessage {
  const m = msg as { t?: unknown; e2ee?: unknown; nonce?: unknown };
  return (
    typeof msg === 'object' &&
    msg !== null &&
    m.t === 'hello' &&
    typeof m.e2ee === 'boolean' &&
    typeof m.nonce === 'string'
  );
}

function isAuthMessage(msg: unknown): msg is AuthMessage {
  const m = msg as { t?: unknown; e2ee?: unknown; nonce?: unknown; mac?: unknown };
  return (
    typeof msg === 'object' &&
    msg !== null &&
    m.t === 'auth' &&
    typeof m.e2ee === 'boolean' &&
    typeof m.nonce === 'string' &&
    typeof m.mac === 'string'
  );
}

function isConfirmMessage(msg: unknown): msg is ConfirmMessage {
  const m = msg as { t?: unknown; mac?: unknown };
  return (
    typeof msg === 'object' &&
    msg !== null &&
    m.t === 'confirm' &&
    typeof m.mac === 'string'
  );
}

/** Canonical handshake transcript; both peers build the identical string. */
function buildTranscript(
  guestNonce: string,
  hostNonce: string,
  e2eeGuest: boolean,
  e2eeHost: boolean,
): string {
  return [
    'telefone-handshake-v1',
    guestNonce,
    hostNonce,
    String(e2eeGuest),
    String(e2eeHost),
  ].join('|');
}

/** Pull the (first) DTLS certificate fingerprint out of an SDP blob. */
function extractFingerprint(sdp?: string | null): string | null {
  if (!sdp) return null;
  const match = sdp.match(/a=fingerprint:\S+\s+([0-9A-Fa-f:]+)/);
  return match ? match[1].toUpperCase() : null;
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

/**
 * Time to wait for the authenticated handshake to complete. If it does not,
 * the call is aborted (rather than silently downgraded) — an unauthenticated
 * peer must never be admitted.
 */
const HANDSHAKE_TIMEOUT_MS = 8000;

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
  private authKey: CryptoKey | null = null;
  private secret = '';
  /** Chrome path: createEncodedStreams() on the main thread. */
  private readonly canEncodedStreams: boolean = supportsEncodedStreams();
  /** Safari path: RTCRtpScriptTransform driven by a worker. */
  private readonly canScriptTransform: boolean = supportsScriptTransform();
  /** Whether THIS browser can do frame-level encryption in either flavour. */
  private readonly localSupport: boolean =
    this.canEncodedStreams || this.canScriptTransform;
  /**
   * Capability we ADVERTISE for the extra E2EE layer. Only the Chrome
   * createEncodedStreams path is verified to interoperate frame-for-frame; the
   * Safari RTCRtpScriptTransform worker path is not yet validated cross-browser
   * (it silently fails to decrypt, blanking the remote video), so we do not
   * negotiate the extra layer for it — those calls stay on DTLS-SRTP, which is
   * already end-to-end for direct P2P. The flag still rides inside the signed
   * handshake transcript, so it remains downgrade-resistant (C1).
   */
  private readonly e2eeCapable: boolean = this.canEncodedStreams;
  /** Lazily-created worker that runs the Safari encoded-transform. */
  private transformWorker: Worker | null = null;
  /** Negotiated result: extra E2EE layer is used only if BOTH peers support it. */
  private useE2EE = false;
  private negotiated = false;
  private callStarted = false;
  /** Handshake state. */
  private authed = false;
  private helloSeen = false;
  private guestNonce = '';
  private hostNonce = '';
  private transcript = '';
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Host: a media call that arrived before the peer was authenticated. */
  private pendingCall: MediaConnection | null = null;
  /** Host: once a peer is admitted, reject further callers until re-armed. */
  private roomLocked = false;
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
      this.secret = room.secret;
      this.mediaKey = await deriveMediaKey(room.secret);
      this.authKey = await deriveAuthKey(room.secret);
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
        // Guest opens a data channel and runs the authenticated handshake
        // before its media 'call' is answered.
        this.peer.on('connection', (data) => {
          if (this.roomLocked) {
            data.close();
            return;
          }
          if (this.data && this.data !== data) this.data.close();
          this.data = data;
          data.on('open', () => this.sendCameraState());
          data.on('data', (msg) => void this.onHostData(data, msg, cb));
        });
        this.peer.on('call', (call) => {
          if (this.roomLocked) {
            call.close();
            return;
          }
          // Buffer the media call until the peer proves knowledge of the secret.
          if (this.authed) this.answerCall(call, cb);
          else this.pendingCall = call;
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

  /** Abort the call without admitting the peer (failed/timed-out handshake). */
  private abortHandshake(cb: CallCallbacks, message: string): void {
    if (this.negotiated || this.callStarted) return;
    this.negotiated = true;
    this.clearHandshakeTimer();
    cb.onStatus('error');
    cb.onError(message);
    this.data?.close();
    this.data = null;
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  /**
   * Guest side: run the authenticated handshake over the data channel, then
   * place the media call. If the handshake fails or times out the call is
   * aborted — there is no silent DTLS-only fallback for an unauthenticated peer.
   */
  private negotiateThenCall(hostId: string, cb: CallCallbacks): void {
    const data = this.peer!.connect(hostId, { reliable: true });
    this.data = data;
    this.guestNonce = randomNonce();

    this.handshakeTimer = setTimeout(() => {
      this.abortHandshake(
        cb,
        'Не удалось установить защищённое соединение. Попробуйте ещё раз.',
      );
    }, HANDSHAKE_TIMEOUT_MS);

    const startMedia = () => {
      if (this.callStarted) return;
      this.callStarted = true;
      cb.onE2EE(this.useE2EE);
      const call = this.peer!.call(hostId, this.localStream!);
      this.connection = call;
      this.wireConnection(call, cb);
    };

    data.on('open', () => {
      data.send({ t: 'hello', e2ee: this.e2eeCapable, nonce: this.guestNonce });
      this.sendCameraState();
    });
    data.on('data', (msg) => {
      if (isCameraMessage(msg)) {
        cb.onRemoteVideo(msg.on);
        return;
      }
      if (this.authed || !isAuthMessage(msg)) return;
      void (async () => {
        this.hostNonce = msg.nonce;
        const transcript = buildTranscript(
          this.guestNonce,
          this.hostNonce,
          this.e2eeCapable,
          msg.e2ee,
        );
        const ok = await verifyTranscript(
          this.authKey!,
          'host',
          transcript,
          msg.mac,
        );
        if (!ok) {
          this.abortHandshake(
            cb,
            'Не удалось подтвердить собеседника: неверный код или попытка перехвата соединения.',
          );
          return;
        }
        const mac = await signTranscript(this.authKey!, 'guest', transcript);
        data.send({ t: 'confirm', mac });
        this.authed = true;
        this.negotiated = true;
        this.clearHandshakeTimer();
        this.useE2EE = this.e2eeCapable && msg.e2ee;
        startMedia();
      })();
    });
    data.on('error', () => {
      this.abortHandshake(
        cb,
        'Не удалось установить защищённое соединение. Попробуйте ещё раз.',
      );
    });
  }

  /**
   * Host side: process a data-channel message. Runs the authenticated handshake
   * (hello → auth → confirm); the buffered media call is answered only after
   * the guest's `confirm` MAC verifies.
   */
  private async onHostData(
    data: DataConnection,
    msg: unknown,
    cb: CallCallbacks,
  ): Promise<void> {
    if (isCameraMessage(msg)) {
      cb.onRemoteVideo(msg.on);
      return;
    }
    if (isHelloMessage(msg) && !this.helloSeen) {
      this.helloSeen = true;
      this.guestNonce = msg.nonce;
      this.hostNonce = randomNonce();
      this.transcript = buildTranscript(
        this.guestNonce,
        this.hostNonce,
        msg.e2ee,
        this.e2eeCapable,
      );
      this.useE2EE = this.e2eeCapable && msg.e2ee;
      const mac = await signTranscript(this.authKey!, 'host', this.transcript);
      data.send({ t: 'auth', e2ee: this.e2eeCapable, nonce: this.hostNonce, mac });
      // If the guest never confirms, drop this half-open attempt so a genuine
      // peer can retry (an attacker without the secret can't get past here).
      this.handshakeTimer = setTimeout(() => {
        if (this.authed) return;
        this.helloSeen = false;
        this.pendingCall?.close();
        this.pendingCall = null;
        data.close();
        if (this.data === data) this.data = null;
      }, HANDSHAKE_TIMEOUT_MS);
      return;
    }
    if (isConfirmMessage(msg) && this.helloSeen && !this.authed) {
      const ok = await verifyTranscript(
        this.authKey!,
        'guest',
        this.transcript,
        msg.mac,
      );
      if (!ok) {
        this.clearHandshakeTimer();
        this.helloSeen = false;
        this.pendingCall?.close();
        this.pendingCall = null;
        data.close();
        if (this.data === data) this.data = null;
        return;
      }
      this.authed = true;
      this.negotiated = true;
      this.clearHandshakeTimer();
      cb.onE2EE(this.useE2EE);
      if (this.pendingCall) {
        const call = this.pendingCall;
        this.pendingCall = null;
        this.answerCall(call, cb);
      }
    }
  }

  /** Host: admit an authenticated peer's media call and lock the room. */
  private answerCall(call: MediaConnection, cb: CallCallbacks): void {
    this.roomLocked = true;
    this.connection = call;
    call.answer(this.localStream ?? undefined);
    cb.onE2EE(this.useE2EE);
    this.wireConnection(call, cb);
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
            void this.emitSafetyCode(pc, cb);
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

  /**
   * Compute the safety code bound to both peers' DTLS fingerprints and the
   * shared secret, and hand it to the UI. A signaling MitM that swaps a DTLS
   * fingerprint changes this code, so a voice comparison detects it.
   */
  private async emitSafetyCode(
    pc: RTCPeerConnection,
    cb: CallCallbacks,
  ): Promise<void> {
    const local = extractFingerprint(pc.localDescription?.sdp);
    const remote = extractFingerprint(pc.remoteDescription?.sdp);
    if (local && remote) {
      cb.onSafetyCode(await computeSafetyCode(this.secret, local, remote));
    }
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
    this.clearHandshakeTimer();
    this.connection?.close();
    this.connection = null;
    this.peerGone = false;
    this.negotiated = false;
    this.callStarted = false;
    this.authed = false;
    this.helloSeen = false;
    this.roomLocked = false;
    this.pendingCall?.close();
    this.pendingCall = null;
    this.data?.close();
    this.data = null;
    this.guestNonce = '';
    this.hostNonce = '';
    this.transcript = '';
    this.prevLost = 0;
    this.prevReceived = 0;
  }

  hangup(): void {
    this.closedByUs = true;
    this.stopQualityMonitor();
    this.clearHandshakeTimer();
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
