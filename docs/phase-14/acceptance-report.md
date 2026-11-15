# Phase 14 · Practice trading: acceptance report

| | |
|---|---|
| Status | **Accepted 2026-11-15**, when you asked to start Phase 16. All twelve criteria are met, criterion 14.1 in the web app and in the installed Windows desktop build. Committed on 2026-11-15 at your request, after Phases 7 and 8; not pushed |
| Date | 2026-11-14 to 15 |
| Scope | [Implementation plan, Phase 14](../phase-0/08-implementation-plan.md#phase-14--practice-trading), [proposal 001](../proposals/001-trading.md), [ADR 021](../adr/021-practice-trading-engine-and-broker.md) |
| Evidence | This machine (Windows 11, Docker Desktop, Node.js 26.13.0); the local Compose stack streaming live public data from Binance and Coinbase, redeployed with Phase 14 at 06:20 UTC on 2026-11-15 and again, with the journal fix, at 06:44; the Windows desktop build of 07:24, installed over the Phase 8 build; checks to 09:55 UTC |

## Summary

Every user has a practice account on each venue, starting at 10,000 in the venue's quote currency. They buy and sell with simulated spot orders, and see what they hold and how it has gone. Orders are simulated inside the platform and fill from the venues' live trades and order books. **No order reaches an exchange, no real money is involved, and a person places every order.**

- **Orders** (the Practice Trading page, `/practice`, for every role):
  - market and limit orders to buy and sell, on any monitored pair;
  - a buy can carry a protective stop and a target, which sell what it bought and cancel each other (one-cancels-other);
  - cancelling, and resetting an account to its starting balances (its history stays).
  - Every order goes through a confirmation step that shows what it will cost with fees, under the practice banner.
- **Fills** ([ADR 021](../adr/021-practice-trading-engine-and-broker.md)), by a pure engine, `packages/paper-engine`:
  - a market order walks the book level by level, so a large one pays slippage, and what the book cannot fill is cancelled;
  - a waiting limit order fills only when a live trade goes through its price, up to the quantity traded;
  - a stop triggers on a trade at its price, then sells against the book;
  - fees per venue (Binance 0.1 % maker and taker; Coinbase 0.5 % maker and 0.9 % taker, its lowest US tier), set by admins;
  - the venues' price step, quantity step and minimum order value;
  - fills that took a large share of a thin book, or PAXG fills while the gold market was closed, are flagged.
- **The broker** (`apps/broker`, new) is the only writer of fills and balances. One instance holds a fenced lease, with a standby. It reads the api's commands and every live trade of the monitored pairs (`md:trades:{id}`, new, from the ingestor), and the latest book. It opens no connection to any venue.
- **Balances** are never stored: they are sums of a ledger of starting balances, holds, releases, fills and fees, so they always reconcile.
- **Refusals**: an order is refused, with the reason, when the pair's data is delayed or has a gap, the pair is halted, the order breaks the venue's rules, or the balance does not cover it with fees. Refused orders stay in the history.
- **Every action is audited**: orders placed, refused, cancelled and filled, and account resets.
- **Replays**: the broker journals every input with what it read, so a replay of the journal gives the same fills (criterion 14.3).
- **Results**: holdings by average cost, realised and unrealised profit and loss after fees, per currency, all labelled as simulated and never presented as expected performance.
- **Alerts**: two new alert kinds, "practice order filled" and "practice stop or target reached", through the Phase 8 pipeline.
- **"Practise this setup"** on a bullish setup fills in the ticket with the setup's levels and the position-size calculator's quantity. It places nothing.

Verification found three defects, all fixed: the journal did not record the rules and fees the engine used; the broker did not audit cancellations and resets; and the page could show a filled order as still submitted. See [below](#found-by-verification-and-fixed).

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 14.1 | On every monitored pair, a user buys and sells with market and limit orders, cancels an open order, and sees balances, positions and profit and loss update, in the web and desktop apps | **Met**: on the live stack, all eight monitored pairs bought and sold; a limit order rested and was cancelled; balances, holdings and results updated, in the web app (end to end) and in the installed Windows desktop build | [14.1](#141-buying-and-selling) |
| 14.2 | Fills match hand-computed fixtures: slippage, fees, trade-through limits, partial fills, a stop triggering, a stop and target cancelling each other | **Met**: unit fixtures for each, and the broker's integration tests | [14.2](#142-fills-against-hand-computed-fixtures) |
| 14.3 | Replaying the same recorded market data and orders gives identical fills (digest) | **Met**: a property test, the broker's integration test, and the live journal (82 entries, 67 fills, identical) | [14.3](#143-replays) |
| 14.4 | The ledger always reconciles, no balance goes negative, a retried submission never creates a second order | **Met**: a property test over random sessions; five concurrent retries made one order | [14.4](#144-the-ledger-and-retries) |
| 14.5 | Orders are refused, with the reason, on delayed or gapped data or a halted pair, and when they break the venue's steps or minimum value | **Met**: unit, integration (api and broker), and a real refusal on the live stack | [14.5](#145-refusals) |
| 14.6 | "Practise this setup" fills in the ticket and nothing is submitted until the user submits it (end to end); no code in setups, alerts, the AI or jobs can create an order | **Met**: end to end from a real bullish setup; the dependency rule, proven with deliberate violations | [14.6](#146-practise-this-setup) |
| 14.7 | The practice banner on every practice screen; every result labelled as simulated | **Met**: unit and end to end | [14.7](#147-labelled-as-simulated) |
| 14.8 | The RBAC matrix covers the new endpoints; each role reaches only its own account; orders and resets are audited, and the hash chain verifies | **Met**: integration | [14.8](#148-access-and-audit) |
| 14.9 | Practice fills arrive as alerts, in the inbox and as native notifications; after a disconnect, open orders and balances resynchronise | **Met**: end to end on the live stack, integration and unit | [14.9](#149-alerts-and-resynchronisation) |
| 14.10 | `pnpm check:no-trading` passes unchanged; a test shows the broker opens no connection to any venue | **Met**: verify; the broker's integration test records every connection; live, the broker holds connections to the database and Valkey only | [14.10](#1410-no-venue-contact) |
| 14.11 | NFR-16 is measured and met (a fill published p95 ≤ 1 s) | **Met**: market orders p95 210 ms, waiting orders p95 124 ms after their trade | [14.11](#1411-latency-nfr-16) |
| 14.12 | axe finds no serious violations on the new page, and keyboard navigation works, including the confirmation step | **Met**: end to end, in the form and in the confirmation step | [14.12](#1412-accessibility) |

### 14.1 Buying and selling

- **End to end** (`e2e/tests/phase14.spec.ts`, the live stack, the development viewer):
  - **Through the page**, on Binance BTC/USDT: a market buy; the fill arrives on the page, and the BTC balance and the holding appear. Then a market sell; the holding goes to zero and the results show the realised profit or loss. Then a limit buy at half the best bid rests under "Open practice orders", is cancelled, and shows as cancelled in the history.
  - **On every monitored pair**, through the api: a market buy and a market sell, each waited for until filled. All eight pairs bought and sold: BTC, ETH, SOL and PAXG on Binance and on Coinbase.
- **Integration** (`apps/api/test/practice.int.test.ts`): accounts opened once per venue however many requests race; orders stored as submitted and handed to the broker; stops and targets attached; cancel and reset; positions and profit and loss computed by hand.
- **The desktop app** ([evidence](evidence/14.1-desktop/README.md)): the Windows build of 2026-11-15, installed over the Phase 8 build, signed in as the viewer against the stack. Through its window: a market buy of 0.0002 BTC, confirmed and filled at 64,354.64, the BTC balance up from 0.0011 to 0.0013; a market sell, filled at 64,361.82, with the results updated; and a limit buy at 32,180.00 that rested and was cancelled. The page is the same `packages/app` page as on the web.

### 14.2 Fills against hand-computed fixtures

Unit (`packages/paper-engine`, 34 tests), each with its numbers worked out by hand:

| Behaviour | Test |
|---|---|
| Slippage | A market order walks the book level by level, at each level's price, and pays the taker fee |
| What the book cannot fill | Cancelled, as on the venues |
| Fees | Taker for market orders; maker for resting limits, which keep the difference from the higher fee they held |
| Trade-through | A resting limit fills only on a trade through its price, at its price, up to the traded quantity; trades printed before it was accepted never fill it |
| Partial fills | A trade smaller than the order fills part of it; a trade is shared between resting orders by price, then time |
| A stop triggering | A stop triggers on a trade at its price and sells against the book; with no book it waits for the next trade that has one |
| Stop and target | A filling target cancels the stop and keeps selling the rest; cancelling one cancels both; a partly filled buy keeps its legs for what it bought |
| Flags | A thin book (more than a fifth of the depth within 0.5 % of the best price); PAXG while the gold market was closed |

The broker's integration tests (`apps/broker`) run the same cases through the real service, PostgreSQL and Valkey: a market fill of 0.5 at 100 (50 USDT, fee 0.05, taker), a limit filled only by a trade through its price, a stop selling against the book and cancelling its target.

### 14.3 Replays

- **Unit**: the same inputs give the same fills (a property test over random sessions), and a journal replays on a fresh engine with every digest line equal. A new test changes the fees and a pair's minimum in the middle of a session: the journalled configuration replays exactly, and without it the replay differs at the first order.
- **Integration**: the broker's journal, written across a lease handover between two instances, replays with every fill identical; each run starts with the rules and fees it used.
- **Live**: `docker compose exec broker node apps/broker/dist/cli.js replay` on the stack. Since the redeploy with the fix (journal entry 79), 82 entries with 67 fills replay with every fill identical. The run before it (entries 1–78) differs at entry 3, which found [defect 1](#found-by-verification-and-fixed).

### 14.4 The ledger and retries

- **Property test** (`packages/paper-engine`): over random sessions of orders, trades, cancels and resets, no balance goes negative, the ledger sums to the balances, and what live orders hold is accounted for.
- **Retries** (integration): five concurrent submissions with one `clientOrderId` made one order (one `201`, four `200`) and one command to the broker. The same key for a different order answers `409`; a refused order retried is refused again, without a second row.

### 14.5 Refusals

- **Integration** (api): each reason, with the stored refused order and its audit entry, and no command to the broker: price step, quantity step, minimum value, the balance (a buy, and a sell of nothing), a reference pair (`not_practice_pair`), no book (`no_market`), delayed data (a degraded trades feed, and no feed status at all), a data gap, and a halted pair.
- **Integration** (broker): an order taken up while the data was delayed is refused by the broker, audited with `by: broker`.
- **Unit**: the engine's refusals, in the same order as the api's checks, so the reason is the same either way.
- **Live**: an end-to-end run sized its order before the pair-status job had read BTC/USDT's 5 USDT minimum; the api refused the next order as below the minimum, with the reason on the page.

### 14.6 "Practise this setup"

- **End to end**: the run found a bullish BTC/USDT setup with levels, opened it, and followed "Practise this setup". The ticket showed "Filled in from a setup", with the limit price, the quantity, the stop and the target. No order request was sent while the ticket was open, reviewed, and taken back to editing.
- **Unit** (the app): the levels are rounded down to the pair's price step and the quantity is the calculator's; a bearish setup shows that practice trading is spot only, with no link.
- **The dependency rule** `only-the-api-and-broker-handle-practice-orders`: only the api's practice module and the broker may import the order-command module. Deliberate imports from the jobs service, the analyzer (the AI's home too) and the alerts package each failed `depcruise` (2026-11-15), and the check passed again once removed.

### 14.7 Labelled as simulated

- The banner, "Practice trading: simulated orders, no real money.", heads the page, the confirmation step and the admins' settings card, in a colour used for nothing else (unit and end to end).
- Results are titled "(simulated)": the holdings and results, and the fills; the page says simulated results are not a guide to what real trading would return.
- Practice alerts end with "Practice trading: simulated, no real money."

### 14.8 Access and audit

- **RBAC matrix** (integration): the ten new endpoints, each called with every role and anonymously. Every role has `practice.own`; the admin settings need `settings.manage`.
- **Own account only** (integration): another user, an admin included, gets `404` for someone else's order and cannot cancel it; lists and accounts are per user.
- **Audit** (integration, api and broker): `practice_order.placed`, `.refused` (`by: api` or `broker`), `.cancel_requested`, `.cancelled` (with its cause), `.filled`, `practice_account.reset_requested` and `.reset`, and `settings.updated`. After the practice tests, the audit chain verifies through the api (`GET /admin/audit/verify`).

### 14.9 Alerts and resynchronisation

- **End to end**: a "practice order filled" rule; a market buy on the page; the alert was recorded, put in the inbox, and shown in the app's Alert Center. Then a resting limit order; the browser went offline; the order was cancelled meanwhile through the api; back online, the page showed it gone without a reload.
- **Integration**: the analyzer reads `practice:events` with its own cursor and fires the two practice kinds for the owner's rules only, once per order and outcome. The rule test lists practice fills too. The api's `practice` channel delivers each user only their own updates, and a reconnect too old to replay gets the balances and open orders as a snapshot.
- **Unit** (the app): channel updates move orders and balances; a snapshot after a reconnect replaces them.
- **Native notifications**: practice alerts use the same delivery as every other alert, whose native notifications passed criterion 8.2 on Windows.

### 14.10 No venue contact

- `pnpm check:no-trading` passes unchanged (verify, 2026-11-15, 09:47–09:55 UTC).
- The broker's integration test records every connection the process opens while the broker works: all go to the test database and Valkey. Its package depends on no venue adapter, and the dependency rule `broker-has-no-venue-client` failed on a deliberate import of the adapters (2026-11-15).
- Live: the broker container's established connections were to Valkey (two) and PostgreSQL (one), nothing else.

### 14.11 Latency (NFR-16)

`node scripts/practice-latency.mjs --drive 40 5` on the final build (2026-11-15, about 06:50 UTC): 40 practice orders on BTC/USDT through the api, then every practice fill in the last 5 minutes, timed on the Redis clock at both ends.

| Fills | n | p50 | p95 | max | Target |
|---|---|---|---|---|---|
| Market orders: submitted (command appended) → fill published | 43 | 95 ms | 210 ms | 298 ms | p95 ≤ 1 s |
| Waiting orders: the trade that filled it → fill published | 24 | 59 ms | 124 ms | 199 ms | p95 ≤ 1 s |

A first run on the first deploy gave 300 ms and 180 ms (30 and 27 fills). The broker also records the first figure as `cip_practice_order_latency_ms`.

### 14.12 Accessibility

End to end, on the live stack: axe (WCAG 2 A and AA) found no serious or critical violation on the page, in the form and in the confirmation step. By keyboard alone: the quantity typed, Enter to review, the focus on the confirmation's heading, Tab to "Place practice order", Escape back to the form, and Enter and Tab to place it. The app's unit tests check the focus on the confirmation and on the first wrong field, the field errors, and Escape.

## Live

On the local stack (2026-11-15, UTC):

- **06:20**: redeployed with Phase 14. Migration 0012 was applied; the broker took the lease (epoch 1).
- **06:23–06:27**, end to end: the first run passed 14.1 and 14.7/14.12, then failed 14.6 on a mistake in the test (it passed the scanner's `state=all` to the api, which does not take it). The second run hit the real refusal described under 14.5. The third passed 4 of 4.
- **After those runs**: latency, market p95 300 ms and waiting p95 180 ms.
- **06:44**: redeployed with the journal fix; the broker journalled its configuration with its new `load`.
- **06:45–06:47**: end to end, 5 of 5, including every monitored pair.
- **06:48–06:52**: latency on the final build (above), and the live replay (82 entries, 67 fills, identical).
- **07:24–07:31**: the desktop app rebuilt and installed over the Phase 8 build; criterion 14.1 in it (07:30, [evidence](evidence/14.1-desktop/README.md)).
- **08:40–09:01**: `pnpm verify`, then the integration suites with coverage, on the final code.
- **09:01–09:20**: every end-to-end spec, all phases: 9 passed, 3 failed and 7 were skipped after them. The failures were [defect 3](#found-by-verification-and-fixed), the smoke test's new broker check, and Phase 8's gold alert on a Sunday (see the corrections below).
- **09:33–09:35**: the stack rebuilt with those fixes.
- **09:35–09:46**, the failed specs again: the smoke and Phase 8 specs passed (the gold kind recorded as not checkable while the gold market was closed). Phase 14's "every pair" test hit the order rate limit once and was taught to wait as Retry-After says; then the Phase 14 spec passed 5 of 5.
- **09:46–09:47**: the admin, Technical Analysis and Phase 7 specs again on the rebuilt stack: passed.
- **09:47–09:55**: `pnpm verify` on the final code: passed.

## Found by verification and fixed

| # | Found | Effect | Fix |
|---|---|---|---|
| 1 | The journal recorded what the engine read from the market, but not the pairs' order rules or the fees (the live replay) | A replay used today's rules and fees. On the stack, an order of 1.93 USDT, taken while BTC/USDT's minimum was still unknown, would be refused under today's 5 USDT minimum: the run from entry 1 differed at entry 3 | The broker journals the rules and fees with each `load`, and with the first entry after they change; the replay applies them. Unit and integration tests, and the live replay since entry 79 |
| 2 | The broker audited fills and its refusals, but not cancellations or resets (review, while writing the api) | A cancellation or reset was audited only as the user's request, not as done | `practice_order.cancelled` (with its cause: the user, a reset, the other half of a stop and target, or a market order's unfilled rest) and `practice_account.reset`, tested in the broker's integration tests |
| 3 | The answer to placing an order could reach the page after the channel had already said the order filled (the full end-to-end run, on a market sell) | The page put the filled order back under "Open practice orders" as "Submitted", until the next reload | The page keeps the newest copy of every order it has seen, finished ones included, and ignores an older one. A unit test sends the fill before the answer; the end-to-end run passed on the rebuilt stack |

The tests and tools needed these corrections. None is a product defect:
- The RBAC matrix now has more endpoints than one user's REST burst (60); its test clock moves 100 ms per call.
- The end-to-end spec waited for the account before using the ticket, and sizes its orders from a floor of 10 USDT, because the pair-status job may not have read a pair's minimum yet on a fresh stack.
- Files edited with Windows Python had CRLF line endings; they were converted back before anything ran.
- A Phase 8 analyzer test, the gold-market closing alert, failed on a Sunday. The SMC tests store the gold calendar for real weeks, so on a weekend the market was already closed when the test started, and no closing could be seen. The test now runs at a fixed Wednesday afternoon.
- Verify runs on this machine could not start test workers in time, or ran past Vitest's 5 s limit on the chart pages, while every package's suite ran at once beside the stack. The app's suite now uses at most four workers, allows 60 s a test, and waits up to 15 s for a page; nothing else changed.
- The broker's first test read the published events a moment before the broker sent them, which only the slower coverage run showed; it now waits for them.
- The broker's branch coverage was 63.5 %, under its 70 % gate. Two new tests cover the inputs that change nothing and a fee change in the middle of a run (75.1 %). The broker's 30 s settings refresh can be shortened in tests; the default is unchanged.
- The database package's own tests did not reach the trading helpers (functions 63.8 %, branches 65.7 %). `trading.int.test.ts` covers them, and which service may write what (99.1 % / 85.7 %).
- The pair-status job's test did not expect Coinbase BTC-USD among the changed pairs once its minimum order value became known; it does now.
- The smoke test's new check that the broker is "OK" also matched the cell "broker", because text matching ignores case; it now matches the badge exactly.
- Phase 8's end-to-end 8.1 waited for a "gold market closed" alert on a Sunday, while the gold market was already in its weekend closure, so no closing could be seen. The test now reads the gold calendar first, and in that case records the gold kind as not checked in that run (the analyzer's integration test checks it at a fixed weekday).

## Tests and coverage

2,034 automated tests, all passing: 1,512 unit, 503 integration and 19 end to end (Phase 8: 1,897).

- `pnpm verify` passes on the final code (2026-11-15, 09:47–09:55 UTC; and at 08:40–08:51, before the page fix): formatting, lint, typecheck, dependency rules, the no-trading check, unit tests with coverage gates, the build and the artefact scan. Turbo reused the cached results of packages unchanged since an earlier passing run.
- The integration suites of all seven packages that have them pass with coverage (the broker, the database and the ingestor at 08:32–08:40; the api, the analyzer, the jobs service and observability at 08:51–09:01).
- The end to end runs are under [Live](#live): all 19 tests passed on the final build, the Phase 8 gold kind recorded as not checkable on a Sunday.

As before, the integration figures count only integration tests: each package's integration run also repeats its unit tests.

| Package | Tests (unit + integration) | What is new in Phase 14 | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| paper-engine (new) | 34 | The fill engine: book walks with slippage, trades through the price, partial fills, stops and targets, fees, the venues' rules, refusals, resets and the ledger; property tests; journal replay, with its configuration | 90% | 99.7% / 92.1% |
| broker (new) | 3 + 11 | Market and limit fills, refusals, stops and targets, cancel and reset with their audit, inputs that change nothing, a fee change journalled, the lease handover with fencing, journal replay, and connections to the database and Valkey only | 70% | 87.5% / 75.1% |
| contracts | 72 (Phase 8: 66) | The practice schemas, `practice.own`, `ORDER_REFUSED`, the `practice` channel | 90% | 100% / 100% |
| alerts | 27 (24) | The two practice kinds, the owner-only match, late practice alerts | 90% | 98.7% / 94.4% |
| api | 19 + 386 (19 + 326) | Practice accounts, orders, refusals, idempotency, the rate limit, cancel and reset, positions and profit and loss, admin settings, the `practice` channel, the audit trail; ten routes in the RBAC matrix | 70% | 89.7% / 73.8% |
| analyzer | 5 + 24 (5 + 23) | Practice alerts from `practice:events` | 70% | 90.6% / 75.5% |
| db | 2 + 33 (2 + 28) | Migration 0012: the row mappings, balances per period, and each service's rights on `trading` | 70% | 99.1% / 85.7% |
| ingestor | 6 + 14 | The broker's trade stream, in the replay test | 70% | 92.3% / 80.9% |
| jobs | 19 + 31 | The minimum order value, in the pair-status test | 70% | 97.6% / 88.1% |
| app | 159 (150) | The Practice Trading page, its confirmation step, refusals, channel updates and resynchronisation, the setup prefill, cancel and reset, the admins' settings; "Practise this setup" | none yet | 78.8% / 67.4% |
| smc-engine, domain, indicators, market-data, exchange-adapters, observability, ui | 982, 31, 73, 40, 25, 11 + 4, 4 | Unchanged | as before | as before |
| End to end | 19 (14) | 14.1 (on the page, and on every pair), 14.6, 14.7 with 14.12, 14.9 | — | — |

## Decisions made during Phase 14

| Decision | Why | Recorded in |
|---|---|---|
| The api stores an order as `new` and the broker holds its balance when it takes it up | One writer of balances; the api's database role can write nothing but new or refused orders and starting balances (row-level security) | ADR 021; data model §10 note |
| The api checks an order the way the broker will, in the same order | A refusal says why at once, and gives the same reason either way | ADR 021 |
| Refusal reasons are ten, not five: the planned `venue_rule` is `price_step`, `quantity_step` and `min_value`, plus `no_market`, `not_practice_pair` and `too_many_open_orders` | The user sees exactly what to change | API contracts §7 note |
| Cancel and reset wait up to 2 s for the broker: `200` with the outcome, else `202` | The page usually gets the result in the answer; the channel brings it otherwise | API contracts note |
| `GET /practice/orders/{id}` added; `GET /practice/account` gives the venues' fees | The page shows one order, and estimates fees before the confirmation | API contracts note |
| Holdings by average cost; a sale's fee counts when it is sold | Simple, stated on the page, and it reconciles with the ledger | API contracts note |
| The broker journals its configuration when it changes | Criterion 14.3 holds after the pair-status job or an admin changes rules or fees (defect 1) | ADR 021 |
| A replay account exists for every user; the page shows only venues with pairs | The replay venue is for tests and demos | Data model §10 note |
| "Practise this setup" only for bullish setups, with levels rounded down to the price step | Practice trading is spot only (TRD-02); a price off the step would be refused | The setup page |
| The admins' settings are a card on the practice page | They belong with what they change; the api enforces `settings.manage` | The page |

## Carried forward

| Item | Plan |
|---|---|
| A fill's basis keeps the trade or the book levels it used, not the whole book | Enough for replays; a full book per fill would make the journal much larger |
| Phase 15 (exchange test networks) | Your decision after Phase 14, as proposal 001 says |
| From Phase 8: criterion 8.2 on macOS; `cargo fmt` and `cargo clippy` for the desktop crate | Unchanged |
| From earlier phases: the FRED key (7.3); rulebook notes I1–I38; the trend rule and volume threshold; D2 hosting | Unchanged |

## What I need from you

1. Your approval of this report, or what to change.
2. **Pushing**: Phases 7, 8 and 14 are committed on `phase-14/practice-trading`, one commit each, and not pushed. When you ask, I would push the branch and open the pull requests.
