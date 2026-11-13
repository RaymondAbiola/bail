import { generateCode, isAccountId, type BailView, type Event, type NewEvent } from "@bail/sdk";

import type { StorageLike } from "./storage.ts";

export interface HostRecord {
  version: 1;
  contractId: string;
  eventId: number;
  organizer: string;
  /** Null means an opened code was lost. Never replace an already committed code. */
  codes: (string | null)[];
  title: string;
  callUrl: string;
}

export interface PendingHost {
  organizer: string;
  event: NewEvent;
  title: string;
  callUrl: string;
}

function validRecord(value: unknown, contractId: string, eventId: number): value is HostRecord {
  const r = value as Partial<HostRecord> | null;
  return !!r && r.version === 1 && r.contractId === contractId && r.eventId === eventId && Number.isSafeInteger(eventId) && eventId >= 0
    && typeof r.organizer === "string" && isAccountId(r.organizer) && typeof r.title === "string" && typeof r.callUrl === "string" && safeCallLink(r.callUrl)
    && Array.isArray(r.codes) && r.codes.length >= 1 && r.codes.length <= 5
    && r.codes.every((code) => code === null || (typeof code === "string" && /^[a-z]+(?: [a-z]+){4}$/.test(code) && code.length <= 64));
}

function safeCallLink(value: string): boolean {
  if (!value) return true;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

/** Host codes are local secrets, separate from attendees' ticket keys. Saving must be durable. */
export class HostStore {
  readonly storage: StorageLike | null;
  constructor(storage: StorageLike | null) { this.storage = storage; }

  static key(contractId: string, eventId: number): string { return `bail:host:v1:${contractId}:${eventId}`; }

  private read(key: string): unknown {
    try { return JSON.parse(this.storage?.getItem(key) ?? "null"); } catch { return null; }
  }

  private write(key: string, value: unknown): void {
    if (!this.storage) throw new Error("This browser cannot save host codes. Allow local storage before creating an event.");
    try { this.storage.setItem(key, JSON.stringify(value)); }
    catch { throw new Error("Host codes could not be saved. Free some browser storage and try again."); }
  }

  get(contractId: string, eventId: number): HostRecord | null {
    const value = this.read(HostStore.key(contractId, eventId));
    return validRecord(value, contractId, eventId) ? value : null;
  }

  save(record: HostRecord): void {
    if (!validRecord(record, record.contractId, record.eventId)) throw new Error("The host record is not valid.");
    this.write(HostStore.key(record.contractId, record.eventId), record);
    this.write(`bail:host:last:${record.contractId}`, Math.max(record.eventId, this.lastId(record.contractId)));
  }

  lastId(contractId: string): number {
    const value = this.read(`bail:host:last:${contractId}`);
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  pending(contractId: string): PendingHost | null {
    const p = this.read(`bail:host:pending:${contractId}`) as Partial<PendingHost> | null;
    if (!p || typeof p.organizer !== "string" || !isAccountId(p.organizer) || typeof p.title !== "string" || typeof p.callUrl !== "string"
      || !p.event || !Number.isSafeInteger(p.event.checkin_opens_at_ms) || !Number.isInteger(p.event.checkin?.slots) || p.event.checkin.slots < 1 || p.event.checkin.slots > 5) return null;
    return p as PendingHost;
  }

  savePending(contractId: string, pending: PendingHost): void { this.write(`bail:host:pending:${contractId}`, pending); }
  clearPending(contractId: string): void { this.storage?.removeItem(`bail:host:pending:${contractId}`); }
}

/** Reads through the first unused id; an RPC failure must not be mistaken for the end. */
export async function findCreatedEvent(view: Pick<BailView, "event">, organizer: string, opensAt: number, from = 0): Promise<number | null> {
  if (!Number.isSafeInteger(from) || from < 0) throw new Error("The event lookup must start at a valid id.");
  let found: number | null = null;
  for (let id = from; Number.isSafeInteger(id); id++) {
    const event = await view.event(id);
    if (!event) return found;
    if (event.organizer === organizer && event.schedule.checkin_opens_at_ms === opensAt) found = id;
  }
  throw new Error("The event lookup exceeded the supported id range.");
}

export function makeHostRecord(contractId: string, eventId: number, pending: PendingHost): HostRecord {
  return { version: 1, contractId, eventId, organizer: pending.organizer, codes: Array.from({ length: pending.event.checkin.slots }, () => generateCode()), title: pending.title, callUrl: pending.callUrl };
}

export function recoverUnopenedCodes(contractId: string, eventId: number, event: Event): HostRecord {
  return { version: 1, contractId, eventId, organizer: event.organizer, codes: Array.from({ length: event.checkin.slots }, (_, slot) => slot < event.slots.length ? null : generateCode()), title: "", callUrl: "" };
}
