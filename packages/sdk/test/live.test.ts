// Reads the deployed testnet contract. Runs only with BAIL_LIVE=1, since it needs the network.

import assert from "node:assert/strict";
import { test } from "node:test";

import { BailView, TESTNET, Ticket } from "../src/index.ts";

const live = process.env.BAIL_LIVE === "1";
const view = new BailView(TESTNET);

test("the deployed contract runs the published source with the testnet config", { skip: !live }, async () => {
  const config = await view.config();
  assert.equal(config.fee_bps, 0);
  assert.equal(config.intents_account, null);
  const source = await view.sourceMetadata();
  assert.match(source.link ?? "", /^https:\/\/github\.com\/RaymondAbiola\/bail\/tree\/[0-9a-f]{40}$/);
  assert.equal(await view.storageCost(30), "320000000000000000000000");
});

test("events and tickets read back as typed views", { skip: !live }, async () => {
  const event = await view.event(0);
  if (!event) {
    assert.equal(await view.event(0), null);
    return;
  }
  assert.ok(["Active", "Cancelled", "Voided"].includes(event.status));
  assert.ok(event.schedule.checkin_opens_at_ms < event.schedule.dispute_ends_at_ms);
  for (const [key, ticket] of await view.tickets(0, 0, 10)) {
    assert.ok(key.startsWith("ed25519:"));
    assert.match(ticket.payout_to, /^(near|intents):/);
  }
  assert.equal(await view.standing(0, Ticket.generate().publicKey), null);
});
