import type { NewEvent } from "@bail/sdk";

export const MINUTE = 60_000;
/** Slack around every code window, because block times are not exact. */
export const MARGIN_MS = 15_000;

export interface EventPlan {
  token: string;
  /** In the token's smallest unit. */
  deposit: bigint;
  capacity: number;
  arbiter: string;
  checkinOpensAt: number;
  checkinMinutes: number;
  slots: number;
  required: number;
  windowMinutes: number;
  revealMinutes: number;
  disputeMinutes: number;
  /** Free cancellation ends this long before check-in opens. */
  cancelBeforeMinutes: number;
}

/** "+15m", "+2h" or an ISO date, as milliseconds since the epoch. */
export function parseWhen(value: string, nowMs: number): number {
  const relative = value.match(/^\+(\d+)(m|h)$/);
  if (relative) return nowMs + Number(relative[1]) * (relative[2] === "h" ? 60 : 1) * MINUTE;
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`can't read the time ${value}; use +15m, +2h or an ISO date`);
  return at;
}

/** Whole and fractional token amounts, such as "1" or "0.5", in the smallest unit. */
export function parseAmount(value: string, decimals: number): bigint {
  const match = value.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length ?? 0) > decimals) throw new Error(`can't read the amount ${value}`);
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
}

/** The `create_event` argument for a plan, refusing schedules the live console couldn't run. */
export function buildEvent(plan: EventPlan, nowMs: number): NewEvent {
  const window = plan.windowMinutes * MINUTE;
  const checkin = plan.checkinMinutes * MINUTE;
  const needed = plan.slots * (window + MARGIN_MS) + MARGIN_MS;
  if (checkin < needed) {
    throw new Error(`check-in must be at least ${Math.ceil(needed / MINUTE)} minutes for ${plan.slots} codes of ${plan.windowMinutes} minutes`);
  }
  if (plan.checkinOpensAt <= nowMs) throw new Error("check-in must open in the future");
  const cutoff = Math.max(nowMs + MINUTE, plan.checkinOpensAt - plan.cancelBeforeMinutes * MINUTE);
  return {
    token: plan.token,
    deposit: String(plan.deposit),
    capacity: plan.capacity,
    arbiter: plan.arbiter,
    cancel_cutoff_ms: Math.min(cutoff, plan.checkinOpensAt),
    rsvp_closes_at_ms: plan.checkinOpensAt,
    checkin_opens_at_ms: plan.checkinOpensAt,
    checkin_closes_at_ms: plan.checkinOpensAt + checkin,
    reveal_ms: plan.revealMinutes * MINUTE,
    dispute_ms: plan.disputeMinutes * MINUTE,
    checkin: { slots: plan.slots, required: plan.required, window_ms: window },
  };
}

/**
 * When slot `slot` may open: after the previous window has closed onchain, and early
 * enough that it and every later slot still fit before check-in closes.
 */
export function slotRange(
  slot: number,
  slots: number,
  windowMs: number,
  opensAt: number,
  closesAt: number,
  previousOpenedAt: number | null,
): { earliest: number; latest: number } {
  const earliest = previousOpenedAt === null ? opensAt + MARGIN_MS : previousOpenedAt + windowMs + MARGIN_MS;
  const latest = closesAt - (slots - slot) * (windowMs + MARGIN_MS);
  if (earliest + windowMs + MARGIN_MS > closesAt) throw new Error(`too late to open code ${slot + 1}`);
  return { earliest, latest: Math.max(earliest, latest) };
}

/** A moment in the range nobody can predict, so attendees can't just tune in for the codes. */
export function randomMoment({ earliest, latest }: { earliest: number; latest: number }): number {
  const span = latest - earliest;
  if (span <= 0) return earliest;
  return earliest + (crypto.getRandomValues(new Uint32Array(1))[0]! % (span + 1));
}
