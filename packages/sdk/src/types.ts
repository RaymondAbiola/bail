// The contract's JSON views. u128 amounts arrive as decimal strings, base64 as strings.

export type Status = "Active" | "Cancelled" | "Voided";
export type Outcome = "Attended" | "Vouched" | "Forfeited" | "Refunded";
export type TallyStage = "Classifying" | "Recording" | "Done";

export interface Config {
  fee_bps: number;
  fee_account: string | null;
  min_window_ms: number;
  min_reveal_ms: number;
  min_dispute_ms: number;
  max_event_ms: number;
  intents_account: string | null;
}

export interface Schedule {
  cancel_cutoff_ms: number;
  rsvp_closes_at_ms: number;
  checkin_opens_at_ms: number;
  checkin_closes_at_ms: number;
  reveal_deadline_ms: number;
  dispute_ends_at_ms: number;
}

export interface CheckinConfig {
  slots: number;
  required: number;
  window_ms: number;
}

export interface Slot {
  opened_at_ms: number;
  commitment: string;
  flags: number;
  revealed: string | null;
}

export interface Tally {
  stage: TallyStage;
  cursor: number;
  paid_cursor: number;
  attended: number;
  vouched: number;
  forfeited: number;
  refunded: number;
  pool: string;
  fee: string;
  bonus: string;
  dust: string;
  everyone_refunded: boolean;
  measured: boolean;
  new_records: number;
}

export interface Event {
  organizer: string;
  arbiter: string;
  token: string;
  deposit: string;
  capacity: number;
  registered: number;
  tickets_created: number;
  owed_records: number;
  owed_total: number;
  status: Status;
  schedule: Schedule;
  checkin: CheckinConfig;
  slots: Slot[];
  tally: Tally | null;
  closed: boolean;
}

/** What `create_event` takes; the reveal and dispute ends follow from the durations. */
export interface NewEvent {
  token: string;
  deposit: string;
  capacity: number;
  arbiter: string;
  cancel_cutoff_ms: number;
  rsvp_closes_at_ms: number;
  checkin_opens_at_ms: number;
  checkin_closes_at_ms: number;
  reveal_ms: number;
  dispute_ms: number;
  checkin: CheckinConfig;
}

export interface Catch {
  attempt: number;
  proof: string;
}

export interface TicketRecord {
  payout_to: string;
  index: number;
  catches: (Catch | null)[];
  flags: number;
  vouched_for: string | null;
  vouched_by: number;
  outcome: Outcome | null;
  paid: boolean;
}

export interface Standing {
  verified_catches: number;
  void_slots: number;
  catches_needed: number;
  attended: boolean;
  vouches: number;
  is_final: boolean;
}

export interface Reliability {
  rsvps: number;
  attended: number;
  vouched: number;
  forfeited: number;
}

export interface SourceMetadata {
  version: string | null;
  link: string | null;
  standards: { standard: string; version: string }[];
  build_info?: {
    build_environment: string;
    build_command: string[];
    contract_path: string;
    source_code_snapshot: string;
    output_wasm_path: string | null;
  };
}
