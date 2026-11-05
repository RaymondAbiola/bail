/** At most `limit` hits per key in any `windowMs`, counted in a sliding window. */
export class RateLimit {
  readonly limit: number;
  readonly windowMs: number;
  readonly #hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string, now = Date.now()): boolean {
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    if (this.#hits.size > 50_000) this.#prune(now);
    return true;
  }

  #prune(now: number): void {
    for (const [key, hits] of this.#hits) {
      if (hits.every((t) => now - t >= this.windowMs)) this.#hits.delete(key);
    }
  }
}
