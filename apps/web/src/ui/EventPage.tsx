import { type Event, phase as phaseOf } from "@bail/sdk";

import { useApp } from "../context.tsx";
import { useChainNow, useEventState, usePoll, useStoredTicket } from "../hooks.ts";
import { formatUsdc } from "../lib/money.ts";
import { describePhase, rsvpBlock } from "../lib/rules.ts";
import { liveSlot } from "../lib/slots.ts";
import { OtherChain } from "./OtherChain.tsx";
import { Organizer } from "./Organizer.tsx";
import { RestoreForm } from "./Restore.tsx";
import { BLOCK_COPY, RsvpFlow } from "./Rsvp.tsx";
import { TicketPanel } from "./TicketPanel.tsx";
import { ContractLink, Notice, Skeleton, formatClock, formatWhen } from "./common.tsx";
import { Icon } from "./Icon.tsx";
import { slotStatus } from "../lib/slots.ts";

export function EventPage({ id, view: sub }: { id: number; view: "main" | "rsvp" | "restore" | "organizer" }) {
  const { config } = useApp();
  const { stored } = useStoredTicket(id);
  const state = useEventState(id, stored?.publicKey ?? null);
  const { now, stale } = useChainNow();
  const event = state.data?.event ?? null;

  if (state.loading && !state.data) {
    return (
      <div className="page two" aria-busy="true">
        <div className="column"><Skeleton block label="Loading the event" /><Skeleton block label="Loading your ticket" /></div>
        <div className="column"><Skeleton block label="Loading how it works" /></div>
      </div>
    );
  }
  if (!state.data) {
    return (
      <div className="page">
        <Notice tone="bad" title="Could not read the event">
          {state.error ?? "The chain did not answer."} Check your connection, then try again.
        </Notice>
        <button type="button" className="btn primary" onClick={() => void state.refresh()}>Try again</button>
      </div>
    );
  }
  if (!event) {
    return (
      <div className="page">
        <section className="card">
          <h1>Event #{id} not found</h1>
          <p>There is no event with that number on this contract. Check the link you were given.</p>
          <a className="btn primary" href="#/">Enter another event number</a>
        </section>
      </div>
    );
  }

  if (sub === "organizer") return <Organizer id={id} />;

  const meta = config.events[String(id)] ?? {};
  const phase = phaseOf(event, now);
  const tone = describePhase(event, phase);
  const block = rsvpBlock(event, now);
  // While a code is live, the code is the whole screen: no heading pushing it down the page.
  const liveNow = sub === "main" && !!stored && !!state.data.ticket && event.status === "Active" && phase === "CheckIn" && liveSlot(event, now) !== null;

  return (
    <div className={`page event-page ${liveNow ? "is-live" : ""}`}>
      <header className="event-heading">
        <div><p className="eyebrow">Event #{id} <span aria-hidden="true">/</span> {liveNow ? "Live check-in" : "Your next commitment"}</p><h1>{meta.title ?? `Event #${id}`}</h1>{meta.description && <p className="event-description">{meta.description}</p>}</div>
        <div className="event-heading-meta"><span className={`badge ${tone.tone}`}>{tone.label}</span>{meta.callUrl && <a className="text-link" href={meta.callUrl} target="_blank" rel="noreferrer">Join the call ↗</a>}</div>
      </header>
      <div className="event-layout">
      <div className="column">
        {state.error && (
          <Notice tone="wait" title="Showing the last information we have">
            The latest refresh failed. {state.updatedAt ? `Last updated ${formatClock(state.updatedAt)}.` : ""} It will try again on its own.
          </Notice>
        )}
        {stale && <p className="hint" role="status">The time shown may be out of date. It refreshes by itself.</p>}

        {sub === "rsvp" ? (
          <RsvpFlow eventId={id} event={event} />
        ) : sub === "restore" ? (
          <RestoreForm eventId={id} />
        ) : stored ? (
          <TicketPanel eventId={id} event={event} state={state.data} loading={state.loading} now={now} refresh={state.refresh} />
        ) : (
          <>
            <Summary event={event} />
            {block === null ? (
              <div className="actions">
                <a className="btn primary block" href={`#/event/${id}/rsvp`}>RSVP with test USDC</a>
                <a className="btn quiet" href={`#/event/${id}/restore`}>Restore my ticket</a>
              </div>
            ) : (
              <div className="actions">
                <Notice tone="wait" title="Can't RSVP">{BLOCK_COPY[block]}</Notice>
                <a className="btn quiet" href={`#/event/${id}/restore`}>Restore my ticket</a>
              </div>
            )}
          </>
        )}
      </div>

      <aside className="column event-evidence" aria-label="Event rules and public evidence">
        <Evidence id={id} event={event} now={now} updatedAt={state.updatedAt} />
        <details className="disclosure rules-disclosure" open={!liveNow}><summary>How it works</summary><div><HowItWorks event={event} /></div></details>
        <PublicDetails id={id} event={event} />
        {sub === "main" && !stored && <OtherChain />}
        <p className="small"><a href={`#/event/${id}/organizer`}>Organizer view (read only) ↗</a></p>
      </aside>
      </div>
    </div>
  );
}

function Summary({ event }: { event: Event }) {
  const s = event.schedule;
  const left = Math.max(0, event.capacity - event.registered);
  return (
    <section className="ticket" aria-labelledby="summary-title">
      <div className="ticket-topline"><span>Your seat awaits</span><Icon name="ticket" /></div>
      <h2 id="summary-title" className="visually-hidden">Event summary</h2>
      <div>
        <div className="eyebrow">Refundable event deposit</div>
        <div className="big-number">{formatUsdc(event.deposit)}</div>
        <p className="small muted">Show up. Catch the codes. Get it back.</p>
      </div>
      <hr className="perforation" />
      <dl className="facts">
        <div className="wide"><dt>Check-in opens</dt><dd>{formatWhen(s.checkin_opens_at_ms)}</dd></div>
        <div>
          {event.closed ? (
            <>
              <dt>Final headcount</dt>
              <dd>{event.tally ? event.tally.attended + event.tally.vouched + event.tally.forfeited + event.tally.refunded : "Not recorded"}</dd>
            </>
          ) : (
            <>
              <dt>Seats left</dt>
              <dd>{left} of {event.capacity}</dd>
            </>
          )}
        </div>
        <div><dt>Codes</dt><dd>Catch {event.checkin.required} of {event.checkin.slots}</dd></div>
        <div className="wide"><dt>Free cancellation until</dt><dd>{formatWhen(s.cancel_cutoff_ms)}</dd></div>
      </dl>
    </section>
  );
}

function Evidence({ id, event, now, updatedAt }: { id: number; event: Event; now: number; updatedAt: number | null }) {
  return (
    <section className="evidence-panel" aria-labelledby="evidence-title">
      <p className="eyebrow">The public record</p>
      <h2 id="evidence-title">Your attendance.<br />Your proof.</h2>
      <dl className="evidence-ledger">
        <div><dt>Deposit</dt><dd>{formatUsdc(event.deposit)}</dd></div>
        <div><dt>Qualify by codes</dt><dd>Deposit back + share of forfeits</dd></div>
        <div><dt>Arbiter</dt><dd>{event.arbiter}</dd></div>
      </dl>
      <div className="activity-heading"><h3 className="eyebrow">Public activity</h3><span className="small muted">{event.closed ? "Event closed" : `${event.registered} / ${event.capacity} seats`}</span></div>
      <ol className="activity-list">
        {Array.from({ length: event.checkin.slots }, (_, slot) => {
          const status = slotStatus(event, slot, now);
          const copy = {
            waiting: ["Not opened yet", "The host opens codes during check-in."],
            live: ["Window is live", "Attendees can send this code now."],
            "awaiting-reveal": ["Awaiting reveal", "Submissions are not verified yet."],
            revealed: ["Revealed", "Catches can be checked against this code."],
            void: ["Void", "This slot lowers the requirement."],
          }[status];
          return <li key={slot} className={`activity-item ${status}`}><span className="activity-marker" aria-hidden="true">{status === "revealed" ? <Icon name="check" /> : status === "live" ? <span className="live-dot" /> : null}</span><div><strong>Code {slot + 1}: {copy[0]}</strong><p>{copy[1]}</p>{(event.slots[slot]?.flags ?? 0) > 0 && <p>{event.slots[slot]!.flags} no-code flags recorded</p>}</div></li>;
        })}
      </ol>
      <a className="text-link" href={`#/event/${id}/organizer`}>View public event details <span aria-hidden="true">↗</span></a>
      {updatedAt && <p className="evidence-updated">Read from chain at {formatClock(updatedAt)}</p>}
      <p className="evidence-promise">The host cannot mark you absent.</p>
    </section>
  );
}

function HowItWorks({ event }: { event: Event }) {
  const { view } = useApp();
  const config = usePoll(() => view.config(), 300_000, [view]);
  const fee = config.data?.fee_bps;
  return (
    <section className="event-rules" aria-label="How deposits and attendance work">
      <ol className="steps">
        <li><span className="mark done" aria-hidden="true">1</span><span>Put down the deposit of {formatUsdc(event.deposit)}.</span></li>
        <li><span className="mark done" aria-hidden="true">2</span><span>Join the call. The host shows {event.checkin.slots} live codes at unexpected times. Type each one in within {Math.round(event.checkin.window_ms / 60000)} minute{event.checkin.window_ms === 60000 ? "" : "s"}. You need {event.checkin.required}.</span></li>
        <li><span className="mark done" aria-hidden="true">3</span><span>If you catch enough, you get at least your deposit back, plus a share of what people forfeit.</span></li>
        <li><span className="mark done" aria-hidden="true">4</span><span>If you don't, you forfeit it. A ticket rescued by two vouches gets its deposit back, without the bonus.</span></li>
      </ol>
      <p>Cancel before the cutoff for a full refund. If the event is cancelled or voided, or nobody attends, everyone is refunded.</p>
      <p>
        The arbiter, <strong>{event.arbiter}</strong>, can void the event to refund everyone. It cannot choose who attended.
        {fee === undefined ? "" : fee === 0 ? " There is no fee." : ` A ${fee / 100}% fee comes out of forfeited deposits only, never out of a deposit that is returned.`}
      </p>
    </section>
  );
}

function PublicDetails({ id, event }: { id: number; event: Event }) {
  const { config } = useApp();
  const s = event.schedule;
  const revealed = event.slots.filter((slot) => slot.revealed !== null).length;
  const times: [string, number][] = [
    ["Cancel until", s.cancel_cutoff_ms],
    ["RSVPs close", s.rsvp_closes_at_ms],
    ["Check-in opens", s.checkin_opens_at_ms],
    ["Check-in closes", s.checkin_closes_at_ms],
    ["Reveal deadline", s.reveal_deadline_ms],
    ["Dispute ends", s.dispute_ends_at_ms],
  ];
  return (
    <details className="disclosure">
      <summary>Public event details</summary>
      <div>
        <dl className="facts">
          <div className="wide"><dt>Organizer</dt><dd>{event.organizer}</dd></div>
          <div className="wide"><dt>Arbiter</dt><dd>{event.arbiter}</dd></div>
          <div className="wide"><dt>Contract</dt><dd><ContractLink account={config.contractId} /></dd></div>
          <div className="wide"><dt>Token</dt><dd className="small">{event.token}</dd></div>
          <div><dt>Codes opened</dt><dd>{event.slots.length} of {event.checkin.slots}</dd></div>
          <div><dt>Codes revealed</dt><dd>{revealed}</dd></div>
        </dl>
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Fixed schedule for event {id}</caption>
            <tbody>
              {times.map(([label, at]) => (
                <tr key={label}><th scope="row">{label}</th><td>{formatWhen(at)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small">
          The host cannot mark an attendee absent. A code the host never opens or never reveals becomes void and lowers what everyone needs, so a host's failure never counts against you.
        </p>
        <p className="small muted">
          If a host hides codes from the public, attendees can flag the slot as evidence. That helps only because the arbiter acts on it. Flags do not refund anyone by themselves.
        </p>
      </div>
    </details>
  );
}
