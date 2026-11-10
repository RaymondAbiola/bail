import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { siteConfig, siteServer, tunnelUrl } from "../src/public.ts";

test("a quick tunnel's address is read from cloudflared's log", () => {
  const banner = "2026-11-10T21:00:00Z INF |  https://random-words-here-1234.trycloudflare.com                          |";
  assert.equal(tunnelUrl(banner), "https://random-words-here-1234.trycloudflare.com");
  assert.equal(tunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com..."), null);
  assert.equal(tunnelUrl("INF Registered tunnel connection connIndex=0"), null);
  assert.equal(tunnelUrl("see https://example.com/trycloudflare.com for docs"), null, "only real tunnel hosts");
});

test("the site's config points at the relayer and carries only what was given", () => {
  const plain = JSON.parse(siteConfig({ relayerUrl: "https://r.trycloudflare.com/" }));
  assert.deepEqual(plain, { relayerUrl: "https://r.trycloudflare.com", explorerUrl: "https://testnet.nearblocks.io" });
  const full = JSON.parse(
    siteConfig({ relayerUrl: "https://r.example", defaultEventId: 0, explorerUrl: null, events: { "0": { title: "Builders check-in", callUrl: "https://meet.example/x" } } }),
  );
  assert.equal(full.defaultEventId, 0, "event 0 is a real event number, not 'none'");
  assert.equal(full.explorerUrl, null);
  assert.equal(full.events["0"].title, "Builders check-in");
  assert.equal(JSON.parse(siteConfig({ relayerUrl: "https://r.example", events: {} })).events, undefined);
});

test("the static server serves the built site and nothing outside it", async () => {
  const root = mkdtempSync(join(tmpdir(), "bail-site-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), '<div id="root"></div>');
  writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(root, "config.json"), "{}");
  writeFileSync(join(tmpdir(), "bail-secret-outside.txt"), "outside");

  const server = siteServer(root);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, init?: RequestInit) => fetch(base + path, init);
  try {
    const home = await get("/");
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type")!, /text\/html/);
    assert.match(await home.text(), /id="root"/);
    assert.match((await get("/assets/app.js")).headers.get("content-type")!, /javascript/);
    assert.equal((await get("/config.json")).headers.get("cache-control"), "no-store", "the config is never cached");
    assert.equal((await get("/nope.js")).status, 404);
    assert.equal((await get("/assets")).status, 404, "directories are not listed");
    assert.equal((await get("/", { method: "POST" })).status, 405);
    assert.equal((await get("/", { method: "HEAD" })).status, 200);

    // Raw requests, so the client can't tidy the path before it is sent.
    const raw = (path: string) =>
      new Promise<string>((resolve, reject) => {
        import("node:net").then(({ connect }) => {
          const socket = connect(Number(new URL(base).port), "127.0.0.1", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
          let data = "";
          socket.on("data", (d) => (data += d));
          socket.on("end", () => resolve(data));
          socket.on("error", reject);
        });
      });
    for (const attack of ["/../bail-secret-outside.txt", "/%2e%2e/bail-secret-outside.txt", "/assets/../../bail-secret-outside.txt", "/..%2fbail-secret-outside.txt", "/%00"]) {
      const reply = await raw(attack);
      assert.doesNotMatch(reply, /outside/, `${attack} must not reach a file outside the site`);
    }
  } finally {
    server.close();
  }
});
