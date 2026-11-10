// What a person may do, and when. Each rule is the contract's own, so the app never offers
// an action the chain would refuse for timing, and never hides one it would accept.

import { type Event, type Standing, type TicketRecord } from "@bail/sdk";

import { slotIsVoid } from "./slots.ts";

export type RsvpBlock = "not-found" | "cancelled" | "voided" | "closed" | "rsvp-closed" | "full";

/** Why a new RSVP isn't possible, or null if it is. Unknown data means unknown, not open. */
export function rsvpBlock(event: Event | null, now: number): RsvpBlock | null {
  if (!event) return "not-found";
  if (event.closed) return "closed";
  if (event.status === "Cancelled") return "cancelled";
  if (event.status === "Voided") return "voided";
  if (now >= event.schedule.rsvp_closes_at_ms) return "rsvp-closed";
  if (event.registered >= event.capacity) return "full";
  return null;
}

export function canCancel(event: Event, ticket: TicketRecord | null, now: number): boolean {
  return !!ticket && event.status === "Active" && !event.closed && now < event.schedule.cancel_cutoff_ms;
}

/** Flags are evidence for the arbiter, valid from when a slot opens until the reveal deadline. */
export function canFlag(event: Event, slot: number, ticket: TicketRecord | null, now: number): boolean {
  if (!ticket || event.status !== "Active" || !event.slots[slot]) return false;
  if (now >= event.schedule.reveal_deadline_ms) return false;
  return (ticket.flags & (1 << slot)) === 0;
}

export function hasFlagged(ticket: TicketRecord | null, slot: number): boolean {
  return !!ticket && (ticket.flags & (1 << slot)) !== 0;
}

export function inDisputeWindow(event: Event, now: number): boolean {
  return (
    event.status === "Active" &&
    now >= event.schedule.reveal_deadline_ms &&
    now < event.schedule.dispute_ends_at_ms
  );
}

/** One vouch per ticket, only by someone who qualified on their own, only in the dispute window. */
export function canVouch(event: Event, ticket: TicketRecord | null, standing: Standing | null, now: number): boolean {
  return (
    !!ticket &&
    ticket.vouched_for === null &&
    inDisputeWindow(event, now) &&
    !!standing &&
    standing.is_final &&
    standing.attended
  );
}

export const VOUCHES_NEEDED = 2;

/** Slots whose codes are still open to being typed, revealed or voided, for progress lists. */
export function openSlotCount(event: Event, now: number): number {
  let open = 0;
  for (let slot = 0; slot < event.checkin.slots; slot++) if (!slotIsVoid(event, slot, now)) open++;
  return open;
}

export type EventTone = "open" | "live" | "waiting" | "done" | "stopped";

export interface PhaseCopy {
  label: string;
  tone: EventTone;
}

/** Plain words for the phase an event is in. */
export function describePhase(event: Event, phaseName: string): PhaseCopy {
  if (event.status === "Cancelled") return { label: "Cancelled. Every deposit is refunded.", tone: "stopped" };
  if (event.status === "Voided") return { label: "Voided by the arbiter. Every deposit is refunded.", tone: "stopped" };
  switch (phaseName) {
    case "Open": return { label: "Taking RSVPs", tone: "open" };
    case "CheckIn": return { label: "Check-in is live", tone: "live" };
    case "Reveal": return { label: "Codes are being revealed", tone: "waiting" };
    case "Dispute": return { label: "Dispute window: vouching is open", tone: "waiting" };
    case "Tally": return { label: "Settling payouts", tone: "waiting" };
    case "Settled": return { label: "Settled", tone: "done" };
    case "Closed": return { label: "Closed", tone: "done" };
    default: return { label: phaseName, tone: "waiting" };
  }
}
