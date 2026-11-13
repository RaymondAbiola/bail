import assert from "node:assert/strict";
import { test } from "node:test";

import { openSlotArgs } from "@bail/sdk";

import { confirmHostWalletAction, waitForHostConfirmation } from "../src/lib/host-confirmation.ts";
import { matchingHostCode } from "../src/lib/host-reveal.ts";
import { CONTRACT, T0, makeEvent } from "./fixtures.ts";

test("a wallet that submits and then throws still succeeds when the chain confirms, including event id zero", async () => {
  let sends = 0;
  let checking = false;
  const id = await confirmHostWalletAction(
    async () => { sends++; throw new Error("Wallet closed"); },
    async () => { assert.equal(checking, true, "checking is shown before reading the chain"); return 0; },
    () => { checking = true; },
  );
  assert.equal(id, 0);
  assert.equal(sends, 1, "reconciliation must never resubmit the transaction");
});

test("confirmation tolerates delayed inclusion and intermittent RPC errors after a wallet failure", async () => {
  let reads = 0;
  let sends = 0;
  const confirmed = await confirmHostWalletAction(
    async () => { sends++; throw new Error("Wallet closed"); },
    async () => { reads++; if (reads === 1) return null; if (reads === 2) throw new Error("RPC unavailable"); return true; },
    () => {},
    { timeoutMs: 1000, intervalMs: 1 },
  );
  assert.equal(confirmed, true);
  assert.equal(reads, 3);
  assert.equal(sends, 1);
});

test("only an opened slot with this browser's commitment confirms an uncertain opening", async () => {
  const code = "tiger maple seven ocean lamp";
  const expected = openSlotArgs(CONTRACT, 8, 0, code);
  const opened = makeEvent({ slots: [{ opened_at_ms: T0, commitment: expected.commitment, flags: 0, revealed: null }] });
  let current = makeEvent();
  let reads = 0;
  assert.equal(await confirmHostWalletAction(
    async () => { throw new Error("Wallet closed"); },
    async () => {
      reads++;
      if (reads === 2) current = makeEvent({ slots: [{ ...opened.slots[0]!, commitment: "another commitment" }] });
      if (reads === 3) current = opened;
      return matchingHostCode(CONTRACT, 8, current, 0, code) ? true : null;
    },
    () => {}, { timeoutMs: 1000, intervalMs: 1 },
  ), true);
  assert.equal(reads, 3, "neither an unopened nor mismatched slot is confirmation");
});

test("a wallet error is shown only after the chain check finds no success", async () => {
  const error = new Error("Wallet closed");
  let reads = 0;
  await assert.rejects(confirmHostWalletAction(
    async () => { throw error; }, async () => { reads++; return null; }, () => {}, { timeoutMs: 0 },
  ), (caught) => caught === error);
  assert.equal(reads, 1);
});

test("a successful wallet reply is still checked on chain and is passed through for id lookup", async () => {
  const outcome = { status: { SuccessValue: btoa("8") } };
  assert.equal(await confirmHostWalletAction(async () => outcome, async (reply) => { assert.equal(reply, outcome); return 8; }, () => {}), 8);
  await assert.rejects(confirmHostWalletAction(async () => outcome, async () => null, () => {}, { timeoutMs: 0 }), /chain has not confirmed/);
});

test("an explicit failure in a wallet reply cannot override a successful chain result", async () => {
  assert.equal(await confirmHostWalletAction(async () => ({ status: { Failure: {} } }), async () => true, () => {}), true);
});

test("the confirmation deadline also bounds a stalled read", { timeout: 1000 }, async () => {
  assert.equal(await waitForHostConfirmation(() => new Promise<null>(() => {}), { timeoutMs: 10, intervalMs: 1 }), null);
});
