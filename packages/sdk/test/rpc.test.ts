// Public RPC endpoints stall and throttle; reads must survive that.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { BailView } from "../src/index.ts";

const config = {
  fee_bps: 0, fee_account: null, min_window_ms: 60000, min_reveal_ms: 60000,
  min_dispute_ms: 60000, max_event_ms: 1, intents_account: null,
};

async function server_(statuses: number[]): Promise<{ url: string; server: Server; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    req.resume();
    const status = statuses[Math.min(hits++, statuses.length - 1)]!;
    if (status === 200) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(config))] } }));
    } else {
      res.writeHead(status, { "Retry-After": "0" }).end("slow down");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, hits: () => hits };
}

async function endpoint(statuses: number[]): Promise<{ view: BailView; server: Server; hits: () => number }> {
  const { url, server, hits } = await server_(statuses);
  return { view: new BailView({ contractId: "bail.test.near", rpcUrl: url }), server, hits };
}

test("a throttled or failing endpoint is retried until it answers", async () => {
  const { view, server, hits } = await endpoint([429, 503, 200]);
  try {
    assert.deepEqual(await view.config(), config);
    assert.equal(hits(), 3);
  } finally {
    server.close();
  }
});

test("an endpoint that never recovers fails clearly after a few tries", async () => {
  const { view, server, hits } = await endpoint([429]);
  try {
    await assert.rejects(() => view.config(), /429/);
    assert.equal(hits(), 6);
  } finally {
    server.close();
  }
});

test("a refusing endpoint hands over to the next one without waiting", async () => {
  const bad = await server_([429]);
  const good = await server_([200]);
  try {
    const view = new BailView({ contractId: "bail.test.near", rpcUrl: bad.url, fallbackUrls: [good.url] });
    const started = Date.now();
    assert.deepEqual(await view.config(), config);
    assert.equal(bad.hits(), 1);
    assert.equal(good.hits(), 1);
    assert.ok(Date.now() - started < 300, "no backoff between endpoints");
  } finally {
    bad.server.close();
    good.server.close();
  }
});

test("a client error is not retried", async () => {
  const { view, server, hits } = await endpoint([400]);
  try {
    await assert.rejects(() => view.config(), /400/);
    assert.equal(hits(), 1);
  } finally {
    server.close();
  }
});
