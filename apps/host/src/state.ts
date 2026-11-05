import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * What only the host knows about an event, kept on the host's machine: the codes until
 * they are revealed, the slot key, and the rehearsal attendees' ticket backups.
 */
export interface EventState {
  contractId: string;
  eventId: number;
  organizer: string;
  codes: string[];
  hostKey?: string;
  bots?: { backup: string; catches: boolean }[];
}

export function stateDir(): string {
  return process.env.BAIL_HOST_HOME ?? join(homedir(), ".bail-host");
}

function path(dir: string, contractId: string, eventId: number): string {
  return join(dir, contractId, `${eventId}.json`);
}

export function saveState(dir: string, state: EventState): void {
  mkdirSync(join(dir, state.contractId), { recursive: true, mode: 0o700 });
  const file = path(dir, state.contractId, state.eventId);
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadState(dir: string, contractId: string, eventId: number): EventState {
  const file = path(dir, contractId, eventId);
  if (!existsSync(file)) throw new Error(`no host state for event ${eventId} at ${file}; was it created on this machine?`);
  return JSON.parse(readFileSync(file, "utf8"));
}
