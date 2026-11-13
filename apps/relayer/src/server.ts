import { createServer, type IncomingMessage, type Server } from "node:http";

import { type BailView, codeCommitment, fromBase64, revealArgs } from "@bail/sdk";

import type { Chain } from "./chain.ts";
import { BadRequest, checkAction, type Checked } from "./checks.ts";
import { RateLimit } from "./limits.ts";
import { type Sponsor, checkDelegate, checkFaucet } from "./onboarding.ts";

const MAX_BODY = 4096;
const ACTION_TGAS = 30;

export interface ServerOptions {
  chain: Chain;
  view: BailView;
  contractId: string;
  allowOrigin?: string;
  perIp?: RateLimit;
  perTicket?: RateLimit;
  /** Testnet only: funds new accounts and sponsors RSVP transfers. */
  sponsor?: Sponsor;
  faucetPerIp?: RateLimit;
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
  const faucetPerIp = options.faucetPerIp ?? new RateLimit(5, 3_600_000);
  const funded = new Set<string>();

  async function faucet(body: unknown, ip: string): Promise<{ status: number; body: object }> {
    const sponsor = options.sponsor;
    if (!sponsor) throw new HttpError(404, "this relayer has no faucet");
    const b = (body ?? {}) as Record<string, unknown>;
    const eventId = typeof b.event_id === "number" ? b.event_id : -1;
    const event = eventId >= 0 ? await options.view.event(eventId) : null;
    const { accountId, amount } = checkFaucet(body, event, sponsor.token, await options.view.now());
    if (funded.has(`${eventId}/${accountId}`)) throw new HttpError(429, "this account was already funded for this event");
    if (!faucetPerIp.allow(ip)) throw new HttpError(429, "too many faucet requests from this address");
    funded.add(`${eventId}/${accountId}`);
    let outcome;
    try {
      outcome = await sponsor.fund(accountId, amount);
    } catch (error) {
      // Nothing was confirmed sent, so the attendee must be able to ask again.
      funded.delete(`${eventId}/${accountId}`);
      throw error;
    }
    log(`faucet event=${eventId} account=${accountId} ok=${outcome.ok} tx=${outcome.tx}`);
    if (!outcome.ok) {
      funded.delete(`${eventId}/${accountId}`);
      return { status: 422, body: { error: outcome.error, tx: outcome.tx } };
    }
    return { status: 200, body: { tx: outcome.tx } };
  }

  async function meta(body: unknown): Promise<{ status: number; body: object }> {
    const sponsor = options.sponsor;
    if (!sponsor) throw new HttpError(404, "this relayer sponsors no transfers");
    const b = (body ?? {}) as Record<string, unknown>;
    const eventId = typeof b.event_id === "number" ? b.event_id : -1;
    const { view } = options;
    const [event, nowMs, finalHeight] = await Promise.all([
      eventId >= 0 ? view.event(eventId) : null,
      view.now(),
      view.finalHeight(),
    ]);
    const checked = checkDelegate(b.signed_delegate, { contractId: options.contractId, eventId, event, nowMs, finalHeight });
    const outcome = await sponsor.relay(checked.decoded, checked.senderId);
    const seated = outcome.ok && (await view.ticket(eventId, checked.ticketKey)) !== null;
    log(`meta event=${eventId} sender=${checked.senderId} ok=${outcome.ok} seated=${seated} tx=${outcome.tx}`);
    if (!outcome.ok) return { status: 422, body: { error: outcome.error, tx: outcome.tx } };
    return { status: 200, body: { tx: outcome.tx, seated } };
  }

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

  // Reveals are permissionless, so the host's browser can hand a code here instead of asking
  // its wallet again. The code must match the slot's commitment before any gas is spent.
  async function reveal(body: unknown): Promise<{ status: number; body: object }> {
    const { view, chain, contractId } = options;
    const b = (body ?? {}) as Record<string, unknown>;
    const eventId = b.event_id;
    const slot = b.slot;
    if (typeof eventId !== "number" || !Number.isSafeInteger(eventId) || eventId < 0) throw new BadRequest("event_id must be a whole number");
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot > 255) throw new BadRequest("slot must be 0 to 255");
    if (typeof b.code !== "string") throw new BadRequest("code must be text");
    let args: ReturnType<typeof revealArgs>;
    try {
      args = revealArgs(eventId, slot, b.code);
    } catch {
      throw new BadRequest("a code is 1 to 64 bytes of words");
    }
    const event = await view.event(eventId);
    if (!event) throw new HttpError(404, "no such event");
    const opened = event.slots[slot];
    if (!opened) throw new HttpError(422, "that code has not been opened");
    if (opened.revealed !== null) throw new HttpError(409, "that code is already revealed");
    const committed = fromBase64(opened.commitment);
    const offered = codeCommitment(contractId, eventId, slot, args.code);
    if (committed.length !== offered.length || committed.some((byte, i) => byte !== offered[i])) {
      throw new BadRequest("that is not the code committed for this slot");
    }
    const now = await view.now();
    if (now < opened.opened_at_ms + event.checkin.window_ms) throw new HttpError(422, "the code's window is still open");
    if (now >= event.schedule.reveal_deadline_ms) throw new HttpError(422, "the reveal deadline has passed");
    const outcome = await chain.call("reveal", args, ACTION_TGAS);
    log(`reveal event=${eventId} slot=${slot} ok=${outcome.ok} tx=${outcome.tx}`);
    if (!outcome.ok) return { status: 422, body: { error: outcome.error, tx: outcome.tx } };
    return { status: 200, body: { tx: outcome.tx } };
  }

  async function handle(req: IncomingMessage): Promise<{ status: number; body: object }> {
    const url = new URL(req.url ?? "/", "http://relayer");
    if (req.method === "GET" && url.pathname === "/v1/health") {
      return {
        status: 200,
        body: { ok: true, contract: options.contractId, account: options.chain.accountId, faucet: !!options.sponsor },
      };
    }
    const route = url.pathname.match(/^\/v1\/([a-z]+)$/);
    if (req.method !== "POST" || !route) throw new HttpError(404, "not found");
    const ip = clientIp(req);
    if (!perIp.allow(ip)) throw new HttpError(429, "too many requests from this address");
    if (route[1] === "faucet") return faucet(await readJson(req), ip);
    if (route[1] === "meta") return meta(await readJson(req));
    if (route[1] === "reveal") return reveal(await readJson(req));
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
