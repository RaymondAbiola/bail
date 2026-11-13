import { MINUTE } from "@bail/sdk";

// The timing rules live in the SDK, shared with the web app's host page.
export {
  type EventPlan,
  LATENCY_MS,
  MARGIN_MS,
  MINUTE,
  buildEvent,
  lastChance,
  parseAmount,
  slotRange,
} from "@bail/sdk";

/** "+15m", "+2h" or an ISO date, as milliseconds since the epoch. */
export function parseWhen(value: string, nowMs: number): number {
  const relative = value.match(/^\+(\d+)(m|h)$/);
  if (relative) return nowMs + Number(relative[1]) * (relative[2] === "h" ? 60 : 1) * MINUTE;
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`can't read the time ${value}; use +15m, +2h or an ISO date`);
  return at;
}

/** A moment in the range nobody can predict, so attendees can't just tune in for the codes. */
export function randomMoment({ earliest, latest }: { earliest: number; latest: number }): number {
  const span = latest - earliest;
  if (span <= 0) return earliest;
  return earliest + (crypto.getRandomValues(new Uint32Array(1))[0]! % (span + 1));
}
