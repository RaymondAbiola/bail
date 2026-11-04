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
    const response = await fetch(`${this.baseUrl}/v1/${action.kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action.args),
    });
    const body = (await response.json().catch(() => ({}))) as { tx?: string; error?: string };
    if (!response.ok) throw new Error(body.error ?? `relayer answered ${response.status}`);
    if (typeof body.tx !== "string") throw new Error("the relayer returned no transaction");
    return { tx: body.tx };
  }
}
