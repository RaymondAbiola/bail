import { useEffect, useRef, useState } from "react";

import { useApp } from "../context.tsx";
import { usePoll } from "../hooks.ts";
import { connectedOrganizer, organizerConnector, testOrganizerWallet, type OrganizerWallet } from "../lib/organizer-wallet.ts";
import { Notice } from "./common.tsx";

export function useHostWallet() {
  const { config } = useApp();
  const [wallet, setWallet] = useState<OrganizerWallet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    const test = testOrganizerWallet(config.testWallet, window.location.hostname);
    if (test) { setLoading(false); return; }
    void organizerConnector().then(async (connector) => {
      if (!active) return;
      const update = async () => { const next = await connectedOrganizer(connector); if (active) setWallet(next); };
      const clear = () => { if (active) setWallet(null); };
      connector.on("wallet:signIn", update);
      connector.on("wallet:signOut", clear);
      unsubscribe = () => { connector.off("wallet:signIn", update); connector.off("wallet:signOut", clear); };
      await update();
    }).catch(() => { if (active) setError("The wallet connector could not load. Try connecting again."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; unsubscribe(); };
  }, [config.testWallet]);

  const connect = async () => {
    if (busy.current) return;
    busy.current = true; setLoading(true); setError(null);
    try {
      const test = testOrganizerWallet(config.testWallet, window.location.hostname);
      if (test) { setWallet(test); return; }
      const connector = await organizerConnector();
      await connector.connect();
      const connected = await connectedOrganizer(connector);
      if (!connected) throw new Error("No account selected");
      setWallet(connected);
    } catch { setError("No wallet connected. You can try again when you are ready."); }
    finally { busy.current = false; setLoading(false); }
  };
  const disconnect = async () => {
    if (busy.current) return;
    busy.current = true; setError(null);
    try {
      if (!testOrganizerWallet(config.testWallet, window.location.hostname)) await (await organizerConnector()).disconnect();
      setWallet(null);
    } catch { setError("Could not disconnect. Try again."); }
    finally { busy.current = false; }
  };
  return { wallet, loading, error, connect, disconnect };
}

export type HostWalletState = ReturnType<typeof useHostWallet>;

export function HostWallet({ state }: { state: HostWalletState }) {
  return <section className="host-wallet card" aria-label="Organizer wallet">
    <div><p className="eyebrow">Organizer / NEAR testnet</p><p className="host-account">{state.wallet?.accountId ?? "Your event. Your wallet."}</p><p className="small muted">The organizer pays event storage and approves each code opening.</p></div>
    <button type="button" className="btn primary" disabled={state.loading} onClick={() => void (state.wallet ? state.disconnect() : state.connect())}>{state.loading ? "Loading wallet..." : state.wallet ? "Disconnect wallet" : "Connect NEAR wallet"}</button>
    {state.error && <p className="small payout-error" role="alert">{state.error}</p>}
  </section>;
}

export function RelayerHealth() {
  const { config } = useApp();
  const health = usePoll(async () => {
    const response = await fetch(`${config.relayerUrl}/v1/health`, { signal: AbortSignal.timeout(8000) });
    const data = await response.json() as { ok?: boolean; contract?: string };
    if (!response.ok || !data.ok || data.contract !== config.contractId) throw new Error("Relayer unavailable");
    return true;
  }, 30_000, [config.relayerUrl, config.contractId]);
  return <div className="host-health">
    <Notice tone={health.loading ? "info" : health.error ? "wait" : "good"} title={health.loading ? "Checking the relayer..." : health.error ? "Relayer unavailable" : "Relayer is reachable"}>
      <p>{health.error ? "Attendees cannot RSVP or send codes through this relayer right now. Keep it running during the event." : "Attendees need the relayer to RSVP and send codes. Keep it running during the event."}</p>
    </Notice>
    {health.error && <button type="button" className="btn quiet" onClick={() => void health.refresh()}>Check relayer again</button>}
  </div>;
}
