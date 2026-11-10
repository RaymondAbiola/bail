import { toBase64, text } from "./codec.ts";
import type {
  Config,
  Event,
  Reliability,
  SourceMetadata,
  Standing,
  Tally,
  TicketRecord,
} from "./types.ts";

export const TESTNET = {
  contractId: "v1.dontbail.testnet",
  // rpc.testnet.near.org is deprecated and throttled on purpose, and test.rpc.fastnear.com
  // refuses most requests from one address. Each host throttles separately, so use them in turn.
  rpcUrl: "https://rpc.testnet.fastnear.com",
  fallbackUrls: ["https://archival-rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"],
  token: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  intents: false,
} as const;

/** Read-only calls to a Bail contract over NEAR RPC. */
export class BailView {
  readonly contractId: string;
  readonly rpcUrl: string;
  readonly fallbackUrls: readonly string[];

  constructor(options: { contractId: string; rpcUrl: string; fallbackUrls?: readonly string[] } = TESTNET) {
    this.contractId = options.contractId;
    this.rpcUrl = options.rpcUrl;
    this.fallbackUrls = options.fallbackUrls ?? [];
  }

  /**
   * One JSON-RPC request. Public endpoints stall and throttle, so a network failure, 429 or
   * 5xx moves on to the next endpoint at once, and waits (longer each round, up to what the
   * endpoint asks for, at most 5 seconds) only after every endpoint has been tried.
   */
  async #send(method: string, body: object, attempts = 6): Promise<Response> {
    const urls = [this.rpcUrl, ...this.fallbackUrls];
    for (let attempt = 1; ; attempt++) {
      const round = Math.floor((attempt - 1) / urls.length);
      let wait = attempt % urls.length === 0 ? Math.min(400 * 2 ** round, 5000) : 0;
      try {
        const response = await fetch(urls[(attempt - 1) % urls.length]!, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
        if (response.status !== 429 && response.status < 500) return response;
        if (attempt === attempts) throw new Error(`${method}: RPC answered ${response.status}`);
        const asked = Number(response.headers.get("retry-after"));
        if (asked > 0 && wait > 0) wait = Math.min(asked, 5) * 1000;
      } catch (error) {
        if (attempt === attempts) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  async call<T>(method: string, args: object = {}): Promise<T> {
    const response = await this.#send(method, {
      jsonrpc: "2.0",
      id: method,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: this.contractId,
        method_name: method,
        args_base64: toBase64(text(JSON.stringify(args))),
      },
    });
    if (!response.ok) throw new Error(`${method}: RPC answered ${response.status}`);
    const reply = (await response.json()) as {
      error?: unknown;
      result?: { error?: string; result: number[] };
    };
    const error = reply.error ?? reply.result?.error;
    if (error) throw new Error(`${method}: ${typeof error === "string" ? error : JSON.stringify(error)}`);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(reply.result!.result)));
  }

  config(): Promise<Config> {
    return this.call("get_config");
  }

  event(eventId: number): Promise<Event | null> {
    return this.call("get_event", { event_id: eventId });
  }

  ticket(eventId: number, ticketKey: string): Promise<TicketRecord | null> {
    return this.call("get_ticket", { event_id: eventId, ticket_key: ticketKey });
  }

  tickets(eventId: number, from = 0, limit = 100): Promise<[string, TicketRecord][]> {
    return this.call("get_tickets", { event_id: eventId, from, limit });
  }

  standing(eventId: number, ticketKey: string): Promise<Standing | null> {
    return this.call("standing", { event_id: eventId, ticket_key: ticketKey });
  }

  totals(eventId: number): Promise<Tally | null> {
    return this.call("event_totals", { event_id: eventId });
  }

  payout(eventId: number, ticketKey: string): Promise<string | null> {
    return this.call("get_payout", { event_id: eventId, ticket_key: ticketKey });
  }

  owed(eventId: number, payoutTo: string): Promise<string> {
    return this.call("get_owed", { event_id: eventId, payout_to: payoutTo });
  }

  reliability(payoutTo: string): Promise<Reliability> {
    return this.call("reliability", { payout_to: payoutTo });
  }

  /** The NEAR to attach to `create_event`, in yoctoNEAR. */
  storageCost(capacity: number): Promise<string> {
    return this.call("storage_cost", { capacity });
  }

  sourceMetadata(): Promise<SourceMetadata> {
    return this.call("contract_source_metadata");
  }

  async rpc<T>(method: string, params: object): Promise<T> {
    const response = await this.#send(method, { jsonrpc: "2.0", id: method, method, params });
    const reply = (await response.json()) as { result?: T; error?: unknown };
    if (reply.result === undefined) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
    return reply.result;
  }

  /** The latest block's time in milliseconds: the clock the contract's deadlines use. */
  async now(): Promise<number> {
    const block = await this.rpc<{ header: { timestamp_nanosec: string } }>("block", { finality: "optimistic" });
    return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
  }

  async finalHeight(): Promise<bigint> {
    const block = await this.rpc<{ header: { height: number } }>("block", { finality: "final" });
    return BigInt(block.header.height);
  }

  /** The nonce of an access key, or null if the account or key doesn't exist yet. */
  async accessKeyNonce(accountId: string, publicKey: string): Promise<bigint | null> {
    try {
      const key = await this.rpc<{ nonce: number }>("query", {
        request_type: "view_access_key",
        finality: "optimistic",
        account_id: accountId,
        public_key: publicKey,
      });
      return BigInt(key.nonce);
    } catch {
      return null;
    }
  }
}

export type Phase = "Open" | "CheckIn" | "Reveal" | "Dispute" | "Tally" | "Settled" | "Closed";

/** The lifecycle phase at `nowMs`. The contract derives it from the block time the same way. */
export function phase(event: Event, nowMs: number): Phase {
  if (event.closed) return "Closed";
  if (event.tally?.stage === "Done") return "Settled";
  if (event.tally || event.status !== "Active") return "Tally";
  const s = event.schedule;
  if (nowMs < s.checkin_opens_at_ms) return "Open";
  if (nowMs < s.checkin_closes_at_ms) return "CheckIn";
  if (nowMs < s.reveal_deadline_ms) return "Reveal";
  if (nowMs < s.dispute_ends_at_ms) return "Dispute";
  return "Tally";
}
