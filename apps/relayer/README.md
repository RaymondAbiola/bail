# Bail relayer and keeper

The relayer pays the gas for actions attendees sign, so attendees never need NEAR. The keeper settles every event once its deadlines pass. Neither holds any power over money: they call Bail with function-call keys that can reach only these methods, none of which takes attached NEAR, and the contract checks every ticket signature itself. A relayer can delay an action but can't forge or change one, and anyone can run their own.

## Endpoints

`POST /v1/catch`, `/v1/flag`, `/v1/cancel` and `/v1/vouch` take exactly the arguments of the contract methods `catch`, `flag_slot`, `cancel_rsvp` and `vouch`, as the SDK's `Ticket` builds them, and answer `{ "tx": "<hash>" }`.

Before spending gas the relayer checks the fields and the ticket's signature, the same way the contract will, and that the ticket exists. It limits each IP to 60 requests a minute and each ticket to 12. After a cancellation it claims the refund for the ticket's payout address. Errors come back as `{ "error": "..." }`: 400 for a malformed or wrongly signed action, 404 for an unknown ticket, 422 with the contract's own message and the transaction when the contract refused it, 429 when rate-limited.

`GET /v1/health` names the contract and the relayer account.

## Testnet onboarding

With a sponsor account configured, two more endpoints let a fresh browser with no NEAR and no wallet RSVP:

- `POST /v1/faucet` with `{ "account_id", "event_id" }` turns the attendee's ticket key into an implicit account (the key's 32 bytes in hex), registers it with test USDC and sends exactly the event's deposit. Once per account and event, five requests per IP an hour, deposits up to 5 USDC.
- `POST /v1/meta` with `{ "event_id", "signed_delegate" }` submits the attendee's signed NEP-366 delegate action and pays its gas, but only if it is exactly the RSVP transfer: `ft_transfer_call` of the event's deposit to Bail on the event's token, from the signing key's own implicit account, with 1 yoctoNEAR, at most 100 Tgas and a note for this event. It answers `{ "tx", "seated" }`.

The sponsor is a separate account with a full-access key of its own, kept small. Fill it with test USDC from Circle's faucet and register it with the token first.

## Keeper

Every 30 seconds the keeper reads each open event and, judging deadlines by block time as the contract does, calls `tally`, then `payout`, then `close_event` in pages. A page that runs out of gas is halved and retried. It waits six hours after the last payout before closing (`KEEPER_CLOSE_DELAY_MINUTES`): closing frees every ticket's storage, and with it the per-ticket results attendees look up, while it only refunds the organizer's storage, so there is no hurry. The wait also lets transfer callbacks settle.

## Running it on testnet

```bash
# 1. A relayer account, funded by the parent account (signs with your key, once).
near account create-account fund-myself relayer.dontbail.testnet '3 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as dontbail.testnet network-config testnet sign-with-legacy-keychain send

# 2. A sponsor account for onboarding, registered with test USDC, then fill it from Circle's faucet.
near account create-account fund-myself faucet.dontbail.testnet '2 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as dontbail.testnet network-config testnet sign-with-legacy-keychain send
near contract call-function as-transaction 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af storage_deposit json-args '{"account_id":"faucet.dontbail.testnet","registration_only":true}' prepaid-gas '30.0 Tgas' attached-deposit '0.00125 NEAR' sign-as dontbail.testnet network-config testnet sign-with-legacy-keychain send

# 3. Keys for both, written to apps/relayer/.env (never printed).
npm run keys -w @bail/relayer -- relayer.dontbail.testnet 4 --sponsor faucet.dontbail.testnet

# 4. Start.
npm start -w @bail/relayer
```

Each key sends one transaction at a time, held only until it is included, so four keys relay about four actions a second. `NEAR_RPC`, `PORT`, `ALLOW_ORIGIN` and `KEEPER=off` are optional; see `src/main.ts`.

## Tests

```bash
node --test test/relayer.test.ts       # checks, rate limits, every HTTP answer, the keeper's paging
NEAR_SANDBOX_BIN=<path> node --test test/sandbox.test.ts
```

The sandbox test runs a whole event on a local NEAR node with the compiled contract: Alice starts as a fresh key with no account, gets her deposit from the faucet and RSVPs through a sponsored meta transaction (a delegate that tries to send the money elsewhere is refused, and a replay fails onchain), Bob cancels and Alice catches the code through the relayer, a catch relabelled as another ticket's is refused, and the keeper tallies, pays out and closes by itself. Every balance is checked to the micro-unit. It needs `target/near/bail/bail.wasm` and `target/near/test_token/test_token.wasm` from `cargo near build non-reproducible-wasm`.
