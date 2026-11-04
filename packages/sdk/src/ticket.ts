import { ed25519 } from "@noble/curves/ed25519.js";

import {
  type EventId,
  decodeSecretKey,
  encodePublicKey,
  encodeSecretKey,
  text,
  toBase64,
} from "./codec.ts";
import { catchProof } from "./hashes.ts";
import { cancelMessage, catchMessage, flagMessage, vouchMessage } from "./messages.ts";
import { rsvpNote } from "./notes.ts";

/** A signed call to a Bail method. `args` are exactly the method's arguments. */
export type SignedAction =
  | { kind: "catch"; method: "catch"; args: CatchArgs }
  | { kind: "flag"; method: "flag_slot"; args: FlagArgs }
  | { kind: "cancel"; method: "cancel_rsvp"; args: CancelArgs }
  | { kind: "vouch"; method: "vouch"; args: VouchArgs };

type Action<K extends SignedAction["kind"]> = Extract<SignedAction, { kind: K }>;

export interface CatchArgs {
  event_id: number;
  slot: number;
  attempt: number;
  ticket_key: string;
  proof: string;
  signature: string;
}

export interface FlagArgs {
  event_id: number;
  slot: number;
  ticket_key: string;
  signature: string;
}

export interface CancelArgs {
  event_id: number;
  ticket_key: string;
  signature: string;
}

export interface VouchArgs {
  event_id: number;
  voucher_key: string;
  target_key: string;
  signature: string;
}

/**
 * An attendee's key for one event. It never needs NEAR or a NEAR account: the contract
 * checks its signatures itself, and the deposit names it in the RSVP note.
 */
export class Ticket {
  readonly publicKey: string;
  readonly #seed: Uint8Array;

  private constructor(seed: Uint8Array) {
    this.#seed = seed;
    this.publicKey = encodePublicKey(ed25519.getPublicKey(seed));
  }

  static generate(): Ticket {
    return new Ticket(ed25519.utils.randomSecretKey());
  }

  static fromSeed(seed: Uint8Array): Ticket {
    if (seed.length !== 32) throw new RangeError("a ticket seed is 32 bytes");
    return new Ticket(Uint8Array.from(seed));
  }

  /** Restores a ticket from `backup()`, refusing one whose key halves don't match. */
  static restore(backup: string): Ticket {
    const { seed, publicKey } = decodeSecretKey(backup.trim());
    const ticket = new Ticket(seed);
    if (ticket.publicKey !== encodePublicKey(publicKey)) throw new Error("this backup is damaged");
    return ticket;
  }

  /** NEAR's secret key format, `ed25519:<base58 of seed and public key>`. */
  backup(): string {
    return encodeSecretKey(this.#seed, ed25519.getPublicKey(this.#seed));
  }

  sign(message: string): string {
    return toBase64(ed25519.sign(text(message), this.#seed));
  }

  rsvpNote(eventId: EventId, payoutTo: string, options = { intents: false }): string {
    return rsvpNote(eventId, this.publicKey, payoutTo, options);
  }

  catch(contractId: string, eventId: number, slot: number, attempt: number, code: string): Action<"catch"> {
    const proof = catchProof(contractId, eventId, slot, code, this.publicKey);
    return {
      kind: "catch",
      method: "catch",
      args: {
        event_id: eventId,
        slot,
        attempt,
        ticket_key: this.publicKey,
        proof: toBase64(proof),
        signature: this.sign(catchMessage(contractId, eventId, slot, attempt, proof)),
      },
    };
  }

  flag(contractId: string, eventId: number, slot: number): Action<"flag"> {
    return {
      kind: "flag",
      method: "flag_slot",
      args: {
        event_id: eventId,
        slot,
        ticket_key: this.publicKey,
        signature: this.sign(flagMessage(contractId, eventId, slot)),
      },
    };
  }

  cancel(contractId: string, eventId: number): Action<"cancel"> {
    return {
      kind: "cancel",
      method: "cancel_rsvp",
      args: {
        event_id: eventId,
        ticket_key: this.publicKey,
        signature: this.sign(cancelMessage(contractId, eventId)),
      },
    };
  }

  vouch(contractId: string, eventId: number, targetKey: string): Action<"vouch"> {
    return {
      kind: "vouch",
      method: "vouch",
      args: {
        event_id: eventId,
        voucher_key: this.publicKey,
        target_key: targetKey,
        signature: this.sign(vouchMessage(contractId, eventId, targetKey)),
      },
    };
  }
}
