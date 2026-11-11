import { type BailView, type Event, type TicketRecord, codeCommitment, generateCode, toBase64 } from "@bail/sdk";
import { ResilientProvider } from "@bail/sdk/provider";
import { Account, KeyPair, KeyPairSigner, actions, nearToYocto, teraToGas } from "near-api-js";
import type { KeyPairString } from "near-api-js";

import { ChainClock } from "./clock.ts";
import { copyToClipboard } from "./clipboard.ts";
import { type ReadyView, renderCode, renderOpeningSoon, renderReady, renderWaiting } from "./display.ts";
import { type EventPlan, buildEvent, lastChance, randomMoment, slotRange } from "./schedule.ts";
import { type EventState, loadState, saveState } from "./state.ts";
import { EnterKey, TerminalScreen } from "./terminal.ts";

/** open_slot and reveal are cheap; never attach the maximum, which a function-call key pays for up front. */
const HOST_TGAS = 30;
export const HOST_METHODS = ["open_slot", "reveal"];

export interface Host {
  view: BailView;
  contractId: string;
  /** The organizer's account with its full-access key, for create and grant-key. */
  organizer?: Account;
  stateDir: string;
}

export async function createEvent(host: Host, plan: EventPlan): Promise<number> {
  const organizer = host.organizer;
  if (!organizer) throw new Error("creating an event needs the organizer's full-access key");
  if (plan.arbiter === organizer.accountId) throw new Error("the arbiter can't be the organizer");
  const event = buildEvent(plan, await host.view.now());
  const id = (await organizer.callFunction({
    contractId: host.contractId,
    methodName: "create_event",
    args: { event },
    deposit: BigInt(await host.view.storageCost(plan.capacity)),
    gas: teraToGas(100),
  })) as number;
  saveState(host.stateDir, {
    contractId: host.contractId,
    eventId: id,
    organizer: organizer.accountId,
    codes: Array.from({ length: plan.slots }, () => generateCode()),
  });
  return id;
}

/** Adds a key to the organizer's account that can only open slots and reveal codes on Bail. */
export async function grantKey(host: Host, eventId: number): Promise<string> {
  const organizer = host.organizer;
  if (!organizer) throw new Error("granting the slot key needs the organizer's full-access key");
  const state = loadState(host.stateDir, host.contractId, eventId);
  const key = KeyPair.fromRandom("ed25519");
  await organizer.signAndSendTransaction({
    receiverId: organizer.accountId,
    actions: [actions.addFunctionCallAccessKey(key.getPublicKey(), host.contractId, HOST_METHODS, nearToYocto("1"))],
  });
  saveState(host.stateDir, { ...state, hostKey: key.toString() });
  return key.getPublicKey().toString();
}

function hostAccount(host: Host, state: EventState): Account {
  if (!state.hostKey) throw new Error(`run grant-key ${state.eventId} first`);
  const signer = new KeyPairSigner(KeyPair.fromString(state.hostKey as KeyPairString));
  return new Account(state.organizer, new ResilientProvider([host.view.rpcUrl, ...host.view.fallbackUrls]), signer);
}

async function callAsHost(account: Account, host: Host, methodName: string, args: object): Promise<void> {
  await account.callFunction({ contractId: host.contractId, methodName, args, gas: teraToGas(HOST_TGAS) });
}

export interface WaitForHost {
  view: ReadyView;
  /** Resolves when the host asks for the code. */
  pressed: Promise<void>;
  /** Chain time, as near as can be told. */
  now: () => Promise<number> | number;
  show: (frame: string) => void;
  pause?: (ms: number) => Promise<void>;
}

/**
 * Waits for the host to ask for a code, then for the moment it may open. True means open it
 * now; false means it is too late for this code to fit, so it stays void. Nothing opens on
 * its own: a code that went live while the host was busy talking would cost everyone.
 */
export async function waitForHost({ view, pressed, now, show, pause = (ms) => new Promise((r) => setTimeout(r, ms)) }: WaitForHost): Promise<boolean> {
  let asked = false;
  void pressed.then(() => (asked = true));
  for (;;) {
    const t = await now();
    if (t >= view.lastChance) return false;
    if (asked && t >= view.earliest) return true;
    if (asked) {
      show(renderOpeningSoon(view.slot, view.slots, view.earliest - t));
      await pause(Math.min(1000, view.earliest - t));
    } else {
      show(renderReady({ ...view, now: t }));
      await Promise.race([pressed, pause(1000)]);
    }
  }
}

export interface LiveOptions {
  /**
   * When each code opens: "host" (the default) when the host presses Enter, "random" at a
   * random moment that leaves room for the rest, "earliest" as soon as allowed (for tests).
   */
  timing?: "host" | "random" | "earliest";
  /** For "host" timing: resolves when the host asks for the next code. Defaults to the Enter key. */
  nextPress?: () => Promise<void>;
  /** Reveal each code as soon as its window closes. On by default. */
  reveal?: boolean;
  onOpen?: (slot: number, code: string) => Promise<void> | void;
  show?: (screen: string) => void;
  /** Waits until block time reaches `ms`. Defaults to polling the chain once a second. */
  sleepUntil?: (ms: number) => Promise<void>;
}

/**
 * Runs check-in: opens every remaining slot, shows its code until the window closes, then
 * reveals it. Each slot's timing is read from the chain's record of the previous one, never
 * from the plan, and it can be resumed after a crash.
 */
export async function runLive(host: Host, eventId: number, options: LiveOptions = {}): Promise<void> {
  const { view } = host;
  const state = loadState(host.stateDir, host.contractId, eventId);
  const account = hostAccount(host, state);
  const screen = options.show ? null : new TerminalScreen();
  const show = options.show ?? ((frame: string) => screen!.show(frame));
  if (screen) {
    // Leave the alternate screen however this ends, so the terminal is never left blank.
    process.once("exit", () => screen.close());
    process.once("SIGINT", () => {
      screen.close();
      process.exit(130);
    });
  }
  const clock = new ChainClock(view);
  const sleepUntil = options.sleepUntil ?? ((ms: number) => clock.sleepUntil(ms));
  const timing = options.timing ?? "host";
  const keys = timing === "host" && !options.nextPress ? new EnterKey() : null;
  try {
    await liveSlots();
  } finally {
    keys?.close();
  }

  async function liveSlots(): Promise<void> {
    let event = (await view.event(eventId))!;
    if (!event) throw new Error(`event ${eventId} does not exist`);
    const { slots, window_ms: windowMs } = event.checkin;
    const { checkin_opens_at_ms: opensAt, checkin_closes_at_ms: closesAt } = event.schedule;

    const shown: string[] = [];
    let noRoomFor: number | null = null;
    for (let slot = 0; slot < slots; slot++) {
      const code = state.codes[slot]!;
      let note: string | undefined;
      if (!event.slots[slot]) {
        const range = slotRange(slot, slots, windowMs, opensAt, closesAt, event.slots[slot - 1]?.opened_at_ms ?? null);
        if (!range) {
          noRoomFor = slot;
          break;
        }
        if (timing === "host") {
          await clock.sync();
          const go = await waitForHost({
            view: { slot, slots, windowMs, now: 0, earliest: range.earliest, roomBy: range.latest, lastChance: lastChance(windowMs, closesAt) },
            pressed: options.nextPress ? options.nextPress() : keys!.next(),
            now: () => clock.fresh(),
            show,
          });
          if (!go) {
            noRoomFor = slot;
            break;
          }
        } else {
          show(renderWaiting(slot, slots));
          await sleepUntil(timing === "earliest" ? range.earliest : randomMoment(range));
        }
        await callAsHost(account, host, "open_slot", {
          event_id: eventId,
          slot,
          commitment: toBase64(codeCommitment(host.contractId, eventId, slot, code)),
        });
        event = (await view.event(eventId))!;
        await options.onOpen?.(slot, code);
        if (!options.show) {
          const tool = await copyToClipboard(code);
          note = tool
            ? `Copied to your clipboard (${tool}). Paste it into the call chat.`
            : "Triple-click the green line to copy it. Nothing else is on that line.";
        }
      }
      shown.push(`Code ${slot + 1}: ${code}`);
      const windowEnds = event.slots[slot]!.opened_at_ms + windowMs;
      if (options.sleepUntil) {
        show(renderCode(code, slot, slots, windowEnds - (await view.now()), true, note));
        await options.sleepUntil(windowEnds);
      } else {
        // Count the seconds locally; ask the chain only now and then, and to confirm the end.
        await clock.sync();
        for (;;) {
          const now = await clock.fresh();
          if (now >= windowEnds && (await clock.sync()) >= windowEnds) break;
          show(renderCode(code, slot, slots, Math.max(0, windowEnds - now), true, note));
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (options.reveal !== false && event.slots[slot]!.revealed === null) {
        await callAsHost(account, host, "reveal", { event_id: eventId, slot, code });
      }
      event = (await view.event(eventId))!;
    }
    const ending =
      noRoomFor === null
        ? "Check-in is over and every code is revealed. Attendees can vouch until the dispute window ends."
        : noRoomFor === slots - 1
          ? `Check-in is over. There was no time left to open code ${slots}, so it stays unopened and is void, which only lowers what everyone needs.`
          : `Check-in is over. There was no time left to open codes ${noRoomFor + 1} to ${slots}, so they stay unopened and are void, which only lowers what everyone needs.`;
    const summary = ["", ...shown, "", ending].join("\n");
    if (screen) screen.close(summary);
    else show(summary);
  }
}

/** Reveals every opened code whose window has closed, for example after `live --no-reveal`. */
export async function revealAll(host: Host, eventId: number): Promise<number[]> {
  const state = loadState(host.stateDir, host.contractId, eventId);
  const account = state.hostKey ? hostAccount(host, state) : host.organizer;
  if (!account) throw new Error("revealing needs the slot key or the organizer's key");
  const event = (await host.view.event(eventId))!;
  const now = await host.view.now();
  const revealed: number[] = [];
  for (const [slot, opened] of event.slots.entries()) {
    if (opened.revealed !== null || now < opened.opened_at_ms + event.checkin.window_ms) continue;
    await callAsHost(account, host, "reveal", { event_id: eventId, slot, code: state.codes[slot] });
    revealed.push(slot);
  }
  return revealed;
}

async function allTickets(view: BailView, eventId: number): Promise<[string, TicketRecord][]> {
  const all: [string, TicketRecord][] = [];
  for (;;) {
    const page = await view.tickets(eventId, all.length, 100);
    all.push(...page);
    if (page.length < 100) return all;
  }
}

function amount(value: bigint, decimals = 6): string {
  const whole = value / 10n ** BigInt(decimals);
  const fraction = (value % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function payoutFor(ticket: TicketRecord, event: Event): bigint | null {
  const tally = event.tally;
  if (!tally || tally.stage === "Classifying" || !ticket.outcome) return null;
  const deposit = BigInt(event.deposit);
  if (tally.everyone_refunded) return deposit;
  if (ticket.outcome === "Attended") return deposit + BigInt(tally.bonus);
  return ticket.outcome === "Forfeited" ? 0n : deposit;
}

/** Attendance and payouts, as Markdown for the README or plain text for the terminal. */
export async function report(view: BailView, eventId: number): Promise<string> {
  const event = await view.event(eventId);
  if (!event) throw new Error(`event ${eventId} does not exist`);
  const tickets = await allTickets(view, eventId);
  const tally = event.tally;
  const counted = tally ? tally.attended + tally.vouched + tally.forfeited + tally.refunded : 0;
  const lines = [
    `## Event ${eventId} on ${view.contractId}`,
    "",
    `- Status: ${event.status}${event.closed ? ", closed" : ""}`,
    `- Deposit: ${amount(BigInt(event.deposit))} (${event.token})`,
    event.closed ? `- RSVPs: ${counted} of ${event.capacity} seats` : `- Seats: ${event.registered} of ${event.capacity} taken`,
    `- Codes: ${event.slots.length} of ${event.checkin.slots} opened, ${event.slots.filter((s) => s.revealed !== null).length} revealed, ${event.checkin.required} needed to count as attended`,
  ];
  if (tally) {
    const showed = tally.attended + tally.vouched;
    const total = counted;
    lines.push(
      `- Tally: ${tally.stage}. Attended ${tally.attended}, vouched ${tally.vouched}, forfeited ${tally.forfeited}, refunded ${tally.refunded}`,
      `- Show-up rate: ${total ? Math.round((100 * showed) / total) : 0}%`,
      `- Forfeit pool ${amount(BigInt(tally.pool))}, fee ${amount(BigInt(tally.fee))}, bonus per attendee ${amount(BigInt(tally.bonus))}`,
    );
  }
  if (tickets.length) {
    lines.push("", "| # | Payout address | Codes caught | Vouches | Outcome | Payout | Paid |", "|---|---|---|---|---|---|---|");
    for (const [, ticket] of tickets) {
      const caught = ticket.catches.filter(Boolean).length;
      const payout = payoutFor(ticket, event);
      lines.push(
        `| ${ticket.index + 1} | ${ticket.payout_to} | ${caught} | ${ticket.vouched_by} | ${ticket.outcome ?? "pending"} | ${payout === null ? "" : amount(payout)} | ${ticket.paid ? "yes" : "no"} |`,
      );
    }
  } else if (event.closed) {
    lines.push("", "Tickets were freed when the event closed; the totals above are kept onchain.");
  }
  return lines.join("\n") + "\n";
}
