// Adds keys for the relayer and writes them to apps/relayer/.env.
//
//   node scripts/keys.ts relayer.dontbail.testnet [count] [--sponsor faucet.dontbail.testnet]
//
// Signs with each account's full-access key from near-cli's legacy keychain
// (~/.near-credentials/testnet/<account>.json). The relayer's new keys can only call
// Bail's relayer and keeper methods, none of which moves the account's NEAR. With
// --sponsor, the faucet account gets a new full-access key of its own, so the server
// never holds the key you created it with; keep that account's balance small. No key is printed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { TESTNET } from "@bail/sdk";
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto } from "near-api-js";
import type { KeyPairString } from "near-api-js";

import { RELAYER_METHODS } from "../src/chain.ts";

const args = process.argv.slice(2);
const sponsorAt = args.indexOf("--sponsor");
const sponsorId = sponsorAt >= 0 ? args.splice(sponsorAt, 2)[1] : undefined;
const [accountId, countArg = "4"] = args;
if (!accountId) throw new Error("usage: node scripts/keys.ts <relayer account> [count] [--sponsor <account>]");
const count = Number(countArg);
const envFile = new URL("../.env", import.meta.url).pathname;
if (existsSync(envFile)) throw new Error(`${envFile} already exists; move it away to make new keys`);

const provider = new JsonRpcProvider({ url: TESTNET.rpcUrl });
function fromKeychain(id: string): Account {
  const credentials = join(homedir(), ".near-credentials", "testnet", `${id}.json`);
  const { private_key } = JSON.parse(readFileSync(credentials, "utf8")) as { private_key: string };
  return new Account(id, provider, private_key as KeyPairString);
}
const account = fromKeychain(accountId);

// Unused gas is refunded to a key's allowance, so 2 NEAR covers the up-front charge
// for a 300 Tgas keeper call (just over 1 NEAR) with room to spare.
const keys = Array.from({ length: count }, () => KeyPair.fromRandom("ed25519"));
const result = await account.signAndSendTransaction({
  receiverId: accountId,
  actions: keys.map((key) =>
    actions.addFunctionCallAccessKey(key.getPublicKey(), TESTNET.contractId, RELAYER_METHODS, nearToYocto("2")),
  ),
});

console.log(`added ${count} function-call keys to ${accountId} (tx ${result.transaction.hash})`);
const lines = [
  `RELAYER_ACCOUNT=${accountId}`,
  `RELAYER_KEYS=${keys.map((k) => k.toString()).join(",")}`,
  `BAIL_CONTRACT=${TESTNET.contractId}`,
];

if (sponsorId) {
  const sponsorKey = KeyPair.fromRandom("ed25519");
  const added = await fromKeychain(sponsorId).signAndSendTransaction({
    receiverId: sponsorId,
    actions: [actions.addFullAccessKey(sponsorKey.getPublicKey())],
  });
  console.log(`added a full-access key for the faucet to ${sponsorId} (tx ${added.transaction.hash})`);
  lines.push(`SPONSOR_ACCOUNT=${sponsorId}`, `SPONSOR_KEY=${sponsorKey.toString()}`);
}

writeFileSync(envFile, [...lines, ""].join("\n"), { mode: 0o600 });
console.log(`wrote ${envFile}`);
