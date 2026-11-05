import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { renderCode } from "../src/display.ts";
import { type EventPlan, MARGIN_MS, MINUTE, buildEvent, parseAmount, parseWhen, randomMoment, slotRange } from "../src/schedule.ts";
import { loadState, saveState } from "../src/state.ts";

const NOW = 1_800_000_000_000;

const plan = (overrides: Partial<EventPlan> = {}): EventPlan => ({
  token: "usdc.testnet", deposit: 1_000_000n, capacity: 30, arbiter: "dao.testnet",
  checkinOpensAt: NOW + 60 * MINUTE, checkinMinutes: 20, slots: 3, required: 2, windowMinutes: 2,
  revealMinutes: 15, disputeMinutes: 30, cancelBeforeMinutes: 60, ...overrides,
});

test("times and amounts are read the way a host types them", () => {
  assert.equal(parseWhen("+15m", NOW), NOW + 15 * MINUTE);
  assert.equal(parseWhen("+2h", NOW), NOW + 120 * MINUTE);
  assert.equal(parseWhen("2026-11-13T18:00:00Z", NOW), Date.parse("2026-11-13T18:00:00Z"));
  assert.throws(() => parseWhen("tomorrow", NOW));
  assert.equal(parseAmount("1", 6), 1_000_000n);
  assert.equal(parseAmount("0.5", 6), 500_000n);
  assert.equal(parseAmount("2.125", 6), 2_125_000n);
  assert.throws(() => parseAmount("1.0000001", 6));
  assert.throws(() => parseAmount("-1", 6));
});

test("an event plan becomes the contract's create_event argument", () => {
  const event = buildEvent(plan(), NOW);
  assert.equal(event.checkin_opens_at_ms, NOW + 60 * MINUTE);
  assert.equal(event.rsvp_closes_at_ms, event.checkin_opens_at_ms);
  assert.equal(event.cancel_cutoff_ms, NOW + MINUTE, "an hour before an event an hour away is clamped to a minute from now");
  assert.equal(event.checkin_closes_at_ms, event.checkin_opens_at_ms + 20 * MINUTE);
  assert.deepEqual(event.checkin, { slots: 3, required: 2, window_ms: 2 * MINUTE });
  assert.equal(event.deposit, "1000000");
  assert.equal(buildEvent(plan({ checkinOpensAt: NOW + 3 * 60 * MINUTE }), NOW).cancel_cutoff_ms, NOW + 2 * 60 * MINUTE);
});

test("schedules the live console couldn't run are refused", () => {
  assert.throws(() => buildEvent(plan({ checkinMinutes: 6 }), NOW), /at least 7 minutes/);
  assert.doesNotThrow(() => buildEvent(plan({ checkinMinutes: 7 }), NOW));
  assert.throws(() => buildEvent(plan({ checkinOpensAt: NOW }), NOW), /future/);
});

test("each slot opens after the previous window and leaves room for the rest", () => {
  const opens = 1000 * MINUTE;
  const closes = opens + 20 * MINUTE;
  const window = 2 * MINUTE;
  const first = slotRange(0, 3, window, opens, closes, null);
  assert.equal(first.earliest, opens + MARGIN_MS);
  assert.equal(first.latest, closes - 3 * (window + MARGIN_MS));
  const second = slotRange(1, 3, window, opens, closes, opens + 5 * MINUTE);
  assert.equal(second.earliest, opens + 5 * MINUTE + window + MARGIN_MS);
  assert.equal(second.latest, closes - 2 * (window + MARGIN_MS));
  const late = slotRange(2, 3, window, opens, closes, closes - 4.5 * MINUTE);
  assert.equal(late.latest, late.earliest, "a late previous slot leaves no choice, but still fits");
  assert.throws(() => slotRange(2, 3, window, opens, closes, closes - 3 * MINUTE), /too late/);
  for (let i = 0; i < 100; i++) {
    const at = randomMoment(first);
    assert.ok(at >= first.earliest && at <= first.latest);
  }
});

test("the code is shown large, letter by letter, with its countdown", () => {
  const screen = renderCode("tiger maple seven ocean lamp", 1, 3, 95_000, false);
  assert.match(screen, /CODE 2 OF 3/);
  assert.match(screen, /T I G E R/);
  assert.match(screen, /L A M P/);
  assert.match(screen, /Closes in 1:35/);
});

test("host state is kept private to the host", () => {
  const dir = mkdtempSync(join(tmpdir(), "bail-host-"));
  saveState(dir, { contractId: "v1.dontbail.testnet", eventId: 4, organizer: "host.testnet", codes: ["zoo zoo"] });
  assert.equal(loadState(dir, "v1.dontbail.testnet", 4).codes[0], "zoo zoo");
  assert.equal(statSync(join(dir, "v1.dontbail.testnet", "4.json")).mode & 0o777, 0o600);
  assert.throws(() => loadState(dir, "v1.dontbail.testnet", 5), /no host state/);
});
