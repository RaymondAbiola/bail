// A local playground: the real site, the real contract on a private NEAR node, the real
// relayer and keeper, three pretend attendees and a pretend host. You play one more attendee.
//
//   NEAR_SANDBOX_BIN=<path to near-sandbox> npm run demo -w @bail/web
//
// Open the app, RSVP, wait for check-in, and type the codes you see on the "host screen" page.
// Nothing here touches testnet or any real funds. Stop it with Ctrl+C.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { NearChain, RELAYER_METHODS, Sender } from "@bail/relayer/src/chain.ts";
import { Keeper } from "@bail/relayer/src/keeper.ts";
import { RateLimit } from "@bail/relayer/src/limits.ts";
import { Sponsor } from "@bail/relayer/src/onboarding.ts";
import { relayerServer } from "@bail/relayer/src/server.ts";
import { BailView, RelayerClient, Ticket, codeCommitment, generateCode, rsvpDelegate, toBase64 } from "@bail/sdk";
import { MINUTE, USDC, startSandbox } from "@bail/testkit";
import { KeyPair } from "near-api-js";

const webDir = new URL("../", import.meta.url).pathname;
const bin = process.env.NEAR_SANDBOX_BIN;
if (!bin) throw new Error("set NEAR_SANDBOX_BIN to the near-sandbox binary");
const PORT = Number(process.env.DEMO_PORT ?? 5180);
const OPENS_IN = Number(process.env.DEMO_OPENS_MINUTES ?? 5);
const SLOTS = 3;
const REQUIRED = 2;
const WINDOW = MINUTE;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const log = (line: string) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`);
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

interface HostState {
  phase: "waiting" | "live" | "between" | "over";
  slot: number;
  code: string | null;
  windowEnd: number;
  opensAt: number;
  closesAt: number;
  now: number;
}

const HOST_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Host screen</title><style>
body{margin:0;font-family:system-ui,sans-serif;background:#172d29;color:#f7f5ef;min-height:100vh;display:grid;place-items:center;text-align:center;padding:24px}
.small{opacity:.75;font-size:1rem;margin:8px 0}.code{font-family:ui-serif,Georgia,serif;font-size:clamp(2rem,7vw,4.5rem);line-height:1.2;font-weight:700;letter-spacing:.02em}
.word{display:block}.t{font-size:2rem;font-variant-numeric:tabular-nums;margin-top:16px}.tag{background:#fff0cd;color:#5a3a07;border-radius:999px;padding:4px 12px;font-weight:600;font-size:.9rem}
</style></head><body><main><span class="tag">Pretend host screen</span><div id="body"><p class="small">Loading...</p></div></main>
<script>
const body=document.getElementById('body');
const clock=ms=>{const s=Math.max(0,Math.ceil(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
async function paint(){try{const r=await fetch('/host.json',{cache:'no-store'});const s=await r.json();const now=s.now;
if(s.phase==='live'){body.innerHTML='<p class="small">Code '+(s.slot+1)+' of ${SLOTS}. Say it or share your screen, as a real host would.</p><div class="code">'+s.code.split(' ').map(w=>'<span class="word">'+w+'</span>').join('')+'</div><div class="t">'+clock(s.windowEnd-now)+'</div>';}
else if(s.phase==='waiting'){body.innerHTML='<h1>Check-in has not started</h1><p class="small">Codes start appearing here once check-in opens, at an unpredictable moment.</p><div class="t">opens in '+clock(s.opensAt-now)+'</div>';}
else if(s.phase==='between'){body.innerHTML='<h1>No code live right now</h1><p class="small">The next one comes at an unexpected moment.</p>';}
else{body.innerHTML='<h1>Check-in is over</h1><p class="small">All codes shown and revealed. Back in the app, watch the dispute window and then your result.</p>';}}catch{}}
setInterval(paint,1000);paint();
</script></body></html>`;

async function main() {
  log("building the site...");
  const dist = mkdtempSync(join(tmpdir(), "bail-demo-"));
  execFileSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], { cwd: webDir, stdio: "ignore" });

  log("starting a private NEAR node and deploying Bail...");
  const sb = await startSandbox(bin!);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      sb.stop();
      process.exit(0);
    });
  }
  const relayerKeys = [KeyPair.fromRandom("ed25519"), KeyPair.fromRandom("ed25519")];
  const sponsorKey = KeyPair.fromRandom("ed25519");
  const [bail, usdc, organizer, arbiter, relayer, faucet] = await Promise.all([
    sb.deployBail(),
    sb.deployToken(),
    sb.newAccount("organizer", "10"),
    sb.newAccount("arbiter", "1"),
    sb.newAccount("relayer", "10", { functionCallKeys: { keys: relayerKeys, receiverId: sb.id("bail"), methods: RELAYER_METHODS, allowance: "2" } }),
    sb.newAccount("faucet", "10", { key: sponsorKey }),
  ]);
  await sb.fund(usdc, [bail], 0n);
  await sb.fund(usdc, [faucet], 200n * USDC);

  const view = new BailView({ contractId: bail.accountId, rpcUrl: sb.rpcUrl });
  const chain = new NearChain({ accountId: relayer.accountId, contractId: bail.accountId, rpcUrl: sb.rpcUrl, keys: relayerKeys.map(String) });
  const sponsor = new Sponsor(new Sender({ accountId: faucet.accountId, rpcUrl: sb.rpcUrl, keys: [sponsorKey.toString()] }), usdc.accountId, view);
  const relayerHttp = relayerServer({
    chain, view, contractId: bail.accountId, sponsor, log: () => {},
    perIp: new RateLimit(600, 60_000), perTicket: new RateLimit(120, 60_000), faucetPerIp: new RateLimit(100, 3_600_000),
  });
  await new Promise<void>((resolve) => relayerHttp.listen(0, "127.0.0.1", resolve));
  const relayerUrl = `http://127.0.0.1:${(relayerHttp.address() as AddressInfo).port}`;
  const relayerClient = new RelayerClient(relayerUrl);

  writeFileSync(
    join(dist, "config.json"),
    JSON.stringify({
      relayerUrl, rpcUrl: sb.rpcUrl, contractId: bail.accountId, token: usdc.accountId, defaultEventId: 0,
      events: { "0": { title: "Bail demo event", description: "A practice event on a private test network. Nothing here is real." } },
    }),
  );

  const t0 = await view.now();
  const opens = t0 + OPENS_IN * MINUTE;
  const closes = opens + 6 * MINUTE;
  await sb.call(organizer, bail.accountId, "create_event", {
    event: {
      token: usdc.accountId, deposit: String(USDC), capacity: 8, arbiter: arbiter.accountId,
      cancel_cutoff_ms: t0 + Math.max(1, OPENS_IN - 1) * MINUTE, rsvp_closes_at_ms: opens, checkin_opens_at_ms: opens,
      checkin_closes_at_ms: closes, reveal_ms: MINUTE, dispute_ms: MINUTE,
      checkin: { slots: SLOTS, required: REQUIRED, window_ms: WINDOW },
    },
  }, BigInt(await view.storageCost(8)));

  // Three pretend attendees: two will catch every code, one will miss them all and forfeit.
  const guests = [
    { name: "Carol", ticket: Ticket.generate(), catches: true },
    { name: "Erin", ticket: Ticket.generate(), catches: true },
    { name: "Dave", ticket: Ticket.generate(), catches: false },
  ];
  for (const guest of guests) {
    await relayerClient.faucet(guest.ticket.accountId, 0);
    const nonce = (await view.accessKeyNonce(guest.ticket.accountId, guest.ticket.publicKey))!;
    await relayerClient.meta(0, guest.ticket.signDelegate(rsvpDelegate({
      publicKey: guest.ticket.publicKey, token: usdc.accountId, contractId: bail.accountId, deposit: String(USDC),
      note: guest.ticket.rsvpNote(0, `near:${guest.ticket.accountId}`), nonce: nonce + 1n, maxBlockHeight: (await view.finalHeight()) + 600n,
    })));
  }

  const host: HostState = { phase: "waiting", slot: -1, code: null, windowEnd: 0, opensAt: opens, closesAt: closes, now: 0 };
  const site = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/host.json") {
      host.now = await view.now().catch(() => Date.now());
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(host));
      return;
    }
    if (path === "/host") {
      res.writeHead(200, { "Content-Type": "text/html" }).end(HOST_PAGE);
      return;
    }
    try {
      const file = join(dist, path === "/" ? "/index.html" : path);
      if (!existsSync(file)) throw new Error("missing");
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((resolve, reject) => site.once("error", reject).listen(PORT, "127.0.0.1", resolve));

  const keeper = new Keeper({ chain, view, closeDelayMs: 60 * MINUTE, log: () => {} });
  setInterval(() => void keeper.tick().catch(() => {}), 5000);

  const when = (ms: number) => new Date(ms).toLocaleTimeString();
  console.log(`
==============================================================
  Bail demo is running. Nothing here is real or on testnet.

  The app:          http://localhost:${PORT}/
  The host screen:  http://localhost:${PORT}/host     (open it in a second window)

  Check-in opens at ${when(opens)}. Until then, RSVP in the app.
  Then watch the host screen for codes and type them into the app.
  Carol and Erin will catch every code; Dave will miss them all.
  The whole event takes about ${OPENS_IN + 8} minutes. Ctrl+C stops it.
==============================================================
`);

  // The pretend host: opens each code at an unpredictable moment, shows it, reveals it afterwards.
  const waitUntil = async (ms: number) => {
    while ((await view.now()) < ms) await wait(1000);
  };
  await waitUntil(opens);
  log("check-in is open");
  let previousEnd = opens;
  for (let slot = 0; slot < SLOTS; slot++) {
    host.phase = slot === 0 ? "waiting" : "between";
    await waitUntil(previousEnd + between(slot === 0 ? 10_000 : 10_000, slot === 0 ? 30_000 : 20_000));
    const code = generateCode();
    await sb.call(organizer, bail.accountId, "open_slot", { event_id: 0, slot, commitment: toBase64(codeCommitment(bail.accountId, 0, slot, code)) });
    const opened = (await view.event(0))!.slots[slot]!.opened_at_ms;
    host.phase = "live";
    host.slot = slot;
    host.code = code;
    host.windowEnd = opened + WINDOW;
    log(`code ${slot + 1} is live: ${code}`);
    await wait(between(3000, 8000));
    for (const guest of guests.filter((g) => g.catches)) {
      await relayerClient.submit(guest.ticket.catch(bail.accountId, 0, slot, 1, code)).catch(() => {});
    }
    await waitUntil(opened + WINDOW);
    host.phase = "between";
    host.code = null;
    await sb.call(organizer, bail.accountId, "reveal", { event_id: 0, slot, code });
    previousEnd = opened + WINDOW;
  }
  host.phase = "over";
  log("all codes shown and revealed; the dispute window and settlement follow");
  await new Promise(() => {}); // keep serving until Ctrl+C
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
