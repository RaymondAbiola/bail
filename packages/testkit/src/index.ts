// A private NEAR node for integration tests, with the compiled Bail contract and a test
// token deployed. Needs the near-sandbox binary (NEAR_SANDBOX_BIN) and the wasm files from
// `cargo near build non-reproducible-wasm` for contracts/bail and contracts/test-token.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BailView } from "@bail/sdk";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, nearToYocto, teraToGas } from "near-api-js";
import type { KeyPairString } from "near-api-js";

const root = new URL("../../../", import.meta.url).pathname;
export const BAIL_WASM = join(root, "target/near/bail/bail.wasm");
export const TOKEN_WASM = join(root, "target/near/test_token/test_token.wasm");
export const MINUTE = 60_000;
export const USDC = 1_000_000n;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export interface FunctionCallKeys {
  keys: KeyPair[];
  receiverId: string;
  methods: string[];
  allowance: `${number}`;
}

export class Sandbox {
  readonly rpcUrl: string;
  readonly provider: JsonRpcProvider;
  readonly root: Account;
  readonly #stop: () => void;

  constructor(rpcUrl: string, root: Account, stop: () => void) {
    this.rpcUrl = rpcUrl;
    this.provider = root.provider as JsonRpcProvider;
    this.root = root;
    this.#stop = stop;
  }

  id(name: string): string {
    return `${name}.${this.root.accountId}`;
  }

  async newAccount(
    name: string,
    near: `${number}`,
    options: { key?: KeyPair; functionCallKeys?: FunctionCallKeys } = {},
  ): Promise<Account> {
    const key = options.key ?? KeyPair.fromRandom("ed25519");
    const fc = options.functionCallKeys;
    await this.root.signAndSendTransaction({
      receiverId: this.id(name),
      actions: [
        actions.createAccount(),
        actions.transfer(nearToYocto(near)),
        actions.addFullAccessKey(key.getPublicKey()),
        ...(fc?.keys ?? []).map((k) =>
          actions.addFunctionCallAccessKey(k.getPublicKey(), fc!.receiverId, fc!.methods, nearToYocto(fc!.allowance)),
        ),
      ],
    });
    return new Account(this.id(name), this.provider, new KeyPairSigner(key));
  }

  call(from: Account, contractId: string, methodName: string, args: object, deposit = 0n, tgas = 100): Promise<unknown> {
    return from.callFunction({ contractId, methodName, args, deposit, gas: teraToGas(tgas) });
  }

  async rpc<T>(method: string, params: object): Promise<T> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return ((await response.json()) as { result: T }).result;
  }

  async #height(finality: string): Promise<number> {
    return (await this.rpc<{ header: { height: number } }>("block", { finality })).header.height;
  }

  /**
   * Moves block time to at least `ms`. Fast-forwarding jumps the optimistic head ahead of
   * the final one, and transactions are anchored to a final block, so this also waits for
   * finality to catch up.
   */
  async advanceTo(view: BailView, ms: number): Promise<void> {
    while ((await view.now()) < ms) {
      await this.rpc("sandbox_fast_forward", { delta_height: 20 });
      await new Promise((r) => setTimeout(r, 300));
    }
    while ((await this.#height("optimistic")) - (await this.#height("final")) > 5) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async balance(tokenId: string, accountId: string): Promise<bigint> {
    return BigInt(
      (await this.provider.callFunction({ contractId: tokenId, method: "ft_balance_of", args: { account_id: accountId } })) as string,
    );
  }

  /** Deploys and initializes Bail with one-minute windows and one-second reveal and dispute minimums. */
  async deployBail(name = "bail"): Promise<Account> {
    const bail = await this.newAccount(name, "10");
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
    return bail;
  }

  /** Deploys the test token with its whole supply held by the token account itself. */
  async deployToken(name = "usdc", supply = 1_000n * USDC): Promise<Account> {
    const token = await this.newAccount(name, "10");
    await token.signAndSendTransaction({
      receiverId: token.accountId,
      actions: [
        actions.deployContract(readFileSync(TOKEN_WASM)),
        actions.functionCall("new", { owner_id: token.accountId, total_supply: String(supply) }, teraToGas(30)),
      ],
    });
    return token;
  }

  /** Registers each holder with the token and sends it `amount`. */
  async fund(token: Account, holders: (Account | string)[], amount: bigint): Promise<void> {
    for (const holder of holders) {
      const id = typeof holder === "string" ? holder : holder.accountId;
      await this.call(token, token.accountId, "storage_deposit", { account_id: id }, nearToYocto("0.00125"));
      if (amount > 0n) await this.call(token, token.accountId, "ft_transfer", { receiver_id: id, amount: String(amount) }, 1n);
    }
  }

  stop(): void {
    this.#stop();
  }
}

export async function startSandbox(bin: string): Promise<Sandbox> {
  const home = mkdtempSync(join(tmpdir(), "bail-sandbox-"));
  execFileSync(bin, ["--home", home, "init"], { stdio: "ignore" });
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  const rpcPort = await freePort();
  config.rpc.addr = `127.0.0.1:${rpcPort}`;
  config.network.addr = `127.0.0.1:${await freePort()}`;
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const node = spawn(bin, ["--home", home, "run"], { stdio: "ignore" });
  const stop = () => {
    node.kill();
    rmSync(home, { recursive: true, force: true });
  };
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  for (let i = 0; ; i++) {
    const up = await fetch(`${rpcUrl}/status`).then((r) => r.ok, () => false);
    if (up) break;
    if (i > 120) {
      stop();
      throw new Error("the sandbox node did not start");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const validator = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8"));
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return new Sandbox(rpcUrl, new Account(validator.account_id, provider, validator.secret_key as KeyPairString), stop);
}
