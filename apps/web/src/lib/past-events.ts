import type { BailView, Event } from "@bail/sdk";

import { sumUnits } from "./money.ts";

export const PAST_EVENTS = [
  { id: 4, title: "Dry run with friends", date: "2026-11-11", dateLabel: "11 Nov 2026" },
  { id: 5, title: "First community call", date: "2026-11-12", dateLabel: "12 Nov 2026" },
] as const;

export interface PastEventRead {
  event: Event | null;
  failed: boolean;
}

export async function readPastEvents(view: Pick<BailView, "event">): Promise<PastEventRead[]> {
  const results = await Promise.allSettled(PAST_EVENTS.map(({ id }) => view.event(id)));
  return results.map((result) => result.status === "fulfilled" ? { event: result.value, failed: false } : { event: null, failed: true });
}

export function pastEventOutcome(event: Event | null) {
  const tally = event?.tally;
  if (!event || !tally || tally.stage !== "Done") return null;
  return {
    seats: tally.attended + tally.vouched + tally.forfeited + tally.refunded,
    attended: tally.attended,
    vouched: tally.vouched,
    forfeited: tally.forfeited,
    refunded: tally.refunded,
    duePerAttendee: tally.attended > 0 ? sumUnits(event.deposit, tally.bonus) : null,
  };
}
