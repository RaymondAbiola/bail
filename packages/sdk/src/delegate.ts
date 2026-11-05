import { sha256 } from "@noble/hashes/sha2.js";

import { decodePublicKey, text, toBase64, toHex } from "./codec.ts";

/** NEP-461 prefix for NEP-366 meta transactions: 2^30 + 366. */
const DELEGATE_PREFIX = 2 ** 30 + 366;
const FUNCTION_CALL = 2;
const ED25519 = 0;
/** What the RSVP's `ft_transfer_call` may burn, including the deposit callback. */
export const RSVP_GAS = 100_000_000_000_000n;

class Borsh {
  readonly #parts: Uint8Array[] = [];

  u8(value: number): this {
    this.#parts.push(Uint8Array.of(value));
    return this;
  }

  u32(value: number): this {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    this.#parts.push(out);
    return this;
  }

  u64(value: bigint): this {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, value, true);
    this.#parts.push(out);
    return this;
  }

  u128(value: bigint): this {
    return this.u64(value & 0xffff_ffff_ffff_ffffn).u64(value >> 64n);
  }

  bytes(value: Uint8Array): this {
    this.u32(value.length);
    this.#parts.push(value);
    return this;
  }

  string(value: string): this {
    return this.bytes(text(value));
  }

  raw(value: Uint8Array): this {
    this.#parts.push(value);
    return this;
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.#parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of this.#parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

export interface FunctionCallDelegate {
  senderId: string;
  receiverId: string;
  methodName: string;
  args: object;
  gas: bigint;
  deposit: bigint;
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: string;
}

/** The borsh bytes of a one-function-call `DelegateAction`, as nearcore lays them out. */
export function encodeDelegateAction(d: FunctionCallDelegate): Uint8Array {
  return new Borsh()
    .string(d.senderId)
    .string(d.receiverId)
    .u32(1)
    .u8(FUNCTION_CALL)
    .string(d.methodName)
    .bytes(text(JSON.stringify(d.args)))
    .u64(d.gas)
    .u128(d.deposit)
    .u64(d.nonce)
    .u64(d.maxBlockHeight)
    .u8(ED25519)
    .raw(decodePublicKey(d.publicKey))
    .done();
}

/** What the sender signs: the hash of the prefixed delegate action. */
export function delegateHash(d: FunctionCallDelegate): Uint8Array {
  const prefix = new Borsh().u32(DELEGATE_PREFIX).done();
  const body = encodeDelegateAction(d);
  const both = new Uint8Array(prefix.length + body.length);
  both.set(prefix);
  both.set(body, prefix.length);
  return sha256(both);
}

/** A `SignedDelegate`, base64-encoded for the relayer. */
export function encodeSignedDelegate(d: FunctionCallDelegate, signature: Uint8Array): string {
  return toBase64(new Borsh().raw(encodeDelegateAction(d)).u8(ED25519).raw(signature).done());
}

/** The implicit account a ticket key controls: the key's 32 bytes in hex. */
export function implicitAccountId(publicKey: string): string {
  return toHex(decodePublicKey(publicKey));
}

/** The RSVP transfer an attendee's implicit account asks a relayer to sponsor. */
export function rsvpDelegate(options: {
  publicKey: string;
  token: string;
  contractId: string;
  deposit: string;
  note: string;
  nonce: bigint;
  maxBlockHeight: bigint;
}): FunctionCallDelegate {
  return {
    senderId: implicitAccountId(options.publicKey),
    receiverId: options.token,
    methodName: "ft_transfer_call",
    args: { receiver_id: options.contractId, amount: options.deposit, msg: options.note },
    gas: RSVP_GAS,
    deposit: 1n,
    nonce: options.nonce,
    maxBlockHeight: options.maxBlockHeight,
    publicKey: options.publicKey,
  };
}

