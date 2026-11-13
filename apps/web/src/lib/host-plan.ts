import { buildEvent, isAccountId, parseAmount, type BailView, type Config, type EventPlan } from "@bail/sdk";

export interface HostFields {
  startsAt: string;
  checkinMinutes: string;
  slots: string;
  required: string;
  windowMinutes: string;
  deposit: string;
  capacity: string;
  arbiter: string;
  cancelBeforeMinutes: string;
  revealMinutes: string;
  disputeMinutes: string;
  title: string;
  callUrl: string;
}

export function localDateTime(ms: number): string {
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function defaultHostFields(nowMs: number): HostFields {
  return { startsAt: localDateTime(nowMs + 60 * 60_000), checkinMinutes: "60", slots: "3", required: "3", windowMinutes: "5", deposit: "0.5", capacity: "30", arbiter: "", cancelBeforeMinutes: "60", revealMinutes: "15", disputeMinutes: "30", title: "", callUrl: "" };
}

function whole(value: string, label: string, min: number, max = 525_600): number {
  const n = Number(value);
  if (!value.trim() || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** UI bounds complement buildEvent, which owns the shared scheduling rules. */
export function validateHostFields(fields: HostFields, token: string, organizer: string, nowMs: number, limits?: Config): EventPlan {
  const deposit = parseAmount(fields.deposit.trim(), 6);
  if (deposit <= 0n || deposit >= 2n ** 128n) throw new Error("The deposit must be greater than zero and fit the token's amount limit.");
  const arbiter = fields.arbiter.trim();
  if (!isAccountId(arbiter)) throw new Error("Enter a valid NEAR testnet arbiter account.");
  if (arbiter === organizer) throw new Error("The arbiter cannot be the organizer.");
  const starts = new Date(fields.startsAt).getTime();
  if (!Number.isSafeInteger(starts)) throw new Error("Choose a check-in start date and time.");
  if (fields.callUrl.trim()) {
    let url: URL;
    try { url = new URL(fields.callUrl.trim()); } catch { throw new Error("The call link must be a full http or https address."); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The call link must use http or https.");
  }
  const plan: EventPlan = {
    token, deposit, arbiter, checkinOpensAt: starts,
    capacity: whole(fields.capacity, "Seats", 1, 1000),
    slots: whole(fields.slots, "Codes", 1, 5), required: whole(fields.required, "Required codes", 1, 5),
    checkinMinutes: whole(fields.checkinMinutes, "Check-in length", 1), windowMinutes: whole(fields.windowMinutes, "Code window", 1),
    cancelBeforeMinutes: whole(fields.cancelBeforeMinutes, "Cancellation notice", 0), revealMinutes: whole(fields.revealMinutes, "Reveal period", 1), disputeMinutes: whole(fields.disputeMinutes, "Dispute period", 1),
  };
  if (plan.required > plan.slots) throw new Error("Required codes cannot exceed the number of codes.");
  const event = buildEvent(plan, nowMs);
  if (limits) {
    if (event.checkin.window_ms < limits.min_window_ms) throw new Error(`Code windows must be at least ${Math.ceil(limits.min_window_ms / 60_000)} minutes on this contract.`);
    if (event.reveal_ms < limits.min_reveal_ms) throw new Error(`The reveal period must be at least ${Math.ceil(limits.min_reveal_ms / 60_000)} minutes.`);
    if (event.dispute_ms < limits.min_dispute_ms) throw new Error(`The dispute period must be at least ${Math.ceil(limits.min_dispute_ms / 60_000)} minutes.`);
    if (event.checkin_closes_at_ms + event.reveal_ms + event.dispute_ms - nowMs > limits.max_event_ms) throw new Error("The event ends beyond this contract's maximum event length. Choose an earlier start or shorter periods.");
  }
  return plan;
}

/** An arbiter must already exist, including when its name is a 64-character implicit account. */
export async function checkArbiter(view: Pick<BailView, "rpc">, account: string, organizer: string): Promise<void> {
  if (!isAccountId(account)) throw new Error("Enter a valid NEAR testnet arbiter account.");
  if (account === organizer) throw new Error("The arbiter cannot be the organizer.");
  try { await view.rpc("query", { request_type: "view_account", account_id: account, finality: "final" }); }
  catch (error) {
    if (error instanceof Error && /\bUNKNOWN_ACCOUNT\b/.test(error.message)) throw new Error(`There is no NEAR account called ${account}.`);
    throw new Error("Could not check the arbiter account. Try again before creating the event.");
  }
}
