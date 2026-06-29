import Peer from 'peerjs';
import type { DataConnection, MediaConnection } from 'peerjs';
import {
  createDecryptTransform,
  createEncryptTransform,
  deriveMediaKey,
  isInsertableStreamsSupported,
} from './crypto';
import { generatePeerId, type RoomCode } from './roomcode';

export type CallStatus =
  | 'idle'
  | 'preparing'
  | 'waiting'
  | 'connecting'
  | 'in-call'
  | 'ended'
  | 'error';

export type CallRole = 'host' | 'guest';

export interface CallCallbacks {
  onStatus: (status: CallStatus, detail?: string) => void;
  onLocalStream: (stream: MediaStream) => void;
  onRemoteStream: (stream: MediaStream) => void;
  /** Fires once the extra E2EE layer is negotiated with the peer. */
  onE2EE: (active: boolean) => void;
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
  /** Whether THIS browser can do frame-level encryption (Insertable Streams). */
  private readonly localSupport: boolean = isInsertableStreamsSupported();
  /** Negotiated result: extra E2EE layer is used only if BOTH peers support it. */
  private useE2EE = false;
  private negotiated = false;
  private callStarted = false;
  private readonly appliedSenders = new WeakSet<RTCRtpSender>();
  private readonly appliedReceivers = new WeakSet<RTCRtpReceiver>();

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
      // Enable the API when locally capable; transforms are still only applied
      // if the negotiation below decides both peers support it.
      if (this.localSupport) config.encodedInsertableStreams = true;

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
          data.on('data', (msg) => {
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

    data.on('open', () => data.send({ t: 'cap', e2ee: this.localSupport }));
    data.on('data', (msg) => {
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
        this.applyReceiverE2EE(event.receiver),
      );
      this.applySenderE2EE(pc);
    }

    call.on('stream', (remoteStream) => {
      cb.onRemoteStream(remoteStream);
      cb.onStatus('in-call');
    });
    call.on('close', () => cb.onStatus('ended'));
    call.on('error', (err) => {
      cb.onStatus('error');
      cb.onError(err.message);
    });
  }

  private applySenderE2EE(pc: RTCPeerConnection): void {
    if (!this.useE2EE || !this.mediaKey) return;
    for (const sender of pc.getSenders()) {
      if (
        !sender.track ||
        !sender.createEncodedStreams ||
        this.appliedSenders.has(sender)
      ) {
        continue;
      }
      const { readable, writable } = sender.createEncodedStreams();
      void readable
        .pipeThrough(createEncryptTransform(this.mediaKey))
        .pipeTo(writable);
      this.appliedSenders.add(sender);
    }
  }

  private applyReceiverE2EE(receiver: RTCRtpReceiver): void {
    if (!this.useE2EE || !this.mediaKey) return;
    if (!receiver.createEncodedStreams || this.appliedReceivers.has(receiver)) {
      return;
    }
    const { readable, writable } = receiver.createEncodedStreams();
    void readable
      .pipeThrough(createDecryptTransform(this.mediaKey))
      .pipeTo(writable);
    this.appliedReceivers.add(receiver);
  }

  setMicEnabled(enabled: boolean): void {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = enabled));
  }

  setCameraEnabled(enabled: boolean): void {
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = enabled));
  }

  hangup(): void {
    this.connection?.close();
    this.connection = null;
    this.data?.close();
    this.data = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.peer?.destroy();
    this.peer = null;
  }

  private describeError(type: string, fallback: string): string {
    switch (type) {
      case 'peer-unavailable':
        return 'Собеседник недоступен — проверьте код комнаты или дождитесь, пока он создаст звонок.';
      case 'unavailable-id':
        return 'Этот код комнаты уже занят. Создайте новый звонок.';
      case 'browser-incompatible':
        return 'Браузер не поддерживает WebRTC.';
      case 'network':
        return 'Проблема с сетью при подключении к сигналинг-серверу.';
      default:
        return fallback || 'Произошла ошибка соединения.';
    }
  }
}
