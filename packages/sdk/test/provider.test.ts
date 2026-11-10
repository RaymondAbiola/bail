import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { ResilientProvider } from "../src/provider.ts";

async function node(handler: (hit: number) => number): Promise<{ url: string; server: Server; hits: () => number; peak: () => number }> {
  let hits = 0;
  let inflight = 0;
  let peak = 0;
  const server = createServer((req, res) => {
    req.resume();
    const status = handler(hits++);
    inflight++;
    peak = Math.max(peak, inflight);
    setTimeout(() => {
      inflight--;
      if (status === 200) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { chain_id: "testnet" } }));
      } else {
        res.writeHead(status).end("Rate limits exceeded");
      }
    }, 20);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, hits: () => hits, peak: () => peak };
}

const ask = (p: ResilientProvider) => p.sendJsonRpc("status" as never, [] as never) as Promise<{ chain_id: string }>;

test("a throttled endpoint hands over to the next one at once", async () => {
  const bad = await node(() => 429);
  const good = await node(() => 200);
  try {
    const started = Date.now();
    assert.equal((await ask(new ResilientProvider([bad.url, good.url]))).chain_id, "testnet");
    assert.equal(bad.hits(), 1);
    assert.equal(good.hits(), 1);
    assert.ok(Date.now() - started < 400, "no backoff between endpoints");
  } finally {
    bad.server.close();
    good.server.close();
  }
});

test("a single endpoint is retried after a pause, and recovers", async () => {
  const flaky = await node((hit) => (hit < 2 ? 429 : 200));
  try {
    assert.equal((await ask(new ResilientProvider([flaky.url]))).chain_id, "testnet");
    assert.equal(flaky.hits(), 3);
  } finally {
    flaky.server.close();
  }
});

test("when every endpoint keeps refusing, the last error comes back", async () => {
  const a = await node(() => 429);
  const b = await node(() => 429);
  try {
    await assert.rejects(() => ask(new ResilientProvider([a.url, b.url], { rounds: 2 })), /Rate limits/);
    assert.equal(a.hits() + b.hits(), 4);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("a burst of requests is spread out, not sent all at once", async () => {
  const good = await node(() => 200);
  try {
    const provider = new ResilientProvider([good.url], { maxConcurrent: 2 });
    await Promise.all(Array.from({ length: 10 }, () => ask(provider)));
    assert.equal(good.hits(), 10);
    assert.ok(good.peak() <= 2, `at most 2 in flight, saw ${good.peak()}`);
  } finally {
    good.server.close();
  }
});
