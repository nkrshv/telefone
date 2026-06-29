import Peer from 'peerjs';
import type { MediaConnection } from 'peerjs';
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
  onError: (message: string) => void;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class CallManager {
  private peer: Peer | null = null;
  private connection: MediaConnection | null = null;
  private localStream: MediaStream | null = null;
  private mediaKey: CryptoKey | null = null;
  private readonly e2ee: boolean = isInsertableStreamsSupported();
  private readonly appliedSenders = new WeakSet<RTCRtpSender>();
  private readonly appliedReceivers = new WeakSet<RTCRtpReceiver>();

  get e2eeActive(): boolean {
    return this.e2ee;
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
      if (this.e2ee) config.encodedInsertableStreams = true;

      // Host keeps the shared peer id; guest gets a throwaway id.
      const peerId = role === 'host' ? room.peerId : generatePeerId();
      this.peer = new Peer(peerId, { config });

      this.peer.on('error', (err) => {
        cb.onStatus('error', err.type);
        cb.onError(this.describeError(err.type, err.message));
      });

      if (role === 'host') {
        this.peer.on('open', () => cb.onStatus('waiting'));
        this.peer.on('call', (call) => {
          this.connection = call;
          call.answer(this.localStream ?? undefined);
          this.wireConnection(call, cb);
        });
      } else {
        this.peer.on('open', () => {
          cb.onStatus('connecting');
          const call = this.peer!.call(room.peerId, this.localStream!);
          this.connection = call;
          this.wireConnection(call, cb);
        });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Не удалось получить доступ к камере/микрофону';
      cb.onStatus('error', message);
      cb.onError(message);
    }
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
    if (!this.e2ee || !this.mediaKey) return;
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
    if (!this.e2ee || !this.mediaKey) return;
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
