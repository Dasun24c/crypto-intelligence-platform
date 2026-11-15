# Phase 8 · Desktop notifications: manual checklist (criterion 8.2)

Criterion 8.2 asks for native notifications on the Windows and macOS builds, shown by a manual run with a recording. Run this list once on each operating system, recording the screen from step 3 to the end.

## Before you start

- A desktop build of this commit: the `Desktop` workflow's artifact, or `pnpm --filter @cip/desktop tauri build` with Rust installed (see `apps/desktop/README.md`).
  - Windows: the `.msi` or `.exe` from `desktop-windows`, or the one built on this machine: `apps/desktop/src-tauri/target/release/bundle/nsis/Crypto Intelligence Platform_0.1.0_x64-setup.exe`. It is unsigned, so SmartScreen may warn: More info › Run anyway.
  - macOS: the universal `.dmg` from `desktop-macos`. It is unsigned until Phase 13, so open it with right-click › Open.
- A stack to connect to, at an address the build accepts:
  - **An installed build** needs an `https://` server. Release builds refuse plain HTTP, and their content security policy allows only `https:` and `wss:` (desktop README, "First run").
    - The local stack also serves `https://localhost:8443` once its certificate is set up (root README, "HTTPS for the desktop app"). On this machine the certificate is made: trust its authority for your user, then use `https://localhost:8443` as the server address.
    - Or use a server once one is hosted (decision D2).
  - **The local stack, today**: run the development build, `pnpm --filter @cip/desktop dev`, with Rust's `cargo` on the PATH. It accepts `http://localhost:8080`. Its notifications use the same plugin; Windows may label them with a generic app name, because a development build is not installed.
- A user with a rule that fires often. The viewer and this rule are enough:
  - **Alert me on:** Indicator threshold, 1m RSI above 0;
  - **Instruments:** one instrument;
  - **Cooldown:** 1 minute;
  - **Notify me:** In the desktop app.

## Steps

| # | Do | Expect |
|---|---|---|
| 1 | Install and open the app; enter the server address; sign in. | The Command Center; the bell in the header. |
| 2 | Open the Alert Center. If it says desktop notifications are off, click **Allow desktop notifications** and accept the system prompt. | The notice disappears. |
| 3 | Start recording. Create the rule above (or resume it). | The rule is listed. |
| 4 | Wait for the next minute's candle to close (up to about a minute). | A native notification (Windows: Action Center toast; macOS: Notification Center banner) titled like "… 1m: RSI above 0". The bell's count goes up; the alert is first in the inbox. |
| 5 | Leave the app in the background (another window in front). | The next minute's alert still shows as a native notification. |
| 6 | Edit the rule: quiet hours covering the current time, in your time zone. | Alerts keep arriving in the inbox and the bell, but no native notification appears. |
| 7 | Turn quiet hours off. Disconnect the network (Wi-Fi off) for three minutes, then reconnect. Against the local stack, Wi-Fi off does not cut `localhost` and would also stop the market data: stop the web server instead, `docker compose stop web; sleep 180; docker compose start web`. | No burst after reconnecting: one notification, "N alerts while you were away" (criterion 8.4). The inbox lists them all. |
| 8 | Quit the app (tray › Quit, or Cmd-Q). Wait three minutes. Open it again. | One "N alerts while you were away" notification at start; the inbox lists them. |
| 9 | Click a notification in the bell's panel; then **Mark all read**. | The count goes down, then to none. |
| 10 | Pause the rule, and stop recording. | No more alerts. |

## Record

| OS and version | Build (workflow run or commit) | Recording | Steps passed | Notes |
|---|---|---|---|---|
| Windows 11 Pro 25H2 (10.0.26200) | NSIS installer built here from the Phase 8 working tree, 2026-11-13 03:32 UTC (SHA-256 `841914AF…3069E10`) | No screen recording: screenshots of each of this app's notifications and of its window ([evidence](evidence/8.2-windows/README.md)) | 1–10 | Run by Claude Code at your request on 2026-11-13, driving the installed app through UI Automation. Step 7 stopped the web server. Step 8 failed the first time (the script forced the app to stop, and the app lost its server address) and passed when run again on 2026-11-14 with a normal quit. |
| macOS | | | | Not run yet: needs the `Desktop` workflow's build and a Mac |
