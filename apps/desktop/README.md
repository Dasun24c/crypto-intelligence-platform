# Desktop app (`@cip/desktop`)

The Tauri 2 host for the shared React app in `packages/app` (architecture §13, ADR 008). It is a thin
client of the same server as the web app: it runs no backend services and no analysis. Only what a
browser cannot do lives here.

| Path | Purpose |
|---|---|
| `src/main.tsx` | Resolves the app version, then mounts `@cip/app` with the Tauri platform |
| `src/platform.ts` | The `Platform` implementation: server address, OS keychain, notifications, external links, sleep/wake |
| `vite.config.ts` | Frontend build for the WebView (dev server on port 1420, output in `dist/`) |
| `src-tauri/src/secure_store.rs` | `secure_store_get`, `secure_store_set`, `secure_store_delete`: the refresh token in the OS keychain |
| `src-tauri/src/tray.rs` | Tray icon with Show and Quit, and `set_tray_status`, which puts the connection status in its tooltip |
| `src-tauri/tauri.conf.json` | Window, CSP and bundle settings |
| `src-tauri/capabilities/default.json` | Everything the WebView is allowed to call |
| `src-tauri/tauri.ci.conf.json` | CI only: bundle the `dist/` that was already built and scanned instead of building it again |
| `app-icon.png` | 1024×1024 source of the icons in `src-tauri/icons/` |

## Prerequisites

On every platform: Node.js and pnpm as for the rest of the monorepo (`.nvmrc`, `packageManager`), and
Rust stable through [rustup](https://rustup.rs) (`rustup update stable`).

**Windows 10/11 x64**

- Microsoft C++ Build Tools with the "Desktop development with C++" workload.
- WebView2 Runtime. Windows 11 and up-to-date Windows 10 already have it; otherwise install the
  Evergreen runtime from Microsoft. The installers download it when it is missing.

**macOS**

- Xcode Command Line Tools: `xcode-select --install`.
- For universal bundles: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.

**Linux** (development only; no Linux bundles are shipped)

- `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config`
- A Secret Service provider (GNOME Keyring or KWallet) for the keychain commands.

## Commands

From the repository root (inside `apps/desktop`, drop `--filter @cip/desktop`):

| Command | What it does |
|---|---|
| `pnpm --filter @cip/desktop dev` | `tauri dev`: starts Vite on port 1420 (`dev:web`) and opens the app with hot reload |
| `pnpm --filter @cip/desktop dev:web` | The Vite dev server alone. In an ordinary browser it only shows a notice: the desktop APIs exist only inside the app |
| `pnpm --filter @cip/desktop build` | Builds the frontend into `dist/` |
| `pnpm --filter @cip/desktop bundle` | `tauri build`: frontend, release binary and installers for this OS, in `src-tauri/target/release/bundle/` |
| `pnpm --filter @cip/desktop tauri build --target universal-apple-darwin` | macOS universal bundle (Apple silicon and Intel) |
| `pnpm --filter @cip/desktop typecheck` | TypeScript check |
| `pnpm --filter @cip/desktop tauri icon` | Regenerates `src-tauri/icons/` from `app-icon.png` (delete the `android/` and `ios/` folders it also writes) |

The root `pnpm dev` leaves the desktop app out because it needs the Rust toolchain.

Rust checks, from `apps/desktop/src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`
and `cargo test`. Plain `cargo` builds in development mode, which loads `devUrl` instead of embedding the
frontend; `tauri build` (or `cargo build --features tauri/custom-protocol`) embeds `../dist`, so build the
frontend first. `Cargo.lock` is committed because this is an application.

## First run, and what is stored where

The app asks for the server address, then for a login. Addresses must use `https://`; development
builds (`tauri dev`) also accept `http://localhost` and `http://127.0.0.1` for a local stack, release
builds never do. Only the origin is kept, so an address with a path, a query or credentials is refused.

In `tauri dev` the page comes from Vite, so its origin is `http://localhost:1420` rather than a Tauri
origin. A local API must allow it: `CORS_ORIGINS=http://localhost:5173,http://localhost:1420`.

| Data | Where | Notes |
|---|---|---|
| Refresh token | OS keychain: Keychain Services (macOS), Credential Manager (Windows), Secret Service (Linux). Service `org.cip.desktop` (the bundle identifier), account `refresh_token` | The only secret the client keeps (ADR 009). The Rust commands accept no other key and never log values |
| Server address | WebView local storage, key `cip.serverUrl` | Not a secret |
| Access token | Memory only | Gone when the app quits; the refresh token gets a new one |
| Window size and position | `.window-state.json` in the app's config folder | Written by the window-state plugin |

The API recognises desktop clients by the `x-client: desktop` header and returns the refresh token in
the response body rather than in a cookie. Its CORS allowlist always contains the Tauri origins
(`tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`).

## Security

**Capabilities.** `src-tauri/capabilities/default.json` grants the main window the app version,
notifications (check, request, send), opening `https://` links in the default browser, the window-state
plugin and the four app commands, and nothing else: no shell, file-system, HTTP-client or autostart
plugin. Because `build.rs` registers the app commands with tauri-build, even they need an explicit grant.
Review this file and the CSP whenever a plugin is added (ADR 008).

**Content Security Policy** (`app.security.csp` in `tauri.conf.json`):

```
default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';
connect-src 'self' ipc: http://ipc.localhost https: wss:
```

- Scripts load only from the bundle; there are no remote scripts.
- **Trade-off:** the architecture's policy names one server (`connect-src https://<server> wss://<server>`),
  but the server is chosen at run time while the CSP is fixed at build time. `connect-src` therefore allows
  any `https:` and `wss:` host. It never allows plain `http:` or `ws:`, and the app itself only connects
  to the server the user entered. A build made for a single known server can narrow `connect-src` to it.
- `ipc:` and `http://ipc.localhost` are Tauri's IPC channel (macOS and Linux, and Windows).
- Runtime-injected styles need `'unsafe-inline'`. Keep `index.html` free of inline `<style>` and
  `<script>`: Tauri adds a nonce or hash to the policy for each one, and browsers then ignore
  `'unsafe-inline'`.
- There is no `devCsp`. In `tauri dev` the WebView loads Vite's dev server directly, and Tauri applies
  the CSP only to the assets it serves itself (Tauri 2.12 proxies the dev server only on mobile), so a
  development policy would never take effect. Development builds run without a CSP, which is also why a
  local `http://localhost` API works there; every bundle, including `tauri build --debug`, enforces the
  policy above.

## Identifier and signing

`org.cip.desktop` is a placeholder. Before the first signed release (Phase 13), change `identifier` in
`src-tauri/tauri.conf.json` to the organisation's reverse domain, e.g. `com.example.cip`. The identifier
is also the keychain service name and names the WebView's data folder, so changing it after a release
makes users sign in and enter the server address again.

Bundles are unsigned until Phase 13, which adds code signing, notarisation and the updater. Until then:

- macOS Gatekeeper blocks the app: right-click it and choose Open, or run
  `xattr -dr com.apple.quarantine "/Applications/Crypto Intelligence Platform.app"`.
- Windows SmartScreen warns about an unknown publisher: choose "More info", then "Run anyway".

## Platforms

- **Windows 10/11 x64**: NSIS installer (per-user) and MSI.
- **macOS 13.3 or later**, Apple silicon and Intel: `.app` and `.dmg`. WKWebView is the system WebKit,
  and macOS 13.3 ships Safari 16.4: the floor for Tailwind CSS 4 and the `safari16.4` build target in
  `vite.config.ts`. Change both together (`bundle.macOS.minimumSystemVersion` in `tauri.conf.json`).

## Tray

The tray icon's tooltip reads "Crypto Intelligence Platform", followed by the connection status once
the app reports it through `set_tray_status` (`setTrayStatus` in `src/platform.ts`; the platform
interface has no hook for it yet). Its menu has Show and Quit. On Windows a left click brings the
window back; on macOS a click opens the menu. Closing the window quits the app: the tray option to keep
running in the background (requirements analysis C6) is not built yet.

## CI

`.github/workflows/desktop.yml` builds unsigned bundles on `windows-latest` (`x86_64-pc-windows-msvc`)
and `macos-latest` (`universal-apple-darwin`) for pull requests that touch the desktop app or the shared
frontend packages, for `desktop-v*` tags and on demand. It builds the frontend, runs
`pnpm run scan:artifacts` over `dist/` (no server environment-variable names, no secrets), bundles that
same `dist/` and uploads the installers as workflow artefacts.
