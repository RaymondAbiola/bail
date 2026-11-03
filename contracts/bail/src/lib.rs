//! Bail: RSVP with a deposit from any chain, get it back when you show up.

mod cancel;
mod checkin;
mod deposit;
mod event;
mod payout;
mod recourse;
mod reveal;
mod settle;
#[cfg(test)]
mod tests;
mod tickets;

pub use event::{
    CheckinConfig, Config, Event, NewEvent, Schedule, Slot, Status, MAX_CAPACITY, MAX_CODE_LEN,
    MAX_FEE_BPS, MAX_SLOTS, MIN_WINDOW_FLOOR_MS, STORAGE_PER_EVENT, STORAGE_PER_SEAT,
};
pub use recourse::VOUCHES_NEEDED;
pub use reveal::Standing;
pub use settle::{Record, Tally, TallyStage};
pub use tickets::{Catch, Outcome, Ticket};

use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, BorshStorageKey, CurveType, PanicOnDefault, PublicKey};

pub type EventId = u64;
type TicketKey = [u8; 32];

/// `intents:` plus a 64-character account ID, the longest payout address Bail accepts.
pub const MAX_PAYOUT_LEN: usize = 72;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Events,
    Tickets,
    TicketIndex,
    Owed,
    Reputation,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bail {
    config: Config,
    next_event_id: EventId,
    events: LookupMap<EventId, Event>,
    tickets: LookupMap<(EventId, TicketKey), Ticket>,
    // Position -> ticket, so tally can page through an event's tickets in order.
    ticket_index: LookupMap<(EventId, u32), TicketKey>,
    owed: LookupMap<(EventId, String), u128>,
    reputation: LookupMap<String, Record>,
}

#[near]
impl Bail {
    /// Only the contract account itself can initialise it, in the same transaction as the deploy.
    #[init]
    #[private]
    pub fn new(config: Config) -> Self {
        config.validate();
        Self {
            config,
            next_event_id: 0,
            events: LookupMap::new(StorageKey::Events),
            tickets: LookupMap::new(StorageKey::Tickets),
            ticket_index: LookupMap::new(StorageKey::TicketIndex),
            owed: LookupMap::new(StorageKey::Owed),
            reputation: LookupMap::new(StorageKey::Reputation),
        }
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }
}

fn ticket_bytes(key: &PublicKey) -> Option<TicketKey> {
    if !matches!(key.curve_type(), CurveType::ED25519) {
        return None;
    }
    key.as_bytes()[1..].try_into().ok()
}

fn ticket_public_key(ticket: &TicketKey) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, ticket.to_vec()).unwrap()
}

/// The canonical string a ticket signs: `bail/v1/<action>/<contract>/<event>[/<part>...]`.
/// Naming the contract and event stops a signature replaying on another deployment or event.
fn signed_message(action: &str, event_id: EventId, parts: &[&str]) -> String {
    let mut message = format!("bail/v1/{action}/{}/{event_id}", env::current_account_id());
    for part in parts {
        message.push('/');
        message.push_str(part);
    }
    message
}

fn verify_ticket(ticket: &TicketKey, message: &str, signature: &[u8]) -> bool {
    let Ok(signature) = <&[u8; 64]>::try_from(signature) else {
        return false;
    };
    env::ed25519_verify(signature, message.as_bytes(), ticket)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn emit(event: &str, data: Value) {
    let log = json!({ "standard": "bail", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}
