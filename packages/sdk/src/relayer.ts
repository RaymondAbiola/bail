import type { SignedAction } from "./ticket.ts";

/**
 * Hands signed actions to a relayer, which pays the gas. A relayer can delay an action
 * but can't change one: the contract checks the ticket's signature itself.
 */
export class RelayerClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async submit(action: SignedAction): Promise<{ tx: string }> {
    return this.#post(action.kind, action.args);
  }

  /** Testnet only: creates the ticket's implicit account and sends it the event's deposit in test USDC. */
  async faucet(accountId: string, eventId: number): Promise<{ tx: string }> {
    return this.#post("faucet", { account_id: accountId, event_id: eventId });
  }

  /** Testnet only: sponsors the gas for a signed RSVP transfer. */
  async meta(eventId: number, signedDelegate: string): Promise<{ tx: string; seated: boolean }> {
    return this.#post("meta", { event_id: eventId, signed_delegate: signedDelegate });
  }

  async #post<T extends { tx: string }>(path: string, payload: object): Promise<T> {
    const response = await fetch(`${this.baseUrl}/v1/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as Partial<T> & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `relayer answered ${response.status}`);
    if (typeof body.tx !== "string") throw new Error("the relayer returned no transaction");
    return body as T;
  }
}
