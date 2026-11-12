# Bail

Bail is deposit escrow for events, on NEAR. To RSVP you put down a small deposit. If you attend, you get it back plus an equal share of the deposits forfeited by people who did not. Attendance is proved by the attendees themselves with live codes, and nobody, including the organizer, can write the attendance list.

Status: the contract is deployed and locked on NEAR **testnet** at [`v1.dontbail.testnet`](https://testnet.nearblocks.io/address/v1.dontbail.testnet), using Circle's test USDC. It is not deployed on mainnet, it handles no real money, and it is unaudited. Built for NEAR HACKATHON, track: Social Money.

## The problem

Kickback is the best known tool of this kind. Its organizer alone decides who attended: `finalize` in `AbstractConference.sol` (line 266) takes an attendance bitmap and is `onlyAdmin`. An organizer can mark only their own sock-puppet account as present and withdraw every deposit.

This repository runs Kickback's real contract, copied unchanged and checked against upstream hashes, and shows the attack taking all four deposits. The same scenario fails against Bail. See [tests/kickback](tests/kickback/README.md) and the test `the_kickback_attack_fails_against_bail`.

## How an event works

1. **RSVP.** The organizer creates an event with a deposit, a capacity, a schedule and a named arbiter. Attendees RSVP with the deposit. Free cancellation until a cutoff.
2. **Check-in.** On a video call the host shows live codes, each five random words, whenever the host chooses, with the last one usually kept for the end. Nobody knows in advance when a code is coming. Each code is live for a short window. Attendees type it in. The host commits to each code on chain when it opens, so it can't be changed later.
3. **Reveal.** After a code's window, anyone who knows it can reveal it. The contract checks each attendee's catch against it. An attendee needs R of the K codes. A code the host never opens or reveals becomes void and only lowers the requirement.
4. **Dispute.** Attendees who qualified can vouch for someone whose phone died (two vouches get the deposit back, without the bonus). If the host hides codes, attendees flag the slot and the arbiter can void the event, which refunds everyone. The arbiter can't be the organizer and can't choose who attended.
5. **Settle.** Anyone can run the tally and the payouts. A keeper does it automatically. Fees, if any, come only from forfeited deposits.

Attendees need no wallet and no NEAR: their ticket key is made in the browser, a relayer pays the gas, and a faucet provides test USDC on testnet.

## Used with real people

| Event | When | Seats | Attended | Forfeited | Each attendee got | Full results |
|---|---|---|---|---|---|---|
| Dry run with friends (event 4) | 11 Nov 2026 | 4 | 1 | 3 | 2 test USDC (0.5 back + 1.5) | [docs/dry-run.md](docs/dry-run.md) |
| First event, a Google Meet call (event 5) | 12 Nov 2026 | 11 | 6 | 5 | 0.916666 test USDC (0.5 back + 0.416666) | [docs/first-event.md](docs/first-event.md) |

Both are on chain and can be checked with `npx bail-host report 4` and `npx bail-host report 5`.

What the dry run changed: one attendee copied a code from the host's terminal with a space between every letter, so it didn't match and they forfeited. The host console now shows each code on a plain line, and the app warns when an entry isn't five words. We also closed a loophole after it: with 2 of 3 codes needed and codes at set times, anyone could leave after the second. The host now chooses when each code opens, and every code is needed by default.

In the first event every code sent matched. One payout failed: an attendee typed `adetomiwa` as their payout address instead of `adetomiwa.testnet`, an account that doesn't exist, so the transfer was refused and the amount is still held by the contract. A ticket's payout address can't be changed after RSVP.

## Verify it

Each step is "run X, see Y". None needs a private key. Each row names what it needs besides Rust stable and Node 24.

| Do | See |
|---|---|
| `python3 scripts/verify.py` | `PASS` twice, then `v1.dontbail.testnet is locked and runs the published source`. It checks the contract has no access keys, then rebuilds the exact commit it names in a pinned Docker image and compares the code hash. Needs `git`, Docker and `cargo-near` (`cargo install --locked cargo-near --no-default-features`). About 4 minutes. |
| `cargo test -p bail --lib` | All unit and property tests pass (about 40 seconds). The property test pays out random event histories against an independent model and checks conservation to the micro-unit. CI runs it with `PROPTEST_CASES=1000`. |
| `cargo test -p bail --test sandbox` | Four tests run the compiled contract in a local NEAR node: a whole six-person event settled by a stranger, and the access rules on the real runtime. Needs `cargo-near` as above. |
| `cd tests/kickback && forge test -vv` | `[PASS] test_organizerTakesEveryDepositByMarkingOnlyTheirOwnAccount()`. The attack succeeds against Kickback's own contract. Needs [Foundry](https://getfoundry.sh). |
| `npm ci && npm run typecheck --workspaces && npm test --workspaces --if-present` | The TypeScript suites pass: the SDK against test vectors built by the contract's own code, the relayer, the host console and the web app. Tests that need a local node or the network skip unless enabled. |
| `BAIL_LIVE=1 npm test -w @bail/sdk` | The SDK reads the live testnet contract and its published source metadata. |

To run a complete event on a private local node (real contract, relayer and keeper, scripted attendees, and the web app), build both contracts, then:

```bash
cargo near build non-reproducible-wasm --manifest-path contracts/bail/Cargo.toml
cargo near build non-reproducible-wasm --manifest-path contracts/test-token/Cargo.toml
export NEAR_SANDBOX_BIN=$(find target -type f -name near-sandbox -perm -u+x | head -1)   # present after the sandbox tests
npm run demo -w @bail/web
```

You will see the app at `http://localhost:5180/` and a stand-in host screen at `/host` that shows each code as it goes live. `npm run e2e -w @bail/web` drives the same flow in headless Chrome and checks every balance. The record of a full event on testnet, with token balances read from the chain, is in [docs/testnet-rehearsal.md](docs/testnet-rehearsal.md).

[CLAIMS.md](CLAIMS.md) lists each claim made about Bail and the test or file that proves it.

## Repository

| Path | What |
|---|---|
| `contracts/bail` | The contract (Rust, near-sdk 5.30), its unit and property tests, and `tests/sandbox.rs` |
| `contracts/test-token` | A standard NEP-141 token used only by the local tests |
| `tests/kickback` | Foundry project: Kickback's contract and the attack on it |
| `packages/sdk` | Browser-safe TypeScript: ticket keys, codes, hashes, signed actions, RSVP notes, typed reads. Verified byte for byte against the contract |
| `apps/relayer` | Relayer (pays attendees' gas, checks every action first), testnet faucet and sponsored deposits, and the keeper that settles events |
| `apps/host` | `bail-host`: the organizer's console for creating events, running live codes, and reporting |
| `apps/web` | The web app for attendees. See [apps/web/README.md](apps/web/README.md) |
| `packages/testkit` | A local NEAR node with the contract deployed, shared by the integration tests |
| `scripts` | `deploy.sh` and `verify.py` |
| `deployments` | `testnet.json`: the deployed contract, its source commit and its transactions |
| `docs` | [ARCHITECTURE.md](docs/ARCHITECTURE.md) (design, threat model, invariants), [ROADMAP.md](docs/ROADMAP.md) |

## NEAR features used

- **Locked contract, reproducible build.** After deployment the account's only key is deleted. The contract has no method that deploys code or adds keys. NEP-330 metadata names the source commit and the pinned build image, and `scripts/verify.py` rebuilds it.
- **Function-call access keys.** The host console's live terminal holds a key limited to `open_slot` and `reveal`. The relayer's keys can reach only attendee and keeper methods, none of which takes attached NEAR. A test shows the network refusing the host key everything else.
- **NEP-366 meta transactions.** The relayer sponsors an attendee's deposit only if it is exactly the RSVP transfer, so attendees pay no gas.
- **Implicit accounts.** A ticket key is also the key of a NEAR implicit account, so one backup is enough.
- **NEP-141 `ft_transfer_call`.** Deposits arrive as a transfer with an RSVP note. The same path serves deposits from NEAR Intents.
- **`ed25519_verify` host function.** The contract verifies ticket signatures itself, so attendees need no NEAR account.

## Limits

- Testnet only. The deposits are test tokens. Mainnet and deposits from other chains through NEAR Intents are designed (the contract already accepts `intents:` payout addresses) but not deployed or tested live. The web app marks "pay from another chain" as planned.
- Online presence is not attention: Bail proves someone was in the session at several separate moments, not that they listened. A friend can relay a code to someone absent. Short windows, a multi-code requirement and small deposits make that unattractive, not impossible.
- Against a host who hides the codes from everyone but their own tickets, the defence is the arbiter, and the contract can't prove the arbiter is independent.
- The contract is unaudited and has no admin, so a bug can't be patched in place. A fix ships as a new version.

The full list and the threat model are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#15-known-limitations).

## Licence

MIT. See [LICENSE](LICENSE). The copied Kickback and OpenZeppelin files under `tests/kickback/src` keep their own MIT licences.
