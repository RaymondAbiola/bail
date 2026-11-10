import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { BailView, type Event, type FunctionCallDelegate, Ticket, type TicketRecord, rsvpDelegate } from "@bail/sdk";

import type { CallOutcome, Chain } from "../src/chain.ts";
import { failureMessage } from "../src/chain.ts";
import { BadRequest, checkAction } from "../src/checks.ts";
import { Keeper, nextStep } from "../src/keeper.ts";
import { RateLimit } from "../src/limits.ts";
import { type Sponsor, checkDelegate, checkFaucet } from "../src/onboarding.ts";
import { relayerServer } from "../src/server.ts";

const CONTRACT = "v1.dontbail.testnet";
const alice = Ticket.generate();
const bob = Ticket.generate();

class FakeChain implements Chain {
  readonly accountId = "relayer.testnet";
  calls: { method: string; args: Record<string, unknown> }[] = [];
  answer: (method: string, args: Record<string, unknown>) => Omit<CallOutcome, "tx"> = () => ({ ok: true });

  async call(method: string, args: object): Promise<CallOutcome> {
    this.calls.push({ method, args: args as Record<string, unknown> });
    return { tx: `tx${this.calls.length}`, ...this.answer(method, args as Record<string, unknown>) };
  }
}

class FakeView extends BailView {
  tickets_ = new Map<string, TicketRecord>();
  events = new Map<number, Event>();

  override async ticket(eventId: number, key: string): Promise<TicketRecord | null> {
    return this.tickets_.get(`${eventId}/${key}`) ?? null;
  }

  override async event(eventId: number): Promise<Event | null> {
    return this.events.get(eventId) ?? null;
  }
}

function record(payoutTo: string): TicketRecord {
  return {
    payout_to: payoutTo, index: 0, catches: [], flags: 0, vouched_for: null, vouched_by: 0, outcome: null, paid: false,
  };
}

test("actions signed by the SDK pass the relayer's checks", () => {
  for (const action of [
    alice.catch(CONTRACT, 3, 1, 2, "tiger maple seven ocean lamp"),
    alice.flag(CONTRACT, 3, 0),
    alice.cancel(CONTRACT, 3),
    alice.vouch(CONTRACT, 3, bob.publicKey),
  ]) {
    const checked = checkAction(action.kind, action.args, CONTRACT);
    assert.equal(checked.method, action.method);
    assert.deepEqual(checked.args, action.args);
    assert.equal(checked.signer, alice.publicKey);
  }
});

test("a signature for another contract, event, slot or attempt is refused", () => {
  const action = alice.catch(CONTRACT, 3, 1, 2, "zoo");
  assert.throws(() => checkAction("catch", action.args, "v1.dontbail.near"), BadRequest);
  for (const change of [{ event_id: 4 }, { slot: 2 }, { attempt: 3 }]) {
    assert.throws(() => checkAction("catch", { ...action.args, ...change }, CONTRACT), /signature/);
  }
  const forged = { ...action.args, ticket_key: bob.publicKey };
  assert.throws(() => checkAction("catch", forged, CONTRACT), /signature/);
});

test("malformed actions are refused before they cost gas", () => {
  const args = alice.flag(CONTRACT, 3, 0).args;
  assert.throws(() => checkAction("flag", { ...args, slot: 5 }, CONTRACT), /slot/);
  assert.throws(() => checkAction("flag", { ...args, event_id: -1 }, CONTRACT), /event_id/);
  assert.throws(() => checkAction("flag", { ...args, ticket_key: "alice" }, CONTRACT), /ticket_key/);
  assert.throws(() => checkAction("flag", { ...args, signature: "AAAA" }, CONTRACT), /signature/);
  assert.throws(() => checkAction("flag", [], CONTRACT), /object/);
  assert.throws(() => checkAction("tally", args, CONTRACT), /unknown action/);
  const self = alice.vouch(CONTRACT, 3, alice.publicKey).args;
  assert.throws(() => checkAction("vouch", self, CONTRACT), /yourself/);
});

test("rate limits use a sliding window", () => {
  const limit = new RateLimit(2, 1000);
  assert.ok(limit.allow("a", 0));
  assert.ok(limit.allow("a", 10));
  assert.ok(!limit.allow("a", 999));
  assert.ok(limit.allow("b", 999));
  assert.ok(limit.allow("a", 1001));
});

test("the contract's panic message is reported", () => {
  const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: code window is closed" } } } };
  assert.equal(failureMessage(failure), "code window is closed");
});

async function serve(options: Partial<Parameters<typeof relayerServer>[0]> = {}) {
  const chain = new FakeChain();
  const view = new FakeView({ contractId: CONTRACT, rpcUrl: "http://unused" });
  view.tickets_.set(`3/${alice.publicKey}`, record("near:alice.testnet"));
  const server = relayerServer({ chain, view, contractId: CONTRACT, log: () => {}, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { chain, view, server, base, post };
}

test("the relayer submits a checked action and returns its transaction", async () => {
  const { chain, server, post } = await serve();
  try {
    const action = alice.catch(CONTRACT, 3, 1, 2, "zoo");
    const reply = await post("/v1/catch", action.args);
    assert.deepEqual(reply, { status: 200, body: { tx: "tx1" } });
    assert.deepEqual(chain.calls, [{ method: "catch", args: action.args }]);
  } finally {
    server.close();
  }
});

test("a cancellation's refund is claimed right after it", async () => {
  const { chain, server, post } = await serve();
  try {
    assert.equal((await post("/v1/cancel", alice.cancel(CONTRACT, 3).args)).status, 200);
    assert.deepEqual(chain.calls.map((c) => c.method), ["cancel_rsvp", "claim_owed"]);
    assert.deepEqual(chain.calls[1]!.args, { event_id: 3, payout_to: "near:alice.testnet" });
  } finally {
    server.close();
  }
});

test("the relayer answers clearly when it can't help", async () => {
  const { chain, server, base, post } = await serve({ perTicket: new RateLimit(2, 60_000) });
  try {
    assert.equal((await post("/v1/catch", bob.catch(CONTRACT, 3, 0, 1, "zoo").args)).status, 404);
    const bad = { ...alice.flag(CONTRACT, 3, 0).args, slot: 1 };
    assert.equal((await post("/v1/flag", bad)).status, 400);
    chain.answer = () => ({ ok: false, error: "code window is closed" });
    const late = await post("/v1/catch", alice.catch(CONTRACT, 3, 0, 1, "zoo").args);
    assert.deepEqual(late, { status: 422, body: { error: "code window is closed", tx: "tx1" } });
    assert.equal((await post("/v1/catch", alice.catch(CONTRACT, 3, 0, 2, "zoo").args)).status, 422);
    assert.equal((await post("/v1/catch", alice.catch(CONTRACT, 3, 0, 3, "zoo").args)).status, 429);
    const huge = await fetch(`${base}/v1/catch`, { method: "POST", body: "x".repeat(5000) });
    assert.equal(huge.status, 413);
    assert.equal((await fetch(`${base}/v1/nope`)).status, 404);
    const health = await (await fetch(`${base}/v1/health`)).json();
    assert.deepEqual(health, { ok: true, contract: CONTRACT, account: "relayer.testnet", faucet: false });
    const preflight = await fetch(`${base}/v1/catch`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  } finally {
    server.close();
  }
});

function event(overrides: Partial<Event> = {}): Event {
  return {
    organizer: "host.testnet", arbiter: "dao.testnet", token: "usdc.testnet", deposit: "1000000",
    capacity: 40, registered: 30, tickets_created: 30, owed_records: 0, owed_total: 0, status: "Active",
    schedule: {
      cancel_cutoff_ms: 1, rsvp_closes_at_ms: 2, checkin_opens_at_ms: 2,
      checkin_closes_at_ms: 3, reveal_deadline_ms: 4, dispute_ends_at_ms: 1000,
    },
    checkin: { slots: 2, required: 2, window_ms: 60_000 }, slots: [], tally: null, closed: false,
    ...overrides,
  };
}

test("each event's next step follows its deadlines and its tally", () => {
  assert.equal(nextStep(event(), 999), null);
  assert.equal(nextStep(event(), 1000), "tally");
  assert.equal(nextStep(event({ status: "Voided" }), 5), "tally");
  const tally = (paid: number) => ({ stage: "Done", paid_cursor: paid }) as Event["tally"];
  assert.equal(nextStep(event({ tally: tally(10) }), 1000), "payout");
  assert.equal(nextStep(event({ tally: tally(30) }), 1000), "close_event");
  assert.equal(nextStep(event({ tally: tally(30), closed: true }), 1000), null);
});

test("the keeper settles an event by itself, halving a page that runs out of gas", async () => {
  const view = new FakeView({ contractId: CONTRACT, rpcUrl: "http://unused" });
  const chain = new FakeChain();
  let state = event();
  view.events.set(0, state);
  // A tiny model of the contract: tally in one call, payouts out of gas above 4 per page.
  const contract = (method: string, limit: number): Omit<CallOutcome, "tx"> => {
    if (method === "tally") {
      state = { ...state, tally: { stage: "Done", paid_cursor: 0 } as Event["tally"] };
      return { ok: true };
    }
    if (method === "payout") {
      if (limit > 4) return { ok: false, error: "Exceeded the prepaid gas." };
      const paid = Math.min(state.registered, state.tally!.paid_cursor + limit);
      state = { ...state, tally: { ...state.tally!, paid_cursor: paid } };
      return { ok: true, value: paid === state.registered };
    }
    state = { ...state, closed: true };
    return { ok: true, value: true };
  };
  chain.answer = (method, args) => {
    const result = contract(method, args.limit as number);
    view.events.set(0, state);
    return result;
  };

  const keeper = new Keeper({ chain, view, closeDelayMs: 60_000, callsPerTick: 20, log: () => {} });
  await keeper.tick(999);
  assert.equal(chain.calls.length, 0, "nothing happens before the dispute window ends");
  await keeper.tick(1000);
  assert.equal(state.tally!.paid_cursor, 30);
  assert.ok(!state.closed, "closing waits for transfer callbacks to settle");
  const limits = chain.calls.filter((c) => c.method === "payout").map((c) => c.args.limit);
  assert.deepEqual(limits.slice(0, 2), [8, 4]);
  await keeper.tick(1000 + 60_000);
  assert.ok(state.closed);
  const before = chain.calls.length;
  await keeper.tick(1000 + 120_000);
  assert.equal(chain.calls.length, before, "a closed event is left alone");
});

const TOKEN = "usdc.testnet";
const open = event({ token: TOKEN, schedule: { ...event().schedule, rsvp_closes_at_ms: 500 } });

function signedRsvp(changes: Partial<FunctionCallDelegate> = {}, signer = alice): string {
  const delegate = rsvpDelegate({
    publicKey: alice.publicKey, token: TOKEN, contractId: CONTRACT, deposit: "1000000",
    note: alice.rsvpNote(3, `near:${alice.accountId}`), nonce: 9n, maxBlockHeight: 2000n,
  });
  return signer.signDelegate({ ...delegate, ...changes });
}

const context = (overrides: Partial<Parameters<typeof checkDelegate>[1]> = {}) => ({
  contractId: CONTRACT, eventId: 3, event: open, nowMs: 100, finalHeight: 1000n, ...overrides,
});

test("an exact RSVP transfer from the signer's implicit account is sponsored", () => {
  const checked = checkDelegate(signedRsvp(), context());
  assert.equal(checked.senderId, alice.accountId);
  assert.equal(checked.ticketKey, alice.publicKey);
});

test("anything other than the exact RSVP transfer is refused", () => {
  const note = (n: object) => JSON.stringify(n);
  const cases: [string, unknown, Partial<Parameters<typeof checkDelegate>[1]>, RegExp][] = [
    ["another method", signedRsvp({ methodName: "ft_transfer" }), {}, /ft_transfer_call/],
    ["another token", signedRsvp({ receiverId: "wrap.testnet" }), {}, /token/],
    ["another sender", signedRsvp({ senderId: bob.accountId }), {}, /implicit account/],
    ["not to Bail", signedRsvp({ args: { receiver_id: "thief.testnet", amount: "1000000", msg: alice.rsvpNote(3, "near:a.testnet") } }), {}, /go to Bail/],
    ["a bigger amount", signedRsvp({ args: { receiver_id: CONTRACT, amount: "5000000", msg: alice.rsvpNote(3, "near:a.testnet") } }), {}, /exactly/],
    ["extra arguments", signedRsvp({ args: { receiver_id: CONTRACT, amount: "1000000", msg: alice.rsvpNote(3, "near:a.testnet"), memo: "x" } }), {}, /unexpected/],
    ["another event's note", signedRsvp({ args: { receiver_id: CONTRACT, amount: "1000000", msg: alice.rsvpNote(4, "near:a.testnet") } }), {}, /another event/],
    ["an unpayable address", signedRsvp({ args: { receiver_id: CONTRACT, amount: "1000000", msg: note({ event_id: 3, ticket_key: alice.publicKey, payout_to: "near:Bad" }) } }), {}, /payable/],
    ["more gas", signedRsvp({ gas: 300_000_000_000_000n }), {}, /100 Tgas/],
    ["more yoctoNEAR", signedRsvp({ deposit: 2n }), {}, /1 yoctoNEAR/],
    ["an expired delegate", signedRsvp(), { finalHeight: 2000n }, /expired/],
    ["a closed event", signedRsvp(), { nowMs: 500 }, /not taking RSVPs/],
    ["a missing event", signedRsvp(), { event: null }, /not taking RSVPs/],
    ["trailing bytes", Buffer.concat([Buffer.from(signedRsvp(), "base64"), Buffer.of(0)]).toString("base64"), {}, /NEP-366|canonical/],
    ["garbage", "AAAA", {}, /NEP-366/],
    ["no string", 7, {}, /base64/],
  ];
  for (const [name, encoded, overrides, error] of cases) {
    assert.throws(() => checkDelegate(encoded, context(overrides)), error, name);
  }
  const tampered = Buffer.from(signedRsvp(), "base64");
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => checkDelegate(tampered.toString("base64"), context()), /signature/);
});

test("the faucet funds only implicit accounts for open events in its own token", () => {
  assert.deepEqual(checkFaucet({ account_id: alice.accountId }, open, TOKEN, 100), { accountId: alice.accountId, amount: 1_000_000n });
  assert.throws(() => checkFaucet({ account_id: "alice.testnet" }, open, TOKEN, 100), /implicit/);
  assert.throws(() => checkFaucet({ account_id: alice.accountId }, open, TOKEN, 500), /not taking RSVPs/);
  assert.throws(() => checkFaucet({ account_id: alice.accountId }, open, "wrap.testnet", 100), /test USDC/);
  assert.throws(() => checkFaucet({ account_id: alice.accountId }, { ...open, deposit: "6000000" }, TOKEN, 100), /5 USDC/);
});

test("a faucet request that failed before funding can be asked again", async () => {
  let calls = 0;
  const sponsor = {
    token: TOKEN,
    fund: async () => {
      if (calls++ === 0) throw new Error("the node is down");
      return { tx: "fundtx", ok: true };
    },
  } as unknown as Sponsor;
  const view = new (class extends FakeView {
    override async now(): Promise<number> {
      return 100;
    }
  })({ contractId: CONTRACT, rpcUrl: "http://unused" });
  view.events.set(3, open);
  const { server, post } = await serve({ view, sponsor });
  try {
    const body = { account_id: alice.accountId, event_id: 3 };
    assert.equal((await post("/v1/faucet", body)).status, 502);
    assert.deepEqual(await post("/v1/faucet", body), { status: 200, body: { tx: "fundtx" } });
    assert.equal((await post("/v1/faucet", body)).status, 429, "funded accounts are still refused a second time");
  } finally {
    server.close();
  }
});
