use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, AccountId, PromiseOrValue, PublicKey};

use crate::event::{Status, MAX_TICKETS_PER_SEAT};
use crate::payout::PayoutTo;
use crate::{emit, ticket_bytes, Bail, BailExt, EventId, TicketKey, MAX_PAYOUT_LEN};

/// The `msg` attached to `ft_transfer_call`, e.g. by 1Click's `customRecipientMsg`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct RsvpMsg {
    event_id: EventId,
    ticket_key: PublicKey,
    payout_to: String,
}

#[near]
impl FungibleTokenReceiver for Bail {
    /// A transfer is bounced only when it can't be returned any other way. Once the
    /// note names a payout address, a bounce through 1Click would land with the relay
    /// rather than the attendee, so anything that can't become a seat is owed instead,
    /// up to one owed record per seat.
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

        let (deposit, refusal) = {
            let event = &self.events[&event_id];
            let refusal = if event.status != Status::Active {
                Some("event_not_active")
            } else if env::block_timestamp_ms() >= event.schedule.rsvp_closes_at_ms {
                Some("rsvp_closed")
            } else if event.registered >= event.capacity {
                Some("full")
            } else if self.tickets.contains_key(&(event_id, ticket)) {
                Some("already_registered")
            } else if event.tickets_created >= event.capacity * MAX_TICKETS_PER_SEAT {
                Some("rsvp_limit")
            } else {
                None
            };
            (event.deposit.0, refusal)
        };
        if amount.0 < deposit {
            // Underpaying can't buy storage for a refund record, so it goes back.
            return PromiseOrValue::Value(amount);
        }

        if let Some(reason) = refusal {
            if !self.owe(event_id, &payout_to, amount.0) {
                return PromiseOrValue::Value(amount);
            }
            emit(
                "deposit_refused",
                json!({ "event_id": event_id, "reason": reason, "amount": amount, "payout_to": payout_to, "sender_id": sender_id }),
            );
            return PromiseOrValue::Value(U128(0));
        }

        self.add_ticket(event_id, ticket, payout_to.clone());
        let excess = amount.0 - deposit;
        let unused = if excess > 0 && !self.owe(event_id, &payout_to, excess) {
            excess
        } else {
            0
        };
        emit(
            "rsvp",
            json!({ "event_id": event_id, "payout_to": payout_to, "amount": amount, "sender_id": sender_id }),
        );
        PromiseOrValue::Value(U128(unused))
    }
}

#[near]
impl Bail {
    pub fn get_owed(&self, event_id: EventId, payout_to: String) -> U128 {
        U128(self.owed.get(&(event_id, payout_to)).copied().unwrap_or(0))
    }
}

impl Bail {
    fn parse_rsvp(&self, token: &AccountId, msg: &str) -> Option<(EventId, TicketKey, String)> {
        let msg: RsvpMsg = serde_json::from_str(msg).ok()?;
        let event = self.events.get(&msg.event_id)?;
        if &event.token != token
            || msg.payout_to.len() > MAX_PAYOUT_LEN
            || PayoutTo::parse(&msg.payout_to, &self.config).is_none()
        {
            return None;
        }
        let ticket = ticket_bytes(&msg.ticket_key)?;
        Some((msg.event_id, ticket, msg.payout_to))
    }

    /// For refused transfers. Returns false when a new owed record would exceed the
    /// event's prepaid cap.
    pub(crate) fn owe(&mut self, event_id: EventId, payout_to: &str, amount: u128) -> bool {
        let key = (event_id, payout_to.to_owned());
        if let Some(owed) = self.owed.get_mut(&key) {
            *owed += amount;
            return true;
        }
        let event = self.events.get_mut(&event_id).unwrap();
        if event.owed_records >= event.capacity {
            return false;
        }
        event.owed_records += 1;
        event.owed_total += 1;
        self.owed.insert(key, amount);
        true
    }

    /// For refunds whose storage is already paid for, such as a cancelled ticket.
    pub(crate) fn owe_uncapped(&mut self, event_id: EventId, payout_to: &str, amount: u128) {
        let key = (event_id, payout_to.to_owned());
        if !self.owed.contains_key(&key) {
            self.events.get_mut(&event_id).unwrap().owed_total += 1;
        }
        *self.owed.entry(key).or_insert(0) += amount;
    }
}
