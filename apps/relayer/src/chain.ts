import { sha256 } from "@noble/hashes/sha2.js";
import { ResilientProvider } from "@bail/sdk/provider";
import { Account, KeyPair, KeyPairSigner, actions, baseEncode, teraToGas } from "near-api-js";
import type { Action, KeyPairString } from "near-api-js";

/** Everything the relayer and keeper call. None of them takes attached NEAR. */
export const RELAYER_METHODS = [
  "catch", "flag_slot", "cancel_rsvp", "vouch", "reveal", "tally", "payout", "claim", "claim_owed", "close_event",
];

export interface CallOutcome {
  tx: string;
  ok: boolean;
  /** The method's return value, when it succeeded. */
  value?: unknown;
  /** The contract's panic message, when it failed. */
  error?: string;
}

export interface Chain {
  readonly accountId: string;
  call(method: string, args: object, tgas: number): Promise<CallOutcome>;
}

/** The first `ExecutionError` string anywhere in a failure, which is the contract's panic. */
export function failureMessage(failure: unknown): string {
  const found = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    for (const [k, v] of Object.entries(value)) {
      if (k === "ExecutionError" && typeof v === "string") return v.replace(/^Smart contract panicked: /, "");
      const inner = found(v);
      if (inner) return inner;
    }
    return undefined;
  };
  return found(failure) ?? JSON.stringify(failure);
}

class Lane {
  account: Account;
  readonly make: () => Account;
  queue: Promise<unknown> = Promise.resolve();
  pending = 0;

  constructor(make: () => Account) {
    this.make = make;
    this.account = make();
  }

  /** Runs `job` after every earlier job on this key, so nonces are used in order. */
  run<T>(job: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.queue.then(job);
    this.queue = result.catch(() => {
      // A failed send leaves the cached nonce unknown; start again from the chain's.
      this.account = this.make();
    });
    return result.finally(() => this.pending--);
  }
}

/**
 * Sends transactions from a pool of keys on one account. Each key's queue is held only
 * until its transaction is included, so keys never reuse or skip a nonce, and results
 * are read afterwards without holding the queue.
 */
export class Sender {
  readonly accountId: string;
  readonly provider: ResilientProvider;
  readonly #lanes: Lane[];

  constructor(options: { accountId: string; rpcUrl: string; fallbackUrls?: readonly string[]; keys: string[] }) {
    if (options.keys.length === 0) throw new Error(`${options.accountId} needs at least one key`);
    this.accountId = options.accountId;
    this.provider = new ResilientProvider([options.rpcUrl, ...(options.fallbackUrls ?? [])]);
    this.#lanes = options.keys.map((secret) => {
      const signer = new KeyPairSigner(KeyPair.fromString(secret as KeyPairString));
      return new Lane(() => new Account(options.accountId, this.provider, signer));
    });
  }

  get keyCount(): number {
    return this.#lanes.length;
  }

  async send(receiverId: string, txActions: Action[]): Promise<CallOutcome> {
    const lane = this.#lanes.reduce((best, lane) => (lane.pending < best.pending ? lane : best));
    const tx = await lane.run(async () => {
      const signed = await lane.account.createSignedTransaction({ receiverId, actions: txActions });
      const hash = baseEncode(sha256(signed.transaction.encode()));
      await this.provider.sendTransactionUntil(signed, "INCLUDED");
      return hash;
    });
    const outcome = await this.provider.viewTransactionStatus({
      txHash: tx,
      accountId: this.accountId,
      waitUntil: "EXECUTED_OPTIMISTIC",
    });
    const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
    if (status.Failure !== undefined) return { tx, ok: false, error: failureMessage(status.Failure) };
    const raw = status.SuccessValue ? Buffer.from(status.SuccessValue, "base64").toString() : "";
    return { tx, ok: true, value: raw ? JSON.parse(raw) : undefined };
  }
}

/** Bail calls from the relayer's function-call keys. */
export class NearChain implements Chain {
  readonly contractId: string;
  readonly #sender: Sender;

  constructor(options: { accountId: string; contractId: string; rpcUrl: string; fallbackUrls?: readonly string[]; keys: string[] }) {
    this.contractId = options.contractId;
    this.#sender = new Sender(options);
  }

  get accountId(): string {
    return this.#sender.accountId;
  }

  get keyCount(): number {
    return this.#sender.keyCount;
  }

  call(method: string, args: object, tgas: number): Promise<CallOutcome> {
    return this.#sender.send(this.contractId, [actions.functionCall(method, args, teraToGas(tgas), 0n)]);
  }
}
