use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, PublicKey};

use crate::event::Status;
use crate::recourse::VOUCHES_NEEDED;
use crate::reveal::{qualifies, slot_states, void_slots};
use crate::tickets::Outcome;
use crate::{emit, ticket_bytes, Bail, BailExt, EventId};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TallyStage {
    #[default]
    Classifying,
    Recording,
    Done,
}

/// Fixed before any money moves. Every ticket's payout follows from its outcome and these.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tally {
    pub stage: TallyStage,
    pub cursor: u32,
    /// Payout progress, once the tally is done.
    pub paid_cursor: u32,
    pub attended: u32,
    pub vouched: u32,
    pub forfeited: u32,
    pub refunded: u32,
    pub pool: U128,
    pub fee: U128,
    pub bonus: U128,
    pub dust: U128,
    /// Cancelled, voided, or nobody attended: every ticket gets its deposit back.
    pub everyone_refunded: bool,
    /// Whether enough codes were revealed for attendance to mean anything.
    pub measured: bool,
    /// Reliability records this event created, for the close-time storage refund.
    pub new_records: u32,
}

/// Reliability per payout address. Only events where attendance was measured count.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Record {
    pub rsvps: u32,
    pub attended: u32,
    pub vouched: u32,
    pub forfeited: u32,
}

#[near]
impl Bail {
    /// Anyone can call this. It classifies `limit` tickets per call, fixes the split once
    /// every ticket is classified, then records reliability in further pages.
    pub fn tally(&mut self, event_id: EventId, limit: u32) -> TallyStage {
        require!(limit > 0, "limit must be positive");
        let now = env::block_timestamp_ms();
        let event = self.events.get(&event_id).expect("no such event");
        let refund_all = match event.status {
            Status::Active => {
                require!(
                    now >= event.schedule.dispute_ends_at_ms,
                    "the dispute window is still open"
                );
                false
            }
            Status::Cancelled | Status::Voided => true,
        };
        let mut tally = event.tally.clone().unwrap_or_default();
        require!(tally.stage != TallyStage::Done, "already tallied");

        let registered = event.registered;
        let deposit = event.deposit.0;
        let required = event.checkin.required;
        let end = tally.cursor.saturating_add(limit).min(registered);

        if tally.stage == TallyStage::Classifying {
            for i in tally.cursor..end {
                let key = self.ticket_index[&(event_id, i)];
                let ticket = &self.tickets[&(event_id, key)];
                let event = &self.events[&event_id];
                let outcome = if refund_all {
                    Outcome::Refunded
                } else if qualifies(required, &slot_states(event_id, event, &key, ticket, now)) {
                    Outcome::Attended
                } else if ticket.vouched_by >= VOUCHES_NEEDED {
                    Outcome::Vouched
                } else {
                    Outcome::Forfeited
                };
                match outcome {
                    Outcome::Attended => tally.attended += 1,
                    Outcome::Vouched => tally.vouched += 1,
                    Outcome::Forfeited => tally.forfeited += 1,
                    Outcome::Refunded => tally.refunded += 1,
                }
                self.tickets.get_mut(&(event_id, key)).unwrap().outcome = Some(outcome);
            }
            tally.cursor = end;
            if end == registered {
                let measured = !refund_all
                    && required > void_slots(&self.events[&event_id], now);
                self.fix_split(&mut tally, deposit, measured);
            }
        } else {
            for i in tally.cursor..end {
                let key = self.ticket_index[&(event_id, i)];
                let ticket = &self.tickets[&(event_id, key)];
                let outcome = ticket.outcome.expect("classified");
                if !self.reputation.contains_key(&ticket.payout_to) {
                    tally.new_records += 1;
                }
                let record = self.reputation.entry(ticket.payout_to.clone()).or_default();
                record.rsvps += 1;
                match outcome {
                    Outcome::Attended => record.attended += 1,
                    Outcome::Vouched => record.vouched += 1,
                    Outcome::Forfeited => record.forfeited += 1,
                    Outcome::Refunded => {}
                }
            }
            tally.cursor = end;
            if end == registered {
                tally.stage = TallyStage::Done;
            }
        }

        let stage = tally.stage;
        if stage == TallyStage::Done {
            emit("event_tallied", json!({ "event_id": event_id, "tally": tally }));
        }
        self.events.get_mut(&event_id).unwrap().tally = Some(tally);
        stage
    }

    pub fn event_totals(&self, event_id: EventId) -> Option<Tally> {
        self.events.get(&event_id)?.tally.clone()
    }

    /// What a ticket is paid, once its event's split is fixed.
    pub fn get_payout(&self, event_id: EventId, ticket_key: PublicKey) -> Option<U128> {
        let event = self.events.get(&event_id)?;
        let tally = event.tally.as_ref().filter(|t| t.stage != TallyStage::Classifying)?;
        let ticket = self.tickets.get(&(event_id, ticket_bytes(&ticket_key)?))?;
        Some(U128(payout_amount(ticket.outcome?, tally, event.deposit.0)))
    }

    pub fn reliability(&self, payout_to: String) -> Record {
        self.reputation.get(&payout_to).copied().unwrap_or_default()
    }
}

impl Bail {
    fn fix_split(&self, tally: &mut Tally, deposit: u128, measured: bool) {
        tally.cursor = 0;
        if tally.refunded > 0 || tally.attended == 0 {
            tally.everyone_refunded = true;
            tally.stage = TallyStage::Done;
            return;
        }
        let pool = u128::from(tally.forfeited) * deposit;
        let fee = pool * u128::from(self.config.fee_bps) / 10_000;
        let attended = u128::from(tally.attended);
        let bonus = (pool - fee) / attended;
        tally.pool = U128(pool);
        tally.fee = U128(fee);
        tally.bonus = U128(bonus);
        tally.dust = U128(pool - fee - bonus * attended);
        tally.measured = measured;
        tally.stage = if measured {
            TallyStage::Recording
        } else {
            TallyStage::Done
        };
    }
}

pub(crate) fn payout_amount(outcome: Outcome, tally: &Tally, deposit: u128) -> u128 {
    if tally.everyone_refunded {
        return deposit;
    }
    match outcome {
        Outcome::Attended => deposit + tally.bonus.0,
        Outcome::Vouched | Outcome::Refunded => deposit,
        Outcome::Forfeited => 0,
    }
}
