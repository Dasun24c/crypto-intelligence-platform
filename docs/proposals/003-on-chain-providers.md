# Proposal 003 · On-chain providers for the Whale Tracker

| | |
|---|---|
| Status | **Approved 2026-11-17 with option A, the free one** (you answered "A, free"). Phase 11 builds it. Your part: a free Alchemy account, with its key in `.secrets-jobs/alchemy-api-key`. Until the key is there, Ethereum, PAXG and Solana wait, and Bitcoin runs without a key. |
| Date | 2026-11-16 |
| Decision | D9 in the [Phase 0 decisions](../phase-0/README.md), taken in Phase 11 as planned. See [§6](#6-decision-for-you). |
| Scope | [REQUIREMENTS §7](../../REQUIREMENTS.md#7-whale-monitoring) (WH-02); [implementation plan, Phase 11](../phase-0/08-implementation-plan.md#phase-11--whale-tracker), criteria 11.2 and 11.4; [feasibility §9](../phase-0/02-feasibility.md#9-on-chain-providers-decision-in-phase-11) |

## 1. Why you decide this first

REQUIREMENTS §7 says to "integrate suitable on-chain data providers only after evaluating their API access, pricing and coverage". It also says PAXG wallet monitoring starts "once an on-chain provider is approved". The approval is yours, because each option has a cost, an account to create, and terms of use.

Phase 11 needs four things from the providers:

1. Large transfers on Bitcoin, Ethereum and Solana, delivered by push (criterion 11.2).
2. Large PAXG transfers, and Paxos mint and burn events. These are `SupplyIncreased` and `SupplyDecreased` on the Ethereum contract `0x45804880De22913dAFE09f4980848ECE6EcbAf78`.
3. Labels saying which addresses belong to exchanges.
4. Terms of use we can read and record before go-live (criterion 11.4).

## 2. What changed since Phase 0

Each figure below was checked on the provider's own pages on 2026-11-16. They change often, and the full terms are read again before go-live.

- **Whale Alert now starts at $29.95 a month** (the Developer plan). It covers 14 blockchains and includes exchange attribution. Alerts come over WebSocket, at most 100 an hour, each at least $100,000. Its licence says "Personal use only". The Enterprise API costs $699 a month.
- **Etherscan's free plan** is for "Personal & Research use", which "does not include use by or for a company". Address labels come only with Pro Plus, at $899 a month.
- **Alchemy's free plan** gives 30M compute units a month, 15 requests a second and 100 WebSocket connections. Pay-as-you-go costs $0.52 per million compute units after that. The pricing page states no personal-use restriction.
- **Helius's free plan** gives 1M credits a month and standard WebSockets, but not the enhanced transaction stream. Developer costs $49 a month.
- **mempool.space** offers a public WebSocket and REST API, with rate limits it does not publish (it answers HTTP 429 when they are exceeded). It sells an enterprise plan for heavy or business use.

## 3. A constraint of this setup

The stack runs on your laptop, which has no public address. A webhook, where the provider calls us, cannot reach it without a tunnel. So every option here uses **outbound WebSocket subscriptions**: we connect to the provider and it pushes each event to us. That counts as push for criterion 11.2.

## 4. Options

| | **A. Free (recommended)** | **B. Whale Alert + Alchemy** | **C. Commercial labels** |
|---|---|---|---|
| Cost | $0 a month | $29.95 a month | $699 a month, plus Alchemy |
| Bitcoin | mempool.space: each new block is pushed, then its transactions are read; every transfer over the threshold | Whale Alert: transfers of at least $100,000, with exchange attribution | Whale Alert Enterprise |
| Ethereum | Alchemy: each new block is pushed, then its transactions are read; every transfer over the threshold | Whale Alert | Whale Alert Enterprise |
| Solana | Alchemy: only transfers into or out of the listed exchange wallets, sized to stay within the free plan | Whale Alert | Whale Alert Enterprise |
| PAXG transfers, mints and burns | Alchemy: the contract's own events, pushed as they happen; exact | Alchemy, the same way | Alchemy, the same way |
| Exchange labels | Our own list, built from the addresses exchanges publish in their proof-of-reserves reports | Whale Alert's attribution, plus our list | Whale Alert's attribution |
| Limits | Alchemy: Ethereum plus PAXG use roughly half the free 30M compute units (estimate). mempool.space: unpublished limits | 100 alerts an hour, each at least $100,000 | 500 REST calls a minute, 10,000 alerts an hour |
| Terms | No personal-use restriction found on Alchemy's pricing page; mempool.space for business use is an enterprise matter. Both are read in full before go-live | Whale Alert Developer: "Personal use only" | An enterprise contract |
| Your part | Create a free Alchemy account and put its key in `.secrets-jobs/alchemy-api-key` | The same, plus a Whale Alert Developer subscription and its key | Contracts and keys |

The design is the same for all three. Each provider sits behind one interface, so a later move from A to B or C changes no screen, table or alert.

### Not proposed

- **Etherscan.** Its free plan is personal and research use only, and labels cost $899 a month.
- **Helius.** It covers Solana only, and its free plan lacks the transaction stream. Alchemy's standard Solana subscriptions come with the same key as Ethereum.
- **Running our own nodes.** A Bitcoin node and an Ethereum node need hundreds of gigabytes and days to sync. That's not for a laptop.

## 5. Recommendation

**A.**
- It costs nothing.
- We found no personal-use restriction on it.
- It is what Phase 0's decision D9 planned: "start with the low-cost option and a curated list of exchange addresses".
- Every on-chain event comes straight from the chain, with no third party's interpretation.

Its gap is Solana: within the free plans, only transfers that involve a listed exchange wallet can be watched.

If this platform is only for your own use, B gives wider coverage and exchange labels for $29.95 a month. Its licence rules it out for anything beyond personal use.

## 6. Decision for you

**D9: which option, A, B or C?**

After you choose:
- With A or B, you create the free Alchemy account and put its key in the file above. I never take a key pasted in chat.
- Until a key is in place, the On-chain tab says it is waiting for a provider, and criterion 11.2 is carried forward, as Grok's 9.1 was.
- Criterion 11.4 (terms read and recorded) is completed for the chosen providers before go-live.
