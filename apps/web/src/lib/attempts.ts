import type { TicketRecord } from "@bail/sdk";

import type { Submission } from "./storage.ts";

/**
 * The attempt number for a new catch: one above the highest the chain has seen for this
 * slot, or the highest this browser has tried, whichever is bigger. Attempts only have to
 * increase, so a skipped number from an unsure earlier try is harmless.
 */
export function nextAttempt(
  chain: TicketRecord | null,
  slot: number,
  local: Record<number, Submission> | undefined,
): number {
  const onChain = chain?.catches[slot]?.attempt ?? 0;
  const tried = local?.[slot]?.attempt ?? 0;
  return Math.max(onChain, tried) + 1;
}

/** Whether the chain has this attempt (or a later one), which settles an unsure submission. */
export function attemptLanded(chain: TicketRecord | null, slot: number, attempt: number): boolean {
  return (chain?.catches[slot]?.attempt ?? 0) >= attempt;
}
