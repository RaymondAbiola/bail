import { useMemo, useState } from "react";

import { type Event, Ticket, isAccountId, isPayoutAddress } from "@bail/sdk";

import { useApp } from "../context.tsx";
import { useChainNow, useStoredTicket } from "../hooks.ts";
import { formatUsdc } from "../lib/money.ts";
import { type RsvpOutcome, RsvpError, type RsvpStep, confirmSeat, runRsvp } from "../lib/rsvp.ts";
import { rsvpBlock } from "../lib/rules.ts";
import type { StoredTicket } from "../lib/storage.ts";
import { KeyBackup } from "./KeyBackup.tsx";
import { OtherChain } from "./OtherChain.tsx";
import { Notice, TxLink, formatWhen, useAction } from "./common.tsx";

export const BLOCK_COPY = {
  "not-found": "This event does not exist.",
  cancelled: "This event was cancelled. No RSVPs are being taken, and every deposit is refunded.",
  voided: "This event was voided. No RSVPs are being taken, and every deposit is refunded.",
  closed: "This event is closed.",
  "rsvp-closed": "RSVPs have closed for this event.",
  full: "This event is full.",
} as const;

const STEP_LABEL: Record<RsvpStep, string> = {
  checking: "Checking your ticket",
  funding: "Getting your test USDC",
  "waiting-for-funds": "Waiting for the test USDC to arrive",
  signing: "Signing your deposit on this device",
  submitting: "Sending your deposit to Bail",
  confirming: "Confirming your seat",
};
const STEP_ORDER: RsvpStep[] = ["checking", "funding", "waiting-for-funds", "signing", "submitting", "confirming"];

export function RsvpFlow({ eventId, event }: { eventId: number; event: Event }) {
  const { now } = useChainNow();
  const { stored, save, update } = useStoredTicket(eventId);
  const block = rsvpBlock(event, now);

  if (stored?.stage === "seated") {
    return (
      <section className="card" aria-labelledby="done-title">
        <span className="eyebrow">Step 3 of 3 · Event #{eventId} · Testnet</span>
        <h2 id="done-title">You're in</h2>
        <Notice tone="good" title="Seat confirmed">
          Your deposit of {formatUsdc(event.deposit)} is held by Bail. Keep your ticket key safe, and open this page when check-in begins.{" "}
          <TxLink tx={stored.rsvpTx} />
        </Notice>
        <a className="btn primary block" href={`#/event/${eventId}`}>Open my ticket</a>
      </section>
    );
  }
  if (block && !stored) {
    return (
      <section className="card">
        <h2>RSVP is not available</h2>
        <Notice tone="wait" title="Not taking RSVPs">{BLOCK_COPY[block]}</Notice>
        <a className="btn" href={`#/event/${eventId}`}>Back to the event</a>
      </section>
    );
  }
  if (!stored) return <Terms eventId={eventId} event={event} onCreate={save} />;
  if (!stored.backedUp) {
    return (
      <Backup
        eventId={eventId}
        backup={stored.backup}
        onConfirmed={() => update((t) => ({ ...t, backedUp: true }))}
      />
    );
  }
  return <Pay eventId={eventId} event={event} stored={stored} markSeated={(tx) => update((t) => ({ ...t, stage: "seated", rsvpTx: tx ?? t.rsvpTx }))} blocked={block} />;
}

function Terms({ eventId, event, onCreate }: { eventId: number; event: Event; onCreate: (t: StoredTicket) => void }) {
  const [own, setOwn] = useState(false);
  const [account, setAccount] = useState("");
  const [agree, setAgree] = useState(false);
  const accountOk = !own || (isAccountId(account.trim()) && isPayoutAddress(`near:${account.trim()}`, { intents: false }));
  const s = event.schedule;

  const create = () => {
    const ticket = Ticket.generate();
    onCreate({
      version: 1,
      backup: ticket.backup(),
      publicKey: ticket.publicKey,
      payoutTo: own ? `near:${account.trim()}` : `near:${ticket.accountId}`,
      createdAt: Date.now(),
      backedUp: false,
      stage: "created",
      submissions: {},
    });
  };

  return (
    <div className="column">
      <section className="card" aria-labelledby="terms-title">
        <span className="eyebrow">Step 1 of 3 · Event #{eventId} · Testnet</span>
        <h2 id="terms-title">Before you pay</h2>
        <ul className="steps">
          <li><span className="mark done" aria-hidden="true">1</span><span>You put down <strong>{formatUsdc(event.deposit)}</strong>. The app gets the test USDC for you, so you need no wallet and no NEAR.</span></li>
          <li><span className="mark done" aria-hidden="true">2</span><span>If you catch {event.checkin.required} of the {event.checkin.slots} live codes, you get at least your deposit back, plus a share of what people forfeit.</span></li>
          <li><span className="mark done" aria-hidden="true">3</span><span>If you don't, you forfeit it to those who did. If you change your mind, cancel before <strong>{formatWhen(s.cancel_cutoff_ms)}</strong> for a full refund.</span></li>
        </ul>
        <p>
          The arbiter is <strong>{event.arbiter}</strong>. It can void the event, which refunds everyone. It cannot choose who attended. If the event is cancelled or voided, or nobody attends, every deposit goes back.
        </p>
      </section>

      <section className="card" aria-labelledby="payout-title">
        <h3 id="payout-title">Where your payout goes</h3>
        <p className="small muted">This is fixed when you RSVP and cannot be changed afterwards.</p>
        <label className="check">
          <input type="radio" name="payout" checked={!own} onChange={() => setOwn(false)} />
          <span>
            <strong>My ticket's own testnet account</strong> (default). It is controlled by the ticket key you are about to save. This app has no withdrawal feature, so moving tokens out later needs compatible tools and some testnet NEAR for fees.
          </span>
        </label>
        <label className="check">
          <input type="radio" name="payout" checked={own} onChange={() => setOwn(true)} />
          <span><strong>My own NEAR testnet account</strong></span>
        </label>
        {own && (
          <div className="field">
            <label htmlFor="account">NEAR testnet account name</label>
            <input
              id="account" className="input" value={account} onChange={(e) => setAccount(e.target.value)}
              placeholder="yourname.testnet" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              aria-invalid={!accountOk}
            />
            {!accountOk && <p className="hint" role="status">That is not a valid account name. Use lowercase letters, digits, dots, dashes and underscores.</p>}
            <p className="hint">The account must be registered with test USDC to receive it, or the payout will be held as owed until it is.</p>
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>I understand these are test tokens, the payout address is fixed, and I may forfeit the deposit.</span>
        </label>
        <button type="button" className="btn primary block" disabled={!agree || !accountOk} onClick={create}>
          Create my ticket key
        </button>
      </section>
      <OtherChain />
    </div>
  );
}

function Backup({ eventId, backup, onConfirmed }: { eventId: number; backup: string; onConfirmed: () => void }) {
  const { store } = useApp();
  const [ack, setAck] = useState(false);
  return (
    <section className="card" aria-labelledby="backup-title">
      <span className="eyebrow">Step 2 of 3 · Event #{eventId} · Testnet</span>
      <h2 id="backup-title">Save your ticket key</h2>
      <Notice tone="wait" title="This key is your ticket">
        Save it somewhere private. Losing it can stop you checking in or cancelling. Anyone who has it can act as your ticket, so do not share it. It stays on this device and is never sent anywhere.
      </Notice>
      {store.memoryOnly && (
        <Notice tone="bad" title="This browser will not keep your key">
          Storage is blocked here, so the key is only held until you close or reload this page. Saving it now matters even more.
        </Notice>
      )}
      <KeyBackup backup={backup} eventId={eventId} />
      <label className="check">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I saved my ticket key somewhere private.</span>
      </label>
      <button type="button" className="btn primary block" disabled={!ack} onClick={onConfirmed}>
        Continue to payment
      </button>
    </section>
  );
}

type Result =
  | { kind: "idle" }
  | { kind: "error"; message: string }
  | { kind: "outcome"; outcome: RsvpOutcome };

function Pay({
  eventId, event, stored, markSeated, blocked,
}: { eventId: number; event: Event; stored: StoredTicket; markSeated: (tx?: string) => void; blocked: ReturnType<typeof rsvpBlock> }) {
  const { view, relayer, config } = useApp();
  const [step, setStep] = useState<RsvpStep | null>(null);
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const ticket = useMemoTicket(stored.backup);
  const deps = { view, relayer, contractId: config.contractId };

  const pay = useAction(async () => {
    setResult({ kind: "idle" });
    try {
      const outcome = await runRsvp(deps, { eventId, event, ticket, payoutTo: stored.payoutTo }, setStep);
      if (outcome.kind === "seated") markSeated(outcome.tx);
      setResult({ kind: "outcome", outcome });
    } catch (error) {
      setResult({ kind: "error", message: error instanceof RsvpError ? error.message : error instanceof Error ? error.message : "Something went wrong." });
    } finally {
      setStep(null);
    }
  });

  const check = useAction(async () => {
    const seated = await confirmSeat(deps, eventId, ticket.publicKey, 3, 1000);
    if (seated) {
      markSeated();
      setResult({ kind: "outcome", outcome: { kind: "seated" } });
    }
    return seated;
  });

  const outcome = result.kind === "outcome" ? result.outcome : null;

  return (
    <section className="card" aria-labelledby="pay-title">
      <span className="eyebrow">Step 3 of 3 · Event #{eventId} · Testnet</span>
      <h2 id="pay-title">Pay your deposit</h2>
      <dl className="facts">
        <div><dt>Deposit</dt><dd>{formatUsdc(event.deposit)}</dd></div>
        <div><dt>Arbiter</dt><dd>{event.arbiter}</dd></div>
        <div className="wide"><dt>Payout goes to</dt><dd>{stored.payoutTo}</dd></div>
      </dl>
      {blocked && (
        <Notice tone="wait" title="Not taking RSVPs">{BLOCK_COPY[blocked as keyof typeof BLOCK_COPY]} Nothing will be sent.</Notice>
      )}

      {step && (
        <ol className="steps" aria-live="polite" aria-label="Progress">
          {STEP_ORDER.map((s, i) => {
            const at = STEP_ORDER.indexOf(step);
            return (
              <li key={s}>
                <span className={`mark ${i < at ? "done" : i === at ? "now" : ""}`} aria-hidden="true">{i < at ? "✓" : i + 1}</span>
                <span>{STEP_LABEL[s]}{i === at ? "..." : ""}</span>
              </li>
            );
          })}
        </ol>
      )}

      {result.kind === "error" && <Notice tone="bad" title="Nothing was spent">{result.message} Your ticket key is saved, so you can try again.</Notice>}
      {outcome?.kind === "not-seated" && (
        <Notice tone="bad" title="Your deposit did not get a seat">
          The deposit reached Bail but no seat was made, for example because the event filled up or closed just then. It is owed back to {stored.payoutTo}
          {outcome.owed !== "0" ? ` (${formatUsdc(outcome.owed)} owed)` : ""}. This does not mean it has been paid yet. <TxLink tx={outcome.tx} />
        </Notice>
      )}
      {outcome?.kind === "unknown" && (
        <Notice tone="wait" title="We can't tell yet">
          Your payment may or may not have gone through. Do not pay again. Check again in a moment: the chain decides. Your ticket key is saved.
        </Notice>
      )}
      {check.error && <Notice tone="bad">{check.error.message}</Notice>}
      {check.done && outcome?.kind === "unknown" && <p className="small muted">Still no seat on the chain. If you just paid, wait a minute and check again.</p>}

      <div className="actions">
        {outcome?.kind === "unknown" ? (
          <>
            <button type="button" className="btn primary block" disabled={check.pending} onClick={() => void check.run()}>
              {check.pending ? "Checking..." : "Check again"}
            </button>
            <button type="button" className="btn quiet" disabled={pay.pending || check.pending} onClick={() => void pay.run()}>
              Still nothing? Try sending again (it reads the chain first, so it can't pay twice)
            </button>
          </>
        ) : (
          <button type="button" className="btn primary block" disabled={pay.pending || !!blocked || outcome?.kind === "not-seated"} onClick={() => void pay.run()}>
            {pay.pending ? "Working..." : result.kind === "error" ? "Try again" : `Pay ${formatUsdc(event.deposit)} and RSVP`}
          </button>
        )}
      </div>
    </section>
  );
}

function useMemoTicket(backup: string): Ticket {
  return useMemo(() => Ticket.restore(backup), [backup]);
}
