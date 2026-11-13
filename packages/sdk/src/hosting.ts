import { toBase64 } from "./codec.ts";
import { checkedCode } from "./codes.ts";
import { codeCommitment } from "./hashes.ts";
import type { Event, NewEvent } from "./types.ts";

// What an organizer's app needs to create an event and run its codes, shared by the host
// console and the web app so both follow the same timing rules.

export const MINUTE = 60_000;
/** Slack around every code window, because block times are not exact. */
export const MARGIN_MS = 15_000;
/**
 * Room kept for each code still to come, for the open and reveal transactions and a throttled
 * RPC. Without it a late open can leave the last code no time, as it did in the dry run.
 */
export const LATENCY_MS = 45_000;
export const CREATE_EVENT_TGAS = 100;
export const HOST_TGAS = 30;

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

/** Whole and fractional token amounts, such as "1" or "0.5", in the smallest unit. */
export function parseAmount(value: string, decimals: number): bigint {
  const match = value.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length ?? 0) > decimals) throw new Error(`can't read the amount ${value}`);
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
}

/** The shortest check-in that fits every code window with room around each. */
export function minCheckinMinutes(slots: number, windowMinutes: number): number {
  return Math.ceil((slots * (windowMinutes * MINUTE + MARGIN_MS + LATENCY_MS) + MARGIN_MS) / MINUTE);
}

/** The `create_event` argument for a plan, refusing schedules the host couldn't run. */
export function buildEvent(plan: EventPlan, nowMs: number): NewEvent {
  const window = plan.windowMinutes * MINUTE;
  const checkin = plan.checkinMinutes * MINUTE;
  if (plan.checkinMinutes < minCheckinMinutes(plan.slots, plan.windowMinutes)) {
    throw new Error(`check-in must be at least ${minCheckinMinutes(plan.slots, plan.windowMinutes)} minutes for ${plan.slots} codes of ${plan.windowMinutes} minutes`);
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
 * enough that it and every later slot still fit before check-in closes. Null means there is
 * no longer room for it, so the code stays unopened and becomes void.
 */
export function slotRange(
  slot: number,
  slots: number,
  windowMs: number,
  opensAt: number,
  closesAt: number,
  previousOpenedAt: number | null,
): { earliest: number; latest: number } | null {
  const earliest = previousOpenedAt === null ? opensAt + MARGIN_MS : previousOpenedAt + windowMs + MARGIN_MS;
  if (earliest + windowMs + MARGIN_MS > closesAt) return null;
  const latest = closesAt - (slots - slot) * (windowMs + MARGIN_MS + LATENCY_MS);
  return { earliest, latest: Math.max(earliest, latest) };
}

/** The last moment any code can still be opened and have its whole window before check-in closes. */
export function lastChance(windowMs: number, closesAt: number): number {
  return closesAt - windowMs - MARGIN_MS - LATENCY_MS;
}

export type NextCode =
  | { state: "all-opened" }
  | { state: "checkin-over"; slot: number }
  | { state: "no-room"; slot: number }
  | {
      state: "waiting" | "ready";
      slot: number;
      /** The previous window has closed onchain (or check-in has opened), so this code may open. */
      earliest: number;
      /** Open by then and every later code still fits. */
      roomBy: number;
      /** After this the code can't open at all and becomes void. */
      lastChance: number;
    };

/** The next code the host can open, judged by `nowMs` in block time. */
export function nextCode(event: Event, nowMs: number): NextCode {
  const slot = event.slots.length;
  const { slots, window_ms: windowMs } = event.checkin;
  if (slot >= slots) return { state: "all-opened" };
  const { checkin_opens_at_ms: opensAt, checkin_closes_at_ms: closesAt } = event.schedule;
  if (nowMs >= closesAt) return { state: "checkin-over", slot };
  const previous = slot === 0 ? null : event.slots[slot - 1]!.opened_at_ms;
  const range = slotRange(slot, slots, windowMs, opensAt, closesAt, previous);
  const last = lastChance(windowMs, closesAt);
  if (!range || nowMs > last) return { state: "no-room", slot };
  return { state: nowMs >= range.earliest ? "ready" : "waiting", slot, earliest: range.earliest, roomBy: range.latest, lastChance: last };
}

/** The `open_slot` arguments: the code itself stays with the host, only its commitment goes onchain. */
export function openSlotArgs(contractId: string, eventId: number, slot: number, code: string) {
  return { event_id: eventId, slot, commitment: toBase64(codeCommitment(contractId, eventId, slot, code)) };
}

export function revealArgs(eventId: number, slot: number, code: string) {
  return { event_id: eventId, slot, code: checkedCode(code) };
}

/** Opened slots whose window has closed, not yet revealed, while revealing is still allowed. */
export function revealableSlots(event: Event, nowMs: number): number[] {
  if (nowMs >= event.schedule.reveal_deadline_ms) return [];
  return event.slots.flatMap((s, slot) =>
    s.revealed === null && nowMs >= s.opened_at_ms + event.checkin.window_ms + MARGIN_MS ? [slot] : [],
  );
}

/**
 * The event id `create_event` returned, from a wallet's final execution outcome. Null when the
 * outcome has no success value, so the caller can look the event up instead.
 */
export function createdEventId(outcome: unknown): number | null {
  const status = (outcome as { status?: { SuccessValue?: string } } | null)?.status;
  if (!status || typeof status.SuccessValue !== "string" || status.SuccessValue === "") return null;
  try {
    const value: unknown = JSON.parse(atob(status.SuccessValue));
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}
