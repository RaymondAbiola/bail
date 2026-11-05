# Bail relayer and keeper

The relayer pays the gas for actions attendees sign, so attendees never need NEAR. The keeper settles every event once its deadlines pass. Neither holds any power over money: they call Bail with function-call keys that can reach only these methods, none of which takes attached NEAR, and the contract checks every ticket signature itself. A relayer can delay an action but can't forge or change one, and anyone can run their own.

## Endpoints

`POST /v1/catch`, `/v1/flag`, `/v1/cancel` and `/v1/vouch` take exactly the arguments of the contract methods `catch`, `flag_slot`, `cancel_rsvp` and `vouch`, as the SDK's `Ticket` builds them, and answer `{ "tx": "<hash>" }`.

Before spending gas the relayer checks the fields and the ticket's signature, the same way the contract will, and that the ticket exists. It limits each IP to 60 requests a minute and each ticket to 12. After a cancellation it claims the refund for the ticket's payout address. Errors come back as `{ "error": "..." }`: 400 for a malformed or wrongly signed action, 404 for an unknown ticket, 422 with the contract's own message and the transaction when the contract refused it, 429 when rate-limited.

`GET /v1/health` names the contract and the relayer account.

## Keeper

Every 30 seconds the keeper reads each open event and, judging deadlines by block time as the contract does, calls `tally`, then `payout`, then `close_event` in pages. A page that runs out of gas is halved and retried. It waits a minute after the last payout before closing, so transfer callbacks settle first.

## Running it on testnet

```bash
# 1. A relayer account, funded by the parent account (signs with your key, once).
near account create-account fund-myself relayer.dontbail.testnet '3 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as dontbail.testnet network-config testnet sign-with-legacy-keychain send

# 2. Function-call keys for it, written to apps/relayer/.env (never printed).
npm run keys -w @bail/relayer -- relayer.dontbail.testnet 4

# 3. Start.
npm start -w @bail/relayer
```

Each key sends one transaction at a time, held only until it is included, so four keys relay about four actions a second. `NEAR_RPC`, `PORT`, `ALLOW_ORIGIN` and `KEEPER=off` are optional; see `src/main.ts`.

## Tests

```bash
node --test test/relayer.test.ts       # checks, rate limits, every HTTP answer, the keeper's paging
NEAR_SANDBOX_BIN=<path> node --test test/sandbox.test.ts
```

The sandbox test runs a whole event on a local NEAR node with the compiled contract: Bob cancels and Alice catches the code through the relayer, a catch relabelled as another ticket's is refused, and the keeper tallies, pays out and closes by itself. Every balance is checked to the micro-unit. It needs `target/near/bail/bail.wasm` and `target/near/test_token/test_token.wasm` from `cargo near build non-reproducible-wasm`.
