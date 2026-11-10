// For servers and CLIs that use near-api-js. Not part of the browser bundle: import it as
// "@bail/sdk/provider".

import { JsonRpcProvider } from "near-api-js";

type Send = JsonRpcProvider["sendJsonRpc"];

const RETRY_CAUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Throttling, server trouble and dropped connections are worth another try; a refused transaction is not. */
function worthRetrying(error: unknown): boolean {
  const e = error as { cause?: unknown; message?: string };
  if (typeof e?.cause === "number") return RETRY_CAUSES.has(e.cause);
  return error instanceof TypeError || /fetch failed|FetchError|ECONNRESET|ETIMEDOUT/.test(e?.message ?? "");
}

/**
 * A near-api-js provider for public endpoints, which throttle: it moves to the next endpoint
 * as soon as one refuses, waits only after every endpoint has been tried, and never has more
 * than a few requests in flight, so a burst of work doesn't get the whole process refused.
 * near-api-js on its own doesn't retry a 429 at all.
 */
export class ResilientProvider extends JsonRpcProvider {
  constructor(urls: readonly string[], options: { maxConcurrent?: number; rounds?: number } = {}) {
    if (urls.length === 0) throw new Error("at least one RPC endpoint is needed");
    super({ url: urls[0]! });
    const peers = urls.map((url) => new JsonRpcProvider({ url }));
    const rounds = options.rounds ?? 3;
    const maxConcurrent = options.maxConcurrent ?? 3;
    let running = 0;
    const queue: (() => void)[] = [];

    const acquire = async () => {
      if (running >= maxConcurrent) await new Promise<void>((resolve) => queue.push(resolve));
      running++;
    };
    const release = () => {
      running--;
      queue.shift()?.();
    };

    this.sendJsonRpc = (async (method, params) => {
      await acquire();
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            return await peers[attempt % peers.length]!.sendJsonRpc(method, params);
          } catch (error) {
            if (!worthRetrying(error) || attempt + 1 >= peers.length * rounds) throw error;
            if ((attempt + 1) % peers.length === 0) {
              const round = Math.floor(attempt / peers.length);
              await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** round, 5000)));
            }
          }
        }
      } finally {
        release();
      }
    }) as Send;
  }
}
