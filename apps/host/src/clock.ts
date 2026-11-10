import type { BailView } from "@bail/sdk";

const RESYNC_MS = 10_000;

/**
 * Block time, asked of the chain rarely and counted locally in between. Public endpoints
 * throttle, and a console that asks for the time every second gets itself refused.
 */
export class ChainClock {
  readonly #view: BailView;
  #offset = 0;
  #syncedAt = 0;

  constructor(view: BailView) {
    this.#view = view;
  }

  /** Reads block time from the chain. */
  async sync(): Promise<number> {
    const chain = await this.#view.now();
    this.#syncedAt = Date.now();
    this.#offset = chain - this.#syncedAt;
    return chain;
  }

  /** The estimate, with no network call. */
  now(): number {
    return Date.now() + this.#offset;
  }

  /** Re-reads the chain only if the last read is a few seconds old. */
  async fresh(): Promise<number> {
    return Date.now() - this.#syncedAt > RESYNC_MS ? this.sync() : this.now();
  }

  /** Waits until block time reaches `ms`, asking the chain about every 10 seconds and once more at the end. */
  async sleepUntil(ms: number): Promise<void> {
    for (;;) {
      const now = await this.sync();
      if (now >= ms) return;
      const left = ms - now;
      await new Promise((resolve) => setTimeout(resolve, left > RESYNC_MS ? RESYNC_MS : left + 250));
    }
  }
}
