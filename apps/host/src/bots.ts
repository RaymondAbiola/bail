// Rehearsal attendees, driven by the SDK exactly as the web app will drive a real one: a
// fresh key, the faucet, a sponsored RSVP, then catches through the relayer. They read the
// codes from the host's own state file, so they only work on the host's machine.

import { type BailView, type RelayerClient, Ticket, rsvpDelegate } from "@bail/sdk";

import { ChainClock } from "./clock.ts";
import { type EventState, loadState, saveState } from "./state.ts";

export async function rsvpBots(
  view: BailView,
  relayer: RelayerClient,
  stateDir: string,
  eventId: number,
  options: { count: number; miss: number; log?: (line: string) => void },
): Promise<EventState> {
  const log = options.log ?? ((line: string) => console.log(line));
  const state = loadState(stateDir, view.contractId, eventId);
  const event = await view.event(eventId);
  if (!event) throw new Error(`event ${eventId} does not exist`);
  const bots = [...(state.bots ?? [])];
  // `count` is the total wanted, so a run that stopped partway can be repeated to finish.
  while (bots.length < options.count) {
    const i = bots.length;
    const ticket = Ticket.generate();
    await relayer.faucet(ticket.accountId, eventId);
    const nonce = await view.accessKeyNonce(ticket.accountId, ticket.publicKey);
    if (nonce === null) throw new Error(`the faucet did not create ${ticket.accountId}`);
    const delegate = rsvpDelegate({
      publicKey: ticket.publicKey,
      token: event.token,
      contractId: view.contractId,
      deposit: event.deposit,
      note: ticket.rsvpNote(eventId, `near:${ticket.accountId}`),
      nonce: nonce + 1n,
      maxBlockHeight: (await view.finalHeight()) + 600n,
    });
    const { tx, seated } = await relayer.meta(eventId, ticket.signDelegate(delegate));
    const catches = i >= options.miss;
    bots.push({ backup: ticket.backup(), catches });
    saveState(stateDir, { ...state, bots });
    log(`bot ${bots.length}: ${ticket.accountId.slice(0, 12)}... seated=${seated} ${catches ? "will catch every code" : "will miss every code"} (tx ${tx})`);
  }
  return { ...state, bots };
}

/** Every catching bot catches `slot`'s code through the relayer. */
export async function catchSlot(view: BailView, relayer: RelayerClient, state: EventState, slot: number, log = console.log): Promise<void> {
  for (const [i, bot] of (state.bots ?? []).entries()) {
    if (!bot.catches) continue;
    const ticket = Ticket.restore(bot.backup);
    const { tx } = await relayer.submit(ticket.catch(view.contractId, state.eventId, slot, 1, state.codes[slot]!));
    log(`bot ${i + 1} caught code ${slot + 1} (tx ${tx})`);
  }
}

/** Watches the event and has the bots catch each code a few seconds after it opens. */
export async function runBots(view: BailView, relayer: RelayerClient, stateDir: string, eventId: number, log = console.log): Promise<void> {
  const state = loadState(stateDir, view.contractId, eventId);
  const done = new Set<number>();
  const clock = new ChainClock(view);
  for (;;) {
    const event = (await view.event(eventId))!;
    const now = await clock.fresh();
    for (const [slot, opened] of event.slots.entries()) {
      if (done.has(slot) || now >= opened.opened_at_ms + event.checkin.window_ms) continue;
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 5000));
      await catchSlot(view, relayer, state, slot, log);
      done.add(slot);
    }
    if (now >= event.schedule.checkin_closes_at_ms || done.size === event.checkin.slots) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
}
