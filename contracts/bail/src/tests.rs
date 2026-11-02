use ed25519_dalek::{Signer, SigningKey};
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::json;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::get_created_receipts;
use near_sdk::{
    env, testing_env, AccountId, CurveType, NearToken, PromiseOrValue, PromiseResult, PublicKey,
    RuntimeFeesConfig,
};

use crate::event::seat_storage_cost;
use crate::reveal::{catch_proof, code_commitment, normalize_code, qualifies, SlotState};
use crate::payout::{OWED_RECORD_BYTES, REPUTATION_RECORD_BYTES};
use crate::settle::payout_amount;
use crate::*;

mod proptests;

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

const CODE: &str = "tiger maple seven ocean lamp";

fn key_bytes(seed: u8) -> [u8; 32] {
    signer(seed).verifying_key().to_bytes()
}

fn open_code(c: &mut Bail, event_id: EventId, slot: u8, at_ms: u64, code: &str) {
    ctx("organizer.near", at_ms, NearToken::from_near(0));
    let commitment = code_commitment(event_id, slot, code);
    c.open_slot(event_id, slot, Base64VecU8(commitment.to_vec()));
}

fn catch_heard(c: &mut Bail, event_id: EventId, slot: u8, seed: u8, heard: &str, at_ms: u64) {
    let p = Base64VecU8(catch_proof(event_id, slot, heard, &key_bytes(seed)).to_vec());
    catch_code(c, event_id, slot, 1, seed, p, at_ms);
}

fn reveal_code(c: &mut Bail, event_id: EventId, slot: u8, code: &str, at_ms: u64) {
    ctx("anyone.near", at_ms, NearToken::from_near(0));
    c.reveal(event_id, slot, code.to_string());
}

fn standing_at(c: &Bail, event_id: EventId, seed: u8, at_ms: u64) -> Standing {
    ctx("anyone.near", at_ms, NearToken::from_near(0));
    c.standing(event_id, ticket(seed)).unwrap()
}

const CODES: [&str; 3] = ["alpha one", "bravo two", "charlie three"];

/// Tickets 1 and 2 catch every code, ticket 4 catches one, ticket 3's phone died.
/// Returns the event with every code revealed, and the reveal and dispute deadlines.
fn dispute_setup() -> (Bail, EventId, u64, u64) {
    let (mut c, id) = setup(10);
    for seed in 1..=4 {
        rsvp(&mut c, id, seed, &format!("near:t{seed}.near"));
    }
    for (slot, code) in CODES.iter().enumerate() {
        let (slot, at) = (slot as u8, OPENS + slot as u64 * WINDOW);
        open_code(&mut c, id, slot, at, code);
        catch_heard(&mut c, id, slot, 1, code, at);
        catch_heard(&mut c, id, slot, 2, code, at);
        if slot == 0 {
            catch_heard(&mut c, id, slot, 4, code, at);
        }
    }
    for (slot, code) in CODES.iter().enumerate() {
        reveal_code(&mut c, id, slot as u8, code, CLOSES);
    }
    let s = c.get_event(id).unwrap().schedule;
    (c, id, s.reveal_deadline_ms, s.dispute_ends_at_ms)
}

fn vouch_message(event_id: EventId, target: u8) -> String {
    format!("bail/v1/vouch/{CONTRACT}/{event_id}/{}", ticket(target))
}

fn vouch_signed(c: &mut Bail, event_id: EventId, voucher: u8, target: u8, at_ms: u64, signature: Base64VecU8) {
    ctx("relayer.near", at_ms, NearToken::from_near(0));
    c.vouch(event_id, ticket(voucher), ticket(target), signature);
}

fn vouch(c: &mut Bail, event_id: EventId, voucher: u8, target: u8, at_ms: u64) {
    let signature = sign(voucher, &vouch_message(event_id, target));
    vouch_signed(c, event_id, voucher, target, at_ms, signature);
}

fn void_as(c: &mut Bail, event_id: EventId, who: &str, at_ms: u64, attached: NearToken) {
    ctx(who, at_ms, attached);
    c.void_event(event_id);
}

fn tally_all(c: &mut Bail, event_id: EventId, at_ms: u64, limit: u32) -> Tally {
    ctx("keeper.near", at_ms, NearToken::from_near(0));
    while c.tally(event_id, limit) != TallyStage::Done {}
    c.event_totals(event_id).unwrap()
}

fn payout_of(c: &Bail, event_id: EventId, seed: u8) -> u128 {
    c.get_payout(event_id, ticket(seed)).unwrap().0
}

/// The worked example in ARCHITECTURE.md section 6.7: 20 RSVPs at 1 USDC, tickets 1 to 15
/// catch every code, 16 is vouched for by 1 and 2, and 17 to 20 never show.
fn worked_example(fee: Option<(u16, &str)>) -> (Bail, EventId, u64) {
    ctx("deployer.near", NOW, NearToken::from_near(0));
    let mut c = Bail::new(Config {
        fee_bps: fee.map_or(0, |f| f.0),
        fee_account: fee.map(|f| acc(f.1)),
        ..config()
    });
    let id = create(&mut c, new_event(20));
    for seed in 1..=20 {
        rsvp(&mut c, id, seed, &format!("near:t{seed}.near"));
    }
    for (slot, code) in CODES.iter().enumerate() {
        let (slot, at) = (slot as u8, OPENS + slot as u64 * WINDOW);
        open_code(&mut c, id, slot, at, code);
        for seed in 1..=15 {
            catch_heard(&mut c, id, slot, seed, code, at);
        }
    }
    for (slot, code) in CODES.iter().enumerate() {
        reveal_code(&mut c, id, slot as u8, code, CLOSES);
    }
    let s = c.get_event(id).unwrap().schedule;
    vouch(&mut c, id, 1, 16, s.reveal_deadline_ms);
    vouch(&mut c, id, 2, 16, s.reveal_deadline_ms);
    (c, id, s.dispute_ends_at_ms)
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

// Reveal and qualification

#[test]
fn hashes_match_the_independent_test_vectors() {
    // Computed separately in Python from the field layout in ARCHITECTURE.md section 6.10.
    ctx("anyone.near", NOW, NearToken::from_near(0));
    assert_eq!(
        to_hex(&code_commitment(7, 2, CODE)),
        "7b5c424e3d0bd348bd83951b83df2094a04cb91ba3b0c1e312fcaca412ab8e29"
    );
    assert_eq!(
        to_hex(&catch_proof(7, 2, CODE, &[0x11; 32])),
        "e0150c423d6ff2364b228af39e5130332af485bebb8c281ba1780a8cfb5d2ca8"
    );
}

#[test]
fn codes_are_normalized() {
    assert_eq!(normalize_code("  Tiger  MAPLE\tseven ocean LAMP "), CODE);
}

#[test]
fn a_revealed_code_verifies_correct_catches() {
    let (mut c, id) = checkin_setup();
    open_code(&mut c, id, 0, OPENS, CODE);
    catch_heard(&mut c, id, 0, 1, CODE, OPENS);
    catch_heard(&mut c, id, 0, 2, "tiger maple seven ocean lump", OPENS);
    reveal_code(&mut c, id, 0, CODE, OPENS + WINDOW);
    assert_eq!(c.get_event(id).unwrap().slots[0].revealed.as_deref(), Some(CODE));
    assert_eq!(standing_at(&c, id, 1, OPENS + WINDOW).verified_catches, 1);
    assert_eq!(standing_at(&c, id, 2, OPENS + WINDOW).verified_catches, 0);
}

#[test]
fn a_copied_proof_does_not_count() {
    let (mut c, id) = checkin_setup();
    open_code(&mut c, id, 0, OPENS, CODE);
    let ones_proof = Base64VecU8(catch_proof(id, 0, CODE, &key_bytes(1)).to_vec());
    catch_code(&mut c, id, 0, 1, 1, ones_proof.clone(), OPENS);
    catch_code(&mut c, id, 0, 1, 2, ones_proof, OPENS);
    reveal_code(&mut c, id, 0, CODE, OPENS + WINDOW);
    assert_eq!(standing_at(&c, id, 1, OPENS + WINDOW).verified_catches, 1);
    assert_eq!(standing_at(&c, id, 2, OPENS + WINDOW).verified_catches, 0);
}

#[test]
fn reveals_accept_any_spacing_and_case() {
    let (mut c, id) = checkin_setup();
    open_code(&mut c, id, 0, OPENS, CODE);
    reveal_code(&mut c, id, 0, "  TIGER maple  Seven ocean LAMP", OPENS + WINDOW);
    assert_eq!(c.get_event(id).unwrap().slots[0].revealed.as_deref(), Some(CODE));
}

#[test]
#[should_panic(expected = "the code window is still open")]
fn a_code_cannot_be_revealed_inside_its_window() {
    let (mut c, id) = checkin_setup();
    open_code(&mut c, id, 0, OPENS, CODE);
    reveal_code(&mut c, id, 0, CODE, OPENS + WINDOW - 1);
}

#[test]
#[should_panic(expected = "code does not match the commitment")]
fn a_wrong_code_cannot_be_revealed() {
    let (mut c, id) = checkin_setup();
    open_code(&mut c, id, 0, OPENS, CODE);
    reveal_code(&mut c, id, 0, "tiger maple seven ocean lump", OPENS + WINDOW);
}

#[test]
#[should_panic(expected = "the reveal deadline has passed")]
fn reveals_close_at_the_deadline() {
    let (mut c, id) = checkin_setup();
    open_code(&mut c, id, 0, OPENS, CODE);
    let deadline = c.get_event(id).unwrap().schedule.reveal_deadline_ms;
    reveal_code(&mut c, id, 0, CODE, deadline);
}

#[test]
#[should_panic(expected = "already revealed")]
fn a_code_is_revealed_once() {
    let (mut c, id) = checkin_setup();
    open_code(&mut c, id, 0, OPENS, CODE);
    reveal_code(&mut c, id, 0, CODE, OPENS + WINDOW);
    reveal_code(&mut c, id, 0, CODE, OPENS + WINDOW + 1);
}

#[test]
#[should_panic(expected = "code must be 1 to 64 bytes")]
fn an_empty_code_cannot_be_revealed() {
    let (mut c, id) = checkin_setup();
    open_code(&mut c, id, 0, OPENS, CODE);
    reveal_code(&mut c, id, 0, "   ", OPENS + WINDOW);
}

#[test]
fn attending_takes_r_of_k_verified_catches() {
    let (mut c, id) = checkin_setup();
    let codes = ["alpha one", "bravo two", "charlie three"];
    for (slot, code) in codes.iter().enumerate() {
        let at = OPENS + slot as u64 * WINDOW;
        open_code(&mut c, id, slot as u8, at, code);
        catch_heard(&mut c, id, slot as u8, 2, if slot == 0 { code } else { "misheard" }, at);
        if slot < 2 {
            catch_heard(&mut c, id, slot as u8, 1, code, at);
        }
    }
    for (slot, code) in codes.iter().enumerate() {
        reveal_code(&mut c, id, slot as u8, code, CLOSES);
    }
    let deadline = c.get_event(id).unwrap().schedule.reveal_deadline_ms;
    let one = standing_at(&c, id, 1, deadline);
    let two = standing_at(&c, id, 2, deadline);
    assert!(one.attended && one.is_final);
    assert_eq!((one.verified_catches, one.catches_needed), (2, 2));
    assert!(!two.attended && two.is_final);
    assert_eq!(two.verified_catches, 1);
}

#[test]
fn a_host_who_never_reveals_leaves_everyone_qualified() {
    let (mut c, id) = checkin_setup();
    for slot in 0..3 {
        open_code(&mut c, id, slot, OPENS + u64::from(slot) * WINDOW, CODE);
    }
    let deadline = c.get_event(id).unwrap().schedule.reveal_deadline_ms;
    assert!(!standing_at(&c, id, 2, deadline - 1).attended);
    let two = standing_at(&c, id, 2, deadline);
    assert!(two.attended && two.is_final);
    assert_eq!((two.void_slots, two.catches_needed), (3, 0));
}

#[test]
fn slots_never_opened_go_void_when_checkin_closes() {
    let (mut c, id) = checkin_setup();
    open_code(&mut c, id, 0, OPENS, CODE);
    catch_heard(&mut c, id, 0, 1, CODE, OPENS);
    reveal_code(&mut c, id, 0, CODE, OPENS + WINDOW);

    let before = standing_at(&c, id, 2, CLOSES - 1);
    assert_eq!((before.void_slots, before.attended), (0, false));

    let after = standing_at(&c, id, 2, CLOSES);
    assert_eq!((after.void_slots, after.catches_needed), (2, 0));
    assert!(after.attended && !after.is_final);
}

#[test]
fn voiding_a_slot_never_disqualifies_anyone() {
    // Every combination of slot outcomes for every K and R: turning any one revealed
    // slot void must never flip a ticket from attended to not attended.
    let outcomes = [
        SlotState::Void,
        SlotState::Revealed { caught: true },
        SlotState::Revealed { caught: false },
    ];
    let mut checked = 0;
    for k in 1..=MAX_SLOTS {
        for r in 1..=k {
            for n in 0..3usize.pow(u32::from(k)) {
                let states: Vec<SlotState> =
                    (0..k).map(|i| outcomes[n / 3usize.pow(u32::from(i)) % 3]).collect();
                let before = qualifies(r, &states);
                for i in 0..usize::from(k) {
                    if states[i] == SlotState::Void {
                        continue;
                    }
                    let mut voided = states.clone();
                    voided[i] = SlotState::Void;
                    assert!(qualifies(r, &voided) || !before, "k={k} r={r} {states:?} slot {i}");
                    checked += 1;
                }
            }
        }
        assert!(qualifies(1, &vec![SlotState::Void; usize::from(k)]));
    }
    assert!(checked > 1_000);
}

// Vouching

#[test]
fn two_attendees_vouch_for_a_dead_phone() {
    let (mut c, id, deadline, _) = dispute_setup();
    assert!(!standing_at(&c, id, 3, deadline).attended);
    vouch(&mut c, id, 1, 3, deadline);
    vouch(&mut c, id, 2, 3, deadline + 1);
    assert_eq!(standing_at(&c, id, 3, deadline + 1).vouches, VOUCHES_NEEDED);
    assert_eq!(c.get_ticket(id, ticket(1)).unwrap().vouched_for, Some(ticket(3)));
}

#[test]
#[should_panic(expected = "only attendees can vouch")]
fn only_attendees_can_vouch() {
    let (mut c, id, deadline, _) = dispute_setup();
    vouch(&mut c, id, 4, 3, deadline);
}

#[test]
#[should_panic(expected = "already vouched")]
fn each_attendee_vouches_once() {
    let (mut c, id, deadline, _) = dispute_setup();
    vouch(&mut c, id, 1, 3, deadline);
    vouch(&mut c, id, 1, 4, deadline);
}

#[test]
#[should_panic(expected = "you can't vouch for yourself")]
fn nobody_vouches_for_themselves() {
    let (mut c, id, deadline, _) = dispute_setup();
    vouch(&mut c, id, 1, 1, deadline);
}

#[test]
#[should_panic(expected = "the target already attended")]
fn vouching_is_only_for_people_who_missed_out() {
    let (mut c, id, deadline, _) = dispute_setup();
    vouch(&mut c, id, 1, 2, deadline);
}

#[test]
#[should_panic(expected = "vouching opens at the reveal deadline")]
fn vouching_waits_for_final_attendance() {
    let (mut c, id, deadline, _) = dispute_setup();
    vouch(&mut c, id, 1, 3, deadline - 1);
}

#[test]
#[should_panic(expected = "the dispute window has closed")]
fn vouching_closes_with_the_dispute_window() {
    let (mut c, id, _, ends) = dispute_setup();
    vouch(&mut c, id, 1, 3, ends);
}

#[test]
#[should_panic(expected = "invalid signature")]
fn a_vouch_needs_the_vouchers_own_signature() {
    let (mut c, id, deadline, _) = dispute_setup();
    let signature = sign(2, &vouch_message(id, 3));
    vouch_signed(&mut c, id, 1, 3, deadline, signature);
}

#[test]
#[should_panic(expected = "invalid signature")]
fn a_vouch_cannot_be_redirected() {
    let (mut c, id, deadline, _) = dispute_setup();
    let signature = sign(1, &vouch_message(id, 3));
    vouch_signed(&mut c, id, 1, 4, deadline, signature);
}

#[test]
#[should_panic(expected = "no such ticket")]
fn vouching_needs_a_registered_target() {
    let (mut c, id, deadline, _) = dispute_setup();
    vouch(&mut c, id, 1, 9, deadline);
}

// Arbiter

#[test]
fn the_arbiter_can_void_until_the_dispute_window_ends() {
    let (mut c, id, _, ends) = dispute_setup();
    void_as(&mut c, id, "arbiter.near", ends - 1, NearToken::from_yoctonear(1));
    assert_eq!(c.get_event(id).unwrap().status, Status::Voided);
}

#[test]
#[should_panic(expected = "exactly 1 yoctoNEAR")]
fn voiding_needs_a_full_access_key() {
    let (mut c, id, deadline, _) = dispute_setup();
    void_as(&mut c, id, "arbiter.near", deadline, NearToken::from_near(0));
}

#[test]
#[should_panic(expected = "only the arbiter can void")]
fn only_the_arbiter_can_void() {
    let (mut c, id, deadline, _) = dispute_setup();
    void_as(&mut c, id, "organizer.near", deadline, NearToken::from_yoctonear(1));
}

#[test]
#[should_panic(expected = "the dispute window has closed")]
fn voiding_closes_with_the_dispute_window() {
    let (mut c, id, _, ends) = dispute_setup();
    void_as(&mut c, id, "arbiter.near", ends, NearToken::from_yoctonear(1));
}

#[test]
#[should_panic(expected = "event is not active")]
fn an_event_is_voided_once() {
    let (mut c, id, deadline, _) = dispute_setup();
    void_as(&mut c, id, "arbiter.near", deadline, NearToken::from_yoctonear(1));
    void_as(&mut c, id, "arbiter.near", deadline, NearToken::from_yoctonear(1));
}

#[test]
fn deposits_into_a_voided_event_are_owed() {
    let (mut c, id) = setup(10);
    void_as(&mut c, id, "arbiter.near", NOW, NearToken::from_yoctonear(1));
    assert_eq!(send(&mut c, USDC, NOW, DEPOSIT, msg(id, 1, "near:a.near")), 0);
    assert_eq!(c.get_event(id).unwrap().registered, 0);
    assert_eq!(c.get_owed(id, "near:a.near".into()).0, DEPOSIT);
}

#[test]
#[should_panic(expected = "event is not active")]
fn a_voided_event_stops_checkin() {
    let (mut c, id) = checkin_setup();
    open_code(&mut c, id, 0, OPENS, CODE);
    void_as(&mut c, id, "arbiter.near", OPENS + 1, NearToken::from_yoctonear(1));
    catch_heard(&mut c, id, 0, 1, CODE, OPENS + 2);
}

#[test]
#[should_panic(expected = "event is not active")]
fn a_voided_event_stops_vouching() {
    let (mut c, id, deadline, _) = dispute_setup();
    void_as(&mut c, id, "arbiter.near", deadline, NearToken::from_yoctonear(1));
    vouch(&mut c, id, 1, 3, deadline);
}

// Tally and reputation

#[test]
fn tally_reproduces_the_worked_example() {
    let (mut c, id, ends) = worked_example(None);
    let t = tally_all(&mut c, id, ends, 1_000);
    assert_eq!((t.attended, t.vouched, t.forfeited, t.refunded), (15, 1, 4, 0));
    assert_eq!((t.pool.0, t.fee.0, t.bonus.0, t.dust.0), (4_000_000, 0, 266_666, 10));
    assert!(t.measured && !t.everyone_refunded);

    assert_eq!(payout_of(&c, id, 1), 1_266_666);
    assert_eq!(payout_of(&c, id, 16), 1_000_000);
    assert_eq!(payout_of(&c, id, 20), 0);
    let paid: u128 = (1..=20).map(|seed| payout_of(&c, id, seed)).sum();
    assert_eq!(paid + t.fee.0 + t.dust.0, 20 * DEPOSIT);
}

#[test]
fn paging_gives_the_same_result_as_one_call() {
    let (mut one, id, ends) = worked_example(None);
    let (mut paged, _, _) = worked_example(None);
    let whole = tally_all(&mut one, id, ends, 1_000);
    let pages = tally_all(&mut paged, id, ends, 3);
    assert_eq!(whole, pages);
    for seed in 1..=20 {
        assert_eq!(one.get_ticket(id, ticket(seed)), paged.get_ticket(id, ticket(seed)));
        let address = format!("near:t{seed}.near");
        assert_eq!(one.reliability(address.clone()), paged.reliability(address));
    }
}

#[test]
fn the_fee_comes_only_from_forfeits() {
    let (mut c, id, ends) = worked_example(Some((500, "fees.near")));
    let t = tally_all(&mut c, id, ends, 1_000);
    assert_eq!((t.pool.0, t.fee.0, t.bonus.0, t.dust.0), (4_000_000, 200_000, 253_333, 5));
    assert_eq!(payout_of(&c, id, 16), DEPOSIT);
    let paid: u128 = (1..=20).map(|seed| payout_of(&c, id, seed)).sum();
    assert_eq!(paid + t.fee.0 + t.dust.0, 20 * DEPOSIT);
}

#[test]
fn reliability_records_proven_attendance() {
    let (mut c, id, ends) = worked_example(None);
    tally_all(&mut c, id, ends, 1_000);
    let record = |a: &str| c.reliability(a.to_string());
    assert_eq!(record("near:t1.near"), Record { rsvps: 1, attended: 1, ..Default::default() });
    assert_eq!(record("near:t16.near"), Record { rsvps: 1, vouched: 1, ..Default::default() });
    assert_eq!(record("near:t20.near"), Record { rsvps: 1, forfeited: 1, ..Default::default() });
    assert_eq!(record("near:nobody.near"), Record::default());
}

#[test]
#[should_panic(expected = "the dispute window is still open")]
fn tally_waits_for_the_dispute_window() {
    let (mut c, id, ends) = worked_example(None);
    tally_all(&mut c, id, ends - 1, 1_000);
}

#[test]
#[should_panic(expected = "already tallied")]
fn an_event_is_tallied_once() {
    let (mut c, id, ends) = worked_example(None);
    tally_all(&mut c, id, ends, 1_000);
    c.tally(id, 1_000);
}

#[test]
#[should_panic(expected = "limit must be positive")]
fn a_tally_page_needs_a_limit() {
    let (mut c, id, ends) = worked_example(None);
    ctx("keeper.near", ends, NearToken::from_near(0));
    c.tally(id, 0);
}

#[test]
fn a_cancelled_event_refunds_everyone_at_once() {
    let (mut c, id) = checkin_setup();
    cancel_event_as(&mut c, id, "organizer.near", NOW, NearToken::from_yoctonear(1));
    let t = tally_all(&mut c, id, NOW, 1_000);
    assert!(t.everyone_refunded && !t.measured);
    assert_eq!(t.refunded, 2);
    assert_eq!((payout_of(&c, id, 1), payout_of(&c, id, 2)), (DEPOSIT, DEPOSIT));
    assert_eq!(c.reliability("near:a.near".into()), Record::default());
}

#[test]
fn a_voided_event_refunds_everyone() {
    let (mut c, id, deadline, _) = dispute_setup();
    void_as(&mut c, id, "arbiter.near", deadline, NearToken::from_yoctonear(1));
    let t = tally_all(&mut c, id, deadline, 1_000);
    assert!(t.everyone_refunded);
    assert!((1..=4).all(|seed| payout_of(&c, id, seed) == DEPOSIT));
    assert_eq!(c.reliability("near:t1.near".into()), Record::default());
}

#[test]
fn nobody_attending_counts_as_voided() {
    let (mut c, id) = checkin_setup();
    for (slot, code) in CODES.iter().enumerate() {
        open_code(&mut c, id, slot as u8, OPENS + slot as u64 * WINDOW, code);
    }
    for (slot, code) in CODES.iter().enumerate() {
        reveal_code(&mut c, id, slot as u8, code, CLOSES);
    }
    let ends = c.get_event(id).unwrap().schedule.dispute_ends_at_ms;
    let t = tally_all(&mut c, id, ends, 1_000);
    assert!(t.everyone_refunded);
    assert_eq!((t.attended, t.forfeited), (0, 2));
    assert_eq!((payout_of(&c, id, 1), payout_of(&c, id, 2)), (DEPOSIT, DEPOSIT));
    assert_eq!(c.reliability("near:a.near".into()), Record::default());
}

#[test]
fn skipped_checkin_refunds_everyone_without_touching_reputation() {
    let (mut c, id) = checkin_setup();
    let ends = c.get_event(id).unwrap().schedule.dispute_ends_at_ms;
    let t = tally_all(&mut c, id, ends, 1_000);
    assert_eq!((t.attended, t.pool.0, t.bonus.0), (2, 0, 0));
    assert!(!t.measured);
    assert_eq!((payout_of(&c, id, 1), payout_of(&c, id, 2)), (DEPOSIT, DEPOSIT));
    assert_eq!(c.reliability("near:a.near".into()), Record::default());
}

#[test]
fn payouts_follow_outcomes() {
    let t = Tally { bonus: U128(5), ..Default::default() };
    assert_eq!(payout_amount(Outcome::Attended, &t, 100), 105);
    assert_eq!(payout_amount(Outcome::Vouched, &t, 100), 100);
    assert_eq!(payout_amount(Outcome::Refunded, &t, 100), 100);
    assert_eq!(payout_amount(Outcome::Forfeited, &t, 100), 0);
    let all = Tally { everyone_refunded: true, ..t };
    assert_eq!(payout_amount(Outcome::Forfeited, &all, 100), 100);
}

// Payouts

fn with_intents() -> Bail {
    ctx("deployer.near", NOW, NearToken::from_near(0));
    Bail::new(Config {
        intents_account: Some(acc("intents.near")),
        ..config()
    })
}

/// Token calls the last contract call scheduled: (token, method, args, attached deposit).
fn token_calls() -> Vec<(AccountId, String, Value, NearToken)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => {
                    let method = String::from_utf8(method_name).unwrap();
                    let args = near_sdk::serde_json::from_slice(&args).unwrap_or(Value::Null);
                    method.starts_with("ft_").then(|| (receiver.clone(), method, args, attached_deposit))
                }
                _ => None,
            })
        })
        .collect()
}

fn near_transfers() -> Vec<(AccountId, NearToken)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((receiver.clone(), deposit)),
                _ => None,
            })
        })
        .collect()
}

fn transfer_to(calls: &[(AccountId, String, Value, NearToken)], receiver: &str) -> Vec<u128> {
    calls
        .iter()
        .filter(|(_, m, args, _)| m == "ft_transfer" && args["receiver_id"] == receiver)
        .map(|(_, _, args, _)| args["amount"].as_str().unwrap().parse().unwrap())
        .collect()
}

fn pay_all(c: &mut Bail, event_id: EventId, at_ms: u64, limit: u32) -> Vec<(AccountId, String, Value, NearToken)> {
    let mut calls = Vec::new();
    loop {
        ctx("keeper.near", at_ms, NearToken::from_near(0));
        let done = c.payout(event_id, limit);
        calls.extend(token_calls());
        if done {
            return calls;
        }
    }
}

fn settled_example() -> (Bail, EventId, u64) {
    let (mut c, id, ends) = worked_example(None);
    tally_all(&mut c, id, ends, 1_000);
    (c, id, ends)
}

/// Calls the payout callback as the token's answer would arrive.
fn answer(c: &mut Bail, event_id: EventId, seed: Option<u8>, payout_to: &str, amount: u128, is_call: bool, result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc(CONTRACT))
            .predecessor_account_id(acc(CONTRACT))
            .block_timestamp(NOW * NS_PER_MS)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
    c.on_transfer(event_id, seed.map(ticket), payout_to.to_string(), U128(amount), is_call);
}

#[test]
fn unusable_payout_addresses_bounce() {
    let (mut c, id) = setup(10);
    for address in ["base:0xabc", "near:", "near:Not Valid", "intents:t1.near", "t1.near"] {
        assert_eq!(send(&mut c, USDC, NOW, DEPOSIT, msg(id, 1, address)), DEPOSIT, "{address}");
    }
    assert_eq!(c.get_event(id).unwrap().registered, 0);
}

#[test]
fn intents_addresses_work_where_enabled() {
    let mut c = with_intents();
    let id = create(&mut c, new_event(10));
    rsvp(&mut c, id, 1, "intents:0x1234567890abcdef1234567890abcdef12345678");
    assert_eq!(c.get_event(id).unwrap().registered, 1);
}

#[test]
fn an_event_takes_two_rsvps_per_seat() {
    let (mut c, id) = setup(1);
    rsvp(&mut c, id, 1, "near:a.near");
    cancel(&mut c, id, 1, NOW, sign(1, &cancel_message(id)));
    rsvp(&mut c, id, 2, "near:b.near");
    cancel(&mut c, id, 2, NOW, sign(2, &cancel_message(id)));
    assert_eq!(send(&mut c, USDC, NOW, DEPOSIT, msg(id, 3, "near:c.near")), 0);
    let e = c.get_event(id).unwrap();
    assert_eq!((e.registered, e.tickets_created), (0, 2));
    assert_eq!(c.get_owed(id, "near:c.near".into()).0, DEPOSIT);
}

#[test]
fn payouts_send_every_share() {
    let (mut c, id, ends) = settled_example();
    let calls = pay_all(&mut c, id, ends, 1_000);
    assert_eq!(calls.len(), 16);
    assert!(calls.iter().all(|(token, method, _, deposit)| {
        token.as_str() == USDC && method == "ft_transfer" && *deposit == NearToken::from_yoctonear(1)
    }));
    assert_eq!(transfer_to(&calls, "t1.near"), vec![1_266_666]);
    assert_eq!(transfer_to(&calls, "t16.near"), vec![DEPOSIT]);
    assert!(transfer_to(&calls, "t20.near").is_empty());
    assert!((1..=20).all(|seed| c.get_ticket(id, ticket(seed)).unwrap().paid));
}

#[test]
fn payouts_page_through_tickets() {
    let (mut c, id, ends) = settled_example();
    let calls = pay_all(&mut c, id, ends, 7);
    assert_eq!(calls.len(), 16);
}

#[test]
#[should_panic(expected = "the tally is not finished")]
fn payouts_wait_for_the_tally() {
    let (mut c, id, ends) = worked_example(None);
    pay_all(&mut c, id, ends, 1_000);
}

#[test]
#[should_panic(expected = "already paid")]
fn nothing_is_paid_twice() {
    let (mut c, id, ends) = settled_example();
    pay_all(&mut c, id, ends, 1_000);
    ctx("anyone.near", ends, NearToken::from_near(0));
    c.claim(id, ticket(1));
}

#[test]
fn a_ticket_can_be_claimed_on_its_own() {
    let (mut c, id, ends) = settled_example();
    ctx("anyone.near", ends, NearToken::from_near(0));
    c.claim(id, ticket(1));
    assert_eq!(transfer_to(&token_calls(), "t1.near"), vec![1_266_666]);
    assert!(c.get_ticket(id, ticket(1)).unwrap().paid);
    assert!(!c.get_ticket(id, ticket(2)).unwrap().paid);
}

#[test]
fn a_failed_transfer_can_be_retried() {
    let (mut c, id, ends) = settled_example();
    ctx("anyone.near", ends, NearToken::from_near(0));
    c.claim(id, ticket(1));
    answer(&mut c, id, Some(1), "near:t1.near", 1_266_666, false, PromiseResult::Failed);
    assert!(!c.get_ticket(id, ticket(1)).unwrap().paid);
    assert_eq!(c.get_owed(id, "near:t1.near".into()).0, 0);
    ctx("anyone.near", ends, NearToken::from_near(0));
    c.claim(id, ticket(1));
    assert_eq!(transfer_to(&token_calls(), "t1.near"), vec![1_266_666]);
}

#[test]
fn a_successful_transfer_stays_paid() {
    let (mut c, id, ends) = settled_example();
    ctx("anyone.near", ends, NearToken::from_near(0));
    c.claim(id, ticket(1));
    answer(&mut c, id, Some(1), "near:t1.near", 1_266_666, false, PromiseResult::Successful(vec![]));
    assert!(c.get_ticket(id, ticket(1)).unwrap().paid);
    assert_eq!(c.get_owed(id, "near:t1.near".into()).0, 0);
}

#[test]
fn intents_payouts_use_transfer_call() {
    let mut c = with_intents();
    let id = create(&mut c, new_event(10));
    rsvp(&mut c, id, 1, "intents:0x1234567890abcdef1234567890abcdef12345678");
    cancel_event_as(&mut c, id, "organizer.near", NOW, NearToken::from_yoctonear(1));
    tally_all(&mut c, id, NOW, 1_000);
    let calls = pay_all(&mut c, id, NOW, 1_000);
    assert_eq!(calls.len(), 1);
    let (token, method, args, _) = &calls[0];
    assert_eq!((token.as_str(), method.as_str()), (USDC, "ft_transfer_call"));
    assert_eq!(args["receiver_id"], "intents.near");
    assert_eq!(args["msg"], "0x1234567890abcdef1234567890abcdef12345678");
    assert_eq!(args["amount"], DEPOSIT.to_string());
}

#[test]
fn what_intents_returns_is_owed() {
    let (mut c, id, _) = settled_example();
    let used = PromiseResult::Successful(b"\"400000\"".to_vec());
    answer(&mut c, id, Some(16), "near:t16.near", DEPOSIT, true, used);
    assert_eq!(c.get_owed(id, "near:t16.near".into()).0, 600_000);
}

#[test]
fn an_unreadable_answer_counts_as_paid() {
    let (mut c, id, ends) = settled_example();
    ctx("anyone.near", ends, NearToken::from_near(0));
    c.claim(id, ticket(16));
    answer(&mut c, id, Some(16), "near:t16.near", DEPOSIT, true, PromiseResult::Successful(b"garbage".to_vec()));
    assert!(c.get_ticket(id, ticket(16)).unwrap().paid);
    assert_eq!(c.get_owed(id, "near:t16.near".into()).0, 0);
}

#[test]
fn owed_refunds_can_be_claimed() {
    let (mut c, id) = setup(10);
    send(&mut c, USDC, RSVP_CLOSES, DEPOSIT, msg(id, 1, "near:late.near"));
    ctx("anyone.near", RSVP_CLOSES, NearToken::from_near(0));
    c.claim_owed(id, "near:late.near".into());
    assert_eq!(transfer_to(&token_calls(), "late.near"), vec![DEPOSIT]);
    assert_eq!(c.get_owed(id, "near:late.near".into()).0, 0);
}

#[test]
fn a_failed_owed_claim_is_restored() {
    let (mut c, id) = setup(10);
    send(&mut c, USDC, RSVP_CLOSES, DEPOSIT, msg(id, 1, "near:late.near"));
    ctx("anyone.near", RSVP_CLOSES, NearToken::from_near(0));
    c.claim_owed(id, "near:late.near".into());
    answer(&mut c, id, None, "near:late.near", DEPOSIT, false, PromiseResult::Failed);
    assert_eq!(c.get_owed(id, "near:late.near".into()).0, DEPOSIT);
}

#[test]
#[should_panic(expected = "nothing owed")]
fn claiming_nothing_fails() {
    let (mut c, id) = setup(10);
    ctx("anyone.near", NOW, NearToken::from_near(0));
    c.claim_owed(id, "near:nobody.near".into());
}

// Closing

fn close_all(c: &mut Bail, event_id: EventId, at_ms: u64, limit: u32) -> Vec<(AccountId, NearToken)> {
    loop {
        ctx("anyone.near", at_ms, NearToken::from_near(0));
        if c.close_event(event_id, limit) {
            return near_transfers();
        }
    }
}

#[test]
#[should_panic(expected = "payouts are not finished")]
fn closing_waits_for_payouts() {
    let (mut c, id, ends) = settled_example();
    close_all(&mut c, id, ends, 1_000);
}

#[test]
fn closing_frees_tickets_and_refunds_unused_storage() {
    let (mut c, id, ends) = settled_example();
    pay_all(&mut c, id, ends, 1_000);
    let refunds = close_all(&mut c, id, ends, 1_000);
    let e = c.get_event(id).unwrap();
    assert!(e.closed);
    assert!(c.get_ticket(id, ticket(1)).is_none());

    // 20 seats prepaid, minus the event's own budget and 20 reliability records it created.
    let keep = STORAGE_PER_EVENT.saturating_add(
        env::storage_byte_cost().saturating_mul(20 * REPUTATION_RECORD_BYTES),
    );
    let expected = seat_storage_cost(20).saturating_sub(keep);
    assert_eq!(refunds, vec![(acc("organizer.near"), expected)]);
    assert_eq!(e.owed_total, 0);
}

#[test]
fn closing_works_in_pages() {
    let (mut c, id, ends) = settled_example();
    pay_all(&mut c, id, ends, 1_000);
    for _ in 0..2 {
        ctx("anyone.near", ends, NearToken::from_near(0));
        assert!(!c.close_event(id, 8));
    }
    ctx("anyone.near", ends, NearToken::from_near(0));
    assert!(c.close_event(id, 8));
}

#[test]
fn closing_moves_failed_payouts_to_owed() {
    let (mut c, id, ends) = settled_example();
    pay_all(&mut c, id, ends, 1_000);
    answer(&mut c, id, Some(1), "near:t1.near", 1_266_666, false, PromiseResult::Failed);
    close_all(&mut c, id, ends, 1_000);
    assert_eq!(c.get_owed(id, "near:t1.near".into()).0, 1_266_666);
    assert_eq!(c.get_event(id).unwrap().owed_total, 1);
}

#[test]
fn a_payout_failing_after_close_is_owed() {
    let (mut c, id, ends) = settled_example();
    pay_all(&mut c, id, ends, 1_000);
    close_all(&mut c, id, ends, 1_000);
    answer(&mut c, id, Some(1), "near:t1.near", 1_266_666, false, PromiseResult::Failed);
    assert_eq!(c.get_owed(id, "near:t1.near".into()).0, 1_266_666);
}

#[test]
#[should_panic(expected = "already closed")]
fn an_event_closes_once() {
    let (mut c, id, ends) = settled_example();
    pay_all(&mut c, id, ends, 1_000);
    close_all(&mut c, id, ends, 1_000);
    close_all(&mut c, id, ends, 1_000);
}

#[test]
fn the_fee_account_is_owed_the_fee_and_the_dust() {
    let (mut c, id, ends) = worked_example(Some((500, "fees.near")));
    tally_all(&mut c, id, ends, 1_000);
    assert_eq!(c.get_owed(id, "near:fees.near".into()).0, 200_000 + 5);
}

// Kickback comparison (see tests/kickback for the same attack on Kickback's own contract)

/// Alice, Bob and Carol RSVP, and so does an account the organizer controls.
fn kickback_setup() -> (Bail, EventId) {
    let (mut c, id) = setup(10);
    for (seed, who) in [(1, "alice"), (2, "bob"), (3, "carol"), (4, "puppet")] {
        rsvp(&mut c, id, seed, &format!("near:{who}.near"));
    }
    (c, id)
}

fn kickback_checkin(c: &mut Bail, id: EventId, hearers: &[u8]) {
    for (slot, code) in CODES.iter().enumerate() {
        let (slot, at) = (slot as u8, OPENS + slot as u64 * WINDOW);
        open_code(c, id, slot, at, code);
        for &seed in hearers {
            catch_heard(c, id, slot, seed, code, at);
        }
    }
}

#[test]
#[should_panic(expected = "the dispute window is still open")]
fn bail_has_no_early_finalize() {
    let (mut c, id) = kickback_setup();
    ctx("organizer.near", NOW, NearToken::from_near(0));
    c.tally(id, 1_000);
}

#[test]
fn the_kickback_attack_fails_against_bail() {
    // There is no method that marks attendance. With an honest check-in the puppet is
    // just one more attendee and gains nothing.
    let (mut c, id) = kickback_setup();
    kickback_checkin(&mut c, id, &[1, 2, 3, 4]);
    for (slot, code) in CODES.iter().enumerate() {
        reveal_code(&mut c, id, slot as u8, code, CLOSES);
    }
    let ends = c.get_event(id).unwrap().schedule.dispute_ends_at_ms;
    let t = tally_all(&mut c, id, ends, 1_000);
    assert_eq!(t.attended, 4);
    assert!((1..=4).all(|seed| payout_of(&c, id, seed) == DEPOSIT));
}

#[test]
fn hiding_the_codes_is_undone_by_the_arbiter() {
    // A dishonest host shows the codes only to the puppet. The real attendees flag each
    // slot, and the arbiter voids the event: everyone gets exactly their deposit back.
    let (mut c, id) = kickback_setup();
    kickback_checkin(&mut c, id, &[4]);
    for slot in 0..3u8 {
        for seed in 1..=3 {
            flag(&mut c, id, slot, seed, CLOSES, sign(seed, &flag_message(id, slot)));
        }
    }
    for (slot, code) in CODES.iter().enumerate() {
        reveal_code(&mut c, id, slot as u8, code, CLOSES);
    }
    let e = c.get_event(id).unwrap();
    assert!(e.slots.iter().all(|s| s.flags == 3));
    void_as(&mut c, id, "arbiter.near", e.schedule.reveal_deadline_ms, NearToken::from_yoctonear(1));
    let t = tally_all(&mut c, id, e.schedule.reveal_deadline_ms, 1_000);
    assert!(t.everyone_refunded);
    assert!((1..=4).all(|seed| payout_of(&c, id, seed) == DEPOSIT));
}

#[test]
fn if_the_arbiter_does_nothing_hidden_codes_cost_honest_attendees() {
    // The residual risk named in the threat model, shown rather than claimed: without
    // the arbiter, a host who shows the codes only to their own account takes the pool.
    let (mut c, id) = kickback_setup();
    kickback_checkin(&mut c, id, &[4]);
    for (slot, code) in CODES.iter().enumerate() {
        reveal_code(&mut c, id, slot as u8, code, CLOSES);
    }
    let ends = c.get_event(id).unwrap().schedule.dispute_ends_at_ms;
    tally_all(&mut c, id, ends, 1_000);
    assert_eq!(payout_of(&c, id, 1), 0);
    assert_eq!(payout_of(&c, id, 4), 4 * DEPOSIT);
}

#[test]
fn record_bounds_cover_the_longest_addresses() {
    assert_eq!(OWED_RECORD_BYTES, 1 + 8 + 4 + 72 + 16 + 40);
    assert_eq!(REPUTATION_RECORD_BYTES, 1 + 4 + 72 + 16 + 40);
}

// Storage

/// A filled `vouched_for` key is the one field still smaller here than at its maximum
/// (33 bytes over None): every ticket in this test attended, so none vouched.
const RESERVED_PER_SEAT: u64 = 33;

/// The worst case an organizer pays for: every seat filled, cancelled and filled again
/// (the lifetime limit of two RSVPs per seat), a refused deposit per seat, five code
/// slots caught and flagged by everyone, every code revealed at full length, and a
/// reliability record per attendee, all with the longest addresses Bail accepts.
#[test]
fn prepaid_storage_covers_the_worst_case() {
    let capacity = 25u32;
    let mut c = with_intents();
    let before = env::storage_usage();
    let mut event = new_event(capacity);
    event.checkin = CheckinConfig { slots: MAX_SLOTS, required: MAX_SLOTS, window_ms: WINDOW };
    event.checkin_closes_at_ms = OPENS + u64::from(MAX_SLOTS) * WINDOW;
    event.token = acc(&format!("{}.near", "t".repeat(59)));
    event.arbiter = acc(&format!("{}.near", "a".repeat(59)));
    let token = event.token.to_string();
    let id = create(&mut c, event);

    let address = |n: u32| format!("intents:{n:064}");
    assert_eq!(address(0).len(), MAX_PAYOUT_LEN);
    for i in 0..capacity {
        send(&mut c, &token, NOW, DEPOSIT, msg(id, i as u8, &address(i)));
        cancel(&mut c, id, i as u8, NOW, sign(i as u8, &cancel_message(id)));
    }
    let seed = |i: u32| (100 + i) as u8;
    for i in 0..capacity {
        send(&mut c, &token, NOW, DEPOSIT, msg(id, seed(i), &address(1_000 + i)));
    }
    for i in 0..capacity {
        send(&mut c, &token, RSVP_CLOSES, DEPOSIT, msg(id, 250, &address(2_000 + i)));
    }

    let code = |slot: u8| format!("{slot}{}", "a".repeat(MAX_CODE_LEN - 1));
    for slot in 0..MAX_SLOTS {
        let at = OPENS + u64::from(slot) * WINDOW;
        open_code(&mut c, id, slot, at, &code(slot));
        for i in 0..capacity {
            let p = Base64VecU8(catch_proof(id, slot, &code(slot), &key_bytes(seed(i))).to_vec());
            catch_code(&mut c, id, slot, u32::MAX, seed(i), p, at);
            flag(&mut c, id, slot, seed(i), at, sign(seed(i), &flag_message(id, slot)));
        }
    }
    let closes = OPENS + u64::from(MAX_SLOTS) * WINDOW;
    for slot in 0..MAX_SLOTS {
        reveal_code(&mut c, id, slot, &code(slot), closes);
    }
    let ends = c.get_event(id).unwrap().schedule.dispute_ends_at_ms;
    let t = tally_all(&mut c, id, ends, 1_000);
    assert_eq!((t.attended, t.new_records), (capacity, capacity));
    let e = c.get_event(id).unwrap();
    assert_eq!((e.registered, e.tickets_created), (capacity, 2 * capacity));
    assert_eq!((e.owed_records, e.owed_total), (capacity, 2 * capacity));

    c.events.flush();
    c.tickets.flush();
    c.ticket_index.flush();
    c.owed.flush();
    c.reputation.flush();
    let used = env::storage_usage() - before;
    let needed = used + RESERVED_PER_SEAT * u64::from(capacity);
    let prepaid = seat_storage_cost(capacity).as_yoctonear() / env::storage_byte_cost().as_yoctonear();
    println!("storage for {capacity} seats: needs {needed} bytes, prepaid {prepaid}");
    assert!(needed <= prepaid as u64, "needs {needed} bytes, prepaid {prepaid}");
}
