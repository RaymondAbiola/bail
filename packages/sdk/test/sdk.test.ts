import assert from "node:assert/strict";
import { test } from "node:test";

import { base58 } from "@scure/base";

import {
  type Event,
  Ticket,
  checkedCode,
  codeCommitment,
  generateCode,
  normalizeCode,
  phase,
  suggestWords,
  wordlist,
} from "../src/index.ts";

test("generated tickets are distinct and survive a backup", () => {
  const a = Ticket.generate();
  const b = Ticket.generate();
  assert.notEqual(a.publicKey, b.publicKey);
  assert.equal(Ticket.restore(`  ${a.backup()}\n`).publicKey, a.publicKey);
});

test("a damaged backup is refused rather than restoring the wrong ticket", () => {
  const a = Ticket.generate().backup();
  const b = Ticket.generate().backup();
  assert.throws(() => Ticket.restore(a.slice(0, 20)));
  const seedOfA = base58.decode(a.slice(8)).slice(0, 32);
  const keyOfB = base58.decode(b.slice(8)).slice(32);
  const mixed = `ed25519:${base58.encode(Uint8Array.from([...seedOfA, ...keyOfB]))}`;
  assert.throws(() => Ticket.restore(mixed), /damaged/);
});

test("generated codes are five list words that the contract can reveal", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    const words = code.split(" ");
    assert.equal(words.length, 5);
    assert.ok(words.every((w) => wordlist.includes(w)));
    assert.equal(checkedCode(code), code);
  }
});

test("codes the contract would refuse to reveal are refused up front", () => {
  assert.throws(() => checkedCode("   "));
  assert.throws(() => checkedCode("a".repeat(65)));
  assert.equal(checkedCode("a".repeat(64)), "a".repeat(64));
  assert.throws(() => codeCommitment("v1.dontbail.testnet", 0, 0, ""));
});

test("spacing and case never change a catch", () => {
  assert.equal(normalizeCode("TIGER   maple"), "tiger maple");
  const a = codeCommitment("v1.dontbail.testnet", 3, 1, "Tiger Maple Seven Ocean Lamp");
  const b = codeCommitment("v1.dontbail.testnet", 3, 1, "tiger maple seven ocean lamp ");
  assert.deepEqual(a, b);
});

test("word suggestions for autocomplete", () => {
  assert.deepEqual(suggestWords("tig"), ["tiger"]);
  assert.deepEqual(suggestWords(""), []);
  assert.ok(suggestWords("ab").every((w) => w.startsWith("ab")));
});

test("event ids outside the contract's range are refused", () => {
  assert.throws(() => codeCommitment("v1.dontbail.testnet", -1, 0, "zoo"));
  assert.throws(() => codeCommitment("v1.dontbail.testnet", 1.5, 0, "zoo"));
  assert.throws(() => codeCommitment("v1.dontbail.testnet", 2 ** 60, 0, "zoo"));
  assert.doesNotThrow(() => codeCommitment("v1.dontbail.testnet", 2n ** 64n - 1n, 0, "zoo"));
  assert.throws(() => codeCommitment("v1.dontbail.testnet", 2n ** 64n, 0, "zoo"));
  assert.throws(() => codeCommitment("v1.dontbail.testnet", 0, 256, "zoo"));
});

function event(overrides: Partial<Event> = {}): Event {
  return {
    organizer: "host.testnet",
    arbiter: "dao.testnet",
    token: "usdc.testnet",
    deposit: "1000000",
    capacity: 10,
    registered: 0,
    tickets_created: 0,
    owed_records: 0,
    owed_total: 0,
    status: "Active",
    schedule: {
      cancel_cutoff_ms: 50,
      rsvp_closes_at_ms: 100,
      checkin_opens_at_ms: 100,
      checkin_closes_at_ms: 200,
      reveal_deadline_ms: 300,
      dispute_ends_at_ms: 400,
    },
    checkin: { slots: 2, required: 2, window_ms: 60 },
    slots: [],
    tally: null,
    closed: false,
    ...overrides,
  };
}

test("phases follow the schedule, then the tally", () => {
  const e = event();
  assert.equal(phase(e, 0), "Open");
  assert.equal(phase(e, 100), "CheckIn");
  assert.equal(phase(e, 200), "Reveal");
  assert.equal(phase(e, 300), "Dispute");
  assert.equal(phase(e, 400), "Tally");
  assert.equal(phase(event({ status: "Cancelled" }), 0), "Tally");
  const done = { stage: "Done" as const } as Event["tally"];
  assert.equal(phase(event({ tally: done }), 500), "Settled");
  assert.equal(phase(event({ tally: done, closed: true }), 500), "Closed");
});
