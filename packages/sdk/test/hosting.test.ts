import assert from "node:assert/strict";
import test from "node:test";

import {
  type Event,
  LATENCY_MS,
  MARGIN_MS,
  MINUTE,
  buildEvent,
  codeCommitment,
  createdEventId,
  minCheckinMinutes,
  nextCode,
  openSlotArgs,
  revealArgs,
  revealableSlots,
  toBase64,
} from "../src/index.ts";

const OPENS = 1_000 * MINUTE;
const WINDOW = 5 * MINUTE;

function event(slots: Event["slots"] = [], closesAfter = 60 * MINUTE): Event {
  return {
    organizer: "host.testnet", arbiter: "dao.testnet", token: "usdc.testnet", deposit: "500000", capacity: 30,
    registered: 0, tickets_created: 0, owed_records: 0, owed_total: 0, status: "Active",
    schedule: {
      cancel_cutoff_ms: OPENS - 10 * MINUTE, rsvp_closes_at_ms: OPENS, checkin_opens_at_ms: OPENS,
      checkin_closes_at_ms: OPENS + closesAfter, reveal_deadline_ms: OPENS + closesAfter + 15 * MINUTE,
      dispute_ends_at_ms: OPENS + closesAfter + 45 * MINUTE,
    },
    checkin: { slots: 3, required: 3, window_ms: WINDOW },
    slots, tally: null, closed: false,
  };
}
const opened = (at: number, revealed: string | null = null) => ({ opened_at_ms: at, commitment: "", flags: 0, revealed });

test("the first code waits for check-in, then is ready", () => {
  const before = nextCode(event(), OPENS - MINUTE);
  assert.equal(before.state, "waiting");
  assert.equal(nextCode(event(), OPENS + MARGIN_MS).state, "ready");
  if (before.state !== "waiting") return;
  assert.equal(before.slot, 0);
  assert.equal(before.earliest, OPENS + MARGIN_MS);
  // Room for codes 2 and 3 after this one, each with its window and margins.
  assert.equal(before.roomBy, OPENS + 60 * MINUTE - 3 * (WINDOW + MARGIN_MS + LATENCY_MS));
});

test("the next code waits for the previous window to close onchain", () => {
  const e = event([opened(OPENS + MINUTE)]);
  const during = nextCode(e, OPENS + 3 * MINUTE);
  assert.equal(during.state, "waiting");
  if (during.state === "waiting") assert.equal(during.earliest, OPENS + MINUTE + WINDOW + MARGIN_MS);
  assert.equal(nextCode(e, OPENS + MINUTE + WINDOW + MARGIN_MS).state, "ready");
});

test("all three codes can open within the first 17 minutes", () => {
  let e = event();
  let t = OPENS;
  for (let slot = 0; slot < 3; slot++) {
    const next = nextCode(e, t);
    assert.ok(next.state === "waiting" || next.state === "ready");
    if (next.state !== "waiting" && next.state !== "ready") return;
    t = next.earliest;
    e = event([...e.slots, opened(t)]);
  }
  assert.equal(nextCode(e, t).state, "all-opened");
  assert.ok(t - OPENS < 17 * MINUTE);
});

test("a code with no room left is reported, not opened", () => {
  const late = OPENS + 60 * MINUTE - WINDOW - MARGIN_MS - LATENCY_MS + 1;
  assert.equal(nextCode(event(), late).state, "no-room");
  assert.equal(nextCode(event(), OPENS + 60 * MINUTE).state, "checkin-over");
});

test("only closed, unrevealed windows can be revealed, until the deadline", () => {
  const e = event([opened(OPENS, "zoo"), opened(OPENS + 10 * MINUTE), opened(OPENS + 20 * MINUTE)]);
  assert.deepEqual(revealableSlots(e, OPENS + 20 * MINUTE + MINUTE), [1]);
  assert.deepEqual(revealableSlots(e, OPENS + 20 * MINUTE + WINDOW + MARGIN_MS), [1, 2]);
  assert.deepEqual(revealableSlots(e, e.schedule.reveal_deadline_ms), []);
});

test("open_slot carries only the commitment, and reveal the normalized code", () => {
  const args = openSlotArgs("v1.dontbail.testnet", 7, 1, "Tiger  Maple seven ocean lamp");
  assert.deepEqual(args, { event_id: 7, slot: 1, commitment: toBase64(codeCommitment("v1.dontbail.testnet", 7, 1, "tiger maple seven ocean lamp")) });
  assert.ok(!JSON.stringify(args).includes("tiger"));
  assert.deepEqual(revealArgs(7, 1, " Tiger maple  seven ocean lamp "), { event_id: 7, slot: 1, code: "tiger maple seven ocean lamp" });
});

test("the created event id is read from a wallet's outcome", () => {
  assert.equal(createdEventId({ status: { SuccessValue: btoa("7") } }), 7);
  assert.equal(createdEventId({ status: { SuccessValue: "" } }), null);
  assert.equal(createdEventId({ status: { Failure: {} } }), null);
  assert.equal(createdEventId({ status: { SuccessValue: btoa("\"7\"") } }), null);
  assert.equal(createdEventId(null), null);
});

test("check-in must fit every code, and the plan becomes create_event's argument", () => {
  assert.equal(minCheckinMinutes(3, 5), 19);
  const plan = {
    token: "usdc.testnet", deposit: 500_000n, capacity: 30, arbiter: "dao.testnet", checkinOpensAt: OPENS,
    checkinMinutes: 60, slots: 3, required: 3, windowMinutes: 5, revealMinutes: 15, disputeMinutes: 30, cancelBeforeMinutes: 60,
  };
  const built = buildEvent(plan, OPENS - 2 * 60 * MINUTE);
  assert.equal(built.checkin_closes_at_ms, OPENS + 60 * MINUTE);
  assert.equal(built.cancel_cutoff_ms, OPENS - 60 * MINUTE);
  assert.deepEqual(built.checkin, { slots: 3, required: 3, window_ms: WINDOW });
  assert.throws(() => buildEvent({ ...plan, checkinMinutes: 18 }, 0), /at least 19 minutes/);
  assert.throws(() => buildEvent(plan, OPENS), /in the future/);
});
