import assert from "node:assert/strict";
import { test } from "node:test";

import { buildEvent, openSlotArgs, type BailView } from "@bail/sdk";

import { checkArbiter, defaultHostFields, localDateTime, validateHostFields } from "../src/lib/host-plan.ts";
import { findCreatedEvent, HostStore, makeHostRecord, recoverUnopenedCodes } from "../src/lib/host-record.ts";
import { matchingHostCode, relayHostReveal } from "../src/lib/host-reveal.ts";
import { assertWalletSuccess, hostTransaction, testOrganizerWallet } from "../src/lib/organizer-wallet.ts";
import { parseConfig } from "../src/lib/config.ts";
import { CONTRACT, MIN, T0, makeEvent } from "./fixtures.ts";

const fields = () => ({ ...defaultHostFields(T0), arbiter: "dao.testnet" });
const plan = () => validateHostFields(fields(), "usdc.testnet", "host.testnet", T0);
const pending = () => ({ organizer: "host.testnet", event: buildEvent(plan(), T0), title: "A community call", callUrl: "https://meet.example/call" });
const CODE = "tiger maple seven ocean lamp";

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test("host records save and reload per contract and event without exposing other host records", () => {
  const backing = storage();
  const store = new HostStore(backing);
  const record = makeHostRecord(CONTRACT, 8, pending());
  store.save(record);
  assert.deepEqual(new HostStore(backing).get(CONTRACT, 8), record);
  assert.equal(store.get(CONTRACT, 9), null);
  assert.equal(store.get("other.testnet", 8), null);
  assert.equal(store.lastId(CONTRACT), 8);
  assert.equal(record.codes.length, 3);
  assert.ok(record.codes.every((code) => /^[a-z]+(?: [a-z]+){4}$/.test(code!)));
  store.savePending(CONTRACT, pending());
  assert.deepEqual(new HostStore(backing).pending(CONTRACT), pending());
  store.clearPending(CONTRACT);
  assert.equal(store.pending(CONTRACT), null);
});

test("missing, corrupt and mismatched host records are unavailable; storage failures never report success", () => {
  const backing = storage();
  const store = new HostStore(backing);
  const record = makeHostRecord(CONTRACT, 8, pending());
  for (const raw of ["{broken", "null", "{}", JSON.stringify({ ...record, eventId: 9 }), JSON.stringify({ ...record, codes: [] }), JSON.stringify({ ...record, codes: [42] }), JSON.stringify({ ...record, callUrl: "javascript:alert(1)" })]) {
    backing.setItem(HostStore.key(CONTRACT, 8), raw);
    assert.equal(store.get(CONTRACT, 8), null);
  }
  assert.equal(new HostStore(null).get(CONTRACT, 8), null);
  assert.throws(() => new HostStore(null).save(record), /cannot save host codes/);
  assert.throws(() => new HostStore({ ...backing, setItem: () => { throw new Error("quota"); } }).save(record), /could not be saved/);
  assert.equal(new HostStore({ ...backing, getItem: () => { throw new Error("denied"); } }).get(CONTRACT, 8), null);
});

test("recovery generates only unopened codes; opened commitments cannot be replaced", () => {
  const event = makeEvent({ slots: [{ opened_at_ms: T0, commitment: "original", flags: 0, revealed: null }] });
  const record = recoverUnopenedCodes(CONTRACT, 8, event);
  assert.equal(record.codes[0], null);
  assert.equal(record.codes.length, 3);
  assert.ok(record.codes.slice(1).every((code) => typeof code === "string"));
});

test("id lookup chooses the newest event with the organizer and scheduled start, stopping at the first unused id", async () => {
  const events = [makeEvent(), makeEvent({ organizer: "someone.testnet" }), makeEvent(), makeEvent({ schedule: { ...makeEvent().schedule, checkin_opens_at_ms: T0 + MIN } })];
  const calls: number[] = [];
  const view = { async event(id: number) { calls.push(id); return events[id] ?? null; } };
  assert.equal(await findCreatedEvent(view, "host.testnet", T0), 2);
  assert.deepEqual(calls, [0, 1, 2, 3, 4]);
  calls.length = 0;
  assert.equal(await findCreatedEvent(view, "host.testnet", T0, 2), 2);
  assert.deepEqual(calls, [2, 3, 4]);
  assert.equal(await findCreatedEvent(view, "missing.testnet", T0), null);
  await assert.rejects(findCreatedEvent({ event: async () => { throw new Error("RPC unavailable"); } }, "host.testnet", T0), /RPC unavailable/);
  await assert.rejects(findCreatedEvent(view, "host.testnet", T0, -1), /valid id/);
});

test("form defaults follow the shared buildEvent schedule and retain integer token precision", () => {
  const value = plan();
  assert.equal(value.deposit, 500_000n);
  assert.equal(value.slots, 3);
  assert.equal(value.required, 3);
  assert.equal(value.capacity, 30);
  const event = buildEvent(value, T0);
  assert.equal(event.rsvp_closes_at_ms, new Date(fields().startsAt).getTime());
  assert.equal(event.checkin_closes_at_ms - event.checkin_opens_at_ms, 60 * MIN);
  assert.deepEqual(event.checkin, { slots: 3, required: 3, window_ms: 5 * MIN });
  assert.equal(validateHostFields({ ...fields(), deposit: "0.000001" }, "usdc.testnet", "host.testnet", T0).deposit, 1n);
});

test("form validation refuses impossible schedules, wrong amounts, unsafe links and organizer arbiters", () => {
  const bad = [
    { checkinMinutes: "18" }, { startsAt: localDateTime(T0 - MIN) }, { startsAt: "" }, { deposit: "0" }, { deposit: "0.0000001" },
    { deposit: "1e6" }, { capacity: "1001" }, { capacity: "0" }, { slots: "6" }, { windowMinutes: "0" }, { required: "4" },
    { arbiter: "host.testnet" }, { arbiter: "" }, { arbiter: "Bad Account" }, { callUrl: "javascript:alert(1)" }, { revealMinutes: "-1" },
  ];
  for (const changes of bad) assert.throws(() => validateHostFields({ ...fields(), ...changes }, "usdc.testnet", "host.testnet", T0), JSON.stringify(changes));
  assert.equal(validateHostFields({ ...fields(), required: "2" }, "usdc.testnet", "host.testnet", T0).required, 2);
  assert.throws(() => validateHostFields(fields(), "usdc.testnet", "host.testnet", T0, { min_window_ms: 6 * MIN, min_reveal_ms: MIN, min_dispute_ms: MIN, max_event_ms: 24 * 60 * MIN, fee_bps: 0, fee_account: null, intents_account: null }), /at least 6 minutes/);
});

test("the arbiter must exist on chain even for an implicit account, and RPC outages are distinct", async () => {
  const calls: string[] = [];
  const view: Pick<BailView, "rpc"> = { async rpc<T>(_method: string, params: object) { const account = (params as { account_id: string }).account_id; calls.push(account); if (account === "missing.testnet") throw new Error("UNKNOWN_ACCOUNT"); return {} as T; } };
  await checkArbiter(view, "dao.testnet", "host.testnet");
  await checkArbiter(view, "a".repeat(64), "host.testnet");
  assert.deepEqual(calls, ["dao.testnet", "a".repeat(64)]);
  await assert.rejects(checkArbiter(view, "missing.testnet", "host.testnet"), /There is no NEAR account/);
  await assert.rejects(checkArbiter(view, "host.testnet", "host.testnet"), /cannot be the organizer/);
  await assert.rejects(checkArbiter({ rpc: async () => { throw new Error("offline"); } }, "dao.testnet", "host.testnet"), /Could not check/);
});

test("opening sends only a commitment; a held code must match the actual opened slot", () => {
  const args = openSlotArgs(CONTRACT, 8, 0, CODE);
  const transaction = hostTransaction(CONTRACT, "open_slot", args, 30);
  assert.doesNotMatch(JSON.stringify(transaction), /tiger|maple/);
  assert.equal(transaction.actions[0]!.params.gas, "30000000000000");
  assert.equal(transaction.actions[0]!.params.deposit, "0");
  const event = makeEvent({ slots: [{ commitment: args.commitment, opened_at_ms: T0, flags: 0, revealed: null }] });
  assert.equal(matchingHostCode(CONTRACT, 8, event, 0, CODE), true);
  assert.equal(matchingHostCode(CONTRACT, 8, event, 1, CODE), false);
  assert.equal(matchingHostCode(CONTRACT, 8, event, 0, "wrong five words go here"), false);
  assert.equal(matchingHostCode(CONTRACT, 8, event, 0, null), false);
  assert.throws(() => assertWalletSuccess({ status: { Failure: {} } }), /transaction failed/);
});

test("the sandbox wallet is off by default and cannot activate on a public hostname", () => {
  assert.equal(parseConfig({ relayerUrl: "http://localhost:8787" }).testWallet, false);
  assert.equal(parseConfig({ relayerUrl: "http://localhost:8787", testWallet: "true" }).testWallet, false);
  assert.equal(testOrganizerWallet(false, "localhost"), null);
  assert.equal(testOrganizerWallet(true, "raymondabiola.github.io"), null);
  assert.equal(testOrganizerWallet(true, "localhost.attacker.example"), null);
});

test("reveal posts only to the dedicated relayer endpoint and tolerates another keeper winning", async (t) => {
  const requests: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify({ tx: "reveal-tx" }), { status: 200 });
  });
  await relayHostReveal("https://relayer.example", 8, 0, CODE);
  assert.deepEqual(requests, [{ url: "https://relayer.example/v1/reveal", body: { event_id: 8, slot: 0, code: CODE } }]);
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 409 }));
  await relayHostReveal("https://relayer.example", 8, 0, CODE);
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 422 }));
  await assert.rejects(relayHostReveal("https://relayer.example", 8, 0, CODE), /could not be confirmed/);
});
