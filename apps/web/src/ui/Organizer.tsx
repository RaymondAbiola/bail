import { type TicketRecord } from "@bail/sdk";

import { useApp } from "../context.tsx";
import { useChainNow, useEventState, usePoll } from "../hooks.ts";
import { describePhase } from "../lib/rules.ts";
import { slotStatus } from "../lib/slots.ts";
import { formatUsdc } from "../lib/money.ts";
import { Notice, Skeleton, formatClock, formatWhen } from "./common.tsx";
import { phase as phaseOf } from "@bail/sdk";

const PAGE = 100;
const MAX_PAGES = 10;

/** Public, read-only headcount and per-code activity. Nothing here can set anyone's attendance. */
export function Organizer({ id }: { id: number }) {
  const { view } = useApp();
  const { now } = useChainNow();
  const eventPoll = useEventState(id, null);
  const event = eventPoll.data?.event ?? null;

  const tickets = usePoll<{ list: TicketRecord[]; complete: boolean }>(
    async () => {
      const list: TicketRecord[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const rows = await view.tickets(id, page * PAGE, PAGE);
        list.push(...rows.map(([, ticket]) => ticket));
        if (rows.length < PAGE) return { list, complete: true };
      }
      return { list, complete: false };
    },
    15_000,
    [view, id],
  );

  if (!event) {
    return (
      <div className="page">
        {eventPoll.loading ? <Skeleton block label="Loading the event" /> : <Notice tone="bad">Could not read this event.</Notice>}
      </div>
    );
  }

  const phase = phaseOf(event, now);
  const read = tickets.data?.list.length ?? 0;
  const registeredLabel = event.closed ? "freed" : String(event.registered);
  return (
    <div className="page">
      <div className="column">
        <a href={`#/event/${id}`}>Back to the event</a>
        <h1>Organizer view, event #{id}</h1>
        <p className="muted">Read only. Attendance is proved by attendees' own codes, so there is nothing here that can mark anyone present or absent.</p>
        <span className={`badge ${describePhase(event, phase).tone}`}>{describePhase(event, phase).label}</span>

        <dl className="facts card">
          <div><dt>Registered</dt><dd>{registeredLabel} of {event.capacity}</dd></div>
          <div><dt>Codes opened</dt><dd>{event.slots.length} of {event.checkin.slots}</dd></div>
          <div><dt>Required</dt><dd>{event.checkin.required} catches</dd></div>
          <div><dt>Deposit</dt><dd>{formatUsdc(event.deposit)}</dd></div>
        </dl>

        <section className="card">
          <h2>Codes</h2>
          {event.closed ? (
            <p>Ticket records were freed when this event closed, so per-code submission counts are no longer available.</p>
          ) : tickets.data === null ? (
            tickets.error ? <Notice tone="bad">Could not read tickets. {tickets.error}</Notice> : <Skeleton label="Reading tickets" />
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Code</th><th>Status</th><th>Opened</th><th>Codes sent</th><th>Flags</th></tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: event.checkin.slots }, (_, slot) => {
                      const opened = event.slots[slot];
                      const sent = tickets.data!.list.filter((t) => t.catches[slot]).length;
                      return (
                        <tr key={slot}>
                          <th scope="row">{slot + 1}</th>
                          <td>{{ waiting: "Not opened", live: "Live", "awaiting-reveal": "Awaiting reveal", revealed: "Revealed", void: "Void" }[slotStatus(event, slot, now)]}</td>
                          <td>{opened ? formatClock(opened.opened_at_ms) : "-"}</td>
                          <td>{sent} of {read}</td>
                          <td>{opened ? opened.flags : "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="small muted">
                {tickets.data.complete ? `Counts cover all ${read} tickets read.` : `Counts cover the first ${read} tickets only; more exist.`}{" "}
                {tickets.updatedAt ? `Updated ${formatClock(tickets.updatedAt)}.` : ""} A count is a snapshot, not a final result.
              </p>
            </>
          )}
        </section>

        {event.tally && (
          <section className="card">
            <h2>Tally</h2>
            <dl className="facts">
              <div><dt>Attended</dt><dd>{event.tally.attended}</dd></div>
              <div><dt>Vouched</dt><dd>{event.tally.vouched}</dd></div>
              <div><dt>Forfeited</dt><dd>{event.tally.forfeited}</dd></div>
              <div><dt>Refunded</dt><dd>{event.tally.refunded}</dd></div>
              <div><dt>Forfeit pool</dt><dd>{formatUsdc(event.tally.pool)}</dd></div>
              <div><dt>Bonus each</dt><dd>{formatUsdc(event.tally.bonus)}</dd></div>
            </dl>
            <p className="small muted">Stage: {event.tally.stage}. Check-in closed {formatWhen(event.schedule.checkin_closes_at_ms)}.</p>
          </section>
        )}
      </div>
    </div>
  );
}
