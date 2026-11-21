# ADR 025: The Whale Tracker keeps exchange flow and on-chain events apart; on-chain events are pushed over outbound WebSockets, read from the chain in the jobs service, stored once per transaction and position, and labelled from our own list; the watcher stays off unless switched on

- Status: accepted (Phase 11)
- Date: 2026-11-21 (built 2026-11-17; verified and completed 2026-11-21)
- Context:
  - [REQUIREMENTS §7](../../REQUIREMENTS.md#7-whale-monitoring) (WH-01, WH-02; PAXG transfers and Paxos mint and burn events once a provider is approved);
  - [architecture §5.6](../phase-0/03-architecture.md#56-exchange-whale-signals) (large trades and walls) and §6 (the `onchain` queue), [API contracts](../phase-0/06-api-contracts.md) (`/whales/exchange`, `/whales/onchain`);
  - [feasibility §9](../phase-0/02-feasibility.md#9-on-chain-providers-decision-in-phase-11) (providers; whether a PAXG mint and burn also emit `Transfer` was left to confirm), decision D9 and [proposal 003](../proposals/003-on-chain-providers.md) (option A, approved 2026-11-17);
  - risk R21 (on-chain provider cost, terms and coverage);
  - implementation plan Phase 11 (criteria 11.1–11.4).

## Context

Phase 0 split whale monitoring in two. Large trades and order-book walls on the venues (WH-01) have been detected and stored since Phase 2, and Market Activity shows them per instrument. Transfers on the blockchains (WH-02) were to come only after a provider evaluation; proposal 003 chose option A, at no cost: Alchemy's free plan for Ethereum, PAXG and Solana, mempool.space for Bitcoin, and our own list of exchange addresses.

This ADR settles how the two are kept apart, how on-chain events reach a platform that has no public address, what counts as an event, how each is stored once, how amounts are valued and labelled, and when the on-chain watcher runs at all.

## Decision

### Two tabs and two endpoints, never mixed

- **One page, `/whales` ("Whale Tracker")**, for every role (`dashboards.view`), with two tabs: **Exchange flow** and **On-chain**. They are WAI-ARIA tabs (arrow keys, Home and End); only the open tab's panel is rendered, so no list, table or chart ever holds both (criterion 11.3).
- **Separate endpoints and contracts**: `GET /whales/exchange` (`ExchangeFlow`) and `GET /whales/onchain` (`OnchainPage`), plus `GET /whales/onchain/status`. Neither response carries a field of the other.
- The exchange addresses are kept by admins (`settings.manage`) at `/admin/whales/labels`; every change is audited.

### Exchange flow

- **No new table or job.** It reads `market.large_trades` and `market.orderbook_walls`, the rows Market Activity reads, with the same meaning: large trades in `[from, to)`, and walls standing now or first seen in the window.
- **Window**: the last 24 h by default, at most 7 days.
- **Per instrument**: large trades (buys and sells), bought, sold and net USD, the largest; walls appeared, filled, pulled and standing now. **Lists**: the newest 200 large trades (the totals count every one), and up to 500 walls, standing ones first.
- **Live**: the page follows the instruments' trades and market channels, and reads the totals again a second after the latest large trade or wall event; otherwise every 15 s.

### On-chain events are pushed over outbound WebSockets

The stack has no public address, so providers cannot call a webhook. The jobs service's **watcher** keeps outbound WebSocket subscriptions instead, and each pushed block or transaction becomes a job on the BullMQ queue `onchain`:

| Chain | Subscription | Job | What the job reads |
|---|---|---|---|
| Bitcoin | mempool.space: `want blocks` | `btc-block` for each new block | The block's transactions from the Esplora REST API, 25 a page, one request at a time and at most 4 a second |
| Ethereum | Alchemy: `newHeads` | `eth-block` for the block 2 behind each new head, past most reorganisations | The block with its transactions (`eth_getBlockByNumber`) |
| PAXG | Alchemy: `logs` of the PAXG contract for `Transfer`, `SupplyIncreased` and `SupplyDecreased` | `paxg-log` for each log; `paxg-removed` when the node marks a log removed (a reorganisation) | The block's time, from the pushed heads, or from the node |
| Solana | Alchemy: `logsSubscribe` mentioning each listed exchange wallet (at most 25, cold and reserve wallets first) | `sol-tx` for each successful transaction | The transaction (`getTransaction`), at most 5,000 a UTC day, to keep the free plan for Ethereum |

- **One watcher**: the instance holding the fenced lease `lease:onchain` keeps the subscriptions. Any jobs instance reads the queue (2 at a time, 6 attempts, backing off from 10 s).
- **After a disconnection** the missed blocks are read from each chain's cursor: Bitcoin by height (at most 12), Ethereum by number (at most 300; older ones are skipped and logged). The first start begins at the tip; no history is read.
- **The sources' state** goes to `onchain:status` every 5 s (stale after 60 s): connected, connecting, no key, unreachable (after 3 failed attempts in a row), error, standby, idle (Solana with no listed wallet) or off. The On-chain tab shows it.
- **The Alchemy key** is the file `.secrets-jobs/alchemy-api-key`, which only the jobs container mounts, as for Grok's key (ADR 023). The watcher looks for it every 30 s, so a key added later starts Ethereum, PAXG and Solana without a restart. Bitcoin needs no key. The key is part of Alchemy's URLs, so no URL is ever logged or put in an error: errors name the provider and the status only.

### What counts as an event

- **Bitcoin**: what a transaction pays to addresses other than its inputs' (change returning to the sender is not transferred), when large. From is the largest input's address, to the largest recipient's; the counts of inputs, outputs, senders and recipients are kept. Coinbase transactions are left out.
- **Ethereum**: a transaction moving at least the threshold in ETH itself. Contract creations, internal transfers and tokens other than PAXG are not covered.
- **PAXG**: a **mint** from `SupplyIncreased` and a **burn** from `SupplyDecreased`, whatever their size. The recorded mint and burn show that each also emits a `Transfer` from or to the zero address (the point feasibility §9 left open); that `Transfer` is not a second event. Any other `Transfer` of at least the threshold is a transfer.
- **Solana**: SOL moving into or out of a listed exchange wallet: the account that lost the most sends, the one that gained the most receives, and the amount is what was received.
- **Thresholds**: $1,000,000 for BTC, ETH and SOL, and $250,000 for PAXG (settings of the jobs service).
- **Prices** are the platform's own live tickers: the USD pair when one streams, otherwise the USDT pair times USDT/USD (1 when that is not streamed). A ticker older than 5 minutes gives no price, and without a price nothing counts as large; mints and burns are still recorded, without a USD value. The value at detection is stored with the event.

### Each event stored once

- `onchain.events` has one row per **(chain, transaction, asset, position)**: the position is the log index on Ethereum, otherwise 0. Inserts do nothing on a conflict, and only new rows are counted, so a block read twice, a log pushed twice or a job retried adds nothing.
- Jobs have ids made from the block or transaction (`btc-<height>-<hash>`, `eth-<number>`, `paxg-<transaction>-<log index>`, `sol-<signature>`), so a repeated push queues nothing while the job is kept.
- `onchain.cursors` keeps the last block each chain finished; it only moves forward.
- A removed PAXG log deletes its event. Ethereum blocks are read 2 behind the head. A Bitcoin block replaced after it was read is not checked again.
- Only the jobs service writes events (`svc_jobs`: select, insert, and delete for removed logs); the api only reads them.

### Labels are our own list

- `onchain.labels`: chain, address (Ethereum in lowercase), owner, wallet kind (cold, hot, reserve, unknown) and where the exchange published it. Admins add and remove them; each change is audited (`onchain_label.created`, `onchain_label.deleted`).
- Labels are joined when events are read, so an address listed later labels earlier events too. A transfer is **to an exchange**, **from an exchange**, **between exchanges** or **other**; each asset's totals add up the USD into and out of the listed exchanges.
- None are seeded. The list is built before go-live from the addresses exchanges publish in their proof-of-reserves reports.

### Off unless switched on

`ONCHAIN_ENABLED` is false unless set to true: in the jobs service's own settings, in the local stack and on the replay stack. CI never switches it on. While it is off, nothing connects to a provider; the jobs service writes an "off" state for each source every 30 s, and the On-chain tab says the watcher is switched off on this stack.

The development laptop is a managed computer on which outbound connections to blockchain services raised a security alert on 2026-11-17. The watcher therefore runs only where that traffic is allowed and the user has switched it on.

### Terms of use

Before go-live, Alchemy's and mempool.space's terms are read in full and recorded (criterion 11.4). Proposal 003 found no personal-use restriction on Alchemy's pricing page; mempool.space treats business use as an enterprise matter.

## Consequences

- The Exchange flow tab needs no new data: it is as current as the ingestor's detections.
- Option A covers every large BTC and ETH transfer, every PAXG mint and burn and its large transfers, but Solana only into and out of listed exchange wallets, and no token other than PAXG.
- Exchange flows on the On-chain tab are only as complete as the list of addresses: with none listed, every transfer is "other".
- Delivery depends on the providers: a Bitcoin block when it is mined, an Ethereum block 2 blocks (about 24 s) after it, PAXG logs as the node pushes them. It is measured only once the watcher runs.
- Moving to option B or C changes the watcher's sources; no screen, table or alert changes.

## As built (Phase 11)

- **Contracts** (`packages/contracts/src/whales.ts`): the exchange flow, the on-chain events, pages, summaries and sources' states, the labels with each chain's address format, the thresholds, the PAXG contract.
- **Database** (`packages/db/migrations/0015_onchain.sql`, `packages/db/src/onchain.ts`): the `onchain` schema (labels, events, cursors) and its grants; storing events once, removing a reorganised one, moving a cursor forward.
- **The api** (`apps/api/src/whales/`): `/whales/exchange`, `/whales/onchain`, `/whales/onchain/status` and `/admin/whales/labels`.
- **The jobs service** (`apps/jobs/src/onchain/`): the pure detectors (`detect.ts`), the provider HTTP clients (`http.ts`), the prices (`prices.ts`), the jobs (`jobs.ts`), the processor (`processor.ts`) and the watcher (`watcher.ts`, which takes an in-memory WebSocket in its tests).
- **The app** (`packages/app/src/pages/whale-tracker.tsx`, `lib/whales.ts`): the page and its tabs; the test hooks `data-flow-instrument`, `data-trade-id`, `data-wall-id`, `data-onchain-asset`, `data-onchain-event`, `data-source` and `data-source-state`.
- **Recorded chain data** (`apps/jobs/test/fixtures/onchain/`): Bitcoin block 976172, Ethereum block 26429557, the PAXG mint in block 26429062 and the burn in block 26429307 (all of 2026-11-16, recorded on 2026-11-17).
- **Shared table**: the design system's `Table` became a focusable, named region while it scrolls sideways, so a wide table can be scrolled from the keyboard (found by the Phase 11 end-to-end test).
