import { useMemo } from "react";

import { type Event, Ticket, type TicketRecord, phase as phaseOf } from "@bail/sdk";

import { useApp } from "../context.tsx";
import { type EventState, usePoll, useStoredTicket } from "../hooks.ts";
import { formatUsdc } from "../lib/money.ts";
import { canCancel } from "../lib/rules.ts";
import type { CachedResult } from "../lib/storage.ts";
import { catchStatus, liveSlot, requirement } from "../lib/slots.ts";
import { requiredCodes, STAY_UNTIL_END } from "../lib/checkin-copy.ts";
import { KeyBackup } from "./KeyBackup.tsx";
import { LiveCode } from "./LiveCode.tsx";
import { Progress } from "./Progress.tsx";
import { Results } from "./Results.tsx";
import { AskForVouch, VouchPanel } from "./Vouch.tsx";
import { Notice, formatCountdown, formatWait, formatWhen, useAction } from "./common.tsx";

export interface TicketPanelProps {
  eventId: number;
  event: Event;
  state: EventState;
  loading: boolean;
  now: number;
  refresh: () => Promise<void>;
}

/** What this person sees for their own ticket: the next step, derived from the chain, not from a menu. */
export function TicketPanel({ eventId, event, state, loading, now, refresh }: TicketPanelProps) {
  const { config } = useApp();
  const { stored, update } = useStoredTicket(eventId);
  const ticket = useMemo(() => (stored ? Ticket.restore(stored.backup) : null), [stored?.backup]);
  if (!stored || !ticket) return null;

  const chain = state.ticket;
  const phase = phaseOf(event, now);
  const saveSubmission = (slot: number, attempt: number, code: string) =>
    update((t) => ({ ...t, submissions: { ...t.submissions, [slot]: { attempt, code, at: Date.now() } } }));
  const remember = (result: CachedResult) => update((t) => ({ ...t, result }));

  // No record on the chain for this ticket.
  if (!chain) {
    if (loading) return <section className="card"><p role="status">Checking your ticket...</p></section>;
    if (stored.cancelled) return <Cancelled eventId={eventId} payoutTo={stored.payoutTo} />;
    if (stored.stage !== "seated") {
      return (
        <section className="card">
          <h2>Your RSVP is not finished</h2>
          <p>This browser has a ticket key for this event, but no seat on the chain yet.</p>
          <a className="btn primary" href={`#/event/${eventId}/rsvp`}>Continue my RSVP</a>
        </section>
      );
    }
    return <Results event={event} chain={null} payout={null} stored={stored} remember={remember} />;
  }

  const slot = liveSlot(event, now);
  const refunded = event.status !== "Active";
  const live = !refunded && phase === "CheckIn" && slot !== null;
  const notConfirmed = event.slots.some((_, slot) => catchStatus(event, slot, chain, config.contractId, eventId, ticket.publicKey) === "not-confirmed");

  return (
    <div className="column ticket-column">
      {live ? (
        <>
          <LiveCode
            key={`${eventId}:${slot}`}
            eventId={eventId} event={event} slot={slot!} now={now} ticket={ticket} chain={chain} stored={stored}
            saveSubmission={saveSubmission} onChanged={() => void refresh()}
          />
          <p className="small muted" data-testid="ticket-line">
            Your ticket: seat {chain.index + 1} of {event.capacity}, {formatUsdc(event.deposit)} deposit.
          </p>
        </>
      ) : (
        <section className="ticket" aria-labelledby="ticket-title">
          <span className="eyebrow">Your ticket · Event #{eventId}</span>
          <h2 id="ticket-title" className="big-number">{phase === "Open" || phase === "CheckIn" ? "You're in" : "Your ticket"}</h2>
          <hr className="perforation" />
          <dl className="facts">
            <div><dt>{phase === "Open" || phase === "CheckIn" ? "Deposit held" : "Deposit"}</dt><dd>{formatUsdc(event.deposit)}</dd></div>
            <div><dt>Seat</dt><dd>{chain.index + 1} of {event.capacity}</dd></div>
            <div className="wide"><dt>Payout goes to</dt><dd>{chain.payout_to}</dd></div>
          </dl>
        </section>
      )}

      {refunded && (
        <Notice tone="info" title={event.status === "Voided" ? "Voided by the arbiter" : "Cancelled"}>
          Every deposit is refunded. {event.status === "Voided" ? "The arbiter voided this event." : "The organizer cancelled this event."}
        </Notice>
      )}

      {!refunded && phase === "Open" && (
        <section className="card">
          <h3>Check-in opens {formatWhen(event.schedule.checkin_opens_at_ms)}</h3>
          <p className="big-number" aria-live="off">{formatCountdown(event.schedule.checkin_opens_at_ms - now)}</p>
          <p className="muted small">That is {formatWait(event.schedule.checkin_opens_at_ms - now)} from now.</p>
          <p>
            <strong>Keep this page open during the call.</strong> The host will share codes at unexpected times. You need {requiredCodes(event.checkin.required, event.checkin.slots)}.
            {event.checkin.required === event.checkin.slots && <> {STAY_UNTIL_END}</>}
          </p>
          <p className="small muted">RSVPs close {formatWhen(event.schedule.rsvp_closes_at_ms)}{event.schedule.rsvp_closes_at_ms === event.schedule.checkin_opens_at_ms ? ", when the call starts" : ""}.</p>
          <CancelAction eventId={eventId} event={event} ticket={ticket} chain={chain} now={now} onCancelled={(tx) => { update((t) => ({ ...t, cancelled: { tx, at: Date.now() } })); void refresh(); }} />
        </section>
      )}

      {!refunded && phase === "CheckIn" && slot === null && (
        <section className="card">
          <h3>Waiting for the next code</h3>
          <p>
            {event.slots.length === 0
              ? "No code has been shared yet. The first one can appear at any moment."
              : "Stay on the call. The next code can appear at any moment."}{" "}
            Keep this page open.
            {event.checkin.required === event.checkin.slots && <> {STAY_UNTIL_END}</>}
          </p>
        </section>
      )}

      {!refunded && (phase === "CheckIn" || phase === "Reveal" || phase === "Dispute") && (
        <details className="disclosure" open={!live || notConfirmed}>
          <summary>Your codes: details and flags</summary>
          <div>
          <Progress
            eventId={eventId} event={event} now={now} contractId={config.contractId}
            ticketKey={ticket.publicKey} chain={chain} ticketObj={ticket} submissions={stored.submissions} onChanged={() => void refresh()}
          />
          {phase === "Reveal" && <p className="small muted">Codes are confirmed once the host reveals them. Confirmation can arrive any time up to {formatWhen(event.schedule.reveal_deadline_ms)}.</p>}
          </div>
        </details>
      )}

      {!refunded && (phase === "Reveal" || phase === "Dispute") && <Standing eventId={eventId} event={event} state={state} now={now} />}
      {!refunded && (phase === "Dispute") && (
        <>
          <VouchPanel eventId={eventId} event={event} now={now} ticket={ticket} chain={chain} standing={state.standing} onChanged={() => void refresh()} />
          <AskForVouch event={event} now={now} ticket={ticket} standing={state.standing} />
        </>
      )}

      {(refunded || phase === "Tally" || phase === "Settled" || phase === "Closed") && (
        <Results event={event} chain={chain} payout={state.payout} stored={stored} remember={remember} />
      )}

      <details className="disclosure">
        <summary>Back up my ticket key again</summary>
        <div>
          <p className="small muted">Anyone with this key can act as your ticket. It never leaves this device.</p>
          <KeyBackup backup={stored.backup} eventId={eventId} />
        </div>
      </details>
    </div>
  );
}

/** Where the person stands once check-in is over: the chain's own numbers once they are final. */
function Standing({ eventId, event, state, now }: { eventId: number; event: Event; state: EventState; now: number }) {
  const s = state.standing;
  const need = requirement(event, now);
  if (!s) return null;
  return (
    <section className="card" aria-labelledby="standing-title">
      <h3 id="standing-title">Where you stand</h3>
      {!s.is_final ? (
        <Notice tone="wait" title="Not final yet">
          Codes can still be revealed until {formatWhen(event.schedule.reveal_deadline_ms)}. So far {s.verified_catches} confirmed; you need {s.catches_needed}.
        </Notice>
      ) : s.attended ? (
        <Notice tone="good" title="You qualified">
          {s.verified_catches} confirmed, and {s.catches_needed} were needed{s.void_slots > 0 ? ` (${s.void_slots} void ${s.void_slots === 1 ? "code lowers" : "codes lower"} the bar)` : ""}.
        </Notice>
      ) : s.vouches >= 2 ? (
        <Notice tone="good" title="Vouched for">You did not reach the codes, but two attendees vouched for you. You get your deposit back, without the bonus.</Notice>
      ) : (
        <Notice tone="bad" title="Not enough confirmed codes">
          {s.verified_catches} confirmed, {s.catches_needed} needed. {s.vouches} of 2 vouches so far.
        </Notice>
      )}
      <p className="small muted">Event #{eventId}: {requiredCodes(need.required, need.slots)} required.</p>
    </section>
  );
}

function CancelAction({ eventId, event, ticket, chain, now, onCancelled }: {
  eventId: number; event: Event; ticket: Ticket; chain: TicketRecord; now: number; onCancelled: (tx: string) => void;
}) {
  const { relayer, config } = useApp();
  const cancel = useAction(async () => {
    const { tx } = await relayer.submit(ticket.cancel(config.contractId, eventId));
    onCancelled(tx);
  });
  if (!canCancel(event, chain, now)) return null;
  return (
    <details className="disclosure">
      <summary>Cancel my RSVP</summary>
      <div>
        <p>
          You can cancel until {formatWhen(event.schedule.cancel_cutoff_ms)} for a full refund of {formatUsdc(event.deposit)} to {chain.payout_to}. Your seat is freed.
        </p>
        {cancel.error && <Notice tone="bad">{cancel.error.message}</Notice>}
        <button type="button" className="btn danger" disabled={cancel.pending} onClick={() => void cancel.run()}>
          {cancel.pending ? "Cancelling..." : "Cancel my RSVP and refund me"}
        </button>
      </div>
    </details>
  );
}

function Cancelled({ eventId, payoutTo }: { eventId: number; payoutTo: string }) {
  const { view } = useApp();
  const owed = usePoll(() => view.owed(eventId, payoutTo), 10_000, [view, eventId, payoutTo]);
  return (
    <section className="card">
      <h2>RSVP cancelled</h2>
      {owed.data === null ? (
        <p role="status">Checking your refund...</p>
      ) : owed.data === "0" ? (
        <Notice tone="good" title="Refund sent">Your deposit was refunded to {payoutTo}.</Notice>
      ) : (
        <Notice tone="wait" title="Refund pending">
          {formatUsdc(owed.data)} is owed to {payoutTo}. The relayer normally claims it for you within moments. Owed is not the same as received.
        </Notice>
      )}
    </section>
  );
}
