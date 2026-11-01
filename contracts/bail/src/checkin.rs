use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, PublicKey};

use crate::event::{Slot, Status};
use crate::tickets::Catch;
use crate::{emit, hex, signed_message, ticket_bytes, verify_ticket, Bail, BailExt, EventId};

#[near]
impl Bail {
    /// Called by the host console with a function-call key, so it takes no deposit.
    pub fn open_slot(&mut self, event_id: EventId, slot: u8, commitment: Base64VecU8) {
        let now = env::block_timestamp_ms();
        let event = self.events.get_mut(&event_id).expect("no such event");
        require!(
            env::predecessor_account_id() == event.organizer,
            "only the organizer opens slots"
        );
        require!(event.status == Status::Active, "event is not active");
        require!(slot < event.checkin.slots, "no such slot");
        require!(
            usize::from(slot) == event.slots.len(),
            "slots open in order, once each"
        );
        require!(commitment.0.len() == 32, "commitment must be 32 bytes");

        let window = event.checkin.window_ms;
        require!(now >= event.schedule.checkin_opens_at_ms, "check-in is not open");
        require!(
            now + window <= event.schedule.checkin_closes_at_ms,
            "the window would end after check-in closes"
        );
        if let Some(previous) = event.slots.last() {
            require!(
                now >= previous.opened_at_ms + window,
                "the previous code window is still open"
            );
        }

        event.slots.push(Slot {
            opened_at_ms: now,
            commitment,
            flags: 0,
        });
        emit(
            "slot_opened",
            json!({ "event_id": event_id, "slot": slot, "closes_at_ms": now + window }),
        );
    }

    /// A ticket can resubmit inside the window to fix a typo, but only with a higher
    /// attempt number, so nobody can replay an older signed attempt over a newer one.
    pub fn catch(
        &mut self,
        event_id: EventId,
        slot: u8,
        attempt: u32,
        ticket_key: PublicKey,
        proof: Base64VecU8,
        signature: Base64VecU8,
    ) {
        let now = env::block_timestamp_ms();
        let event = self.events.get(&event_id).expect("no such event");
        require!(event.status == Status::Active, "event is not active");
        let opened = event
            .slots
            .get(usize::from(slot))
            .expect("slot is not open")
            .opened_at_ms;
        require!(now < opened + event.checkin.window_ms, "code window is closed");
        require!(proof.0.len() == 32, "proof must be 32 bytes");

        let ticket = ticket_bytes(&ticket_key).expect("ticket key must be ed25519");
        let entry = self
            .tickets
            .get_mut(&(event_id, ticket))
            .expect("no such ticket");
        let message = signed_message(
            "catch",
            event_id,
            &[&slot.to_string(), &attempt.to_string(), &hex(&proof.0)],
        );
        require!(verify_ticket(&ticket, &message, &signature.0), "invalid signature");

        let current = &mut entry.catches[usize::from(slot)];
        if let Some(previous) = current {
            require!(
                attempt > previous.attempt,
                "attempt must be higher than the last"
            );
        }
        *current = Some(Catch { attempt, proof });
        emit(
            "code_caught",
            json!({ "event_id": event_id, "slot": slot, "attempt": attempt, "ticket_key": ticket_key }),
        );
    }

    /// Evidence for the arbiter that a slot opened onchain but no code was shown.
    /// It moves no money.
    pub fn flag_slot(
        &mut self,
        event_id: EventId,
        slot: u8,
        ticket_key: PublicKey,
        signature: Base64VecU8,
    ) {
        let now = env::block_timestamp_ms();
        let event = self.events.get_mut(&event_id).expect("no such event");
        require!(event.status == Status::Active, "event is not active");
        require!(
            now < event.schedule.reveal_deadline_ms,
            "flagging has closed"
        );
        let opened = event
            .slots
            .get_mut(usize::from(slot))
            .expect("slot is not open");

        let ticket = ticket_bytes(&ticket_key).expect("ticket key must be ed25519");
        let entry = self
            .tickets
            .get_mut(&(event_id, ticket))
            .expect("no such ticket");
        let message = signed_message("flag", event_id, &[&slot.to_string()]);
        require!(verify_ticket(&ticket, &message, &signature.0), "invalid signature");

        let bit = 1u8 << slot;
        require!(entry.flags & bit == 0, "already flagged");
        entry.flags |= bit;
        opened.flags += 1;
        emit(
            "slot_flagged",
            json!({ "event_id": event_id, "slot": slot, "flags": opened.flags }),
        );
    }
}
