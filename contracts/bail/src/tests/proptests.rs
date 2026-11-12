//! Random event histories, checked against an independent model.
//!
//! Each case builds an event from scratch: random capacity, code slots, required catches
//! and fee; RSVPs with random overpayments; cancellations; late deposits; tickets that
//! hear the code, mishear it, fix a typo or miss it; slots the host never opens or never
//! reveals; vouches; and organizer cancellations or arbiter voids. It is tallied, paid
//! out and closed with random page sizes. The model works out who attended from what
//! each ticket heard, without calling the contract's own logic.

use proptest::prelude::*;

use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Heard {
    Nothing,
    Right,
    Wrong,
    TypoThenRight,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ending {
    Normal,
    Cancelled,
    Voided,
}

#[derive(Clone, Debug)]
struct History {
    rsvps: u8,
    spare_seats: u32,
    slots: u8,
    required: u8,
    fee_bps: u16,
    overpay: Vec<u16>,
    cancels: Vec<bool>,
    late: u8,
    opened: u8,
    revealed: Vec<bool>,
    heard: Vec<Vec<Heard>>,
    /// How many vouches each ticket asks for if it misses out; one isn't enough.
    vouch_wants: Vec<u8>,
    ending: Ending,
    tally_page: u32,
    pay_page: u32,
}

const MAX_RSVPS: u8 = 10;
const FEES: &str = "fees.near";

fn heard() -> impl Strategy<Value = Heard> {
    prop_oneof![
        3 => Just(Heard::Right),
        1 => Just(Heard::Nothing),
        1 => Just(Heard::Wrong),
        1 => Just(Heard::TypoThenRight),
    ]
}

fn history() -> impl Strategy<Value = History> {
    let n = usize::from(MAX_RSVPS);
    let shape = (
        1..=MAX_RSVPS,
        0u32..=2,
        1..=MAX_SLOTS,
        any::<u8>(),
        any::<u8>(),
        prop_oneof![Just(0u16), 1..=MAX_FEE_BPS],
    );
    let people = (
        prop::collection::vec(prop_oneof![3 => Just(0u16), 1 => 1u16..=500], n),
        prop::collection::vec(prop::bool::weighted(0.15), n),
        0u8..=3,
        prop::collection::vec(prop::collection::vec(heard(), usize::from(MAX_SLOTS)), n),
        prop::collection::vec(
            prop_oneof![6 => Just(0u8), 2 => Just(1u8), 3 => Just(2u8), 1 => Just(3u8)],
            n,
        ),
    );
    let host = (
        prop::collection::vec(prop::bool::weighted(0.85), usize::from(MAX_SLOTS)),
        prop_oneof![8 => Just(Ending::Normal), 1 => Just(Ending::Cancelled), 1 => Just(Ending::Voided)],
        1u32..=7,
        1u32..=7,
    );
    (shape, people, host).prop_map(
        |(
            (rsvps, spare_seats, slots, required, opened, fee_bps),
            (overpay, cancels, late, heard, vouch_wants),
            (revealed, ending, tally_page, pay_page),
        )| History {
            rsvps,
            spare_seats,
            slots,
            required: 1 + required % slots,
            opened: opened % (slots + 1),
            fee_bps,
            overpay,
            cancels,
            late,
            revealed,
            heard,
            vouch_wants,
            ending,
            tally_page,
            pay_page,
        },
    )
}

/// Every case starts from empty storage; the mocked chain otherwise keeps it per thread.
fn fresh_chain() {
    env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        VMContextBuilder::new().build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        vec![],
        Default::default(),
        Default::default(),
        None,
    ));
}

fn payee(t: usize) -> String {
    format!("near:p{t}.near")
}

fn late_payer(i: u8) -> String {
    format!("near:late{i}.near")
}

fn code(slot: u8) -> String {
    format!("word{slot} maple lamp")
}

fn amounts(calls: &[(AccountId, String, Value, NearToken)]) -> u128 {
    calls
        .iter()
        .map(|(_, _, args, _)| args["amount"].as_str().unwrap().parse::<u128>().unwrap())
        .sum()
}

fn run(h: &History) -> Result<(), TestCaseError> {
    fresh_chain();
    ctx("deployer.near", NOW, NearToken::from_near(0));
    let mut c = Bail::new(Config {
        fee_bps: h.fee_bps,
        fee_account: (h.fee_bps > 0).then(|| acc(FEES)),
        ..config()
    });
    let capacity = u32::from(h.rsvps) + h.spare_seats;
    let mut event = new_event(capacity);
    event.checkin = CheckinConfig {
        slots: h.slots,
        required: h.required,
        window_ms: WINDOW,
    };
    let closes = OPENS + u64::from(h.slots) * WINDOW;
    event.checkin_closes_at_ms = closes;
    let id = create(&mut c, event);
    let seed = |t: usize| (t + 1) as u8;
    let mut received = 0u128;

    for (t, &extra) in h.overpay.iter().enumerate().take(usize::from(h.rsvps)) {
        let amount = DEPOSIT + u128::from(extra);
        prop_assert_eq!(
            send(&mut c, USDC, NOW, amount, msg(id, seed(t), &payee(t))),
            0
        );
        received += amount;
    }
    let active: Vec<usize> = (0..usize::from(h.rsvps))
        .filter(|&t| !h.cancels[t])
        .collect();
    for t in (0..usize::from(h.rsvps)).filter(|&t| h.cancels[t]) {
        cancel(&mut c, id, seed(t), NOW, sign(seed(t), &cancel_message(id)));
    }
    if h.ending == Ending::Cancelled {
        cancel_event_as(
            &mut c,
            id,
            "organizer.near",
            NOW,
            NearToken::from_yoctonear(1),
        );
    }
    for i in 0..h.late {
        let unused = send(
            &mut c,
            USDC,
            RSVP_CLOSES,
            DEPOSIT,
            msg(id, 100 + i, &late_payer(i)),
        );
        received += DEPOSIT - unused;
    }

    let schedule = c.get_event(id).unwrap().schedule;
    if h.ending != Ending::Cancelled {
        for slot in 0..h.opened {
            let at = OPENS + u64::from(slot) * WINDOW;
            open_code(&mut c, id, slot, at, &code(slot));
            for &t in &active {
                let key = key_bytes(seed(t));
                let right = Base64VecU8(catch_proof(id, slot, &code(slot), &key).to_vec());
                let wrong = Base64VecU8(catch_proof(id, slot, "not the code", &key).to_vec());
                match h.heard[t][usize::from(slot)] {
                    Heard::Nothing => {}
                    Heard::Right => catch_code(&mut c, id, slot, 1, seed(t), right, at),
                    Heard::Wrong => catch_code(&mut c, id, slot, 1, seed(t), wrong, at),
                    Heard::TypoThenRight => {
                        catch_code(&mut c, id, slot, 1, seed(t), wrong, at);
                        catch_code(&mut c, id, slot, 2, seed(t), right, at + 1);
                    }
                }
            }
        }
        for slot in (0..h.opened).filter(|&s| h.revealed[usize::from(s)]) {
            reveal_code(&mut c, id, slot, &code(slot), closes);
        }
        // Each ticket that missed out gets the vouches it asks for, from attendees who
        // haven't vouched yet, as far as the rules allow.
        let deadline = schedule.reveal_deadline_ms;
        let mut vouched: Vec<usize> = Vec::new();
        for &t in &active {
            let wants = usize::from(h.vouch_wants[t]);
            if wants == 0 || standing_at(&c, id, seed(t), deadline).attended {
                continue;
            }
            let vouchers: Vec<usize> = active
                .iter()
                .copied()
                .filter(|&v| v != t && !vouched.contains(&v))
                .filter(|&v| standing_at(&c, id, seed(v), deadline).attended)
                .take(wants)
                .collect();
            for v in vouchers {
                vouch(&mut c, id, seed(v), seed(t), deadline);
                vouched.push(v);
            }
        }
        if h.ending == Ending::Voided {
            void_as(
                &mut c,
                id,
                "arbiter.near",
                deadline,
                NearToken::from_yoctonear(1),
            );
        }
    }

    let settle_at = if h.ending == Ending::Cancelled {
        NOW
    } else {
        schedule.dispute_ends_at_ms
    };
    let tally = tally_all(&mut c, id, settle_at, h.tally_page);

    // The model: who attended, from what each ticket actually heard.
    let unrevealed = (0..h.opened)
        .filter(|&s| !h.revealed[usize::from(s)])
        .count() as u8;
    let void = (h.slots - h.opened) + unrevealed;
    let bar = h.required.saturating_sub(void);
    let attended = |t: usize| {
        let right = (0..h.opened).filter(|&s| {
            h.revealed[usize::from(s)]
                && matches!(
                    h.heard[t][usize::from(s)],
                    Heard::Right | Heard::TypoThenRight
                )
        });
        right.count() >= usize::from(bar)
    };
    let refund_all = h.ending != Ending::Normal || !active.iter().any(|&t| attended(t));
    prop_assert_eq!(tally.everyone_refunded, refund_all);

    for &t in &active {
        let state = c.get_ticket(id, ticket(seed(t))).unwrap();
        let outcome = state.outcome.unwrap();
        let payout = payout_of(&c, id, seed(t));
        if h.ending != Ending::Normal {
            prop_assert_eq!(outcome, Outcome::Refunded);
            prop_assert_eq!(payout, DEPOSIT);
            continue;
        }
        let expected = if attended(t) {
            Outcome::Attended
        } else if state.vouched_by >= VOUCHES_NEEDED {
            Outcome::Vouched
        } else {
            Outcome::Forfeited
        };
        prop_assert_eq!(outcome, expected, "ticket {}", t);
        let expected_payout = match (refund_all, expected) {
            (true, _) => DEPOSIT,
            (false, Outcome::Attended) => DEPOSIT + tally.bonus.0,
            (false, Outcome::Vouched) => DEPOSIT,
            (false, _) => 0,
        };
        prop_assert_eq!(payout, expected_payout);
        // Principal protection: anyone who wasn't a no-show gets at least their deposit.
        if outcome != Outcome::Forfeited {
            prop_assert!(payout >= DEPOSIT);
        }
    }

    if !refund_all {
        let a = u128::from(tally.attended);
        let pool = u128::from(tally.forfeited) * DEPOSIT;
        let fee = pool * u128::from(h.fee_bps) / 10_000;
        prop_assert_eq!(tally.pool.0, pool);
        prop_assert_eq!(tally.fee.0, fee);
        prop_assert_eq!(tally.bonus.0, (pool - fee) / a);
        prop_assert_eq!(tally.dust.0, pool - fee - tally.bonus.0 * a);
    }

    // Reliability is recorded only when attendance was measured.
    let measured = !refund_all && bar > 0;
    prop_assert_eq!(tally.measured, measured);
    for t in 0..usize::from(h.rsvps) {
        let record = c.reliability(payee(t));
        if measured && active.contains(&t) {
            prop_assert_eq!(record.rsvps, 1);
        } else {
            prop_assert_eq!(record, Record::default());
        }
    }

    // Conservation: pay every ticket and every owed record, and every token the event
    // took in comes back out, except dust held when there is no fee account.
    let mut paid_out = amounts(&pay_all(&mut c, id, settle_at, h.pay_page));
    let owed_to = (0..usize::from(h.rsvps))
        .map(payee)
        .chain((0..h.late).map(late_payer))
        .chain([format!("near:{FEES}")]);
    for address in owed_to {
        if c.get_owed(id, address.clone()).0 > 0 {
            ctx("anyone.near", settle_at, NearToken::from_near(0));
            c.claim_owed(id, address.clone());
            paid_out += amounts(&token_calls());
            prop_assert_eq!(c.get_owed(id, address).0, 0);
        }
    }
    let held = if h.fee_bps == 0 && !refund_all {
        tally.dust.0
    } else {
        0
    };
    prop_assert_eq!(paid_out + held, received);

    // Closing frees every ticket and never refunds more storage than was prepaid.
    let refunds = close_all(&mut c, id, settle_at, h.pay_page);
    prop_assert!(c.get_event(id).unwrap().closed);
    prop_assert!(active
        .iter()
        .all(|&t| c.get_ticket(id, ticket(seed(t))).is_none()));
    let refunded: u128 = refunds.iter().map(|(_, n)| n.as_yoctonear()).sum();
    prop_assert!(refunded <= seat_storage_cost(capacity).as_yoctonear());
    Ok(())
}

// 256 histories by default keeps `cargo test` quick. CI runs 1,000 with
// PROPTEST_CASES=1000; set it higher for a deeper local run.
proptest! {

    #[test]
    fn every_history_keeps_bails_promises(h in history()) {
        run(&h)?;
    }
}
