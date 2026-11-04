import { type EventId, decodePublicKey, encodePublicKey } from "./codec.ts";

export const MAX_PAYOUT_LEN = 72;

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** NEAR's account id rules: 2 to 64 characters, lowercase, separators never doubled or at the ends. */
export function isAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && ACCOUNT_ID.test(value);
}

/**
 * Whether the contract accepts this payout address. `intents:` addresses need a contract
 * configured with a NEAR Intents account, which testnet doesn't have.
 */
export function isPayoutAddress(address: string, options: { intents: boolean }): boolean {
  if (address.length > MAX_PAYOUT_LEN) return false;
  if (address.startsWith("near:")) return isAccountId(address.slice(5));
  if (address.startsWith("intents:")) return options.intents && isAccountId(address.slice(8));
  return false;
}

/**
 * The `msg` of the `ft_transfer_call` that pays the deposit. Keys follow the contract's
 * `RsvpMsg`, so the note is byte-identical to the one its tests deposit.
 */
export function rsvpNote(
  eventId: EventId,
  ticketKey: string,
  payoutTo: string,
  options: { intents: boolean },
): string {
  if (!isPayoutAddress(payoutTo, options)) throw new Error(`the contract won't pay ${payoutTo}`);
  const key = encodePublicKey(decodePublicKey(ticketKey));
  return `{"event_id":${String(eventId)},"ticket_key":${JSON.stringify(key)},"payout_to":${JSON.stringify(payoutTo)}}`;
}
