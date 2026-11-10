import { useEffect, useMemo, useRef, useState } from "react";

import { type Event, type Ticket, type TicketRecord, normalizeCode, suggestWords, wordlist } from "@bail/sdk";

import { useApp } from "../context.tsx";
import { attemptLanded, nextAttempt } from "../lib/attempts.ts";
import { describeError } from "../lib/errors.ts";
import { canFlag, hasFlagged } from "../lib/rules.ts";
import { slotWindowEnd } from "../lib/slots.ts";
import type { StoredTicket } from "../lib/storage.ts";
import { Notice, TxLink, formatCountdown, useAction } from "./common.tsx";
import { TicketCodeStrip } from "./CodeStrip.tsx";
import { Icon } from "./Icon.tsx";

const WORDS = 5;
const words = new Set(wordlist);

type Sent =
  | { state: "none" }
  | { state: "sent"; attempt: number; tx: string }
  | { state: "unsure"; attempt: number }
  | { state: "refused"; message: string };

export interface LiveCodeProps {
  eventId: number;
  event: Event;
  slot: number;
  now: number;
  ticket: Ticket;
  chain: TicketRecord | null;
  stored: StoredTicket;
  saveSubmission: (slot: number, attempt: number, code: string) => void;
  onChanged: () => void;
}

export function LiveCode({ eventId, event, slot, now, ticket, chain, stored, saveSubmission, onChanged }: LiveCodeProps) {
  const { view, relayer, clock, config } = useApp();
  const [text, setText] = useState("");
  const [sent, setSent] = useState<Sent>({ state: "none" });
  const input = useRef<HTMLInputElement>(null);

  const windowEnd = slotWindowEnd(event, slot) ?? now;
  const remaining = windowEnd - now;
  const closed = remaining <= 0;
  const previous = stored.submissions[slot];
  const onChain = chain?.catches[slot] ?? null;
  const hasPrevious = !!(onChain || previous);

  const normalized = useMemo(() => normalizeCode(text), [text]);
  const wordList = normalized ? normalized.split(" ") : [];
  const typing = text.length > 0 && !/\s$/.test(text);
  const partial = typing ? (wordList[wordList.length - 1] ?? "") : "";
  const suggestions = useMemo(() => (partial ? suggestWords(partial, 5).filter((w) => w !== partial) : []), [partial]);
  // A finished word that isn't on the list is probably a typo. It is only a hint: the host's code decides.
  const unknown = wordList.filter((w, i) => !(typing && i === wordList.length - 1) && !words.has(w));

  const submit = useAction(async () => {
    if (!normalized) throw new Error("Type the code first.");
    let fresh: TicketRecord | null;
    try {
      fresh = await view.ticket(eventId, ticket.publicKey);
    } catch {
      throw new Error("Could not check your earlier attempts, so nothing was sent. Try again.");
    }
    const attempt = nextAttempt(fresh, slot, stored.submissions);
    try {
      const { tx } = await relayer.submit(ticket.catch(config.contractId, eventId, slot, attempt, normalized));
      saveSubmission(slot, attempt, normalized);
      setSent({ state: "sent", attempt, tx });
      onChanged();
    } catch (error) {
      const described = describeError(error);
      if (described.kind === "network") {
        // The request may have been received. Remember the attempt so the next one is higher.
        saveSubmission(slot, attempt, normalized);
        setSent({ state: "unsure", attempt });
        return;
      }
      setSent({ state: "refused", message: described.message });
    }
  });

  // An unsure attempt is settled by the chain, not by guessing.
  useEffect(() => {
    if (sent.state === "unsure" && attemptLanded(chain, slot, sent.attempt)) {
      setSent({ state: "sent", attempt: sent.attempt, tx: "" });
    }
  }, [chain, slot, sent]);

  const chooseSuggestion = (word: string) => {
    const head = text.replace(/\S*$/, "");
    setText(`${head}${word} `);
    input.current?.focus();
  };

  const wordNote =
    wordList.length === WORDS ? `${WORDS} of ${WORDS} words` : `${wordList.length} of ${WORDS} words`;

  return (
    <section className="ticket live-card slot-in" aria-labelledby="live-title">
      <div className="ticket-topline"><span>Your live ticket</span><span>Event #{eventId}</span></div>
      <div className="live-banner"><span className="live-dot" /><h2 id="live-title">Code {slot + 1} of {event.checkin.slots} is live</h2></div>
      <div className="live-head">
        <p className="live-title">Catch this moment.</p>
        {closed ? (
          <p className="notice wait" role="status">
            <strong>Window closed.</strong> Edits can no longer be sent. Your last submission is kept below.
          </p>
        ) : (
          <p aria-live="off">
            <span className="countdown" aria-hidden="true">{formatCountdown(remaining)}</span>
            <span className="visually-hidden">About {Math.ceil(remaining / 1000)} seconds left</span>
            <span className="small"> left</span>
          </p>
        )}
      </div>
        {clock.stale && !closed && (
          <p className="hint">
            Your time reading is out of date, so this countdown may be off.{" "}
            <button type="button" className="btn quiet" onClick={() => void clock.sync()}>Refresh time</button>
          </p>
        )}

      {!closed && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit.run();
          }}
          className="actions"
          noValidate
        >
          <div className="field">
            <label htmlFor="code">Enter the five words the host shares</label>
            <input
              id="code"
              ref={input}
              className="code-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="send"
              inputMode="text"
              aria-describedby="code-hint"
            />
            <p id="code-hint" className="hint word-count" aria-live="polite">
              {wordNote}. Capitals and spacing don't matter.
            </p>
          </div>

          {suggestions.length > 0 && (
            <ul className="suggestions" aria-label="Word suggestions">
              {suggestions.map((word) => (
                <li key={word}>
                  <button
                    type="button"
                    className="suggest"
                    // Keep the keyboard open: tapping a suggestion must not take focus from the input.
                    onPointerDown={(e) => e.preventDefault()}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chooseSuggestion(word)}
                  >
                    {word}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {unknown.length > 0 && (
            <p className="hint" role="status">
              Check the spelling of {unknown.map((w) => `"${w}"`).join(", ")}. It is not on the word list. You can still send it.
            </p>
          )}

          {hasPrevious && (
            <p className="hint">
              Sending again replaces your earlier submission for this code. The last one the chain accepts is the one that counts.
            </p>
          )}

          <button type="submit" className="btn primary block" disabled={submit.pending || !normalized}>
            {submit.pending ? "Sending..." : hasPrevious ? "Resubmit corrected code" : "Send code"} <Icon name="arrow" />
          </button>
          <p className="send-explainer">Sent first. Confirmed after reveal.</p>
        </form>
      )}

      <div aria-live="polite" className="actions">
        {submit.error && <Notice tone="bad" title="Not sent">{submit.error.message}</Notice>}
        {sent.state === "sent" && (
          <Notice tone="good" title="Sent">
            Confirmation comes after the host reveals the code. {sent.tx ? <TxLink tx={sent.tx} /> : null}
          </Notice>
        )}
        {sent.state === "unsure" && (
          <Notice tone="wait" title="Not confirmed yet">
            We could not tell whether your code reached the chain. We are checking. What you typed is still here, and you can send it again while the window is open.
          </Notice>
        )}
        {sent.state === "refused" && (
          <Notice tone="bad" title="The code was refused">
            {sent.message} Your earlier submission, if you had one, is unchanged.
          </Notice>
        )}
        {(onChain || previous) && (
          <p className="small muted">
            {onChain ? `On the chain: attempt ${onChain.attempt}.` : "Nothing from this code is on the chain yet."}
            {previous ? ` Last sent from this device: "${previous.code}".` : ""}
          </p>
        )}
      </div>

      <div className="ticket-tear" aria-hidden="true" />
      <TicketCodeStrip event={event} eventId={eventId} now={now} chain={chain} contractId={config.contractId} ticketKey={ticket.publicKey} />
      <FlagAction eventId={eventId} event={event} slot={slot} now={now} ticket={ticket} chain={chain} onChanged={onChanged} />
    </section>
  );
}

/** The host never showed a code. This records evidence for the arbiter; it refunds no one by itself. */
export function FlagAction({
  eventId, event, slot, now, ticket, chain, onChanged,
}: { eventId: number; event: Event; slot: number; now: number; ticket: Ticket; chain: TicketRecord | null; onChanged: () => void }) {
  const { relayer, config } = useApp();
  const [sure, setSure] = useState(false);
  const flag = useAction(async () => {
    await relayer.submit(ticket.flag(config.contractId, eventId, slot));
    onChanged();
  });

  if (hasFlagged(chain, slot)) return <p className="small muted">You told the arbiter no code was shown for this slot.</p>;
  if (!canFlag(event, slot, chain, now)) return null;

  return (
    <details className="disclosure">
      <summary>The host did not show a code</summary>
      <div>
        <p>
          Use this only if you were on the call and no code appeared for this slot. It records evidence for the arbiter,{" "}
          {event.arbiter}. It does not refund anyone by itself.
        </p>
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          <span>I was on the call and no code was shown for code {slot + 1}.</span>
        </label>
        {flag.error && <Notice tone="bad">{flag.error.message}</Notice>}
        {flag.done && <Notice tone="good" title="Recorded">The arbiter can see your flag.</Notice>}
        <button type="button" className="btn danger" disabled={!sure || flag.pending || flag.done} onClick={() => void flag.run()}>
          {flag.pending ? "Sending..." : "Send flag"}
        </button>
      </div>
    </details>
  );
}
