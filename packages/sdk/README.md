# @bail/sdk

TypeScript for everything an attendee or host signs or hashes, byte-identical to the Bail contract, plus typed reads of its state.

- `Ticket`: an attendee's ed25519 key. `generate`, `backup` (NEAR's secret key format), `restore`, and signed `catch`, `flag`, `cancel` and `vouch` actions whose `args` are exactly the contract method's arguments.
- `rsvpNote`: the `msg` for the `ft_transfer_call` that pays the deposit, refusing payout addresses the contract wouldn't pay.
- `generateCode`, `normalizeCode`, `suggestWords`: five-word live codes from the BIP-39 English list.
- `codeCommitment`, `catchProof`: the hashes in [ARCHITECTURE.md section 6.10](../../docs/ARCHITECTURE.md#610-signed-messages).
- `BailView`: typed views over NEAR RPC, and `phase(event, now)` for the lifecycle phase.
- `rsvpDelegate`, `Ticket.signDelegate`, `Ticket.accountId`: on testnet the ticket key is also an implicit NEAR account, and its RSVP transfer is a NEP-366 delegate action a relayer sponsors. The encoding is the SDK's own, held byte for byte to near-api-js by `test/delegate.test.ts`.
- `RelayerClient`: hands signed actions to a relayer, which pays the gas, and on testnet asks its faucet for the deposit and sponsors the RSVP.

```ts
import { BailView, TESTNET, Ticket } from "@bail/sdk";

const ticket = Ticket.generate();
const note = ticket.rsvpNote(0, "near:alice.testnet");
const action = ticket.catch(TESTNET.contractId, 0, 1, 1, "tiger maple seven ocean lamp");
const event = await new BailView(TESTNET).event(0);
```

## Tests

```bash
npm ci                                          # from the repository root
cd packages/sdk
npm test                                        # vectors and unit tests
npm run typecheck
BAIL_LIVE=1 node --test test/live.test.ts       # reads the deployed testnet contract
```

`test/vectors.json` is built by the contract's own code (`contracts/bail/src/tests/vectors.rs`): commitments, proofs, signed messages, ed25519 signatures, and RSVP notes that were actually deposited into a contract, each marked accepted or refused. The Rust test fails if the file stops matching the contract, and the SDK tests fail if the SDK stops matching the file.
