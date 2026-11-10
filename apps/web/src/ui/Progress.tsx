import type { Event, Ticket, TicketRecord } from "@bail/sdk";

import { type CatchStatus, type SlotStatus, catchStatus, requirement, slotStatus } from "../lib/slots.ts";
import { FlagAction } from "./LiveCode.tsx";

interface Row {
  mark: "done" | "now" | "bad" | "void" | "idle";
  glyph: string;
  title: string;
  detail: string;
}

function row(status: SlotStatus, caught: CatchStatus): Row {
  switch (status) {
    case "waiting":
      return { mark: "idle", glyph: "-", title: "Not opened yet", detail: "The host opens each code at an unexpected moment." };
    case "live":
      return { mark: "now", glyph: "!", title: "Live now", detail: caught === "none" ? "No code sent yet." : "A code was sent. You can still correct it." };
    case "awaiting-reveal":
      return caught === "none"
        ? { mark: "bad", glyph: "x", title: "Window closed, no code sent", detail: "Waiting for the host to reveal this code." }
        : { mark: "idle", glyph: "?", title: "Sent, waiting for the reveal", detail: "It is confirmed once the host reveals the code." };
    case "revealed":
      if (caught === "confirmed") return { mark: "done", glyph: "✓", title: "Confirmed", detail: "Your code matched." };
      if (caught === "not-confirmed") return { mark: "bad", glyph: "x", title: "Not confirmed", detail: "What you sent did not match the revealed code." };
      return { mark: "bad", glyph: "x", title: "No code sent", detail: "This code was revealed and you did not send one." };
    case "void":
      return { mark: "void", glyph: "-", title: "Void", detail: "The host did not open or reveal this code in time, so it lowers what you need." };
  }
}

export interface ProgressProps {
  eventId: number;
  event: Event;
  now: number;
  contractId: string;
  ticketKey: string;
  chain: TicketRecord | null;
  ticketObj?: Ticket;
  onChanged?: () => void;
}

/** One line per code, with words as well as marks, and the current requirement above it. */
export function Progress({ eventId, event, now, contractId, ticketKey, chain, ticketObj, onChanged }: ProgressProps) {
  const need = requirement(event, now);
  let confirmed = 0;
  const rows = Array.from({ length: event.checkin.slots }, (_, slot) => {
    const status = slotStatus(event, slot, now);
    const caught = catchStatus(event, slot, chain, contractId, eventId, ticketKey);
    if (caught === "confirmed") confirmed++;
    return { slot, status, caught, ...row(status, caught) };
  });
  return (
    <div className="actions">
      <p>
        <strong>
          You need {need.needed} confirmed {need.needed === 1 ? "code" : "codes"}
        </strong>{" "}
        <span className="muted">
          ({event.checkin.required} required of {event.checkin.slots}
          {need.voidSlots > 0 ? `, ${need.voidSlots} void so far lowers it` : ""}). Confirmed so far: {confirmed}.
        </span>
      </p>
      <ol className="steps" aria-label="Codes">
        {rows.map((r) => (
          <li key={r.slot}>
            <span className={`mark ${r.mark === "idle" ? "" : r.mark}`} aria-hidden="true">{r.glyph}</span>
            <div>
              <strong>Code {r.slot + 1}: {r.title}</strong>
              <div className="small muted">{r.detail}</div>
              {ticketObj && onChanged && r.status === "awaiting-reveal" && r.caught === "none" && (
                <FlagAction eventId={eventId} event={event} slot={r.slot} now={now} ticket={ticketObj} chain={chain} onChanged={onChanged} />
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
