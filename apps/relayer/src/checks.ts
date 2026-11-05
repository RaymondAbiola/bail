import { ed25519 } from "@noble/curves/ed25519.js";

import {
  cancelMessage,
  catchMessage,
  decodePublicKey,
  encodePublicKey,
  flagMessage,
  fromBase64,
  vouchMessage,
} from "@bail/sdk";

export const KINDS = { catch: "catch", flag: "flag_slot", cancel: "cancel_rsvp", vouch: "vouch" } as const;
export type Kind = keyof typeof KINDS;

const MAX_SLOTS = 5;

export class BadRequest extends Error {}

export interface Checked {
  kind: Kind;
  method: (typeof KINDS)[Kind];
  args: Record<string, unknown>;
  eventId: number;
  /** The ticket whose own signature authorizes the action. */
  signer: string;
}

type Body = Record<string, unknown>;

function int(body: Body, name: string, max: number): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new BadRequest(`${name} must be an integer from 0 to ${max}`);
  }
  return value;
}

function key(body: Body, name: string): string {
  const value = body[name];
  try {
    if (typeof value !== "string") throw new Error();
    return encodePublicKey(decodePublicKey(value));
  } catch {
    throw new BadRequest(`${name} must be an ed25519 public key`);
  }
}

function bytes(body: Body, name: string, length: number): Uint8Array {
  const value = body[name];
  try {
    if (typeof value !== "string") throw new Error();
    const decoded = fromBase64(value);
    if (decoded.length !== length) throw new Error();
    return decoded;
  } catch {
    throw new BadRequest(`${name} must be ${length} bytes of base64`);
  }
}

/**
 * Parses an action and checks its ticket signature, exactly as the contract will, so
 * a bad action is turned away here instead of costing gas onchain.
 */
export function checkAction(kind: string, body: unknown, contractId: string): Checked {
  if (!(kind in KINDS)) throw new BadRequest(`unknown action ${kind}`);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequest("the body must be a JSON object");
  }
  const b = body as Body;
  const eventId = int(b, "event_id", Number.MAX_SAFE_INTEGER);
  const signature = bytes(b, "signature", 64);
  let args: Record<string, unknown>;
  let signer: string;
  let message: string;

  if (kind === "catch") {
    const slot = int(b, "slot", MAX_SLOTS - 1);
    const attempt = int(b, "attempt", 0xffff_ffff);
    signer = key(b, "ticket_key");
    const proof = bytes(b, "proof", 32);
    message = catchMessage(contractId, eventId, slot, attempt, proof);
    args = { event_id: eventId, slot, attempt, ticket_key: signer, proof: b.proof, signature: b.signature };
  } else if (kind === "flag") {
    const slot = int(b, "slot", MAX_SLOTS - 1);
    signer = key(b, "ticket_key");
    message = flagMessage(contractId, eventId, slot);
    args = { event_id: eventId, slot, ticket_key: signer, signature: b.signature };
  } else if (kind === "cancel") {
    signer = key(b, "ticket_key");
    message = cancelMessage(contractId, eventId);
    args = { event_id: eventId, ticket_key: signer, signature: b.signature };
  } else {
    signer = key(b, "voucher_key");
    const target = key(b, "target_key");
    if (target === signer) throw new BadRequest("you can't vouch for yourself");
    message = vouchMessage(contractId, eventId, target);
    args = { event_id: eventId, voucher_key: signer, target_key: target, signature: b.signature };
  }

  if (!ed25519.verify(signature, new TextEncoder().encode(message), decodePublicKey(signer))) {
    throw new BadRequest("the signature does not match this ticket and action");
  }
  return { kind: kind as Kind, method: KINDS[kind as Kind], args, eventId, signer };
}
