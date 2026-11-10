import type { Event, TicketRecord } from "@bail/sdk";

import { catchStatus, requirement, slotStatus } from "../lib/slots.ts";
import { Icon } from "./Icon.tsx";

export interface CodeStep {
  label: string;
  tone: "confirmed" | "live" | "upcoming" | "sent" | "missed" | "void";
}

export function CodeStrip({ steps }: { steps: CodeStep[] }) {
  return (
    <ol className="code-strip" aria-label="Code progress" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(steps.length, 3))}, minmax(0, 1fr))` }}>
      {steps.map((step, index) => (
        <li className={`code-step ${step.tone}`} key={index}>
          <span className="code-number">{String(index + 1).padStart(2, "0")}</span>
          <span className="code-step-label">{step.label}</span>
          {step.tone === "confirmed" && <Icon name="check" />}
          {step.tone === "live" && <span className="live-dot" />}
        </li>
      ))}
    </ol>
  );
}

export function TicketCodeStrip({ event, eventId, now, chain, contractId, ticketKey }: {
  event: Event; eventId: number; now: number; chain: TicketRecord | null; contractId: string; ticketKey: string;
}) {
  const need = requirement(event, now);
  const steps = Array.from({ length: event.checkin.slots }, (_, slot): CodeStep => {
    const status = slotStatus(event, slot, now);
    const caught = catchStatus(event, slot, chain, contractId, eventId, ticketKey);
    if (status === "void") return { tone: "void", label: "Void" };
    if (status === "live") return { tone: "live", label: "Live now" };
    if (caught === "confirmed") return { tone: "confirmed", label: "Confirmed" };
    if (status === "waiting") return { tone: "upcoming", label: "Upcoming" };
    if (status === "awaiting-reveal") return caught === "none" ? { tone: "missed", label: "Not sent" } : { tone: "sent", label: "Sent" };
    return { tone: "missed", label: caught === "not-confirmed" ? "No match" : "Not sent" };
  });
  return <><CodeStrip steps={steps} /><p className="ticket-footnote">{need.needed} confirmed {need.needed === 1 ? "code" : "codes"} needed{need.voidSlots > 0 ? ` · ${need.voidSlots} void` : ` of ${event.checkin.slots}`}.</p></>;
}
