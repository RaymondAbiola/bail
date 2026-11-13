# Claims

Every claim the README and docs make about Bail, with the test or file that proves it and a command to check it. Test names are exact. Rust tests are in `contracts/bail/src/tests.rs` unless a path is given. If a claim has no proof here, treat it as not made.

Commands run from the repository root. `cargo test -p bail --lib` runs the Rust unit and property tests; the compiled-contract tests are `cargo test -p bail --test sandbox` and need `cargo-near` ([README](README.md#verify-it)).

## The problem Bail fixes

| Claim | Proof | Check |
|---|---|---|
| In Kickback, the organizer alone writes attendance and can take every deposit by marking only their own account. | `tests/kickback/test/KickbackAttack.t.sol`, `test_organizerTakesEveryDepositByMarkingOnlyTheirOwnAccount`, run against Kickback's own source. The source is copied unchanged and checked against SHA-256 hashes in `tests/kickback/SHA256SUMS` (CI checks them). | `cd tests/kickback && forge test -vv` |
| The same attack fails against Bail. | `the_kickback_attack_fails_against_bail`, `bail_has_no_early_finalize` | `cargo test -p bail --lib kickback` |
| If a host hides codes instead, the arbiter can void the event and everyone is refunded. | `hiding_the_codes_is_undone_by_the_arbiter` | `cargo test -p bail --lib hiding_the_codes` |
| The arbiter can be a community's Sputnik DAO with no extra code: the council votes on a FunctionCall proposal, one vote of two does nothing, a council member can't void alone, and the passed vote voids the event and refunds everyone. It runs the DAO code testnet's factory deploys today, checked by hash. | `a_sputnik_dao_votes_to_void_an_event` (`contracts/bail/tests/sandbox.rs`), DAO code and provenance in `contracts/bail/tests/sputnik/`, and on testnet the record in [docs/dao-arbiter-event.md](docs/dao-arbiter-event.md) | `cargo test -p bail --test sandbox a_sputnik_dao` |
| That defence needs an honest arbiter. Without one, hidden codes cost honest attendees. This is stated, not hidden. | `if_the_arbiter_does_nothing_hidden_codes_cost_honest_attendees`, [ARCHITECTURE.md section 15](docs/ARCHITECTURE.md#15-known-limitations) | `cargo test -p bail --lib if_the_arbiter` |

## Nobody writes the attendance list

| Claim | Proof | Check |
|---|---|---|
| The contract has no method that marks anyone present or absent. Its public methods are listed in `contracts/bail/src` and the organizer can only create an event, cancel it before check-in, and open code slots. | `grep -hE "pub fn" contracts/bail/src/*.rs`; `organizer_can_cancel_before_checkin`, `organizer_cannot_cancel_once_checkin_opens`, `only_the_organizer_can_cancel` | read the list |
| A ticket's catches change only with that ticket's own signature, and only inside the code's window. | `a_catch_needs_the_tickets_own_signature`, `the_signature_covers_the_proof`, `the_signature_covers_the_slot`, `an_older_attempt_cannot_be_replayed`, `the_same_attempt_cannot_be_resubmitted` | `cargo test -p bail --lib signature` |
| A host can't change a code after opening it: the commitment is checked at reveal. | `a_wrong_code_cannot_be_revealed` | `cargo test -p bail --lib a_wrong_code` |
| A code that is never opened or revealed is void and only lowers the requirement. It never disqualifies anyone. | `voiding_a_slot_never_disqualifies_anyone` (every combination of slot outcomes for every required count), `slots_never_opened_go_void_when_checkin_closes` | `cargo test -p bail --lib voiding_a_slot` |
| Attendance is decided by the contract's own rule, checked against an independent model over random histories. | `every_history_keeps_bails_promises` in `contracts/bail/src/tests/proptests.rs` | `cargo test -p bail --lib every_history` |

## The money

| Claim | Proof | Check |
|---|---|---|
| Every token an event takes in goes back out as a payout, an owed refund or the fee. Nothing is kept except rounding dust when there is no fee account. | `every_history_keeps_bails_promises` (256 histories by default, 1,000 in CI; totals checked to the micro-unit), `tally_reproduces_the_worked_example` (the worked example in [ARCHITECTURE.md section 6.7](docs/ARCHITECTURE.md)), and on the compiled contract `a_whole_event_runs_on_the_compiled_contract` (`contracts/bail/tests/sandbox.rs`, which ends with the contract holding none of the event's tokens) | `PROPTEST_CASES=1000 cargo test -p bail --lib every_history` |
| Someone who attended, was vouched for, or is refunded receives at least their deposit. | `every_history_keeps_bails_promises` | as above |
| Cancelling, voiding, vouching and void slots can only move money back to the person who paid it. Cancelled and voided events refund exactly the deposit. | `every_history_keeps_bails_promises`, `cancelling_frees_the_seat_and_owes_the_deposit`, `a_stolen_ticket_cannot_redirect_the_refund`, `two_attendees_vouch_for_a_dead_phone` | `cargo test -p bail --lib cancelling` |
| Cancelling before the cutoff refunds in full, once. | `cancelling_frees_the_seat_and_owes_the_deposit`, `cancel_after_the_cutoff_fails`, `cancelling_twice_fails` | `cargo test -p bail --lib cancel` |
| A fee, if any, is taken only from forfeited deposits and is capped at 10%. | `config_caps_the_fee`, the split in `fix_split` in `contracts/bail/src/settle.rs` (the pool is the forfeited deposits), and the property test, which draws random fees | `cargo test -p bail --lib config_caps_the_fee` |
| A failed payout can be retried, and a refused transfer is recorded as owed instead of lost. | `a_failed_transfer_can_be_retried`, `a_failed_owed_claim_is_restored`, `closing_moves_failed_payouts_to_owed`, and the unregistered-wallet payout in `a_whole_event_runs_on_the_compiled_contract` | `cargo test -p bail --lib a_failed` |
| An event's own storage cannot be exhausted by flooding it. | `prepaid_storage_covers_the_worst_case`, `owed_records_are_capped_at_capacity` | `cargo test -p bail --lib prepaid_storage` |

## Time and settlement

| Claim | Proof | Check |
|---|---|---|
| Nobody can settle before the dispute window ends, and no schedule can be edited. | `tally_waits_for_the_dispute_window`, `bail_has_no_early_finalize` | `cargo test -p bail --lib tally_waits` |
| After the deadlines, anyone can run the tally, the payouts and the close. | `a_whole_event_runs_on_the_compiled_contract`, where an account with no role in the event does it all. `apps/relayer/test/sandbox.test.ts` and `apps/host/test/sandbox.test.ts` show the keeper settling an event with no one else calling anything. | `cargo test -p bail --test sandbox` |
| Every proven attendance, vouch and forfeit is recorded per payout address. | `reliability_records_proven_attendance` | `cargo test -p bail --lib reliability` |

## No admin, and the deployed contract is the published source

| Claim | Proof | Check |
|---|---|---|
| The deployed contract has no access keys, so its code can never change, and it is the build of the commit it names. | `scripts/verify.py` against `deployments/testnet.json` | `python3 scripts/verify.py` |
| The contract has no method that deploys code, adds a key or deletes an account. | The command returns nothing: | `grep -rn -e deploy_contract -e add_full_access_key -e add_access_key -e delete_key -e delete_account contracts/bail/src --exclude-dir=tests --exclude=tests.rs` |
| Only the contract itself can initialise it or answer a transfer. | `only_the_contract_can_initialise_itself`, `only_the_contract_can_answer_a_transfer`, both on the compiled contract | `cargo test -p bail --test sandbox only_the_contract` |
| A host key limited to `open_slot` is refused every other call and every NEAR transfer by the network. | `the_host_key_can_only_open_slots` | `cargo test -p bail --test sandbox the_host_key` |

## Attendees pay no gas and need no wallet

| Claim | Proof | Check |
|---|---|---|
| The SDK builds the same hashes, signed messages, signatures and RSVP notes as the contract, and refuses the same payout addresses. | `sdk_vectors_match_the_contract` builds `packages/sdk/test/vectors.json` from the contract's own code, depositing each RSVP note into a contract to record whether it is accepted. `packages/sdk/test/vectors.test.ts` checks the SDK against the same file. | `cargo test -p bail --lib sdk_vectors && npm test -w @bail/sdk` |
| The SDK's delegate-action encoding is byte-identical to near-api-js. | `packages/sdk/test/delegate.test.ts` | `npm test -w @bail/sdk` |
| The relayer spends gas only on actions whose ticket signature is valid for this contract, event and slot. | `apps/relayer/test/relayer.test.ts`: "a signature for another contract, event, slot or attempt is refused", "malformed actions are refused before they cost gas" | `npm test -w @bail/relayer` |
| The relayer sponsors a deposit only if it is exactly the RSVP transfer. | `apps/relayer/test/relayer.test.ts`: "anything other than the exact RSVP transfer is refused" (sixteen wrong transfers) | `npm test -w @bail/relayer` |
| A browser key with no NEAR and no account can RSVP, catch codes and be paid. | `apps/relayer/test/sandbox.test.ts` (a stealing delegate is refused, a replay fails on chain), `apps/web/e2e/run.ts` (from an empty browser at phone size, every balance checked), and the testnet record in [docs/testnet-rehearsal.md](docs/testnet-rehearsal.md) | `NEAR_SANDBOX_BIN=... npm run e2e -w @bail/web` |

## Evidence from testnet

| Claim | Proof |
|---|---|
| A full event ran on NEAR testnet and paid out as designed: two attendees received 1.5 test USDC each, the one who missed the codes received 0, and the contract held 0 afterwards. | [docs/testnet-rehearsal.md](docs/testnet-rehearsal.md), with balances read from the token contract. The attendees were scripts, not people. |
| Bail ran twice with real people on phones: the dry run (event 4, 4 seats, 1 attended, 3 forfeited) and the first event (event 5, 11 seats, 6 attended, 5 forfeited, 0.916666 test USDC to each attendee). Every payout was sent except one, to a mistyped address that doesn't exist. | [docs/dry-run.md](docs/dry-run.md), [docs/first-event.md](docs/first-event.md), and `python3 scripts/check-events.py`, which recounts attendance from the raw catch proofs and recomputes every payout without trusting the contract's tally |
| A Sputnik DAO, with two council members and not the organizer, voted to void event 6 on testnet, and every deposit was refunded. | [docs/dao-arbiter-event.md](docs/dao-arbiter-event.md) and `python3 scripts/check-events.py` |
| The deployed contract and its four deployment transactions are on testnet. | `deployments/testnet.json` and `python3 scripts/verify.py` |

## Not claimed

- **No mainnet deployment.** Nothing here has handled real money.
- **NEAR Intents is not live.** The contract accepts `intents:` payout addresses and has unit tests for that path (`intents_payouts_use_transfer_call`). Deposits from other chains are designed but not built or tested against the real service, which has no testnet. The web app marks it "planned".
- **Not audited.** The invariant tests are strong evidence for the properties above, not a substitute for a review.
- **Presence is not attention.** A friend can relay a code to someone absent. The protocol makes it unattractive, not impossible.
- **The arbiter's independence is not provable on chain.** The contract only checks that the arbiter is not the organizer.
- **Testnet money is free,** so a testnet event shows the mechanics work, not that deposits change how people behave.
