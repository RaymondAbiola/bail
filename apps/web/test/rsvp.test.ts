import assert from "node:assert/strict";
import { test } from "node:test";

import { BailView, Ticket, type TicketRecord } from "@bail/sdk";

import { RsvpError, type RsvpStep, confirmSeat, runRsvp } from "../src/lib/rsvp.ts";
import { CONTRACT, makeEvent, makeTicket } from "./fixtures.ts";

const ticket = Ticket.generate();
const event = makeEvent({ token: "usdc.testnet" });
const noWait = async () => {};

/** A chain that answers from plain variables, so each test says exactly what the chain knows. */
class FakeChain extends BailView {
  balance = 0n;
  seat: TicketRecord | null = null;
  nonce: bigint | null = 7n;
  owedAmount = "0";
  onBalanceRead: () => void = () => {};
  payoutError: Error | null = null;

  constructor() {
    super({ contractId: CONTRACT, rpcUrl: "http://unused" });
  }

  override async rpc<T>(_method: string, _params: object): Promise<T> {
    if ((_params as { request_type?: string }).request_type === "view_account") {
      if (this.payoutError) throw this.payoutError;
      return { amount: "0" } as T;
    }
    this.onBalanceRead();
    return { result: [...new TextEncoder().encode(JSON.stringify(String(this.balance)))] } as T;
  }
  override async ticket(): Promise<TicketRecord | null> { return this.seat; }
  override async accessKeyNonce(): Promise<bigint | null> { return this.nonce; }
  override async finalHeight(): Promise<bigint> { return 1000n; }
  override async owed(): Promise<string> { return this.owedAmount; }
}

class FakeRelayer {
  faucetCalls = 0;
  metaCalls = 0;
  faucetImpl: () => Promise<{ tx: string }> = async () => ({ tx: "fund" });
  metaImpl: () => Promise<{ tx: string; seated: boolean }> = async () => ({ tx: "rsvp", seated: true });
  async faucet() { this.faucetCalls++; return this.faucetImpl(); }
  async meta() { this.metaCalls++; return this.metaImpl(); }
}

function setup() {
  const view = new FakeChain();
  const relayer = new FakeRelayer();
  const steps: RsvpStep[] = [];
  const run = () => runRsvp({ view, relayer, contractId: CONTRACT, sleep: noWait }, { eventId: 3, event, ticket, payoutTo: "near:alice.testnet" }, (s) => steps.push(s));
  return { view, relayer, steps, run };
}

test("a fresh key is funded, signs its deposit and is seated", async () => {
  const { view, relayer, steps, run } = setup();
  relayer.faucetImpl = async () => { view.balance = 1_000_000n; return { tx: "fund" }; };
  relayer.metaImpl = async () => { view.seat = makeTicket(); return { tx: "rsvp", seated: true }; };
  assert.deepEqual(await run(), { kind: "seated", tx: "rsvp" });
  assert.deepEqual(steps, ["checking", "funding", "waiting-for-funds", "signing", "submitting", "confirming"]);
  assert.equal(relayer.faucetCalls, 1);
  assert.equal(relayer.metaCalls, 1);
});

test("a ticket that is already seated sends nothing", async () => {
  const { view, relayer, run } = setup();
  view.seat = makeTicket();
  view.payoutError = new Error('query: {"cause":{"name":"UNKNOWN_ACCOUNT"}}');
  assert.deepEqual(await run(), { kind: "seated" });
  assert.equal(relayer.faucetCalls + relayer.metaCalls, 0);
});

test("an invalid saved payout blocks payment before funding or a deposit can be sent", async () => {
  for (const failure of [new Error('query: {"cause":{"name":"UNKNOWN_ACCOUNT"}}'), new TypeError("Failed to fetch")]) {
    const { view, relayer, run } = setup();
    view.payoutError = failure;
    await assert.rejects(run, (error: unknown) => error instanceof RsvpError && error.safeToRetry && /account/i.test(error.message));
    assert.equal(relayer.faucetCalls, 0);
    assert.equal(relayer.metaCalls, 0);
  }
});

test("an account that already holds the deposit skips the faucet", async () => {
  const { view, relayer, run } = setup();
  view.balance = 1_000_000n;
  relayer.metaImpl = async () => { view.seat = makeTicket(); return { tx: "rsvp", seated: true }; };
  assert.equal((await run()).kind, "seated");
  assert.equal(relayer.faucetCalls, 0);
});

test("'already funded' after an earlier try is not an error when the funds are there", async () => {
  const { view, relayer, run } = setup();
  relayer.faucetImpl = async () => { view.balance = 1_000_000n; throw new Error("this account was already funded for this event"); };
  relayer.metaImpl = async () => { view.seat = makeTicket(); return { tx: "rsvp", seated: true }; };
  assert.equal((await run()).kind, "seated");
});

test("a faucet refusal stops safely, with the relayer's own words and nothing spent", async () => {
  const { relayer, run } = setup();
  relayer.faucetImpl = async () => { throw new Error("too many faucet requests from this address"); };
  await assert.rejects(run, (error: unknown) => error instanceof RsvpError && error.safeToRetry && /too many faucet/i.test(error.message));
  assert.equal(relayer.metaCalls, 0);
});

test("funds that never arrive stop the RSVP before anything is signed", async () => {
  const { relayer, run } = setup();
  await assert.rejects(run, /has not arrived/);
  assert.equal(relayer.metaCalls, 0);
});

test("a lost reply is settled by reading the chain, not by sending again", async () => {
  const landed = setup();
  landed.view.balance = 1_000_000n;
  landed.relayer.metaImpl = async () => { landed.view.seat = makeTicket(); throw new TypeError("Failed to fetch"); };
  assert.equal((await landed.run()).kind, "seated");
  assert.equal(landed.relayer.metaCalls, 1);

  const lost = setup();
  lost.view.balance = 1_000_000n;
  lost.relayer.metaImpl = async () => { throw new TypeError("Failed to fetch"); };
  assert.deepEqual(await lost.run(), { kind: "unknown" });
  assert.equal(lost.relayer.metaCalls, 1, "no second deposit was sent");
});

test("a deposit the relayer says was seated but the chain does not show is unknown, not a promise", async () => {
  const { view, relayer, run } = setup();
  view.balance = 1_000_000n;
  relayer.metaImpl = async () => ({ tx: "rsvp", seated: true });
  assert.deepEqual(await run(), { kind: "unknown" });
});

test("a deposit that reached Bail without a seat is reported with what is owed", async () => {
  const { view, relayer, run } = setup();
  view.balance = 1_000_000n;
  view.owedAmount = "1000000";
  relayer.metaImpl = async () => ({ tx: "rsvp", seated: false });
  assert.deepEqual(await run(), { kind: "not-seated", tx: "rsvp", owed: "1000000" });
});

test("the relayer or contract refusing the deposit is shown as a safe retry", async () => {
  const { view, relayer, run } = setup();
  view.balance = 1_000_000n;
  relayer.metaImpl = async () => { throw new Error("this event is not taking RSVPs"); };
  await assert.rejects(run, (error: unknown) => error instanceof RsvpError && error.safeToRetry && /not taking RSVPs/.test(error.message));
});

test("a ticket account that is not ready yet stops before signing", async () => {
  const { view, relayer, run } = setup();
  view.balance = 1_000_000n;
  view.nonce = null;
  await assert.rejects(run, /not ready yet/);
  assert.equal(relayer.metaCalls, 0);
});

test("confirming a seat tolerates reads that fail along the way", async () => {
  const view = new FakeChain();
  let reads = 0;
  view.ticket = async () => { if (reads++ < 2) throw new Error("rpc down"); return makeTicket(); };
  assert.equal(await confirmSeat({ view, relayer: new FakeRelayer(), contractId: CONTRACT, sleep: noWait }, 3, ticket.publicKey), true);
});
