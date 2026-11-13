import { useEffect, useRef, useState } from "react";

import { CREATE_EVENT_TGAS, buildEvent, createdEventId, minCheckinMinutes } from "@bail/sdk";

import { useApp } from "../context.tsx";
import { useChainNow, usePoll } from "../hooks.ts";
import { checkArbiter, defaultHostFields, validateHostFields, type HostFields } from "../lib/host-plan.ts";
import { findCreatedEvent, makeHostRecord, type HostRecord, type HostStore, type PendingHost } from "../lib/host-record.ts";
import { formatUnits } from "../lib/money.ts";
import { assertWalletSuccess, hostTransaction } from "../lib/organizer-wallet.ts";
import { HostWallet, RelayerHealth, type HostWalletState } from "./HostCommon.tsx";
import { CopyButton, Notice } from "./common.tsx";
import { Icon } from "./Icon.tsx";

export function CreateEvent({ walletState, store }: { walletState: HostWalletState; store: HostStore }) {
  const { config, view, clock } = useApp();
  const { now, ready, stale } = useChainNow();
  const [fields, setFields] = useState(() => defaultHostFields(Date.now()));
  const [pending, setPending] = useState(() => store.pending(config.contractId));
  const [success, setSuccess] = useState<HostRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [arbiterCheck, setArbiterCheck] = useState<{ account: string; organizer: string; error: string | null } | null>(null);
  const wallet = walletState.wallet;
  const organizer = wallet?.accountId ?? "";
  const arbiter = fields.arbiter.trim();
  const capacity = Number(fields.capacity);
  const limits = usePoll(() => view.config(), 300_000, [view]);
  const storage = usePoll(async () => ({ capacity, cost: Number.isInteger(capacity) && capacity >= 1 && capacity <= 1000 ? await view.storageCost(capacity) : null }), 60_000, [view, capacity]);
  const cost = storage.data?.capacity === capacity ? storage.data.cost : null;
  const set = (key: keyof HostFields, value: string) => setFields((previous) => ({ ...previous, [key]: value, ...(key === "slots" ? { required: value } : {}) }));

  useEffect(() => {
    setArbiterCheck(null);
    if (!arbiter || !organizer) return;
    let active = true;
    const timer = setTimeout(() => {
      void checkArbiter(view, arbiter, organizer).then(
        () => { if (active) setArbiterCheck({ account: arbiter, organizer, error: null }); },
        (error: unknown) => { if (active) setArbiterCheck({ account: arbiter, organizer, error: error instanceof Error ? error.message : "Could not check this arbiter." }); },
      );
    }, 400);
    return () => { active = false; clearTimeout(timer); };
  }, [arbiter, organizer, view]);

  let validation: string | null = null;
  try { if (ready) validateHostFields(fields, config.token, organizer, now, limits.data ?? undefined); }
  catch (error) { validation = error instanceof Error ? error.message : "Check the event rules."; }
  const arbiterOk = arbiterCheck?.account === arbiter && arbiterCheck.organizer === organizer && arbiterCheck.error === null;
  const minimum = Number.isInteger(Number(fields.slots)) && Number(fields.slots) >= 1 && Number(fields.slots) <= 5 && Number.isSafeInteger(Number(fields.windowMinutes)) && Number(fields.windowMinutes) >= 1 ? minCheckinMinutes(Number(fields.slots), Number(fields.windowMinutes)) : null;

  const complete = async (id: number, creation: PendingHost) => {
    const event = await view.event(id);
    if (!event || event.organizer !== creation.organizer || event.schedule.checkin_opens_at_ms !== creation.event.checkin_opens_at_ms) throw new Error("The created event could not be confirmed yet. Use Find my created event to check again.");
    const record = store.get(config.contractId, id) ?? makeHostRecord(config.contractId, id, creation);
    store.save(record);
    store.clearPending(config.contractId);
    setPending(null); setSuccess(record);
  };

  const create = async () => {
    if (!wallet || lock.current || pending) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      // ChainClock interpolates with performance.now(), which can include fractional milliseconds.
      // The contract's schedule fields are integer u64 timestamps.
      const chainNow = Math.floor(await clock.sync());
      const rules = await view.config();
      const plan = validateHostFields(fields, config.token, wallet.accountId, chainNow, rules);
      await checkArbiter(view, plan.arbiter, wallet.accountId);
      const event = buildEvent(plan, chainNow);
      const deposit = await view.storageCost(plan.capacity);
      const creation = { organizer: wallet.accountId, event, title: fields.title.trim(), callUrl: fields.callUrl.trim() };
      store.savePending(config.contractId, creation);
      setPending(creation); setNotFound(false);
      const outcome = await wallet.signAndSendTransaction(hostTransaction(config.contractId, "create_event", { event }, CREATE_EVENT_TGAS, deposit));
      assertWalletSuccess(outcome);
      const id = createdEventId(outcome) ?? await findCreatedEvent(view, wallet.accountId, event.checkin_opens_at_ms, store.lastId(config.contractId));
      if (id === null) throw new Error("No created event was found yet. Check your wallet activity, then use Find my created event.");
      await complete(id, creation);
    } catch (error) { setError(error instanceof Error ? error.message : "The event could not be created. Check your wallet activity before trying again."); }
    finally { lock.current = false; setBusy(false); }
  };

  const recover = async () => {
    if (!pending || lock.current || organizer !== pending.organizer) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const id = await findCreatedEvent(view, pending.organizer, pending.event.checkin_opens_at_ms, store.lastId(config.contractId));
      if (id === null) { setNotFound(true); setError("No matching event is on chain yet. Check your wallet activity before returning to the form."); }
      else await complete(id, pending);
    } catch { setError("The event lookup could not finish. Try finding it again when the chain is reachable."); }
    finally { lock.current = false; setBusy(false); }
  };

  if (success) {
    const link = new URL(window.location.href); link.hash = `#/event/${success.eventId}`;
    return <div className="page host-page"><section className="ticket host-success" aria-labelledby="created-title">
      <div className="ticket-topline"><span>Event #{success.eventId} / Ready to share</span><Icon name="check" /></div>
      <h1 id="created-title">Your event is on.</h1><p>The rules are on chain. Your host codes are saved in this browser.</p>
      <label htmlFor="attendee-link">Attendee link</label><input id="attendee-link" className="input" readOnly value={link.href} />
      <CopyButton text={link.href} label="Copy attendee link" />
      {(success.title || success.callUrl) && <p className="small muted">Your title and call link stay in this browser. Share those details separately; attendees see Event #{success.eventId}.</p>}
      <a className="btn primary" href={`#/event/${success.eventId}/host`}>Open the host screen <Icon name="arrow" /></a>
    </section></div>;
  }

  const numberField = (key: keyof HostFields, label: string, min: number, max?: number) => <div className="field" key={key}><label htmlFor={`host-${key}`}>{label}</label><input id={`host-${key}`} className="input" type="number" min={min} max={max} step="1" required value={fields[key]} onChange={(e) => set(key, e.target.value)} /></div>;

  return <div className="page host-page">
    <header className="host-heading"><p className="eyebrow">For the people bringing people together</p><h1>Make showing up<br /><em>mean something.</em></h1><p>Set the commitment. Share the invitation. Run the codes when your call is ready.</p></header>
    <HostWallet state={walletState} />
    {pending ? <section className="card" aria-labelledby="pending-host-title"><h2 id="pending-host-title">Check your event creation</h2><p>A wallet approval was started for {pending.organizer}. Find that event before sending another creation transaction.</p>
      {organizer !== pending.organizer && <Notice tone="wait">Connect {pending.organizer} to recover this event.</Notice>}
      <button type="button" className="btn primary" disabled={busy || organizer !== pending.organizer} onClick={() => void recover()}>{busy ? "Checking the chain..." : "Find my created event"}</button>
      {notFound && <button type="button" className="btn quiet" disabled={busy} onClick={() => { store.clearPending(config.contractId); setPending(null); setError(null); setNotFound(false); }}>I checked my wallet; return to the form</button>}
    </section> : <form className="host-form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <fieldset disabled={!wallet || busy}>
        <section className="card"><div className="ticket-topline"><span>01 / The commitment</span><Icon name="ticket" /></div><h2>Give your event its rules.</h2>
          <div className="host-form-grid"><div className="field"><label htmlFor="host-startsAt">Check-in starts</label><input id="host-startsAt" className="input" type="datetime-local" required value={fields.startsAt} onChange={(e) => set("startsAt", e.target.value)} /><p className="hint">In your timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). RSVPs close at this time.</p></div>
          {numberField("checkinMinutes", "Check-in length (minutes)", minimum ?? 1)}
          {numberField("slots", "Number of codes", 1, 5)}{numberField("windowMinutes", "Each code is live for (minutes)", 1)}
          <div className="field"><label htmlFor="host-deposit">Deposit (test USDC)</label><input id="host-deposit" className="input" inputMode="decimal" required value={fields.deposit} onChange={(e) => set("deposit", e.target.value)} /></div>
          {numberField("capacity", "Seats", 1, 1000)}</div>
          <p className="small muted">{minimum !== null ? `Allow at least ${minimum} minutes for these code windows. ` : ""}Every code is needed by default. You decide when each opens.</p>
        </section>
        <section className="card"><div className="ticket-topline"><span>02 / An independent arbiter</span><Icon name="shield" /></div>
          <div className="field"><label htmlFor="host-arbiter">Arbiter account</label><input id="host-arbiter" className="input" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={fields.arbiter} onChange={(e) => set("arbiter", e.target.value)} aria-describedby="host-arbiter-hint host-arbiter-check" aria-invalid={!!arbiterCheck?.error} placeholder="your-community.sputnikv2.testnet" />
          <p id="host-arbiter-hint" className="hint">The only account that can void the event and refund everyone, such as your community's Sputnik DAO. It cannot be the organizer.</p>
          <p id="host-arbiter-check" className={`small ${arbiterCheck?.error ? "payout-error" : "muted"}`} role="status">{arbiter && organizer ? arbiterCheck?.error ?? (arbiterOk ? "Account exists on NEAR testnet." : "Checking this arbiter on NEAR testnet...") : "Required before the event can be created."}</p></div>
        </section>
        <details className="disclosure host-advanced"><summary>Advanced rules</summary><div className="host-form-grid">
          {numberField("required", "Codes needed to qualify", 1, Number(fields.slots))}
          {numberField("cancelBeforeMinutes", "Free cancellation ends before check-in (minutes)", 0)}
          {numberField("revealMinutes", "Reveal period after check-in (minutes)", 1)}{numberField("disputeMinutes", "Dispute period (minutes)", 1)}
          <p className="small muted host-wide">Requiring fewer codes means anyone who has caught enough can leave early. Require every code to keep the commitment through the call.</p>
        </div></details>
        <section className="card"><p className="eyebrow">Optional / Only on this device</p><h2>A name and a meeting place.</h2><p className="small muted">The contract stores no titles or call links. These stay only in this browser. Share them with your invitation; attendees see Event #N.</p>
          <div className="field"><label htmlFor="host-title">Event title (optional)</label><input id="host-title" className="input" maxLength={120} value={fields.title} onChange={(e) => set("title", e.target.value)} /></div>
          <div className="field"><label htmlFor="host-callUrl">Call link (optional)</label><input id="host-callUrl" className="input" type="url" value={fields.callUrl} onChange={(e) => set("callUrl", e.target.value)} placeholder="https://meet.google.com/..." /></div>
        </section>
        <section className="host-create-total card"><p className="eyebrow">One wallet approval</p><h2>{cost ? `${formatUnits(cost, 24)} NEAR` : "Reading storage cost..."}</h2><p className="small muted">Event storage for {fields.capacity || "your"} seats, most of it returned when the event closes. Your wallet also pays transaction fees.</p>
          {validation && <p className="small payout-error" role="status">{validation}</p>}
          {(!ready || stale) && <p className="small muted">Waiting for current chain time before creating the event.</p>}
          <button className="btn primary" type="submit" disabled={!wallet || busy || !ready || stale || !limits.data || !!limits.error || !cost || !!storage.error || !!validation || !arbiterOk}>{busy ? "Waiting for your wallet..." : "Create event"}<Icon name="arrow" /></button>
        </section>
      </fieldset>
    </form>}
    {error && <Notice tone="bad" title="Event creation needs a check">{error}</Notice>}
    {(storage.error || limits.error) && <div className="notice wait"><p>The event rules or storage quote could not be read.</p><button className="btn quiet" type="button" onClick={() => { void storage.refresh(); void limits.refresh(); }}>Retry event rules</button></div>}
    <RelayerHealth />
  </div>;
}
