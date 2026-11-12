import assert from "node:assert/strict";
import { test } from "node:test";

import type { BailView } from "@bail/sdk";

import { checkPayoutAccount } from "../src/lib/payout-account.ts";

function chain(existing: string[], unavailable: string[] = []) {
  const calls: string[] = [];
  const view: Pick<BailView, "rpc"> = {
    async rpc<T>(method: string, params: object): Promise<T> {
      const p = params as { request_type: string; account_id: string; finality: string };
      assert.equal(method, "query");
      assert.equal(p.request_type, "view_account");
      assert.equal(p.finality, "final");
      calls.push(p.account_id);
      if (unavailable.includes(p.account_id)) throw new TypeError("Failed to fetch");
      if (!existing.includes(p.account_id)) throw new Error(`query: ${JSON.stringify({ cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: p.account_id } } })}`);
      return { amount: "0", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 0 } as T;
    },
  };
  return { view, calls };
}

test("an existing named payout account is accepted through view_account", async () => {
  const { view, calls } = chain(["alice.testnet"]);
  assert.deepEqual(await checkPayoutAccount(view, "near:alice.testnet"), { ok: true });
  assert.deepEqual(calls, ["alice.testnet"]);
});

test("a missing bare name suggests .testnet only when that account exists", async () => {
  const known = chain(["adetomiwa.testnet"]);
  assert.deepEqual(await checkPayoutAccount(known.view, "near:adetomiwa"), {
    ok: false, kind: "missing", suggestion: "adetomiwa.testnet",
    message: "There is no NEAR account called adetomiwa. Did you mean adetomiwa.testnet?",
  });
  assert.deepEqual(known.calls, ["adetomiwa", "adetomiwa.testnet"]);
  for (const unavailable of [[], ["adetomiwa.testnet"]]) {
    const missing = chain([], unavailable);
    const result = await checkPayoutAccount(missing.view, "near:adetomiwa");
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : "", /There is no NEAR account called adetomiwa\./);
    assert.equal("suggestion" in result, false);
  }
});

test("missing dotted names are refused without guessing another suffix", async () => {
  const { view, calls } = chain([]);
  const result = await checkPayoutAccount(view, "near:missing.testnet");
  assert.equal(!result.ok && result.kind, "missing");
  assert.deepEqual(calls, ["missing.testnet"]);
});

test("64-hex implicit accounts are accepted without any RPC request", async () => {
  const { view, calls } = chain([]);
  assert.deepEqual(await checkPayoutAccount(view, `near:${"a".repeat(64)}`), { ok: true });
  assert.deepEqual(calls, []);
});

test("an RPC outage blocks continuing without declaring an account missing", async () => {
  const { view, calls } = chain([], ["alice.testnet"]);
  const result = await checkPayoutAccount(view, "near:alice.testnet");
  assert.equal(!result.ok && result.kind, "unavailable");
  assert.doesNotMatch(!result.ok ? result.message : "", /There is no NEAR account/);
  assert.deepEqual(calls, ["alice.testnet"]);
});

test("invalid or unsupported payout addresses are refused before RPC", async () => {
  const { view, calls } = chain([]);
  for (const address of ["near:ALICE.testnet", "near:", "alice.testnet", "intents:alice.testnet"]) {
    const result = await checkPayoutAccount(view, address);
    assert.equal(!result.ok && result.kind, "invalid");
  }
  assert.deepEqual(calls, []);
});
