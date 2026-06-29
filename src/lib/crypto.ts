import type { RTCEncodedFrame } from './insertable-streams';

const enc = new TextEncoder();

const IV_LENGTH = 12;
const HKDF_SALT = enc.encode('telefone-e2ee-v1');
const HKDF_INFO = enc.encode('telefone-media-key');
const AUTH_SALT = enc.encode('telefone-auth-v1');
const AUTH_INFO = enc.encode('telefone-handshake-key');

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Derives an AES-256-GCM key from the shared room secret.
 * The secret never leaves the two peers, so the signaling server can never
 * derive this key.
 */
export async function deriveMediaKey(secret: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Short human-readable fingerprint shown to both peers for voice comparison.
 *
 * It binds the shared secret to BOTH ends' DTLS certificate fingerprints (read
 * from the negotiated SDP). A signaling-layer man-in-the-middle that rewrites
 * DTLS fingerprints — the classic attack against a malicious signaling relay,
 * and the only app-layer protection on the DTLS-SRTP-only path (e.g. iPhone) —
 * changes this code, so reading it aloud detects the MitM. The fingerprints are
 * sorted so both peers compute the same value regardless of role.
 */
export async function computeSafetyCode(
  secret: string,
  fingerprintA?: string | null,
  fingerprintB?: string | null,
): Promise<string> {
  let input = 'telefone-safety:' + secret;
  if (fingerprintA && fingerprintB) {
    const [a, b] = [fingerprintA.toUpperCase(), fingerprintB.toUpperCase()].sort();
    input += '|' + a + '|' + b;
  }
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  const bytes = new Uint8Array(digest);
  const groups: string[] = [];
  for (let i = 0; i < 4; i++) {
    const n = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
    groups.push(n.toString().padStart(5, '0'));
  }
  return groups.join(' ');
}

/**
 * Derives an HMAC-SHA-256 key from the room secret, used to authenticate the
 * data-channel handshake. Only a peer that knows the secret can produce a valid
 * MAC, which is what gates admission and makes the negotiated E2EE flag
 * tamper-evident (downgrade-resistant).
 */
export async function deriveAuthKey(secret: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: AUTH_SALT, info: AUTH_INFO },
    baseKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

/** Random 128-bit nonce (base64) for the handshake transcript. */
export function randomNonce(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
}

/** HMAC over a labelled handshake transcript; returns base64. */
export async function signTranscript(
  authKey: CryptoKey,
  label: string,
  transcript: string,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    authKey,
    enc.encode(label + '|' + transcript),
  );
  return bytesToBase64(new Uint8Array(mac));
}

/** Constant-time verification of a transcript MAC (via WebCrypto verify). */
export async function verifyTranscript(
  authKey: CryptoKey,
  label: string,
  transcript: string,
  macB64: string,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      'HMAC',
      authKey,
      base64ToBytes(macB64),
      enc.encode(label + '|' + transcript),
    );
  } catch {
    return false;
  }
}

/** TransformStream that encrypts each encoded media frame with AES-256-GCM. */
export function createEncryptTransform(
  key: CryptoKey,
): TransformStream<RTCEncodedFrame, RTCEncodedFrame> {
  return new TransformStream({
    async transform(frame, controller) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        frame.data,
      );
      const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
      out.set(iv, 0);
      out.set(new Uint8Array(ciphertext), IV_LENGTH);
      frame.data = out.buffer;
      controller.enqueue(frame);
    },
  });
}

/** TransformStream that decrypts each encoded media frame. */
export function createDecryptTransform(
  key: CryptoKey,
): TransformStream<RTCEncodedFrame, RTCEncodedFrame> {
  return new TransformStream({
    async transform(frame, controller) {
      const full = new Uint8Array(frame.data);
      if (full.byteLength <= IV_LENGTH) return;
      const iv = full.subarray(0, IV_LENGTH);
      const ciphertext = full.subarray(IV_LENGTH);
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv },
          key,
          ciphertext,
        );
        frame.data = plaintext;
        controller.enqueue(frame);
      } catch {
        // Authentication failed (wrong key or tampered frame): drop it.
      }
    },
  });
}

/**
 * Pass-through transform. Required when Insertable Streams is enabled on the
 * RTCPeerConnection but the extra E2EE layer is disabled (fallback): Chrome
 * blocks media unless the encoded streams are consumed, so we forward frames
 * unchanged instead of leaving them unpiped.
 */
export function createIdentityTransform(): TransformStream<
  RTCEncodedFrame,
  RTCEncodedFrame
> {
  return new TransformStream({
    transform(frame, controller) {
      controller.enqueue(frame);
    },
  });
}

/** Chrome/Edge flavour: RTCRtpSender.createEncodedStreams() on the main thread. */
export function supportsEncodedStreams(): boolean {
  return (
    typeof RTCRtpSender !== 'undefined' &&
    'createEncodedStreams' in RTCRtpSender.prototype
  );
}

/** Safari/standard flavour: RTCRtpScriptTransform (work runs in a worker). */
export function supportsScriptTransform(): boolean {
  return typeof RTCRtpScriptTransform !== 'undefined';
}

/** True when the browser supports the extra E2EE layer in either flavour. */
export function isInsertableStreamsSupported(): boolean {
  return supportsEncodedStreams() || supportsScriptTransform();
}
