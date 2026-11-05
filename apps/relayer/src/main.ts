// Configuration comes from the environment, so keys are never written to the repository.
// RELAYER_ACCOUNT  the account holding the function-call keys, such as relayer.dontbail.testnet
// RELAYER_KEYS     its function-call secret keys, comma-separated (never logged)
// BAIL_CONTRACT    default v1.dontbail.testnet
// NEAR_RPC         default https://rpc.testnet.near.org
// PORT             default 8787
// ALLOW_ORIGIN     the web app's origin, default *
// KEEPER           set to "off" to run the relayer without the keeper

import { BailView, TESTNET } from "@bail/sdk";

import { NearChain } from "./chain.ts";
import { Keeper } from "./keeper.ts";
import { relayerServer } from "./server.ts";

const env = process.env;
const required = (name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const contractId = env.BAIL_CONTRACT ?? TESTNET.contractId;
const rpcUrl = env.NEAR_RPC ?? TESTNET.rpcUrl;
const chain = new NearChain({
  accountId: required("RELAYER_ACCOUNT"),
  contractId,
  rpcUrl,
  keys: required("RELAYER_KEYS").split(",").map((k) => k.trim()).filter(Boolean),
});
const view = new BailView({ contractId, rpcUrl });
const port = Number(env.PORT ?? 8787);

relayerServer({ chain, view, contractId, allowOrigin: env.ALLOW_ORIGIN }).listen(port, () => {
  console.log(`relayer for ${contractId} as ${chain.accountId} with ${chain.keyCount} keys on :${port}`);
});
if (env.KEEPER !== "off") new Keeper({ chain, view }).start();
