import { catchProof, normalizeCode, toBase64, type TicketRecord } from "@bail/sdk";

import type { Submission } from "./storage.ts";

export function codeEntryWarnings(text: string): string[] {
  const normalized = normalizeCode(text);
  if (!normalized) return [];
  const words = normalized.split(" ");
  const warnings: string[] = [];
  if (words.length !== 5) {
    warnings.push(`That is ${words.length} ${words.length === 1 ? "word" : "words"}. A code is five words. If you copied it letter by letter, ask the host to send the words again.`);
  }
  if (words.length > 1 && words.filter((word) => word.length === 1).length > words.length / 2) {
    warnings.push("These look like single letters. Codes are whole words.");
  }
  return warnings;
}

/** A local retry may not have landed. Show it as sent only if it matches the recorded catch. */
export function recordedCode(submission: Submission | undefined, chain: TicketRecord | null, contractId: string, eventId: number, slot: number, ticketKey: string): string | null {
  const caught = chain?.catches[slot];
  if (!submission || !caught || submission.attempt !== caught.attempt) return null;
  const proof = toBase64(catchProof(contractId, eventId, slot, submission.code, ticketKey));
  return proof === caught.proof ? submission.code : null;
}
