import assert from "node:assert/strict";
import { test } from "node:test";

import type { BailView, Tally } from "@bail/sdk";

import { formatUsdc } from "../src/lib/money.ts";
import { PAST_EVENTS, pastEventOutcome, readPastEvents } from "../src/lib/past-events.ts";
import { makeEvent } from "./fixtures.ts";

function tally(overrides: Partial<Tally> = {}): Tally {
  return { stage: "Done", attended: 6, vouched: 0, forfeited: 5, refunded: 0, pool: "2500000", bonus: "416666", fee: "0", dust: "4", cursor: 11, paid_cursor: 0, everyone_refunded: false, measured: true, new_records: 0, ...overrides };
}

test("past-event figures come from the tally and retain six-decimal payouts", () => {
  const outcome = pastEventOutcome(makeEvent({ deposit: "500000", tally: tally(), registered: 0, closed: true }));
  assert.equal(outcome?.seats, 11, "closing or cancellations must not replace the final ticket count");
  assert.equal(outcome?.attended, 6);
  assert.equal(outcome?.forfeited, 5);
  assert.equal(formatUsdc(outcome!.duePerAttendee!), "0.916666 test USDC");
  const dryRun = pastEventOutcome(makeEvent({ deposit: "500000", tally: tally({ attended: 1, forfeited: 3, bonus: "1500000" }) }));
  assert.equal(dryRun?.seats, 4);
  assert.equal(formatUsdc(dryRun!.duePerAttendee!), "2 test USDC");
});

test("vouched and refunded tickets are counted without treating them as code-qualified", () => {
  const outcome = pastEventOutcome(makeEvent({ tally: tally({ attended: 2, vouched: 1, forfeited: 3, refunded: 2 }) }));
  assert.deepEqual({ seats: outcome?.seats, attended: outcome?.attended, vouched: outcome?.vouched, refunded: outcome?.refunded }, { seats: 8, attended: 2, vouched: 1, refunded: 2 });
  const refund = pastEventOutcome(makeEvent({ tally: tally({ attended: 0, forfeited: 0, refunded: 4 }) }));
  assert.equal(refund?.duePerAttendee, null);
});

test("unavailable and unfinished results never become zero totals or promised payouts", () => {
  assert.equal(pastEventOutcome(null), null);
  assert.equal(pastEventOutcome(makeEvent()), null);
  assert.equal(pastEventOutcome(makeEvent({ tally: tally({ stage: "Classifying" }) })), null);
  assert.equal(pastEventOutcome(makeEvent({ tally: tally({ stage: "Recording" }) })), null);
});

test("each historical read is independent and uses only the chain", async () => {
  const event = makeEvent({ tally: tally() });
  const calls: number[] = [];
  const view: Pick<BailView, "event"> = { async event(id) { calls.push(id); if (id === 4) throw new Error("RPC unavailable"); return event; } };
  assert.deepEqual(await readPastEvents(view), [{ event: null, failed: true }, { event, failed: false }]);
  assert.deepEqual(calls, PAST_EVENTS.map(({ id }) => id));
  assert.deepEqual(await readPastEvents({ event: async () => null }), [{ event: null, failed: false }, { event: null, failed: false }]);
});
