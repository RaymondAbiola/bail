use near_sdk::json_types::Base64VecU8;
use near_sdk::{near, PublicKey};

use crate::{ticket_bytes, ticket_public_key, Bail, BailExt, EventId, TicketKey, MAX_SLOTS};

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Ticket {
    pub payout_to: String,
    pub index: u32,
    pub catches: [Option<Catch>; MAX_SLOTS as usize],
    /// One bit per slot this ticket flagged as having shown no code.
    pub flags: u8,
    /// The one ticket this attendee vouched for, if any.
    pub vouched_for: Option<PublicKey>,
    pub vouched_by: u8,
    /// Set by tally.
    pub outcome: Option<Outcome>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Attended,
    Vouched,
    Forfeited,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Catch {
    pub attempt: u32,
    pub proof: Base64VecU8,
}

#[near]
impl Bail {
    pub fn get_ticket(&self, event_id: EventId, ticket_key: PublicKey) -> Option<Ticket> {
        let ticket = ticket_bytes(&ticket_key)?;
        self.tickets.get(&(event_id, ticket)).cloned()
    }

    /// Tickets in RSVP order, `limit` at a time.
    pub fn get_tickets(&self, event_id: EventId, from: u32, limit: u32) -> Vec<(PublicKey, Ticket)> {
        let Some(event) = self.events.get(&event_id) else {
            return Vec::new();
        };
        let end = from.saturating_add(limit).min(event.registered);
        (from..end)
            .map(|i| {
                let key = self.ticket_index[&(event_id, i)];
                (ticket_public_key(&key), self.tickets[&(event_id, key)].clone())
            })
            .collect()
    }
}

impl Bail {
    pub(crate) fn add_ticket(&mut self, event_id: EventId, ticket: TicketKey, payout_to: String) {
        let event = self.events.get_mut(&event_id).unwrap();
        let index = event.registered;
        event.registered += 1;
        self.ticket_index.insert((event_id, index), ticket);
        self.tickets.insert(
            (event_id, ticket),
            Ticket {
                payout_to,
                index,
                catches: Default::default(),
                flags: 0,
                vouched_for: None,
                vouched_by: 0,
                outcome: None,
            },
        );
    }

    /// Swap-remove: the last ticket takes the removed one's position.
    pub(crate) fn remove_ticket(&mut self, event_id: EventId, ticket: TicketKey) -> Ticket {
        let removed = self.tickets.remove(&(event_id, ticket)).unwrap();
        let event = self.events.get_mut(&event_id).unwrap();
        event.registered -= 1;
        let last = event.registered;
        let last_key = self.ticket_index.remove(&(event_id, last)).unwrap();
        if removed.index != last {
            self.ticket_index.insert((event_id, removed.index), last_key);
            self.tickets.get_mut(&(event_id, last_key)).unwrap().index = removed.index;
        }
        removed
    }
}
