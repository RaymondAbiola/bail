import { base58, base64 } from "@scure/base";

const utf8 = new TextEncoder();

export type EventId = number | bigint;

export function text(value: string): Uint8Array {
  return utf8.encode(value);
}

/** Each field is its length as 4 little-endian bytes, then its bytes, exactly as the contract hashes them. */
export function fields(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + 4 + part.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const part of parts) {
    view.setUint32(at, part.length, true);
    out.set(part, at + 4);
    at += 4 + part.length;
  }
  return out;
}

export function eventIdBytes(eventId: EventId): Uint8Array {
  const id = BigInt(eventId);
  if (typeof eventId === "number" && !Number.isSafeInteger(eventId)) {
    throw new RangeError(`event id ${eventId} is not a safe integer`);
  }
  if (id < 0n || id >= 1n << 64n) throw new RangeError(`event id ${eventId} is not a u64`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, id, true);
  return out;
}

export function slotByte(slot: number): Uint8Array {
  if (!Number.isInteger(slot) || slot < 0 || slot > 255) throw new RangeError(`slot ${slot} is not a u8`);
  return Uint8Array.of(slot);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64(bytes: Uint8Array): string {
  return base64.encode(bytes);
}

export function fromBase64(value: string): Uint8Array {
  return base64.decode(value);
}

export function encodePublicKey(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new RangeError("an ed25519 public key is 32 bytes");
  return `ed25519:${base58.encode(bytes)}`;
}

/** Accepts only `ed25519:<base58>`, the form the contract writes back. */
export function decodePublicKey(key: string): Uint8Array {
  if (!key.startsWith("ed25519:")) throw new Error(`not an ed25519 key: ${key}`);
  const bytes = base58.decode(key.slice("ed25519:".length));
  if (bytes.length !== 32) throw new Error(`not an ed25519 key: ${key}`);
  return bytes;
}

export function encodeSecretKey(seed: Uint8Array, publicKey: Uint8Array): string {
  const both = new Uint8Array(64);
  both.set(seed);
  both.set(publicKey, 32);
  return `ed25519:${base58.encode(both)}`;
}

export function decodeSecretKey(key: string): { seed: Uint8Array; publicKey: Uint8Array } {
  if (!key.startsWith("ed25519:")) throw new Error("not an ed25519 secret key");
  const bytes = base58.decode(key.slice("ed25519:".length));
  if (bytes.length !== 64) throw new Error("not an ed25519 secret key");
  return { seed: bytes.slice(0, 32), publicKey: bytes.slice(32) };
}
