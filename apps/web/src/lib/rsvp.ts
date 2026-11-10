import { type BailView, type Event, type RelayerClient, type Ticket, rsvpDelegate } from "@bail/sdk";

import { tokenBalance } from "./chain.ts";
import { describeError } from "./errors.ts";

export type RsvpStep = "checking" | "funding" | "waiting-for-funds" | "signing" | "submitting" | "confirming";

export type RsvpOutcome =
  | { kind: "seated"; tx?: string }
  /** The deposit reached Bail but no seat was made. It is owed back to the payout address. */
  | { kind: "not-seated"; tx: string; owed: string }
  /** Not known whether it landed. Nothing more should be sent until the chain is read again. */
  | { kind: "unknown" };

export interface RsvpDeps {
  view: BailView;
  relayer: Pick<RelayerClient, "faucet" | "meta">;
  contractId: string;
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RsvpError extends Error {
  /** Funding or signing failed before anything was sent to Bail, so retrying is safe. */
  readonly safeToRetry: boolean;
  constructor(message: string, safeToRetry: boolean) {
    super(message);
    this.safeToRetry = safeToRetry;
  }
}

/** Reads the chain a few times for this ticket, for when a reply was lost or came back unseated. */
export async function confirmSeat(
  deps: RsvpDeps,
  eventId: number,
  publicKey: string,
  tries = 4,
  gapMs = 1500,
): Promise<boolean> {
  const sleep = deps.sleep ?? pause;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      if (await deps.view.ticket(eventId, publicKey)) return true;
    } catch {
      // A read that fails is not evidence either way; try again.
    }
    if (attempt + 1 < tries) await sleep(gapMs);
  }
  return false;
}

async function waitFor<T>(sleep: (ms: number) => Promise<void>, tries: number, gapMs: number, read: () => Promise<T | null>): Promise<T | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const value = await read();
    if (value !== null) return value;
    if (attempt + 1 < tries) await sleep(gapMs);
  }
  return null;
}

/**
 * Funds the ticket's account, signs the deposit and has the relayer submit it. Every step
 * starts by reading the chain, so running it again after any failure or lost reply never
 * pays twice and never makes a second ticket.
 */
export async function runRsvp(
  deps: RsvpDeps,
  input: { eventId: number; event: Event; ticket: Ticket; payoutTo: string },
  onStep: (step: RsvpStep) => void = () => {},
): Promise<RsvpOutcome> {
  const { view, relayer, contractId } = deps;
  const sleep = deps.sleep ?? pause;
  const { eventId, event, ticket, payoutTo } = input;
  const deposit = BigInt(event.deposit);

  onStep("checking");
  if (await view.ticket(eventId, ticket.publicKey)) return { kind: "seated" };

  if ((await tokenBalance(view, event.token, ticket.accountId)) < deposit) {
    onStep("funding");
    try {
      await relayer.faucet(ticket.accountId, eventId);
    } catch (error) {
      // "Already funded" means an earlier try got through; the balance read below decides.
      if (!/already funded/i.test(describeError(error).message)) throw new RsvpError(describeError(error).message, true);
    }
    onStep("waiting-for-funds");
    const funded = await waitFor(sleep, 10, 2000, async () =>
      (await tokenBalance(view, event.token, ticket.accountId)) >= deposit ? true : null,
    );
    if (!funded) throw new RsvpError("Test USDC has not arrived yet. Nothing was spent. Try again in a moment.", true);
  }

  onStep("signing");
  const nonce = await waitFor(sleep, 6, 1500, () => view.accessKeyNonce(ticket.accountId, ticket.publicKey));
  if (nonce === null) throw new RsvpError("Your ticket account is not ready yet. Nothing was spent. Try again in a moment.", true);
  const signed = ticket.signDelegate(
    rsvpDelegate({
      publicKey: ticket.publicKey,
      token: event.token,
      contractId,
      deposit: event.deposit,
      note: ticket.rsvpNote(eventId, payoutTo),
      nonce: nonce + 1n,
      maxBlockHeight: (await view.finalHeight()) + 600n,
    }),
  );

  onStep("submitting");
  let tx: string | undefined;
  let seated = false;
  try {
    ({ tx, seated } = await relayer.meta(eventId, signed));
  } catch (error) {
    const described = describeError(error);
    // A reply that never came back says nothing about whether the deposit went through.
    if (described.kind !== "network") throw new RsvpError(described.message, true);
    onStep("confirming");
    return (await confirmSeat(deps, eventId, ticket.publicKey)) ? { kind: "seated" } : { kind: "unknown" };
  }

  onStep("confirming");
  if (await confirmSeat(deps, eventId, ticket.publicKey, seated ? 6 : 2)) return { kind: "seated", tx };
  if (seated) return { kind: "unknown" };
  return { kind: "not-seated", tx: tx!, owed: await view.owed(eventId, payoutTo).catch(() => "0") };
}
