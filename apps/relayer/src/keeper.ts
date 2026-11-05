import { type BailView, type Event } from "@bail/sdk";

import type { Chain } from "./chain.ts";

const KEEPER_TGAS = 300;

export interface KeeperOptions {
  chain: Chain;
  view: BailView;
  /** Tickets per call. A page that runs out of gas is halved and retried. */
  pages?: { tally: number; payout: number; close: number };
  /** How long to wait after the last payout before closing, so transfer callbacks settle first. */
  closeDelayMs?: number;
  /** At most this many calls per event per tick, so one event can't starve the others. */
  callsPerTick?: number;
  log?: (line: string) => void;
}

type Step = "tally" | "payout" | "close_event";

/** What an event needs next, or null if nothing can be done for it yet. */
export function nextStep(event: Event, nowMs: number): Step | null {
  if (event.closed) return null;
  const tally = event.tally;
  if (tally?.stage !== "Done") {
    const due = event.status !== "Active" || nowMs >= event.schedule.dispute_ends_at_ms;
    return due ? "tally" : null;
  }
  return tally.paid_cursor < event.registered ? "payout" : "close_event";
}

/** Settles every event once its deadlines pass. Anyone can do this; the keeper just doesn't forget. */
export class Keeper {
  readonly #options: Required<Omit<KeeperOptions, "chain" | "view" | "log">> & KeeperOptions;
  readonly #paidAt = new Map<number, number>();
  #firstOpen = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: KeeperOptions) {
    this.#options = {
      pages: { tally: 25, payout: 8, close: 25 },
      closeDelayMs: 60_000,
      callsPerTick: 10,
      ...options,
    };
  }

  /** One pass over every event that isn't closed yet, judged by block time as the contract does. */
  async tick(at?: number): Promise<void> {
    const { view } = this.#options;
    const nowMs = at ?? (await view.now());
    for (let id = this.#firstOpen; ; id++) {
      const event = await view.event(id);
      if (!event) break;
      if (event.closed && id === this.#firstOpen) {
        this.#firstOpen++;
        continue;
      }
      await this.#settle(id, event, nowMs);
    }
  }

  async #settle(id: number, initial: Event, nowMs: number): Promise<void> {
    const { chain, view, pages, closeDelayMs, callsPerTick } = this.#options;
    const log = this.#options.log ?? ((line: string) => console.log(line));
    let event: Event | null = initial;
    for (let calls = 0; event && calls < callsPerTick; calls++) {
      const step = nextStep(event, nowMs);
      if (!step) return;
      if (step === "close_event") {
        const paidAt = this.#paidAt.get(id) ?? nowMs;
        this.#paidAt.set(id, paidAt);
        if (nowMs - paidAt < closeDelayMs) return;
      }
      const pageKey = step === "close_event" ? "close" : step;
      const outcome = await chain.call(step, { event_id: id, limit: pages[pageKey] }, KEEPER_TGAS);
      log(`keeper ${step} event=${id} limit=${pages[pageKey]} ok=${outcome.ok} tx=${outcome.tx}`);
      if (!outcome.ok) {
        if (/exceeded the prepaid gas|GasExceeded/i.test(outcome.error ?? "") && pages[pageKey] > 1) {
          pages[pageKey] = Math.max(1, Math.floor(pages[pageKey] / 2));
          continue;
        }
        log(`keeper ${step} event=${id} failed: ${outcome.error}`);
        return;
      }
      if (step === "close_event" && outcome.value === true) {
        this.#paidAt.delete(id);
        return;
      }
      event = await view.event(id);
    }
  }

  start(intervalMs = 30_000): void {
    const run = () =>
      this.tick()
        .catch((error: unknown) => console.error(`keeper: ${error instanceof Error ? error.message : error}`))
        .finally(() => {
          this.#timer = setTimeout(run, intervalMs);
        });
    void run();
  }

  stop(): void {
    clearTimeout(this.#timer);
  }
}
