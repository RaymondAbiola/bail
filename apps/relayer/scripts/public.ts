// Puts the relayer, keeper and web app on the internet for an event, through two Cloudflare
// quick tunnels (no account needed), and keeps your machine awake while it runs.
//
//   npm run public -w @bail/relayer -- --event 3 --title "Builders check-in" --call-url https://...
//
// Needs apps/relayer/.env (see the README) and a working `cloudflared` (or CLOUDFLARED=<path>).
// Stop everything with Ctrl+C.
// Quick tunnel addresses change every time they start, so attendees need the address printed
// at the end, and if a tunnel restarts the new address is printed again.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { AddressTracker, siteConfig, siteServer, tunnelUrl } from "../src/public.ts";

const relayerDir = new URL("../", import.meta.url).pathname;
const webDir = join(relayerDir, "../web");

const { values } = parseArgs({
  options: {
    event: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    "call-url": { type: "string" },
    port: { type: "string", default: "8787" },
    "close-delay-minutes": { type: "string", default: "360" },
    explorer: { type: "string", default: "https://testnet.nearblocks.io" },
  },
});

const log = (line: string) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`);
const stop: (() => void)[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string): never {
  console.error(`public: ${message}`);
  for (const f of stop) f();
  process.exit(1);
}

async function until<T>(what: string, seconds: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  for (let i = 0; i < seconds; i++) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await wait(1000);
  }
  return fail(`${what} did not come up within ${seconds} seconds`);
}

// 1. Preflight: everything that can be checked before anything starts.
const cloudflared = process.env.CLOUDFLARED ?? "cloudflared";
try {
  execFileSync(cloudflared, ["--version"], { stdio: "pipe" });
} catch {
  fail(
    `${cloudflared} does not run. Install it from https://github.com/cloudflare/cloudflared/releases, check its file is complete and executable (chmod +x), or set CLOUDFLARED=<path>.`,
  );
}
const envFile = join(relayerDir, ".env");
if (!existsSync(envFile)) fail("apps/relayer/.env is missing. Create it with `npm run keys -w @bail/relayer` (see apps/relayer/README.md).");
const names = new Set(readFileSync(envFile, "utf8").split("\n").map((l) => l.split("=")[0]!.trim()));
for (const name of ["RELAYER_ACCOUNT", "RELAYER_KEYS", "SPONSOR_ACCOUNT", "SPONSOR_KEY"]) {
  if (!names.has(name)) fail(`apps/relayer/.env has no ${name}`);
}

// 2. Keep the machine awake: a dead laptop is the most likely way for an event to fail.
const inhibitor = spawn("systemd-inhibit", ["--what=sleep:idle", "--who=bail", "--why=Bail event is running", "--mode=block", "sleep", "infinity"], {
  stdio: "ignore",
});
inhibitor.on("error", () => log("systemd-inhibit is not available: turn off sleep and lid-close suspend yourself"));
stop.push(() => inhibitor.kill());

// 3. Build the site into its own folder, so the repository's copy is never touched.
log("building the web app...");
const dist = mkdtempSync(join(tmpdir(), "bail-public-"));
try {
  execFileSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], { cwd: webDir, stdio: "pipe" });
} catch (error) {
  fail(`the web app did not build: ${(error as { stderr?: Buffer }).stderr?.toString().slice(-600) ?? error}`);
}

// 4. The relayer and keeper, using the keys in .env. Their values are never printed.
const port = Number(values.port);
const relayer = spawn("node", ["--env-file=.env", "src/main.ts"], {
  cwd: relayerDir,
  env: { ...process.env, PORT: String(port), KEEPER_CLOSE_DELAY_MINUTES: values["close-delay-minutes"]! },
  stdio: ["ignore", "inherit", "inherit"],
});
relayer.on("exit", (code) => fail(`the relayer stopped (exit ${code}). Scroll up for why.`));
stop.push(() => relayer.kill());
await until("the relayer", 30, async () => (await fetch(`http://127.0.0.1:${port}/v1/health`)).ok);
log("relayer is up");

// 5. A tunnel that restarts itself and reports its (new) address each time.
function openTunnel(name: string, target: string, onUrl: (url: string) => void): void {
  let child: ChildProcess | undefined;
  let stopping = false;
  const start = () => {
    child = spawn(cloudflared, ["tunnel", "--no-autoupdate", "--url", target], { stdio: ["ignore", "ignore", "pipe"] });
    let buffer = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const url = tunnelUrl(line);
        if (url) onUrl(url);
      }
    });
    child.on("exit", () => {
      if (stopping) return;
      log(`the ${name} tunnel stopped; restarting in 3 seconds`);
      setTimeout(start, 3000);
    });
  };
  start();
  stop.push(() => {
    stopping = true;
    child?.kill();
  });
}

const firstUrl = (name: string, target: string) =>
  new Promise<{ url: string }>((resolve) => {
    const tracker = new AddressTracker();
    const holder = { url: "" };
    openTunnel(name, target, (url) => {
      const seen = tracker.see(url);
      holder.url = url;
      if (seen === "first") resolve(holder);
      else if (seen === "changed") {
        log(`NEW ${name.toUpperCase()} ADDRESS: ${url}`);
        onRestart(name, url);
      }
    });
  });

let siteAddress = "";
let relayerAddress = "";
const meta = values.title || values.description || values["call-url"];
const events = values.event && meta ? { [values.event]: { title: values.title, description: values.description, callUrl: values["call-url"] } } : undefined;
const writeConfig = () =>
  writeFileSync(
    join(dist, "config.json"),
    siteConfig({
      relayerUrl: relayerAddress,
      explorerUrl: values.explorer,
      defaultEventId: values.event === undefined ? null : Number(values.event),
      events,
    }),
  );
function onRestart(name: string, url: string): void {
  if (name === "relayer") {
    relayerAddress = url;
    writeConfig();
    log("the site's config now points at the new relayer address. Attendees need to reload the page.");
  } else {
    siteAddress = url;
    log(`share this instead: ${url}`);
  }
}

const relayerTunnel = await Promise.race([firstUrl("relayer", `http://127.0.0.1:${port}`), wait(40_000).then(() => null)]);
if (!relayerTunnel) fail("the relayer tunnel did not announce an address within 40 seconds");
relayerAddress = relayerTunnel.url;
writeConfig();

const site = siteServer(dist);
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
stop.push(() => site.close());
const sitePort = (site.address() as AddressInfo).port;
const siteTunnel = await Promise.race([firstUrl("site", `http://127.0.0.1:${sitePort}`), wait(40_000).then(() => null)]);
if (!siteTunnel) fail("the site tunnel did not announce an address within 40 seconds");
siteAddress = siteTunnel.url;

// 6. Check both public addresses the way an attendee's phone will use them.
const publicHealth = await until("the relayer's public address", 60, async () => {
  const response = await fetch(`${relayerAddress}/v1/health`, { signal: AbortSignal.timeout(8000) });
  return response.ok ? ((await response.json()) as { contract: string; faucet: boolean }) : null;
});
const publicConfig = await until("the site's public address", 60, async () => {
  const response = await fetch(`${siteAddress}/config.json`, { signal: AbortSignal.timeout(8000) });
  return response.ok ? ((await response.json()) as { relayerUrl: string }) : null;
});
if (publicConfig.relayerUrl !== relayerAddress) fail("the site's config does not point at the relayer's public address");
if (!publicHealth.faucet) log("WARNING: the relayer has no faucet, so new attendees cannot get test USDC");
const page = await fetch(siteAddress, { signal: AbortSignal.timeout(8000) });
if (!page.ok || !(await page.text()).includes('id="root"')) fail("the site's public address did not serve the app");

const eventLink = values.event === undefined ? siteAddress : `${siteAddress}/#/event/${values.event}`;
console.log(`
============================================================
  Bail is public. Both addresses answered from the internet.

  Send attendees:   ${eventLink}
  Relayer:          ${relayerAddress}
  Contract:         ${publicHealth.contract}

  Keep this window open and the machine on power. Ctrl+C stops it.
  These addresses change if you stop and start again.
============================================================
`);

process.on("SIGINT", () => {
  for (const f of stop) f();
  process.exit(0);
});
process.on("SIGTERM", () => {
  for (const f of stop) f();
  process.exit(0);
});
await new Promise(() => {});
