# Proposal 002 · Automatic practice trading

| | |
|---|---|
| Status | **Approved 2026-11-15** with the recommended choice for each of A1–A9, and applied to REQUIREMENTS.md (revision 5) and the Phase 0 documents. Nothing is built: Phase 16 starts after Phase 14 is accepted, when you say "Start Phase 16". |
| Date | 2026-11-15 |
| Changed | [REQUIREMENTS.md](../../REQUIREMENTS.md) (revision 5), the [requirements analysis](../phase-0/01-requirements-analysis.md), the [implementation plan](../phase-0/08-implementation-plan.md), the [architecture](../phase-0/03-architecture.md), the [risk register](../phase-0/04-risks-and-dependencies.md), the [data model](../phase-0/05-data-model.md), the [API contracts](../phase-0/06-api-contracts.md) and [proposal 001](001-trading.md)'s rules 1 and 2 |
| Decisions | A1–A9, in [§9](#9-decisions-for-you) |

## 1. What you asked for

On 2026-11-15 you asked for buying and selling to happen automatically, without you: the platform reads the patterns it detects, and buys and sells by itself.

Today it can't, by design. On 2026-11-13 you approved [proposal 001](001-trading.md), which says:

- **A person places every order** (TRD-05, and proposal 001's rule 1).
- **Nothing trades automatically**: setups, alerts, the AI and scheduled jobs never place, change or cancel an order (rule 2). A dependency rule checks it (criterion 14.6).
- **The AI stays out of orders** (rule 3).
- **No real money in the initial release** (REQUIREMENTS §10, unchanged since the first version).

This proposal changes the first two, for **practice balances only**. The third and the fourth stay.

## 2. Summary

| | Proposed |
|---|---|
| **What** | An automatic trader for each user who switches it on. When a setup the platform detects is confirmed and matches that user's rules, it places a practice buy with a protective stop and a target. It cancels the buy if the setup expires or fails before the buy fills. |
| **Money** | Practice balances only. Simulated, like every practice order. No exchange, no real money. |
| **Who decides** | The rules you set: patterns, pairs, minimum checklist score, minimum reward for the risk, risk per trade, and limits. Nothing else: not the AI, not an indicator on its own. |
| **Control** | Off until you switch it on. Limits on open trades, orders per day and daily loss. A stop button that cancels its open orders at once. |
| **Visibility** | Every automatic order is labelled "Automatic", audited with the setup and rules that caused it, and raises an alert. Every setup it looked at is logged: traded, or skipped and why. |
| **When** | A new **Phase 16**, after Phase 14 is accepted (A8) |

**Recommendation:** approve it for practice balances, with the defaults in §9. Keep real money out, as now.

## 3. What the platform's data shows so far

From the live analysis runs, for setups decided between 1 and 15 November 2026:

- **3,700 bullish setups** formed; **48** reached "confirmed": 33 "sweep outside, fill inside", 9 "double liquidity trap" and 6 "higher-timeframe order block".
- Of those 48, **40 expired before their entry price was touched**: a limit buy at the entry would not have filled. **8 were entered, and all 8 reached target 1**. Their target 1 was, on average, 0.8 times the risk: closer than the stop.
- With the recommended defaults (a checklist score of at least 70, and target 1 at least twice the risk), **6 of the 48 qualified, and all 6 expired before their entry was touched**. Over these two weeks, the automatic trader would have placed six buys and filled none.

These are historical observations from a short period, not a forecast. They are far too few to say whether trading the setups automatically would gain or lose; that is what running it on practice balances would show. They also say that strict rules may trade rarely, and loose rules take setups whose reward is smaller than their risk.

## 4. How it would work

### 4.1 Your rules

On the Practice Trading page, a new card, **"Automatic trading (simulated)"**, holds one set of rules per user:

| Rule | Recommended default | Choices |
|---|---|---|
| Switched on | Off | On or off, with a confirmation |
| Account | Binance | Binance or Coinbase practice account |
| Pairs | Every monitored pair on that venue | Any of them |
| Patterns | All four | Any of: double liquidity trap (A and B), equal levels near a POI, higher-timeframe order block, sweep outside fill inside |
| Minimum checklist score | 70 | 0–100 (the setup's confluence score) |
| Minimum reward for the risk | 2.0 at target 1 | 0.5–10. The checklist's own risk-reward item asks for 2.0 |
| Risk per trade | 1 % of the account's balance | 0.1–2 % (the calculator suggests 0.5–1 %) |
| Most open automatic trades | 3, and one per pair | 1–10 |
| Most automatic orders a day | 10 | 1–50 |
| Daily loss limit | 3 % of the period's starting balance | 1–10 %. When reached, it pauses until 00:00 UTC |

### 4.2 What it does

1. **It reads** every setup transition the analysis publishes (the same stream the Setup Scanner and alerts use).
2. **When a bullish setup is confirmed** and matches the rules, it checks the limits, then sizes the trade with the position-size calculator at the risk per trade, rounded down to the pair's quantity step.
3. **It places a practice limit buy** at the setup's entry (rounded down to the price step), with a **protective stop** at the invalidation and a **target** at target 1. The stop and target cancel each other, as in Phase 14.
4. **It cancels the buy** if the setup expires or is invalidated before the buy fills. Once the buy has filled, only the stop or the target closes the trade.
5. **It records every decision**: "placed", or "skipped" with the reason (score too low, reward too small, limit reached, data delayed, balance too low).

Bearish setups are skipped: practice trading is spot only, so it can't sell short.

The order goes through the same checks as one you place yourself: the pair's live data, the venue's price step, quantity step and minimum order value, and the balance with fees. The broker fills it from the live market in the same way.

### 4.3 Where it runs

**Recommended: inside the broker service**, as a pure "auto-trader" part of the practice engine.

- The broker already reads its inputs in one ordered sequence (orders and live trades); the setup transitions become a third input.
- Every decision is then journalled with everything it read, so a replay gives the same decisions and the same fills, as criterion 14.3 already checks for fills.
- No new service. The broker's database role gains one right: to insert practice orders marked automatic, for users whose automatic trading is switched on (a database policy enforces it).
- The alternative, a separate auto-trader service, is in ADR 022, to be written at the start of the phase.

The dependency rule from criterion 14.6 stays: setups, alerts, the AI and scheduled jobs still can't create orders. The broker remains the only place that does it automatically.

### 4.4 What you see

- The **"Automatic trading (simulated)" card**: the switch, the rules, today's orders and result against the daily limit, and the decision log.
- A **"Stop automatic trading"** button: it switches the trader off and cancels its open orders within 5 seconds.
- **"Automatic"** on every automatic order in the open orders and the history, with a link to its setup.
- **Alerts**: two new alert kinds, "automatic order placed" and "automatic trading paused". The Phase 14 practice alerts cover its fills.
- Every result labelled as simulated, as now.

## 5. What stays forbidden

| | Why |
|---|---|
| **Real money** | REQUIREMENTS §10: no real-money trading in the initial release. Proposal 001's stage C conditions (legal review, test-network history, security test, limits, user consent) would all still apply, and automatic real-money trading would need a proposal of its own. |
| **The AI deciding trades** | The AI's analysis is an opinion. It can't be replayed or tested the same way twice, and it must never be presented as a guaranteed prediction. Rules on the pattern engine's output can be tested and replayed exactly. Once Phase 9 adds the AI, it may explain a trade afterwards, never make one. |
| **Short selling, margin, leverage** | Spot only (proposal 001, rule 6) |
| **Trading for other users** | Each user's rules trade only their own practice account. Nobody, admins included, can switch it on for someone else. |

## 6. Requirement changes (revision 5)

| Where | Today (revision 4) | Proposed |
|---|---|---|
| §3.1 | "The system never places orders by itself, and no order reaches an exchange. … A person places every order." | "No order reaches an exchange. A person places each manual order. Automatic practice orders are placed only for a user who has switched automatic trading on, only on their own practice account, under the rules and limits they set (§11)." |
| TRD-05 | "A person places every order. Setups and the position-size calculator may fill in the ticket. Nothing places orders automatically." | "A person places every manual order; setups and the position-size calculator may fill in the ticket. Automatic practice trading (TRD-09) places orders only under a user's own rules, switched on by them. Setups, alerts, the AI and jobs never place orders." |
| New TRD-09 | — | Automatic practice trading: per-user rules (account, pairs, patterns, minimum checklist score, minimum reward for the risk, risk per trade) and limits (open trades, orders per day, daily loss); off by default; a stop that cancels its orders |
| New TRD-10 | — | Every automatic decision is logged with its reason, and every automatic order is labelled, audited with its setup and rules version, and alerted |
| New TRD-11 | — | Automatic decisions are deterministic: the same setups, market data and rules give the same decisions and fills on replay |
| New NFR-17 | — | An automatic order is placed p95 ≤ 2 s after its setup is confirmed |
| §10 | "Do not implement real-money trading in the initial release." | Unchanged |

Proposal 001's rules 1 and 2 would read: "A person places every manual order. Nothing trades automatically except a user's own automatic practice trading, under their rules (TRD-09)."

## 7. Phase 16 in the implementation plan

Order of work: 8 → 14 → **16** → 9 → 10 → 11 → 12 → 15 (if approved) → 13. Phase 15 keeps its number for the exchange test networks.

| # | Criterion | Covers |
|---|---|---|
| 16.1 | With automatic trading on, a confirmed bullish setup that matches the rules becomes a practice limit buy with its stop and target, sized by the calculator; one that doesn't is logged as skipped with the reason (end to end, on live or replayed data) | TRD-09, TRD-10 |
| 16.2 | The limits hold: open trades, one per pair, orders per day, and the daily loss pause (unit and property tests) | TRD-09 |
| 16.3 | The stop button switches it off and cancels every open automatic order within 5 s | TRD-09 |
| 16.4 | Nothing is placed for a user who hasn't switched it on, and nothing but the broker can place an automatic order (database policy and dependency rule) | TRD-05 |
| 16.5 | A buy is cancelled when its setup expires or is invalidated before it fills | TRD-09 |
| 16.6 | Replaying recorded setups and market data gives the same decisions and fills (digest) | TRD-11 |
| 16.7 | Every automatic order is labelled "Automatic", audited with its setup and rules version, and raises an alert; rule changes are audited | TRD-10 |
| 16.8 | NFR-17 is measured and met | NFR-17 |
| 16.9 | The new card carries the practice banner, axe finds no serious violations, and it works from the keyboard, the switch's confirmation included | TRD-06, NFR-10 |

Relative size: M.

## 8. New risks

| ID | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R38 | Automatic practice results are taken as proof that the rules work | H | H | "Simulated" on every result; the number of trades and the period shown with every figure; no performance claims; §3's caution in the app |
| R39 | Rules trade too often, or lose quickly | M | M | Off by default; limits on open trades, orders per day and daily loss; the stop button |
| R40 | Pressure to point the automatic trader at real money | M | H | Real money stays out (§5); it would need its own proposal and proposal 001's stage C conditions |
| R41 | A decision bug: the wrong pair, size or level | L | M | A pure, deterministic decider; property tests; replays; the decision log and audit |
| R42 | A new analysis ruleset changes which setups qualify | M | L | The ruleset and rules versions are recorded with every decision |

## 9. Decisions for you

All nine were approved as recommended on 2026-11-15.

| # | Decision | Recommendation |
|---|---|---|
| A1 | Add automatic practice trading, with the requirement changes in §6 | Yes, on practice balances only |
| A2 | What triggers an automatic buy | A confirmed bullish setup that matches the user's rules. Not the AI, and not an indicator on its own |
| A3 | The order it places | A limit buy at the setup's entry, a protective stop at the invalidation and a target at target 1; cancelled if the setup expires or is invalidated first |
| A4 | Default rules | All four patterns; checklist score at least 70; target 1 at least 2.0 times the risk; 1 % risk per trade. As §3 shows, these may trade rarely; each user can change them |
| A5 | Default limits | 3 open automatic trades, one per pair; 10 automatic orders a day; a daily loss limit of 3 % that pauses it until 00:00 UTC |
| A6 | Who can use it | Every role, each on their own practice account, off until they switch it on |
| A7 | The AI | Kept out of decisions. After Phase 9 it may explain a trade, never place one |
| A8 | When | A new Phase 16, after Phase 14 is accepted, before Phase 9 |
| A9 | Real money | Unchanged: not in the initial release. Automatic real-money trading would be a separate proposal |

## 10. What happens when you approve

1. Done on 2026-11-15: REQUIREMENTS.md is at revision 5, the Phase 0 documents listed at the top are updated, and proposal 001's rules 1 and 2 are amended as in §6.
2. Phase 16 starts when you say "Start Phase 16", once Phase 14 is accepted. It begins with ADR 022 (the auto-trader, its decisions and its journal), and ends with an acceptance report like every other phase.
