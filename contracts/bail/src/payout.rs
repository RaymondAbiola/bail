use near_contract_standards::fungible_token::core::ext_ft_core;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError, PublicKey};

use crate::event::{seat_storage_cost, Config, STORAGE_PER_EVENT};
use crate::settle::{payout_amount, TallyStage};
use crate::{emit, ticket_bytes, ticket_public_key, Bail, BailExt, EventId, TicketKey, MAX_PAYOUT_LEN};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(60);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

/// Upper bounds on the records that outlive an event, so the close-time refund
/// can never hand back storage the contract still needs.
pub(crate) const OWED_RECORD_BYTES: u128 = (1 + 8 + 4 + MAX_PAYOUT_LEN as u128) + 16 + 40;
pub(crate) const REPUTATION_RECORD_BYTES: u128 = (1 + 4 + MAX_PAYOUT_LEN as u128) + 16 + 40;

/// Where a payout goes. Checked at RSVP, so every stored address is payable.
pub(crate) enum PayoutTo {
    Near(AccountId),
    Intents(AccountId),
}

impl PayoutTo {
    pub(crate) fn parse(address: &str, config: &Config) -> Option<Self> {
        if let Some(account) = address.strip_prefix("near:") {
            return account.parse().ok().map(Self::Near);
        }
        if let Some(account) = address.strip_prefix("intents:") {
            config.intents_account.as_ref()?;
            return account.parse().ok().map(Self::Intents);
        }
        None
    }
}

#[near]
impl Bail {
    /// Pays up to `limit` tickets. Anyone can call it once the tally is done. Returns
    /// true when every ticket has had its payout started.
    pub fn payout(&mut self, event_id: EventId, limit: u32) -> bool {
        require!(limit > 0, "limit must be positive");
        let event = self.events.get(&event_id).expect("no such event");
        let tally = done_tally(event.tally.as_ref());
        let (start, registered) = (tally.paid_cursor, event.registered);
        let end = start.saturating_add(limit).min(registered);
        for i in start..end {
            let key = self.ticket_index[&(event_id, i)];
            if let Some(transfer) = self.pay_ticket(event_id, key) {
                transfer.detach();
            }
        }
        let event = self.events.get_mut(&event_id).unwrap();
        event.tally.as_mut().unwrap().paid_cursor = end;
        end == registered
    }

    /// Pays one ticket, for example one whose earlier transfer failed.
    pub fn claim(&mut self, event_id: EventId, ticket_key: PublicKey) {
        let event = self.events.get(&event_id).expect("no such event");
        done_tally(event.tally.as_ref());
        let key = ticket_bytes(&ticket_key).expect("ticket key must be ed25519");
        let ticket = self.tickets.get(&(event_id, key)).expect("no such ticket");
        require!(!ticket.paid, "already paid");
        if let Some(transfer) = self.pay_ticket(event_id, key) {
            transfer.detach();
        }
    }

    /// Pays a refund or excess owed to an address. The record is removed first and
    /// restored if the transfer fails.
    pub fn claim_owed(&mut self, event_id: EventId, payout_to: String) {
        let amount = self
            .owed
            .remove(&(event_id, payout_to.clone()))
            .expect("nothing owed");
        let token = self.events[&event_id].token.clone();
        self.send(&token, &payout_to, amount, event_id, None).detach();
    }

    /// Reads the token's answer. A failed transfer is rolled back: the ticket can be paid
    /// again, or the owed record is restored. Part of a transfer that NEAR Intents
    /// returned is owed. A result that can't be read counts as paid, so nothing can be
    /// paid twice.
    #[private]
    pub fn on_transfer(
        &mut self,
        event_id: EventId,
        ticket_key: Option<PublicKey>,
        payout_to: String,
        amount: U128,
        is_call: bool,
    ) {
        let returned = match env::promise_result_checked(0, 64) {
            Ok(bytes) if is_call => {
                let used = serde_json::from_slice::<U128>(&bytes).map_or(amount.0, |u| u.0);
                amount.0 - used.min(amount.0)
            }
            Ok(_) => 0,
            Err(PromiseError::Failed) => amount.0,
            Err(_) => 0,
        };
        if returned == 0 {
            emit(
                "payout_sent",
                json!({ "event_id": event_id, "payout_to": payout_to, "amount": amount }),
            );
            return;
        }
        // A whole ticket payout that failed is retried as a ticket. Anything else, including
        // a ticket already removed by close_event, becomes an owed record.
        let key = ticket_key.as_ref().and_then(ticket_bytes).filter(|_| returned == amount.0);
        let rolled_back = match key.and_then(|key| self.tickets.get_mut(&(event_id, key))) {
            Some(ticket) => {
                ticket.paid = false;
                true
            }
            None => false,
        };
        if !rolled_back {
            self.owe_uncapped(event_id, &payout_to, returned);
        }
        emit(
            "payout_returned",
            json!({ "event_id": event_id, "payout_to": payout_to, "amount": U128(returned) }),
        );
    }

    /// Frees ticket storage, `limit` tickets per call, once every payout has started. A
    /// ticket whose transfer failed is moved to an owed record. The last call refunds
    /// the organizer's prepaid storage, minus upper bounds for the records that outlive
    /// the event. Returns true once the event is closed.
    pub fn close_event(&mut self, event_id: EventId, limit: u32) -> bool {
        require!(limit > 0, "limit must be positive");
        let event = self.events.get(&event_id).expect("no such event");
        require!(!event.closed, "already closed");
        let tally = done_tally(event.tally.as_ref()).clone();
        require!(tally.paid_cursor >= event.registered, "payouts are not finished");
        let deposit = event.deposit.0;

        for _ in 0..limit.min(event.registered) {
            let event = self.events.get_mut(&event_id).unwrap();
            event.registered -= 1;
            let last = event.registered;
            let key = self.ticket_index.remove(&(event_id, last)).unwrap();
            let ticket = self.tickets.remove(&(event_id, key)).unwrap();
            if !ticket.paid {
                let amount = payout_amount(ticket.outcome.expect("tallied"), &tally, deposit);
                if amount > 0 {
                    self.owe_uncapped(event_id, &ticket.payout_to, amount);
                }
            }
        }

        let event = self.events.get_mut(&event_id).unwrap();
        if event.registered > 0 {
            return false;
        }
        event.closed = true;
        let keep_bytes = u128::from(event.owed_total) * OWED_RECORD_BYTES
            + u128::from(tally.new_records) * REPUTATION_RECORD_BYTES;
        let keep = STORAGE_PER_EVENT.saturating_add(env::storage_byte_cost().saturating_mul(keep_bytes));
        let refund = seat_storage_cost(event.capacity).saturating_sub(keep);
        let organizer = event.organizer.clone();
        emit(
            "event_closed",
            json!({ "event_id": event_id, "storage_refund": refund }),
        );
        if !refund.is_zero() {
            Promise::new(organizer).transfer(refund).detach();
        }
        true
    }
}

impl Bail {
    fn pay_ticket(&mut self, event_id: EventId, key: TicketKey) -> Option<Promise> {
        let event = &self.events[&event_id];
        let tally = done_tally(event.tally.as_ref());
        let ticket = self.tickets.get_mut(&(event_id, key)).unwrap();
        if ticket.paid {
            return None;
        }
        let amount = payout_amount(ticket.outcome.expect("tallied"), tally, event.deposit.0);
        ticket.paid = true;
        if amount == 0 {
            return None;
        }
        let (token, payout_to) = (event.token.clone(), ticket.payout_to.clone());
        Some(self.send(&token, &payout_to, amount, event_id, Some(ticket_public_key(&key))))
    }

    fn send(
        &self,
        token: &AccountId,
        payout_to: &str,
        amount: u128,
        event_id: EventId,
        ticket_key: Option<PublicKey>,
    ) -> Promise {
        let one_yocto = NearToken::from_yoctonear(1);
        let (transfer, is_call) = match PayoutTo::parse(payout_to, &self.config) {
            Some(PayoutTo::Near(account)) => (
                ext_ft_core::ext(token.clone())
                    .with_attached_deposit(one_yocto)
                    .with_static_gas(GAS_FT_TRANSFER)
                    .ft_transfer(account, U128(amount), None),
                false,
            ),
            Some(PayoutTo::Intents(account)) => (
                ext_ft_core::ext(token.clone())
                    .with_attached_deposit(one_yocto)
                    .with_static_gas(GAS_FT_TRANSFER_CALL)
                    .ft_transfer_call(
                        self.config.intents_account.clone().unwrap(),
                        U128(amount),
                        None,
                        account.to_string(),
                    ),
                true,
            ),
            None => env::panic_str("payout address was checked at RSVP"),
        };
        transfer.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_transfer(event_id, ticket_key, payout_to.to_string(), U128(amount), is_call),
        )
    }
}

fn done_tally(tally: Option<&crate::settle::Tally>) -> &crate::settle::Tally {
    tally
        .filter(|t| t.stage == TallyStage::Done)
        .unwrap_or_else(|| env::panic_str("the tally is not finished"))
}
