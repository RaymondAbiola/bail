// Testnet onboarding: a fresh browser key becomes an implicit account holding exactly one
// deposit of test USDC, then pays it through a meta transaction the sponsor submits.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { deserialize, serialize } from "borsh";
import { SCHEMA, actions, encodeDelegateAction, nearToYocto, teraToGas } from "near-api-js";
import type { Action, DelegateAction, Signature } from "near-api-js";

import { type BailView, type Event, RSVP_GAS, encodePublicKey, isPayoutAddress } from "@bail/sdk";

import type { CallOutcome, Sender } from "./chain.ts";
import { BadRequest } from "./checks.ts";

/** Enough NEAR for an implicit account's own storage and the 1 yoctoNEAR the transfer attaches. */
const ACCOUNT_NEAR = "0.01";
const REGISTRATION_NEAR = "0.00125";
const MAX_FAUCET_DEPOSIT = 5_000_000n;

export interface DecodedDelegate {
  delegateAction: DelegateAction;
  signature: Signature;
}

interface Plain {
  delegateAction: {
    senderId: string;
    receiverId: string;
    actions: { functionCall?: { methodName: string; args: number[] | Uint8Array; gas: bigint; deposit: bigint } }[];
    nonce: bigint;
    maxBlockHeight: bigint;
    publicKey: { ed25519Key?: { data: number[] | Uint8Array } };
  };
  signature: { ed25519Signature?: { data: number[] | Uint8Array } };
}

function isOpen(event: Event | null, nowMs: number): event is Event {
  return !!event && event.status === "Active" && nowMs < event.schedule.rsvp_closes_at_ms;
}

/** The account must be an implicit one and the event must be open, in the sponsor's token, at a sane deposit. */
export function checkFaucet(body: unknown, event: Event | null, token: string, nowMs: number): { accountId: string; amount: bigint } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.account_id !== "string" || !/^[0-9a-f]{64}$/.test(b.account_id)) {
    throw new BadRequest("account_id must be an implicit account (64 hex characters)");
  }
  if (!isOpen(event, nowMs)) throw new BadRequest("this event is not taking RSVPs");
  if (event.token !== token) throw new BadRequest("this faucet only has test USDC");
  const amount = BigInt(event.deposit);
  if (amount > MAX_FAUCET_DEPOSIT) throw new BadRequest("this faucet only covers deposits up to 5 USDC");
  return { accountId: b.account_id, amount };
}

/**
 * Accepts a signed delegate only if it is exactly one RSVP: `ft_transfer_call` of the
 * event's deposit to Bail on the event's token, from the implicit account of the key that
 * signed it, with a note the contract will seat. Anything else would spend the sponsor's
 * gas on something other than an RSVP.
 */
export function checkDelegate(
  encoded: unknown,
  options: { contractId: string; eventId: number; event: Event | null; nowMs: number; finalHeight: bigint },
): { decoded: DecodedDelegate; senderId: string; ticketKey: string } {
  if (typeof encoded !== "string") throw new BadRequest("signed_delegate must be base64");
  const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
  let plain: Plain;
  try {
    plain = deserialize(SCHEMA.SignedDelegate, bytes) as Plain;
  } catch {
    throw new BadRequest("signed_delegate is not a NEP-366 signed delegate");
  }
  if (!Buffer.from(serialize(SCHEMA.SignedDelegate, plain)).equals(Buffer.from(bytes))) {
    throw new BadRequest("signed_delegate is not canonically encoded");
  }
  const d = plain.delegateAction;
  const key = d.publicKey.ed25519Key?.data;
  const signature = plain.signature.ed25519Signature?.data;
  if (!key || !signature) throw new BadRequest("only ed25519 keys are sponsored");
  if (d.senderId !== Buffer.from(key).toString("hex")) {
    throw new BadRequest("the sender must be the implicit account of the signing key");
  }
  const { event } = options;
  if (!isOpen(event, options.nowMs)) throw new BadRequest("this event is not taking RSVPs");
  if (d.receiverId !== event.token) throw new BadRequest("the transfer must be in the event's token");
  if (d.maxBlockHeight <= options.finalHeight) throw new BadRequest("this signed delegate has expired");

  const call = d.actions.length === 1 ? d.actions[0]!.functionCall : undefined;
  if (!call || call.methodName !== "ft_transfer_call") throw new BadRequest("only an ft_transfer_call is sponsored");
  if (call.deposit !== 1n || call.gas > RSVP_GAS) throw new BadRequest("the transfer must attach 1 yoctoNEAR and at most 100 Tgas");
  let args: Record<string, unknown>;
  let note: Record<string, unknown>;
  try {
    args = JSON.parse(Buffer.from(call.args).toString("utf8"));
    note = JSON.parse(String(args.msg));
  } catch {
    throw new BadRequest("the transfer's arguments are not an RSVP");
  }
  if (Object.keys(args).sort().join() !== "amount,msg,receiver_id") throw new BadRequest("unexpected transfer arguments");
  if (args.receiver_id !== options.contractId) throw new BadRequest("the transfer must go to Bail");
  if (args.amount !== event.deposit) throw new BadRequest("the transfer must be exactly the event's deposit");
  if (note.event_id !== options.eventId) throw new BadRequest("the note is for another event");
  if (typeof note.ticket_key !== "string" || typeof note.payout_to !== "string" || !isPayoutAddress(note.payout_to, { intents: false })) {
    throw new BadRequest("the note does not name a ticket and a payable address");
  }

  const hash = sha256(encodeDelegateAction(plain.delegateAction as unknown as DelegateAction));
  if (!ed25519.verify(Uint8Array.from(signature), hash, Uint8Array.from(key))) {
    throw new BadRequest("the delegate's signature does not verify");
  }
  return { decoded: plain as unknown as DecodedDelegate, senderId: d.senderId, ticketKey: note.ticket_key };
}

/** Holds test NEAR and test USDC, and pays for onboarding. Testnet only. */
export class Sponsor {
  readonly sender: Sender;
  readonly token: string;
  readonly #view: BailView;

  constructor(sender: Sender, token: string, view: BailView) {
    this.sender = sender;
    this.token = token;
    this.#view = view;
  }

  async #balance(accountId: string): Promise<bigint> {
    const view = await this.#view.rpc<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: this.token,
      method_name: "ft_balance_of",
      args_base64: Buffer.from(JSON.stringify({ account_id: accountId })).toString("base64"),
    });
    return BigInt(JSON.parse(Buffer.from(view.result).toString()));
  }

  /** Creates the implicit account if needed, registers it with the token and tops it up to `amount`. */
  async fund(accountId: string, amount: bigint): Promise<CallOutcome> {
    const key = encodePublicKey(Uint8Array.from(Buffer.from(accountId, "hex")));
    const exists = (await this.#view.accessKeyNonce(accountId, key)) !== null;
    if (!exists) {
      const created = await this.sender.send(accountId, [actions.transfer(nearToYocto(ACCOUNT_NEAR))]);
      if (!created.ok) return created;
    }
    const missing = amount - (await this.#balance(accountId));
    const txActions: Action[] = [
      actions.functionCall("storage_deposit", { account_id: accountId, registration_only: true }, teraToGas(10), nearToYocto(REGISTRATION_NEAR)),
    ];
    if (missing > 0n) {
      txActions.push(actions.functionCall("ft_transfer", { receiver_id: accountId, amount: String(missing) }, teraToGas(15), 1n));
    }
    return this.sender.send(this.token, txActions);
  }

  relay(decoded: DecodedDelegate, senderId: string): Promise<CallOutcome> {
    return this.sender.send(senderId, [actions.signedDelegate(decoded)]);
  }
}

