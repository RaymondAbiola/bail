// Adds function-call keys for the relayer and writes them to apps/relayer/.env.
//
//   node scripts/keys.ts relayer.dontbail.testnet [count]
//
// Signs with the relayer account's full-access key from near-cli's legacy keychain
// (~/.near-credentials/testnet/<account>.json). The new keys can only call Bail's
// relayer and keeper methods, none of which moves the account's NEAR. No key is printed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { TESTNET } from "@bail/sdk";
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto } from "near-api-js";
import type { KeyPairString } from "near-api-js";

import { RELAYER_METHODS } from "../src/chain.ts";

const [accountId, countArg = "4"] = process.argv.slice(2);
if (!accountId) throw new Error("usage: node scripts/keys.ts <relayer account> [count]");
const count = Number(countArg);
const envFile = new URL("../.env", import.meta.url).pathname;
if (existsSync(envFile)) throw new Error(`${envFile} already exists; move it away to make new keys`);

const credentials = join(homedir(), ".near-credentials", "testnet", `${accountId}.json`);
const { private_key } = JSON.parse(readFileSync(credentials, "utf8")) as { private_key: string };
const account = new Account(accountId, new JsonRpcProvider({ url: TESTNET.rpcUrl }), private_key as KeyPairString);

// Unused gas is refunded to a key's allowance, so 2 NEAR covers the up-front charge
// for a 300 Tgas keeper call (just over 1 NEAR) with room to spare.
const keys = Array.from({ length: count }, () => KeyPair.fromRandom("ed25519"));
const result = await account.signAndSendTransaction({
  receiverId: accountId,
  actions: keys.map((key) =>
    actions.addFunctionCallAccessKey(key.getPublicKey(), TESTNET.contractId, RELAYER_METHODS, nearToYocto("2")),
  ),
});

writeFileSync(
  envFile,
  [
    `RELAYER_ACCOUNT=${accountId}`,
    `RELAYER_KEYS=${keys.map((k) => k.toString()).join(",")}`,
    `BAIL_CONTRACT=${TESTNET.contractId}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.log(`added ${count} function-call keys to ${accountId} (tx ${result.transaction.hash})`);
console.log(`wrote ${envFile}`);
