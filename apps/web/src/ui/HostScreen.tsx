import { useCallback, useEffect, useRef, useState } from "react";

import { HOST_TGAS, nextCode, openSlotArgs, revealArgs, revealableSlots } from "@bail/sdk";

import { useApp } from "../context.tsx";
import { useChainNow, usePoll } from "../hooks.ts";
import { confirmHostWalletAction } from "../lib/host-confirmation.ts";
import { recoverUnopenedCodes, type HostStore } from "../lib/host-record.ts";
import { matchingHostCode, relayHostReveal } from "../lib/host-reveal.ts";
import { hostTransaction } from "../lib/organizer-wallet.ts";
import { HostWallet, RelayerHealth, type HostWalletState } from "./HostCommon.tsx";
import { CopyButton, Notice, Skeleton, formatClock, formatCountdown, formatWhen } from "./common.tsx";
import { Icon } from "./Icon.tsx";

export function HostScreen({ id, store, walletState }: { id: number; store: HostStore; walletState: HostWalletState }) {
  const { config, view, clock } = useApp();
  const { now, ready, stale } = useChainNow();
  const read = usePoll(() => view.event(id), 5000, [view, id]);
  const event = read.data;
  const [record, setRecord] = useState(() => store.get(config.contractId, id));
  const [error, setError] = useState<string | null>(null);
  const [walletWorking, setWalletWorking] = useState(false);
  const [walletChecking, setWalletChecking] = useState(false);
  const walletLock = useRef(false);
  const [reveals, setReveals] = useState<Record<number, "sending" | "checking" | "sent" | "failed">>({});
  const attempted = useRef(new Set<number>());
  const sending = useRef(new Set<number>());
  const wallet = walletState.wallet;
  const ownsEvent = !!wallet && wallet.accountId === event?.organizer;
  const validRecord = record && record.organizer === event?.organizer && record.codes.length === event.checkin.slots && record.codes.slice(event.slots.length).every((code) => code !== null) ? record : null;

  const revealSlot = useCallback(async (slot: number, withWallet = false) => {
    const code = record?.codes[slot];
    if (!code || sending.current.has(slot) || (withWallet && (!wallet || walletLock.current))) return;
    sending.current.add(slot);
    attempted.current.add(slot);
    if (withWallet) { walletLock.current = true; setWalletWorking(true); }
    setReveals((previous) => ({ ...previous, [slot]: "sending" }));
    try {
      // Re-check immediately before releasing a secret, including on retries and reloads.
      const [fresh, chainNow] = await Promise.all([view.event(id), clock.sync()]);
      if (!fresh || !matchingHostCode(config.contractId, id, fresh, slot, code)) throw new Error("Code unavailable");
      if (fresh.slots[slot]!.revealed === null) {
        if (!revealableSlots(fresh, chainNow).includes(slot)) throw new Error("Reveal not allowed yet");
        if (withWallet && wallet) {
          await confirmHostWalletAction(
            () => wallet.signAndSendTransaction(hostTransaction(config.contractId, "reveal", revealArgs(id, slot, code), HOST_TGAS)),
            async () => {
              const confirmed = await view.event(id);
              return confirmed && matchingHostCode(config.contractId, id, confirmed, slot, code) && confirmed.slots[slot]!.revealed !== null ? true : null;
            },
            () => { setWalletChecking(true); setReveals((previous) => ({ ...previous, [slot]: "checking" })); },
          );
        } else await relayHostReveal(config.relayerUrl, id, slot, code);
      }
      setReveals((previous) => ({ ...previous, [slot]: "sent" }));
      await read.refresh();
    } catch {
      setReveals((previous) => ({ ...previous, [slot]: "failed" }));
    } finally {
      sending.current.delete(slot);
      if (withWallet) { walletLock.current = false; setWalletWorking(false); setWalletChecking(false); }
    }
  }, [record, wallet, view, clock, id, config.contractId, config.relayerUrl, read.refresh]);

  useEffect(() => {
    if (!event || !validRecord || !ready || stale || event.status !== "Active") return;
    for (const slot of revealableSlots(event, now)) {
      if (!attempted.current.has(slot) && matchingHostCode(config.contractId, id, event, slot, validRecord.codes[slot])) void revealSlot(slot);
    }
  }, [event, validRecord, ready, stale, now, config.contractId, id, revealSlot]);

  const open = async () => {
    if (!wallet || !validRecord || walletLock.current) return;
    walletLock.current = true; setWalletWorking(true); setWalletChecking(false); setError(null);
    try {
      const [fresh, chainNow] = await Promise.all([view.event(id), clock.sync()]);
      if (!fresh || fresh.organizer !== wallet.accountId || fresh.status !== "Active" || fresh.closed) throw new Error("Connect the event's organizer wallet to open a code.");
      const next = nextCode(fresh, chainNow);
      if (next.state !== "ready") throw new Error("The next code cannot open yet. Refresh the event to check its timing.");
      const code = validRecord.codes[next.slot];
      if (!code) throw new Error("This device does not hold that code.");
      // Keep this slot fixed while reconciling; a later poll may already show another next code.
      const slot = fresh.slots.length;
      await confirmHostWalletAction(
        () => wallet.signAndSendTransaction(hostTransaction(config.contractId, "open_slot", openSlotArgs(config.contractId, id, slot, code), HOST_TGAS)),
        async () => {
          const confirmed = await view.event(id);
          return confirmed && matchingHostCode(config.contractId, id, confirmed, slot, code) ? true : null;
        },
        () => setWalletChecking(true),
      );
    } catch (error) { setError(error instanceof Error ? error.message : "Opening was not confirmed. Refresh before trying again."); }
    finally { await read.refresh(); walletLock.current = false; setWalletWorking(false); setWalletChecking(false); }
  };

  const recover = () => {
    if (!event || !ownsEvent) return;
    try { const recovered = recoverUnopenedCodes(config.contractId, id, event); store.save(recovered); setRecord(recovered); setError(null); }
    catch (error) { setError(error instanceof Error ? error.message : "The host record could not be saved."); }
  };

  if (read.loading && !event) return <div className="page"><Skeleton block label="Loading the host's event" /></div>;
  if (!event) return <div className="page host-page"><Notice tone="bad" title={read.error ? "Could not read the event" : `Event #${id} not found`}>Check the event number and try again.</Notice><button type="button" className="btn primary" onClick={() => void read.refresh()}>Retry event</button></div>;

  const next = nextCode(event, now);
  const liveSlot = ready ? event.slots.findIndex((slot) => now >= slot.opened_at_ms && now < slot.opened_at_ms + event.checkin.window_ms) : -1;
  const liveCode = validRecord?.codes[liveSlot];
  const showCode = event.status === "Active" && matchingHostCode(config.contractId, id, event, liveSlot, liveCode);
  const canOpen = next.state === "ready" && ownsEvent && !!validRecord && !!validRecord.codes[next.slot] && !walletWorking && ready && !stale && !read.error && event.status === "Active" && !event.closed;
  const afterCheckin = ready && now >= event.schedule.checkin_closes_at_ms;
  const allRevealed = event.slots.length === event.checkin.slots && event.slots.every((slot) => slot.revealed !== null);

  return <div className="page host-page">
    <header className="host-heading"><p className="eyebrow">Host screen / Event #{id}</p><h1>{validRecord?.title || `Your event, #${id}.`}</h1><p>You run the call. Bail keeps the commitment.</p></header>
    <HostWallet state={walletState} />
    {walletChecking && <p className="small muted" role="status">Checking the chain...</p>}
    {wallet && !ownsEvent && <Notice tone="wait">This event belongs to {event.organizer}. Connect that account to open codes.</Notice>}
    {read.error && <Notice tone="wait" title="Showing the last event read">The latest refresh failed. <button type="button" className="btn quiet" onClick={() => void read.refresh()}>Refresh event</button></Notice>}
    {!validRecord && <section className="card"><h2>The codes live on the creating device.</h2><p>Open this link in the browser that created the event. This device has no valid host record.</p><p className="small muted">Unopened codes can be generated again. A lost opened code cannot be replaced or revealed, and becomes void. That only lowers what attendees need.</p>
      {event.slots.length < event.checkin.slots && <button type="button" className="btn" disabled={!ownsEvent} onClick={recover}>Prepare unopened codes on this device</button>}
    </section>}
    {validRecord && <section className={`ticket host-controls ${showCode ? "host-showing-code" : ""}`} aria-labelledby="host-control-title">
      <div className="ticket-topline"><span>{showCode ? `Code ${liveSlot + 1} of ${event.checkin.slots} / Live` : "You choose the moment"}</span><Icon name="calendar" /></div>
      {showCode ? <><h2 id="host-control-title" className="visually-hidden">Live host code</h2><p className="host-live-code" data-testid="host-live-code">{liveCode}</p><div className="host-live-actions"><CopyButton text={liveCode!} label="Copy live code" /><p className="countdown">{formatCountdown(event.slots[liveSlot]!.opened_at_ms + event.checkin.window_ms - now)} left</p></div><p className="small muted">Share these five words with everyone on the call. No other code is shown here.</p></> : <><h2 id="host-control-title">{event.status !== "Active" ? `Event ${event.status.toLowerCase()}` : next.state === "all-opened" ? "Every code has opened." : next.state === "checkin-over" ? "Check-in has ended." : next.state === "no-room" ? "No room for another code." : `Next up: code ${next.slot + 1}.`}</h2>
        {(next.state === "waiting" || next.state === "ready") && event.status === "Active" && <>
          <p>{next.state === "waiting" ? `Can open from ${formatWhen(next.earliest)}.` : "Ready when your call is ready. Opening asks your wallet for one approval."}</p>
          <p className="host-timing">{next.slot === event.checkin.slots - 1 ? `Open by ${formatClock(next.lastChance)}, or it cannot open and is void.` : `Open by ${formatClock(next.roomBy)} to leave room for code ${event.checkin.slots}.`}</p>
          <button type="button" className="btn primary" disabled={!canOpen} onClick={() => void open()}>{walletWorking ? walletChecking ? "Checking the chain..." : "Waiting for your wallet..." : `Open code ${next.slot + 1}`}<Icon name="arrow" /></button>
          <p className="small muted">Unopened codes stay hidden, even while this screen is shared.</p>
        </>}
        {next.state === "no-room" && <p>The remaining unopened codes become void, lowering the number attendees need.</p>}
      </>}
      {(!ready || stale) && <p className="small muted">Waiting for current chain time. Code opening is paused.</p>}
    </section>}
    {error && <Notice tone="bad" title="Host action needs a check">{error}</Notice>}
    <section className="card" aria-labelledby="host-reveal-title"><p className="eyebrow">The public proof</p><h2 id="host-reveal-title">{allRevealed ? "Every code is revealed." : "Keep this page open for reveals."}</h2><p className="small muted">Closed code windows are revealed through the relayer without another wallet popup. Keep this page open until every code is revealed, or return before {formatWhen(event.schedule.reveal_deadline_ms)}.</p>
      <ol className="host-code-status">{Array.from({ length: event.checkin.slots }, (_, slot) => {
        const opened = event.slots[slot];
        const held = validRecord?.codes[slot];
        const revealable = ready && revealableSlots(event, now).includes(slot);
        const missing = opened && opened.revealed === null && !matchingHostCode(config.contractId, id, event, slot, held);
        const expired = ready && now >= event.schedule.reveal_deadline_ms;
        const state = !opened ? afterCheckin || next.state === "no-room" ? "Unopened / void" : "Not opened" : opened.revealed !== null ? "Revealed" : expired ? "Not revealed / void" : missing ? "Opened code unavailable on this device" : reveals[slot] === "checking" ? "Checking the chain..." : reveals[slot] === "sending" ? "Revealing..." : reveals[slot] === "failed" ? "Automatic reveal needs a retry" : reveals[slot] === "sent" ? "Reveal sent; waiting for the chain" : revealable ? "Ready to reveal" : "Waiting for the window to close";
        return <li key={slot}><span>Code {slot + 1}</span><strong>{state}</strong>{revealable && !missing && opened?.revealed === null && reveals[slot] === "failed" && <div className="actions row"><button className="btn" type="button" onClick={() => void revealSlot(slot)}>Retry automatic reveal</button><button className="btn quiet" type="button" disabled={!wallet || walletWorking} onClick={() => void revealSlot(slot, true)}>Reveal with wallet</button></div>}</li>;
      })}</ol>
    </section>
    <RelayerHealth />
    <section className="host-links card"><p className="eyebrow">Your event links</p><a className="text-link" href={`#/event/${id}`}>{afterCheckin ? "View attendee results" : "Open the attendee page"} <Icon name="arrow" /></a><a className="text-link" href={`#/event/${id}/organizer`}>View public event record ↗</a>{validRecord?.callUrl && <a className="text-link" href={validRecord.callUrl} target="_blank" rel="noreferrer">Join your call ↗</a>}</section>
  </div>;
}
