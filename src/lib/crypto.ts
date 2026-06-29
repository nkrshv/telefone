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

// ---------------------------------------------------------------------------
// Perfect Forward Secrecy (M1) + deterministic nonce / AAD (M2).
//
// On the Chrome createEncodedStreams path we upgrade the static per-call key to
// an ephemeral X25519 ECDH handshake mixed with the room secret, then run a
// symmetric hash ratchet so the key rolls forward during the call. Properties:
//   - PFS across calls and against secret leak: deriving the media key needs
//     the ephemeral private keys, which never leave the device and are dropped
//     when the call ends, so a later secret/link leak can't decrypt a recording.
//   - PFS within a call: each epoch key is HKDF'd from a chain value that is
//     immediately advanced and the old value discarded, so compromising the
//     current key does not reveal earlier epochs.
// The ephemeral public keys are carried inside the HMAC-signed handshake
// transcript (see call.ts), so a signaling MitM can't substitute its own.
// Browsers without WebCrypto X25519 fall back to the static-key transform.
// ---------------------------------------------------------------------------

const EMPTY_SALT = new Uint8Array(0);
/** Frames per epoch before the sender ratchets its key forward. */
const REKEY_FRAMES = 600;
/** How many past epoch keys a receiver keeps, to tolerate reordering. */
const EPOCH_WINDOW = 2;
/** Safety cap on how far ahead a single frame may advance the ratchet. */
const MAX_EPOCH_JUMP = 64;
/** Wire format: [version(1) | epoch(4) | counter(8)] then ciphertext+tag. */
const PFS_HEADER_LEN = 13;
const PFS_VERSION = 0x02;

/** WebCrypto's X25519 types are not in the DOM lib yet; localise the casts. */
const X25519: Algorithm = { name: 'X25519' } as Algorithm;

/** Uint8Array backed by a plain ArrayBuffer (what WebCrypto's BufferSource wants). */
type Bytes = Uint8Array<ArrayBuffer>;

async function hkdfBytes(
  ikm: BufferSource,
  salt: BufferSource,
  info: string,
  length = 32,
): Promise<Bytes> {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function epochKeyFromChain(chain: Bytes): Promise<CryptoKey> {
  const raw = await hkdfBytes(chain, EMPTY_SALT, 'telefone-epoch-key-v1');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

function advanceChain(chain: Bytes): Promise<Bytes> {
  return hkdfBytes(chain, EMPTY_SALT, 'telefone-epoch-next-v1');
}

function makeNonce(epoch: number, counter: number): Bytes {
  const nonce = new Uint8Array(IV_LENGTH);
  const view = new DataView(nonce.buffer);
  view.setUint32(0, epoch);
  view.setBigUint64(4, BigInt(counter));
  return nonce;
}

/** True iff this browser exposes WebCrypto X25519 (required for the PFS path). */
export async function supportsX25519(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey(X25519, true, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

export interface EcdhKeyPair {
  publicKeyB64: string;
  privateKey: CryptoKey;
}

/** Fresh ephemeral X25519 keypair; the public half is exported as base64. */
export async function generateEcdhKeyPair(): Promise<EcdhKeyPair> {
  const pair = (await crypto.subtle.generateKey(X25519, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return { publicKeyB64: bytesToBase64(new Uint8Array(raw)), privateKey: pair.privateKey };
}

/** Raw ECDH shared secret between our private key and the peer's public key. */
export async function deriveEcdhBits(
  privateKey: CryptoKey,
  peerPublicKeyB64: string,
): Promise<Bytes> {
  const peerPublic = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(peerPublicKeyB64),
    X25519,
    false,
    [],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: peerPublic } as unknown as Algorithm,
    privateKey,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Directional chain root: HKDF over the ECDH secret (IKM) salted by the room
 * secret, separated per direction and track kind so the (epoch, counter) nonce
 * can never repeat across the two senders sharing a key.
 */
export async function deriveChainRoot(
  ecdhBits: Bytes,
  secret: string,
  info: string,
): Promise<Bytes> {
  return hkdfBytes(ecdhBits, enc.encode(secret), info, 32);
}

/**
 * Encrypting transform for the PFS path: deterministic nonce (epoch‖counter),
 * the framing header bound as AAD, and a hash ratchet every REKEY_FRAMES.
 */
export function createPfsEncryptTransform(
  root: Bytes,
): TransformStream<RTCEncodedFrame, RTCEncodedFrame> {
  let chain = root.slice();
  let epoch = 0;
  let counter = 0;
  let epochKey: CryptoKey | null = null;
  return new TransformStream({
    async transform(frame, controller) {
      if (!epochKey) epochKey = await epochKeyFromChain(chain);
      if (counter >= REKEY_FRAMES) {
        const next = await advanceChain(chain);
        chain.fill(0);
        chain = next;
        epoch += 1;
        counter = 0;
        epochKey = await epochKeyFromChain(chain);
      }
      const header = new Uint8Array(PFS_HEADER_LEN);
      const view = new DataView(header.buffer);
      view.setUint8(0, PFS_VERSION);
      view.setUint32(1, epoch);
      view.setBigUint64(5, BigInt(counter));
      const nonce = makeNonce(epoch, counter);
      counter += 1;
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: header },
        epochKey,
        frame.data,
      );
      const out = new Uint8Array(PFS_HEADER_LEN + ciphertext.byteLength);
      out.set(header, 0);
      out.set(new Uint8Array(ciphertext), PFS_HEADER_LEN);
      frame.data = out.buffer;
      controller.enqueue(frame);
    },
  });
}

/** Decrypting transform for the PFS path; ratchets forward to each frame's epoch. */
export function createPfsDecryptTransform(
  root: Bytes,
): TransformStream<RTCEncodedFrame, RTCEncodedFrame> {
  const keys = new Map<number, CryptoKey>();
  let nextChain = root.slice();
  let nextEpoch = 0;

  async function deriveUpTo(target: number): Promise<void> {
    while (nextEpoch <= target) {
      keys.set(nextEpoch, await epochKeyFromChain(nextChain));
      const advanced = await advanceChain(nextChain);
      nextChain.fill(0);
      nextChain = advanced;
      const evict = nextEpoch - EPOCH_WINDOW;
      if (evict >= 0) keys.delete(evict);
      nextEpoch += 1;
    }
  }

  return new TransformStream({
    async transform(frame, controller) {
      const full = new Uint8Array(frame.data);
      if (full.byteLength <= PFS_HEADER_LEN) return;
      const header = full.subarray(0, PFS_HEADER_LEN);
      const view = new DataView(full.buffer, full.byteOffset, PFS_HEADER_LEN);
      if (view.getUint8(0) !== PFS_VERSION) return;
      const epoch = view.getUint32(1);
      const counter = Number(view.getBigUint64(5));
      if (epoch >= nextEpoch + MAX_EPOCH_JUMP) return;
      await deriveUpTo(epoch);
      const key = keys.get(epoch);
      if (!key) return;
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: makeNonce(epoch, counter), additionalData: header },
          key,
          full.subarray(PFS_HEADER_LEN),
        );
        frame.data = plaintext;
        controller.enqueue(frame);
      } catch {
        // Wrong key, tampered header, or tampered frame: drop it.
      }
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
