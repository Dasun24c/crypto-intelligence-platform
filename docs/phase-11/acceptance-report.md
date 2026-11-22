# Phase 11 · Whale Tracker: acceptance report

| | |
|---|---|
| Status | **Accepted 2026-11-21** (you answered "Accept Phase 11"), with criterion 11.2 accepted in part and 11.4 carried forward. Criteria 11.1 and 11.3 are met. Criterion 11.2 is met for everything that can be shown without connecting to the blockchain providers: the known PAXG mint and burn are captured correctly, and nothing is stored twice. On 2026-11-21 you chose to keep the on-chain watcher off on this laptop ("Keep it off"), so 11.2's other part, events pushed by the real providers within their documented latency, and criterion 11.4 (the providers' terms read and recorded before go-live) are carried forward, as 9.1 was, until the watcher runs on a computer where that traffic is allowed. Committed on 2026-11-21 at your request as `fc38db9` on the branch `phase-11/whale-tracker`, pushed, and merged into `main` through pull request #13 (`d3823eb`) |
| Date | 2026-11-21 |
| Scope | [Implementation plan, Phase 11](../phase-0/08-implementation-plan.md#phase-11--whale-tracker), REQUIREMENTS §7 (WH-01, WH-02), [proposal 003](../proposals/003-on-chain-providers.md) (decision D9, option A, approved 2026-11-17), [ADR 025](../adr/025-whale-tracker.md) |
| Evidence | This machine (the new Dell Vostro 3500: Windows 11 Pro, Docker Desktop 4.99, Node.js 26.13); the local Compose stack streaming live public data from Binance and Coinbase, built from `6c4f35f` on 2026-11-21 at 14:41 UTC with a fresh database, the on-chain watcher off; the web app rebuilt with the fixes below at 16:58 and 17:14 UTC |

## Summary

The **Whale Tracker** (`/whales`, in the navigation for every role) shows large money moving, in two tabs that are never mixed.

- **Exchange flow**: large trades and order-book walls on Binance and Coinbase, from what the platform already detects and stores (the rows Market Activity shows). Per pair over the last hour, 24 hours (the default) or 7 days: the number of large trades, buys and sells, the USD bought, sold and net, the largest; walls that appeared, were filled or pulled, and stand now. Below: the newest 200 large trades and the walls. It updates a second after each new large trade or wall.
- **On-chain**: large transfers on Bitcoin, Ethereum and Solana, and PAXG's mints and burns (Paxos's `SupplyIncreased` and `SupplyDecreased`) and large transfers, with each asset's totals and the flows into and out of listed exchange addresses. Above them, each source's state. Admins keep the list of exchange addresses on the same tab; each change is audited.
- **How on-chain events arrive** (ADR 025): this laptop has no public address, so providers push over outbound WebSocket subscriptions: mempool.space pushes each Bitcoin block; Alchemy pushes Ethereum's new blocks, PAXG's contract events and Solana transactions that touch a listed exchange wallet. The jobs service reads each block or transaction from the chain, keeps what is over the threshold ($1 million for BTC, ETH and SOL; $250,000 for PAXG; every mint and burn), values it with the platform's own prices, and stores it once.
- **Off on this laptop**: the watcher runs only when `ONCHAIN_ENABLED` is true, and it is false here. The On-chain tab says "The on-chain watcher is switched off on this stack", and nothing connects to a blockchain provider. The tests use chain data recorded on 2026-11-17.

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 11.1 | The Exchange flow tab matches stored large trades and walls | **Met** | End to end on the live stack: the page shows exactly what the endpoint returns, and for each pair with large trades or walls (8) the large trades (count, buys, USD bought and sold) and the walls match Market Activity's own endpoints over the same 24 hours; the api's totals are tested on seeded rows. [11.1](#111-exchange-flow) |
| 11.2 | On-chain events arrive by push within the provider's documented latency and are de-duplicated. A known historical PAXG mint and burn are captured correctly. | **Met in part, accepted by you on 2026-11-21.** The mint and burn, and the de-duplication: met. Push from the real providers and its latency: carried forward, since you chose to keep the watcher off on this laptop | The PAXG mint of 62.9874 PAXG (block 26429062) and burn of 3.2 PAXG (block 26429307) are captured from their supply events and stored once each, through the same jobs as the live path; delivered again, nothing is added; in-memory providers' pushes become one job each. [11.2](#112-on-chain-events) |
| 11.3 | Exchange and on-chain data never appear in the same list or chart | **Met** | End to end: neither tab shows an element of the other; the two endpoints share no field; axe finds nothing serious on either tab; the arrow keys move between them. [11.3](#113-never-mixed) |
| 11.4 | Each provider's terms of use are reviewed and recorded before go-live | **Carried forward with 11.2: due before the watcher goes live** | Proposal 003 recorded what Alchemy's and mempool.space's pricing pages said on 2026-11-16. Reading their full terms is the first step of switching the watcher on. [11.4](#114-terms-of-use) |

### 11.1 Exchange flow

- **End to end** (`e2e/tests/phase11.spec.ts`, the live stack, 2026-11-21): the page asks for the last 24 hours. It shows one row per pair carrying the endpoint's numbers, and as many large-trade and wall rows as the endpoint lists. For every pair, Market Activity's endpoints over the same window (`/market/{id}/large-trades`, read page by page, and `/market/{id}/walls`) give the same count of large trades and of buys, the same USD bought and sold (to the cent) and the same walls that appeared; the walls standing now agree within 2 (a wall can end between two reads). The list is newest first and inside the window. At 17:17 UTC the window held 105 large trades on 7 pairs (Binance BTC/USDT 46, ETH/USDT 16, SOL/USDT 14, PAXG/USDT 2; Coinbase BTC/USD 15, SOL/USD 9, ETH/USD 3) and 1,537 walls that appeared, with 13 standing, on 8 pairs in all (Coinbase PAXG/USD had walls only); the fresh database holds data from 14:40 UTC.
- **The api** (`apps/api/test/whales.int.test.ts`): large trades and walls seeded on two pairs, some of them outside the window (a trade after it, a wall standing since before it), give the expected totals and lists; one pair can be asked for alone; a window over 7 days is refused, and so is a request without a session.
- **The page** (`pages/whale-tracker.test.tsx`): the tab shows the endpoint's numbers; a live large trade makes it read the totals again.

### 11.2 On-chain events

**Recorded chain data** (`apps/jobs/test/fixtures/onchain/`, recorded on 2026-11-17 from public nodes, before the security alert that stopped all such calls): Bitcoin block 976172 (three of its transactions), Ethereum block 26429557 (two of its transactions), and the receipts of a PAXG mint (block 26429062, 2026-11-16 17:23:59 UTC) and burn (block 26429307, 18:12:59 UTC).

- **The detectors** (`apps/jobs/src/onchain/detect.test.ts`, 14 tests): the mint is recorded from `SupplyIncreased`: 62.9874 PAXG to `0xedd40fe35a559b8f5340b77af93083f3462ebb42`, log 132; the burn from `SupplyDecreased`: 3.2 PAXG from `0xf58e79a7bd26532ff525db5b78456eb2e79076ec`, log 164. Each also emits a `Transfer` from or to the zero address, which is not counted again (this settles the question feasibility §9 left open). Mints and burns are recorded whatever their size, even without a price. Bitcoin: 100.00095775 BTC paid by transaction `7663e888…` to 39 recipients, with change and coinbase transactions left out; Ethereum: 16,517.67 ETH in block 26429557.
- **The jobs, end to end in the jobs service** (`apps/jobs/test/onchain.int.test.ts`, 9 tests, new; a real database and Valkey; the providers are a fake `fetch` and an in-memory WebSocket behind `.invalid` hosts, so nothing connects out):
  - The mint and burn logs, processed as the watcher queues them, are stored once each with their block, time, addresses, amount and value (the mint: $251,949.60 at $4,000, priced through PAXG/USDT and USDT/USD). Their `Transfer` logs add nothing. **Delivered again, nothing is added.** The mint's block time comes from the pushed heads; the burn's is asked of the provider.
  - A log the node marks removed (a reorganisation) deletes its event; pushed again, it comes back.
  - A Bitcoin block and an Ethereum block read twice store their large transfer once, and move the chain's cursor forward.
  - SOL moved into a listed exchange wallet is recorded; the daily allowance of Solana reads stops the next one.
  - Without a fresh price no transfer counts as large, but the block is still read and a burn is still recorded, without a USD value.
  - **The watcher**, against in-memory providers: it subscribes as designed (Bitcoin blocks; Ethereum new heads; PAXG's `Transfer`, `SupplyIncreased` and `SupplyDecreased`; Solana logs that mention each listed wallet). Each pushed block, PAXG log and Solana transaction becomes **one** job: the same block, log or transaction pushed twice queues nothing more; a removed log queues its removal; a failed Solana transaction is not read. The status shows each source connected with its last block. Without an Alchemy key only Bitcoin connects, and Ethereum and Solana say why. Only the instance holding the lease connects.
- **The database** (`packages/db/src/onchain.int.test.ts`): one row per chain, transaction, asset and position; only the jobs service writes events; a mint has no sender and a burn no recipient; a cursor only moves forward; the other services have no access.

**Not shown here: push from the real providers, and its latency.** The watcher stays off on this laptop (your decision, below). To finish 11.2, on a computer where connecting to Alchemy and mempool.space is allowed: read and record their terms (11.4); put the Alchemy key in `.secrets-jobs/alchemy-api-key`; start the stack with `ONCHAIN_ENABLED=true`; after a day, compare each event's arrival (`received_at`) with its block's time, per chain, against what the providers document; and check that the next PAXG mint or burn appears once. On 2026-11-17 mempool.space could not be reached from the old laptop's network (blockstream.info could); the Bitcoin source can point at another Esplora service with `ONCHAIN_BTC_WS_URL` and `ONCHAIN_BTC_API_URL`.

### 11.3 Never mixed

- **End to end**: on the Exchange flow tab there is no on-chain element; the arrow key moves to the On-chain tab, which shows no pair, large trade or wall, but the four assets and the three sources, each "off", with the notice that the watcher is switched off. axe (WCAG 2.0 and 2.1, A and AA) finds nothing serious or critical on either tab. The exchange endpoint's response has only `from`, `instruments`, `largeTrades`, `largeTradesTotal`, `to` and `walls`; the on-chain one only `from`, `items`, `nextCursor`, `summary` and `to`.
- **The page** (`pages/whale-tracker.test.tsx`): sources and events appear only in the On-chain tab; switching tabs removes the other tab's rows.
- **The contracts** keep separate schemas for the two, with no shared type.

### 11.4 Terms of use

Proposal 003 recorded, from the providers' own pages on 2026-11-16: no personal-use restriction on Alchemy's pricing page; mempool.space treats heavy or business use as an enterprise matter. The criterion asks for the full terms to be read and recorded before go-live, and the watcher has not gone live: it is the first step of switching it on. I have not opened those sites from this laptop.

## Your decision: the on-chain watcher stays off on this laptop

The Defender alert of 2026-11-17 came from connections to blockchain services from the old laptop, and this laptop has not been checked for such monitoring. Asked whether to keep the watcher off here or switch it on with your Alchemy key, you answered **"Keep it off"** (2026-11-21).

- The stack keeps `ONCHAIN_ENABLED` at its default, false: nothing connects to mempool.space or Alchemy, and the On-chain tab says the watcher is switched off. The Exchange flow tab works as it is.
- 11.2's push and latency, and 11.4, are carried forward, as 9.1 was, until the watcher runs on a computer where that traffic is allowed.
- To switch it on there later: read and record the providers' terms, put the Alchemy key in `.secrets-jobs/alchemy-api-key` (never in chat), and start the stack with `ONCHAIN_ENABLED=true`.

## Decisions made while building it

Recorded in [ADR 025](../adr/025-whale-tracker.md). The ones you may want to know about:

1. **Exchange flow reads what is already stored**: no new table or job, so the tab and Market Activity always agree.
2. **Push over outbound WebSockets**, not webhooks: the stack has no public address.
3. **Ethereum blocks are read 2 blocks behind the newest**, past most reorganisations; PAXG events the node withdraws are deleted.
4. **A PAXG mint or burn is its supply event**; the `Transfer` from or to the zero address that comes with it is not a second event.
5. **Values come from the platform's own prices**, and with no fresh price (5 minutes) nothing counts as large.
6. **Exchange addresses are our own list**, kept by admins; none are listed yet, so every transfer's flow shows as "other" and Solana has nothing to watch until some are added.
7. **The watcher is off unless switched on**, now also in the jobs service's own settings (finding 4).

## Live

On the local stack (2026-11-21, UTC):

- **14:41**: the stack built from `6c4f35f` on the new laptop's fresh database: migrations up to `0015_onchain` applied at 14:41:31; all 8 services healthy; `ONCHAIN_ENABLED` at its default, false.
- **16:53**: checked: the `onchain` schema's three tables exist and are empty; `onchain:status` says "off" for Bitcoin (mempool.space), Ethereum and Solana (Alchemy), refreshed every 30 s; the Alchemy key file is empty; the jobs container mounts it read-only.
- **16:54**: the Phase 11 spec: 11.1 passed; 11.3 failed on axe (finding 1).
- **16:58**: the web app rebuilt with the shared table's fix; **16:59**: the Phase 11 spec, 2 of 2; the keyboard reaches and scrolls the wide table.
- **17:14**: the web app rebuilt with the reworded notice (finding 3).
- **17:26–17:31**: `pnpm verify` passed (below).
- **17:32–17:46**: every end-to-end spec, all phases: **29 passed, 7 skipped**: Phase 16's five skip themselves while your analyst's automatic practice trading is on, and the two frame-rate measurements run only when asked for (`E2E_PERF=1`). The tests signed in only as the `e2e-*` accounts: your three accounts have no audit event from these runs, and the analyst's automatic trading is still on, unchanged since 14:42.
- **17:47–17:58**: the integration suites of all seven packages that have them. The first run found the access matrix's gap (finding 6), the second my new test's price assumption (below); the third passed, all seven, with coverage (17:52–17:58).
- **17:59–18:00**: `pnpm verify` again on the final code: passed.
- **Later on 2026-11-21**: you chose to keep the on-chain watcher off on this laptop (nothing on the stack changed), then accepted Phase 11.

## Found by verification and fixed

| # | Found | Effect | Fix |
|---|---|---|---|
| 1 | axe's "scrollable-region-focusable" on the Exchange flow tab: in a 1280-pixel window the per-pair and large-trade tables are wider than their boxes (1,106 and 1,065 pixels in 1,006), and the boxes could not be reached from the keyboard | Keyboard users could not scroll to the right-hand columns (WCAG 2.1.1). It affects any wide table, on any page | The design system's table makes its box a focusable region, named by the table's caption, while (and only while) the table is wider than the box. A unit test; on the stack the arrow keys scroll it, and at 1,600 pixels the extra tab stop goes away |
| 2 | The contracts package's coverage gate (90 % of branches) failed: `whales.ts` had no tests in its package (71 % of branches) | `pnpm verify`, and so CI's checks, would fail | 6 tests of the address formats, the label form, the flows, the queries and the sources' states: 100 % |
| 3 | The jobs service's 13 new settings (`ALCHEMY_API_KEY` and `ONCHAIN_*`) were missing from the list of server settings, so the jobs configuration test failed and the artefact scan did not look for them. The On-chain tab's notice also named `ONCHAIN_ENABLED`, which that scan forbids in the web app | A server setting's name could reach the web app unnoticed | Listed; the notice now says the watcher is switched on "in the jobs service's settings" |
| 4 | The watcher's own default was on: only the Compose files switched it off, so running the jobs service from source (`pnpm --filter @cip/jobs dev`) would have connected to mempool.space | An outbound connection to a blockchain service from this laptop, the kind that raised the alert of 2026-11-17 | Off unless `ONCHAIN_ENABLED=true`, in the service's own settings; a test |
| 5 | Nothing tested the jobs that store on-chain events or the watcher: the push path, the de-duplication of jobs, a withdrawn log, the key, the lease | 11.2's "de-duplicated" rested on the database key alone | 9 integration tests on the recorded chain data; the watcher takes an in-memory WebSocket in its tests, so nothing connects out |
| 6 | The api's access matrix (criterion 1.4) did not list the 6 new routes, so its check that the table covers every route the api serves failed (found by the first full integration run) | Who may call the new routes was not checked | Listed: the three Whale Tracker routes for every role, the exchange addresses for admins; each is called by every role and anonymously (24 tests) |

My new tests needed two corrections, neither a product defect: the watcher test first read the status before the watcher's next 5-second report; and the "no fresh price" test assumed no other suite had left a price behind, while in the full run the AI suite's BTC/USDT price was still there, dated in March 2027 and so never old (my test now sets or removes every pair's price itself).

**This laptop, not the product**: `turbo` (which `pnpm verify` and `pnpm test:integration` use) and the api's password-hashing module (`argon2`) are native Windows programs that need the Microsoft Visual C++ runtime (`VCRUNTIME140.dll`), which is not installed on the new laptop: both stopped with "DLL not found". I ran the suites with the runtime's three DLLs copied from Microsoft Edge's own folder (signed by Microsoft) into a temporary folder on the test processes' `PATH`; nothing was installed or changed. Later that day, at your request, the "Microsoft Visual C++ Redistributable 2015–2022 (x64)" was installed with winget (`Microsoft.VCRedist.2015+.x64`, 14.52); `turbo` and `argon2` now load without that workaround.

## Tests and coverage

2,360 automated tests: 1,673 unit, 651 integration and 36 end to end (Phase 10: 2,270). All pass, except the 7 end-to-end tests that skip by design (above). Phase 11 added 76 of them: 30 unit, 44 integration and 2 end to end. The other 14 since Phase 10 came with the stack fixes of 2026-11-16 (pull request #12).

- `pnpm verify` passes on the final code (2026-11-21, 17:59–18:00 UTC; Turbo reused the results of the 17:26–17:31 run where nothing had changed): formatting, lint, typecheck, dependency rules (557 modules), the no-trading check (883 files), unit tests with coverage gates, the build, and the artefact scan of the web app (36 files, 58 rules, 51 of them server setting names).
- The integration suites of all seven packages that have them pass with coverage (17:52–17:58 UTC).
- Every end-to-end spec ran against the live stack (17:32–17:46 UTC): 29 passed, 7 skipped by design.

As before, the integration figures count only integration tests: each package's integration run also repeats its unit tests.

| Package | Tests (unit + integration; Phase 10 in brackets) | What is new in Phase 11 | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| app | 201 (193) | The Whale Tracker page (3: both tabs, the sources and events, the admins' exchange addresses) and its helpers (5) | none yet | 81.6 % / 70.1 % (the page: 95.0 % / 69.2 %) |
| api | 27 + 481 (27 + 451) | The Whale Tracker's endpoints (6); the access matrix's 6 new routes (24) | 70 % | 91.1 % / 77.3 % (`src/whales`: 94.6 % / 92.5 %) |
| contracts | 91 (85) | The Whale Tracker's contracts (6) | 90 % | 100 % / 100 % |
| db | 2 + 49 (2 + 44) | The `onchain` schema: one row per event, who may write, the kinds, the cursors (5) | 70 % | 95.8 % / 80.6 % |
| jobs | 34 + 59 (19 + 50) | The detectors on recorded chain data (14) and the watcher's default (1); the processor and the watcher on recorded data (9) | 70 % | 92.7 % / 80.4 % (`src/onchain`: 88.3 % / 75.2 %) |
| ui | 5 (4) | The table's scroll region (1) | none | |
| ingestor | 15 + 16 (6 + 14) | None (the stack fixes of #12: 9 + 2) | 70 % | 92.5 % / 80.6 % |
| analyzer | 5 + 25 (5 + 25) | None | 70 % | 90.8 % / 76.1 % |
| broker | 3 + 17 (3 + 17) | None | 70 % | 96.2 % / 78.4 % |
| observability | 15 + 4 (15 + 4) | None | 70 % | 88.3 % / 73.0 % |
| End to end | 36 (34) | `phase11.spec.ts` (2: 11.1 and 11.3 on the stack) | | |

The other packages are unchanged in Phase 11; exchange-adapters has the 3 tests of #12 (28 in all).

## Not covered, and limits

- **11.2's push from the real providers and its latency, and 11.4's terms**: carried forward, by your decision to keep the watcher off on this laptop, until it runs on a computer where that traffic is allowed (above).
- **No exchange addresses are listed** yet, so the on-chain flows all show as "other", and Solana has nothing to watch. The list comes from the exchanges' proof-of-reserves pages before go-live; the research stopped on 2026-11-17 with the alert.
- **Coverage of option A**: Solana only into and out of listed wallets; no token other than PAXG; no internal ETH transfers. A Bitcoin block replaced after it was read is not checked again.
- **The jobs container runs the code of `6c4f35f`**: the two jobs changes (the setting's default, and the watcher's test seam) change nothing on this stack, which sets `ONCHAIN_ENABLED=false` itself, so the server containers were not rebuilt (that would have restarted the broker with your automatic trading). The web container runs the final code.
- **The desktop app was not rebuilt**; the page is in `packages/app`, so the next desktop build has it.
- **In CI** (the replay stack) the Phase 11 spec is meant to run too: the watcher is off there, and the Exchange flow tab may be empty; it has run only against the live stack here.
- **Committed and merged**: `fc38db9` on `phase-11/whale-tracker`, after the work-in-progress commit `6c4f35f`; both pushed, and merged into `main` through pull request #13.
