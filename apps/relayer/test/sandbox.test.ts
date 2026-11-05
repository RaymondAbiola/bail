// A whole event on a local NEAR node, through the real relayer and keeper. Needs the
// near-sandbox binary and both compiled contracts:
//   NEAR_SANDBOX_BIN=<path to near-sandbox> node --test test/sandbox.test.ts
// The wasm files come from `cargo near build non-reproducible-wasm` for contracts/bail and
// contracts/test-token.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BailView, Ticket, codeCommitment, toBase64 } from "@bail/sdk";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, nearToYocto, teraToGas } from "near-api-js";
import type { KeyPairString } from "near-api-js";

import { NearChain, RELAYER_METHODS } from "../src/chain.ts";
import { Keeper } from "../src/keeper.ts";
import { relayerServer } from "../src/server.ts";

const bin = process.env.NEAR_SANDBOX_BIN;
const root = new URL("../../../", import.meta.url).pathname;
const BAIL_WASM = join(root, "target/near/bail/bail.wasm");
const TOKEN_WASM = join(root, "target/near/test_token/test_token.wasm");
const MINUTE = 60_000;
const USDC = 1_000_000n;
const CODE = "tiger maple seven ocean lamp";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("an event runs through the relayer and the keeper settles it by itself", { skip: !bin, timeout: 900_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "bail-relayer-"));
  execFileSync(bin!, ["--home", home, "init"], { stdio: "ignore" });
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  const rpcPort = await freePort();
  config.rpc.addr = `127.0.0.1:${rpcPort}`;
  config.network.addr = `127.0.0.1:${await freePort()}`;
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const node = spawn(bin!, ["--home", home, "run"], { stdio: "ignore" });
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const servers: { close(): void }[] = [];
  let keeper: Keeper | undefined;

  try {
    for (let i = 0; ; i++) {
      const up = await fetch(`${rpcUrl}/status`).then((r) => r.ok, () => false);
      if (up) break;
      if (i > 120) throw new Error("the sandbox node did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    const provider = new JsonRpcProvider({ url: rpcUrl });
    const validator = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8"));
    const rootAccount = new Account(validator.account_id, provider, validator.secret_key as KeyPairString);

    async function newAccount(name: string, near: `${number}`, extraKeys: KeyPair[] = []): Promise<Account> {
      const id = `${name}.${validator.account_id}`;
      const key = KeyPair.fromRandom("ed25519");
      await rootAccount.signAndSendTransaction({
        receiverId: id,
        actions: [
          actions.createAccount(),
          actions.transfer(nearToYocto(near)),
          actions.addFullAccessKey(key.getPublicKey()),
          ...extraKeys.map((k) =>
            actions.addFunctionCallAccessKey(k.getPublicKey(), `bail.${validator.account_id}`, RELAYER_METHODS, nearToYocto("2")),
          ),
        ],
      });
      return new Account(id, provider, new KeyPairSigner(key));
    }
    const call = (from: Account, contractId: string, methodName: string, args: object, deposit = 0n, tgas = 100) =>
      from.callFunction({ contractId, methodName, args, deposit, gas: teraToGas(tgas) });

    const relayerKeys = [KeyPair.fromRandom("ed25519"), KeyPair.fromRandom("ed25519")];
    const [bail, usdc, organizer, arbiter, relayer, alice, bob, carol] = await Promise.all([
      newAccount("bail", "10"),
      newAccount("usdc", "10"),
      newAccount("organizer", "10"),
      newAccount("arbiter", "1"),
      newAccount("relayer", "10", relayerKeys),
      newAccount("alice", "1"),
      newAccount("bob", "1"),
      newAccount("carol", "1"),
    ]);
    await bail.signAndSendTransaction({
      receiverId: bail.accountId,
      actions: [
        actions.deployContract(readFileSync(BAIL_WASM)),
        actions.functionCall("new", {
          config: {
            fee_bps: 0, fee_account: null, min_window_ms: MINUTE, min_reveal_ms: 1000,
            min_dispute_ms: 1000, max_event_ms: 30 * 24 * 60 * MINUTE, intents_account: null,
          },
        }, teraToGas(30)),
      ],
    });
    await usdc.signAndSendTransaction({
      receiverId: usdc.accountId,
      actions: [
        actions.deployContract(readFileSync(TOKEN_WASM)),
        actions.functionCall("new", { owner_id: usdc.accountId, total_supply: String(100n * USDC) }, teraToGas(30)),
      ],
    });
    for (const holder of [bail, alice, bob, carol]) {
      await call(usdc, usdc.accountId, "storage_deposit", { account_id: holder.accountId }, nearToYocto("0.00125"));
    }
    for (const holder of [alice, bob, carol]) {
      await call(usdc, usdc.accountId, "ft_transfer", { receiver_id: holder.accountId, amount: String(USDC) }, 1n);
    }

    const view = new BailView({ contractId: bail.accountId, rpcUrl });
    const chain = new NearChain({
      accountId: relayer.accountId,
      contractId: bail.accountId,
      rpcUrl,
      keys: relayerKeys.map((k) => k.toString()),
    });
    const server = relayerServer({ chain, view, contractId: bail.accountId, log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const relayerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const relay = (kind: string, args: object) =>
      fetch(`${relayerUrl}/v1/${kind}`, { method: "POST", body: JSON.stringify(args) }).then(async (r) => ({
        status: r.status,
        body: await r.json(),
      }));

    const rpc = (method: string, params: object) =>
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }).then((r) => r.json());
    const height = async (finality: string) =>
      ((await rpc("block", { finality })) as { result: { header: { height: number } } }).result.header.height;

    // Fast-forwarding jumps the optimistic head ahead of the final one, and transactions
    // are anchored to a final block, so wait for finality to catch up before going on.
    async function advanceTo(ms: number): Promise<void> {
      while ((await view.now()) < ms) {
        await rpc("sandbox_fast_forward", { delta_height: 20 });
        await new Promise((r) => setTimeout(r, 300));
      }
      while ((await height("optimistic")) - (await height("final")) > 5) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    // One code slot, required. Alice catches it, Bob cancels, Carol never shows.
    const t0 = await view.now();
    const opens = t0 + 2 * MINUTE;
    const capacity = 4;
    const id = (await call(organizer, bail.accountId, "create_event", {
      event: {
        token: usdc.accountId, deposit: String(USDC), capacity, arbiter: arbiter.accountId,
        cancel_cutoff_ms: t0 + MINUTE, rsvp_closes_at_ms: opens, checkin_opens_at_ms: opens,
        checkin_closes_at_ms: opens + 4 * MINUTE, reveal_ms: MINUTE, dispute_ms: MINUTE,
        checkin: { slots: 1, required: 1, window_ms: MINUTE },
      },
    }, BigInt(await view.storageCost(capacity)))) as number;

    const tickets = { alice: Ticket.generate(), bob: Ticket.generate(), carol: Ticket.generate() };
    for (const [name, holder] of [["alice", alice], ["bob", bob], ["carol", carol]] as const) {
      const note = tickets[name].rsvpNote(id, `near:${holder.accountId}`);
      await call(holder, usdc.accountId, "ft_transfer_call", { receiver_id: bail.accountId, amount: String(USDC), msg: note }, 1n);
    }
    assert.equal((await view.event(id))!.registered, 3);

    const cancelled = await relay("cancel", tickets.bob.cancel(bail.accountId, id).args);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal((await view.event(id))!.registered, 2);
    assert.equal(await view.owed(id, `near:${bob.accountId}`), "0", "the relayer claimed Bob's refund");

    await advanceTo(opens);
    await call(organizer, bail.accountId, "open_slot", {
      event_id: id, slot: 0, commitment: toBase64(codeCommitment(bail.accountId, id, 0, CODE)),
    });
    const caught = await relay("catch", tickets.alice.catch(bail.accountId, id, 0, 1, CODE).args);
    assert.equal(caught.status, 200, JSON.stringify(caught.body));
    assert.equal((await view.ticket(id, tickets.alice.publicKey))!.catches[0]!.attempt, 1);
    const forged = await relay("catch", { ...tickets.alice.catch(bail.accountId, id, 0, 2, CODE).args, ticket_key: tickets.carol.publicKey });
    assert.equal(forged.status, 400, "a catch signed by one ticket can't be relayed for another");

    const opened = (await view.event(id))!.slots[0]!.opened_at_ms;
    await advanceTo(opened + MINUTE);
    await call(carol, bail.accountId, "reveal", { event_id: id, slot: 0, code: CODE });
    const event = (await view.event(id))!;
    await advanceTo(event.schedule.dispute_ends_at_ms);

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

    const balance = async (who: Account) =>
      BigInt((await usdc.provider.callFunction({ contractId: usdc.accountId, method: "ft_balance_of", args: { account_id: who.accountId } })) as string);
    assert.equal(await balance(alice), 2n * USDC, "Alice gets her deposit and Carol's");
    assert.equal(await balance(bob), USDC, "Bob's cancellation was refunded in full");
    assert.equal(await balance(carol), 0n);
    assert.equal(await balance(bail), 0n, "the contract holds nothing back");

    // Function-call keys are charged up front for the gas they attach; check none ran dry.
    for (const key of relayerKeys) {
      const access = await relayer.getAccessKey(key.getPublicKey());
      const permission = access.permission as { FunctionCall?: { allowance?: string | null } };
      assert.ok(BigInt(permission.FunctionCall!.allowance!) > 0n);
    }
  } finally {
    keeper?.stop();
    for (const s of servers) s.close();
    node.kill();
    rmSync(home, { recursive: true, force: true });
  }
});
