import type { RTCEncodedFrame } from './insertable-streams';

const enc = new TextEncoder();

const IV_LENGTH = 12;
const HKDF_SALT = enc.encode('telefone-e2ee-v1');
const HKDF_INFO = enc.encode('telefone-media-key');

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
 * Short human-readable fingerprint of the shared secret. Both peers compute
 * the same value; reading it aloud lets users detect a man-in-the-middle.
 */
export async function computeSafetyCode(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    enc.encode('telefone-safety:' + secret),
  );
  const bytes = new Uint8Array(digest);
  const groups: string[] = [];
  for (let i = 0; i < 4; i++) {
    const n = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
    groups.push(n.toString().padStart(5, '0'));
  }
  return groups.join(' ');
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

/** True when the browser supports the extra E2EE layer (Insertable Streams). */
export function isInsertableStreamsSupported(): boolean {
  return (
    typeof RTCRtpSender !== 'undefined' &&
    'createEncodedStreams' in RTCRtpSender.prototype
  );
}
