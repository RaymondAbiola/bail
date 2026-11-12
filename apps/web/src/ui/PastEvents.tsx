import { useApp } from "../context.tsx";
import { usePoll } from "../hooks.ts";
import { formatUsdc } from "../lib/money.ts";
import { PAST_EVENTS, pastEventOutcome, readPastEvents } from "../lib/past-events.ts";
import { Icon } from "./Icon.tsx";

export function PastEvents() {
  const { view, config } = useApp();
  const reads = usePoll(() => readPastEvents(view), 60_000, [view]);
  const outcomes = reads.data?.map(({ event }) => pastEventOutcome(event));
  const complete = outcomes?.every((outcome) => outcome !== null);
  const attended = outcomes?.reduce((sum, outcome) => sum + (outcome?.attended ?? 0), 0) ?? 0;
  const forfeited = outcomes?.reduce((sum, outcome) => sum + (outcome?.forfeited ?? 0), 0) ?? 0;

  return (
    <section className="past-events content-width" aria-labelledby="past-events-title">
      <div className="section-heading">
        <p className="eyebrow">Run with real people / Testnet</p>
        <h2 id="past-events-title">Real calls. Real commitments.</h2>
        <p className="past-events-summary" role="status">{complete ? `${attended} tickets qualified by codes; ${forfeited} forfeited across these two testnet events.` : reads.loading ? "Reading the event results from the chain..." : "Run twice with real people on testnet. View the public record for each event."}</p>
      </div>
      <ul className="past-events-list">
        {PAST_EVENTS.map((meta, index) => {
          const result = reads.data?.[index];
          const outcome = outcomes?.[index];
          const title = config.events[String(meta.id)]?.title ?? meta.title;
          return (
            <li key={meta.id}>
              <a className="past-event-link" href={`#/event/${meta.id}/organizer`}>
                <div className="past-event-heading"><div><span className="eyebrow">Event #{meta.id} / Testnet</span><h3>{title}</h3><time dateTime={meta.date}>{meta.dateLabel}</time></div><Icon name="arrow" /></div>
                {outcome ? (
                  <>
                    <dl className="past-event-stats">
                      <div><dt>Seats</dt><dd>{outcome.seats}</dd></div>
                      <div><dt>Attended</dt><dd>{outcome.attended}</dd></div>
                      <div><dt>Forfeited</dt><dd>{outcome.forfeited}</dd></div>
                      <div><dt>Due per attendee</dt><dd>{outcome.duePerAttendee === null ? "No code-qualified attendees" : formatUsdc(outcome.duePerAttendee)}</dd></div>
                    </dl>
                    {(outcome.vouched > 0 || outcome.refunded > 0) && <p className="small muted">{outcome.vouched} vouched · {outcome.refunded} refunded</p>}
                  </>
                ) : <p className="past-event-status">{!reads.data ? "Loading results..." : result?.failed ? "Results could not be read. Open the public record to try again." : result?.event ? "The tally is not settled yet." : "This event is not available on the configured contract."}</p>}
                <span className="past-event-record">View public event record ↗</span>
              </a>
            </li>
          );
        })}
      </ul>
      <div className="past-events-note"><p>Amounts shown are due to attendees. Individual transfers may still be pending. Test tokens have no monetary value.</p>{reads.data?.some(({ failed }) => failed) && <button type="button" className="btn quiet" onClick={() => void reads.refresh()}>Retry results</button>}</div>
    </section>
  );
}
