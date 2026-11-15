# ADR 008: Desktop as a thin Tauri client

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Deciders | Project owner (Phase 0 approval) |
| Related | [Architecture §13 Desktop (Tauri 2)](../phase-0/03-architecture.md#13-desktop-tauri-2) · [Architecture §11 Frontend](../phase-0/03-architecture.md#11-frontend) · [Requirements analysis](../phase-0/01-requirements-analysis.md) (assumption A6) · [Feasibility §8](../phase-0/02-feasibility.md#8-desktop-distribution) · [Risks R18, R19, R26](../phase-0/04-risks-and-dependencies.md#1-risk-register) · [ADR 009](009-built-in-auth.md) |

## Context

The requirements call for Windows and macOS desktop apps with native notifications and resync after reconnecting. Assumption A6 says the desktop app is a client of the same backend and runs no backend services or analysis locally. An offline-capable app would need a local database and engine, which the requirements analysis calls a much larger project.

Desktop apps also bring their own risks: signing cost and process, loss of the updater key (R19), WebGL2 performance in WKWebView (R18) and XSS in the WebView (R26).

## Decision

The desktop app is a **thin Tauri 2 client** of the same backend. It builds the same `packages/app` React application with a Tauri implementation of the platform interface (`notify()`, `secureStore`, `openExternal()`, `onSleepWake()`, `appVersion`).

- **First run**: server URL, then login. The refresh token is stored in the OS keychain through a small Rust command (`keyring` crate). The access token stays in memory (see ADR 009).
- **Capabilities are limited** to notifications, window state, tray, optional autostart, the keyring command and opening external links. No shell access, and no filesystem access beyond app config.
- **CSP** allows only `'self'` plus the configured server over HTTPS and WSS. No remote scripts.
- Updates use the Tauri updater with signed manifests (Phase 13). CI builds Windows x64 and macOS universal bundles.
- Tauri 2.x is pinned (2.12.5). The v3 alpha is avoided.

## Consequences

**Positive**

- One UI codebase and one backend. Features reach desktop and web together.
- No secrets and no analysis on the client. The attack surface is small because the Tauri capabilities are restricted.
- Sleep/wake and network changes trigger reconnect and resync, using the same protocol as the web (ADR 007).

**Negative and costs**

- The desktop app does nothing without a reachable server.
- Signing is a cost and a process: Apple Developer Program ($99/year) and a Windows option still to be quoted (decisions D12, R19). The updater private key must go into a secrets manager with an offline backup.
- Two WebViews (WebView2 on Windows, WKWebView on macOS) must both work. WebGL2 performance in WKWebView is checked in Phase 10.

**What we must do because of it**

- Keep the platform interface the only place where web and desktop differ.
- Run packaged-app smoke tests on Windows (tauri-driver) and a scripted manual checklist on macOS (architecture §19).
- Review the capability list and CSP whenever a Tauri plugin is added.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **Embedded local backend** | Gives offline use, but needs a local database, ingestion and engine, and is much larger (architecture §20, assumption A6). |
| Web app only | Not chosen: the requirements ask for Windows and macOS desktop apps with native notifications. |
