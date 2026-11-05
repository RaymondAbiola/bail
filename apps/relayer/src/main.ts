// Configuration comes from the environment, so keys are never written to the repository.
// RELAYER_ACCOUNT  the account holding the function-call keys, such as relayer.dontbail.testnet
// RELAYER_KEYS     its function-call secret keys, comma-separated (never logged)
// BAIL_CONTRACT    default v1.dontbail.testnet
// NEAR_RPC         default https://rpc.testnet.near.org
// PORT             default 8787
// ALLOW_ORIGIN     the web app's origin, default *
// KEEPER           set to "off" to run the relayer without the keeper
// SPONSOR_ACCOUNT  testnet only: an account holding test NEAR and test USDC for onboarding
// SPONSOR_KEY      its full-access secret key (never logged)
// BAIL_TOKEN       default Circle's test USDC

import { BailView, TESTNET } from "@bail/sdk";

import { NearChain, Sender } from "./chain.ts";
import { Keeper } from "./keeper.ts";
import { Sponsor } from "./onboarding.ts";
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

const sponsor = env.SPONSOR_ACCOUNT
  ? new Sponsor(
      new Sender({ accountId: env.SPONSOR_ACCOUNT, rpcUrl, keys: [required("SPONSOR_KEY")] }),
      env.BAIL_TOKEN ?? TESTNET.token,
      view,
    )
  : undefined;

relayerServer({ chain, view, contractId, sponsor, allowOrigin: env.ALLOW_ORIGIN }).listen(port, () => {
  const faucet = sponsor ? `, faucet from ${sponsor.sender.accountId}` : "";
  console.log(`relayer for ${contractId} as ${chain.accountId} with ${chain.keyCount} keys${faucet} on :${port}`);
});
if (env.KEEPER !== "off") new Keeper({ chain, view }).start();
