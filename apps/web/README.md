# Bail web app

A static site for attendees, organizers and observers. Attendees RSVP with test USDC, catch live codes, and see results without a wallet or NEAR. Organizers connect a NEAR testnet wallet to create events and run codes in the browser. The site reads the chain over RPC and sends attendee actions and automatic reveals through the Bail relayer.

Vite, React and TypeScript, plain CSS, and the browser-safe `@bail/sdk`. The organizer pages load `@hot-labs/near-connect` 0.12.0 separately; attendee pages do not load it. No router, component library or site backend.

## Run it

From the repository root:

```bash
npm ci
npm run dev -w @bail/web          # http://localhost:5173
```

It needs a relayer to write through. For testnet, start one as described in [apps/relayer/README.md](../relayer/README.md) (it listens on `http://localhost:8787`, which is the default in `public/config.json`). Reading an event works without one.

Open `http://localhost:5173/#/event/3`, or enter an event number on the front page.

## Configuration

The site reads `config.json` next to `index.html` when it loads, so one build can be pointed at any deployment without rebuilding.

| Key | Required | Meaning |
|---|---|---|
| `relayerUrl` | yes | Address of the Bail relayer, such as `https://relay.example.org` |
| `contractId` | no | Defaults to `v1.dontbail.testnet` |
| `rpcUrl`, `fallbackUrls` | no | NEAR RPC endpoints. Defaults to FastNEAR's testnet host, with its archival host and drpc as fallbacks |
| `token` | no | Defaults to Circle's test USDC |
| `explorerUrl` | no | Such as `https://testnet.nearblocks.io`. Transaction and contract links appear only if set |
| `defaultEventId` | no | Adds a featured event link to the landing page's event finder |
| `events` | no | Titles, descriptions and call links the deployer vouches for, by event number: `{ "3": { "title": "...", "callUrl": "..." } }`. The contract stores none of these, so nothing is shown unless supplied here |

A missing or invalid `relayerUrl` shows a setup message instead of a broken page.

## Build and host

```bash
npm run build -w @bail/web        # writes apps/web/dist
```

`dist` is plain static files with relative paths and hash routes (`#/event/3`), so it works from any static host or folder with no rewrite rules. Put your `config.json` in it.

The public site, [raymondabiola.github.io/bail](https://raymondabiola.github.io/bail/), is built by `.github/workflows/pages.yml` on every push to `main`, with `site-config.json` as its `config.json`. Results and public records need only the chain. Actions need a running relayer: set the `RELAYER_URL` repository variable to point the site at one; without it, actions say the relayer isn't running. The relayer must allow the site's origin; it allows any origin unless `ALLOW_ORIGIN` is set.

## What it does

- **Landing page**: what Bail is, the real events it has run and the Sputnik DAO arbiter demo, each with its result read from the chain.
- **Event page**: what the event is, when check-in opens (in your timezone), seats, deposit, how it works, the named arbiter, fixed schedule and public evidence. Works without a ticket. Once an event has finished, a visitor with no ticket sees its result instead of RSVP steps.
- **RSVP**: terms and payout address, then a full-screen key backup, then payment. A typed NEAR payout account must exist before you can continue, and the app suggests the `.testnet` name when it doesn't. The ticket key is created in the browser, shown only on request, and never sent anywhere. Every step reads the chain first, so retrying after any failure or lost reply can't pay twice or make a second ticket.
- **Check-in**: a countdown to opening, then when a code goes live it takes over the screen: one input for the five words, word-list suggestions that never steal focus, a clear "sent" versus "confirmed after the host reveals the code", corrections with rising attempt numbers, and a "the host did not show a code" flag.
- **Dispute and results**: standing, vouching for someone whose phone died, then outcome, payout and whether it has actually been paid. Results are saved in the browser, because closing an event frees the on-chain ticket record.
- **Organizer view** (`#/event/3/organizer`): public, read only headcount and per-code activity.
- **Create an event** (`#/host`): connect a testnet wallet, choose the schedule, deposit, seats and independent arbiter, review the storage cost, and approve creation once. Optional titles and call links stay in the creating browser; share those details separately from the attendee link. If the wallet returns no event id, the site finds the event on chain. A pending creation can be recovered without sending another transaction.
- **Host screen** (`#/event/3/host`): use the creating browser and the organizer's wallet. Each code opens only after you press its button and approve in the wallet. Only the live code is displayed. After the window closes the page reveals it through the relayer, with an explicit wallet fallback if that fails. Keep the page open until every code is revealed, or return before the reveal deadline. The screen also checks whether the relayer is reachable.
- **Other chain**: a clearly marked "Planned for mainnet" placeholder. Nothing there works yet.

The ticket key is kept per event in this browser's local storage. If the browser blocks storage, the key is held in memory and the app says so on the backup screen. It never appears in a URL or a request.

Host records are separate, per contract and event. Creation requires working local storage. Losing an unopened code is recoverable by preparing new unopened codes on the host screen. Losing an opened code means it cannot be revealed and becomes void, lowering the attendee requirement. Unopened codes never enter the page's DOM, URLs or requests. Wallets receive only commitments when opening; the relayer receives a code only after its window closes. No access keys are added.

## Tests

```bash
npm test -w @bail/web             # logic, RSVP orchestration, colour contrast
npm run typecheck -w @bail/web
```

The unit tests cover the contract's slot and timing rules, every action's eligibility, money formatting, attempt numbering, storage failure, configuration, and the RSVP orchestration against a fake chain, including lost replies. A contrast test reads the colours from the stylesheet and checks every text pairing against WCAG 4.5:1.

### End to end

```bash
cargo near build non-reproducible-wasm --manifest-path contracts/bail/Cargo.toml
cargo near build non-reproducible-wasm --manifest-path contracts/test-token/Cargo.toml
NEAR_SANDBOX_BIN=<path to near-sandbox> npm run e2e -w @bail/web
```

This builds the site, starts a private NEAR node with the compiled contract, the real relayer and keeper, and drives the site in headless Chrome at phone size (`CHROME_PATH` if Chrome is not at `/usr/bin/google-chrome`). It runs a whole event: RSVP from an empty browser, key backup, restoring the ticket in a second browser, a live code with a typo and its correction, a flag, vouching, payouts checked against token balances, and the organizer view. It also checks that the Send button is on screen the moment a code goes live, that nothing scrolls sideways at 320px, and that the browser console stays clean. Set `E2E_SHOTS=<folder>` to keep screenshots.

The browser test also creates an event using a sandbox wallet, RSVPs an attendee, opens and catches codes, checks automatic reveal after a reload and the explicit wallet fallback, then verifies the attendee's token balance after settlement. Its injected wallet is enabled only by `testWallet: true` in the test's config and a loopback hostname. Never enable this flag in a deployed config; a public hostname cannot activate the adapter even if the flag is set. The sandbox signing key stays in the test runner.
