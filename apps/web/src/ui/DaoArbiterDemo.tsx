import { useApp } from "../context.tsx";
import { usePoll } from "../hooks.ts";
import { formatUsdc } from "../lib/money.ts";
import { pastEventOutcome } from "../lib/past-events.ts";
import { ContractLink } from "./common.tsx";
import { Icon } from "./Icon.tsx";

const EVENT_ID = 6;

export function DaoArbiterDemo() {
  const { view, config } = useApp();
  const read = usePoll(() => view.event(EVENT_ID), 60_000, [view]);
  const event = read.data;
  const outcome = pastEventOutcome(event);
  const refunded = event?.status === "Voided" && outcome !== null;

  return (
    <section className="dao-demo content-width" aria-labelledby="dao-demo-title">
      <div className="dao-demo-copy section-heading">
        <p className="eyebrow">Arbiter demo / Testnet</p>
        <h2 id="dao-demo-title">A community DAO votes to void an event.</h2>
        <p>2 of 2 council votes approved the proposal. The DAO called Bail to void the event and return the deposits. The organizer is not on the council.</p>
        <p className="small muted">The attendees in this demo were scripted, not real people.</p>
        <a className="text-link" href="https://github.com/RaymondAbiola/bail/blob/main/docs/dao-arbiter-event.md" target="_blank" rel="noreferrer">Read the demo write-up ↗</a>
      </div>
      <div className="dao-demo-result">
        <div className="ticket-topline"><span>Event #{EVENT_ID} / Testnet</span><Icon name="shield" /></div>
        <h3>{config.events[String(EVENT_ID)]?.title ?? "Sputnik DAO arbiter demo"}</h3>
        {event ? (
          <>
            <dl className="dao-demo-stats">
              <div><dt>Status</dt><dd>{event.status}</dd></div>
              <div><dt>Seats</dt><dd>{outcome?.seats ?? "Tally pending"}</dd></div>
              <div><dt>Refunded</dt><dd>{outcome?.refunded ?? "Tally pending"}</dd></div>
              {refunded && <div><dt>Refunded per ticket</dt><dd>{formatUsdc(event.deposit)} each</dd></div>}
              <div className="dao-demo-arbiter"><dt>Arbiter</dt><dd><ContractLink account={event.arbiter} /></dd></div>
            </dl>
            {!outcome && <p className="small muted">The tally is not settled yet.</p>}
          </>
        ) : <p className="small muted" role="status">{read.loading ? "Reading the demo results from the chain..." : read.error ? "Demo results could not be read. Open the public record to try again." : "This demo is not available on the configured contract."}</p>}
        {read.error && <div className="dao-demo-retry"><p className="small muted">{event ? "Showing the last results read. The latest check failed." : "The demo write-up is still available."}</p><button type="button" className="btn quiet" onClick={() => void read.refresh()}>Retry demo results</button></div>}
        <a className="text-link" href={`#/event/${EVENT_ID}/organizer`}>View public event record <Icon name="arrow" /></a>
      </div>
    </section>
  );
}
