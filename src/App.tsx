import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { CallManager, type CallStatus, type QualityLevel } from './lib/call';
import { computeSafetyCode } from './lib/crypto';
import {
  createRoomCode,
  encodeRoomCode,
  parseRoomCode,
  type RoomCode,
} from './lib/roomcode';
import {
  IconCheck,
  IconChevron,
  IconClose,
  IconCopy,
  IconLink,
  IconLock,
  IconMic,
  IconMicOff,
  IconPhoneOff,
  IconShield,
  IconSun,
  IconTelegram,
  IconUser,
  IconVideo,
  IconVideoOff,
  IconWhatsApp,
} from './icons';

type Screen = 'home' | 'join' | 'call' | 'ended';

function readSharedCode(): string {
  const hash = window.location.hash.slice(1);
  if (!hash) return '';
  const decoded = decodeURIComponent(hash);
  return parseRoomCode(decoded) ? decoded : '';
}

const STATUS_LABEL: Record<CallStatus, string> = {
  idle: '',
  preparing: 'Включаем камеру и микрофон…',
  waiting: 'Ждём собеседника…',
  connecting: 'Соединяем…',
  'in-call': 'На связи',
  reconnecting: 'Восстанавливаем связь…',
  'peer-left': 'Собеседник вышел из звонка',
  ended: 'Звонок завершён',
  error: 'Что-то пошло не так',
};

function securityBadge(e2ee: boolean | null): {
  cls: string;
  label: string;
  title: string;
} {
  if (e2ee === null) {
    return {
      cls: 'pending',
      label: 'Защищаем соединение…',
      title: 'Договариваемся о шифровании с собеседником.',
    };
  }
  if (e2ee) {
    return {
      cls: 'ok',
      label: 'Сквозное шифрование',
      title: 'Звонок видите только вы двое — даже мы не имеем к нему доступа.',
    };
  }
  return {
    cls: 'warn',
    label: 'Соединение защищено',
    title:
      'Звонок зашифрован. Самый сильный (сквозной) режим недоступен — у собеседника старый браузер.',
  };
}

const QUALITY_LABEL: Record<QualityLevel, string> = {
  0: 'Оцениваем связь…',
  1: 'Слабая связь',
  2: 'Связь неустойчива',
  3: 'Хорошая связь',
  4: 'Отличная связь',
};

function QualityBars({ level }: { level: QualityLevel }) {
  return (
    <span
      className={`quality q${level}`}
      title={QUALITY_LABEL[level]}
      role="img"
      aria-label={QUALITY_LABEL[level]}
    >
      {[1, 2, 3, 4].map((b) => (
        <span key={b} className={`bar ${level >= b ? 'on' : ''}`} />
      ))}
    </span>
  );
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function SecurityModal({
  e2ee,
  safety,
  onClose,
}: {
  e2ee: boolean | null;
  safety: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const layers = [
    {
      on: true,
      title: 'Звонок идёт напрямую',
      text: 'Видео и звук передаются между вашими устройствами, минуя наши серверы.',
    },
    {
      on: true,
      title: 'Базовое шифрование (DTLS-SRTP)',
      text: 'Стандартная защита WebRTC — соединение зашифровано в пути.',
    },
    {
      on: e2ee === true,
      title: 'Сквозное шифрование (AES-256-GCM)',
      text:
        e2ee === true
          ? 'Каждый кадр дополнительно шифруется ключом из вашей ссылки. Доступ есть только у вас двоих — даже у нас его нет.'
          : e2ee === null
            ? 'Договариваемся с собеседником…'
            : 'Недоступно: у собеседника более старый браузер. Звонок всё равно зашифрован.',
    },
  ];

  const heading =
    e2ee === true
      ? 'Звонок под сквозным шифрованием'
      : e2ee === null
        ? 'Защищаем соединение…'
        : 'Звонок защищён';

  return (
    <div className="sec-backdrop" onClick={onClose}>
      <div
        className="sec-modal"
        role="dialog"
        aria-modal="true"
        aria-label="О защите звонка"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="sec-close"
          onClick={onClose}
          aria-label="Закрыть"
          title="Закрыть"
        >
          <IconClose width={18} height={18} />
        </button>
        <div className={`sec-hero ${e2ee ? 'ok' : e2ee === null ? 'pending' : 'warn'}`}>
          <IconLock width={26} height={26} />
        </div>
        <h2 className="sec-title">{heading}</h2>
        <p className="sec-sub">
          Мы не видим и не храним ваши звонки. Вот что защищает этот разговор:
        </p>

        <ul className="sec-layers">
          {layers.map((l) => (
            <li key={l.title} className={l.on ? 'on' : 'off'}>
              <span className="sec-dot">
                {l.on ? <IconCheck width={14} height={14} /> : null}
              </span>
              <div>
                <strong>{l.title}</strong>
                <span>{l.text}</span>
              </div>
            </li>
          ))}
        </ul>

        {safety && (
          <div className="sec-safety">
            <p className="sec-safety-label">Код безопасности</p>
            <p className="sec-safety-code">{safety}</p>
            <p className="sec-safety-hint">
              Назовите эти числа собеседнику вслух. Если они совпали — на линии
              точно только вы двое, и никто не подменил соединение.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

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
  const [e2ee, setE2ee] = useState<boolean | null>(null);
  const [hasRemote, setHasRemote] = useState(false);
  const [remoteVideoOn, setRemoteVideoOn] = useState(true);
  const [quality, setQuality] = useState<QualityLevel>(0);
  const [duration, setDuration] = useState(0);
  const [endedDuration, setEndedDuration] = useState(0);
  const [glow, setGlow] = useState(true);
  const [securityOpen, setSecurityOpen] = useState(false);
  const badge = securityBadge(e2ee);

  const managerRef = useRef<CallManager | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const glowVideoRef = useRef<HTMLVideoElement>(null);

  const buildCallbacks = useCallback(
    () => ({
      onStatus: (s: CallStatus) => setStatus(s),
      onLocalStream: (stream: MediaStream) => {
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      },
      onRemoteStream: (stream: MediaStream) => {
        setHasRemote(true);
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
        if (glowVideoRef.current) glowVideoRef.current.srcObject = stream;
      },
      onE2EE: (active: boolean) => setE2ee(active),
      onRemoteVideo: (enabled: boolean) => setRemoteVideoOn(enabled),
      onQuality: (level: QualityLevel) => setQuality(level),
      onError: (message: string) => setError(message),
    }),
    [],
  );

  const beginCall = useCallback(
    async (role: 'host' | 'guest', r: RoomCode) => {
      setError('');
      setHasRemote(false);
      setRemoteVideoOn(true);
      setQuality(0);
      setDuration(0);
      setE2ee(null);
      setSecurityOpen(false);
      setRoom(r);
      setScreen('call');
      setSafety(await computeSafetyCode(r.secret));
      const manager = new CallManager();
      managerRef.current = manager;
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
      setError('Похоже, ссылка или код неверные.');
      return;
    }
    void beginCall('guest', parsed);
  }, [beginCall, joinInput]);

  const teardownCall = useCallback(() => {
    managerRef.current?.hangup();
    managerRef.current = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (glowVideoRef.current) glowVideoRef.current.srcObject = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    setMicOn(true);
    setCamOn(true);
    setHasRemote(false);
    setSecurityOpen(false);
    history.replaceState(null, '', window.location.pathname);
  }, []);

  // End the call but land on a post-call screen instead of jumping home.
  const endCall = useCallback(() => {
    setEndedDuration(duration);
    teardownCall();
    setStatus('ended');
    setScreen('ended');
  }, [duration, teardownCall]);

  const goHome = useCallback(() => {
    teardownCall();
    setRoom(null);
    setStatus('idle');
    setScreen('home');
  }, [teardownCall]);

  const callAgain = useCallback(() => {
    void beginCall('host', createRoomCode());
  }, [beginCall]);

  const stayInCall = useCallback(() => {
    managerRef.current?.resetForReconnect();
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setHasRemote(false);
    setRemoteVideoOn(true);
    setQuality(0);
    setDuration(0);
    setStatus('waiting');
  }, []);

  useEffect(() => {
    return () => managerRef.current?.hangup();
  }, []);

  // Tick the call-duration clock only while actually connected.
  useEffect(() => {
    if (status !== 'in-call') return;
    const id = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

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
  const shareText = 'Давай созвонимся в telefone — это личный и зашифрованный звонок';

  const copyCode = async () => {
    if (!shareLink) return;
    await navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const shareVia = (app: 'whatsapp' | 'telegram') => {
    if (!shareLink) return;
    const url =
      app === 'whatsapp'
        ? `https://wa.me/?text=${encodeURIComponent(`${shareText}: ${shareLink}`)}`
        : `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${encodeURIComponent(shareText)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const peerLeft = status === 'peer-left';
  const reconnecting = status === 'reconnecting';
  const cameraOffPlaceholder =
    hasRemote && !peerLeft && !reconnecting && !remoteVideoOn;

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">telefone</span>
        <span className="tagline">личные видеозвонки</span>
      </header>

      {screen === 'home' && (
        <main className="card">
          <h1>Звонки, которые видите только вы</h1>
          <p className="sub">
            Видео идёт напрямую между вами. Никто не подключится без
            вашей ссылки.
          </p>
          <button className="primary" onClick={handleHost}>
            Начать звонок
          </button>
          <button className="ghost" onClick={() => setScreen('join')}>
            У меня есть ссылка
          </button>
        </main>
      )}

      {screen === 'join' && (
        <main className="card">
          <h1>Присоединиться</h1>
          <p className="sub">Вставьте ссылку или код, которые прислал собеседник.</p>
          <input
            className="code-input"
            placeholder="Ссылка или код"
            value={joinInput}
            autoFocus
            onChange={(e) => setJoinInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
          />
          {error && <p className="error">{error}</p>}
          <button className="primary" onClick={handleJoin}>
            Присоединиться
          </button>
          <button className="ghost" onClick={() => setScreen('home')}>
            Назад
          </button>
        </main>
      )}

      {screen === 'call' && (
        <main className="call">
          <div className={`stage-wrap ${glow && hasRemote ? 'glow-on' : ''}`}>
          <video
            ref={glowVideoRef}
            className="stage-glow"
            autoPlay
            playsInline
            muted
            aria-hidden="true"
          />
          <div className="video-stage">
            <video
              ref={remoteVideoRef}
              className="remote-video"
              autoPlay
              playsInline
            />

            {hasRemote && status === 'in-call' && (
              <div className="stage-pill">
                <span className="live-dot" />
                {formatDuration(duration)}
              </div>
            )}

            {reconnecting && hasRemote && (
              <div className="stage-banner">
                <span className="spinner sm" />
                Связь прерывается — восстанавливаем…
              </div>
            )}

            {cameraOffPlaceholder && (
              <div className="overlay soft">
                <div className="avatar">
                  <IconUser width={34} height={34} />
                </div>
                <p>Камера собеседника выключена</p>
              </div>
            )}

            {peerLeft && (
              <div className="overlay">
                <div className="avatar">
                  <IconUser width={34} height={34} />
                </div>
                <p className="overlay-title">Собеседник вышел из звонка</p>
                <p className="overlay-sub">
                  Ссылка ещё работает — он может вернуться.
                </p>
                <div className="overlay-actions">
                  <button className="ghost" onClick={stayInCall}>
                    Остаться
                  </button>
                  <button className="primary danger-fill" onClick={endCall}>
                    Завершить
                  </button>
                </div>
              </div>
            )}

            {!hasRemote && !peerLeft && (
              <div className="overlay">
                <div className="spinner" />
                <p>{STATUS_LABEL[status]}</p>
                {error && <p className="error">{error}</p>}
              </div>
            )}

            <div className="local">
              <video
                ref={localVideoRef}
                className="local-video"
                autoPlay
                playsInline
                muted
              />
              <span className="local-tag">
                {!micOn && <IconMicOff width={13} height={13} />}
                Вы
              </span>
              {!camOn && (
                <div className="local-camoff">
                  <IconVideoOff width={20} height={20} />
                </div>
              )}
            </div>
          </div>
          </div>

          {!hasRemote && room && !peerLeft && (
            <div className="invite">
              <p className="invite-label">
                <IconLink width={16} height={16} />
                Поделитесь ссылкой с собеседником
              </p>
              <code className="room-code">{encodeRoomCode(room)}</code>
              <div className="invite-actions">
                <button className="copy" onClick={copyCode}>
                  {copied ? (
                    <>
                      <IconCheck width={17} height={17} /> Скопировано
                    </>
                  ) : (
                    <>
                      <IconCopy width={17} height={17} /> Копировать ссылку
                    </>
                  )}
                </button>
                <button
                  className="share wa"
                  onClick={() => shareVia('whatsapp')}
                  title="Отправить в WhatsApp"
                  aria-label="Отправить ссылку в WhatsApp"
                >
                  <IconWhatsApp width={18} height={18} />
                </button>
                <button
                  className="share tg"
                  onClick={() => shareVia('telegram')}
                  title="Отправить в Telegram"
                  aria-label="Отправить ссылку в Telegram"
                >
                  <IconTelegram width={18} height={18} />
                </button>
              </div>
            </div>
          )}

          <div className="status-strip">
            <button
              className={`badge ${badge.cls}`}
              onClick={() => setSecurityOpen(true)}
              title="Подробнее о защите звонка"
              aria-label="Подробнее о защите звонка"
            >
              <IconShield className="badge-icon" width={16} height={16} />
              {badge.label}
              <IconChevron className="badge-more" width={15} height={15} />
            </button>
            <div className="status-right">
              {hasRemote && status === 'in-call' && (
                <QualityBars level={quality} />
              )}
              {safety && (
                <button
                  className="safety"
                  onClick={() => setSecurityOpen(true)}
                  title="Назовите эти числа друг другу. Совпали — значит, на линии только вы двое."
                >
                  <span className="safety-label">Код безопасности</span>{' '}
                  <strong>{safety}</strong>
                </button>
              )}
            </div>
          </div>

          <div className="controls">
            <button
              className={`ctrl ${micOn ? '' : 'off'}`}
              onClick={toggleMic}
              title={micOn ? 'Выключить микрофон' : 'Включить микрофон'}
              aria-label={micOn ? 'Выключить микрофон' : 'Включить микрофон'}
              aria-pressed={!micOn}
            >
              {micOn ? <IconMic /> : <IconMicOff />}
            </button>
            <button
              className={`ctrl ${camOn ? '' : 'off'}`}
              onClick={toggleCam}
              title={camOn ? 'Выключить камеру' : 'Включить камеру'}
              aria-label={camOn ? 'Выключить камеру' : 'Включить камеру'}
              aria-pressed={!camOn}
            >
              {camOn ? <IconVideo /> : <IconVideoOff />}
            </button>
            <button
              className={`ctrl ${glow ? 'active' : ''}`}
              onClick={() => setGlow((g) => !g)}
              title={glow ? 'Выключить подсветку' : 'Включить подсветку'}
              aria-label={glow ? 'Выключить подсветку' : 'Включить подсветку'}
              aria-pressed={glow}
            >
              <IconSun />
            </button>
            <button
              className="ctrl hangup"
              onClick={endCall}
              title="Завершить звонок"
              aria-label="Завершить звонок"
            >
              <IconPhoneOff />
            </button>
          </div>

          {securityOpen && (
            <SecurityModal
              e2ee={e2ee}
              safety={safety}
              onClose={() => setSecurityOpen(false)}
            />
          )}
        </main>
      )}

      {screen === 'ended' && (
        <main className="card">
          <div className="ended-icon">
            <IconPhoneOff width={26} height={26} />
          </div>
          <h1>Звонок завершён</h1>
          <p className="sub">
            {endedDuration > 0
              ? `Длительность звонка — ${formatDuration(endedDuration)}.`
              : 'Звонок завершён.'}{' '}
            Спасибо, что были на связи.
          </p>
          <button className="primary" onClick={callAgain}>
            Начать новый звонок
          </button>
          <button className="ghost" onClick={goHome}>
            На главную
          </button>
        </main>
      )}

      <footer className="footer">
        Мы не видим и не храним ваши звонки — видео идёт напрямую между
        устройствами.
      </footer>
    </div>
  );
}

export default App;
