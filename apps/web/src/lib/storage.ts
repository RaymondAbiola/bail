// The ticket key is the attendee's identity, so it lives only here, per event, in this
// browser. It never goes into a URL, a log, or a request. If the browser refuses storage,
// the key is kept in memory for the session and the app says so.

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type RsvpStage = "created" | "funded" | "seated";

export interface Submission {
  attempt: number;
  code: string;
  at: number;
}

/** What was observed about the person's result, kept so it survives the event closing onchain. */
export interface CachedResult {
  outcome: string;
  payout: string | null;
  paid: boolean;
  payoutTo: string;
  observedAt: number;
}

export interface StoredTicket {
  version: 1;
  /** The secret backup string. Treat as a password. */
  backup: string;
  publicKey: string;
  payoutTo: string;
  createdAt: number;
  backedUp: boolean;
  stage: RsvpStage;
  rsvpTx?: string;
  /** Set when this browser cancelled the RSVP, so the ticket isn't mistaken for a missing one. */
  cancelled?: { tx: string; at: number };
  submissions: Record<number, Submission>;
  result?: CachedResult;
}

export class TicketStore {
  readonly #storage: StorageLike | null;
  readonly #memory = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  #degraded = false;

  constructor(storage: StorageLike | null) {
    this.#storage = storage;
    this.#degraded = storage === null;
  }

  /** Calls `listener` whenever any ticket is saved or removed, so every screen sees the same one. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  /** True when the key can't be kept across a reload. */
  get memoryOnly(): boolean {
    return this.#degraded;
  }

  static key(contractId: string, eventId: number): string {
    return `bail:v1:${contractId}:${eventId}`;
  }

  get(contractId: string, eventId: number): StoredTicket | null {
    const key = TicketStore.key(contractId, eventId);
    let raw: string | null = this.#memory.get(key) ?? null;
    if (raw === null && this.#storage) {
      try {
        raw = this.#storage.getItem(key);
      } catch {
        this.#degraded = true;
      }
    }
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as StoredTicket;
      return parsed.version === 1 && typeof parsed.backup === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  save(contractId: string, eventId: number, ticket: StoredTicket): void {
    const key = TicketStore.key(contractId, eventId);
    const raw = JSON.stringify(ticket);
    this.#memory.set(key, raw);
    try {
      this.#storage?.setItem(key, raw);
    } catch {
      this.#degraded = true;
    }
    this.#emit();
  }

  update(contractId: string, eventId: number, change: (ticket: StoredTicket) => StoredTicket): StoredTicket | null {
    const current = this.get(contractId, eventId);
    if (!current) return null;
    const next = change(current);
    this.save(contractId, eventId, next);
    return next;
  }

  remove(contractId: string, eventId: number): void {
    const key = TicketStore.key(contractId, eventId);
    this.#memory.delete(key);
    try {
      this.#storage?.removeItem(key);
    } catch {
      this.#degraded = true;
    }
    this.#emit();
  }
}

export function browserStorage(): StorageLike | null {
  try {
    const probe = "bail:probe";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}
