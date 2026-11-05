// The SDK encodes delegate actions itself so the browser bundle stays small. These tests
// hold it to near-api-js byte for byte; the sandbox test then has the chain accept one.

import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  PublicKey,
  Signature,
  actions,
  buildDelegateAction,
  encodeDelegateAction as nearEncodeDelegate,
  encodeSignedDelegate as nearEncodeSigned,
} from "near-api-js";

import {
  Ticket,
  decodePublicKey,
  delegateHash,
  encodeDelegateAction,
  fromBase64,
  implicitAccountId,
  rsvpDelegate,
} from "../src/index.ts";

const ticket = Ticket.fromSeed(new Uint8Array(32).fill(7));
const delegate = rsvpDelegate({
  publicKey: ticket.publicKey,
  token: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  contractId: "v1.dontbail.testnet",
  deposit: "1000000",
  note: ticket.rsvpNote(4, `near:${ticket.accountId}`),
  nonce: 123_456_789_012n,
  maxBlockHeight: 276_100_000n,
});

const reference = buildDelegateAction({
  senderId: delegate.senderId,
  receiverId: delegate.receiverId,
  actions: [actions.functionCall(delegate.methodName, delegate.args, delegate.gas, delegate.deposit)],
  nonce: delegate.nonce,
  maxBlockHeight: delegate.maxBlockHeight,
  publicKey: PublicKey.fromString(delegate.publicKey),
});

test("the implicit account is the key's hex", () => {
  assert.match(ticket.accountId, /^[0-9a-f]{64}$/);
  assert.equal(implicitAccountId(ticket.publicKey), Buffer.from(decodePublicKey(ticket.publicKey)).toString("hex"));
});

test("delegate actions encode exactly as near-api-js encodes them", () => {
  const ours = encodeDelegateAction(delegate);
  const theirs = nearEncodeDelegate(reference);
  // near-api-js puts the NEP-461 prefix in front; the rest must match byte for byte.
  assert.deepEqual(theirs.slice(4), ours);
  assert.deepEqual(sha256(theirs), delegateHash(delegate));
});

test("a signed delegate is near-api-js's encoding, and its signature verifies", () => {
  const signed = fromBase64(ticket.signDelegate(delegate));
  const signature = signed.slice(-64);
  const action = actions.signedDelegate({
    delegateAction: reference,
    signature: new Signature({ keyType: 0, data: signature }),
  });
  const theirs = nearEncodeSigned(action.signedDelegate!);
  assert.deepEqual(signed, theirs);
  assert.ok(ed25519.verify(signature, sha256(nearEncodeDelegate(reference)), decodePublicKey(ticket.publicKey)));
});

test("a ticket only signs delegate actions for its own key", () => {
  assert.throws(() => Ticket.generate().signDelegate(delegate), /another key/);
});
