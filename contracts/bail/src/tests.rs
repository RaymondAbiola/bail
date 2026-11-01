use ed25519_dalek::{Signer, SigningKey};
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::json;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env, AccountId, CurveType, NearToken, PromiseOrValue, PublicKey};

use crate::event::seat_storage_cost;
use crate::*;

const NS_PER_MS: u64 = 1_000_000;
const DEPOSIT: u128 = 1_000_000; // 1 USDC, 6 decimals
const NOW: u64 = 1_000_000;
const MINUTE: u64 = 60_000;
const RSVP_CLOSES: u64 = NOW + MINUTE;
const OPENS: u64 = RSVP_CLOSES;
const WINDOW: u64 = 2 * MINUTE;
const CLOSES: u64 = OPENS + 3 * WINDOW;
const USDC: &str = "usdc.near";
const CONTRACT: &str = "bail.near";

fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

fn ctx(predecessor: &str, now_ms: u64, attached: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(predecessor))
        .block_timestamp(now_ms * NS_PER_MS)
        .attached_deposit(attached)
        .build());
}

fn config() -> Config {
    Config {
        fee_bps: 0,
        fee_account: None,
        min_window_ms: MINUTE,
        min_reveal_ms: MINUTE,
        min_dispute_ms: MINUTE,
        max_event_ms: 30 * 24 * 60 * MINUTE,
        intents_account: None,
    }
}

fn new_event(capacity: u32) -> NewEvent {
    NewEvent {
        token: acc(USDC),
        deposit: U128(DEPOSIT),
        capacity,
        arbiter: acc("arbiter.near"),
        cancel_cutoff_ms: NOW + MINUTE / 2,
        rsvp_closes_at_ms: RSVP_CLOSES,
        checkin_opens_at_ms: RSVP_CLOSES,
        checkin_closes_at_ms: RSVP_CLOSES + 6 * MINUTE,
        reveal_ms: MINUTE,
        dispute_ms: MINUTE,
        checkin: CheckinConfig {
            slots: 3,
            required: 2,
            window_ms: 2 * MINUTE,
        },
    }
}

fn contract() -> Bail {
    ctx("deployer.near", NOW, NearToken::from_near(0));
    Bail::new(config())
}

fn create(c: &mut Bail, event: NewEvent) -> EventId {
    ctx("organizer.near", NOW, seat_storage_cost(event.capacity));
    c.create_event(event)
}

fn setup(capacity: u32) -> (Bail, EventId) {
    let mut c = contract();
    let id = create(&mut c, new_event(capacity));
    (c, id)
}

fn try_event(change: impl FnOnce(&mut NewEvent)) {
    let mut c = contract();
    let mut event = new_event(10);
    change(&mut event);
    create(&mut c, event);
}

fn signer(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn ticket(seed: u8) -> PublicKey {
    let key = signer(seed).verifying_key().to_bytes().to_vec();
    PublicKey::from_parts(CurveType::ED25519, key).unwrap()
}

fn sign(seed: u8, message: &str) -> Base64VecU8 {
    Base64VecU8(signer(seed).sign(message.as_bytes()).to_bytes().to_vec())
}

// Spelled out rather than built by the contract's helper, so the format is pinned.
fn cancel_message(event_id: EventId) -> String {
    format!("bail/v1/cancel/{CONTRACT}/{event_id}")
}

fn cancel(c: &mut Bail, event_id: EventId, seed: u8, at_ms: u64, signature: Base64VecU8) {
    ctx("relayer.near", at_ms, NearToken::from_near(0));
    c.cancel_rsvp(event_id, ticket(seed), signature);
}

fn rsvp(c: &mut Bail, event_id: EventId, seed: u8, payout_to: &str) {
    assert_eq!(send(c, USDC, NOW, DEPOSIT, msg(event_id, seed, payout_to)), 0);
}

fn cancel_event_as(c: &mut Bail, event_id: EventId, who: &str, at_ms: u64, attached: NearToken) {
    ctx(who, at_ms, attached);
    c.cancel_event(event_id);
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn proof(seed: u8) -> Base64VecU8 {
    Base64VecU8(vec![seed; 32])
}

fn catch_message(event_id: EventId, slot: u8, attempt: u32, proof: &Base64VecU8) -> String {
    format!("bail/v1/catch/{CONTRACT}/{event_id}/{slot}/{attempt}/{}", to_hex(&proof.0))
}

fn flag_message(event_id: EventId, slot: u8) -> String {
    format!("bail/v1/flag/{CONTRACT}/{event_id}/{slot}")
}

// Opened by the organizer with no deposit attached, as a function-call key would.
fn open(c: &mut Bail, event_id: EventId, slot: u8, at_ms: u64) {
    ctx("organizer.near", at_ms, NearToken::from_near(0));
    c.open_slot(event_id, slot, Base64VecU8(vec![slot; 32]));
}

/// One catch submission: which slot, which attempt, which ticket, and the proof.
struct Attempt {
    slot: u8,
    number: u32,
    seed: u8,
    proof: Base64VecU8,
}

fn catch_signed(c: &mut Bail, event_id: EventId, a: Attempt, at_ms: u64, signature: Base64VecU8) {
    ctx("relayer.near", at_ms, NearToken::from_near(0));
    c.catch(event_id, a.slot, a.number, ticket(a.seed), a.proof, signature);
}

fn catch_code(c: &mut Bail, event_id: EventId, slot: u8, attempt: u32, seed: u8, p: Base64VecU8, at_ms: u64) {
    let signature = sign(seed, &catch_message(event_id, slot, attempt, &p));
    let a = Attempt { slot, number: attempt, seed, proof: p };
    catch_signed(c, event_id, a, at_ms, signature);
}

fn flag(c: &mut Bail, event_id: EventId, slot: u8, seed: u8, at_ms: u64, signature: Base64VecU8) {
    ctx("relayer.near", at_ms, NearToken::from_near(0));
    c.flag_slot(event_id, slot, ticket(seed), signature);
}

fn checkin_setup() -> (Bail, EventId) {
    let (mut c, id) = setup(10);
    rsvp(&mut c, id, 1, "near:a.near");
    rsvp(&mut c, id, 2, "near:b.near");
    (c, id)
}

fn msg(event_id: EventId, seed: u8, payout_to: &str) -> String {
    json!({ "event_id": event_id, "ticket_key": ticket(seed), "payout_to": payout_to }).to_string()
}

fn send(c: &mut Bail, token: &str, at_ms: u64, amount: u128, msg: String) -> u128 {
    ctx(token, at_ms, NearToken::from_near(0));
    match c.ft_on_transfer(acc("intents.near"), U128(amount), msg) {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => unreachable!(),
    }
}

// Config

#[test]
#[should_panic(expected = "fee above 10%")]
fn config_caps_the_fee() {
    ctx("deployer.near", NOW, NearToken::from_near(0));
    Bail::new(Config {
        fee_bps: MAX_FEE_BPS + 1,
        fee_account: Some(acc("fees.near")),
        ..config()
    });
}

#[test]
#[should_panic(expected = "a fee needs a fee account")]
fn config_fee_needs_an_account() {
    ctx("deployer.near", NOW, NearToken::from_near(0));
    Bail::new(Config {
        fee_bps: 100,
        ..config()
    });
}

#[test]
#[should_panic(expected = "code windows must be at least 60 seconds")]
fn config_enforces_the_window_floor() {
    ctx("deployer.near", NOW, NearToken::from_near(0));
    Bail::new(Config {
        min_window_ms: MIN_WINDOW_FLOOR_MS - 1,
        ..config()
    });
}

// Event schedule

#[test]
fn schedule_is_fixed_at_creation() {
    let (c, id) = setup(10);
    let e = c.get_event(id).unwrap();
    assert_eq!(e.organizer, acc("organizer.near"));
    assert_eq!(e.arbiter, acc("arbiter.near"));
    assert_eq!(e.schedule.reveal_deadline_ms, RSVP_CLOSES + 7 * MINUTE);
    assert_eq!(e.schedule.dispute_ends_at_ms, RSVP_CLOSES + 8 * MINUTE);
    assert_eq!(e.checkin.slots, 3);
}

#[test]
#[should_panic(expected = "the arbiter can't be the organizer")]
fn arbiter_cannot_be_the_organizer() {
    try_event(|e| e.arbiter = acc("organizer.near"));
}

#[test]
#[should_panic(expected = "RSVP must close in the future")]
fn rsvp_must_close_in_the_future() {
    try_event(|e| e.rsvp_closes_at_ms = NOW);
}

#[test]
#[should_panic(expected = "cancel cutoff must not be after RSVP closes")]
fn cancel_cutoff_is_before_rsvp_closes() {
    try_event(|e| e.cancel_cutoff_ms = e.rsvp_closes_at_ms + 1);
}

#[test]
#[should_panic(expected = "RSVP must close before check-in opens")]
fn rsvp_closes_before_checkin() {
    try_event(|e| e.checkin_opens_at_ms = e.rsvp_closes_at_ms - 1);
}

#[test]
#[should_panic(expected = "check-in window is empty")]
fn checkin_window_is_not_empty() {
    try_event(|e| e.checkin_closes_at_ms = e.checkin_opens_at_ms);
}

#[test]
#[should_panic(expected = "check-in window too short for its code slots")]
fn checkin_window_fits_every_slot() {
    try_event(|e| e.checkin_closes_at_ms = e.checkin_opens_at_ms + 6 * MINUTE - 1);
}

#[test]
#[should_panic(expected = "between 1 and 5 code slots")]
fn at_least_one_slot() {
    try_event(|e| e.checkin.slots = 0);
}

#[test]
#[should_panic(expected = "between 1 and 5 code slots")]
fn at_most_five_slots() {
    try_event(|e| e.checkin.slots = MAX_SLOTS + 1);
}

#[test]
#[should_panic(expected = "required catches must be between 1 and the number of slots")]
fn required_catches_fit_the_slots() {
    try_event(|e| e.checkin.required = 4);
}

#[test]
#[should_panic(expected = "required catches must be between 1 and the number of slots")]
fn at_least_one_catch_required() {
    try_event(|e| e.checkin.required = 0);
}

#[test]
#[should_panic(expected = "code window too short")]
fn window_meets_the_config_minimum() {
    try_event(|e| e.checkin.window_ms = MINUTE - 1);
}

#[test]
#[should_panic(expected = "reveal period too short")]
fn reveal_meets_the_config_minimum() {
    try_event(|e| e.reveal_ms = MINUTE - 1);
}

#[test]
#[should_panic(expected = "dispute period too short")]
fn dispute_meets_the_config_minimum() {
    try_event(|e| e.dispute_ms = MINUTE - 1);
}

#[test]
#[should_panic(expected = "event runs longer than the maximum")]
fn event_length_is_capped() {
    try_event(|e| e.dispute_ms = 30 * 24 * 60 * MINUTE);
}

#[test]
#[should_panic(expected = "schedule overflows")]
fn schedule_overflow_is_rejected() {
    try_event(|e| e.dispute_ms = u64::MAX);
}

#[test]
#[should_panic(expected = "capacity out of range")]
fn capacity_is_positive() {
    try_event(|e| e.capacity = 0);
}

#[test]
#[should_panic(expected = "capacity out of range")]
fn capacity_is_bounded() {
    try_event(|e| e.capacity = MAX_CAPACITY + 1);
}

#[test]
#[should_panic(expected = "deposit must be positive")]
fn deposit_is_positive() {
    try_event(|e| e.deposit = U128(0));
}

#[test]
#[should_panic(expected = "attach at least")]
fn event_needs_prepaid_storage() {
    let mut c = contract();
    ctx(
        "organizer.near",
        NOW,
        seat_storage_cost(10).saturating_sub(NearToken::from_yoctonear(1)),
    );
    c.create_event(new_event(10));
}

// Deposits

#[test]
fn deposit_with_note_becomes_a_seat() {
    let (mut c, id) = setup(10);
    assert_eq!(send(&mut c, USDC, NOW, DEPOSIT, msg(id, 1, "near:alice.near")), 0);
    assert_eq!(c.get_event(id).unwrap().registered, 1);
    let t = c.get_ticket(id, ticket(1)).unwrap();
    assert_eq!(t.payout_to, "near:alice.near");
    assert_eq!(t.index, 0);
}

#[test]
fn tickets_page_in_rsvp_order() {
    let (mut c, id) = setup(10);
    for seed in 1..=5 {
        send(&mut c, USDC, NOW, DEPOSIT, msg(id, seed, &format!("near:a{seed}.near")));
    }
    let first = c.get_tickets(id, 0, 2);
    let rest = c.get_tickets(id, 2, 10);
    assert_eq!(first.len(), 2);
    assert_eq!(rest.len(), 3);
    let keys: Vec<PublicKey> = first.iter().chain(&rest).map(|(k, _)| k.clone()).collect();
    assert_eq!(keys, (1..=5).map(ticket).collect::<Vec<_>>());
    assert!(c.get_tickets(id, 5, 10).is_empty());
    assert!(c.get_tickets(id + 1, 0, 10).is_empty());
}

#[test]
fn transfers_that_name_no_payout_address_bounce() {
    let (mut c, id) = setup(10);
    assert_eq!(send(&mut c, USDC, NOW, DEPOSIT, "not json".into()), DEPOSIT);
    assert_eq!(send(&mut c, USDC, NOW, DEPOSIT, msg(id, 1, "")), DEPOSIT);
    let too_long = "x".repeat(MAX_PAYOUT_LEN + 1);
    assert_eq!(send(&mut c, USDC, NOW, DEPOSIT, msg(id, 1, &too_long)), DEPOSIT);
    assert_eq!(send(&mut c, USDC, NOW, DEPOSIT, msg(id + 1, 1, "near:a.near")), DEPOSIT);
    assert_eq!(c.get_event(id).unwrap().registered, 0);
}

#[test]
fn wrong_token_bounces() {
    let (mut c, id) = setup(10);
    assert_eq!(send(&mut c, "fake-usdc.near", NOW, DEPOSIT, msg(id, 1, "near:a.near")), DEPOSIT);
    assert_eq!(c.get_event(id).unwrap().registered, 0);
}

#[test]
fn non_ed25519_ticket_bounces() {
    let (mut c, id) = setup(10);
    let secp = PublicKey::from_parts(CurveType::SECP256K1, vec![7; 64]).unwrap();
    let m = json!({ "event_id": id, "ticket_key": secp, "payout_to": "near:a.near" }).to_string();
    assert_eq!(send(&mut c, USDC, NOW, DEPOSIT, m), DEPOSIT);
}

#[test]
fn underpayment_bounces() {
    let (mut c, id) = setup(10);
    assert_eq!(send(&mut c, USDC, NOW, DEPOSIT - 1, msg(id, 1, "near:a.near")), DEPOSIT - 1);
    assert_eq!(c.get_owed(id, "near:a.near".into()).0, 0);
}

#[test]
fn late_deposit_is_owed_not_bounced() {
    let (mut c, id) = setup(10);
    assert_eq!(send(&mut c, USDC, RSVP_CLOSES, DEPOSIT, msg(id, 1, "near:a.near")), 0);
    assert_eq!(c.get_event(id).unwrap().registered, 0);
    assert_eq!(c.get_owed(id, "near:a.near".into()).0, DEPOSIT);
}

#[test]
fn deposit_into_a_full_event_is_owed() {
    let (mut c, id) = setup(1);
    send(&mut c, USDC, NOW, DEPOSIT, msg(id, 1, "near:a.near"));
    assert_eq!(send(&mut c, USDC, NOW, DEPOSIT, msg(id, 2, "near:b.near")), 0);
    assert_eq!(c.get_event(id).unwrap().registered, 1);
    assert_eq!(c.get_owed(id, "near:b.near".into()).0, DEPOSIT);
}

#[test]
fn second_deposit_for_same_ticket_is_owed() {
    let (mut c, id) = setup(10);
    send(&mut c, USDC, NOW, DEPOSIT, msg(id, 1, "near:a.near"));
    send(&mut c, USDC, NOW, DEPOSIT, msg(id, 1, "near:a.near"));
    assert_eq!(c.get_event(id).unwrap().registered, 1);
    assert_eq!(c.get_owed(id, "near:a.near".into()).0, DEPOSIT);
}

#[test]
fn overpayment_seats_and_owes_the_excess() {
    let (mut c, id) = setup(10);
    assert_eq!(send(&mut c, USDC, NOW, DEPOSIT + 250, msg(id, 1, "near:a.near")), 0);
    assert_eq!(c.get_event(id).unwrap().registered, 1);
    assert_eq!(c.get_owed(id, "near:a.near".into()).0, 250);
}

#[test]
fn owed_records_are_capped_at_capacity() {
    let (mut c, id) = setup(1);
    send(&mut c, USDC, RSVP_CLOSES, DEPOSIT, msg(id, 1, "near:first.near"));
    assert_eq!(c.get_event(id).unwrap().owed_records, 1);

    // A new payout address past the cap bounces instead of taking unpaid storage.
    assert_eq!(send(&mut c, USDC, RSVP_CLOSES, DEPOSIT, msg(id, 2, "near:second.near")), DEPOSIT);
    assert_eq!(c.get_owed(id, "near:second.near".into()).0, 0);

    // An address that already has a record can still be owed more.
    assert_eq!(send(&mut c, USDC, RSVP_CLOSES, DEPOSIT, msg(id, 3, "near:first.near")), 0);
    assert_eq!(c.get_owed(id, "near:first.near".into()).0, 2 * DEPOSIT);
    assert_eq!(c.get_event(id).unwrap().owed_records, 1);
}

#[test]
fn overpayment_past_the_owed_cap_returns_the_excess() {
    let (mut c, id) = setup(2);
    send(&mut c, USDC, RSVP_CLOSES, DEPOSIT, msg(id, 1, "near:a.near"));
    send(&mut c, USDC, RSVP_CLOSES, DEPOSIT, msg(id, 2, "near:b.near"));
    assert_eq!(send(&mut c, USDC, NOW, DEPOSIT + 250, msg(id, 3, "near:c.near")), 250);
    assert_eq!(c.get_event(id).unwrap().registered, 1);
    assert_eq!(c.get_owed(id, "near:c.near".into()).0, 0);
}

// Cancellation

#[test]
fn cancelling_frees_the_seat_and_owes_the_deposit() {
    let (mut c, id) = setup(10);
    rsvp(&mut c, id, 1, "near:a.near");
    cancel(&mut c, id, 1, NOW, sign(1, &cancel_message(id)));
    assert_eq!(c.get_event(id).unwrap().registered, 0);
    assert!(c.get_ticket(id, ticket(1)).is_none());
    assert_eq!(c.get_owed(id, "near:a.near".into()).0, DEPOSIT);
}

#[test]
fn cancelling_keeps_the_ticket_list_compact() {
    let (mut c, id) = setup(10);
    for seed in 1..=3 {
        rsvp(&mut c, id, seed, &format!("near:a{seed}.near"));
    }
    cancel(&mut c, id, 1, NOW, sign(1, &cancel_message(id)));
    let keys: Vec<PublicKey> = c.get_tickets(id, 0, 10).into_iter().map(|(k, _)| k).collect();
    assert_eq!(keys, vec![ticket(3), ticket(2)]);
    assert_eq!(c.get_ticket(id, ticket(3)).unwrap().index, 0);
    assert_eq!(c.get_ticket(id, ticket(2)).unwrap().index, 1);
}

#[test]
fn a_stolen_ticket_cannot_redirect_the_refund() {
    let (mut c, id) = setup(10);
    rsvp(&mut c, id, 1, "near:owner.near");
    ctx("thief.near", NOW, NearToken::from_near(0));
    c.cancel_rsvp(id, ticket(1), sign(1, &cancel_message(id)));
    assert_eq!(c.get_owed(id, "near:owner.near".into()).0, DEPOSIT);
    assert_eq!(c.get_owed(id, "near:thief.near".into()).0, 0);
}

#[test]
#[should_panic(expected = "invalid signature")]
fn cancel_rejects_another_keys_signature() {
    let (mut c, id) = setup(10);
    rsvp(&mut c, id, 1, "near:a.near");
    cancel(&mut c, id, 1, NOW, sign(2, &cancel_message(id)));
}

#[test]
#[should_panic(expected = "invalid signature")]
fn cancel_rejects_a_signature_for_another_event() {
    let (mut c, id) = setup(10);
    rsvp(&mut c, id, 1, "near:a.near");
    cancel(&mut c, id, 1, NOW, sign(1, &cancel_message(id + 1)));
}

#[test]
#[should_panic(expected = "invalid signature")]
fn cancel_rejects_a_signature_for_another_contract() {
    let (mut c, id) = setup(10);
    rsvp(&mut c, id, 1, "near:a.near");
    cancel(&mut c, id, 1, NOW, sign(1, &format!("bail/v1/cancel/other.near/{id}")));
}

#[test]
#[should_panic(expected = "invalid signature")]
fn cancel_rejects_a_malformed_signature() {
    let (mut c, id) = setup(10);
    rsvp(&mut c, id, 1, "near:a.near");
    cancel(&mut c, id, 1, NOW, Base64VecU8(vec![0; 10]));
}

#[test]
#[should_panic(expected = "cancel cutoff has passed")]
fn cancel_after_the_cutoff_fails() {
    let (mut c, id) = setup(10);
    rsvp(&mut c, id, 1, "near:a.near");
    let cutoff = c.get_event(id).unwrap().schedule.cancel_cutoff_ms;
    cancel(&mut c, id, 1, cutoff, sign(1, &cancel_message(id)));
}

#[test]
#[should_panic(expected = "no such ticket")]
fn cancelling_twice_fails() {
    let (mut c, id) = setup(10);
    rsvp(&mut c, id, 1, "near:a.near");
    cancel(&mut c, id, 1, NOW, sign(1, &cancel_message(id)));
    cancel(&mut c, id, 1, NOW, sign(1, &cancel_message(id)));
}

#[test]
fn a_cancelled_ticket_can_rsvp_again() {
    let (mut c, id) = setup(10);
    rsvp(&mut c, id, 1, "near:a.near");
    cancel(&mut c, id, 1, NOW, sign(1, &cancel_message(id)));
    rsvp(&mut c, id, 1, "near:a.near");
    assert_eq!(c.get_event(id).unwrap().registered, 1);
    assert_eq!(c.get_owed(id, "near:a.near".into()).0, DEPOSIT);
}

#[test]
fn a_cancellation_refund_ignores_the_owed_cap() {
    let (mut c, id) = setup(1);
    rsvp(&mut c, id, 1, "near:a.near");
    send(&mut c, USDC, NOW, DEPOSIT, msg(id, 2, "near:b.near"));
    assert_eq!(c.get_event(id).unwrap().owed_records, 1);
    cancel(&mut c, id, 1, NOW, sign(1, &cancel_message(id)));
    assert_eq!(c.get_owed(id, "near:a.near".into()).0, DEPOSIT);
}

#[test]
fn organizer_can_cancel_before_checkin() {
    let (mut c, id) = setup(10);
    cancel_event_as(&mut c, id, "organizer.near", NOW, NearToken::from_yoctonear(1));
    assert_eq!(c.get_event(id).unwrap().status, Status::Cancelled);
}

#[test]
#[should_panic(expected = "exactly 1 yoctoNEAR")]
fn cancelling_an_event_needs_a_full_access_key() {
    let (mut c, id) = setup(10);
    cancel_event_as(&mut c, id, "organizer.near", NOW, NearToken::from_near(0));
}

#[test]
#[should_panic(expected = "only the organizer can cancel")]
fn only_the_organizer_can_cancel() {
    let (mut c, id) = setup(10);
    cancel_event_as(&mut c, id, "arbiter.near", NOW, NearToken::from_yoctonear(1));
}

#[test]
#[should_panic(expected = "check-in has started")]
fn organizer_cannot_cancel_once_checkin_opens() {
    let (mut c, id) = setup(10);
    let opens = c.get_event(id).unwrap().schedule.checkin_opens_at_ms;
    cancel_event_as(&mut c, id, "organizer.near", opens, NearToken::from_yoctonear(1));
}

#[test]
#[should_panic(expected = "event is not active")]
fn an_event_cannot_be_cancelled_twice() {
    let (mut c, id) = setup(10);
    cancel_event_as(&mut c, id, "organizer.near", NOW, NearToken::from_yoctonear(1));
    cancel_event_as(&mut c, id, "organizer.near", NOW, NearToken::from_yoctonear(1));
}

#[test]
fn deposits_into_a_cancelled_event_are_owed() {
    let (mut c, id) = setup(10);
    cancel_event_as(&mut c, id, "organizer.near", NOW, NearToken::from_yoctonear(1));
    assert_eq!(send(&mut c, USDC, NOW, DEPOSIT, msg(id, 1, "near:a.near")), 0);
    assert_eq!(c.get_event(id).unwrap().registered, 0);
    assert_eq!(c.get_owed(id, "near:a.near".into()).0, DEPOSIT);
}

#[test]
#[should_panic(expected = "event is not active")]
fn tickets_in_a_cancelled_event_cannot_cancel_separately() {
    let (mut c, id) = setup(10);
    rsvp(&mut c, id, 1, "near:a.near");
    cancel_event_as(&mut c, id, "organizer.near", NOW, NearToken::from_yoctonear(1));
    cancel(&mut c, id, 1, NOW, sign(1, &cancel_message(id)));
}

// Code slots

#[test]
fn slots_open_one_at_a_time_inside_checkin() {
    let (mut c, id) = setup(10);
    open(&mut c, id, 0, OPENS);
    open(&mut c, id, 1, OPENS + WINDOW);
    open(&mut c, id, 2, OPENS + 2 * WINDOW);
    let opened: Vec<u64> = c.get_event(id).unwrap().slots.iter().map(|s| s.opened_at_ms).collect();
    assert_eq!(opened, vec![OPENS, OPENS + WINDOW, OPENS + 2 * WINDOW]);
}

#[test]
#[should_panic(expected = "check-in is not open")]
fn a_slot_cannot_open_before_checkin() {
    let (mut c, id) = setup(10);
    open(&mut c, id, 0, OPENS - 1);
}

#[test]
#[should_panic(expected = "the previous code window is still open")]
fn the_next_slot_waits_for_the_previous_window() {
    let (mut c, id) = setup(10);
    open(&mut c, id, 0, OPENS);
    open(&mut c, id, 1, OPENS + WINDOW - 1);
}

#[test]
#[should_panic(expected = "slots open in order, once each")]
fn slots_open_in_order() {
    let (mut c, id) = setup(10);
    open(&mut c, id, 1, OPENS);
}

#[test]
#[should_panic(expected = "slots open in order, once each")]
fn a_slot_cannot_open_twice() {
    let (mut c, id) = setup(10);
    open(&mut c, id, 0, OPENS);
    open(&mut c, id, 0, OPENS + WINDOW);
}

#[test]
#[should_panic(expected = "no such slot")]
fn no_slot_beyond_the_declared_count() {
    let (mut c, id) = setup(10);
    for slot in 0..3 {
        open(&mut c, id, slot, OPENS + u64::from(slot) * WINDOW);
    }
    open(&mut c, id, 3, CLOSES);
}

#[test]
#[should_panic(expected = "the window would end after check-in closes")]
fn a_window_must_end_before_checkin_closes() {
    let (mut c, id) = setup(10);
    open(&mut c, id, 0, CLOSES - WINDOW + 1);
}

#[test]
#[should_panic(expected = "only the organizer opens slots")]
fn only_the_organizer_opens_slots() {
    let (mut c, id) = setup(10);
    ctx("relayer.near", OPENS, NearToken::from_near(0));
    c.open_slot(id, 0, Base64VecU8(vec![0; 32]));
}

#[test]
#[should_panic(expected = "commitment must be 32 bytes")]
fn a_commitment_is_32_bytes() {
    let (mut c, id) = setup(10);
    ctx("organizer.near", OPENS, NearToken::from_near(0));
    c.open_slot(id, 0, Base64VecU8(vec![0; 31]));
}

// Catching codes

#[test]
fn catches_count_from_the_first_to_the_last_millisecond() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    catch_code(&mut c, id, 0, 1, 1, proof(7), OPENS);
    catch_code(&mut c, id, 0, 1, 2, proof(8), OPENS + WINDOW - 1);
    let first = c.get_ticket(id, ticket(1)).unwrap().catches[0].clone().unwrap();
    assert_eq!((first.attempt, first.proof), (1, proof(7)));
    assert!(c.get_ticket(id, ticket(2)).unwrap().catches[0].is_some());
}

#[test]
#[should_panic(expected = "code window is closed")]
fn a_catch_at_the_closing_instant_fails() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    catch_code(&mut c, id, 0, 1, 1, proof(7), OPENS + WINDOW);
}

#[test]
#[should_panic(expected = "slot is not open")]
fn catching_an_unopened_slot_fails() {
    let (mut c, id) = checkin_setup();
    catch_code(&mut c, id, 0, 1, 1, proof(7), OPENS);
}

#[test]
#[should_panic(expected = "no such ticket")]
fn only_registered_tickets_catch() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    catch_code(&mut c, id, 0, 1, 9, proof(7), OPENS);
}

#[test]
#[should_panic(expected = "invalid signature")]
fn a_catch_needs_the_tickets_own_signature() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    let signature = sign(2, &catch_message(id, 0, 1, &proof(7)));
    catch_signed(&mut c, id, Attempt { slot: 0, number: 1, seed: 1, proof: proof(7) }, OPENS, signature);
}

#[test]
#[should_panic(expected = "invalid signature")]
fn the_signature_covers_the_proof() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    let signature = sign(1, &catch_message(id, 0, 1, &proof(7)));
    catch_signed(&mut c, id, Attempt { slot: 0, number: 1, seed: 1, proof: proof(8) }, OPENS, signature);
}

#[test]
#[should_panic(expected = "invalid signature")]
fn the_signature_covers_the_slot() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    open(&mut c, id, 1, OPENS + WINDOW);
    let signature = sign(1, &catch_message(id, 0, 1, &proof(7)));
    catch_signed(&mut c, id, Attempt { slot: 1, number: 1, seed: 1, proof: proof(7) }, OPENS + WINDOW, signature);
}

#[test]
fn a_higher_attempt_fixes_a_typo() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    catch_code(&mut c, id, 0, 1, 1, proof(7), OPENS);
    catch_code(&mut c, id, 0, 2, 1, proof(8), OPENS + 1);
    let current = c.get_ticket(id, ticket(1)).unwrap().catches[0].clone().unwrap();
    assert_eq!((current.attempt, current.proof), (2, proof(8)));
}

#[test]
#[should_panic(expected = "attempt must be higher than the last")]
fn an_older_attempt_cannot_be_replayed() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    let old = sign(1, &catch_message(id, 0, 1, &proof(7)));
    catch_signed(&mut c, id, Attempt { slot: 0, number: 1, seed: 1, proof: proof(7) }, OPENS, old.clone());
    catch_code(&mut c, id, 0, 2, 1, proof(8), OPENS + 1);
    catch_signed(&mut c, id, Attempt { slot: 0, number: 1, seed: 1, proof: proof(7) }, OPENS + 2, old);
}

#[test]
#[should_panic(expected = "attempt must be higher than the last")]
fn the_same_attempt_cannot_be_resubmitted() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    catch_code(&mut c, id, 0, 1, 1, proof(7), OPENS);
    catch_code(&mut c, id, 0, 1, 1, proof(8), OPENS + 1);
}

#[test]
#[should_panic(expected = "proof must be 32 bytes")]
fn a_proof_is_32_bytes() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    catch_code(&mut c, id, 0, 1, 1, Base64VecU8(vec![7; 31]), OPENS);
}

// Flags

#[test]
fn a_flag_counts_once_per_ticket() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    flag(&mut c, id, 0, 1, OPENS, sign(1, &flag_message(id, 0)));
    flag(&mut c, id, 0, 2, OPENS + 1, sign(2, &flag_message(id, 0)));
    assert_eq!(c.get_event(id).unwrap().slots[0].flags, 2);
    assert_eq!(c.get_ticket(id, ticket(1)).unwrap().flags, 0b1);
}

#[test]
#[should_panic(expected = "already flagged")]
fn flagging_twice_fails() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    flag(&mut c, id, 0, 1, OPENS, sign(1, &flag_message(id, 0)));
    flag(&mut c, id, 0, 1, OPENS + 1, sign(1, &flag_message(id, 0)));
}

#[test]
#[should_panic(expected = "slot is not open")]
fn flagging_an_unopened_slot_fails() {
    let (mut c, id) = checkin_setup();
    flag(&mut c, id, 0, 1, OPENS, sign(1, &flag_message(id, 0)));
}

#[test]
#[should_panic(expected = "flagging has closed")]
fn flagging_closes_at_the_reveal_deadline() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    let deadline = c.get_event(id).unwrap().schedule.reveal_deadline_ms;
    flag(&mut c, id, 0, 1, deadline, sign(1, &flag_message(id, 0)));
}

#[test]
#[should_panic(expected = "invalid signature")]
fn a_flag_needs_the_tickets_own_signature() {
    let (mut c, id) = checkin_setup();
    open(&mut c, id, 0, OPENS);
    flag(&mut c, id, 0, 1, OPENS, sign(2, &flag_message(id, 0)));
}

// Storage

/// Bytes each seat will still need for a record that a later stage adds: reputation
/// (key prefix, payout address, four counters, record overhead).
const RESERVED_PER_SEAT: u64 = 1 + 4 + MAX_PAYOUT_LEN as u64 + 16 + 40;
/// Bytes each event will still need: a revealed code of up to 64 bytes per slot, and
/// the settlement totals.
const RESERVED_PER_EVENT: u64 = 5 * (1 + 4 + 64) + 8 * 16;

#[test]
fn prepaid_storage_covers_a_full_event() {
    let capacity = 25;
    let mut c = contract();
    let before = env::storage_usage();
    let mut event = new_event(capacity);
    event.checkin = CheckinConfig { slots: MAX_SLOTS, required: MAX_SLOTS, window_ms: WINDOW };
    event.checkin_closes_at_ms = OPENS + u64::from(MAX_SLOTS) * WINDOW;
    event.token = acc(&format!("{}.near", "t".repeat(59)));
    event.arbiter = acc(&format!("{}.near", "a".repeat(59)));
    let token = event.token.to_string();
    let id = create(&mut c, event);

    let payout = |i: u32| format!("{i:03}{}", "x".repeat(MAX_PAYOUT_LEN - 3));
    for i in 0..capacity {
        send(&mut c, &token, NOW, DEPOSIT, msg(id, i as u8, &payout(i)));
    }
    for i in 0..capacity {
        send(&mut c, &token, RSVP_CLOSES, DEPOSIT, msg(id, 200, &payout(100 + i)));
    }
    for slot in 0..MAX_SLOTS {
        let at = OPENS + u64::from(slot) * WINDOW;
        open(&mut c, id, slot, at);
        for i in 0..capacity {
            catch_code(&mut c, id, slot, u32::MAX, i as u8, proof(slot), at);
            flag(&mut c, id, slot, i as u8, at, sign(i as u8, &flag_message(id, slot)));
        }
    }
    let e = c.get_event(id).unwrap();
    assert_eq!((e.registered, e.owed_records), (capacity, capacity));
    assert_eq!(e.slots.len(), usize::from(MAX_SLOTS));

    c.events.flush();
    c.tickets.flush();
    c.ticket_index.flush();
    c.owed.flush();
    let used = env::storage_usage() - before;
    let needed = used + RESERVED_PER_EVENT + RESERVED_PER_SEAT * u64::from(capacity);
    let prepaid = seat_storage_cost(capacity).as_yoctonear() / env::storage_byte_cost().as_yoctonear();
    println!("storage for {capacity} seats: needs {needed} bytes, prepaid {prepaid}");
    assert!(needed <= prepaid as u64, "needs {needed} bytes, prepaid {prepaid}");
}
