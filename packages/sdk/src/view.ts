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
  rpcUrl: "https://rpc.testnet.near.org",
  token: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  intents: false,
} as const;

/** Read-only calls to a Bail contract over NEAR RPC. */
export class BailView {
  readonly contractId: string;
  readonly rpcUrl: string;

  constructor(options: { contractId: string; rpcUrl: string } = TESTNET) {
    this.contractId = options.contractId;
    this.rpcUrl = options.rpcUrl;
  }

  async call<T>(method: string, args: object = {}): Promise<T> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
      }),
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

  /** The latest block's time in milliseconds: the clock the contract's deadlines use. */
  async now(): Promise<number> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "now", method: "block", params: { finality: "optimistic" } }),
    });
    const reply = (await response.json()) as { result?: { header: { timestamp_nanosec: string } } };
    if (!reply.result) throw new Error("block: no result");
    return Number(BigInt(reply.result.header.timestamp_nanosec) / 1_000_000n);
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
