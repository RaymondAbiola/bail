use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::{emit, Bail, BailExt, EventId};

pub const MAX_CAPACITY: u32 = 1_000;
pub const MAX_SLOTS: u8 = 5;
pub const MAX_FEE_BPS: u16 = 1_000;
pub const MIN_WINDOW_FLOOR_MS: u64 = 60_000;
pub const STORAGE_PER_EVENT: NearToken = NearToken::from_millinear(20);
pub const STORAGE_PER_SEAT: NearToken = NearToken::from_millinear(10);

/// Fixed at init. The contract is locked afterwards, so none of this can change.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub fee_bps: u16,
    pub fee_account: Option<AccountId>,
    pub min_window_ms: u64,
    pub min_reveal_ms: u64,
    pub min_dispute_ms: u64,
    pub max_event_ms: u64,
    pub intents_account: Option<AccountId>,
}

impl Config {
    pub(crate) fn validate(&self) {
        require!(self.fee_bps <= MAX_FEE_BPS, "fee above 10%");
        require!(
            self.fee_bps == 0 || self.fee_account.is_some(),
            "a fee needs a fee account"
        );
        require!(
            self.min_window_ms >= MIN_WINDOW_FLOOR_MS,
            "code windows must be at least 60 seconds"
        );
        require!(self.max_event_ms > 0, "max event length must be positive");
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CheckinConfig {
    pub slots: u8,
    pub required: u8,
    pub window_ms: u64,
}

/// Every boundary is fixed at creation; the phase is derived from the block time.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Schedule {
    pub cancel_cutoff_ms: u64,
    pub rsvp_closes_at_ms: u64,
    pub checkin_opens_at_ms: u64,
    pub checkin_closes_at_ms: u64,
    pub reveal_deadline_ms: u64,
    pub dispute_ends_at_ms: u64,
}

/// A code slot the host has opened. Its window is [opened_at_ms, opened_at_ms + window_ms).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Slot {
    pub opened_at_ms: u64,
    pub commitment: Base64VecU8,
    pub flags: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Active,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub organizer: AccountId,
    pub arbiter: AccountId,
    pub token: AccountId,
    pub deposit: U128,
    pub capacity: u32,
    pub registered: u32,
    pub owed_records: u32,
    pub status: Status,
    pub schedule: Schedule,
    pub checkin: CheckinConfig,
    pub slots: Vec<Slot>,
}

#[near(serializers = [json])]
pub struct NewEvent {
    pub token: AccountId,
    pub deposit: U128,
    pub capacity: u32,
    pub arbiter: AccountId,
    pub cancel_cutoff_ms: u64,
    pub rsvp_closes_at_ms: u64,
    pub checkin_opens_at_ms: u64,
    pub checkin_closes_at_ms: u64,
    pub reveal_ms: u64,
    pub dispute_ms: u64,
    pub checkin: CheckinConfig,
}

impl NewEvent {
    fn into_event(self, organizer: AccountId, now_ms: u64, config: &Config) -> Event {
        require!(self.deposit.0 > 0, "deposit must be positive");
        require!(
            self.capacity > 0 && self.capacity <= MAX_CAPACITY,
            "capacity out of range"
        );
        require!(self.arbiter != organizer, "the arbiter can't be the organizer");

        let c = self.checkin;
        require!(
            c.slots > 0 && c.slots <= MAX_SLOTS,
            "between 1 and 5 code slots"
        );
        require!(
            c.required > 0 && c.required <= c.slots,
            "required catches must be between 1 and the number of slots"
        );
        require!(c.window_ms >= config.min_window_ms, "code window too short");

        require!(now_ms < self.rsvp_closes_at_ms, "RSVP must close in the future");
        require!(
            self.cancel_cutoff_ms <= self.rsvp_closes_at_ms,
            "cancel cutoff must not be after RSVP closes"
        );
        require!(
            self.rsvp_closes_at_ms <= self.checkin_opens_at_ms,
            "RSVP must close before check-in opens"
        );
        require!(
            self.checkin_opens_at_ms < self.checkin_closes_at_ms,
            "check-in window is empty"
        );
        // Slots open one after another, so every window has to fit.
        let needed = c.window_ms.checked_mul(u64::from(c.slots));
        require!(
            needed.is_some_and(|n| n <= self.checkin_closes_at_ms - self.checkin_opens_at_ms),
            "check-in window too short for its code slots"
        );
        require!(self.reveal_ms >= config.min_reveal_ms, "reveal period too short");
        require!(self.dispute_ms >= config.min_dispute_ms, "dispute period too short");

        let reveal_deadline_ms = self.checkin_closes_at_ms.checked_add(self.reveal_ms);
        let dispute_ends_at_ms = reveal_deadline_ms.and_then(|r| r.checked_add(self.dispute_ms));
        let (Some(reveal_deadline_ms), Some(dispute_ends_at_ms)) =
            (reveal_deadline_ms, dispute_ends_at_ms)
        else {
            env::panic_str("schedule overflows");
        };
        require!(
            dispute_ends_at_ms - now_ms <= config.max_event_ms,
            "event runs longer than the maximum"
        );

        Event {
            organizer,
            arbiter: self.arbiter,
            token: self.token,
            deposit: self.deposit,
            capacity: self.capacity,
            registered: 0,
            owed_records: 0,
            status: Status::Active,
            schedule: Schedule {
                cancel_cutoff_ms: self.cancel_cutoff_ms,
                rsvp_closes_at_ms: self.rsvp_closes_at_ms,
                checkin_opens_at_ms: self.checkin_opens_at_ms,
                checkin_closes_at_ms: self.checkin_closes_at_ms,
                reveal_deadline_ms,
                dispute_ends_at_ms,
            },
            checkin: c,
            slots: Vec::new(),
        }
    }
}

#[near]
impl Bail {
    /// The organizer prepays storage for every seat so attendees never need NEAR.
    #[payable]
    pub fn create_event(&mut self, event: NewEvent) -> EventId {
        let organizer = env::predecessor_account_id();
        let cost = seat_storage_cost(event.capacity.min(MAX_CAPACITY));
        let attached = env::attached_deposit();
        let event = event.into_event(organizer.clone(), env::block_timestamp_ms(), &self.config);
        require!(attached >= cost, format!("attach at least {cost} for storage"));

        let id = self.next_event_id;
        self.next_event_id += 1;
        let arbiter = event.arbiter.clone();
        self.events.insert(id, event);
        emit(
            "event_created",
            json!({ "event_id": id, "organizer": organizer, "arbiter": arbiter }),
        );

        let excess = attached.saturating_sub(cost);
        if !excess.is_zero() {
            Promise::new(organizer).transfer(excess).detach();
        }
        id
    }

    pub fn get_event(&self, event_id: EventId) -> Option<Event> {
        self.events.get(&event_id).cloned()
    }

    pub fn storage_cost(&self, capacity: u32) -> NearToken {
        seat_storage_cost(capacity)
    }
}

pub(crate) fn seat_storage_cost(capacity: u32) -> NearToken {
    STORAGE_PER_EVENT.saturating_add(STORAGE_PER_SEAT.saturating_mul(u128::from(capacity)))
}
