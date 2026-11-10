# 06 · API contracts

| | |
|---|---|
| Status | Approved 2026-11-10 (Phase 0 sign-off, recommended defaults) |
| Date | 2026-11-09 |
| Source of truth | zod schemas in `packages/contracts`. OpenAPI 3.1 is generated from them. |

## 1. Conventions

| Topic | Rule |
|---|---|
| Base path | REST under `/api/v1`. WebSocket: Socket.IO namespace `/v1`, WebSocket transport only. |
| Format | JSON, camelCase field names |
| Time | Epoch milliseconds (UTC) as numbers, everywhere: REST, WebSocket and AI context |
| Prices and quantities | Decimal **strings** (`"4106.99"`). Derived ratios and indicator values are numbers. |
| IDs | UUIDv7 strings |
| Errors | RFC 9457 `application/problem+json`: `{type, title, status, detail, code, errors?}` with the codes in §7 |
| Pagination | Cursor-based: `?cursor=&limit=` (default 100, max 1000) → `{items, nextCursor}` |
| Run selection | SMC and indicator endpoints default to the instrument's current **live** run. `?runId=` selects a replay. |
| Versioning | Breaking changes need a new major path (`/api/v2`). CI compares the generated OpenAPI with `main` and fails on breaking changes. |
| Validation | Every request body, query string and WebSocket message is parsed with its zod schema. Unknown fields are rejected. |

## 2. Authentication

| Method | Path | Body → response |
|---|---|---|
| POST | `/auth/login` | `{email, password}` → `{mfaRequired: true, mfaToken, enrollmentRequired}` or `TokenResponse` |
| POST | `/auth/mfa/enroll` | `{mfaToken}` → `{secret, otpauthUri}`. Only when `enrollmentRequired` is true: first sign-in of an account that must use MFA (admins) |
| POST | `/auth/mfa` | `{mfaToken, code}` → `TokenResponse`. With `enrollmentRequired`, the code also confirms the new authenticator |
| POST | `/auth/refresh` | Web: refresh cookie. Desktop: `{refreshToken}` → `TokenResponse` |
| POST | `/auth/logout` | Revokes the current refresh-token family |
| GET | `/me` | `{user, role, preferences}` |
| PUT | `/me/preferences` | `{displayTimeZone, watchlist, layouts}` |
| PUT | `/me/password` | `{currentPassword, newPassword}`. Signs the account out everywhere (all refresh tokens revoked, older access tokens refused) |
| POST | `/me/mfa/setup`, `/me/mfa/confirm` | Optional TOTP enrolment for other roles: `setup` → `{secret, otpauthUri}`, `confirm` `{code}` → 204 |

```ts
interface TokenResponse {
  accessToken: string;          // JWT, 15 min
  expiresAt: number;
  refreshToken?: string;        // desktop only; web receives an httpOnly cookie instead
  user: { id: string; email: string; displayName: string; role: 'admin' | 'analyst' | 'viewer' };
}
```

Desktop clients send `X-Client: desktop` to receive the refresh token in the body.

Implementation notes (Phase 1):

- `mfaToken` is a 5-minute token with its own audience; it is never accepted as an access token, and each one completes a sign-in once.
- A wrong TOTP code returns `401 MFA_REQUIRED`; an expired `mfaToken` returns `401 AUTH_EXPIRED`. Codes are 6 digits, SHA-1, 30 s steps, ±1 step, and a step already used by the account is refused.
- The web refresh cookie is `cip_refresh`: `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`, 14 days, rotated on every use. Cookie-authenticated `refresh` and `logout` also check the `Origin` header against the CORS allowlist.
- Presenting a refresh token that was already rotated revokes its whole family (`auth.refresh.reuse_detected` in the audit log).
- Failed sign-ins lock an account for 1 min after 5 failures, 5 min after 10, 15 min after 15 and 1 h after every further 5. The response does not reveal whether an account exists or is locked.

## 3. REST endpoints

Roles: **V** viewer, **A** analyst, **Ad** admin. Every endpoint needs authentication.

### Market data

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/instruments` | V | `Instrument[]` |
| GET | `/market/{instrumentId}/candles?tf&from&to&limit` | V | `Candle[]` (max 5,000 per call) |
| GET | `/market/{instrumentId}/ticker` | V | `Ticker` |
| GET | `/market/{instrumentId}/book?depth=50` | V | `BookSnapshot` |
| GET | `/market/{instrumentId}/book/metrics?from&to` | V | `BookMetrics[]` |
| GET | `/market/{instrumentId}/large-trades?from&to&cursor` | V | `Page<LargeTrade>` |
| GET | `/market/{instrumentId}/walls?from&to&active` | V | `Wall[]` |
| GET | `/market/spreads/{baseAsset}?from&to` | V | `CrossVenueSpread[]` |
| GET | `/market/gaps?instrumentId&status&cursor` | V | `Page<DataGap>` |
| GET | `/market/closures?calendar=gold&from&to` | V | `Closure[]` |

### Indicators and SMC

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/indicators/{instrumentId}?tf&from&to` | V | `IndicatorPoint[]` |
| GET | `/smc/{instrumentId}/overlay?tf&from&to` | V | `ChartOverlay`: everything a chart needs in one call |
| GET | `/smc/{instrumentId}/swings?tf&from&to&level` | V | `SwingPoint[]` |
| GET | `/smc/{instrumentId}/structure?tf&from&to` | V | `StructureEvent[]` |
| GET | `/smc/{instrumentId}/ranges?tf&from&to` | V | `TradingRange[]` |
| GET | `/smc/{instrumentId}/levels?tf&status&types` | V | `LiquidityLevel[]` |
| GET | `/smc/{instrumentId}/sweeps?tf&from&to` | V | `Sweep[]` |
| GET | `/smc/{instrumentId}/zones?tf&types&status` | V | `PoiZone[]` |

### Setups and replays

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/setups?instrumentId&pattern&direction&state&minScore&from&to&cursor` | V | `Page<SetupSummary>` |
| GET | `/setups/{id}` | V | `SetupDetail` (transitions, checklist, outcome, referenced detections) |
| GET | `/setups/stats?groupBy&from&to` | V | `SetupStats` (groupBy: pattern, variant, direction, tfPair, instrument, session) |
| POST | `/replays` | A | `{instrumentId, from, to, profileVersion?}` → `202 {runId}` |
| GET | `/replays/{runId}` | V | `ReplayStatus`, including the digest comparison with the live run where the periods overlap |

### Calendar, AI, alerts, whales

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/calendar/events?from&to&minImpact` | V | `EconomicEvent[]` |
| POST / PATCH / DELETE | `/calendar/events[/{id}]` | Ad | Manual entries (for example FOMC dates) |
| GET | `/ai/analyses?instrumentId&status&from&to&cursor` | V | `Page<AiAnalysisSummary>` |
| GET | `/ai/analyses/{id}` | V | `AiAnalysisDetail` (context sent, response, validation, usage) |
| POST | `/ai/analyses` | A | `{instrumentId, reason: 'market_summary' \| 'setup_review' \| 'refresh', setupId?}` → `202 {analysisId}` or `409 BUDGET_EXHAUSTED` |
| GET | `/ai/usage?from&to` | V | Daily calls, tokens, cost, budget status |
| GET / POST | `/alerts/rules` | V | Own rules (admins can filter by owner) |
| GET / PATCH / DELETE | `/alerts/rules/{id}` | V (owner) | |
| POST | `/alerts/rules/{id}/test?hours=24` | V (owner) | Dry run against stored events: what would have fired |
| GET | `/alerts/events?cursor` | V | `Page<AlertEvent>` (own rules) |
| GET | `/notifications?unread&cursor` | V | `Page<Notification>` |
| POST | `/notifications/{id}/read`, `/notifications/read-all` | V | |
| GET | `/whales/exchange?instrumentId&from&to` | V | Large trades and wall summary |
| GET | `/whales/onchain?asset&from&to` | V | Phase 11 |

### System and administration

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/system/health` | V | `SystemHealth` |
| GET | `/system/feeds` | V | `FeedStatus[]` |
| GET | `/system/runs` | V | Live and replay runs with status and lag |
| GET / POST / PATCH | `/admin/users[/{id}]` | Ad | User management; `POST /admin/users/{id}/reset-mfa` |
| POST / PATCH | `/admin/instruments[/{id}]` | Ad | Add an instrument (triggers backfill), enable/disable, assign profile, primary venue |
| GET / POST | `/admin/profiles[/{name}/versions]` | Ad | Create a new profile version (starts a new live run with warm-up) |
| GET / PUT | `/admin/settings/{key}` | Ad | AI budget, model ids, alert defaults, thresholds |
| POST / DELETE | `/admin/closures` | Ad | Gold-market holidays |
| GET | `/admin/audit?actor&action&from&to&cursor` | Ad | `Page<AuditEntry>` (newest first; `action` matches a prefix) |
| GET | `/admin/audit/verify` | Ad | `{ok, checkedRows, firstBrokenSeq}`: walks the hash chain |
| GET | `/healthz`, `/readyz` | none | Liveness and readiness probes, outside `/api/v1` and not routed by Caddy |

Every POST, PATCH, PUT and DELETE under `/admin`, plus `/replays` and `/ai/analyses`, writes an audit entry.

## 4. Key schemas

```ts
type Ts = number;                 // epoch ms, UTC
type Decimal = string;
type Tf = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
type Direction = 'bullish' | 'bearish';

interface Instrument {
  id: string; venue: 'binance' | 'coinbase' | 'replay'; venueSymbol: string;
  base: string; quote: string;
  assetClass: 'crypto' | 'tokenised_gold' | 'stablecoin';
  role: 'monitored' | 'reference';
  displayName: string;            // e.g. 'PAXG (gold-backed token) · Binance PAXG/USDT'
  priceTick: Decimal; isPrimaryVenue: boolean;
  venueStatus: 'trading' | 'halted' | 'delisted' | 'unknown';
  profile: { name: string; version: number } | null;
  underlyingCalendar: 'gold' | null;
}

interface Candle {
  t: Ts; o: Decimal; h: Decimal; l: Decimal; c: Decimal; v: Decimal; qv: Decimal; n: number | null;
  quality: 'complete' | 'repaired' | 'partial';
  underlyingClosed: boolean;
}

interface Ticker { instrumentId: string; ts: Ts; last: Decimal; bid: Decimal; ask: Decimal; change24hPct: number; volume24hQuote: Decimal; }
interface BookSnapshot { instrumentId: string; ts: Ts; bids: [Decimal, Decimal][]; asks: [Decimal, Decimal][]; coverageBps: number; }

interface LiquidityLevel {
  id: string; tf: Tf; type: LevelType; side: 'buy_side' | 'sell_side'; price: Decimal;
  touches: number; location: 'internal' | 'external' | 'straddling' | 'none';
  knownAt: Ts; status: 'active' | 'swept' | 'broken' | 'expired'; flags: string[];
}
type LevelType = 'eqh' | 'eql' | 'pdh' | 'pdl' | 'pwh' | 'pwl' | 'pmh' | 'pml' | 'session_high' | 'session_low'
  | 'range_high' | 'range_low' | 'weekend_high' | 'weekend_low' | 'swing_high' | 'swing_low' | 'sweep_extreme';

interface Sweep {
  id: string; tf: Tf; levelId: string; groupId: string; kind: 'wick' | 'false_breakout';
  levelPrice: Decimal; extremePrice: Decimal; penetrationAtr: number;
  breachAt: Ts; confirmedAt: Ts; notionalBeyondUsd: Decimal | null; flags: string[];
}

interface PoiZone {
  id: string; tf: Tf; type: 'order_block' | 'fvg' | 'supply' | 'demand'; direction: Direction;
  top: Decimal; bottom: Decimal; originFrom: Ts; originTo: Ts; knownAt: Ts; htf: boolean;
  location: 'internal' | 'external' | 'straddling' | 'none';
  status: 'untouched' | 'partially_filled' | 'filled' | 'invalidated' | 'expired'; fillPct: number; flags: string[];
}

interface ChartOverlay {
  runId: string; tf: Tf;
  swings: SwingPoint[]; structure: StructureEvent[]; ranges: TradingRange[];
  levels: LiquidityLevel[]; sweeps: Sweep[]; zones: PoiZone[];
  closures: { from: Ts; to: Ts; reason: string }[];   // gold instruments only
  setups: SetupSummary[];
}

type Pattern = 'double_liquidity_trap' | 'eq_near_poi' | 'htf_order_block' | 'sweep_outside_fill_inside';
type SetupState = 'forming' | 'triggered' | 'confirmed' | 'entry_active' | 'resolved';

interface SetupSummary {
  id: string; instrumentId: string; pattern: Pattern; variant: string | null; direction: Direction;
  contextTf: Tf; setupTf: Tf; state: SetupState;
  resolution: 'target_reached' | 'invalidated' | 'expired_no_entry' | 'expired_open' | 'ambiguous' | null;
  displayLabel: 'Watching' | 'Confirmed' | 'Entry reached' | 'Resolved';
  levels: { entry: Decimal | null; invalidation: Decimal | null; target1: Decimal | null; target2: Decimal | null; rr: number | null };
  score: number | null; mandatoryPassed: boolean; qualityFlags: string[];
  createdAt: Ts; updatedAt: Ts;
  disclaimer: 'Educational analysis — not financial advice';
}

interface SetupDetail extends SetupSummary {
  transitions: { from: SetupState | null; to: SetupState; candleTime: Ts; processedAt: Ts; reason: string; late: boolean }[];
  checklist: { item: ChecklistItem; credit: 0 | 0.5 | 1; weight: number; mandatory: boolean; evidence: Record<string, unknown> }[];
  outcome: { result: string; mfeR: number | null; maeR: number | null; barsHeld: number | null } | null;
  refs: { sweeps: Sweep[]; mss: StructureEvent | null; entryZone: PoiZone | null; levels: LiquidityLevel[]; range: TradingRange | null; poi: PoiZone | null };
}
type ChecklistItem = 'htf_bias' | 'liquidity_marked' | 'poi_present' | 'sweep' | 'mss' | 'levels_defined' | 'risk_reward' | 'news_clear';

interface EconomicEvent { id: string; scheduledAt: Ts; timeConfirmed: boolean; title: string; country: string; currency: string; category: string; impact: 'low' | 'medium' | 'high'; actual: string | null; forecast: string | null; previous: string | null; source: string; }

interface SystemHealth {
  status: 'ok' | 'degraded' | 'down'; ts: Ts;
  components: { name: 'api' | 'ingestor' | 'analyzer' | 'jobs' | 'database' | 'redis' | 'grok' | 'calendar'; status: 'ok' | 'degraded' | 'down'; detail?: string; lastHeartbeat: Ts }[];
  feeds: FeedStatus[];
  analysis: { instrumentId: string; runId: string; lagSec: number; paused: boolean; pauseReason?: 'data_gap' | 'warming_up' }[];
  ai: { budgetUsedPct: number; state: 'ok' | 'throttled' | 'exhausted' };
}

interface FeedStatus { instrumentId: string; stream: 'trades' | 'depth' | 'kline' | 'ticker'; state: 'connected' | 'degraded' | 'disconnected'; lastMessageAt: Ts; lagMsP50: number; lagMsP95: number; openGaps: number; }
```

### Alert conditions

```ts
type AlertCondition =
  | { kind: 'price_cross'; price: Decimal; direction: 'above' | 'below' }
  | { kind: 'price_change_pct'; windowMin: number; pct: number }
  | { kind: 'indicator_threshold'; tf: Tf; indicator: 'rsi' | 'macd_hist' | 'volume_z' | 'atr'; op: '>' | '<' | 'cross_above' | 'cross_below'; value: number }
  | { kind: 'volume_anomaly'; tf: Tf; minZ: number }
  | { kind: 'smc_event'; tfs: Tf[]; events: ('sweep' | 'false_breakout' | 'bos' | 'choch' | 'mss' | 'poi_entry')[]; levelTypes?: LevelType[]; zoneTypes?: PoiZone['type'][] }
  | { kind: 'setup_transition'; patterns?: Pattern[]; directions?: Direction[]; toStates: SetupState[]; minScore?: number }
  | { kind: 'spread_threshold'; baseAsset: 'PAXG'; absBps: number }
  | { kind: 'economic_event_upcoming'; minImpact: 'medium' | 'high'; minutesBefore: number }
  | { kind: 'gold_market_session'; on: ('open' | 'close')[] }
  | { kind: 'large_trade'; minUsd?: Decimal; sides?: ('buy' | 'sell')[] }
  | { kind: 'wall'; minUsd?: Decimal; events: ('appeared' | 'pulled' | 'filled')[] }
  | { kind: 'feed_health'; events: ('gap' | 'delayed' | 'halted' | 'delisted' | 'disconnected')[] };
```

## 5. WebSocket protocol

### 5.1 Connection

- Connect to `wss://<host>/v1` (Socket.IO, `transports: ['websocket']`) with `auth: { token: <accessToken> }`.
- When the token is about to expire, the server emits `auth:expired`. The client refreshes and sends `auth:renew { token }` without reconnecting.

### 5.2 Messages

```ts
// client → server
socket.emit('subscribe', { channels: string[], since?: Record<string, string> }, ack);
socket.emit('unsubscribe', { channels: string[] });

// ack for subscribe
interface SubscribeAck {
  ok: boolean;
  results: Record<string, {
    mode: 'replayed' | 'snapshot' | 'live';
    seq?: string;                 // latest seq for durable channels
    snapshot?: unknown;           // channel-specific snapshot
    error?: ErrorCode;
  }>;
}

// server → client, on event 'message'
interface Envelope<T> { ch: string; seq?: string; ts: Ts; type: string; data: T; }
```

### 5.3 Channels

| Channel | Message types | Durable | Rate |
|---|---|---|---|
| `ticker:{instrumentId}` | `ticker` | No | 4 Hz |
| `book:{instrumentId}` | `book.snapshot` (top 50) | No | 10 Hz |
| `candles:{instrumentId}:{tf}` | `candle.update`, `candle.closed` | No | 1 Hz + on close |
| `trades:{instrumentId}` | `trade.large` | Yes | On event |
| `market:{instrumentId}` | `gap.opened`, `gap.closed`, `feed.status`, `wall.appeared`, `wall.ended`, `spread` (PAXG, 1 Hz) | Yes, except `spread` | On event |
| `indicators:{instrumentId}:{tf}` | `indicators.closed` | Yes | On candle close |
| `smc:{instrumentId}` | `swing.confirmed`, `structure`, `range.detected`, `range.ended`, `level.created`, `level.status`, `sweep`, `zone.created`, `zone.status` | Yes | On event |
| `setups`, `setups:{instrumentId}` | `setup.transition` (carries a full `SetupSummary`) | Yes | On event |
| `ai` | `ai.queued`, `ai.started`, `ai.completed`, `ai.rejected`, `ai.failed`, `ai.budget` | Yes | On event |
| `alerts` (implicit, per user) | `alert.fired`, `notification.read` | Yes | On event |
| `calendar` | `calendar.updated` | Yes | On change |
| `system:activity` | `activity.snapshot`, `activity.pulse` | No | ≤ 4 Hz + pulses |
| `system:health` | `health.update` | No | On change, at least every 10 s |

```ts
interface ActivitySnapshot {
  ts: Ts;
  ingest: { msgsPerSec: number; perVenue: Record<string, number>; state: 'ok' | 'degraded' | 'down' };
  analysis: { candlesPerSec: number; activeJobs: number; backlog: number; paused: number };
  ai: { inflight: number; queued: number; lastCompletedAt: Ts | null; lastResult: 'accepted' | 'rejected' | 'failed' | null };
  alerts: { firedLastMin: number };
  errors: { component: string; severity: 'warning' | 'critical' }[];
}
interface ActivityPulse { ts: Ts; kind: 'pattern' | 'sweep' | 'mss' | 'ai_completed' | 'alert'; refId: string; instrumentId?: string; }
```

### 5.4 Sequencing and resync

1. Durable channels carry `seq`: the id of the Redis stream entry that produced the message. It increases monotonically but not contiguously. Within one connection, Socket.IO preserves order, so messages can only be lost across a disconnect.
2. The client remembers the last `seq` per durable channel.
3. After reconnecting, the client subscribes with `since: { [channel]: lastSeq }`.
4. If the stream still holds entries after `lastSeq`, the server replays them in order (`mode: 'replayed'`) and then continues live.
5. Otherwise the server returns `mode: 'snapshot'` with the current state (for example, all non-resolved setups and the latest 50 transitions), and the client replaces its local state.
6. Non-durable channels always return a snapshot on subscribe. Candle charts reload missing closed candles over REST.

## 6. AI contract

### 6.1 Context sent to Grok

Every item has an `id` the model must cite. Prices are decimal strings copied from the database.

```ts
interface AiContext {
  contextVersion: '1';
  asOf: Ts;
  instrument: { id: 'instr'; displayName: string; assetClass: string; venue: string };
  market: { id: 'mkt'; last: Decimal; change24hPct: number; volume24hUsd: number; spreadBps: number };
  goldMarket?: { id: 'gold'; status: 'open' | 'closed'; nextChangeAt: Ts; crossVenueSpreadBps: number };
  indicators: { id: string; tf: Tf; name: string; value: number }[];           // id e.g. 'ind:1h:rsi'
  structure: { id: string; tf: Tf; trend: 'bullish' | 'bearish' | 'undefined'; lastEvent?: { type: string; direction: Direction; price: Decimal; at: Ts } }[];
  levels: { id: string; tf: Tf; type: LevelType; price: Decimal; distanceAtr: number; status: string }[];
  zones: { id: string; tf: Tf; type: string; direction: Direction; top: Decimal; bottom: Decimal; status: string; fillPct: number }[];
  setups: { id: string; pattern: Pattern; direction: Direction; state: SetupState; entry?: Decimal; invalidation?: Decimal; target1?: Decimal; rr?: number; score: number; checklist: { item: ChecklistItem; credit: number }[]; flags: string[] }[];
  recentEvents: { id: string; at: Ts; type: string; summary: string }[];      // last 6 h
  calendar: { id: string; at: Ts; title: string; impact: string }[];          // next 48 h
  dataQuality: { id: string; code: string; detail: string }[];
}
```

### 6.2 Response schema (structured output)

The JSON Schema is generated from this zod schema and stays inside Grok's guaranteed subset: string, number, integer, boolean, enum, array and object; no `not` or `if/then/else`; string limits ≤ 2,048; arrays ≤ 256 items; ≤ 64 properties per object.

```ts
interface AiResponse {
  stance: 'bullish' | 'bearish' | 'neutral';
  confidence: 'low' | 'medium' | 'high';
  headline: string;                                              // ≤ 120 chars
  summary: string;                                               // ≤ 800 chars
  observations: { text: string; refs: string[] }[];              // 1–6 items; text ≤ 300; 1–6 refs each
  supportingIndicators: { ref: string; reading: string }[];      // 0–6 items; reading ≤ 160
  risks: { text: string; refs: string[] }[];                     // 1–5 items; text ≤ 240
  invalidation: { text: string; refs: string[] };                // text ≤ 240
  competingScenario: { text: string; refs: string[] };           // text ≤ 240
  dataQualityNotes: string[];                                    // 0–4 items; ≤ 160 each
}
```

### 6.3 Server-side validation

Applied in this order. Any failure in V1–V5 rejects the response (after one repair attempt).

| # | Rule |
|---|---|
| V1 | Parses against the zod schema, including lengths and item counts |
| V2 | Every `ref`/`refs` id exists in the context |
| V3 | Numbers in text are grounded: a percentage must match a context percentage within 0.1 points; any other number with 3+ significant digits must match a context value within 0.05%. Small counts (≤ 10) are ignored. |
| V4 | Policy lint: no guarantee or certainty language ("guaranteed", "will definitely", "risk-free", "can't lose") and no instructions ("buy now", "you should sell", "enter long") |
| V5 | Gold rules: the text never says "XAUUSD"; when `goldMarket.status = 'closed'`, at least one observation or risk cites `gold` |
| V6 | Warning only (shown in the UI): the stance contradicts every confirmed setup's direction |

## 7. Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `AUTH_REQUIRED` | 401 | No or invalid token |
| `AUTH_EXPIRED` | 401 | Access token expired |
| `MFA_REQUIRED` | 401 | Second factor needed |
| `FORBIDDEN` | 403 | Role not allowed |
| `NOT_FOUND` | 404 | Unknown resource |
| `VALIDATION_FAILED` | 400 | Request failed schema validation; `errors[]` lists the fields |
| `CONFLICT` | 409 | State conflict, for example a replay already running for that range |
| `BUDGET_EXHAUSTED` | 409 | AI spending cap reached |
| `RATE_LIMITED` | 429 | Too many requests; `Retry-After` header set |
| `CHANNEL_UNKNOWN` | — | WebSocket subscribe to an unknown channel |
| `UNAVAILABLE` | 503 | Dependency down, for example the database |
| `INTERNAL` | 500 | Unexpected error; carries a correlation id |

## 8. API rate limits

| Scope | Limit |
|---|---|
| `/auth/login`, `/auth/mfa` | 5 per minute per IP and per account, with progressive lockout |
| REST per user | 20 requests/s sustained, burst 60 |
| WebSocket subscribe | 20 channel changes per second per connection |
| `POST /ai/analyses` | 10 per hour per user, plus the global budget |
| `POST /replays` | 2 running per user |
