import { openSlotArgs, revealArgs, type Event } from "@bail/sdk";

/** Refuse a recovered or stale code unless it matches the commitment already on chain. */
export function matchingHostCode(contractId: string, eventId: number, event: Event, slot: number, code: string | null | undefined): code is string {
  return !!code && !!event.slots[slot] && openSlotArgs(contractId, eventId, slot, code).commitment === event.slots[slot]!.commitment;
}

export async function relayHostReveal(baseUrl: string, eventId: number, slot: number, code: string): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/reveal`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(revealArgs(eventId, slot, code)), signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 409) return; // Another keeper already revealed it; re-read the chain.
  const body = await response.json().catch(() => ({})) as { tx?: string };
  if (!response.ok || typeof body.tx !== "string") throw new Error("Automatic reveal could not be confirmed. Retry or reveal with your wallet.");
}
