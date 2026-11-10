import { useState } from "react";

import { type Event, type Standing, type Ticket, type TicketRecord, decodePublicKey } from "@bail/sdk";

import { useApp } from "../context.tsx";
import { VOUCHES_NEEDED, canVouch, inDisputeWindow } from "../lib/rules.ts";
import { CopyButton, Notice, useAction } from "./common.tsx";

/** Vouching for someone whose phone died. Uses their public ticket key, never their secret. */
export function VouchPanel({
  eventId, event, now, ticket, chain, standing, onChanged,
}: { eventId: number; event: Event; now: number; ticket: Ticket; chain: TicketRecord | null; standing: Standing | null; onChanged: () => void }) {
  const { view, relayer, config } = useApp();
  const [target, setTarget] = useState("");

  const vouch = useAction(async () => {
    const key = target.trim();
    try {
      decodePublicKey(key);
    } catch {
      throw new Error("That is not a ticket key. A ticket's public key starts with ed25519: and is safe to share.");
    }
    if (key === ticket.publicKey) throw new Error("You can't vouch for yourself.");
    const [theirs, their] = await Promise.all([view.ticket(eventId, key), view.standing(eventId, key)]);
    if (!theirs) throw new Error("No ticket with that key has a seat in this event.");
    if (their?.attended) throw new Error("That person already attended, so they don't need a vouch.");
    await relayer.submit(ticket.vouch(config.contractId, eventId, key));
    onChanged();
  });

  if (chain?.vouched_for) {
    return <p className="small muted">You vouched for {chain.vouched_for}. Each attendee can vouch for one person.</p>;
  }
  if (!canVouch(event, chain, standing, now)) return null;

  return (
    <section className="card" aria-labelledby="vouch-title">
      <h3 id="vouch-title">Vouch for someone whose phone died</h3>
      <p>
        You attended, so you can vouch for one person who did not. A ticket needs {VOUCHES_NEEDED} vouches. A vouched ticket gets its deposit back, without the bonus. Ask them for their ticket's public key. Never ask for their secret backup.
      </p>
      <div className="field">
        <label htmlFor="target">Their public ticket key</label>
        <input id="target" className="input" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="ed25519:..." autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </div>
      {vouch.error && <Notice tone="bad">{vouch.error.message}</Notice>}
      {vouch.done && <Notice tone="good" title="Vouch recorded">The chain accepted it.</Notice>}
      <button type="button" className="btn primary" disabled={!target.trim() || vouch.pending || vouch.done} onClick={() => void vouch.run()}>
        {vouch.pending ? "Sending..." : "Vouch for this person"}
      </button>
    </section>
  );
}

/** For someone who did not qualify: their public key, to share with attendees who can vouch. */
export function AskForVouch({ event, now, ticket, standing }: { event: Event; now: number; ticket: Ticket; standing: Standing | null }) {
  if (!inDisputeWindow(event, now) || !standing || !standing.is_final || standing.attended) return null;
  return (
    <section className="card" aria-labelledby="ask-title">
      <h3 id="ask-title">Phone died or missed the codes?</h3>
      <p>
        Two attendees can each vouch for you during the dispute window. Share your public ticket key with them. It is safe to share: it lets them vouch, and nothing else. {standing.vouches} of {VOUCHES_NEEDED} vouches so far.
      </p>
      <div className="key-box">{ticket.publicKey}</div>
      <CopyButton text={ticket.publicKey} label="Copy public key" done="Copied" />
    </section>
  );
}
