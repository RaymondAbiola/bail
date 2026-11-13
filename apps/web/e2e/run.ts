// Drives the built web app in headless Chrome at phone size against a private NEAR node with the
// real contract, relayer and keeper: RSVP from a fresh browser, key backup and restore, live
// codes with a typo and a correction, a flag, vouching, and payouts.
//
//   NEAR_SANDBOX_BIN=<path to near-sandbox> CHROME_PATH=<chrome> npm run e2e -w @bail/web
//
// Needs target/near/bail/bail.wasm and target/near/test_token/test_token.wasm, and takes
// screenshots into E2E_SHOTS if set.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { NearChain, RELAYER_METHODS, Sender } from "@bail/relayer/src/chain.ts";
import { Keeper } from "@bail/relayer/src/keeper.ts";
import { Sponsor } from "@bail/relayer/src/onboarding.ts";
import { relayerServer } from "@bail/relayer/src/server.ts";
import { BailView, RelayerClient, Ticket, codeCommitment, rsvpDelegate, toBase64 } from "@bail/sdk";
import { MINUTE, type Sandbox, USDC, startSandbox } from "@bail/testkit";
import { KeyPair, actions } from "near-api-js";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer-core";

import { makeEvent } from "../test/fixtures.ts";
import { localDateTime } from "../src/lib/host-plan.ts";
import { HostStore } from "../src/lib/host-record.ts";
import type { HostTransaction } from "../src/lib/organizer-wallet.ts";

const webDir = new URL("../", import.meta.url).pathname;
const bin = process.env.NEAR_SANDBOX_BIN;
if (!bin) throw new Error("set NEAR_SANDBOX_BIN to the near-sandbox binary");
const chrome =
  process.env.CHROME_PATH ??
  ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => existsSync(p));
if (!chrome) throw new Error("set CHROME_PATH to a Chrome or Chromium binary");
const shots = process.env.E2E_SHOTS ?? "";
if (shots) mkdirSync(shots, { recursive: true });

const CODE_A = "tiger maple seven ocean lamp";
const CODE_B = "abandon ability able about above";
const LETTER_CODE = Array.from({ length: 30 }, () => "a").join(" ");
const WINDOW = 5 * MINUTE;
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (name: string) => console.log(`\n== ${name}`);

async function shot(page: Page, name: string) {
  if (shots) {
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
    await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
  }
}

const text = (page: Page) => page.evaluate(() => document.body.innerText);

const failureText = (page: Page) => page.evaluate(() => {
  let message = document.body.innerText;
  for (const element of document.querySelectorAll('[data-testid="host-live-code"], [data-testid="ticket-key"]')) {
    if (element.textContent) message = message.replaceAll(element.textContent, "[private value hidden]");
  }
  return message.slice(0, 1500);
});

async function waitText(page: Page, expected: string, timeout = 60_000) {
  try {
    await page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), { timeout }, expected);
  } catch {
    throw new Error(`timed out waiting for "${expected}". The page said:\n${await failureText(page)}`);
  }
}

async function waitAny(page: Page, options: string[], timeout = 60_000) {
  try {
    await page.waitForFunction((list) => list.some((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase())), { timeout }, options);
  } catch {
    throw new Error(`timed out waiting for any of ${JSON.stringify(options)}. The page said:\n${await failureText(page)}`);
  }
}

async function clickText(page: Page, label: string, timeout = 60_000) {
  await page.waitForFunction(
    (t) => [...document.querySelectorAll<HTMLElement>("button, a")].some((e) => e.textContent?.trim().startsWith(t) && !(e as HTMLButtonElement).disabled),
    { timeout },
    label,
  );
  await page.evaluate((t) => {
    [...document.querySelectorAll<HTMLElement>("button, a")].find((e) => e.textContent?.trim().startsWith(t) && !(e as HTMLButtonElement).disabled)!.click();
  }, label);
}

/** The app reads chain time rarely; after jumping the node's clock, nudge it to re-read. */
const nudge = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

async function main() {
  step("build the web app and serve it");
  const dist = mkdtempSync(join(tmpdir(), "bail-web-"));
  execFileSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], { cwd: webDir, stdio: "ignore" });

  let sandbox: Sandbox | undefined;
  let browser: Browser | undefined;
  const closers: (() => void)[] = [];
  try {
    const sb = (sandbox = await startSandbox(bin!));
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
    await sb.fund(usdc, [faucet], 20n * USDC);

    const view = new BailView({ contractId: bail.accountId, rpcUrl: sb.rpcUrl });
    const chain = new NearChain({ accountId: relayer.accountId, contractId: bail.accountId, rpcUrl: sb.rpcUrl, keys: relayerKeys.map(String) });
    const sponsor = new Sponsor(new Sender({ accountId: faucet.accountId, rpcUrl: sb.rpcUrl, keys: [sponsorKey.toString()] }), usdc.accountId, view);
    const http = relayerServer({ chain, view, contractId: bail.accountId, sponsor, log: () => {} });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    closers.push(() => http.close());
    const relayerUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const relayerClient = new RelayerClient(relayerUrl);

    writeFileSync(
      join(dist, "config.json"),
      JSON.stringify({ relayerUrl, rpcUrl: sb.rpcUrl, contractId: bail.accountId, token: usdc.accountId, defaultEventId: 0 }),
    );
    const site = createServer((req, res) => {
      const path = !req.url || req.url === "/" ? "/index.html" : req.url.split("?")[0]!;
      try {
        const body = readFileSync(join(dist, path));
        res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" }).end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    closers.push(() => site.close());
    const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

    // Event 0: two codes, one needed. Check-in opens three minutes from now.
    step("create the event");
    const t0 = await view.now();
    const opens = t0 + 3 * MINUTE;
    await sb.call(organizer, bail.accountId, "create_event", {
      event: {
        token: usdc.accountId, deposit: String(USDC), capacity: 6, arbiter: arbiter.accountId,
        cancel_cutoff_ms: t0 + MINUTE, rsvp_closes_at_ms: opens, checkin_opens_at_ms: opens,
        checkin_closes_at_ms: opens + 12 * MINUTE, reveal_ms: MINUTE, dispute_ms: MINUTE,
        checkin: { slots: 2, required: 1, window_ms: WINDOW },
      },
    }, BigInt(await view.storageCost(6)));

    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport(PHONE);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

    step("historical results load without a featured event or a working relayer");
    const historyPage = await (await browser.createBrowserContext()).newPage();
    await historyPage.setViewport(PHONE);
    const historyErrors: string[] = [];
    historyPage.on("pageerror", (e) => historyErrors.push(String(e)));
    let failedHistory = false;
    let changedHistory = false;
    let daoState: "settled" | "pending" | "missing" | "error" = "settled";
    let relayerRequests = 0;
    await historyPage.setRequestInterception(true);
    historyPage.on("request", (request) => {
      if (request.url().startsWith(relayerUrl)) relayerRequests++;
      if (request.url().endsWith("/config.json")) {
        void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ relayerUrl, rpcUrl: sb.rpcUrl, contractId: bail.accountId, token: usdc.accountId, explorerUrl: "https://explorer.example" }) });
        return;
      }
      const body = request.postData();
      if (request.url() === sb.rpcUrl + "/" && body) {
        const rpc = JSON.parse(body);
        if (rpc.params?.method_name === "get_event") {
          const id = JSON.parse(Buffer.from(rpc.params.args_base64, "base64").toString()).event_id;
          if (id === 6) {
            // Different seats, amount and arbiter prove the demo reads Bail's state.
            const fixture = daoState === "missing" ? null : makeEvent({ status: "Voided", closed: true, registered: 0, deposit: "750000", arbiter: "council.sputnikv2.testnet", tally: daoState === "pending" ? null : {
              stage: "Done", cursor: 0, paid_cursor: 0, attended: 0, vouched: 0, forfeited: 0, refunded: 4,
              pool: "0", bonus: "0", fee: "0", dust: "0", everyone_refunded: true, measured: true, new_records: 0,
            } });
            const response = daoState === "error" ? { error: { message: "Demo unavailable" } } : { result: { result: [...Buffer.from(JSON.stringify(fixture))] } };
            void request.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...response }) });
            return;
          }
          if (id === 4 || id === 5) {
            if (failedHistory && id === 4) {
              void request.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { message: "Results unavailable" } }) });
              return;
            }
            // Deliberately differ from the published events to catch hard-coded metrics.
            const attended = id === 4 ? changedHistory ? 3 : 2 : 4;
            const forfeited = id === 4 ? 2 : 3;
            const fixture = makeEvent({ closed: true, registered: 0, deposit: "500000", tally: {
              stage: "Done", cursor: 0, paid_cursor: 0, attended, vouched: 0, forfeited, refunded: 0,
              pool: "1000000", bonus: "123456", fee: "0", dust: "0", everyone_refunded: false, measured: true, new_records: 0,
            } });
            void request.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { result: [...Buffer.from(JSON.stringify(fixture))] } }) });
            return;
          }
        }
      }
      void request.continue();
    });
    await historyPage.goto(`${siteUrl}/`, { waitUntil: "domcontentloaded" });
    await waitText(historyPage, "6 tickets qualified by codes; 5 forfeited");
    await waitText(historyPage, "0.623456 test USDC");
    await waitText(historyPage, "0.75 test USDC each");
    const daoSummary = await historyPage.$eval(".dao-demo", (el) => el.textContent);
    assert.match(daoSummary!, /attendees in this demo were scripted, not real people/);
    assert.match(daoSummary!, /2 of 2 council votes/);
    assert.doesNotMatch(daoSummary!, /Due per attendee|No code-qualified attendees/);
    assert.deepEqual(await historyPage.$$eval(".dao-demo-stats > div", (rows) => rows.map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent])), [
      ["Status", "Voided"], ["Seats", "4"], ["Refunded", "4"], ["Refunded per ticket", "0.75 test USDC each"], ["Arbiter", "council.sputnikv2.testnet"],
    ]);
    assert.equal(await historyPage.$eval('.dao-demo a[href="#/event/6/organizer"]', (a) => a.getAttribute("href")), "#/event/6/organizer");
    assert.equal(await historyPage.$eval('.dao-demo a[href*="/address/"]', (a) => a.getAttribute("href")), "https://explorer.example/address/council.sputnikv2.testnet");
    assert.equal(await historyPage.$eval('.dao-demo a[href*="github.com"]', (a) => a.getAttribute("href")), "https://github.com/RaymondAbiola/bail/blob/main/docs/dao-arbiter-event.md");
    assert.equal(await historyPage.$eval('a[href="#/event/4/organizer"]', (a) => a.getAttribute("href")), "#/event/4/organizer");
    assert.equal(await historyPage.$eval('a[href="#/event/5/organizer"]', (a) => a.getAttribute("href")), "#/event/5/organizer");
    for (const width of [320, 390, 1440]) {
      await historyPage.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      await waitText(historyPage, "6 tickets qualified by codes; 5 forfeited");
      assert.ok(await historyPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `past-event results fit ${width}px`);
      await shot(historyPage, `00-past-events-${width}`);
    }
    changedHistory = true;
    await historyPage.reload({ waitUntil: "domcontentloaded" });
    await waitText(historyPage, "7 tickets qualified by codes; 5 forfeited");
    failedHistory = true;
    await historyPage.reload({ waitUntil: "domcontentloaded" });
    await waitText(historyPage, "Results could not be read");
    assert.doesNotMatch(await text(historyPage), /7 tickets qualified by codes/);
    await waitText(historyPage, "0.623456 test USDC");
    await waitText(historyPage, "0.75 test USDC each");
    for (const state of ["pending", "missing", "error"] as const) {
      daoState = state;
      await historyPage.reload({ waitUntil: "domcontentloaded" });
      await waitText(historyPage, state === "pending" ? "The tally is not settled yet" : state === "missing" ? "This demo is not available" : "Demo results could not be read");
      assert.doesNotMatch(await historyPage.$eval(".dao-demo", (el) => el.textContent!), /0.75 test USDC each/);
      await waitText(historyPage, "0.623456 test USDC");
    }
    daoState = "settled";
    await clickText(historyPage, "Retry demo results");
    await waitText(historyPage, "0.75 test USDC each");
    assert.equal(relayerRequests, 0, "public results need no relayer requests");
    assert.deepEqual(historyErrors, []);
    await historyPage.close();

    step("the landing page and its event finder");
    await page.goto(`${siteUrl}/`, { waitUntil: "domcontentloaded" });
    await waitText(page, "Put a little down.");
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await shot(page, "00-landing-desktop");
    await clickText(page, "Send code");
    await waitText(page, "Demo sent. A real catch is confirmed after reveal.");
    for (const width of [320, 390, 768]) {
      await page.setViewport({ ...PHONE, width });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `landing page fits ${width}px`);
    }
    await page.setViewport(PHONE);
    await shot(page, "00-landing-phone");
    await clickText(page, "See how it works");
    await page.waitForFunction(() => document.getElementById("how-it-works")!.getBoundingClientRect().top < 40);
    await clickText(page, "Find your event");
    await page.type("#event", "0");
    await clickText(page, "Open event");

    step("the event page, before any ticket");
    await waitText(page, "RSVP with test USDC");
    assert.match(await text(page), /Event #0/);
    assert.match(await text(page), /1 test USDC/);
    await shot(page, "01-event-page");

    step("RSVP from a fresh browser: terms, backup, payment");
    await clickText(page, "RSVP with test USDC");
    await waitText(page, "Before you pay");
    await shot(page, "02-terms");
    const createButton = async () => page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Create my ticket key"))!.disabled);
    assert.equal(await createButton(), true, "creating a key needs the explicit agreement");
    await page.click('input[type="checkbox"]');
    await page.click('input[name="payout"]:not(:checked)');
    await page.type("#account", "missing");
    await waitText(page, "There is no NEAR account called missing.");
    assert.equal(await createButton(), true, "a missing payout account blocks continuing");
    await shot(page, "02-missing-payout-account");
    await page.click("#account", { count: 3 });
    await page.keyboard.press("Backspace");
    await page.type("#account", organizer.accountId);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Create my ticket key") && !b.disabled));
    await page.click('input[name="payout"]:not(:checked)');

    step("creating a key keeps the backup screen visible while old and new chain reads overlap");
    const eventBeforeKey = (await view.event(0))!;
    const isEventRead = (request: HTTPRequest) => {
      if (request.url() !== sb.rpcUrl + "/" || !request.postData()) return false;
      const rpc = JSON.parse(request.postData()!);
      return rpc.params?.method_name === "get_event" && JSON.parse(Buffer.from(rpc.params.args_base64, "base64").toString()).event_id === 0;
    };
    const heldReads: HTTPRequest[] = [];
    const holdEventReads = (request: HTTPRequest) => {
      if (isEventRead(request)) heldReads.push(request);
      else void request.continue();
    };
    await page.setRequestInterception(true);
    page.on("request", holdEventReads);
    const oldRead = page.waitForRequest(isEventRead);
    await nudge(page);
    await oldRead;
    const loadingWatch = await page.evaluateHandle(() => {
      const state = { appeared: false };
      const observer = new MutationObserver(() => { state.appeared ||= !!document.querySelector('[aria-label="Loading the event"]'); });
      observer.observe(document.body, { childList: true, subtree: true });
      return { state, observer };
    });
    // This must start before the old request finishes, without waiting for the 6-second poll.
    const keyRead = page.waitForRequest(isEventRead, { timeout: 3000 });
    await clickText(page, "Create my ticket key");
    await keyRead;
    await waitText(page, "Save your ticket key");
    await shot(page, "03-backup");
    assert.equal(await loadingWatch.evaluate(({ state }) => state.appeared), false, "a dependency reload never replaces the page with a skeleton");
    const backupHeading = (await page.$("#backup-title"))!;
    const continueDisabled = async () => {
      await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Continue to payment")), { timeout: 60_000 });
      return page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Continue to payment"))!.disabled);
    };
    assert.equal(await continueDisabled(), true, "continuing needs the explicit acknowledgement");
    assert.doesNotMatch(await text(page), /ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/, "the key is hidden until asked for");
    await clickText(page, "Show key");
    const backup = await page.$eval('[data-testid="ticket-key"]', (el) => el.textContent ?? "");
    const alice = Ticket.restore(backup);
    await page.click('input[type="checkbox"]');

    const respondToRead = (request: HTTPRequest, result: object) => request.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: "get_event", result: { result: [...Buffer.from(JSON.stringify(result))] } }) });
    const afterPaint = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const oldReadFinished = page.waitForResponse((response) => response.request() === heldReads[0]);
    await respondToRead(heldReads[0]!, { ...eventBeforeKey, arbiter: "stale-poll.testnet" });
    await (await oldReadFinished).text();
    await afterPaint();
    assert.doesNotMatch(await page.$eval(".event-page", (el) => el.textContent!), /stale-poll\.testnet/, "the old read cannot overwrite data for the new ticket key");
    await nudge(page);
    await afterPaint();
    assert.equal(heldReads.length, 2, "finishing the old read must not unlock the new read");
    const ticketRead = page.waitForResponse((response) => JSON.parse(response.request().postData() ?? "{}").params?.method_name === "get_ticket");
    await respondToRead(heldReads[1]!, eventBeforeKey);
    await (await ticketRead).text();
    await afterPaint();
    assert.equal(await backupHeading.evaluate((heading) => heading.isConnected), true, "the backup stays mounted when the reload completes");
    assert.equal(await continueDisabled(), false, "the saved-key acknowledgement survives the reload");
    assert.equal(await loadingWatch.evaluate(({ state, observer }) => { observer.disconnect(); return state.appeared; }), false);
    await loadingWatch.dispose();
    await backupHeading.dispose();
    page.off("request", holdEventReads);
    await page.setRequestInterception(false);
    await clickText(page, "Continue to payment");
    await waitText(page, "Pay your deposit");
    await shot(page, "04-pay");
    await clickText(page, "Pay 1 test USDC");
    await waitText(page, "You're in", 90_000);
    await shot(page, "05-seated");
    assert.ok(await view.ticket(0, alice.publicKey), "the chain shows Alice's seat");
    assert.equal(await sb.balance(usdc.accountId, alice.accountId), 0n, "the deposit left her account");
    assert.equal((await view.event(0))!.registered, 1);

    step("the ticket survives a reload, and the key never appears in the page address");
    await page.reload({ waitUntil: "domcontentloaded" });
    await clickText(page, "Open my ticket").catch(() => {});
    await waitText(page, "You're in");
    await waitText(page, "Check-in opens");
    assert.ok(!page.url().includes("ed25519"), "no key in the URL");
    await shot(page, "06-ticket-open-phase");

    step("restore the same ticket in a second, empty browser");
    const other = await (await browser.createBrowserContext()).newPage();
    await other.setViewport(PHONE);
    await other.goto(`${siteUrl}/#/event/0/restore`, { waitUntil: "domcontentloaded" });
    await other.type("#key", "ed25519:notakey");
    await clickText(other, "Check this key");
    await waitText(other, "not a valid ticket key");
    await other.click("#key", { count: 3 });
    await other.keyboard.press("Backspace");
    await other.type("#key", backup);
    await clickText(other, "Check this key");
    await waitText(other, "has a seat in this event");
    await clickText(other, "Use this ticket");
    await waitText(other, "You're in");
    await other.close();

    step("other attendees RSVP through the relayer");
    const guests = { bob: Ticket.generate(), carol: Ticket.generate(), dave: Ticket.generate() };
    for (const guest of Object.values(guests)) {
      await relayerClient.faucet(guest.accountId, 0);
      const nonce = (await view.accessKeyNonce(guest.accountId, guest.publicKey))!;
      const { seated } = await relayerClient.meta(0, guest.signDelegate(rsvpDelegate({
        publicKey: guest.publicKey, token: usdc.accountId, contractId: bail.accountId, deposit: String(USDC),
        note: guest.rsvpNote(0, `near:${guest.accountId}`), nonce: nonce + 1n, maxBlockHeight: (await view.finalHeight()) + 600n,
      })));
      assert.equal(seated, true);
    }
    assert.equal((await view.event(0))!.registered, 4);

    step("check-in opens: the page waits for the first code");
    await sb.advanceTo(view, opens);
    await nudge(page);
    await waitText(page, "Waiting for the next code");
    await shot(page, "07-waiting");

    step("the first code goes live");
    await sb.call(organizer, bail.accountId, "open_slot", { event_id: 0, slot: 0, commitment: toBase64(codeCommitment(bail.accountId, 0, 0, CODE_A)) });
    await waitText(page, "Code 1 of 2 is live");
    await wait(500);
    const fold = await page.evaluate(() => {
      const send = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Send code"))!.getBoundingClientRect();
      return { bottom: Math.round(send.bottom), height: window.innerHeight };
    });
    assert.ok(fold.bottom <= fold.height, `the Send button is on screen the moment a code goes live: ${JSON.stringify(fold)}`);
    await shot(page, "08-live-code");
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await waitText(page, "Code 1 of 2 is live");
    await shot(page, "08-live-code-desktop");

    // At 320 wide with the keyboard open, the input, status and button must stay reachable.
    await page.setViewport({ width: 320, height: 330, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await waitText(page, "Code 1 of 2 is live");
    await page.focus("#code");
    await wait(500); // the card slides in over 240 ms; measure once it has settled
    const layout = await page.evaluate(() => {
      const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const input = box("#code");
      const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Send code"))!.getBoundingClientRect();
      const title = box("#live-title");
      const r = (b: DOMRect) => ({ top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) });
      return { input: r(input), button: r(button), title: r(title), width: document.documentElement.scrollWidth, view: window.innerWidth };
    });
    assert.ok(layout.width <= layout.view, "no sideways scrolling at 320px");
    assert.ok(layout.title.bottom <= layout.input.top && layout.input.bottom <= layout.button.top, `status, input and button stack without overlap: ${JSON.stringify(layout)}`);
    assert.ok(layout.button.height >= 44, "the button is a comfortable tap target");
    await shot(page, "09-live-code-320-keyboard");
    await page.setViewport(PHONE);

    step("a letter-by-letter paste is warned about without blocking Send");
    await page.type("#code", LETTER_CODE);
    await waitText(page, "That is 30 words. A code is five words.");
    await waitText(page, "These look like single letters. Codes are whole words.");
    assert.equal(await page.$eval('button[type="submit"]', (button) => (button as HTMLButtonElement).disabled), false);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "warnings fit a phone");
    await shot(page, "09-letter-paste-warning");
    await page.click("#code", { count: 3 });
    await page.keyboard.press("Backspace");

    step("suggestions never take focus from the input");
    await page.click("#code");
    await page.type("#code", "ti");
    await page.waitForSelector(".suggest");
    assert.ok((await page.$$eval(".suggest", (b) => b.map((x) => x.textContent))).includes("tiger"));
    // A real mouse press, not a script click, so a suggestion that grabbed focus would be caught.
    for (const candidate of await page.$$(".suggest")) {
      if ((await candidate.evaluate((e) => e.textContent)) === "tiger") await candidate.click();
    }
    assert.equal(await page.$eval("#code", (el) => (el as HTMLInputElement).value), "tiger ");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "code", "focus stayed in the input");

    step("a typo is sent, then corrected with a higher attempt");
    await page.type("#code", "mapel seven ocean lamp");
    await waitText(page, 'Check the spelling of "mapel"');
    await shot(page, "10-typo-hint");
    await clickText(page, "Send code");
    await waitText(page, "Confirmation comes after the host reveals the code");
    assert.equal((await view.ticket(0, alice.publicKey))!.catches[0]!.attempt, 1);
    await page.click("#code", { count: 3 });
    await page.keyboard.press("Backspace");
    await page.type("#code", CODE_A.toUpperCase());
    assert.match(await text(page), /Sending again replaces your earlier submission/);
    await clickText(page, "Resubmit corrected code");
    for (let i = 0; i < 30; i++) {
      if ((await view.ticket(0, alice.publicKey))!.catches[0]!.attempt === 2) break;
      await wait(500);
    }
    assert.equal((await view.ticket(0, alice.publicKey))!.catches[0]!.attempt, 2, "the correction landed as attempt 2");
    await shot(page, "11-resubmitted");

    // Carol catches it through the relayer; Dave will send a malformed paste below.
    await relayerClient.submit(guests.carol.catch(bail.accountId, 0, 0, 1, CODE_A));

    step("another attendee sends the malformed paste despite the warning");
    const mistaken = await (await browser.createBrowserContext()).newPage();
    await mistaken.setViewport(PHONE);
    await mistaken.goto(`${siteUrl}/#/event/0/restore`, { waitUntil: "domcontentloaded" });
    await mistaken.type("#key", guests.dave.backup());
    await clickText(mistaken, "Check this key");
    await waitText(mistaken, "has a seat in this event");
    await clickText(mistaken, "Use this ticket");
    await waitText(mistaken, "Code 1 of 2 is live");
    await mistaken.type("#code", LETTER_CODE);
    await clickText(mistaken, "Send code");
    await waitText(mistaken, "Confirmation comes after the host reveals the code");

    step("the code is revealed and Alice's catch is confirmed");
    const opened0 = (await view.event(0))!.slots[0]!.opened_at_ms;
    await sb.advanceTo(view, opened0 + WINDOW);
    await sb.call(organizer, bail.accountId, "reveal", { event_id: 0, slot: 0, code: CODE_A });
    await nudge(page);
    await waitText(page, "Code 1: Confirmed");
    await shot(page, "12-confirmed");
    await nudge(mistaken);
    await waitText(mistaken, "Code 1: Not confirmed");
    await waitText(mistaken, `You sent: ${LETTER_CODE}`);
    await shot(mistaken, "12-not-confirmed-with-code");

    step("the second code opens and the host shows no code: Alice flags it");
    await sb.call(organizer, bail.accountId, "open_slot", { event_id: 0, slot: 1, commitment: toBase64(codeCommitment(bail.accountId, 0, 1, CODE_B)) });
    await waitText(page, "Code 2 of 2 is live");
    await waitText(mistaken, "Code 2 of 2 is live");
    await waitText(mistaken, `You sent: ${LETTER_CODE}`);
    await mistaken.close();
    await sb.advanceTo(view, (await view.event(0))!.slots[1]!.opened_at_ms + WINDOW);
    await nudge(page);
    await waitText(page, "Code 2: Window closed, no code sent");
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("summary")].find((e) => e.textContent?.includes("did not show a code"))!.click());
    await page.waitForSelector('details[open] input[type="checkbox"]');
    await page.click('details[open] input[type="checkbox"]');
    await clickText(page, "Send flag");
    await waitAny(page, ["The arbiter can see your flag", "You told the arbiter no code was shown"]);
    assert.equal((await view.event(0))!.slots[1]!.flags, 1, "the flag is on the chain");
    await shot(page, "13-flagged");

    step("check-in ends: Alice qualified, and vouches in the dispute window");
    await sb.call(organizer, bail.accountId, "reveal", { event_id: 0, slot: 1, code: CODE_B });
    const event = (await view.event(0))!;
    await sb.advanceTo(view, event.schedule.reveal_deadline_ms);
    await nudge(page);
    await waitText(page, "You qualified");
    await waitText(page, "Vouch for someone whose phone died");
    await shot(page, "14-vouch");
    await page.type("#target", guests.bob.publicKey);
    await clickText(page, "Vouch for this person");
    await waitAny(page, ["Vouch recorded", "You vouched for"]);
    await relayerClient.submit(guests.carol.vouch(bail.accountId, 0, guests.bob.publicKey));
    assert.equal((await view.ticket(0, guests.bob.publicKey))!.vouched_by, 2);

    step("settle: the keeper tallies and pays out, and Alice sees her result");
    await sb.advanceTo(view, event.schedule.dispute_ends_at_ms);
    const keeper = new Keeper({ chain, view, closeDelayMs: 60 * MINUTE, log: () => {} });
    await keeper.tick();
    await keeper.tick();
    assert.equal((await view.event(0))!.tally?.stage, "Done");
    await nudge(page);
    await waitText(page, "You attended");
    await waitText(page, "1.5 test USDC");
    await waitText(page, "Paid");
    await shot(page, "15-results");
    assert.equal(await sb.balance(usdc.accountId, alice.accountId), 3n * USDC / 2n);
    assert.equal(await sb.balance(usdc.accountId, guests.bob.accountId), USDC, "Bob was vouched for: deposit back, no bonus");
    assert.equal(await sb.balance(usdc.accountId, guests.carol.accountId), 3n * USDC / 2n);
    assert.equal(await sb.balance(usdc.accountId, guests.dave.accountId), 0n, "Dave forfeited");
    assert.equal(await sb.balance(usdc.accountId, bail.accountId), 0n, "the contract holds nothing back");

    step("the organizer view is public and read only");
    await page.goto(`${siteUrl}/#/event/0/organizer`, { waitUntil: "domcontentloaded" });
    await waitText(page, "Organizer view, event #0");
    await waitText(page, "Counts cover all 4 tickets read");
    assert.match(await text(page), /Attended\s*2/);
    await shot(page, "16-organizer");

    step("a page with no ticket still shows the public record");
    const stranger = await (await browser.createBrowserContext()).newPage();
    await stranger.setViewport(PHONE);
    await stranger.goto(`${siteUrl}/#/event/0`, { waitUntil: "domcontentloaded" });
    await waitText(stranger, "This event has finished");
    await waitText(stranger, "1.5 test USDC");
    assert.doesNotMatch(await text(stranger), /Your next commitment|Your seat awaits|Seats left|Can't RSVP/i);
    assert.deepEqual(await stranger.$$eval('.ticket .facts > div', (rows) => Object.fromEntries(rows.map((row) => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent]))), {
      "Seats taken": "4", Attended: "2", Vouched: "1", Forfeited: "1", Refunded: "0", Deposit: "1 test USDC", "Due per attendee who qualified by codes": "1.5 test USDC",
    });
    await shot(stranger, "16-finished-visitor");
    await clickText(stranger, "View public record");
    await waitText(stranger, "Organizer view, event #0");
    await stranger.goto(`${siteUrl}/#/event/0/rsvp`, { waitUntil: "domcontentloaded" });
    await waitText(stranger, "This event has finished");
    assert.doesNotMatch(await text(stranger), /Before you pay|Your seat awaits|Seats left/);
    await clickText(stranger, "Restore my ticket");
    await stranger.waitForSelector("#key");
    await stranger.type("#key", alice.backup());
    await clickText(stranger, "Check this key");
    await waitText(stranger, "has a seat in this event");
    await clickText(stranger, "Use this ticket");
    await waitText(stranger, "You attended");
    await waitText(stranger, "Paid");

    step("a closed event still shows public results on a fresh device");
    await sb.call(organizer, bail.accountId, "close_event", { event_id: 0, limit: 100 });
    assert.equal((await view.event(0))!.closed, true);
    const closedObserver = await (await browser.createBrowserContext()).newPage();
    await closedObserver.setViewport(PHONE);
    await closedObserver.goto(`${siteUrl}/#/event/0`, { waitUntil: "domcontentloaded" });
    await waitText(closedObserver, "This event has finished");
    await waitText(closedObserver, "1.5 test USDC");
    assert.doesNotMatch(await text(closedObserver), /Your next commitment|Your seat awaits|Seats left|Can't RSVP/i);
    assert.ok(await closedObserver.$('a[href="#/event/0/restore"]'));
    assert.ok(await closedObserver.$('a[href="#/event/0/organizer"]'));
    await shot(closedObserver, "16-closed-visitor");
    await closedObserver.close();
    await stranger.goto(`${siteUrl}/#/event/99`, { waitUntil: "domcontentloaded" });
    await waitText(stranger, "Event #99 not found");
    await shot(stranger, "17-not-found");

    step("attendee pages never load the organizer or wallet bundles");
    assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => /\/(Hosting-|build-)/.test(entry.name))), false);

    step("an organizer creates an event from the browser using the sandbox wallet");
    const hostPage = await (await browser.createBrowserContext()).newPage();
    await hostPage.setViewport(PHONE);
    const hostErrors: string[] = [];
    hostPage.on("pageerror", (error) => hostErrors.push(String(error)));
    const walletCalls: HostTransaction[] = [];
    await hostPage.exposeFunction("__bailSandboxSign", async (transaction: HostTransaction) => {
      walletCalls.push(transaction);
      const outcome = await organizer.signAndSendTransaction({ receiverId: transaction.receiverId, actions: transaction.actions.map(({ params }) => actions.functionCall(params.methodName, params.args, BigInt(params.gas), BigInt(params.deposit))) });
      // Meteor can execute successfully, crash its popup, and reject instead of returning an outcome.
      const params = transaction.actions[0]!.params;
      if (params.methodName !== "open_slot" || params.args.slot === 0) throw new Error("Wallet closed");
      return outcome;
    });
    await hostPage.evaluateOnNewDocument((accountId) => {
      window.__BAIL_TEST_WALLET__ = { accountId, signAndSendTransaction: (transaction) => (window as unknown as { __bailSandboxSign: (tx: typeof transaction) => Promise<unknown> }).__bailSandboxSign(transaction) };
    }, organizer.accountId);
    let failFirstReveal = true;
    const revealRequests: { slot: number; at: number }[] = [];
    const hostRequests: { url: string; body: string }[] = [];
    await hostPage.setRequestInterception(true);
    hostPage.on("request", (request) => {
      hostRequests.push({ url: request.url(), body: request.postData() ?? "" });
      if (request.url().endsWith("/config.json")) {
        void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ relayerUrl, rpcUrl: sb.rpcUrl, contractId: bail.accountId, token: usdc.accountId, testWallet: true }) });
      } else if (request.url() === `${relayerUrl}/v1/reveal` && request.method() === "POST") {
        const slot = JSON.parse(request.postData()!).slot as number;
        void view.now().then((at) => revealRequests.push({ slot, at }));
        if (failFirstReveal || slot === 1) {
          failFirstReveal = false;
          void request.respond({ status: 503, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: "Test relayer outage" }) });
        } else void request.continue();
      } else void request.continue();
    });
    await hostPage.goto(`${siteUrl}/#/host`, { waitUntil: "domcontentloaded" });
    await clickText(hostPage, "Connect NEAR wallet");
    await waitText(hostPage, organizer.accountId);
    const setField = async (selector: string, value: string) => {
      await hostPage.$eval(selector, (element, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    };
    const hostedOpens = (await view.now()) + 4 * MINUTE;
    await setField("#host-startsAt", localDateTime(hostedOpens));
    await setField("#host-slots", "2");
    await setField("#host-windowMinutes", "1");
    await setField("#host-checkinMinutes", "5");
    await setField("#host-capacity", "3");
    await setField("#host-title", "Browser community call");
    await setField("#host-callUrl", "https://meet.example/community");
    await setField("#host-arbiter", organizer.accountId);
    await waitText(hostPage, "The arbiter cannot be the organizer");
    await setField("#host-arbiter", arbiter.accountId);
    await waitText(hostPage, "Account exists on NEAR testnet");
    await hostPage.click(".host-advanced summary");
    await setField("#host-revealMinutes", "1");
    await setField("#host-disputeMinutes", "1");
    for (const width of [320, 390, 1440]) {
      await hostPage.setViewport({ ...PHONE, width, height: 1000, deviceScaleFactor: 1 });
      assert.ok(await hostPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `host form fits ${width}px`);
      await hostPage.evaluate(() => window.scrollTo(0, 0));
      await shot(hostPage, `18-host-create-${width}`);
    }
    await clickText(hostPage, "Create event");
    await waitText(hostPage, "Your event is on");
    assert.equal(await hostPage.$('[role="alert"]'), null, "creation succeeds on chain even when the wallet throws after sending");
    const hostedId = Number((await hostPage.$eval("#attendee-link", (input) => (input as HTMLInputElement).value)).match(/event\/(\d+)$/)![1]);
    assert.equal(hostedId, 1);
    const hosted = (await view.event(hostedId))!;
    assert.equal(hosted.organizer, organizer.accountId);
    assert.equal(hosted.arbiter, arbiter.accountId);
    assert.equal(hosted.deposit, "500000");
    assert.equal(hosted.capacity, 3);
    assert.deepEqual(hosted.checkin, { slots: 2, required: 2, window_ms: MINUTE });
    assert.equal(walletCalls.length, 1, "creating needs one ordinary wallet transaction");
    assert.equal(walletCalls[0]!.actions[0]!.params.deposit, await view.storageCost(3));
    const hostCodes = await hostPage.evaluate((key) => JSON.parse(localStorage.getItem(key)!).codes as string[], HostStore.key(bail.accountId, hostedId));
    assert.equal(hostCodes.length, 2);
    assert.ok(hostCodes.every((code) => !hostRequests.some((request) => request.url.includes(code) || request.body.includes(code))), "unopened codes never leave the browser");
    await clickText(hostPage, "Open the host screen");
    await clickText(hostPage, "Connect NEAR wallet");
    await waitText(hostPage, "Next up: code 1");
    assert.ok(hostCodes.every((code) => !hostRequests.some((request) => request.body.includes(code))), "the host route does not send unopened codes");
    assert.equal(await hostPage.evaluate((codes) => codes.some((code) => document.body.textContent!.includes(code)), hostCodes), false, "unopened codes are absent from the DOM, including hidden content");

    step("a fresh device explains the missing host record");
    const emptyHost = await (await browser.createBrowserContext()).newPage();
    await emptyHost.evaluateOnNewDocument((accountId) => { window.__BAIL_TEST_WALLET__ = { accountId, signAndSendTransaction: async () => { throw new Error("No signing on this device"); } }; }, organizer.accountId);
    await emptyHost.setRequestInterception(true);
    emptyHost.on("request", (request) => {
      if (request.url().endsWith("/config.json")) void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ relayerUrl, rpcUrl: sb.rpcUrl, contractId: bail.accountId, token: usdc.accountId, testWallet: true }) });
      else void request.continue();
    });
    await emptyHost.goto(`${siteUrl}/#/event/${hostedId}/host`, { waitUntil: "domcontentloaded" });
    await waitText(emptyHost, "The codes live on the creating device");
    assert.equal(await emptyHost.$("[data-testid=host-live-code]"), null);
    await emptyHost.close();

    step("an attendee RSVPs to the event created in the browser");
    const hostedAttendee = await (await browser.createBrowserContext()).newPage();
    await hostedAttendee.setViewport(PHONE);
    await hostedAttendee.goto(`${siteUrl}/#/event/${hostedId}/rsvp`, { waitUntil: "domcontentloaded" });
    await waitText(hostedAttendee, "Before you pay");
    assert.doesNotMatch(await text(hostedAttendee), /Browser community call|meet\.example/);
    await hostedAttendee.click('input[type="checkbox"]');
    await clickText(hostedAttendee, "Create my ticket key");
    await clickText(hostedAttendee, "Show key");
    const hostedTicket = Ticket.restore(await hostedAttendee.$eval('[data-testid="ticket-key"]', (element) => element.textContent!));
    await hostedAttendee.click('input[type="checkbox"]');
    await clickText(hostedAttendee, "Continue to payment");
    await clickText(hostedAttendee, "Pay 0.5 test USDC");
    await waitText(hostedAttendee, "You're in", 90_000);
    await clickText(hostedAttendee, "Open my ticket");

    step("only the host opens codes, and only the live code is displayed");
    await sb.advanceTo(view, hosted.schedule.checkin_opens_at_ms + 15_000);
    await nudge(hostPage); await nudge(hostedAttendee);
    await clickText(hostPage, "Open code 1");
    await hostPage.waitForSelector('[data-testid="host-live-code"]');
    await hostPage.waitForFunction(() => !document.body.innerText.includes("Checking the chain..."));
    assert.equal(await hostPage.$('[role="alert"]'), null, "opening succeeds on chain even when the wallet throws after sending");
    assert.equal(await hostPage.$eval('[data-testid="host-live-code"]', (element) => element.textContent!.split(" ").length), 5);
    assert.equal(await hostPage.evaluate((code) => document.body.textContent!.includes(code), hostCodes[1]!), false, "code 2 stays hidden while code 1 is live");
    assert.equal(walletCalls.length, 2);
    assert.ok(hostCodes.every((code) => !JSON.stringify(walletCalls).includes(code)), "wallet opening contains only commitments");
    for (const width of [320, 390, 1440]) {
      await hostPage.setViewport({ ...PHONE, width, height: 1000, deviceScaleFactor: 1 });
      assert.ok(await hostPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `live host code fits ${width}px`);
      await shot(hostPage, `19-host-live-${width}`);
    }
    await waitText(hostedAttendee, "Code 1 of 2 is live");
    await hostedAttendee.type("#code", hostCodes[0]!);
    await clickText(hostedAttendee, "Send code");
    await waitText(hostedAttendee, "Confirmation comes after the host reveals the code");

    step("closed windows reveal automatically, retry after reload, and fall back to the wallet");
    const firstOpened = (await view.event(hostedId))!.slots[0]!.opened_at_ms;
    await sb.advanceTo(view, firstOpened + MINUTE + 15_000);
    await nudge(hostPage);
    await waitText(hostPage, "Automatic reveal needs a retry");
    await hostPage.reload({ waitUntil: "domcontentloaded" });
    await hostPage.waitForFunction(() => document.querySelector(".host-code-status li strong")?.textContent === "Revealed");
    assert.equal(walletCalls.length, 2, "automatic reveal and its reload retry need no wallet approval");
    await clickText(hostPage, "Connect NEAR wallet");
    await clickText(hostPage, "Open code 2");
    await hostPage.waitForSelector('[data-testid="host-live-code"]');
    await nudge(hostedAttendee);
    await waitText(hostedAttendee, "Code 2 of 2 is live");
    await hostedAttendee.type("#code", hostCodes[1]!);
    await clickText(hostedAttendee, "Send code");
    await waitText(hostedAttendee, "Confirmation comes after the host reveals the code");
    const secondOpened = (await view.event(hostedId))!.slots[1]!.opened_at_ms;
    await sb.advanceTo(view, secondOpened + MINUTE + 15_000);
    await nudge(hostPage);
    await waitText(hostPage, "Automatic reveal needs a retry");
    await clickText(hostPage, "Reveal with wallet");
    await hostPage.waitForFunction(() => [...document.querySelectorAll(".host-code-status li strong")].every((element) => element.textContent === "Revealed"));
    await hostPage.waitForFunction(() => !document.body.innerText.includes("Checking the chain..."));
    assert.doesNotMatch(await text(hostPage), /Host action needs a check|Automatic reveal needs a retry|Wallet closed/, "a successful wallet reveal does not leave an alarming error");
    assert.equal(walletCalls.length, 4, "one creation, two opens, one explicit wallet reveal");
    assert.ok(revealRequests.length >= 3);
    assert.ok(revealRequests.every(({ slot, at }) => at >= (slot === 0 ? firstOpened : secondOpened) + MINUTE), "no reveal request is sent during a code window");
    assert.ok(hostRequests.every((request) => hostCodes.every((code) => !request.url.includes(code))), "codes never enter a URL");

    step("the browser-hosted event settles with the attendee paid");
    await sb.advanceTo(view, hosted.schedule.dispute_ends_at_ms);
    await keeper.tick(); await keeper.tick();
    await nudge(hostPage); await nudge(hostedAttendee);
    await waitText(hostedAttendee, "You attended");
    await waitText(hostedAttendee, "Paid");
    assert.equal((await view.event(hostedId))!.tally?.attended, 1);
    assert.equal(await sb.balance(usdc.accountId, hostedTicket.accountId), USDC / 2n);
    assert.deepEqual(hostErrors, []);
    await shot(hostedAttendee, "20-browser-hosted-results");
    await hostPage.close(); await hostedAttendee.close();

    assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], "no errors in the browser console");
    console.log("\nAll end-to-end checks passed.");
  } finally {
    await browser?.close();
    for (const close of closers) close();
    sandbox?.stop();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
