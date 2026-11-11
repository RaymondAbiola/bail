import assert from "node:assert/strict";
import { test } from "node:test";

import { Ticket } from "@bail/sdk";

import { requiredCodes } from "../src/lib/checkin-copy.ts";
import { codeEntryWarnings, recordedCode } from "../src/lib/code-entry.ts";
import { slotStatus, slotWindowEnd } from "../src/lib/slots.ts";
import { CONTRACT, MIN, T0, catchOf, makeEvent, makeTicket } from "./fixtures.ts";

test("all-code events say every code is needed, while partial requirements keep their numbers", () => {
  assert.equal(requiredCodes(3, 3), "all 3 codes");
  assert.equal(requiredCodes(5, 5), "all 5 codes");
  assert.equal(requiredCodes(2, 3), "2 of 3 codes");
  assert.equal(requiredCodes(1, 3), "1 of 3 codes");
  assert.equal(requiredCodes(1, 1), "the only code");
});

test("a letter-by-letter paste gets both prominent explanations", () => {
  const pasted = Array.from({ length: 30 }, () => "a").join(" ");
  const warnings = codeEntryWarnings(pasted);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /30 words.*five words.*letter by letter/);
  assert.match(warnings[1]!, /single letters.*whole words/);
  assert.deepEqual(codeEntryWarnings("a b c d e"), ["These look like single letters. Codes are whole words."]);
});

test("code entry warnings clear for five words and ignore empty input and normal initial typing", () => {
  assert.deepEqual(codeEntryWarnings("  TIGER\nmaple   seven\tocean lamp  "), []);
  assert.deepEqual(codeEntryWarnings("   \t\n"), []);
  assert.match(codeEntryWarnings("t")[0]!, /1 word\./);
  assert.equal(codeEntryWarnings("t").length, 1, "one unfinished word is not a letter-by-letter paste");
  assert.match(codeEntryWarnings("tiger maple")[0]!, /2 words/);
  assert.match(codeEntryWarnings("tiger maple seven ocean lamp tiger")[0]!, /6 words/);
  assert.equal(codeEntryWarnings("a b c maple lamp").length, 1, "a majority of single letters still warns");
  assert.deepEqual(codeEntryWarnings("a b tiger maple lamp"), [], "a minority of single letters is left to the spelling hint");
});

test("the displayed submission must match the recorded attempt and proof", () => {
  const ticket = Ticket.generate();
  const code = Array.from({ length: 30 }, () => "a").join(" ");
  const chain = makeTicket({ catches: [catchOf(ticket, 4, 0, code, 2)] });
  const saved = { attempt: 2, code, at: T0 };
  const read = (submission = saved, record: ReturnType<typeof makeTicket> | null = chain, key = ticket.publicKey) => recordedCode(submission, record, CONTRACT, 4, 0, key);
  assert.equal(read(), code);
  assert.equal(read({ ...saved, attempt: 3 }), null, "an ambiguous newer retry is not the recorded catch");
  assert.equal(read({ ...saved, attempt: 1 }), null, "a correction from another device may have replaced it");
  assert.equal(read({ ...saved, code: "tiger maple seven ocean lamp" }), null, "attempt equality alone cannot prove the code");
  assert.equal(read(saved, null), null);
  assert.equal(read(saved, chain, Ticket.generate().publicKey), null);
  assert.equal(recordedCode(undefined, chain, CONTRACT, 4, 0, ticket.publicKey), null);
  assert.equal(recordedCode(saved, chain, CONTRACT, 4, 1, ticket.publicKey), null);
});

test("five-minute code windows are derived from the event", () => {
  const event = makeEvent({ checkin: { slots: 3, required: 3, window_ms: 5 * MIN }, slots: [{ opened_at_ms: T0, commitment: "", revealed: null, flags: 0 }] });
  assert.equal(slotWindowEnd(event, 0), T0 + 5 * MIN);
  assert.equal(slotStatus(event, 0, T0 + 2 * MIN), "live");
  assert.equal(slotStatus(event, 0, T0 + 5 * MIN - 1), "live");
  assert.equal(slotStatus(event, 0, T0 + 5 * MIN), "awaiting-reveal");
});
