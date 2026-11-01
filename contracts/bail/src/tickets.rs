use near_sdk::{near, PublicKey};

use crate::{ticket_bytes, ticket_public_key, Bail, BailExt, EventId, TicketKey};

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Ticket {
    pub payout_to: String,
    pub index: u32,
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
        self.tickets.insert((event_id, ticket), Ticket { payout_to, index });
    }
}
