import { type Event, Ticket, type TicketRecord, catchProof, toBase64 } from "@bail/sdk";

export const CONTRACT = "v1.dontbail.testnet";
export const T0 = 1_800_000_000_000;
const MIN = 60_000;

/** An event with 3 codes of 1 minute, 2 needed. Check-in 10:00 to 10:10, reveal to 10:15, dispute to 10:25. */
export function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    organizer: "host.testnet", arbiter: "dao.testnet", token: "usdc.testnet", deposit: "1000000",
    capacity: 10, registered: 3, tickets_created: 3, owed_records: 0, owed_total: 0, status: "Active",
    schedule: {
      cancel_cutoff_ms: T0 - 30 * MIN, rsvp_closes_at_ms: T0, checkin_opens_at_ms: T0,
      checkin_closes_at_ms: T0 + 10 * MIN, reveal_deadline_ms: T0 + 15 * MIN, dispute_ends_at_ms: T0 + 25 * MIN,
    },
    checkin: { slots: 3, required: 2, window_ms: MIN },
    slots: [], tally: null, closed: false,
    ...overrides,
  };
}

export function makeTicket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    payout_to: "near:alice.testnet", index: 0, catches: [null, null, null, null, null], flags: 0,
    vouched_for: null, vouched_by: 0, outcome: null, paid: false, ...overrides,
  };
}

/** A catch of `code` for slot `slot`, as the chain stores it. */
export function catchOf(ticket: Ticket, eventId: number, slot: number, code: string, attempt = 1) {
  return { attempt, proof: toBase64(catchProof(CONTRACT, eventId, slot, code, ticket.publicKey)) };
}

export { MIN };
