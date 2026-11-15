# Criterion 8.2 on Windows: the run's evidence

The [manual checklist](../../desktop-notifications-checklist.md), run on the installed Windows build against the local stack on `https://localhost:8443`, signed in as `viewer@cip.test`.

| | |
|---|---|
| System | Windows 11 Pro 25H2 (10.0.26200), 1920 × 1200 at 125 %, Do Not Disturb off |
| Build | `Crypto Intelligence Platform_0.1.0_x64-setup.exe`, built here from the Phase 8 working tree on 2026-11-13 at 03:32 UTC (SHA-256 `841914AFF2DD9091663BFD23056CF28577BE17CBB38906779407875073069E10`), installed per user |
| Run | 2026-11-13 17:39–17:55 UTC (steps 3–10); steps 8–10 again on 2026-11-14 02:23–02:34 UTC |
| How | At your request, Claude Code ran it while you left the computer alone. A script drove the installed app through Windows UI Automation, and changed the rule through the API where the app's window could not be reached. Instead of a screen recording, it captured the notification corner of the screen after each alert, and the app's own window. |

The notification corner also caught other apps' notifications that happened to arrive. Every capture that did not show this app's notification was deleted, unviewed where possible. Only crops of this app's notifications are kept here.

## Steps

| # | What happened | Evidence |
|---|---|---|
| 1–2 | The app connected to `https://localhost:8443`, with the local authority trusted for the user, and the viewer signed in. Windows already allowed its notifications. | Server: the viewer's desktop session from 17:24:28 |
| 3 | The rule "8.2 check: BTC/USDT 1m RSI above 0" (1m RSI above 0 on BTC/USDT, desktop notifications, cooldown 1 minute) was resumed. The first time this went through the API, because the app was on another page; on 2026-11-14 it was clicked in the app. | Audit log 17:39:40 (API) and 02:23:58 (desktop app); [the rule active, with the inbox](step3-rule-active-inbox.png) |
| 4 | At the 17:40 candle close, a Windows notification appeared: "BTC · Binance BTC/USDT 1m: RSI above 0", "RSI 71.1356 on the latest closed candle". The bell went from 128 to 129 unread, and the alert was first in the inbox. | [Notification](step4-notification.png); Windows' notification centre listed it for `org.cip.desktop` |
| 5 | With the app minimised, the 17:42 alert still appeared as a notification (RSI 79.3152). | Windows' notification centre: 1 → 2 entries for the app |
| 6 | Quiet hours from 17:32 to 18:42 UTC: the server marked the 17:43 alert quiet. It reached the inbox, and no notification appeared. | The `alerts:events` push carried `quiet: true`; the notification centre stayed at 2 |
| 7 | The web server was stopped for 180 s (17:43:08–17:46:21), so the app lost its connection. One alert fired meanwhile (17:45). About 4 s after the server came back, one notification appeared: "1 alert while you were away", not a burst. | [Summary after the outage](step7-summary-after-outage.png) |
| 8 | On 2026-11-14 the app's window was closed, which quit the app in 287 ms. Two alerts fired while it was closed (02:27 and 02:28). It was opened from the Start menu at 02:28:02, restored the viewer's session by itself, and showed one notification at 02:28:14: "2 alerts while you were away". The bell showed 4 unread. | [Summary at start](step8-summary-after-restart.png) |
| 9 | In the bell's panel, a click on the newest alert took the count from 5 to 4; **Mark all read** took it to none. | [After one](step9-after-one-read.png), [after Mark all read](step9-after-mark-all-read.png); the inbox rows' `read_at`: 02:33:19 and 02:33:21 |
| 10 | **Pause**, clicked in the app at 02:29:08, stopped the alerts. None came in the next 150 s, nor on 2026-11-13 after the first pause (17:52:05). | Audit log; `alerts.events` |

On the server, the rule fired 12 alerts over the two runs, none late. Each has an inbox row and a desktop row, both `sent`.

## The first step 8, on 2026-11-13

- The script minimised the app for step 5. Afterwards it looked the window up through .NET's `Process.MainWindowHandle`, which returned one of the app's hidden 18 × 18 helper windows rather than the main window.
- So for step 8 its close message went to that helper window. When the app did not quit, the script stopped the process by force.
- Opened again, the app had lost its saved server address and asked for it ("Connect to your server"). The start-up summary could not appear, and step 9 was done through the API.
- The script was corrected: it now finds the main window by its title and size, and never forces the app to stop. Steps 8–10 were then run again, as above.

**What the forced stop showed.** The app keeps its server address in its web view's local storage. On the next start, the web view's storage database recovered without its newest files, and the address was gone, though the saved sign-in in Windows' credential store was intact. Once you entered the address again, the app restored the viewer's session without a password (02:22:49).

After the normal quit on 2026-11-14, the address and the session both survived. So a crash or "End task" could make the app forget its server, but a normal quit could not.

**Fixed on 2026-11-14.** The address now lives in `settings.json` in the app's config folder, written atomically by the app's Rust side. Checked on the rebuilt installer's app:
- with the web view's storage moved aside, the app still started signed in;
- after another forced stop, it started signed in again.

See the [acceptance report](../../acceptance-report.md#82-native-notifications-on-the-desktop-builds).
