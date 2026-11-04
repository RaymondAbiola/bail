// Every vector here was built by the contract's own code (contracts/bail/src/tests/vectors.rs).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ed25519 } from "@noble/curves/ed25519.js";

import {
  type SignedAction,
  Ticket,
  cancelMessage,
  catchMessage,
  catchProof,
  codeCommitment,
  decodePublicKey,
  flagMessage,
  fromBase64,
  isPayoutAddress,
  normalizeCode,
  rsvpNote,
  toBase64,
  vouchMessage,
} from "../src/index.ts";

const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const contract: string = vectors.contract;

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
}

const tickets = new Map<string, Ticket>(
  vectors.tickets.map((t: { seed_hex: string; public_key: string }) => [
    t.public_key,
    Ticket.fromSeed(hexBytes(t.seed_hex)),
  ]),
);

test("ticket keys and backups", () => {
  for (const t of vectors.tickets) {
    const ticket = Ticket.fromSeed(hexBytes(t.seed_hex));
    assert.equal(ticket.publicKey, t.public_key);
    assert.equal(ticket.backup(), t.secret_key);
    assert.equal(Ticket.restore(t.secret_key).publicKey, t.public_key);
  }
});

test("code normalization", () => {
  for (const v of vectors.normalize) assert.equal(normalizeCode(v.input), v.output, JSON.stringify(v.input));
});

test("code commitments", () => {
  for (const v of vectors.commitments) {
    assert.equal(toBase64(codeCommitment(contract, v.event_id, v.slot, v.code)), v.commitment);
  }
});

test("catch proofs", () => {
  for (const v of vectors.proofs) {
    assert.equal(toBase64(catchProof(contract, v.event_id, v.slot, v.code, v.ticket)), v.proof);
  }
});

test("signed messages and signatures", () => {
  for (const v of vectors.messages) {
    const ticket = tickets.get(v.ticket)!;
    let action: SignedAction;
    if (v.action === "catch") {
      assert.equal(catchMessage(contract, v.event_id, v.slot, v.attempt, fromBase64(v.proof)), v.message);
      const caught = ticket.catch(contract, v.event_id, v.slot, v.attempt, v.code);
      assert.equal(caught.args.proof, v.proof);
      action = caught;
    } else if (v.action === "flag") {
      assert.equal(flagMessage(contract, v.event_id, v.slot), v.message);
      action = ticket.flag(contract, v.event_id, v.slot);
    } else if (v.action === "cancel") {
      assert.equal(cancelMessage(contract, v.event_id), v.message);
      action = ticket.cancel(contract, v.event_id);
    } else {
      assert.equal(vouchMessage(contract, v.event_id, v.target), v.message);
      action = ticket.vouch(contract, v.event_id, v.target);
    }
    // ed25519 signatures are deterministic, so they must match the contract's to the byte.
    assert.equal(action.args.signature, v.signature, v.action);
    assert.ok(ed25519.verify(fromBase64(v.signature), new TextEncoder().encode(v.message), decodePublicKey(v.ticket)));
  }
});

test("RSVP notes and payout addresses, as the contract accepted or refused them", () => {
  assert.ok(vectors.notes.some((v: { accepted: boolean }) => v.accepted));
  assert.ok(vectors.notes.some((v: { accepted: boolean }) => !v.accepted));
  for (const v of vectors.notes) {
    const options = { intents: v.intents };
    assert.equal(isPayoutAddress(v.payout_to, options), v.accepted, `${v.payout_to} intents=${v.intents}`);
    if (v.accepted) assert.equal(rsvpNote(v.event_id, v.ticket_key, v.payout_to, options), v.note);
    else assert.throws(() => rsvpNote(v.event_id, v.ticket_key, v.payout_to, options));
  }
});
