import type { BailView } from "@bail/sdk";

const STALE_AFTER_MS = 2 * 60_000;

/**
 * Chain time, read once and then counted with the browser's monotonic clock, so the page
 * doesn't hammer the RPC and isn't thrown off by the user's wrong system clock. A phone
 * that sleeps can lose time, so callers re-sync when the page returns to the foreground.
 */
export class ChainClock {
  readonly #view: BailView;
  #chainAtSync = 0;
  #perfAtSync = 0;
  #syncedWall = 0;
  #synced = false;

  constructor(view: BailView) {
    this.#view = view;
  }

  get synced(): boolean {
    return this.#synced;
  }

  /** True when the last successful read is old, so time-sensitive screens can say so. */
  get stale(): boolean {
    return !this.#synced || Date.now() - this.#syncedWall > STALE_AFTER_MS;
  }

  get lastSyncedAt(): number | null {
    return this.#synced ? this.#syncedWall : null;
  }

  async sync(): Promise<number> {
    const before = performance.now();
    const chain = await this.#view.now();
    // The reply was produced somewhere in the middle of the round trip.
    this.#perfAtSync = (before + performance.now()) / 2;
    this.#chainAtSync = chain;
    this.#syncedWall = Date.now();
    this.#synced = true;
    return this.now();
  }

  now(): number {
    return this.#chainAtSync + (performance.now() - this.#perfAtSync);
  }
}
