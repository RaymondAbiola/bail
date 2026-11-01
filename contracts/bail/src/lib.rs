//! Bail: RSVP with a deposit from any chain, get it back when you show up.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, CurveType, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PublicKey,
};

pub type EventId = u64;
type TicketKey = [u8; 32];

pub const STORAGE_PER_EVENT: NearToken = NearToken::from_millinear(5);
pub const STORAGE_PER_SEAT: NearToken = NearToken::from_millinear(3);
pub const MAX_CAPACITY: u32 = 1_000;
pub const MAX_PAYOUT_LEN: usize = 128;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Events,
    Rsvps,
    Owed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub organizer: AccountId,
    pub token: AccountId,
    pub deposit: U128,
    pub capacity: u32,
    pub registered: u32,
    pub rsvp_closes_at_ms: u64,
    pub checkin_opens_at_ms: u64,
    pub checkin_closes_at_ms: u64,
}

#[near(serializers = [json])]
pub struct NewEvent {
    pub token: AccountId,
    pub deposit: U128,
    pub capacity: u32,
    pub rsvp_closes_at_ms: u64,
    pub checkin_opens_at_ms: u64,
    pub checkin_closes_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Rsvp {
    pub payout_to: String,
}

/// The `msg` attached to `ft_transfer_call`, e.g. by 1Click's `customRecipientMsg`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct RsvpMsg {
    event_id: EventId,
    ticket_key: PublicKey,
    payout_to: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bail {
    next_event_id: EventId,
    events: LookupMap<EventId, Event>,
    rsvps: LookupMap<(EventId, TicketKey), Rsvp>,
    owed: LookupMap<(EventId, String), u128>,
}

#[near]
impl Bail {
    #[init]
    pub fn new() -> Self {
        Self {
            next_event_id: 0,
            events: LookupMap::new(StorageKey::Events),
            rsvps: LookupMap::new(StorageKey::Rsvps),
            owed: LookupMap::new(StorageKey::Owed),
        }
    }

    /// The organizer prepays storage for every seat so attendees never need NEAR.
    #[payable]
    pub fn create_event(&mut self, event: NewEvent) -> EventId {
        let now = env::block_timestamp_ms();
        require!(event.deposit.0 > 0, "deposit must be positive");
        require!(
            event.capacity > 0 && event.capacity <= MAX_CAPACITY,
            "capacity out of range"
        );
        require!(now < event.rsvp_closes_at_ms, "RSVP must close in the future");
        require!(
            event.rsvp_closes_at_ms <= event.checkin_opens_at_ms,
            "RSVP must close before check-in opens"
        );
        require!(
            event.checkin_opens_at_ms < event.checkin_closes_at_ms,
            "check-in window is empty"
        );

        let cost = seat_storage_cost(event.capacity);
        let attached = env::attached_deposit();
        require!(attached >= cost, format!("attach at least {cost} for storage"));

        let id = self.next_event_id;
        self.next_event_id += 1;
        let organizer = env::predecessor_account_id();
        self.events.insert(
            id,
            Event {
                organizer: organizer.clone(),
                token: event.token,
                deposit: event.deposit,
                capacity: event.capacity,
                registered: 0,
                rsvp_closes_at_ms: event.rsvp_closes_at_ms,
                checkin_opens_at_ms: event.checkin_opens_at_ms,
                checkin_closes_at_ms: event.checkin_closes_at_ms,
            },
        );
        emit("event_created", json!({ "event_id": id, "organizer": organizer }));

        let excess = attached.saturating_sub(cost);
        if !excess.is_zero() {
            Promise::new(organizer).transfer(excess).detach();
        }
        id
    }

    pub fn get_event(&self, event_id: EventId) -> Option<Event> {
        self.events.get(&event_id).cloned()
    }

    pub fn get_rsvp(&self, event_id: EventId, ticket_key: PublicKey) -> Option<Rsvp> {
        let ticket = ticket_bytes(&ticket_key)?;
        self.rsvps.get(&(event_id, ticket)).cloned()
    }

    pub fn get_owed(&self, event_id: EventId, payout_to: String) -> U128 {
        U128(self.owed.get(&(event_id, payout_to)).copied().unwrap_or(0))
    }

    pub fn storage_cost(&self, capacity: u32) -> NearToken {
        seat_storage_cost(capacity)
    }

    fn parse_rsvp(&self, token: &AccountId, msg: &str) -> Option<(EventId, TicketKey, String)> {
        let msg: RsvpMsg = serde_json::from_str(msg).ok()?;
        let event = self.events.get(&msg.event_id)?;
        if &event.token != token
            || msg.payout_to.is_empty()
            || msg.payout_to.len() > MAX_PAYOUT_LEN
        {
            return None;
        }
        let ticket = ticket_bytes(&msg.ticket_key)?;
        Some((msg.event_id, ticket, msg.payout_to))
    }

    fn owe(&mut self, event_id: EventId, payout_to: &str, amount: u128) {
        let entry = self
            .owed
            .entry((event_id, payout_to.to_owned()))
            .or_insert(0);
        *entry += amount;
    }
}

#[near]
impl FungibleTokenReceiver for Bail {
    /// A transfer is bounced only when it doesn't say where money should go back to.
    /// After that, a bounce through 1Click would land with the relay rather than the
    /// attendee, so anything that can't become a seat is recorded as owed instead.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let Some((event_id, ticket, payout_to)) = self.parse_rsvp(&token, &msg) else {
            return PromiseOrValue::Value(amount);
        };

        let event = &self.events[&event_id];
        let deposit = event.deposit.0;
        if amount.0 < deposit {
            // Underpaying can't buy storage for a refund record, so it goes back.
            return PromiseOrValue::Value(amount);
        }
        let refusal = if env::block_timestamp_ms() >= event.rsvp_closes_at_ms {
            Some("rsvp_closed")
        } else if event.registered >= event.capacity {
            Some("full")
        } else if self.rsvps.contains_key(&(event_id, ticket)) {
            Some("already_registered")
        } else {
            None
        };

        if let Some(reason) = refusal {
            self.owe(event_id, &payout_to, amount.0);
            emit(
                "deposit_refused",
                json!({ "event_id": event_id, "reason": reason, "amount": amount, "payout_to": payout_to, "sender_id": sender_id }),
            );
            return PromiseOrValue::Value(U128(0));
        }

        self.events.get_mut(&event_id).unwrap().registered += 1;
        self.rsvps.insert(
            (event_id, ticket),
            Rsvp {
                payout_to: payout_to.clone(),
            },
        );
        let excess = amount.0 - deposit;
        if excess > 0 {
            self.owe(event_id, &payout_to, excess);
        }
        emit(
            "rsvp",
            json!({ "event_id": event_id, "payout_to": payout_to, "amount": amount, "sender_id": sender_id }),
        );
        PromiseOrValue::Value(U128(0))
    }
}

fn seat_storage_cost(capacity: u32) -> NearToken {
    STORAGE_PER_EVENT.saturating_add(STORAGE_PER_SEAT.saturating_mul(capacity as u128))
}

fn ticket_bytes(key: &PublicKey) -> Option<TicketKey> {
    if !matches!(key.curve_type(), CurveType::ED25519) {
        return None;
    }
    key.as_bytes()[1..].try_into().ok()
}

fn emit(event: &str, data: Value) {
    let log = json!({ "standard": "bail", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const NS_PER_MS: u64 = 1_000_000;
    const DEPOSIT: u128 = 1_000_000; // 1 USDC, 6 decimals
    const NOW: u64 = 1_000_000;
    const CLOSES: u64 = NOW + 60_000;

    fn acc(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    fn ctx(predecessor: &str, now_ms: u64, attached: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acc(predecessor))
            .block_timestamp(now_ms * NS_PER_MS)
            .attached_deposit(attached)
            .build());
    }

    fn ticket(seed: u8) -> PublicKey {
        PublicKey::from_parts(CurveType::ED25519, vec![seed; 32]).unwrap()
    }

    fn new_event(capacity: u32) -> NewEvent {
        NewEvent {
            token: acc("usdc.near"),
            deposit: U128(DEPOSIT),
            capacity,
            rsvp_closes_at_ms: CLOSES,
            checkin_opens_at_ms: CLOSES,
            checkin_closes_at_ms: CLOSES + 60_000,
        }
    }

    fn setup(capacity: u32) -> (Bail, EventId) {
        ctx("organizer.near", NOW, NearToken::from_near(0));
        let mut c = Bail::new();
        ctx("organizer.near", NOW, seat_storage_cost(capacity));
        let id = c.create_event(new_event(capacity));
        (c, id)
    }

    fn send(c: &mut Bail, token: &str, at_ms: u64, amount: u128, msg: String) -> u128 {
        ctx(token, at_ms, NearToken::from_near(0));
        match c.ft_on_transfer(acc("intents.near"), U128(amount), msg) {
            PromiseOrValue::Value(v) => v.0,
            PromiseOrValue::Promise(_) => unreachable!(),
        }
    }

    fn msg(event_id: EventId, seed: u8, payout_to: &str) -> String {
        json!({ "event_id": event_id, "ticket_key": ticket(seed), "payout_to": payout_to }).to_string()
    }

    #[test]
    fn deposit_with_note_becomes_a_seat() {
        let (mut c, id) = setup(10);
        let returned = send(&mut c, "usdc.near", NOW, DEPOSIT, msg(id, 1, "base:0xabc"));
        assert_eq!(returned, 0);
        assert_eq!(c.get_event(id).unwrap().registered, 1);
        assert_eq!(
            c.get_rsvp(id, ticket(1)).unwrap().payout_to,
            "base:0xabc"
        );
        assert_eq!(c.get_owed(id, "base:0xabc".into()).0, 0);
    }

    #[test]
    fn transfers_that_name_no_payout_address_bounce() {
        let (mut c, id) = setup(10);
        assert_eq!(send(&mut c, "usdc.near", NOW, DEPOSIT, "not json".into()), DEPOSIT);
        assert_eq!(send(&mut c, "usdc.near", NOW, DEPOSIT, msg(id, 1, "")), DEPOSIT);
        let too_long = "x".repeat(MAX_PAYOUT_LEN + 1);
        assert_eq!(send(&mut c, "usdc.near", NOW, DEPOSIT, msg(id, 1, &too_long)), DEPOSIT);
        assert_eq!(send(&mut c, "usdc.near", NOW, DEPOSIT, msg(id + 1, 1, "base:0xabc")), DEPOSIT);
        assert_eq!(c.get_event(id).unwrap().registered, 0);
    }

    #[test]
    fn wrong_token_bounces() {
        let (mut c, id) = setup(10);
        assert_eq!(send(&mut c, "fake-usdc.near", NOW, DEPOSIT, msg(id, 1, "base:0xabc")), DEPOSIT);
        assert_eq!(c.get_event(id).unwrap().registered, 0);
    }

    #[test]
    fn non_ed25519_ticket_bounces() {
        let (mut c, id) = setup(10);
        let secp = PublicKey::from_parts(CurveType::SECP256K1, vec![7; 64]).unwrap();
        let m = json!({ "event_id": id, "ticket_key": secp, "payout_to": "base:0xabc" }).to_string();
        assert_eq!(send(&mut c, "usdc.near", NOW, DEPOSIT, m), DEPOSIT);
    }

    #[test]
    fn underpayment_bounces() {
        let (mut c, id) = setup(10);
        assert_eq!(send(&mut c, "usdc.near", NOW, DEPOSIT - 1, msg(id, 1, "base:0xabc")), DEPOSIT - 1);
        assert_eq!(c.get_owed(id, "base:0xabc".into()).0, 0);
    }

    #[test]
    fn late_deposit_is_owed_not_bounced() {
        let (mut c, id) = setup(10);
        assert_eq!(send(&mut c, "usdc.near", CLOSES, DEPOSIT, msg(id, 1, "base:0xabc")), 0);
        assert_eq!(c.get_event(id).unwrap().registered, 0);
        assert_eq!(c.get_owed(id, "base:0xabc".into()).0, DEPOSIT);
    }

    #[test]
    fn deposit_into_a_full_event_is_owed() {
        let (mut c, id) = setup(1);
        send(&mut c, "usdc.near", NOW, DEPOSIT, msg(id, 1, "base:0xaaa"));
        assert_eq!(send(&mut c, "usdc.near", NOW, DEPOSIT, msg(id, 2, "base:0xbbb")), 0);
        assert_eq!(c.get_event(id).unwrap().registered, 1);
        assert_eq!(c.get_owed(id, "base:0xbbb".into()).0, DEPOSIT);
    }

    #[test]
    fn second_deposit_for_same_ticket_is_owed() {
        let (mut c, id) = setup(10);
        send(&mut c, "usdc.near", NOW, DEPOSIT, msg(id, 1, "base:0xabc"));
        send(&mut c, "usdc.near", NOW, DEPOSIT, msg(id, 1, "base:0xabc"));
        assert_eq!(c.get_event(id).unwrap().registered, 1);
        assert_eq!(c.get_owed(id, "base:0xabc".into()).0, DEPOSIT);
    }

    #[test]
    fn overpayment_seats_and_owes_the_excess() {
        let (mut c, id) = setup(10);
        assert_eq!(send(&mut c, "usdc.near", NOW, DEPOSIT + 250, msg(id, 1, "base:0xabc")), 0);
        assert_eq!(c.get_event(id).unwrap().registered, 1);
        assert_eq!(c.get_owed(id, "base:0xabc".into()).0, 250);
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn event_needs_prepaid_storage() {
        ctx("organizer.near", NOW, NearToken::from_near(0));
        let mut c = Bail::new();
        ctx("organizer.near", NOW, seat_storage_cost(10).saturating_sub(NearToken::from_yoctonear(1)));
        c.create_event(new_event(10));
    }

    #[test]
    #[should_panic(expected = "check-in window is empty")]
    fn event_needs_a_checkin_window() {
        ctx("organizer.near", NOW, NearToken::from_near(0));
        let mut c = Bail::new();
        ctx("organizer.near", NOW, seat_storage_cost(10));
        let mut e = new_event(10);
        e.checkin_closes_at_ms = e.checkin_opens_at_ms;
        c.create_event(e);
    }

    #[test]
    fn prepaid_storage_covers_a_full_event() {
        let capacity = 25;
        ctx("organizer.near", NOW, NearToken::from_near(0));
        let mut c = Bail::new();
        let before = env::storage_usage();
        ctx("organizer.near", NOW, seat_storage_cost(capacity));
        let id = c.create_event(new_event(capacity));
        let longest = "x".repeat(MAX_PAYOUT_LEN);
        for seed in 0..capacity as u8 {
            send(&mut c, "usdc.near", NOW, DEPOSIT, msg(id, seed, &longest));
        }
        c.events.flush();
        c.rsvps.flush();
        let used = env::storage_byte_cost().saturating_mul((env::storage_usage() - before) as u128);
        assert!(used <= seat_storage_cost(capacity), "{used} used, {} prepaid", seat_storage_cost(capacity));
    }
}
