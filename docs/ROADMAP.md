# Bail roadmap

What is being built, in order. Each stage builds on the one before it. The design behind every item is in [ARCHITECTURE.md](ARCHITECTURE.md).

![Bail roadmap in two rows. Build the contract: Foundation (done), Check-in (done), Recourse and settlement (done), Proof (done). Ship it: Testnet launch (done), Apps (done), Real events (done), Any chain (planned).](images/roadmap.svg)

| Stage | What it delivers | Status |
|---|---|---|
| 1. Foundation | Events and deposit RSVPs | Done |
| 2. Check-in | Live codes that prove who was there | Done |
| 3. Recourse and settlement | Fair outcomes, payouts and reliability records | Done |
| 4. Proof | Tests that back every promise, including the Kickback comparison | Done |
| 5. Testnet launch | A locked, verifiable contract on NEAR testnet | Done |
| 6. Apps | SDK, relayer, host console and web app | Done |
| 7. Real events | A dry run, a live event and a DAO arbiter on testnet, with published results | Done |
| 8. Any chain | Deposits from any chain through NEAR Intents | Planned |

## 1. Foundation (done)

- [x] Event creation with prepaid seat storage, so attendees never need NEAR
- [x] RSVPs by deposit through `ft_transfer_call` with an RSVP note, the same path 1Click uses
- [x] Only transfers that can't be returned any other way are bounced; late, full and duplicate deposits are kept as owed to the attendee

## 2. Check-in (done)

- [x] Whole event schedule fixed at creation: cancel cutoff, check-in window, code slots, reveal and dispute periods, and a required arbiter
- [x] Free cancellation before the cutoff, and organizer cancellation only before check-in
- [x] Live code slots that open one at a time, each committed onchain as it opens
- [x] Catching codes with proofs bound to each attendee's ticket key, with typos fixable inside the window
- [x] Flags for slots where no code was shown
- [x] Reveals that anyone can make, and a qualification rule where a missing slot can only lower the bar

## 3. Recourse and settlement (done)

- [x] Vouching for attendees whose phone died
- [x] A required arbiter, never the organizer, who can void an event and can only refund
- [x] Tally that anyone can run, in pages, fixing the pool, bonus and fee before any money moves
- [x] Reliability records for every payout address
- [x] Payouts pushed in pages or claimed per ticket; a failed transfer is rolled back so it can be paid again
- [x] Payouts into NEAR Intents balances, built for mainnet (checked live in stage 8)
- [x] Closing an event frees its storage and refunds the organizer what is provably unused

## 4. Proof (done)

- [x] Property tests for conservation, principal protection, no erasure and refund bias, over random event histories checked against an independent model
- [x] Kickback's own contract in a Foundry test, with its organizer taking every deposit, and the same attack failing against Bail
- [x] A whole event lifecycle on the compiled contract in a local NEAR sandbox, settled by an account with no role in the event
- [x] The host key and the transfer callback checked on the compiled contract, where NEAR enforces their limits
- [x] Reproducible build in a Docker image pinned by digest, giving the same wasm hash on every rebuild
- [x] Continuous integration running every test above on every push

## 5. Testnet launch (done)

- [x] Contract deployed to [`v1.dontbail.testnet`](https://testnet.nearblocks.io/address/v1.dontbail.testnet) and locked, with no access keys left
- [x] Verify script checking that the onchain code hash matches the reproducible build; run `scripts/verify.py` to check it yourself

## 6. Apps (done)

- [x] TypeScript SDK, byte-identical to the contract, checked against test vectors the contract's own code builds
- [x] Relayer and keeper, so attendees pay no NEAR gas and events settle themselves
- [x] Testnet onboarding with a faucet and meta transactions, starting from a fresh browser with no NEAR
- [x] Host console to create events, open each code when the host chooses, reveal them and report results
- [x] Web app: event page, RSVP, live check-in, results and organizer view, with a check that a payout account exists before RSVP
- [x] The site on GitHub Pages, reading results and public records straight from the chain

## 7. Real events (done)

- [x] Dry run with friends on phones, 11 Nov 2026 ([results](dry-run.md)), and the fixes it led to
- [x] A live online event with real attendees on testnet, 12 Nov 2026 ([results](first-event.md))
- [x] A Sputnik DAO as an event's arbiter, voting to void it and refunding everyone, on testnet and in a sandbox test ([record](dao-arbiter-event.md))
- [x] `scripts/check-events.py`, which recomputes every published result from raw chain data
- [x] README with step-by-step trial instructions, and CLAIMS.md linking every claim to its proof

## 8. Any chain (planned)

- [ ] Deposits from any chain and asset through 1Click, with the RSVP note delivered onchain
- [ ] A real cross-chain RSVP and an Intents payout on mainnet, since NEAR Intents has no testnet

After these: creating and hosting events from the browser with a NEAR wallet (today the organizer uses the `bail-host` console), and the ideas in [ARCHITECTURE.md section 16](ARCHITECTURE.md#16-beyond-the-hackathon): door mode for in-person events, smaller deposits for reliable people, and a share of forfeits to the community's Trezu treasury.
