use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, require, PublicKey};

use crate::event::Status;
use crate::reveal::{qualifies, slot_states};
use crate::{
    emit, signed_message, ticket_bytes, ticket_public_key, verify_ticket, Bail, BailExt, EventId,
};

/// Vouches that turn a forfeit into a refund (deposit back, no bonus).
pub const VOUCHES_NEEDED: u8 = 2;

#[near]
impl Bail {
    /// For someone who was there but whose phone died. Each attendee vouches at most
    /// once, and a vouched ticket only recovers its own deposit, so collusion can at
    /// most shrink the bonus pool.
    pub fn vouch(
        &mut self,
        event_id: EventId,
        voucher_key: PublicKey,
        target_key: PublicKey,
        signature: Base64VecU8,
    ) {
        let now = env::block_timestamp_ms();
        let event = self.events.get(&event_id).expect("no such event");
        require!(event.status == Status::Active, "event is not active");
        require!(
            now >= event.schedule.reveal_deadline_ms,
            "vouching opens at the reveal deadline"
        );
        require!(
            now < event.schedule.dispute_ends_at_ms,
            "the dispute window has closed"
        );

        let voucher = ticket_bytes(&voucher_key).expect("ticket key must be ed25519");
        let target = ticket_bytes(&target_key).expect("ticket key must be ed25519");
        require!(voucher != target, "you can't vouch for yourself");
        let voucher_ticket = self
            .tickets
            .get(&(event_id, voucher))
            .expect("no such ticket");
        let target_ticket = self
            .tickets
            .get(&(event_id, target))
            .expect("no such ticket");
        require!(voucher_ticket.vouched_for.is_none(), "already vouched");

        let required = event.checkin.required;
        require!(
            qualifies(required, &slot_states(event_id, event, &voucher, voucher_ticket, now)),
            "only attendees can vouch"
        );
        require!(
            !qualifies(required, &slot_states(event_id, event, &target, target_ticket, now)),
            "the target already attended"
        );

        // Rebuilt from the key bytes, so the signed text doesn't depend on how the
        // caller formatted the key.
        let target_key = ticket_public_key(&target);
        let message = signed_message("vouch", event_id, &[&target_key.to_string()]);
        require!(verify_ticket(&voucher, &message, &signature.0), "invalid signature");

        self.tickets.get_mut(&(event_id, voucher)).unwrap().vouched_for = Some(target_key.clone());
        let target_ticket = self.tickets.get_mut(&(event_id, target)).unwrap();
        target_ticket.vouched_by += 1;
        emit(
            "vouched",
            json!({ "event_id": event_id, "target": target_key, "vouches": target_ticket.vouched_by }),
        );
    }

    /// The arbiter's only power: refund everyone. Requires 1 yoctoNEAR, which a Sputnik
    /// DAO proposal can attach and an app's login key can't.
    #[payable]
    pub fn void_event(&mut self, event_id: EventId) {
        assert_one_yocto();
        let event = self.events.get_mut(&event_id).expect("no such event");
        require!(
            env::predecessor_account_id() == event.arbiter,
            "only the arbiter can void"
        );
        require!(event.status == Status::Active, "event is not active");
        require!(
            env::block_timestamp_ms() < event.schedule.dispute_ends_at_ms,
            "the dispute window has closed"
        );
        event.status = Status::Voided;
        emit("event_voided", json!({ "event_id": event_id }));
    }
}
