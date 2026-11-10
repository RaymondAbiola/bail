# Testnet rehearsal: event 3

A full event run on NEAR testnet on 9 November 2026, before the first real event. The host console created it, three scripted attendees RSVPed through the relayer's faucet with no NEAR and no wallet, caught the live codes through the relayer (one attendee deliberately missed both), and the keeper tallied and paid out with nobody else calling anything. The attendees are scripts, not people: this shows the mechanics work on testnet, not that people behave this way.

Contract: `v1.dontbail.testnet` (locked, [verification](../README.md#verify-it)). Token: Circle's test USDC. Event 3 had two 1-minute codes, both required, a 1 USDC deposit and no fee.

## The report

Output of `bail-host report 3`, captured after the tally and before the keeper closed the event. Closing frees each ticket's record, so the per-ticket table below can no longer be read from the chain. The event's totals stay on chain.

- Status: Active
- Deposit: 1 (3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af)
- Seats: 3 of 4 taken
- Codes: 2 of 2 opened, 2 revealed, 2 needed to count as attended
- Tally: Done. Attended 2, vouched 0, forfeited 1, refunded 0
- Show-up rate: 67%
- Forfeit pool 1, fee 0, bonus per attendee 0.5

| # | Payout address | Codes caught | Vouches | Outcome | Payout | Paid |
|---|---|---|---|---|---|---|
| 1 | near:dbe8db7a54271973de1bb29d5d861eccbe59ab7c56ca3ae38ec7aaed602c6eff | 0 | 0 | Forfeited | 0 | yes |
| 2 | near:867bcceed4de65bec21d9ae97aa6b200e367def0dbdf9b77f18d889598cda331 | 2 | 0 | Attended | 1.5 | yes |
| 3 | near:94c6a2a130733aedb12202c4be22d1e788268e0b4de0a769da34130736afd056 | 2 | 0 | Attended | 1.5 | yes |

## Balances read from the token contract afterwards

Read directly from the test USDC contract's `ft_balance_of`, not from the report:

| Account | Balance (test USDC) | Expected |
|---|---|---|
| Attendee 1 (missed both codes) | 0 | 0: forfeited |
| Attendee 2 (caught both) | 1.5 | 1 deposit + 0.5 bonus |
| Attendee 3 (caught both) | 1.5 | 1 deposit + 0.5 bonus |
| `v1.dontbail.testnet` | 0 | 0: nothing held back |

The forfeited deposit (1) was split between the two attendees (0.5 each), and the contract kept none of it.

## Before this run worked

Three earlier attempts the same day failed for reasons unrelated to Bail: the public testnet RPC endpoint `rpc.testnet.near.org` is deprecated and returns 429 on purpose, and the replacement free endpoints refused bursts of requests. The SDK, relayer and host console now fail over between endpoints, retry throttled requests and poll gently. Those fixes are in the repository history from "Improve testnet RPC resilience and host rehearsal flows".
