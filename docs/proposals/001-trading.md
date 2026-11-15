# Proposal 001 · Buying and selling

| | |
|---|---|
| Status | **Approved 2026-11-13** with the recommended choice for each of T1–T7, and applied to REQUIREMENTS.md (revision 4) and the Phase 0 documents. Phase 14 (practice trading) was built on 2026-11-14 and 15 and waits for acceptance: see its [acceptance report](../phase-14/acceptance-report.md). Phase 15 is decided after it. |
| Date | 2026-11-13 |
| Changed | [REQUIREMENTS.md](../../REQUIREMENTS.md) (revision 4), the [requirements analysis](../phase-0/01-requirements-analysis.md), the [implementation plan](../phase-0/08-implementation-plan.md), the [architecture](../phase-0/03-architecture.md), the [risk register](../phase-0/04-risks-and-dependencies.md), the [data model](../phase-0/05-data-model.md) and the [API contracts](../phase-0/06-api-contracts.md) |
| Decisions | T1–T7, in [§8](#8-decisions-for-you) |

## 1. Why the platform doesn't trade today

The requirements rule it out in three places:

- §3.1: "The system must never place orders."
- §3.7: the position-size calculator is "Calculation only: nothing is linked to an exchange account and no orders are placed."
- §10: "Do not implement real-money trading in the initial release. SMC setups, hypothetical levels and the position-size calculator must not connect to any order-placement API."

The requirements analysis turned these into SEC-04, "No trading and no order placement anywhere", for every phase. It lists "Placing orders, exchange accounts, portfolios or anything that moves money" as out of scope. CI enforces it: `pnpm check:no-trading` fails the build if any code mentions an exchange's order, account or user-data endpoints, or the headers that sign private requests.

This proposal adds trading in stages, so each stage can be judged on what the one before it showed.

## 2. Summary

| Stage | What you get | Money | Exchange keys | When |
|---|---|---|---|---|
| **A. Practice trading** | Buy and sell every monitored pair with a practice balance. Orders fill against the live trades and order books the platform already receives. Positions, profit and loss, fees and history. | None: simulated | None | New **Phase 14**, built next if you approve it (T2) |
| **B. Exchange test networks** | The same screens, sending real orders to Binance's test exchange, paid for with test funds | None: test funds | Test-network keys only, kept on the server | New **Phase 15**, decided after Phase 14 is accepted (T5) |
| **C. Real money** | Orders on your real exchange accounts | Real | Trading keys, never withdrawal keys | Not in the initial release, as REQUIREMENTS §10 already says. Only once the conditions in [§6](#6-stage-c-real-money-not-in-the-initial-release) are met (T6) |

**Recommendation:** approve Stage A now and build it as the next phase. Decide on Stage B after you've used Stage A. Keep Stage C out of the initial release.

**Numbering.** The new phases are numbered 14 and 15, so nothing already written has to be renumbered: "Phase 9" still means AI intelligence. The order of work would become 8 → 14 → 9 → 10 → 11 → 12 → 15 (if approved) → 13. Phase 13 stays last so that its security review, load test and soak test cover trading too.

## 3. Rules that hold in every stage

These keep the platform a tool for analysis and education, even with order screens.

1. **A person places every order.** One order at a time, from the order ticket, after a confirmation step. A protective stop or target that the person attaches to their order is part of that order; the platform only carries it out. *Amended 2026-11-15 by [proposal 002](002-automatic-practice-trading.md): a person places every manual order; automatic practice orders follow a user's own rules, switched on by them.*
2. **Nothing trades automatically.** Setups, alerts, the AI and scheduled jobs never place, change or cancel an order. A setup can fill in the ticket, and the person reviews and submits it. There is no "auto-trade", no copy trading and no strategy that runs by itself. *Amended 2026-11-15 by [proposal 002](002-automatic-practice-trading.md): nothing trades automatically except a user's own automatic practice trading, under their rules and limits, on practice balances only. No copy trading, and the AI never decides an order.*
3. **The AI stays out of orders.** The order ticket never opens from an AI analysis. The AI never sees anyone's orders or balances, and never suggests an order.
4. **Analysis stays educational.** "Educational analysis — not financial advice" stays wherever setup levels appear. Practice and test results are labelled as such, and never presented as expected performance.
5. **Money never moves.** No deposits, withdrawals or transfers, in any stage. Keys that allow withdrawals are refused.
6. **Spot only.** Buy with cash, sell what you hold. No margin, leverage, futures or short selling.
7. **Exchange secrets stay on the server.** They are stored encrypted, never sent to the web or desktop app, and never logged (§10, unchanged).
8. **Every order action is audited** in the existing hash-chained audit log: orders placed, cancelled, refused or filled, account resets, and (from Stage B) key and limit changes.
9. **Never guess a price.** When a pair's data is delayed or has a gap, or the pair is halted, new orders on it are refused with the reason. This follows the architecture's "fail visibly" principle.

## 4. Stage A: practice trading (Phase 14)

### 4.1 What users see

- A new **Practice Trading** page in the web and desktop apps: an order ticket, open orders, positions, balances, order and fill history, and profit and loss after fees.
- A banner on every practice screen: **"Practice trading: simulated orders, no real money."** Practice screens use their own accent colour, so they can't be mistaken for anything real.
- Each user has their own practice account, with a separate balance per venue, because a Binance balance can't pay for a Coinbase order:
  - Binance: 10,000 USDT to start (T4);
  - Coinbase: 10,000 USD to start.
  - Users can reset their account to the starting balances. A reset is audited, and the history before it stays visible, marked with the reset.
- Orders on every monitored pair, which today means BTC, ETH, SOL and PAXG on both venues:
  - **market** and **limit** orders, to buy or sell, and cancelling an open order;
  - an optional **protective stop** and **target** attached to a buy; when one fills, the other is cancelled.
- On a setup's detail page, **Practise this setup** opens the ticket filled in with the setup's entry, its invalidation level as the stop, its target, and the size from the position-size calculator. The user reviews it and submits it, or not.
- PAXG stays labelled "PAXG (gold-backed token)". Orders placed while the gold market is closed say so on the ticket and in the history.
- Two new alert kinds in the Alert Center (T7): **practice order filled**, and **practice stop or target reached**. They use the Phase 8 inbox and notifications.

### 4.2 How fills are simulated

The platform already receives every trade and the order book for each pair. The practice engine fills orders from that data, conservatively, and stores what each fill was based on.

| Order | Fills when | Price and quantity | Fee |
|---|---|---|---|
| Market | Immediately, if the order book is fresh | Walks the venue's book level by level, so a large order pays slippage. Anything the book can't fill is cancelled, as on the venues. | Taker |
| Limit that can fill immediately | Immediately | Walks the book up to the limit price; the rest waits as a limit order | Taker for the immediate part |
| Limit, waiting | A venue trade prints **through** the limit price, at a strictly better price. A waiting order isn't assumed to be first in the queue. | The limit price, up to the quantity traded through it, so partial fills happen | Maker |
| Protective stop | A venue trade prints at or through the stop price | Then fills like a market order, with slippage | Taker |
| Target | Like a waiting limit order | Like a waiting limit order | Maker |

- **Fees:** each venue's published base-tier fees, kept in settings that an admin can change, and stored with every fill.
- **Venue order rules:** orders must respect the pair's price step and quantity step, which the venue adapters already read from Binance `exchangeInfo` and Coinbase `products`, and its minimum order value, which would be read the same way.
- **Determinism:** fills depend only on the recorded market data and the orders. Replaying both gives exactly the same fills, so tests run on the replay venue with known answers.
- **What a simulation can't show,** stated in the app and the docs: a real order moves the market and waits in a queue, and a practice order does neither. Fills on thin books are less certain (Coinbase PAXG in particular), so those fills are flagged "thin book". Practice results are a rough guide to execution, not proof of what real trading would have returned.

### 4.3 Changes to the architecture

ADR 021 would settle the detailed design at the start of Phase 14. In outline:

- **`packages/paper-engine`**, a new pure package: order validation, the fill rules, fees and the balance ledger. Like the SMC engine, it does no I/O, so it is tested with fixtures and property tests.
- **`apps/broker`**, a new service in the same server image: the only service that handles orders. One active instance holds a lease, with a warm standby, like the ingestor. It reads the latest order book that the ingestor already keeps (`book:{id}`), and a new capped stream of live trades from the ingestor (`md:trades:{instrumentId}`). It never contacts a venue in Stage A.
- **Orders:** the api validates an order, then records it and reserves its balance in one database transaction. The client's idempotency key means a retried submission can't create a second order. The broker fills orders and settles the balances.
- **Data:** a new `trading` schema: practice accounts and their per-venue balances, orders, fills (each with the trades or book snapshot it was based on), and a ledger of balance changes. Balances are sums of ledger entries, so they can always be checked against fills and fees. The broker gets its own least-privilege database role.
- **API:** `/api/v1/practice/...` endpoints for the account, orders, cancelling, fills, positions and resets, and a per-user `practice` WebSocket channel, durable and resynchronised after reconnecting, like `alerts`.
- **Authorization:** every role can trade on their own practice account (T3). Nobody can see or change anyone else's, admins included. Admins can change the fee settings and the default starting balances.
- **No-trading check:** unchanged. Stage A never mentions an exchange's private endpoints.

### 4.4 Requirement changes (revision 4)

| Where | Today | Proposed |
|---|---|---|
| §3.1 | "The system must never place orders." | "The system never places orders by itself, and no order reaches an exchange. Users can place practice orders, which are simulated inside the platform (§11). A person places every order." |
| §3.7 | "Calculation only: nothing is linked to an exchange account and no orders are placed." | "The calculator never connects to an exchange account. It can fill in a practice order ticket, which the user reviews and submits." |
| §10 | "… SMC setups, hypothetical levels and the position-size calculator must not connect to any order-placement API." | "… must not connect to any exchange's order-placement API. They may fill in a practice order ticket, which a person submits." The first sentence, "Do not implement real-money trading in the initial release", stays. |
| New §11 | — | **Practice trading**, with TRD-01 to TRD-08 below |
| Final acceptance criteria | — | Add: "Let users practise buying and selling with simulated orders filled from live market data, clearly labelled as simulated, without any exchange connection." |

In the requirements analysis:

- SEC-04 "No trading and no order placement anywhere" becomes "No real-money trading; no order reaches an exchange; no deposits, withdrawals or transfers".
- The out-of-scope item "Placing orders, exchange accounts, portfolios or anything that moves money" becomes "Real-money orders, exchange accounts, or anything that moves money. Simulated practice trading is in scope (§11)".
- "Strategy backtesting with profit and loss, fees or slippage" stays out of scope. Practice trading only moves forward in time, and setup outcomes stay in R multiples.
- Risk R12's mitigation "no execution features" becomes "no real-money execution; practice trading labelled as simulated; nothing trades automatically".

New requirements:

| ID | Requirement | Phase |
|---|---|---|
| TRD-01 | A practice account per user, with a balance per venue, configurable starting balances and an audited reset | 14 |
| TRD-02 | Spot market and limit orders to buy and sell on every monitored pair; cancelling; an optional protective stop and target that cancel each other | 14 |
| TRD-03 | Fills simulated from the venues' live trades and order books: slippage from walking the book, limits filled only by trades through the price, partial fills, fees and the venues' order rules. Deterministic and replayable. | 14 |
| TRD-04 | Balances, positions, realised and unrealised profit and loss, fees, and order and fill history, from a ledger that always reconciles | 14 |
| TRD-05 | A person places every order. Setups and the position-size calculator may fill in the ticket. Nothing places orders automatically. | 14 |
| TRD-06 | Every practice screen and result is labelled as simulated; results are never presented as expected performance | 14 |
| TRD-07 | Orders are refused when the pair's data is delayed or has a gap, or the pair is halted | 14 |
| TRD-08 | Each user reaches only their own practice account; every order action is audited; practice alerts go through the alert pipeline | 14 |
| NFR-16 | A market order's fill is published p95 ≤ 1 s after it is submitted; a waiting order's fill p95 ≤ 1 s after the trade that fills it | 14 |

### 4.5 Phase 14 in the implementation plan

**Scope:** the paper engine and the broker service, the live trade stream, the `trading` schema, the practice API and WebSocket channel, the Practice Trading page and order ticket, "Practise this setup", the two practice alert kinds, and ADR 021.

| # | Criterion | Covers |
|---|---|---|
| 14.1 | On every monitored pair, a user buys and sells with market and limit orders, cancels an open order, and sees balances, positions and profit and loss update, in the web and desktop apps | TRD-01, TRD-02, TRD-04 |
| 14.2 | Fills match hand-computed fixtures on recorded books and trades: slippage from walking the book, fees, waiting limits filled only by trades through the price, partial fills, a protective stop triggering, and a stop and target cancelling each other | TRD-03 |
| 14.3 | Replaying the same recorded market data and orders gives identical fills (digest) | TRD-03, NFR-14 |
| 14.4 | A property test over random order sequences: the ledger always reconciles with fills and fees, no balance goes negative, and a retried submission never creates a second order | TRD-04 |
| 14.5 | Orders are refused, with the reason, when the pair's data is delayed or has a gap, or the pair is halted. Orders that break the venue's price step, quantity step or minimum order value are refused. | TRD-07 |
| 14.6 | "Practise this setup" fills in the ticket with the setup's levels and the calculator's size, and nothing is submitted until the user submits it (end-to-end test). A dependency rule shows that no code in setups, alerts, the AI or jobs can create an order. | TRD-05 |
| 14.7 | An automated scan finds the practice banner on every practice screen, and every result is labelled as simulated | TRD-06 |
| 14.8 | The RBAC matrix test covers the new endpoints, and each role reaches only its own account. Orders placed, cancelled, refused and filled, and account resets, are audited, and the hash chain verifies. | TRD-08, SEC-02 |
| 14.9 | Practice fills arrive as alerts, in the inbox and as native notifications. After a disconnect, open orders and balances are resynchronised from the backend. | TRD-08, WD-01 |
| 14.10 | `pnpm check:no-trading` passes unchanged, and a test shows the broker opens no connection to any venue | SEC-04 |
| 14.11 | NFR-16 is measured and met | NFR-16 |
| 14.12 | axe finds no serious violations on the new page, and keyboard navigation works, including the confirmation step | NFR-10 |

Relative size: L, like Phases 6 and 7.

## 5. Stage B: exchange test networks (Phase 15, decided later)

Stage B proves the real order path with funds that are worth nothing: signed requests, the venue's own order rules and matching, partial fills, cancels, rate limits, reconnects and reconciliation.

### 5.1 What exists

Checked on 2026-11-13, from the venues' public documentation and their public read-only endpoints, without any key:

| Venue | Test environment | Fit |
|---|---|---|
| Binance | **Spot Test Network** (`testnet.binance.vision`). Its own matching engine and virtual funds; keys are created on the test network's own site. It lists all four of our Binance pairs (BTCUSDT, ETHUSDT, SOLUSDT, PAXGUSDT) as trading, with market, limit, stop-loss and take-profit orders. It is reset to a blank state about once a month, without notice, and keys survive resets. Its prices and order books are independent of the live exchange. | **Good** for testing the order path. Its prices differ from the live charts, so the ticket must show the test network's own price. |
| Binance | **Demo Mode** (`demo-api.binance.com`). Prices and order books "similar to" the live exchange, the same order rules, and a balance reset at any time. Keys are created by signing in to a real Binance account. | Closer to live prices, but it needs a real Binance account, so that account's terms come into scope. |
| Coinbase | **Advanced Trade sandbox** (`api-sandbox.coinbase.com`). Its documentation says "All responses are static and pre-defined." | Useful for checking request and response formats only. It can't test an order from start to finish. |
| Coinbase | **Exchange sandbox** (`api-public.sandbox.exchange.coinbase.com`). A matching engine for Coinbase Exchange, Coinbase's institutional API, which isn't the API a retail Coinbase account trades through. It lists 13 products: BTC-USD and USDT-USD, but not ETH-USD, SOL-USD or PAXG-USD. | Weak: few of our pairs, and the wrong API for a retail account. |

So Stage B would start with Binance's Spot Test Network only. Coinbase would be checked against its static sandbox for formats, and tested end to end only once it offers a suitable test environment.

### 5.2 Scope, if approved

- **Keys, kept on the server.** The server creates an Ed25519 key pair for each user and shows only the public half. The user registers it on the test network and enters the API key they get back in the app. The private key never leaves the server. Both are stored encrypted, with the encryption key held outside the database, and no endpoint ever returns them.
- **Test hosts only.** The broker refuses to start, or to send a request, unless the venue address is on a fixed list of test hosts. The CI check is narrowed rather than removed: order and account endpoints may appear only in the broker's test-network adapter, production order endpoints stay forbidden everywhere, and test hosts may not appear anywhere else.
- **Order handling:** an order state machine, idempotent client order ids, fills from the venue's user-data stream, and reconciliation against REST after any disconnect. The existing rate-limit budgeter covers order requests too.
- **Limits, checked on the server before an order leaves:** a maximum order value, a maximum number of open orders and a daily loss limit. An admin kill switch cancels every open order and blocks new ones.
- **Confirmation:** the ticket shows the venue, side, quantity, price, estimated cost and fees before the order is sent.
- **Labelling:** a "Test network: test funds" banner, different from the practice banner.
- **Venue resets:** when the test network resets, the platform notices the missing orders and balances, marks open orders "reset by the venue", and tells the user.

Requirement changes: §3.1 adds "and orders on exchange test networks, which use test funds"; §10 adds "Exchange test-network keys are created and stored on the server only, encrypted, and never returned to a client"; assumption A3 becomes "no production exchange keys"; SEC-04 becomes "no order reaches a production exchange". New requirements TRD-09 onwards cover the points above.

### 5.3 Phase 15 criteria (draft, finalised if Stage B is approved)

| # | Criterion |
|---|---|
| 15.1 | An order goes through its whole life on Binance's Spot Test Network (placed, partly filled, filled, cancelled), and the platform's state equals the venue's after each step |
| 15.2 | A retried submission never creates a second order. After a network cut in the middle of an order, state is reconciled within 10 s of reconnecting, with no duplicate or lost order (chaos test). |
| 15.3 | Scans find no key in logs, bundles or images; no endpoint returns one; keys are stored encrypted; the private key never leaves the server |
| 15.4 | The broker refuses production hosts (startup and runtime tests). The CI check fails on a production order endpoint anywhere, and on any order endpoint outside the broker's test-network adapter. |
| 15.5 | An order over a limit is refused before it leaves. The kill switch cancels every open test order and blocks new ones within 5 s. |
| 15.6 | A burst of orders stays within the venue's rate limits |
| 15.7 | Every order request, venue response and state change is audited |

Relative size: L.

## 6. Stage C: real money (not in the initial release)

REQUIREMENTS §10 keeps real-money trading out of the initial release, and this proposal doesn't change that. If you want it afterwards, it should be a proposal of its own, and start only when all of these are true:

1. The initial release (Phase 13) is accepted.
2. A qualified lawyer has reviewed it, in writing, for your jurisdiction and your users. Placing orders for other people, even with their own keys, can be a regulated activity, and each exchange's terms apply. Engineering work can't settle this.
3. Stage B has run for an agreed period with no unexplained difference between the platform's records and the venue's.
4. An independent security test of the trading path has passed, and keys are kept in a managed key service (a KMS or HSM).
5. Each exchange key is restricted at the exchange: trading only, never withdrawals, and usable only from the server's IP address.
6. Hard limits per user (order value, daily loss, open positions), a confirmation for every order, a kill switch and an incident runbook are in place.
7. Each user explicitly accepts the risks before trading is turned on for them.

## 7. New risks

| ID | Risk | L | I | Mitigation | Stage |
|---|---|---|---|---|---|
| R31 | Practice results are taken as proof that a setup or a strategy works | M | H | Banners; "simulated" on every result; no leaderboards or performance claims; setup statistics stay "historical observations" (Phase 12) | A |
| R32 | Simulated fills are better than real fills would be: no market impact, no queue, thin PAXG books | H | M | Limits fill only on trades through the price; partial fills capped by the traded quantity; slippage from the book; a "thin book" flag; the limits stated in the app | A |
| R33 | Order screens next to the analysis turn the platform into a signal service | M | H | The rules in §3: a person places every order, nothing automatic, the AI kept out; a dependency rule (14.6) | A–C |
| R34 | A test-network key leaks, or some code path reaches a production exchange | L | H | Keys created and kept on the server, encrypted; host allow-list; the narrowed CI check; one isolated broker service | B |
| R35 | The platform's order state drifts from the venue's (lost acknowledgements, reconnects) | M | M | Idempotent client order ids; user-data stream plus REST reconciliation; chaos tests | B |
| R36 | Test-network resets, about monthly and without notice, wipe orders and balances | H | L | Detect resets, mark the affected orders, tell the user | B |
| R37 | Real money: financial loss from a bug, and regulatory exposure | — | H | Not in the initial release; the conditions in §6 | C |

The dependency register would gain the Binance Spot Test Network (free; its terms of use to be read before Phase 15) and the Coinbase Advanced Trade sandbox (free; static responses).

## 8. Decisions for you

All seven were approved as recommended on 2026-11-13.

| # | Decision | Recommendation |
|---|---|---|
| T1 | Add Stage A, practice trading, with the requirement changes in §4.4 | Yes |
| T2 | When to build Phase 14 | Next, once Phase 8 is accepted. It builds only on finished phases (market data, setups and alerts), and adds to them without changing how they work. The alternative is after Phase 12. |
| T3 | Who can practise | Every role (viewer, analyst and admin), each on their own account |
| T4 | Starting balances | 10,000 USDT on Binance and 10,000 USD on Coinbase for each user. Admins can change the defaults, and users can reset their own account. |
| T5 | Stage B, exchange test networks | Decide after Phase 14 is accepted. If yes, Binance's Spot Test Network first, and Coinbase format checks only. |
| T6 | Stage C, real money | Keep it out of the initial release (REQUIREMENTS §10 unchanged). Revisit only with the conditions in §6. |
| T7 | Practice alerts | Yes: two new alert kinds, "practice order filled" and "practice stop or target reached" |

## 9. What happens when you approve

1. Done on 2026-11-13: REQUIREMENTS.md is at revision 4, and the Phase 0 documents listed at the top are updated.
2. Phase 14 starts when you say "Start Phase 14", after Phase 8 is accepted. It begins with ADR 021 (the fill model and the broker service), and ends with an acceptance report like every other phase.
