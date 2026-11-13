// A whole event on a local NEAR node, through the real relayer and keeper:
//   NEAR_SANDBOX_BIN=<path to near-sandbox> node --test test/sandbox.test.ts

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { BailView, type FunctionCallDelegate, Ticket, codeCommitment, rsvpDelegate, toBase64 } from "@bail/sdk";
import { MINUTE, type Sandbox, USDC, startSandbox } from "@bail/testkit";
import { KeyPair } from "near-api-js";

import { NearChain, RELAYER_METHODS, Sender } from "../src/chain.ts";
import { Keeper } from "../src/keeper.ts";
import { Sponsor } from "../src/onboarding.ts";
import { relayerServer } from "../src/server.ts";

const bin = process.env.NEAR_SANDBOX_BIN;
const CODE = "tiger maple seven ocean lamp";

test("a fresh browser key RSVPs through the faucet, the event runs through the relayer, and the keeper settles it", { skip: !bin, timeout: 900_000 }, async () => {
  let sandbox: Sandbox | undefined;
  const servers: { close(): void }[] = [];
  let keeper: Keeper | undefined;

  try {
    const sb = (sandbox = await startSandbox(bin!));
    const relayerKeys = [KeyPair.fromRandom("ed25519"), KeyPair.fromRandom("ed25519")];
    const sponsorKey = KeyPair.fromRandom("ed25519");
    const [bail, usdc, organizer, arbiter, relayer, faucet, bob, carol] = await Promise.all([
      sb.deployBail(),
      sb.deployToken(),
      sb.newAccount("organizer", "10"),
      sb.newAccount("arbiter", "1"),
      sb.newAccount("relayer", "10", {
        functionCallKeys: { keys: relayerKeys, receiverId: sb.id("bail"), methods: RELAYER_METHODS, allowance: "2" },
      }),
      sb.newAccount("faucet", "10", { key: sponsorKey }),
      sb.newAccount("bob", "1"),
      sb.newAccount("carol", "1"),
    ]);
    await sb.fund(usdc, [bail], 0n);
    await sb.fund(usdc, [faucet], 10n * USDC);
    await sb.fund(usdc, [bob, carol], USDC);

    const view = new BailView({ contractId: bail.accountId, rpcUrl: sb.rpcUrl });
    const chain = new NearChain({
      accountId: relayer.accountId,
      contractId: bail.accountId,
      rpcUrl: sb.rpcUrl,
      keys: relayerKeys.map((k) => k.toString()),
    });
    const sponsor = new Sponsor(new Sender({ accountId: faucet.accountId, rpcUrl: sb.rpcUrl, keys: [sponsorKey.toString()] }), usdc.accountId, view);
    const server = relayerServer({ chain, view, contractId: bail.accountId, sponsor, log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const relayerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const relay = (kind: string, args: object) =>
      fetch(`${relayerUrl}/v1/${kind}`, { method: "POST", body: JSON.stringify(args) }).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as Record<string, unknown>,
      }));
    const balance = (accountId: string) => sb.balance(usdc.accountId, accountId);

    // One code slot, required. Alice catches it, Bob cancels, Carol never shows.
    const t0 = await view.now();
    const opens = t0 + 2 * MINUTE;
    const capacity = 4;
    const id = (await sb.call(organizer, bail.accountId, "create_event", {
      event: {
        token: usdc.accountId, deposit: String(USDC), capacity, arbiter: arbiter.accountId,
        cancel_cutoff_ms: t0 + MINUTE, rsvp_closes_at_ms: opens, checkin_opens_at_ms: opens,
        checkin_closes_at_ms: opens + 4 * MINUTE, reveal_ms: MINUTE, dispute_ms: MINUTE,
        checkin: { slots: 1, required: 1, window_ms: MINUTE },
      },
    }, BigInt(await view.storageCost(capacity)))) as number;

    const tickets = { alice: Ticket.generate(), bob: Ticket.generate(), carol: Ticket.generate() };
    for (const [name, holder] of [["bob", bob], ["carol", carol]] as const) {
      const note = tickets[name].rsvpNote(id, `near:${holder.accountId}`);
      await sb.call(holder, usdc.accountId, "ft_transfer_call", { receiver_id: bail.accountId, amount: String(USDC), msg: note }, 1n);
    }

    // Alice is a fresh browser key: no account, no NEAR, no tokens.
    const alice = tickets.alice;
    assert.equal(await view.accessKeyNonce(alice.accountId, alice.publicKey), null);
    const funded = await relay("faucet", { account_id: alice.accountId, event_id: id });
    assert.equal(funded.status, 200, JSON.stringify(funded.body));
    assert.equal(await balance(alice.accountId), USDC, "the faucet sends exactly one deposit");
    assert.equal((await relay("faucet", { account_id: alice.accountId, event_id: id })).status, 429, "once per account");

    const signRsvp = async (changes: Partial<FunctionCallDelegate> = {}) => {
      const nonce = (await view.accessKeyNonce(alice.accountId, alice.publicKey))!;
      const delegate = rsvpDelegate({
        publicKey: alice.publicKey, token: usdc.accountId, contractId: bail.accountId, deposit: String(USDC),
        note: alice.rsvpNote(id, `near:${alice.accountId}`), nonce: nonce + 1n, maxBlockHeight: (await view.finalHeight()) + 1000n,
      });
      return alice.signDelegate({ ...delegate, ...changes });
    };
    const stealing = await signRsvp({ methodName: "ft_transfer", args: { receiver_id: carol.accountId, amount: String(USDC) } });
    assert.equal((await relay("meta", { event_id: id, signed_delegate: stealing })).status, 400, "only RSVPs are sponsored");
    const signed = await signRsvp();
    const paid = await relay("meta", { event_id: id, signed_delegate: signed });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.seated, true);
    const replay = await relay("meta", { event_id: id, signed_delegate: signed });
    assert.equal(replay.status, 422, "a signed delegate can't be replayed");
    assert.equal((await view.event(id))!.registered, 3);
    assert.equal(await balance(alice.accountId), 0n);

    const cancelled = await relay("cancel", tickets.bob.cancel(bail.accountId, id).args);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal((await view.event(id))!.registered, 2);
    assert.equal(await view.owed(id, `near:${bob.accountId}`), "0", "the relayer claimed Bob's refund");

    await sb.advanceTo(view, opens);
    await sb.call(organizer, bail.accountId, "open_slot", {
      event_id: id, slot: 0, commitment: toBase64(codeCommitment(bail.accountId, id, 0, CODE)),
    });
    const caught = await relay("catch", tickets.alice.catch(bail.accountId, id, 0, 1, CODE).args);
    assert.equal(caught.status, 200, JSON.stringify(caught.body));
    assert.equal((await view.ticket(id, tickets.alice.publicKey))!.catches[0]!.attempt, 1);
    const forged = await relay("catch", { ...tickets.alice.catch(bail.accountId, id, 0, 2, CODE).args, ticket_key: tickets.carol.publicKey });
    assert.equal(forged.status, 400, "a catch signed by one ticket can't be relayed for another");

    const opened = (await view.event(id))!.slots[0]!.opened_at_ms;
    await sb.advanceTo(view, opened + MINUTE);
    // The host hands the code to the relayer, which checks it against the commitment and reveals it.
    const wrong = await relay("reveal", { event_id: id, slot: 0, code: "not the code" });
    assert.equal(wrong.status, 400, "a code that doesn't match its commitment costs no gas");
    const revealed = await relay("reveal", { event_id: id, slot: 0, code: CODE });
    assert.equal(revealed.status, 200, JSON.stringify(revealed.body));
    assert.equal((await view.event(id))!.slots[0]!.revealed, CODE);
    await sb.advanceTo(view, (await view.event(id))!.schedule.dispute_ends_at_ms);

    // Nobody calls tally, payout or close: the keeper does it all.
    keeper = new Keeper({ chain, view, closeDelayMs: 0, log: () => {} });
    for (let i = 0; i < 10 && !(await view.event(id))!.closed; i++) {
      await keeper.tick();
      await new Promise((r) => setTimeout(r, 1000));
    }
    const settled = (await view.event(id))!;
    assert.ok(settled.closed, "the keeper closed the event");
    assert.equal(settled.tally!.attended, 1);
    assert.equal(settled.tally!.forfeited, 1);
    assert.equal(await balance(alice.accountId), 2n * USDC, "Alice gets her deposit and Carol's");
    assert.equal(await balance(bob.accountId), USDC, "Bob's cancellation was refunded in full");
    assert.equal(await balance(carol.accountId), 0n);
    assert.equal(await balance(bail.accountId), 0n, "the contract holds nothing back");

    // Function-call keys are charged up front for the gas they attach; check none ran dry.
    for (const key of relayerKeys) {
      const access = await relayer.getAccessKey(key.getPublicKey());
      const permission = access.permission as { FunctionCall?: { allowance?: string | null } };
      assert.ok(BigInt(permission.FunctionCall!.allowance!) > 0n);
    }
  } finally {
    keeper?.stop();
    for (const s of servers) s.close();
    sandbox?.stop();
  }
});
