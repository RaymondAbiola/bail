// Mirrors the contract's slot rules (contracts/bail/src/reveal.rs), so what the app says
// matches what the tally will do.

import { type Event, type TicketRecord, catchProof, toBase64 } from "@bail/sdk";

export type SlotStatus = "waiting" | "live" | "awaiting-reveal" | "revealed" | "void";

/** Unopened at the end of check-in, or opened and never revealed by the reveal deadline. */
export function slotIsVoid(event: Event, slot: number, now: number): boolean {
  const opened = event.slots[slot];
  if (!opened) return now >= event.schedule.checkin_closes_at_ms;
  return opened.revealed === null && now >= event.schedule.reveal_deadline_ms;
}

export function slotWindowEnd(event: Event, slot: number): number | null {
  const opened = event.slots[slot];
  return opened ? opened.opened_at_ms + event.checkin.window_ms : null;
}

export function slotStatus(event: Event, slot: number, now: number): SlotStatus {
  if (slotIsVoid(event, slot, now)) return "void";
  const opened = event.slots[slot];
  if (!opened) return "waiting";
  if (now < opened.opened_at_ms + event.checkin.window_ms) return "live";
  return opened.revealed === null ? "awaiting-reveal" : "revealed";
}

/** The slot a person can be typing a code for right now, if any. */
export function liveSlot(event: Event, now: number): number | null {
  for (let slot = event.slots.length - 1; slot >= 0; slot--) {
    if (slotStatus(event, slot, now) === "live") return slot;
  }
  return null;
}

export type CatchStatus = "none" | "submitted" | "confirmed" | "not-confirmed";

/**
 * Whether this ticket's catch for a slot counts. It can only be known once the code is
 * revealed: until then a catch is just "submitted". The check is the contract's own: the
 * stored proof must equal the proof of the revealed code for this ticket.
 */
export function catchStatus(
  event: Event,
  slot: number,
  ticket: TicketRecord | null,
  contractId: string,
  eventId: number,
  ticketKey: string,
): CatchStatus {
  const caught = ticket?.catches[slot] ?? null;
  if (!caught) return "none";
  const revealed = event.slots[slot]?.revealed ?? null;
  if (revealed === null) return "submitted";
  const expected = toBase64(catchProof(contractId, eventId, slot, revealed, ticketKey));
  return caught.proof === expected ? "confirmed" : "not-confirmed";
}

export interface Requirement {
  slots: number;
  required: number;
  voidSlots: number;
  /** Catches still needed after void slots lower the bar. */
  needed: number;
}

export function requirement(event: Event, now: number): Requirement {
  let voidSlots = 0;
  for (let slot = 0; slot < event.checkin.slots; slot++) if (slotIsVoid(event, slot, now)) voidSlots++;
  return {
    slots: event.checkin.slots,
    required: event.checkin.required,
    voidSlots,
    needed: Math.max(0, event.checkin.required - voidSlots),
  };
}

export function confirmedCatches(
  event: Event,
  ticket: TicketRecord | null,
  contractId: string,
  eventId: number,
  ticketKey: string,
): number {
  let confirmed = 0;
  for (let slot = 0; slot < event.checkin.slots; slot++) {
    if (catchStatus(event, slot, ticket, contractId, eventId, ticketKey) === "confirmed") confirmed++;
  }
  return confirmed;
}
