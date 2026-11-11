import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EventEmitter } from "node:events";

import { copyToClipboard } from "../src/clipboard.ts";
import { renderCode, renderWaiting } from "../src/display.ts";
import { waitForHost } from "../src/host.ts";
import { type EventPlan, LATENCY_MS, MARGIN_MS, MINUTE, buildEvent, lastChance, parseAmount, parseWhen, randomMoment, slotRange } from "../src/schedule.ts";
import { loadState, saveState } from "../src/state.ts";
import { EnterKey, TerminalScreen } from "../src/terminal.ts";

const NOW = 1_800_000_000_000;

const plan = (overrides: Partial<EventPlan> = {}): EventPlan => ({
  token: "usdc.testnet", deposit: 1_000_000n, capacity: 30, arbiter: "dao.testnet",
  checkinOpensAt: NOW + 60 * MINUTE, checkinMinutes: 20, slots: 3, required: 2, windowMinutes: 2,
  revealMinutes: 15, disputeMinutes: 30, cancelBeforeMinutes: 60, ...overrides,
});

test("times and amounts are read the way a host types them", () => {
  assert.equal(parseWhen("+15m", NOW), NOW + 15 * MINUTE);
  assert.equal(parseWhen("+2h", NOW), NOW + 120 * MINUTE);
  assert.equal(parseWhen("2026-11-13T18:00:00Z", NOW), Date.parse("2026-11-13T18:00:00Z"));
  assert.throws(() => parseWhen("tomorrow", NOW));
  assert.equal(parseAmount("1", 6), 1_000_000n);
  assert.equal(parseAmount("0.5", 6), 500_000n);
  assert.equal(parseAmount("2.125", 6), 2_125_000n);
  assert.throws(() => parseAmount("1.0000001", 6));
  assert.throws(() => parseAmount("-1", 6));
});

test("an event plan becomes the contract's create_event argument", () => {
  const event = buildEvent(plan(), NOW);
  assert.equal(event.checkin_opens_at_ms, NOW + 60 * MINUTE);
  assert.equal(event.rsvp_closes_at_ms, event.checkin_opens_at_ms);
  assert.equal(event.cancel_cutoff_ms, NOW + MINUTE, "an hour before an event an hour away is clamped to a minute from now");
  assert.equal(event.checkin_closes_at_ms, event.checkin_opens_at_ms + 20 * MINUTE);
  assert.deepEqual(event.checkin, { slots: 3, required: 2, window_ms: 2 * MINUTE });
  assert.equal(event.deposit, "1000000");
  assert.equal(buildEvent(plan({ checkinOpensAt: NOW + 3 * 60 * MINUTE }), NOW).cancel_cutoff_ms, NOW + 2 * 60 * MINUTE);
});

test("schedules the live console couldn't run are refused", () => {
  // 3 codes of 2 minutes need 3 x (2 min + margin + latency) + margin = 9.25 minutes.
  assert.throws(() => buildEvent(plan({ checkinMinutes: 9 }), NOW), /at least 10 minutes/);
  assert.doesNotThrow(() => buildEvent(plan({ checkinMinutes: 10 }), NOW));
  // The real event: 3 codes of 5 minutes.
  assert.throws(() => buildEvent(plan({ windowMinutes: 5, checkinMinutes: 18 }), NOW), /at least 19 minutes/);
  assert.doesNotThrow(() => buildEvent(plan({ windowMinutes: 5, checkinMinutes: 25 }), NOW));
  assert.throws(() => buildEvent(plan({ checkinOpensAt: NOW }), NOW), /future/);
});

test("each slot opens after the previous window and leaves room for the rest", () => {
  const opens = 1000 * MINUTE;
  const closes = opens + 25 * MINUTE;
  const window = 5 * MINUTE;
  const step = window + MARGIN_MS + LATENCY_MS;
  const first = slotRange(0, 3, window, opens, closes, null)!;
  assert.equal(first.earliest, opens + MARGIN_MS);
  assert.equal(first.latest, closes - 3 * step);
  const second = slotRange(1, 3, window, opens, closes, opens + 6 * MINUTE)!;
  assert.equal(second.earliest, opens + 6 * MINUTE + window + MARGIN_MS);
  assert.equal(second.latest, closes - 2 * step);
  for (let i = 0; i < 100; i++) {
    const at = randomMoment(first);
    assert.ok(at >= first.earliest && at <= first.latest);
  }
});

test("whatever moments are drawn, every code fits, even with transaction delays", () => {
  const opens = 1000 * MINUTE;
  const closes = opens + 25 * MINUTE;
  const window = 5 * MINUTE;
  // The worst case: every code opens at the latest moment it was allowed, and each open
  // transaction takes the whole latency allowance to land.
  let previous: number | null = null;
  for (let slot = 0; slot < 3; slot++) {
    const range = slotRange(slot, 3, window, opens, closes, previous);
    assert.ok(range, `code ${slot + 1} still has room`);
    previous = range.latest + LATENCY_MS;
    assert.ok(previous + window <= closes, `code ${slot + 1} ends before check-in does`);
  }
});

test("the dry run's failure: a code with no room left is skipped, not a crash", () => {
  const opens = 1000 * MINUTE;
  const closes = opens + 12 * MINUTE;
  const window = 2 * MINUTE;
  // Code 2 opened late, so code 3 would end after check-in closes.
  assert.equal(slotRange(2, 3, window, opens, closes, closes - window - 5_000), null);
  assert.ok(slotRange(2, 3, window, opens, closes, closes - 5 * MINUTE), "and with 5 minutes to spare it still fits");
});

test("the code is on one line of its own, so copying it copies exactly the words", () => {
  const code = "artefact ostrich pupil mask museum";
  const plain = renderCode(code, 1, 3, 95_000, false).split("\n");
  assert.deepEqual(plain.filter((line) => line.includes("artefact")), [code], "one line has the code, and it is only the code");
  assert.ok(!plain.some((line) => /(\b[a-z]\b ){4}/i.test(line)), "no letter-by-letter spacing anywhere");
  assert.match(plain.join("\n"), /CODE 2 OF 3 IS LIVE/);
  assert.equal(plain[plain.length - 1], "Closes in 1:35", "the countdown is the last line");
  // With colour on, the escape codes wrap the line but are not text, so a copy still has only the words.
  const coloured = renderCode(code, 1, 3, 95_000, true).split("\n").find((line) => line.includes("artefact"))!;
  assert.equal(coloured.replace(/\x1b\[[0-9;]*m/g, ""), code);
  assert.match(renderWaiting(0, 3), /Waiting for code 1 of 3/);
});

test("the terminal redraws only the countdown, and leaves the alternate screen with a plain summary", () => {
  const written: string[] = [];
  const screen = new TerminalScreen({ write: (chunk) => void written.push(chunk) }, true);
  const frame = (left: string) => ["", "CODE 1 OF 3 IS LIVE", "", "tiger maple seven ocean lamp", "", "hint", `Closes in ${left}`].join("\n");
  screen.show(frame("4:59"));
  screen.show(frame("4:58"));
  screen.show(frame("4:57"));
  assert.equal(written[0], "\x1b[?1049h", "enters the alternate screen first, so nothing fills the scrollback");
  assert.match(written[1]!, /^\x1b\[2J\x1b\[H/, "the first frame is a full paint");
  assert.equal(written[2], "\r\x1b[2KCloses in 4:58", "later frames rewrite only the last line");
  assert.equal(written[3], "\r\x1b[2KCloses in 4:57");
  screen.show(frame("4:57").replace("tiger", "zebra"));
  assert.match(written[4]!, /^\x1b\[2J/, "a changed code repaints everything");
  screen.close("Code 1: zebra maple seven ocean lamp");
  assert.deepEqual(written.slice(-2), ["\x1b[?1049l", "Code 1: zebra maple seven ocean lamp\n"]);

  const piped: string[] = [];
  const quiet = new TerminalScreen({ write: (chunk) => void piped.push(chunk) }, false);
  quiet.show(frame("4:59"));
  quiet.show(frame("4:58"));
  assert.equal(piped.length, 1, "piped output isn't flooded once a second");
  assert.ok(!piped[0]!.includes("\x1b"));
});

test("the code is copied with whichever clipboard tool exists, and nothing breaks without one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bail-clip-"));
  const sink = join(dir, "clipboard.txt");
  // wl-copy is the first tool tried, so this fake wins whatever is installed on the machine.
  writeFileSync(join(dir, "wl-copy"), `#!/bin/sh\ncat > "${sink}"\n`, { mode: 0o755 });
  const tool = await copyToClipboard("seat rescue clap brave bleak", { PATH: `${dir}:/usr/bin:/bin` });
  assert.equal(tool, "wl-copy");
  assert.equal(readFileSync(sink, "utf8"), "seat rescue clap brave bleak", "exactly the words, no newline or spaces");
  assert.equal(await copyToClipboard("anything", { PATH: mkdtempSync(join(tmpdir(), "bail-empty-")) }), null);
});

test("the host opens each code when they choose, as fast as codes can follow each other", async () => {
  const window = 5 * MINUTE;
  const opens = 1000 * MINUTE;
  const closes = opens + 60 * MINUTE;
  const view = (slot: number, earliest: number) => ({
    slot, slots: 3, windowMs: window, now: 0, earliest,
    roomBy: slotRange(slot, 3, window, opens, closes, null)!.latest, lastChance: lastChance(window, closes),
  });
  // Fake chain time that moves forward by whatever the console waits.
  const run = async (v: ReturnType<typeof view>, start: number, pressAt: number | null) => {
    let t = start;
    let press!: () => void;
    const pressed = new Promise<void>((r) => (press = r));
    const frames: string[] = [];
    const go = await waitForHost({
      view: v, pressed, now: () => t, show: (f) => void frames.push(f),
      pause: async (ms) => {
        t += ms;
        if (pressAt !== null && t >= pressAt) press();
        await Promise.resolve();
      },
    });
    return { go, t, frames };
  };

  // Enter right away: code 1 opens as soon as check-in does, not at some later moment.
  const first = await run(view(0, opens + MARGIN_MS), opens, opens);
  assert.equal(first.go, true);
  assert.ok(first.t >= opens + MARGIN_MS && first.t < opens + MARGIN_MS + 2000);

  // Enter while code 1 is still live: code 2 waits only for code 1's window to close.
  const code2From = first.t + window + MARGIN_MS;
  const second = await run(view(1, code2From), first.t + MINUTE, first.t + MINUTE + 1000);
  assert.equal(second.go, true);
  assert.ok(second.t >= code2From && second.t < code2From + 2000);
  assert.ok(second.frames.some((f) => /OPENS AS SOON AS IT CAN/.test(f)));

  // So all three codes can be done in the first 16 or so minutes of an hour-long event.
  const code3From = second.t + window + MARGIN_MS;
  const third = await run(view(2, code3From), code3From, code3From);
  assert.ok(third.t + window - opens < 17 * MINUTE);

  // Nothing opens without Enter: the waiting screen says by when, then the code is void.
  const idle = await run(view(2, opens + 20 * MINUTE), opens + 20 * MINUTE, null);
  assert.equal(idle.go, false);
  assert.ok(idle.t >= lastChance(window, closes));
  assert.match(idle.frames[0]!, /NEXT: CODE 3 OF 3/);
  assert.match(idle.frames[0]!, /Press Enter when you want it\. Attendees then have 5 minutes/);
  assert.match(idle.frames[0]!, /or it can't open and is void/);
  assert.match(idle.frames[0]!.split("\n").at(-1)!, /^Time left: \d+:\d\d$/, "the countdown is the last line, redrawn in place");
});

test("Enter presses count one at a time, and only when a code is waiting for one", async () => {
  const input = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  let interrupted = false;
  const keys = new EnterKey(input, () => void (interrupted = true));
  input.emit("data", "\r");
  let got = 0;
  const next = keys.next().then(() => got++);
  input.emit("data", "\r\r");
  await next;
  assert.equal(got, 1, "an early press and a double press open only one code");
  input.emit("data", "\x03");
  assert.ok(interrupted, "Ctrl+C still stops the console");
  keys.close();
  assert.equal(input.listenerCount("data"), 0);
});

test("host state is kept private to the host", () => {
  const dir = mkdtempSync(join(tmpdir(), "bail-host-"));
  saveState(dir, { contractId: "v1.dontbail.testnet", eventId: 4, organizer: "host.testnet", codes: ["zoo zoo"] });
  assert.equal(loadState(dir, "v1.dontbail.testnet", 4).codes[0], "zoo zoo");
  assert.equal(statSync(join(dir, "v1.dontbail.testnet", "4.json")).mode & 0o777, 0o600);
  assert.throws(() => loadState(dir, "v1.dontbail.testnet", 5), /no host state/);
});
