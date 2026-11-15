# ADR 021: Practice trading: a pure fill engine, one broker service, and only the platform's own data

- Status: accepted (Phase 14)
- Date: 2026-11-14
- Context:
  - [REQUIREMENTS §11](../../REQUIREMENTS.md), revision 4, and [proposal 001](../proposals/001-trading.md);
  - [architecture §21](../phase-0/03-architecture.md#21-practice-trading-phase-14), [data model §10](../phase-0/05-data-model.md#10-trading-practice-trading-phase-14), [API contracts](../phase-0/06-api-contracts.md) (practice routes);
  - implementation plan Phase 14 (criteria 14.1–14.12).

## Context

Users practise buying and selling with practice balances: market and limit orders, a protective stop and a target on a buy, positions, profit and loss, fees and history.

Requirements:
- Orders fill from the venues' live trades and order books, conservatively.
- Orders are refused when a pair's data is delayed, has a gap, or the pair is halted.
- Fills are deterministic and replayable.
- Nothing ever contacts a venue.
- A person places every order, and nothing trades automatically.
- Every screen and result is labelled as simulated.
- Each user reaches only their own account, and every order action is audited.

What the platform has today:
- **Trades**: every live trade passes one hook in the ingestor (`InstrumentPipeline.onTrade`), but none reaches Valkey. Raw trades go to PostgreSQL in batches, and only where `store_raw_trades` is set.
- **Books**: the ingestor keeps the latest book in `book:{instrumentId}`: up to 50 levels a side, rewritten every second while the book is live, 30 s TTL. Its `ts` is the local write time, so it does not tell freshness.
- **Health**:
  - feed health per stream is in `feed:status:{venue}`: `connected`, `degraded` (silent, or delayed: median lag above 2 s), `disconnected`;
  - gaps are in `market.data_gaps` (open while `open` or `backfilling`);
  - halts and delistings are in `market.instruments.venue_status`.
- **Order rules**: price steps and quantity steps are stored; minimum order values are not.

## Decision

### A pure engine: `packages/paper-engine`

A deterministic reducer, with no I/O and depending only on `contracts` and `domain` (a dependency rule enforces it). It holds:
- each practice account's available balances;
- the live orders.

It turns each input into order changes, fills and ledger entries. The inputs are:
- `place`: an order the api accepted, with its attached stop and target;
- `cancel`;
- `reset`: a new period with the starting balances;
- `trade`: one live trade, with the book when a stop may need it.

**Fill rules**, conservative by design:

| Order | Fills when | Price and quantity | Fee |
|---|---|---|---|
| Market | At once | Walks the book level by level, so a large order pays slippage. What the book (its 50 levels) cannot fill is cancelled, as on the venues | Taker |
| Limit, marketable | At once | Walks the book up to the limit; the rest rests | Taker |
| Limit, resting | A later trade prints **strictly through** the limit | The limit price, up to the traded quantity. Each side of a trade is shared between resting orders by price, then time | Maker |
| Stop (a sell) | A trade prints at or through the stop | Walks the bids like a market sell. With no book it waits for the next trade | Taker |
| Target (a sell limit) | As a resting sell limit | As a resting sell limit | Maker |

**Balances**:
- A limit buy holds `quantity × limit × (1 + the higher fee)`, and a sell holds its base. A fill releases what it used, so available balances never go negative (a property test).
- Amounts are exact decimals: there is no rounding to drift.
- The available balance is the sum of the account's ledger entries for the current period.
- Fees are charged in the quote asset, at per-venue maker and taker rates kept in settings.

**Stop and target**:
- They arm when their buy fills, for what it filled.
- They hold that base once between them.
- As on Binance, either one filling, even in part, cancels the other.
- A buy cancelled before any fill takes them with it; after a fill, they stay to protect what it bought.
- Cancelling either one cancels both.

**Order rules**:
- The price step, the quantity step and the minimum order value: quantity × the limit, or × the best opposite price for a market order.
- The minimum is a new column, `market.instruments.min_notional`. The pair-status job reads it from Binance's `NOTIONAL` / `MIN_NOTIONAL` filters and Coinbase's `min_market_funds`. Until it is known it is 0, and no minimum applies.

**Health (TRD-07)**:
- A pure function maps an instrument's state to `ok`, `pair_halted`, `data_gap` or `data_delayed`. Its inputs are its venue status, whether it is enabled, its feed entries and its open gaps.
- New orders are refused with the reason. Nothing fills while the health is not `ok`.
- Trades that a backfill recovers later never fill orders: only live trades do.

**Flags**:
- `thin_book` when a taker fill takes more than a fifth of the quantity the book shows within 0.5 % of its best price, or empties it.
- `underlying_closed` on PAXG orders placed while the gold market is closed.

**Determinism**:
- Fill ids come from the order id and the fill's number.
- Trades are ordered by their Valkey stream id. A trade at or before the position the broker had read when the order was accepted never fills it.
- `fillDigestLine` gives each fill's line of a digest. The same inputs give the same digest (a property test), and a replay of the journal must reproduce it (criterion 14.3).

### One broker service: `apps/broker`

It is the only writer of fills and balances, and it has no venue client.

**Lease**:
- One active instance holds `lease:broker`, with a fencing epoch; a standby waits.
- The analyzer's lease class moves to `@cip/observability` so both can use it, since apps must not import each other.
- Every transaction checks the epoch against `trading.broker_state`, so a former holder cannot write.

**Inputs**:
- `practice:commands`: place, cancel and reset, appended by the api after it stores the order or request.
- `md:trades:{instrumentId}`: a new stream the ingestor appends to from `onTrade`, for enabled monitored pairs, capped at about 20,000 entries each. Fields: `id`, `ts`, `price`, `qty`, `side`.
- The book is read from `book:{id}` when an order needs it: a market order, a limit order that may trade at once, or a trade that may trigger a stop.
- Instrument health is refreshed every second from `feed:status:{venue}`, the open gaps and the instruments' status.

**Each input that changes anything** is written in one transaction:
- the orders, fills and ledger entries;
- the input itself in `trading.journal`, with the book it used, and the pairs' order rules and the fees whenever they changed since the last entry (and always with a `load`), so a replay uses what the live engine used even after the pair-status job or an admin changed them;
- the stream cursor;
- the audit rows for fills, refusals, cancellations and resets.

After the commit, the broker appends the owner's updates to `practice:events`. The stream cursors are stored with the outputs, so a restarted or new holder resumes where the old one stopped. A trade read twice changes nothing.

**On taking the lease**, it loads the accounts (sums of their ledger for the current period) and the live orders.

**Settings**: it reads the fees and starting balances from `app.settings` (key `practice`), and the instruments' order rules, every 30 seconds.

**Replay** (criterion 14.3): `node apps/broker/dist/cli.js replay` feeds each run of the journal (from a `load` entry) to a fresh engine with the configuration it journalled, and compares every fill's digest line with what was stored. It is read-only.

### The api

**Routes** (`/api/v1/practice/...`): accounts, orders, cancel, fills, positions, reset.
- A new capability, `practice.own`, which every role has.
- Each user reaches only their own account; nobody, admins included, reads another's.

**Accounts**: created on first use, one per venue, with `start` ledger entries from the settings.

**Placing an order**:
1. The api checks the instrument (an enabled, monitored pair), the health, the venue's order rules and the available balance. For a market buy, the balance check uses the current book.
2. A refusal is stored as a `refused` order, audited, and answered `422 ORDER_REFUSED` with the reason.
3. Otherwise the order and its stop and target are stored as `new`, audited, and appended to `practice:commands`. The api answers `201`; the outcome arrives on the user's `practice` channel within about a second (NFR-16).

**Idempotency**: a retried submission with the same `clientOrderId` returns the stored order (`UNIQUE (account_id, client_order_id)`).

**Cancel and reset** are commands too. The api waits up to 2 seconds for the broker: `200` with the outcome, or `202` with the order or account as it is.

**Settings**: `GET` and `PUT /admin/settings/practice` (`settings.manage`, audited) hold the fees and starting balances.

**Database grants** keep the roles apart:
- only `svc_api` inserts orders and accounts;
- only `svc_broker` writes fills, ledger entries beyond the starting balances, and order status;
- the analyzer and jobs services cannot write to `trading` at all.

### The `practice` channel and alerts

**The channel**: the gateway's per-user channel (`alerts`, ADR 020) becomes a small table of per-user channels. `practice` reads `practice:events` and replays what a reconnecting client missed. Its snapshot holds the accounts and the open orders.

**The two alert kinds** are `practice_order_filled` and `practice_exit` (stop or target).
- The analyzer's alert service, which holds `lease:analyzer:alerts`, reads `practice:events` from its own cursor, as it reads `md:events`.
- It turns order updates into sources: a market or limit order that ended with fills, and a stop's or target's first sale.
- The evaluator matches them against the order owner's rules only.
- The rule test builds the same sources from stored orders.

### Nothing trades automatically (TRD-05)

Three layers:
- **The database**: only the api's role may insert orders.
- **Dependency rules**: the command stream's name lives in its own contracts module. Only the api's practice module and the broker may import it, so setups, alerts, the AI and jobs cannot place orders.
- **"Practise this setup"** only fills in the ticket. The user submits it after a confirmation step. It is offered on bullish setups only: practice trading is spot, and has no short sales.

## Consequences

- **Simulated fills are a rough guide.**
  - No market impact, no queue position, and the book is the one-second snapshot of 50 levels.
  - Limits fill only on trades through their price, which errs on the side of not filling.
  - The app and the docs say so.
- **Load:**
  - Valkey takes one more stream append per trade of each monitored pair.
  - The broker reads those streams and touches the database only when something changes.
- **New moving parts:** a service, a database role and the `trading` schema.
  - The system health page counts the broker, and the Docker stack runs it.
  - Valkey still has no per-service users: that is Phase 13's.
- **Stops and targets protect what their buy filled while they were live.** If a target sells out, a later fill of the same buy is not covered. This is noted in the app.
- **`check:no-trading` is unchanged**, and the broker's package depends on no venue adapter (a dependency rule).
