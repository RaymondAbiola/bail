import { useEffect } from "react";

import type { Event, TicketRecord } from "@bail/sdk";

import { formatUnits, formatUsdc } from "../lib/money.ts";
import type { CachedResult, StoredTicket } from "../lib/storage.ts";
import { Notice, formatWhen } from "./common.tsx";

const OUTCOME_COPY: Record<string, { title: string; body: string; tone: "good" | "wait" | "bad" | "info" }> = {
  Attended: {
    title: "You attended",
    body: "You caught enough codes. You get your deposit back plus a share of the deposits people forfeited.",
    tone: "good",
  },
  Vouched: {
    title: "You were vouched for",
    body: "Two attendees vouched for you. You get your deposit back, without the bonus.",
    tone: "good",
  },
  Refunded: {
    title: "Your deposit is refunded",
    body: "This event was cancelled, voided, or nobody attended, so every deposit goes back to the person who paid it.",
    tone: "info",
  },
  Forfeited: {
    title: "You did not qualify",
    body: "You did not catch enough codes, so your deposit goes to the people who did.",
    tone: "bad",
  },
};

export interface ResultProps {
  event: Event;
  chain: TicketRecord | null;
  payout: string | null;
  stored: StoredTicket;
  remember: (result: CachedResult) => void;
}

/** The ticket's outcome and payout, and whether the money has actually been paid. */
export function Results({ event, chain, payout, stored, remember }: ResultProps) {
  const outcome = chain?.outcome ?? null;
  const settled = !!event.tally && event.tally.stage !== "Classifying";

  // Keep what was seen, so it can still be shown after the event closes and frees the ticket.
  useEffect(() => {
    if (chain && outcome && payout !== null) {
      const seen = stored.result;
      if (!seen || seen.outcome !== outcome || seen.payout !== payout || seen.paid !== chain.paid) {
        remember({ outcome, payout, paid: chain.paid, payoutTo: chain.payout_to, observedAt: Date.now() });
      }
    }
  }, [chain, outcome, payout, stored.result, remember]);

  if (!chain) return <ClosedResult event={event} stored={stored} />;

  const refundAll = event.status !== "Active";
  if (!outcome || !settled) {
    return (
      <section className="card" aria-labelledby="results-title">
        <h2 id="results-title">Settling payouts</h2>
        <p>
          {refundAll
            ? "Every deposit for this event is due back. Payment is pending until the payouts run."
            : "The tally is being worked out. Your result appears here as soon as it is fixed."}
        </p>
        <p className="muted small">Payouts normally run on their own. Timing is not guaranteed.</p>
      </section>
    );
  }

  const copy = OUTCOME_COPY[outcome] ?? { title: outcome, body: "", tone: "info" as const };
  const bonus = outcome === "Attended" && event.tally ? event.tally.bonus : null;
  return (
    <section className="card result-card" aria-labelledby="results-title">
      <span className="eyebrow">Your attendance receipt</span>
      <h2 id="results-title">Your result</h2>
      <Notice tone={copy.tone} title={copy.title}>{copy.body}</Notice>
      <dl className="facts">
        <div>
          <dt>Payout</dt>
          <dd className="result-amount">{payout === null ? "Working it out" : formatUsdc(payout)}</dd>
        </div>
        <div>
          <dt>Payment</dt>
          <dd>{chain.paid ? "Paid" : payout === "0" ? "Nothing to pay" : "Not paid yet"}</dd>
        </div>
        {bonus !== null && (
          <div>
            <dt>Deposit and bonus</dt>
            <dd>{formatUnits(event.deposit)} + {formatUnits(bonus)}</dd>
          </div>
        )}
        <div className="wide">
          <dt>Paid to</dt>
          <dd>{chain.payout_to}</dd>
        </div>
      </dl>
      {!chain.paid && payout !== "0" && (
        <p className="small muted">
          "Not paid yet" means the transfer has not completed. An amount owed is not the same as money received.
        </p>
      )}
      {event.tally && (
        <p className="small muted">
          Show-up: {event.tally.attended + event.tally.vouched} of{" "}
          {event.tally.attended + event.tally.vouched + event.tally.forfeited + event.tally.refunded} tickets.
          {event.tally.forfeited > 0 && ` Forfeited pool: ${formatUsdc(event.tally.pool)}.`}
        </p>
      )}
    </section>
  );
}

/** The ticket record is gone from the chain, as it is once an event closes. */
function ClosedResult({ event, stored }: { event: Event; stored: StoredTicket }) {
  const seen = stored.result;
  if (seen) {
    const copy = OUTCOME_COPY[seen.outcome];
    return (
      <section className="card" aria-labelledby="results-title">
        <h2 id="results-title">{copy?.title ?? "Your result"}</h2>
        <Notice tone="info" title="Saved in this browser">
          Last seen {formatWhen(seen.observedAt)}. This is this browser's record of what the chain showed then, not a current onchain record.
        </Notice>
        <dl className="facts">
          <div><dt>Payout</dt><dd>{seen.payout === null ? "Not seen" : formatUsdc(seen.payout)}</dd></div>
          <div><dt>Payment when seen</dt><dd>{seen.paid ? "Paid" : "Not paid yet"}</dd></div>
          <div className="wide"><dt>Paid to</dt><dd>{seen.payoutTo}</dd></div>
        </dl>
      </section>
    );
  }
  return (
    <section className="card" aria-labelledby="results-title">
      <h2 id="results-title">Ticket details are no longer available onchain</h2>
      <p>
        {event.closed
          ? "Closing an event frees each ticket's record, and this browser did not see your result before then."
          : "This ticket has no record in this event."}{" "}
        That does not mean you did not attend. The event's totals are still public: {event.tally?.attended ?? 0} attended,{" "}
        {event.tally?.forfeited ?? 0} forfeited.
      </p>
    </section>
  );
}

