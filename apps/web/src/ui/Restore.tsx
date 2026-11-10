import { useState } from "react";

import { Ticket } from "@bail/sdk";

import { useApp } from "../context.tsx";
import { useStoredTicket } from "../hooks.ts";
import { Notice, useAction } from "./common.tsx";

type Found = { ticket: Ticket; seated: boolean; payoutTo: string };

/** Puts a saved ticket key back in this browser, after checking it against the chain. */
export function RestoreForm({ eventId }: { eventId: number }) {
  const { view } = useApp();
  const { stored, save } = useStoredTicket(eventId);
  const [text, setText] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [replace, setReplace] = useState(false);

  const check = useAction(async () => {
    setFound(null);
    let ticket: Ticket;
    try {
      ticket = Ticket.restore(text);
    } catch {
      throw new Error("That is not a valid ticket key. Paste the whole key, starting with ed25519:");
    }
    const record = await view.ticket(eventId, ticket.publicKey);
    setFound({ ticket, seated: !!record, payoutTo: record?.payout_to ?? `near:${ticket.accountId}` });
  });

  const differs = !!stored && !!found && stored.publicKey !== found.ticket.publicKey;
  const keep = () => {
    if (!found) return;
    save({
      version: 1,
      backup: found.ticket.backup(),
      publicKey: found.ticket.publicKey,
      payoutTo: found.payoutTo,
      createdAt: Date.now(),
      backedUp: true,
      stage: found.seated ? "seated" : "created",
      submissions: {},
    });
    window.location.hash = `#/event/${eventId}`;
  };

  return (
    <section className="card" aria-labelledby="restore-title">
      <h2 id="restore-title">Restore my ticket</h2>
      <p className="muted">Paste the ticket key you saved. It is checked on this device and against the public chain, and is never sent anywhere.</p>
      <div className="field">
        <label htmlFor="key">Ticket key</label>
        <textarea
          id="key" className="textarea" value={text} onChange={(e) => { setText(e.target.value); setFound(null); }}
          autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="ed25519:..."
        />
      </div>
      {check.error && <Notice tone="bad">{check.error.message}</Notice>}
      {found?.seated && (
        <Notice tone="good" title="This key has a seat in this event">
          It will be saved in this browser as your ticket for event #{eventId}.
        </Notice>
      )}
      {found && !found.seated && (
        <Notice tone="wait" title="This key has no seat in this event">
          It may belong to another event, or its RSVP never finished. You can keep it here to finish an unfinished RSVP, but it will not be shown as registered.
        </Notice>
      )}
      {differs && (
        <>
          <Notice tone="bad" title="This replaces the ticket saved here">
            This browser already holds a different ticket key for this event. Make sure that one is backed up first, because it will be removed from here.
          </Notice>
          <label className="check">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            <span>I have backed up the other key and want to replace it.</span>
          </label>
        </>
      )}
      <div className="actions row">
        {!found ? (
          <button type="button" className="btn primary" disabled={!text.trim() || check.pending} onClick={() => void check.run()}>
            {check.pending ? "Checking..." : "Check this key"}
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={differs && !replace} onClick={keep}>
            {found.seated ? "Use this ticket" : "Keep this key for this event"}
          </button>
        )}
        <a className="btn" href={`#/event/${eventId}`}>Back</a>
      </div>
    </section>
  );
}

