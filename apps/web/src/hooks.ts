import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type Event, type Standing, type TicketRecord, phase as phaseOf } from "@bail/sdk";

import { useApp } from "./context.tsx";
import type { StoredTicket } from "./lib/storage.ts";

export type Route =
  | { page: "home" }
  | { page: "event"; id: number; view: "main" | "rsvp" | "restore" | "organizer" };

export function parseRoute(hash: string): Route {
  const match = hash.replace(/^#\/?/, "").match(/^event\/(\d+)(?:\/(rsvp|restore|organizer))?\/?$/);
  if (!match) return { page: "home" };
  return { page: "event", id: Number(match[1]), view: (match[2] as "rsvp" | "restore" | "organizer" | undefined) ?? "main" };
}

export function routeHref(id: number, view: "main" | "rsvp" | "restore" | "organizer" = "main"): string {
  return `#/event/${id}${view === "main" ? "" : `/${view}`}`;
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return useMemo(() => parseRoute(hash), [hash]);
}

const MIN_POLL_MS = 5000;

export interface Polled<T> {
  data: T | null;
  error: string | null;
  /** When the data was last read successfully, in wall clock milliseconds. */
  updatedAt: number | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Reads on a timer, but never faster than every 5 seconds and not while the page is hidden.
 * Reads for the same deps never overlap. New deps start a fresh read and ignore the old one.
 * Reloads keep the last good data so the screen doesn't go blank; `error` says it is stale.
 */
export function usePoll<T>(read: () => Promise<T>, everyMs: number, deps: unknown[]): Polled<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; updatedAt: number | null; loading: boolean }>({
    data: null, error: null, updatedAt: null, loading: true,
  });
  const active = useRef<{ reading: boolean } | null>(null);
  const readRef = useRef(read);
  readRef.current = read;

  const refresh = useCallback(async () => {
    const scope = active.current;
    if (!scope || scope.reading) return;
    scope.reading = true;
    try {
      const data = await readRef.current();
      if (active.current === scope) setState({ data, error: null, updatedAt: Date.now(), loading: false });
    } catch (error) {
      if (active.current === scope) setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error), loading: false }));
    } finally {
      scope.reading = false;
    }
  }, []);

  useEffect(() => {
    const scope = { reading: false };
    active.current = scope;
    setState((s) => ({ ...s, error: null, loading: true }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      if (!document.hidden) await refresh();
      if (!stopped) timer = setTimeout(tick, Math.max(everyMs, MIN_POLL_MS));
    };
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      active.current = null;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, refresh };
}

/** Chain time in milliseconds, ticking once a second without asking the chain each time. */
export function useChainNow(): { now: number; stale: boolean; ready: boolean } {
  const { clock } = useApp();
  const [, setTick] = useState(0);
  const [ready, setReady] = useState(clock.synced);

  useEffect(() => {
    let alive = true;
    const sync = () => {
      clock.sync().then(() => alive && setReady(true), () => {});
    };
    sync();
    const every = setInterval(() => setTick((n) => n + 1), 1000);
    const resync = setInterval(() => !document.hidden && sync(), 60_000);
    const onVisible = () => {
      if (!document.hidden) sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(every);
      clearInterval(resync);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [clock]);

  return { now: clock.now(), stale: clock.stale, ready };
}

export interface EventState {
  event: Event | null;
  ticket: TicketRecord | null;
  standing: Standing | null;
  /** What this ticket is paid, in base units, once the tally has fixed the split. */
  payout: string | null;
}

/** The event, this person's ticket record, and their standing once check-in is over. */
export function useEventState(eventId: number, ticketKey: string | null): Polled<EventState> {
  const { view, clock } = useApp();
  return usePoll<EventState>(
    async () => {
      const event = await view.event(eventId);
      if (!event || !ticketKey) return { event, ticket: null, standing: null, payout: null };
      const now = clock.synced ? clock.now() : await clock.sync();
      const phaseNow = phaseOf(event, now);
      const afterCheckIn = phaseNow !== "Open" && phaseNow !== "CheckIn";
      const split = !!event.tally && event.tally.stage !== "Classifying";
      const [ticket, standing, payout] = await Promise.all([
        view.ticket(eventId, ticketKey),
        afterCheckIn ? view.standing(eventId, ticketKey) : Promise.resolve(null),
        split ? view.payout(eventId, ticketKey) : Promise.resolve(null),
      ]);
      return { event, ticket, standing, payout };
    },
    6000,
    [eventId, ticketKey, view],
  );
}

/** This browser's saved ticket for an event. Every screen that uses it sees a change at once. */
export function useStoredTicket(eventId: number) {
  const { store, config } = useApp();
  const [stored, setStored] = useState(() => store.get(config.contractId, eventId));
  useEffect(() => {
    const read = () => setStored(store.get(config.contractId, eventId));
    read();
    return store.subscribe(read);
  }, [store, config.contractId, eventId]);
  return {
    stored,
    save: (ticket: StoredTicket) => store.save(config.contractId, eventId, ticket),
    update: (change: (ticket: StoredTicket) => StoredTicket) => void store.update(config.contractId, eventId, change),
    remove: () => store.remove(config.contractId, eventId),
  };
}
