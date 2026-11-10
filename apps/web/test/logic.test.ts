import assert from "node:assert/strict";
import { test } from "node:test";

import { Ticket } from "@bail/sdk";

import { nextAttempt, attemptLanded } from "../src/lib/attempts.ts";
import { ConfigError, parseConfig } from "../src/lib/config.ts";
import { describeError } from "../src/lib/errors.ts";
import { formatUnits, formatUsdc, sumUnits } from "../src/lib/money.ts";
import { canCancel, canFlag, canVouch, describePhase, inDisputeWindow, rsvpBlock } from "../src/lib/rules.ts";
import { catchStatus, confirmedCatches, liveSlot, requirement, slotIsVoid, slotStatus, slotWindowEnd } from "../src/lib/slots.ts";
import { TicketStore } from "../src/lib/storage.ts";
import { CONTRACT, MIN, T0, catchOf, makeEvent, makeTicket } from "./fixtures.ts";

const CODE = "tiger maple seven ocean lamp";
const standing = (over = {}) => ({ verified_catches: 2, void_slots: 0, catches_needed: 2, attended: true, vouches: 0, is_final: true, ...over });

test("money is formatted in integer base units, never as a float", () => {
  assert.equal(formatUnits(1_500_000n), "1.5");
  assert.equal(formatUnits("1000000"), "1");
  assert.equal(formatUnits(0n), "0");
  assert.equal(formatUnits(1n), "0.000001");
  assert.equal(formatUnits("12345678901234567890"), "12345678901234.56789");
  assert.equal(formatUnits(-250_000n), "-0.25");
  assert.equal(formatUsdc(500_000n), "0.5 test USDC");
  assert.equal(sumUnits("1000000", "500000"), 1_500_000n);
  assert.equal(formatUnits(sumUnits("9007199254740993", "1")), "9007199254.740994");
});

test("slot states follow the contract: unopened, live, awaiting reveal, revealed, void", () => {
  const unopened = makeEvent();
  assert.equal(slotStatus(unopened, 0, T0 + MIN), "waiting");
  assert.equal(slotStatus(unopened, 0, T0 + 10 * MIN), "void", "never opened by the end of check-in");

  const opened = makeEvent({ slots: [{ opened_at_ms: T0 + MIN, commitment: "", flags: 0, revealed: null }] });
  assert.equal(slotStatus(opened, 0, T0 + MIN), "live");
  assert.equal(slotStatus(opened, 0, T0 + 2 * MIN - 1), "live");
  assert.equal(slotStatus(opened, 0, T0 + 2 * MIN), "awaiting-reveal");
  assert.equal(slotStatus(opened, 0, T0 + 15 * MIN), "void", "never revealed by the deadline");
  assert.equal(slotWindowEnd(opened, 0), T0 + 2 * MIN);
  assert.equal(slotWindowEnd(opened, 1), null);

  const revealed = makeEvent({ slots: [{ opened_at_ms: T0 + MIN, commitment: "", flags: 0, revealed: CODE }] });
  assert.equal(slotStatus(revealed, 0, T0 + 3 * MIN), "revealed");
  assert.equal(slotStatus(revealed, 0, T0 + 20 * MIN), "revealed", "a revealed slot is never void");
  assert.equal(slotIsVoid(revealed, 0, T0 + 20 * MIN), false);
});

test("the live slot is the one still inside its window", () => {
  const first = { opened_at_ms: T0 + MIN, commitment: "", flags: 0, revealed: CODE };
  const second = { opened_at_ms: T0 + 4 * MIN, commitment: "", flags: 0, revealed: null };
  const onlyFirst = makeEvent({ slots: [{ ...first, revealed: null }] });
  assert.equal(liveSlot(onlyFirst, T0 + MIN + 10), 0, "the first code is live right after it opens");
  assert.equal(liveSlot(makeEvent({ slots: [first] }), T0 + 3 * MIN), null, "between codes nothing is live");
  const both = makeEvent({ slots: [first, second] });
  assert.equal(liveSlot(both, T0 + 4 * MIN + 10), 1);
  assert.equal(liveSlot(both, T0 + 5 * MIN), null);
});

test("void slots lower the bar and never raise it", () => {
  const event = makeEvent();
  assert.deepEqual(requirement(event, T0 + MIN), { slots: 3, required: 2, voidSlots: 0, needed: 2 });
  assert.deepEqual(requirement(event, T0 + 10 * MIN), { slots: 3, required: 2, voidSlots: 3, needed: 0 });
  const some = makeEvent({ slots: [{ opened_at_ms: T0 + MIN, commitment: "", flags: 0, revealed: CODE }] });
  assert.deepEqual(requirement(some, T0 + 10 * MIN), { slots: 3, required: 2, voidSlots: 2, needed: 0 });
});

test("a catch is only submitted until its code is revealed, then confirmed or not by the contract's own check", () => {
  const ticket = Ticket.generate();
  const mine = makeTicket({ catches: [catchOf(ticket, 4, 0, CODE), catchOf(ticket, 4, 1, "tiger maple seven ocean lump"), null, null, null] });
  const status = (event: ReturnType<typeof makeEvent>, slot: number) => catchStatus(event, slot, mine, CONTRACT, 4, ticket.publicKey);

  const hidden = makeEvent({ slots: [
    { opened_at_ms: T0 + MIN, commitment: "", flags: 0, revealed: null },
    { opened_at_ms: T0 + 4 * MIN, commitment: "", flags: 0, revealed: null },
  ] });
  assert.equal(status(hidden, 0), "submitted");
  assert.equal(status(hidden, 2), "none");

  const revealed = makeEvent({ slots: [
    { opened_at_ms: T0 + MIN, commitment: "", flags: 0, revealed: CODE },
    { opened_at_ms: T0 + 4 * MIN, commitment: "", flags: 0, revealed: CODE },
  ] });
  assert.equal(status(revealed, 0), "confirmed");
  assert.equal(status(revealed, 1), "not-confirmed", "a typo does not count");
  assert.equal(confirmedCatches(revealed, mine, CONTRACT, 4, ticket.publicKey), 1);

  const elsewhere = Ticket.generate();
  assert.equal(catchStatus(revealed, 0, mine, CONTRACT, 4, elsewhere.publicKey), "not-confirmed", "a proof is bound to one ticket");
  assert.equal(catchStatus(revealed, 0, null, CONTRACT, 4, ticket.publicKey), "none");
});

test("RSVPs are offered only when the event can take them", () => {
  assert.equal(rsvpBlock(null, T0), "not-found");
  assert.equal(rsvpBlock(makeEvent(), T0 - MIN), null);
  assert.equal(rsvpBlock(makeEvent(), T0), "rsvp-closed");
  assert.equal(rsvpBlock(makeEvent({ registered: 10 }), T0 - MIN), "full");
  assert.equal(rsvpBlock(makeEvent({ status: "Cancelled" }), T0 - MIN), "cancelled");
  assert.equal(rsvpBlock(makeEvent({ status: "Voided" }), T0 - MIN), "voided");
  assert.equal(rsvpBlock(makeEvent({ closed: true }), T0 - MIN), "closed");
});

test("cancelling, flagging and vouching follow the contract's timing", () => {
  const mine = makeTicket();
  assert.equal(canCancel(makeEvent(), mine, T0 - 31 * MIN), true);
  assert.equal(canCancel(makeEvent(), mine, T0 - 30 * MIN), false, "the cutoff itself is too late");
  assert.equal(canCancel(makeEvent(), null, T0 - 31 * MIN), false);
  assert.equal(canCancel(makeEvent({ status: "Cancelled" }), mine, T0 - 31 * MIN), false);

  const opened = makeEvent({ slots: [{ opened_at_ms: T0 + MIN, commitment: "", flags: 0, revealed: null }] });
  assert.equal(canFlag(opened, 0, mine, T0 + MIN), true);
  assert.equal(canFlag(opened, 0, mine, T0 + 15 * MIN), false, "flagging closes at the reveal deadline");
  assert.equal(canFlag(opened, 1, mine, T0 + MIN), false, "an unopened slot can't be flagged");
  assert.equal(canFlag(opened, 0, makeTicket({ flags: 1 }), T0 + MIN), false, "already flagged");

  const inWindow = T0 + 16 * MIN;
  assert.equal(inDisputeWindow(makeEvent(), inWindow), true);
  assert.equal(inDisputeWindow(makeEvent(), T0 + 14 * MIN), false);
  assert.equal(inDisputeWindow(makeEvent(), T0 + 25 * MIN), false);
  assert.equal(canVouch(makeEvent(), mine, standing(), inWindow), true);
  assert.equal(canVouch(makeEvent(), mine, standing({ attended: false }), inWindow), false, "only those who attended can vouch");
  assert.equal(canVouch(makeEvent(), mine, standing({ is_final: false }), inWindow), false);
  assert.equal(canVouch(makeEvent(), makeTicket({ vouched_for: "ed25519:x" }), standing(), inWindow), false, "one vouch each");
  assert.equal(canVouch(makeEvent(), mine, null, inWindow), false, "unknown standing means no");
  assert.equal(canVouch(makeEvent(), mine, standing(), T0 + 26 * MIN), false);
});

test("phases are described in plain words, with refunds called out", () => {
  assert.match(describePhase(makeEvent({ status: "Voided" }), "Dispute").label, /refunded/);
  assert.match(describePhase(makeEvent({ status: "Cancelled" }), "Open").label, /refunded/);
  assert.equal(describePhase(makeEvent(), "CheckIn").tone, "live");
});

test("attempt numbers only ever go up, whatever the chain or this browser remembers", () => {
  const ticket = Ticket.generate();
  const onChain = makeTicket({ catches: [catchOf(ticket, 1, 0, CODE, 3), null, null, null, null] });
  assert.equal(nextAttempt(null, 0, undefined), 1);
  assert.equal(nextAttempt(onChain, 0, undefined), 4);
  assert.equal(nextAttempt(onChain, 1, undefined), 1);
  assert.equal(nextAttempt(onChain, 0, { 0: { attempt: 5, code: "x", at: 0 } }), 6, "a local try the chain hasn't shown yet still counts");
  assert.equal(nextAttempt(onChain, 0, { 0: { attempt: 2, code: "x", at: 0 } }), 4);
  assert.equal(attemptLanded(onChain, 0, 3), true);
  assert.equal(attemptLanded(onChain, 0, 4), false);
  assert.equal(attemptLanded(null, 0, 1), false);
});

test("failures are worded plainly, and a lost connection is not mistaken for a refusal", () => {
  assert.equal(describeError(new TypeError("Failed to fetch")).kind, "network");
  assert.equal(describeError(new Error("code window is closed")).message, "Code window is closed.");
  assert.equal(describeError(new Error("Smart contract panicked: already vouched")).message, "Already vouched.");
  const limited = describeError(new Error("too many requests for this ticket"));
  assert.equal(limited.kind, "rate-limit");
  assert.doesNotMatch(limited.message, /\d+ ?(s|sec|second|minute)/, "no invented countdown");
  assert.equal(describeError(new Error("no such ticket for this event")).kind, "missing");
  assert.equal(describeError(new Error("")).kind, "unknown");
});

test("ticket secrets are kept per event, and survive a browser that refuses storage", () => {
  const entry = { version: 1 as const, backup: "ed25519:secret", publicKey: "ed25519:pub", payoutTo: "near:a", createdAt: 1, backedUp: false, stage: "created" as const, submissions: {} };
  const backing = new Map<string, string>();
  const store = new TicketStore({ getItem: (k) => backing.get(k) ?? null, setItem: (k, v) => void backing.set(k, v), removeItem: (k) => void backing.delete(k) });
  store.save(CONTRACT, 3, entry);
  assert.equal(store.get(CONTRACT, 3)?.backup, "ed25519:secret");
  assert.equal(store.get(CONTRACT, 4), null, "another event has no ticket");
  assert.equal(store.get("v2.dontbail.testnet", 3), null, "another contract has no ticket");
  assert.deepEqual([...backing.keys()], ["bail:v1:v1.dontbail.testnet:3"]);
  assert.equal(store.update(CONTRACT, 3, (t) => ({ ...t, backedUp: true }))?.backedUp, true);
  assert.equal(store.get(CONTRACT, 3)?.backedUp, true);
  store.remove(CONTRACT, 3);
  assert.equal(store.get(CONTRACT, 3), null);
  assert.equal(store.memoryOnly, false);

  const refusing = new TicketStore({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("denied"); } });
  refusing.save(CONTRACT, 3, entry);
  assert.equal(refusing.get(CONTRACT, 3)?.backup, "ed25519:secret", "kept in memory for the session");
  assert.equal(refusing.memoryOnly, true, "and the app can say it won't survive a reload");
  const none = new TicketStore(null);
  assert.equal(none.memoryOnly, true);

  let heard = 0;
  const stop = store.subscribe(() => heard++);
  store.save(CONTRACT, 5, entry);
  store.remove(CONTRACT, 5);
  assert.equal(heard, 2, "every screen is told when the ticket changes");
  stop();
  store.save(CONTRACT, 5, entry);
  assert.equal(heard, 2, "and stops hearing once it unsubscribes");
  let memoryHeard = 0;
  none.subscribe(() => memoryHeard++);
  none.save(CONTRACT, 3, entry);
  assert.equal(memoryHeard, 1, "memory-only mode notifies too");

  backing.set("bail:v1:v1.dontbail.testnet:9", "{not json");
  assert.equal(store.get(CONTRACT, 9), null, "a damaged record is ignored, not fatal");
});

test("config is checked, with testnet defaults for what is left out", () => {
  const ok = parseConfig({ relayerUrl: "https://relay.example/" });
  assert.equal(ok.relayerUrl, "https://relay.example");
  assert.equal(ok.contractId, "v1.dontbail.testnet");
  assert.ok(ok.fallbackUrls.length > 0);
  assert.equal(ok.explorerUrl, null);
  assert.equal(parseConfig({ relayerUrl: "http://localhost:8787", defaultEventId: 3, explorerUrl: "https://testnet.nearblocks.io" }).defaultEventId, 3);
  const own = parseConfig({ relayerUrl: "http://localhost:8787", rpcUrl: "http://127.0.0.1:3030" });
  assert.deepEqual(own.fallbackUrls, [], "a private node has no public fallbacks");
  assert.throws(() => parseConfig({}), ConfigError);
  assert.throws(() => parseConfig({ relayerUrl: "not a url" }), /not a web address/);
  assert.throws(() => parseConfig({ relayerUrl: "ftp://x.example" }), /http or https/);
  assert.throws(() => parseConfig(null), /relayerUrl is not set/);
});
