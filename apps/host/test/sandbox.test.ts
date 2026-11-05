// The testnet rehearsal, on a local NEAR node: the console creates and runs an event,
// three SDK-driven attendees RSVP through the faucet and two catch every code, and the
// keeper settles it.
//   NEAR_SANDBOX_BIN=<path to near-sandbox> node --test test/sandbox.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { NearChain, RELAYER_METHODS, Sender } from "@bail/relayer/src/chain.ts";
import { Keeper } from "@bail/relayer/src/keeper.ts";
import { Sponsor } from "@bail/relayer/src/onboarding.ts";
import { relayerServer } from "@bail/relayer/src/server.ts";
import { BailView, RelayerClient, Ticket } from "@bail/sdk";
import { MINUTE, type Sandbox, USDC, startSandbox } from "@bail/testkit";
import { KeyPair } from "near-api-js";

import { catchSlot, rsvpBots } from "../src/bots.ts";
import { type Host, createEvent, grantKey, report, runLive } from "../src/host.ts";
import { loadState } from "../src/state.ts";

const bin = process.env.NEAR_SANDBOX_BIN;

test("the console runs a whole event with SDK-driven attendees, and the keeper settles it", { skip: !bin, timeout: 900_000 }, async () => {
  let sandbox: Sandbox | undefined;
  let server: { close(): void } | undefined;
  try {
    const sb = (sandbox = await startSandbox(bin!));
    const relayerKeys = [KeyPair.fromRandom("ed25519"), KeyPair.fromRandom("ed25519")];
    const sponsorKey = KeyPair.fromRandom("ed25519");
    const [bail, usdc, organizer, arbiter, relayer, faucet] = await Promise.all([
      sb.deployBail(),
      sb.deployToken(),
      sb.newAccount("organizer", "10"),
      sb.newAccount("arbiter", "1"),
      sb.newAccount("relayer", "10", {
        functionCallKeys: { keys: relayerKeys, receiverId: sb.id("bail"), methods: RELAYER_METHODS, allowance: "2" },
      }),
      sb.newAccount("faucet", "10", { key: sponsorKey }),
    ]);
    await sb.fund(usdc, [bail], 0n);
    await sb.fund(usdc, [faucet], 10n * USDC);

    const view = new BailView({ contractId: bail.accountId, rpcUrl: sb.rpcUrl });
    const chain = new NearChain({ accountId: relayer.accountId, contractId: bail.accountId, rpcUrl: sb.rpcUrl, keys: relayerKeys.map(String) });
    const sponsor = new Sponsor(new Sender({ accountId: faucet.accountId, rpcUrl: sb.rpcUrl, keys: [sponsorKey.toString()] }), usdc.accountId, view);
    const http = relayerServer({ chain, view, contractId: bail.accountId, sponsor, log: () => {} });
    server = http;
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const relayerClient = new RelayerClient(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);

    const host: Host = { view, contractId: bail.accountId, organizer, stateDir: mkdtempSync(join(tmpdir(), "bail-host-")) };
    const now = await view.now();
    const id = await createEvent(host, {
      token: usdc.accountId, deposit: USDC, capacity: 4, arbiter: arbiter.accountId,
      checkinOpensAt: now + 3 * MINUTE, checkinMinutes: 5, slots: 2, required: 2, windowMinutes: 1,
      revealMinutes: 1, disputeMinutes: 1, cancelBeforeMinutes: 1,
    });
    await grantKey(host, id);

    const log = () => {};
    const state = await rsvpBots(view, relayerClient, host.stateDir, id, { count: 3, miss: 1, log });
    assert.equal((await view.event(id))!.registered, 3);

    await sb.advanceTo(view, (await view.event(id))!.schedule.checkin_opens_at_ms);
    const opened: number[] = [];
    await runLive({ ...host, organizer: undefined }, id, {
      earliest: true,
      show: () => {},
      sleepUntil: (ms) => sb.advanceTo(view, ms),
      onOpen: async (slot) => {
        opened.push(slot);
        await catchSlot(view, relayerClient, state, slot, log);
      },
    });
    const event = (await view.event(id))!;
    assert.deepEqual(opened, [0, 1]);
    assert.deepEqual(event.slots.map((s) => s.revealed), loadState(host.stateDir, bail.accountId, id).codes);
    assert.ok(event.slots[1]!.opened_at_ms >= event.slots[0]!.opened_at_ms + MINUTE, "slots never overlap");

    await sb.advanceTo(view, event.schedule.dispute_ends_at_ms);
    // The keeper waits before closing, so attendees can still look up their results.
    await new Keeper({ chain, view, closeDelayMs: 60 * MINUTE, log }).tick();
    assert.ok(!(await view.event(id))!.closed);
    const before = await report(view, id);
    assert.match(before, /Attended 2, vouched 0, forfeited 1/);
    assert.match(before, /Show-up rate: 67%/);
    assert.match(before, /\| 1 \| near:[0-9a-f]{64} \| 0 \| 0 \| Forfeited \| 0 \|/);
    assert.match(before, /\| 2 \| near:[0-9a-f]{64} \| 2 \| 0 \| Attended \| 1\.5 \| yes \|/);
    const keeper = new Keeper({ chain, view, closeDelayMs: 0, log });
    for (let i = 0; i < 5 && !(await view.event(id))!.closed; i++) await keeper.tick();
    assert.ok((await view.event(id))!.closed);
    const after = await report(view, id);
    assert.match(after, /RSVPs: 3 of 4 seats/);
    assert.match(after, /Tickets were freed when the event closed/);

    const [missed, ...caught] = state.bots!.map((b) => Ticket.restore(b.backup).accountId);
    assert.equal(await sb.balance(usdc.accountId, missed!), 0n);
    for (const account of caught) assert.equal(await sb.balance(usdc.accountId, account), USDC + USDC / 2n);
    assert.equal(await sb.balance(usdc.accountId, bail.accountId), 0n);
  } finally {
    server?.close();
    sandbox?.stop();
  }
});
