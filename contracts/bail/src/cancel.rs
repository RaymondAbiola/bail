use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, require, PublicKey};

use crate::event::Status;
use crate::{emit, signed_message, ticket_bytes, verify_ticket, Bail, BailExt, EventId};

#[near]
impl Bail {
    /// Anyone can submit this (usually the relayer), but only a signature from the
    /// ticket key counts, and the refund always goes to the address fixed at RSVP.
    pub fn cancel_rsvp(
        &mut self,
        event_id: EventId,
        ticket_key: PublicKey,
        signature: Base64VecU8,
    ) {
        let event = self.events.get(&event_id).expect("no such event");
        require!(event.status == Status::Active, "event is not active");
        require!(
            env::block_timestamp_ms() < event.schedule.cancel_cutoff_ms,
            "cancel cutoff has passed"
        );
        let deposit = event.deposit.0;

        let ticket = ticket_bytes(&ticket_key).expect("ticket key must be ed25519");
        require!(
            self.tickets.contains_key(&(event_id, ticket)),
            "no such ticket"
        );
        let message = signed_message("cancel", event_id, &[]);
        require!(
            verify_ticket(&ticket, &message, &signature.0),
            "invalid signature"
        );

        let removed = self.remove_ticket(event_id, ticket);
        // The freed ticket record pays for the refund record, so it skips the owed cap.
        self.owe_uncapped(event_id, &removed.payout_to, deposit);
        emit(
            "rsvp_cancelled",
            json!({ "event_id": event_id, "payout_to": removed.payout_to, "amount": deposit.to_string() }),
        );
    }

    /// Requires 1 yoctoNEAR so only a full-access key can cancel, not an app's login key.
    #[payable]
    pub fn cancel_event(&mut self, event_id: EventId) {
        assert_one_yocto();
        let event = self.events.get_mut(&event_id).expect("no such event");
        require!(
            env::predecessor_account_id() == event.organizer,
            "only the organizer can cancel"
        );
        require!(event.status == Status::Active, "event is not active");
        require!(
            env::block_timestamp_ms() < event.schedule.checkin_opens_at_ms,
            "check-in has started"
        );
        event.status = Status::Cancelled;
        emit("event_cancelled", json!({ "event_id": event_id }));
    }
}
