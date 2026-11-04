import { sha256 } from "@noble/hashes/sha2.js";

import { type EventId, decodePublicKey, eventIdBytes, fields, slotByte, text } from "./codec.ts";
import { checkedCode } from "./codes.ts";

/** What the host commits onchain when a slot opens. The code is normalized first. */
export function codeCommitment(contractId: string, eventId: EventId, slot: number, code: string): Uint8Array {
  return sha256(
    fields(text("bail/v1/code"), text(contractId), eventIdBytes(eventId), slotByte(slot), text(checkedCode(code))),
  );
}

/** A catch of `code`, bound to one ticket so it can't be copied to another. */
export function catchProof(
  contractId: string,
  eventId: EventId,
  slot: number,
  code: string,
  ticketKey: string,
): Uint8Array {
  return sha256(
    fields(
      text("bail/v1/proof"),
      text(contractId),
      eventIdBytes(eventId),
      slotByte(slot),
      text(checkedCode(code)),
      decodePublicKey(ticketKey),
    ),
  );
}
