import { createServer, type IncomingMessage, type Server } from "node:http";

import type { BailView } from "@bail/sdk";

import type { Chain } from "./chain.ts";
import { BadRequest, checkAction, type Checked } from "./checks.ts";
import { RateLimit } from "./limits.ts";

const MAX_BODY = 4096;
const ACTION_TGAS = 30;

export interface ServerOptions {
  chain: Chain;
  view: BailView;
  contractId: string;
  allowOrigin?: string;
  perIp?: RateLimit;
  perTicket?: RateLimit;
  log?: (line: string) => void;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "the body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("the body is not JSON");
  }
}

function clientIp(req: IncomingMessage): string {
  // Behind a proxy, the first hop in X-Forwarded-For is the client.
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

export function relayerServer(options: ServerOptions): Server {
  const perIp = options.perIp ?? new RateLimit(60, 60_000);
  const perTicket = options.perTicket ?? new RateLimit(12, 60_000);
  const log = options.log ?? ((line) => console.log(line));

  async function submit(checked: Checked): Promise<{ status: number; body: object }> {
    const { view, chain } = options;
    const ticket = await view.ticket(checked.eventId, checked.signer);
    if (!ticket) throw new HttpError(404, "no such ticket for this event");
    const outcome = await chain.call(checked.method, checked.args, ACTION_TGAS);
    log(`${checked.kind} event=${checked.eventId} ok=${outcome.ok} tx=${outcome.tx}`);
    if (!outcome.ok) return { status: 422, body: { error: outcome.error, tx: outcome.tx } };
    if (checked.kind === "cancel") {
      // The refund is owed to the ticket's payout address; claim it right away.
      const refund = await chain.call("claim_owed", { event_id: checked.eventId, payout_to: ticket.payout_to }, ACTION_TGAS);
      log(`claim_owed event=${checked.eventId} ok=${refund.ok} tx=${refund.tx}`);
    }
    return { status: 200, body: { tx: outcome.tx } };
  }

  async function handle(req: IncomingMessage): Promise<{ status: number; body: object }> {
    const url = new URL(req.url ?? "/", "http://relayer");
    if (req.method === "GET" && url.pathname === "/v1/health") {
      return { status: 200, body: { ok: true, contract: options.contractId, account: options.chain.accountId } };
    }
    const route = url.pathname.match(/^\/v1\/([a-z]+)$/);
    if (req.method !== "POST" || !route) throw new HttpError(404, "not found");
    if (!perIp.allow(clientIp(req))) throw new HttpError(429, "too many requests from this address");
    const checked = checkAction(route[1]!, await readJson(req), options.contractId);
    if (!perTicket.allow(checked.signer)) throw new HttpError(429, "too many requests for this ticket");
    return submit(checked);
  }

  return createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", options.allowOrigin ?? "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    handle(req)
      .catch((error: unknown) => {
        if (error instanceof HttpError) return { status: error.status, body: { error: error.message } };
        if (error instanceof BadRequest) return { status: 400, body: { error: error.message } };
        log(`error ${error instanceof Error ? error.message : String(error)}`);
        return { status: 502, body: { error: "the relayer could not reach NEAR; try again" } };
      })
      .then(({ status, body }) => {
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      });
  });
}
