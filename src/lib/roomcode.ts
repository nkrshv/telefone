const SEPARATOR = '.';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Random PeerJS id (visible to the signaling server). */
export function generatePeerId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return 'tf-' + toBase64Url(bytes);
}

/** Random high-entropy secret (NEVER sent to the signaling server). */
export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return toBase64Url(bytes);
}

export interface RoomCode {
  peerId: string;
  secret: string;
}

export function encodeRoomCode({ peerId, secret }: RoomCode): string {
  return `${peerId}${SEPARATOR}${secret}`;
}

export function parseRoomCode(raw: string): RoomCode | null {
  const trimmed = raw.trim();
  const idx = trimmed.indexOf(SEPARATOR);
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  const peerId = trimmed.slice(0, idx);
  const secret = trimmed.slice(idx + 1);
  if (!peerId || !secret) return null;
  return { peerId, secret };
}

export function createRoomCode(): RoomCode {
  return { peerId: generatePeerId(), secret: generateSecret() };
}
