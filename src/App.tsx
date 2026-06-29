import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { CallManager, type CallStatus } from './lib/call';
import { computeSafetyCode } from './lib/crypto';
import {
  createRoomCode,
  encodeRoomCode,
  parseRoomCode,
  type RoomCode,
} from './lib/roomcode';

type Screen = 'home' | 'join' | 'call';

function readSharedCode(): string {
  const hash = window.location.hash.slice(1);
  if (!hash) return '';
  const decoded = decodeURIComponent(hash);
  return parseRoomCode(decoded) ? decoded : '';
}

const STATUS_LABEL: Record<CallStatus, string> = {
  idle: '',
  preparing: 'Запрашиваем камеру и микрофон…',
  waiting: 'Ожидаем собеседника…',
  connecting: 'Подключаемся…',
  'in-call': 'Зашифрованный звонок',
  ended: 'Звонок завершён',
  error: 'Ошибка',
};

function App() {
  const sharedCode = readSharedCode();
  const [screen, setScreen] = useState<Screen>(sharedCode ? 'join' : 'home');
  const [status, setStatus] = useState<CallStatus>('idle');
  const [room, setRoom] = useState<RoomCode | null>(null);
  const [joinInput, setJoinInput] = useState(sharedCode);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [safety, setSafety] = useState('');
  const [e2ee, setE2ee] = useState(true);
  const [hasRemote, setHasRemote] = useState(false);

  const managerRef = useRef<CallManager | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const buildCallbacks = useCallback(
    () => ({
      onStatus: (s: CallStatus) => setStatus(s),
      onLocalStream: (stream: MediaStream) => {
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      },
      onRemoteStream: (stream: MediaStream) => {
        setHasRemote(true);
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
      },
      onError: (message: string) => setError(message),
    }),
    [],
  );

  const beginCall = useCallback(
    async (role: 'host' | 'guest', r: RoomCode) => {
      setError('');
      setHasRemote(false);
      setRoom(r);
      setScreen('call');
      setSafety(await computeSafetyCode(r.secret));
      const manager = new CallManager();
      managerRef.current = manager;
      setE2ee(manager.e2eeActive);
      await manager.start(role, r, buildCallbacks());
    },
    [buildCallbacks],
  );

  const handleHost = useCallback(() => {
    void beginCall('host', createRoomCode());
  }, [beginCall]);

  const handleJoin = useCallback(() => {
    const parsed = parseRoomCode(joinInput);
    if (!parsed) {
      setError('Неверный код комнаты.');
      return;
    }
    void beginCall('guest', parsed);
  }, [beginCall, joinInput]);

  const endCall = useCallback(() => {
    managerRef.current?.hangup();
    managerRef.current = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    setRoom(null);
    setStatus('idle');
    setScreen('home');
    setMicOn(true);
    setCamOn(true);
    history.replaceState(null, '', window.location.pathname);
  }, []);

  useEffect(() => {
    return () => managerRef.current?.hangup();
  }, []);

  const toggleMic = () => {
    const next = !micOn;
    setMicOn(next);
    managerRef.current?.setMicEnabled(next);
  };

  const toggleCam = () => {
    const next = !camOn;
    setCamOn(next);
    managerRef.current?.setCameraEnabled(next);
  };

  const shareLink = room
    ? `${window.location.origin}${window.location.pathname}#${encodeRoomCode(room)}`
    : '';

  const copyCode = async () => {
    if (!shareLink) return;
    await navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">telefone</span>
        <span className="tagline">защищённые P2P-звонки</span>
      </header>

      {screen === 'home' && (
        <main className="card">
          <h1>Защищённый видеозвонок</h1>
          <p className="sub">
            Сквозное шифрование. Видео идёт напрямую между вами, минуя сервер.
          </p>
          <button className="primary" onClick={handleHost}>
            Создать звонок
          </button>
          <button className="ghost" onClick={() => setScreen('join')}>
            Подключиться по коду
          </button>
        </main>
      )}

      {screen === 'join' && (
        <main className="card">
          <h1>Подключиться</h1>
          <p className="sub">Вставьте код комнаты или ссылку от собеседника.</p>
          <input
            className="code-input"
            placeholder="Код комнаты…"
            value={joinInput}
            onChange={(e) => setJoinInput(e.target.value)}
          />
          {error && <p className="error">{error}</p>}
          <button className="primary" onClick={handleJoin}>
            Войти в звонок
          </button>
          <button className="ghost" onClick={() => setScreen('home')}>
            Назад
          </button>
        </main>
      )}

      {screen === 'call' && (
        <main className="call">
          <div className="video-stage">
            <video
              ref={remoteVideoRef}
              className="remote-video"
              autoPlay
              playsInline
            />
            {!hasRemote && (
              <div className="overlay">
                <div className="spinner" />
                <p>{STATUS_LABEL[status]}</p>
                {error && <p className="error">{error}</p>}
              </div>
            )}
            <video
              ref={localVideoRef}
              className="local-video"
              autoPlay
              playsInline
              muted
            />
          </div>

          {!hasRemote && room && (
            <div className="invite">
              <p className="invite-label">Отправьте этот код собеседнику:</p>
              <code className="room-code">{encodeRoomCode(room)}</code>
              <button className="copy" onClick={copyCode}>
                {copied ? 'Скопировано' : 'Копировать ссылку'}
              </button>
            </div>
          )}

          <div className="status-strip">
            <span className={`badge ${e2ee ? 'ok' : 'warn'}`}>
              {e2ee
                ? '🔒 E2EE: AES-256-GCM + DTLS-SRTP'
                : '⚠ Только DTLS-SRTP (браузер без Insertable Streams)'}
            </span>
            {safety && (
              <span className="safety" title="Сверьте этот код голосом с собеседником">
                Код безопасности: <strong>{safety}</strong>
              </span>
            )}
          </div>

          <div className="controls">
            <button
              className={`ctrl ${micOn ? '' : 'off'}`}
              onClick={toggleMic}
            >
              {micOn ? '🎤' : '🔇'}
            </button>
            <button
              className={`ctrl ${camOn ? '' : 'off'}`}
              onClick={toggleCam}
            >
              {camOn ? '📹' : '🚫'}
            </button>
            <button className="ctrl hangup" onClick={endCall}>
              ✕
            </button>
          </div>
        </main>
      )}

      <footer className="footer">
        Сигналинг-сервер не видит ключи шифрования. Код безопасности защищает от
        подмены.
      </footer>
    </div>
  );
}

export default App;
