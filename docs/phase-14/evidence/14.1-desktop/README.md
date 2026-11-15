# Criterion 14.1 in the desktop app

The installed Windows build of 2026-11-15 (NSIS installer, built 07:24 UTC and installed over the Phase 8 build), against the local stack on `https://localhost:8443`, signed in as the development viewer. Captures of the app's own window only.

| File | What it shows |
|---|---|
| [practice-page.png](practice-page.png) | The Practice Trading page: the practice banner and colour, the order ticket with the live best bid and ask, and the Binance and Coinbase practice balances |
| [confirmation-step.png](confirmation-step.png) | The confirmation step for a market buy of 0.0002 BTC: the best price, the cost with the fee, the account, and the banner |

The steps, driven through Windows UI Automation (07:30 UTC; the orders' times from `trading.orders`):

1. 07:30:09, a market buy of 0.0002 BTC: confirmed, filled at 64,354.64; the BTC balance went from 0.0011 to 0.0013.
2. 07:30:20, a market sell of 0.0002 BTC: filled at 64,361.82; the results by currency updated, labelled simulated.
3. 07:30:37, a limit buy of 0.0004 BTC at 32,180.00: rested under "Open practice orders", was cancelled, and shows as cancelled in the history.
