use near_sdk::serde_json::json;
use near_sdk::{env, near, require, PublicKey};

use crate::event::{Event, Status, MAX_CODE_LEN};
use crate::tickets::Ticket;
use crate::{emit, ticket_bytes, Bail, BailExt, EventId, TicketKey};

/// Where one ticket stands on one slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SlotState {
    /// Still open, or opened and not yet revealed, before the reveal deadline.
    Pending,
    /// Never opened by the end of check-in, or never revealed by the deadline.
    Void,
    Revealed { caught: bool },
}

/// `caught >= max(0, R - void)`. A void slot can cost a ticket at most the one catch it
/// held there and lowers the bar by one, so voiding never disqualifies anyone.
pub(crate) fn qualifies(required: u8, states: &[SlotState]) -> bool {
    let void = states.iter().filter(|s| **s == SlotState::Void).count();
    let caught = states
        .iter()
        .filter(|s| **s == SlotState::Revealed { caught: true })
        .count();
    caught >= usize::from(required).saturating_sub(void)
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Standing {
    pub verified_catches: u8,
    pub void_slots: u8,
    pub catches_needed: u8,
    pub attended: bool,
    pub vouches: u8,
    /// False until the reveal deadline: pending slots can still be revealed or go void.
    pub is_final: bool,
}

#[near]
impl Bail {
    /// Anyone who caught the code can reveal it once its window has closed, so a host
    /// who goes silent can't stop attendees from proving they were there.
    pub fn reveal(&mut self, event_id: EventId, slot: u8, code: String) {
        let now = env::block_timestamp_ms();
        let event = self.events.get_mut(&event_id).expect("no such event");
        require!(event.status == Status::Active, "event is not active");
        require!(
            now < event.schedule.reveal_deadline_ms,
            "the reveal deadline has passed"
        );
        let window = event.checkin.window_ms;
        let opened = event
            .slots
            .get_mut(usize::from(slot))
            .expect("slot is not open");
        require!(
            now >= opened.opened_at_ms + window,
            "the code window is still open"
        );
        require!(opened.revealed.is_none(), "already revealed");

        let code = normalize_code(&code);
        require!(
            !code.is_empty() && code.len() <= MAX_CODE_LEN,
            "code must be 1 to 64 bytes"
        );
        require!(
            code_commitment(event_id, slot, &code).as_slice() == opened.commitment.0.as_slice(),
            "code does not match the commitment"
        );
        opened.revealed = Some(code.clone());
        emit(
            "code_revealed",
            json!({ "event_id": event_id, "slot": slot, "code": code }),
        );
    }

    pub fn standing(&self, event_id: EventId, ticket_key: PublicKey) -> Option<Standing> {
        let event = self.events.get(&event_id)?;
        let key = ticket_bytes(&ticket_key)?;
        let ticket = self.tickets.get(&(event_id, key))?;
        let now = env::block_timestamp_ms();
        let states = slot_states(event_id, event, &key, ticket, now);
        let count = |want: fn(&SlotState) -> bool| states.iter().filter(|s| want(s)).count() as u8;
        let void_slots = count(|s| *s == SlotState::Void);
        Some(Standing {
            verified_catches: count(|s| *s == SlotState::Revealed { caught: true }),
            void_slots,
            catches_needed: event.checkin.required.saturating_sub(void_slots),
            attended: qualifies(event.checkin.required, &states),
            vouches: ticket.vouched_by,
            is_final: now >= event.schedule.reveal_deadline_ms,
        })
    }
}

pub(crate) fn slot_states(
    event_id: EventId,
    event: &Event,
    key: &TicketKey,
    ticket: &Ticket,
    now: u64,
) -> Vec<SlotState> {
    (0..event.checkin.slots)
        .map(|slot| {
            if slot_is_void(event, slot, now) {
                return SlotState::Void;
            }
            let revealed = event.slots.get(usize::from(slot)).and_then(|s| s.revealed.as_ref());
            match revealed {
                Some(code) => {
                    let expected = catch_proof(event_id, slot, code, key);
                    let caught = ticket.catches[usize::from(slot)]
                        .as_ref()
                        .is_some_and(|c| c.proof.0.as_slice() == expected.as_slice());
                    SlotState::Revealed { caught }
                }
                None => SlotState::Pending,
            }
        })
        .collect()
}

/// Never opened by the end of check-in, or opened and never revealed by the deadline.
fn slot_is_void(event: &Event, slot: u8, now: u64) -> bool {
    match event.slots.get(usize::from(slot)) {
        None => now >= event.schedule.checkin_closes_at_ms,
        Some(opened) => opened.revealed.is_none() && now >= event.schedule.reveal_deadline_ms,
    }
}

pub(crate) fn void_slots(event: &Event, now: u64) -> u8 {
    (0..event.checkin.slots)
        .filter(|&slot| slot_is_void(event, slot, now))
        .count() as u8
}

/// Lowercase ASCII words joined by single spaces, so "Tiger  MAPLE" and "tiger maple" match.
pub(crate) fn normalize_code(code: &str) -> String {
    code.split_ascii_whitespace()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Each field is a 4-byte little-endian length followed by its bytes, so no two
/// different inputs can produce the same hash input.
fn push_field(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(bytes);
}

fn slot_hash(domain: &[u8], event_id: EventId, slot: u8, code: &str, key: Option<&TicketKey>) -> [u8; 32] {
    let mut buf = Vec::with_capacity(128);
    push_field(&mut buf, domain);
    push_field(&mut buf, env::current_account_id().as_bytes());
    push_field(&mut buf, &event_id.to_le_bytes());
    push_field(&mut buf, &[slot]);
    push_field(&mut buf, code.as_bytes());
    if let Some(key) = key {
        push_field(&mut buf, key);
    }
    env::sha256_array(&buf)
}

pub(crate) fn code_commitment(event_id: EventId, slot: u8, code: &str) -> [u8; 32] {
    slot_hash(b"bail/v1/code", event_id, slot, code, None)
}

pub(crate) fn catch_proof(event_id: EventId, slot: u8, code: &str, key: &TicketKey) -> [u8; 32] {
    slot_hash(b"bail/v1/proof", event_id, slot, code, Some(key))
}
