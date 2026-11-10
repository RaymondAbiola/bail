#!/usr/bin/env node
// The host console. Run `bail-host help` for the commands.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { BailView, RelayerClient, TESTNET, phase } from "@bail/sdk";
import { ResilientProvider } from "@bail/sdk/provider";
import { Account } from "near-api-js";
import type { KeyPairString } from "near-api-js";

import { rsvpBots, runBots } from "./bots.ts";
import { type Host, createEvent, grantKey, report, revealAll, runLive } from "./host.ts";
import { parseAmount, parseWhen } from "./schedule.ts";
import { loadState, stateDir } from "./state.ts";

const HELP = `bail-host <command> [options]

  create      --organizer <account> --arbiter <account> --opens <+15m | ISO date>
              [--deposit 1] [--capacity 30] [--slots 3] [--required 2] [--window 2]
              [--checkin 20] [--reveal 15] [--dispute 30] [--cancel-before 60] [--token <id>]
              Creates the event, prepays its storage, and makes its codes. Minutes, USDC.
  grant-key   <event>   Adds a key that can only open slots and reveal codes.
  live        <event>   [--manual] Runs check-in: opens each code at a random moment,
                        shows it large, and reveals it when its window closes.
                        --manual waits for Enter before each code instead.
  reveal      <event>   Reveals any opened code whose window has closed.
  status      <event>   The event's phase, seats and codes.
  report      <event>   Attendance and payouts, in Markdown.
  bots        <event>   --relayer <url> [--count 3] [--miss 1] Rehearsal attendees: RSVP
                        through the faucet, then catch codes, except the first --miss.

  Every command takes [--contract ${TESTNET.contractId}] [--rpc ${TESTNET.rpcUrl}].
  Keys come from near-cli's legacy keychain (~/.near-credentials) and are never printed.
  Codes and the slot key are kept in ~/.bail-host (or BAIL_HOST_HOME).`;

function organizerAccount(accountId: string, view: BailView): Account {
  const file = join(homedir(), ".near-credentials", "testnet", `${accountId}.json`);
  const { private_key } = JSON.parse(readFileSync(file, "utf8")) as { private_key: string };
  const provider = new ResilientProvider([view.rpcUrl, ...view.fallbackUrls]);
  return new Account(accountId, provider, private_key as KeyPairString);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      contract: { type: "string", default: TESTNET.contractId },
      rpc: { type: "string", default: TESTNET.rpcUrl },
      organizer: { type: "string" },
      arbiter: { type: "string" },
      opens: { type: "string" },
      token: { type: "string", default: TESTNET.token },
      deposit: { type: "string", default: "1" },
      capacity: { type: "string", default: "30" },
      slots: { type: "string", default: "3" },
      required: { type: "string", default: "2" },
      window: { type: "string", default: "2" },
      checkin: { type: "string", default: "20" },
      reveal: { type: "string", default: "15" },
      dispute: { type: "string", default: "30" },
      "cancel-before": { type: "string", default: "60" },
      manual: { type: "boolean", default: false },
      relayer: { type: "string" },
      count: { type: "string", default: "3" },
      miss: { type: "string", default: "1" },
    },
  });
  const [command, eventArg] = positionals;
  const view = new BailView({
    contractId: values.contract,
    rpcUrl: values.rpc,
    fallbackUrls: values.rpc === TESTNET.rpcUrl ? TESTNET.fallbackUrls : [],
  });
  const host: Host = { view, contractId: values.contract, stateDir: stateDir() };
  const eventId = Number(eventArg);
  const needEvent = () => {
    if (!Number.isInteger(eventId) || eventId < 0) throw new Error(`${command} needs an event id`);
    return eventId;
  };
  const withOrganizer = (id: string | undefined) => ({ ...host, organizer: organizerAccount(id!, view) });

  switch (command) {
    case "create": {
      if (!values.organizer || !values.arbiter || !values.opens) throw new Error("create needs --organizer, --arbiter and --opens");
      const id = await createEvent(withOrganizer(values.organizer), {
        token: values.token,
        deposit: parseAmount(values.deposit, 6),
        capacity: Number(values.capacity),
        arbiter: values.arbiter,
        checkinOpensAt: parseWhen(values.opens, await view.now()),
        checkinMinutes: Number(values.checkin),
        slots: Number(values.slots),
        required: Number(values.required),
        windowMinutes: Number(values.window),
        revealMinutes: Number(values.reveal),
        disputeMinutes: Number(values.dispute),
        cancelBeforeMinutes: Number(values["cancel-before"]),
      });
      console.log(`created event ${id} on ${values.contract}. Next: bail-host grant-key ${id}`);
      return;
    }
    case "grant-key": {
      const state = loadState(host.stateDir, host.contractId, needEvent());
      const key = await grantKey(withOrganizer(state.organizer), eventId);
      console.log(`added slot key ${key} to ${state.organizer}; it can only call open_slot and reveal`);
      return;
    }
    case "live": {
      const rl = values.manual ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
      await runLive(host, needEvent(), {
        earliest: values.manual,
        beforeOpen: rl ? async (slot) => void (await rl.question(`  Press Enter to show code ${slot + 1}. `)) : undefined,
      });
      rl?.close();
      return;
    }
    case "reveal": {
      const revealed = await revealAll(host, needEvent());
      console.log(revealed.length ? `revealed codes ${revealed.map((s) => s + 1).join(", ")}` : "nothing to reveal yet");
      return;
    }
    case "status": {
      const event = await view.event(needEvent());
      if (!event) throw new Error(`event ${eventId} does not exist`);
      const now = await view.now();
      console.log(`event ${eventId}: ${phase(event, now)}, ${event.registered}/${event.capacity} seats, ${event.slots.length}/${event.checkin.slots} codes opened`);
      for (const [name, at] of Object.entries(event.schedule)) {
        console.log(`  ${name.padEnd(22)} ${new Date(at).toISOString()}${at > now ? "" : "  (passed)"}`);
      }
      return;
    }
    case "report":
      process.stdout.write(await report(view, needEvent()));
      return;
    case "bots": {
      if (!values.relayer) throw new Error("bots needs --relayer <url>");
      const relayer = new RelayerClient(values.relayer);
      await rsvpBots(view, relayer, host.stateDir, needEvent(), { count: Number(values.count), miss: Number(values.miss) });
      console.log("bots are seated; waiting for codes (run bail-host live in another terminal)");
      await runBots(view, relayer, host.stateDir, eventId);
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((error: unknown) => {
  console.error(`bail-host: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
