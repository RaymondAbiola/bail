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
import { KeyPair } from "near-api-js";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { makeEvent } from "../test/fixtures.ts";

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

async function waitText(page: Page, expected: string, timeout = 60_000) {
  try {
    await page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), { timeout }, expected);
  } catch {
    throw new Error(`timed out waiting for "${expected}". The page said:\n${(await text(page)).slice(0, 1500)}`);
  }
}

async function waitAny(page: Page, options: string[], timeout = 60_000) {
  try {
    await page.waitForFunction((list) => list.some((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase())), { timeout }, options);
  } catch {
    throw new Error(`timed out waiting for any of ${JSON.stringify(options)}. The page said:\n${(await text(page)).slice(0, 1500)}`);
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
    let relayerRequests = 0;
    await historyPage.setRequestInterception(true);
    historyPage.on("request", (request) => {
      if (request.url().startsWith(relayerUrl)) relayerRequests++;
      if (request.url().endsWith("/config.json")) {
        void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ relayerUrl, rpcUrl: sb.rpcUrl, contractId: bail.accountId, token: usdc.accountId }) });
        return;
      }
      const body = request.postData();
      if (request.url() === sb.rpcUrl + "/" && body) {
        const rpc = JSON.parse(body);
        if (rpc.params?.method_name === "get_event") {
          const id = JSON.parse(Buffer.from(rpc.params.args_base64, "base64").toString()).event_id;
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
    await clickText(page, "Create my ticket key");
    await waitText(page, "Save your ticket key");
    await shot(page, "03-backup");
    const continueDisabled = () => page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Continue to payment"))!.disabled);
    assert.equal(await continueDisabled(), true, "continuing needs the explicit acknowledgement");
    assert.doesNotMatch(await text(page), /ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/, "the key is hidden until asked for");
    await clickText(page, "Show key");
    const backup = await page.$eval('[data-testid="ticket-key"]', (el) => el.textContent ?? "");
    const alice = Ticket.restore(backup);
    await page.click('input[type="checkbox"]');
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
    await waitText(stranger, "Can't RSVP");
    await stranger.goto(`${siteUrl}/#/event/99`, { waitUntil: "domcontentloaded" });
    await waitText(stranger, "Event #99 not found");
    await shot(stranger, "17-not-found");

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
