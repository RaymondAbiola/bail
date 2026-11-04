import { type EventId, decodePublicKey, encodePublicKey, toHex } from "./codec.ts";

/** `bail/v1/<action>/<contract>/<event>[/<part>...]`, the string a ticket signs. */
function message(action: string, contractId: string, eventId: EventId, parts: string[]): string {
  return ["bail/v1", action, contractId, String(eventId), ...parts].join("/");
}

export function catchMessage(
  contractId: string,
  eventId: EventId,
  slot: number,
  attempt: number,
  proof: Uint8Array,
): string {
  return message("catch", contractId, eventId, [String(slot), String(attempt), toHex(proof)]);
}

export function flagMessage(contractId: string, eventId: EventId, slot: number): string {
  return message("flag", contractId, eventId, [String(slot)]);
}

export function cancelMessage(contractId: string, eventId: EventId): string {
  return message("cancel", contractId, eventId, []);
}

/** The contract rebuilds the target key from its bytes, so the SDK does too. */
export function vouchMessage(contractId: string, eventId: EventId, targetKey: string): string {
  return message("vouch", contractId, eventId, [encodePublicKey(decodePublicKey(targetKey))]);
}
