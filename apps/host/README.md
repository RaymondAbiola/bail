# Bail host console

`bail-host` runs an event from the organizer's side: create it, grant the key that opens slots, run the live codes, and report the results. It signs with the organizer's key from near-cli's legacy keychain (`~/.near-credentials`) and never prints a key. The codes and the slot key stay on the host's machine in `~/.bail-host`.

```
bail-host create     --organizer <account> --arbiter <account> --opens <+15m | ISO date> [options]
bail-host grant-key  <event>
bail-host live       <event> [--random]
bail-host reveal     <event>
bail-host status     <event>
bail-host report     <event>
bail-host bots       <event> --relayer <url> [--count 3] [--miss 1]
```

`npx bail-host help` lists every option and its default.

- **create** prepays the event's storage, so attendees never need NEAR, and makes one five-word code per slot. The arbiter can't be the organizer. It refuses a check-in too short to fit every code window with margins around each. By default every code is needed: with fewer, anyone who has caught enough codes can leave early. Make check-in as long as the part of the event people must stay for, and an attendee who honestly missed a code can still get their deposit back with two vouches.
- **grant-key** adds a function-call key to the organizer's account that can only call `open_slot` and `reveal`, with 30 Tgas per call. The live console uses only this key, so a screen-shared terminal holds nothing that can move money.
- **live** opens each code when the host presses Enter, so the host decides when people must be there: all of them early, or the last one at the very end. Codes can't overlap, so the next one can open as soon as the previous window closes; Enter pressed before then opens it at that moment. Between codes the screen shows by when to open the next one to leave room for the rest. Nothing opens on its own, because a code that went live while the host was talking would cost everyone; a code there was no time for is void instead. `--random` opens each code at a random moment, timed from the chain's record of when the previous one actually opened, with room kept for transaction delays so the last code always fits. The code is shown on a line of its own, with nothing else on that line, so triple-clicking it copies exactly the words. If `wl-copy`, `xclip` or `xsel` is installed it is also copied to the clipboard as each code opens, ready to paste into the call chat. The countdown updates in place, and the screen is restored with a plain list of the codes when check-in ends. Each code is revealed as soon as its window closes. If it is interrupted, run it again and it carries on.
- **report** prints attendance and payouts in Markdown. Run it before the keeper closes the event, which frees the tickets; the totals stay onchain after that.
- **bots** are rehearsal attendees driven by the SDK, as the web app will drive real ones: each starts as a fresh key with no NEAR, gets its deposit from the relayer's faucet, RSVPs through a sponsored meta transaction, and catches each code through the relayer, except the first `--miss`, who miss every code. They read the codes from the host's state file, so they only work on the host's machine.

## Rehearsal on testnet

About 20 minutes, from `~/bail`. It needs the relayer set up as in [apps/relayer/README.md](../relayer/README.md), with test USDC in the faucet account.

```bash
# Terminal 1: the relayer and keeper. Close ten minutes after payouts instead of six hours.
KEEPER_CLOSE_DELAY_MINUTES=10 npm start -w @bail/relayer

# Terminal 2: a 4-seat event, 1 test USDC deposit, two 1-minute codes, both needed.
npx bail-host create --organizer dontbail.testnet --arbiter relayer.dontbail.testnet \
  --opens +6m --deposit 1 --capacity 4 --slots 2 --required 2 --window 1 \
  --checkin 5 --reveal 2 --dispute 2 --cancel-before 2
npx bail-host grant-key 0
npx bail-host bots 0 --relayer http://localhost:8787 --count 3 --miss 1

# Terminal 3, once the bots are seated: run check-in, pressing Enter for each code.
npx bail-host live 0

# Afterwards: watch the phases, then the results.
npx bail-host status 0
npx bail-host report 0
```

The event id is printed by `create`; it is 0 only for the contract's first event. Expect 2 attended and 1 forfeited, with each attendee paid 1.5 test USDC.

## Tests

```bash
node --test test/host.test.ts                                 # schedules, slot timing, display, state
NEAR_SANDBOX_BIN=<path> node --test test/sandbox.test.ts      # the rehearsal above, on a local node
```
