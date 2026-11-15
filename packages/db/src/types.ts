import type { ColumnType, Generated, GeneratedAlways, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Kysely table types for the `app` schema (data model §3). Column names stay snake_case, as in SQL;
 * repositories map them to the camelCase API contracts. Keep in step with the migrations: the
 * integration tests compare these columns with information_schema.
 */
export interface UsersTable {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: 'admin' | 'analyst' | 'viewer';
  mfa_secret_enc: Buffer | null;
  mfa_last_used_step: number | null;
  status: ColumnType<'active' | 'locked' | 'disabled', 'active' | 'locked' | 'disabled' | undefined>;
  failed_logins: Generated<number>;
  locked_until: Date | null;
  password_changed_at: Generated<Date>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_login_at: Date | null;
}

export interface RefreshTokensTable {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: Buffer;
  client: 'web' | 'desktop';
  device_label: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
}

export interface AuditLogTable {
  /** bigint: returned as a string by node-postgres. */
  id: GeneratedAlways<string>;
  /** Assigned by the chain trigger. */
  chain_seq: ColumnType<string, never, never>;
  at: Generated<Date>;
  actor_type: 'user' | 'system';
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  user_agent: string | null;
  details: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, never>;
  prev_hash: ColumnType<Buffer, never, never>;
  hash: ColumnType<Buffer, never, never>;
}

export interface SettingsTable {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: Generated<Date>;
}

export interface UserPreferencesTable {
  user_id: string;
  prefs: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>;
  updated_at: Generated<Date>;
}

export interface Database {
  'app.users': UsersTable;
  'app.refresh_tokens': RefreshTokensTable;
  'app.audit_log': AuditLogTable;
  'app.settings': SettingsTable;
  'app.user_preferences': UserPreferencesTable;
  'market.venues': VenuesTable;
  'market.instrument_profiles': InstrumentProfilesTable;
  'market.underlying_calendars': UnderlyingCalendarsTable;
  'market.underlying_market_closures': UnderlyingMarketClosuresTable;
  'market.instruments': InstrumentsTable;
  'market.candles': CandlesTable;
  'market.trades': TradesTable;
  'market.orderbook_metrics': OrderbookMetricsTable;
  'market.orderbook_snapshots': OrderbookSnapshotsTable;
  'market.cross_venue_spreads': CrossVenueSpreadsTable;
  'market.feed_events': FeedEventsTable;
  'market.large_trades': LargeTradesTable;
  'market.orderbook_walls': OrderbookWallsTable;
  'market.data_gaps': DataGapsTable;
  'market.economic_events': EconomicEventsTable;
  'market.economic_event_revisions': EconomicEventRevisionsTable;
  'market.calendar_syncs': CalendarSyncsTable;
  'analysis.detection_runs': DetectionRunsTable;
  'analysis.indicator_values': IndicatorValuesTable;
  'analysis.engine_checkpoints': EngineCheckpointsTable;
  'analysis.detection_events': DetectionEventsTable;
  'analysis.swing_points': SwingPointsTable;
  'analysis.structure_events': StructureEventsTable;
  'analysis.trading_ranges': TradingRangesTable;
  'analysis.liquidity_levels': LiquidityLevelsTable;
  'analysis.sweeps': SweepsTable;
  'analysis.poi_zones': PoiZonesTable;
  'analysis.setups': SetupsTable;
  'analysis.setup_transitions': SetupTransitionsTable;
  'analysis.setup_checklist_results': SetupChecklistResultsTable;
  'analysis.setup_outcomes': SetupOutcomesTable;
  'alerts.rules': AlertRulesTable;
  'alerts.events': AlertEventsTable;
  'alerts.notifications': AlertNotificationsTable;
  'trading.accounts': TradingAccountsTable;
  'trading.orders': TradingOrdersTable;
  'trading.fills': TradingFillsTable;
  'trading.ledger': TradingLedgerTable;
  'trading.journal': TradingJournalTable;
  'trading.broker_state': TradingBrokerStateTable;
  'trading.strategies': TradingStrategiesTable;
  'trading.auto_decisions': TradingAutoDecisionsTable;
  'trading.auto_days': TradingAutoDaysTable;
}

// ---------------------------------------------------------------- market (data model §4)
// `numeric` columns come back from node-postgres as strings: exact decimals, as the API expects.

type Venue = 'binance' | 'coinbase' | 'replay';

export interface VenuesTable {
  id: Venue;
  name: string;
  enabled: Generated<boolean>;
}

export interface InstrumentProfilesTable {
  id: string;
  name: string;
  version: number;
  params: unknown;
  params_hash: string;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface UnderlyingCalendarsTable {
  id: string;
  time_zone: string;
  weekly_rule: unknown;
}

export interface UnderlyingMarketClosuresTable {
  calendar_id: string;
  starts_at: Date;
  ends_at: Date;
  reason: 'weekend' | 'daily_break' | 'holiday';
  source: 'generated' | 'manual';
}

export interface InstrumentsTable {
  id: string;
  venue_id: Venue;
  venue_symbol: string;
  base_asset: string;
  quote_asset: string;
  asset_class: 'crypto' | 'tokenised_gold' | 'stablecoin';
  role: ColumnType<'monitored' | 'reference', 'monitored' | 'reference' | undefined>;
  price_tick: string;
  qty_step: string;
  /** The smallest order value in the quote currency; "0" while unknown (migration 0012). */
  min_notional: ColumnType<string, string | undefined, string>;
  profile_id: string | null;
  underlying_calendar_id: string | null;
  is_primary_venue: Generated<boolean>;
  store_raw_trades: Generated<boolean>;
  venue_status: ColumnType<
    'trading' | 'halted' | 'delisted' | 'unknown',
    'trading' | 'halted' | 'delisted' | 'unknown' | undefined
  >;
  enabled: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CandlesTable {
  instrument_id: string;
  timeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
  open_time: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quote_volume: string;
  trade_count: number | null;
  taker_buy_volume: string | null;
  micro_profile: number[] | null;
  source: 'exchange_kline' | 'trades' | 'rest' | 'aggregated' | 'replay';
  quality: 'complete' | 'repaired' | 'partial';
  underlying_closed: Generated<boolean>;
  finalized_at: Date;
}

export interface TradesTable {
  instrument_id: string;
  ts: Date;
  trade_id: string;
  price: string;
  qty: string;
  taker_side: 'buy' | 'sell';
  taker_order_ref: string | null;
  received_at: Date;
}

export interface OrderbookMetricsTable {
  instrument_id: string;
  ts: Date;
  mid: string;
  spread_bps: number;
  bid_usd_10bp: number | null;
  ask_usd_10bp: number | null;
  bid_usd_50bp: number | null;
  ask_usd_50bp: number | null;
  bid_usd_100bp: number | null;
  ask_usd_100bp: number | null;
  imbalance_10bp: number | null;
  imbalance_50bp: number | null;
  imbalance_100bp: number | null;
  coverage_bps: number | null;
}

export interface OrderbookSnapshotsTable {
  instrument_id: string;
  ts: Date;
  bids: string[];
  asks: string[];
  venue_seq: string | null;
}

export interface CrossVenueSpreadsTable {
  base_asset: string;
  ts: Date;
  primary_instrument_id: string;
  secondary_instrument_id: string;
  primary_usd: string;
  secondary_usd: string;
  usdt_usd: string;
  spread_bps: number;
}

export interface FeedEventsTable {
  ts: Date;
  venue_id: Venue;
  instrument_id: string | null;
  event:
    | 'connected'
    | 'disconnected'
    | 'reconnecting'
    | 'resubscribed'
    | 'rate_limited'
    | 'delayed'
    | 'recovered'
    | 'error'
    | 'status_change';
  details: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, never>;
}

export interface LargeTradesTable {
  id: string;
  instrument_id: string;
  ts: Date;
  taker_side: 'buy' | 'sell';
  avg_price: string;
  qty: string;
  notional_usd: string;
  grouping: 'single' | 'taker_order' | 'burst';
  fill_count: number;
  price_levels: number;
  threshold_usd: string;
}

export interface OrderbookWallsTable {
  id: string;
  instrument_id: string;
  side: 'bid' | 'ask';
  price: string;
  first_seen: Date;
  last_seen: Date;
  max_notional_usd: string;
  ended_reason: 'filled' | 'pulled' | 'unknown' | null;
}

export interface DataGapsTable {
  id: string;
  instrument_id: string;
  stream: 'trades' | 'depth' | 'kline' | 'ticker';
  gap_start: Date;
  gap_end: Date | null;
  detected_at: Date;
  detected_by: 'sequence' | 'heartbeat' | 'timer' | 'reconnect' | 'consistency_check';
  status: 'open' | 'backfilling' | 'repaired' | 'unrepairable';
  resolved_at: Date | null;
  details: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>;
}

// The economic calendar (Phase 7; rulebook I38).

export type EconomicReleaseColumn =
  'cpi' | 'employment_situation' | 'gdp' | 'personal_income_outlays' | 'fomc';
export type EconomicEventStatus = 'scheduled' | 'cancelled' | 'superseded';

export interface EconomicEventsTable {
  id: string;
  source: 'fred' | 'bea' | 'manual';
  source_ref: string;
  release: EconomicReleaseColumn | null;
  title: string;
  country: Generated<string>;
  currency: Generated<string>;
  category: 'inflation' | 'employment' | 'growth' | 'central_bank' | 'other';
  impact: 'low' | 'medium' | 'high';
  scheduled_at: Date;
  time_confirmed: boolean;
  status: Generated<EconomicEventStatus>;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  /** Set by a trigger: the latest revision. */
  revision: Generated<number>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type EconomicEventRow = Selectable<EconomicEventsTable>;

/** Written only by the triggers on market.economic_events. */
export interface EconomicEventRevisionsTable {
  event_id: string;
  revision: number;
  recorded_at: Date;
  scheduled_at: Date;
  time_confirmed: boolean;
  title: string;
  currency: string;
  impact: 'low' | 'medium' | 'high';
  status: EconomicEventStatus;
}

export interface CalendarSyncsTable {
  id: string;
  source: 'fred' | 'bea';
  started_at: Date;
  finished_at: Date | null;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  inserted: Generated<number>;
  updated: Generated<number>;
  unchanged: Generated<number>;
  cancelled: Generated<number>;
  error: string | null;
  details: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>;
}

// ---------------------------------------------------------------- alerts (data model §7, Phase 8)

/** A user's alert rule; `scope`, `condition` and `quiet_hours` hold contracts' AlertScope, AlertCondition, QuietHours. */
export interface AlertRulesTable {
  id: string;
  owner_id: string;
  name: string;
  enabled: Generated<boolean>;
  scope: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>;
  condition: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  severity: 'info' | 'warning' | 'critical';
  cooldown_sec: Generated<number>;
  channels: Generated<string[]>;
  quiet_hours: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

/** One fired occurrence; `UNIQUE (rule_id, dedupe_key)`. */
export interface AlertEventsTable {
  id: string;
  rule_id: string;
  fired_at: Date;
  dedupe_key: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  source_refs: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >;
  late: Generated<boolean>;
  created_at: Generated<Date>;
}

/** Delivery of an event to a user per channel; the `in_app` row is the inbox item. */
export interface AlertNotificationsTable {
  id: string;
  event_id: string;
  user_id: string;
  channel: 'in_app' | 'desktop' | 'web';
  status: 'pending' | 'sent' | 'failed';
  attempts: Generated<number>;
  last_error: string | null;
  created_at: Generated<Date>;
  read_at: Date | null;
}

// ---------------------------------------------------------------- trading (data model §10, Phase 14)

type Json = Record<string, unknown>;

/** A user's practice account on one venue; `starting_balances` is {asset: amount} of the current period. */
export interface TradingAccountsTable {
  id: string;
  user_id: string;
  venue_id: Venue;
  starting_balances: ColumnType<Record<string, string>, Record<string, string>, Record<string, string>>;
  reset_epoch: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type PracticeOrderStatusDb =
  'new' | 'pending' | 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'refused';

export interface TradingOrdersTable {
  id: string;
  account_id: string;
  instrument_id: string;
  client_order_id: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'target';
  quantity: string;
  limit_price: string | null;
  stop_price: string | null;
  status: PracticeOrderStatusDb;
  refusal_reason: string | null;
  filled_quantity: ColumnType<string, string | undefined, string>;
  filled_value: ColumnType<string, string | undefined, string>;
  reserved: ColumnType<string, string | undefined, string>;
  parent_id: string | null;
  oco_group: string | null;
  source: 'manual' | 'setup' | 'auto';
  setup_id: string | null;
  underlying_closed: Generated<boolean>;
  reset_epoch: number;
  seq: ColumnType<string | null, string | number | null | undefined, string | number | null>;
  accepted_after: string | null;
  fill_count: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TradingFillsTable {
  id: string;
  order_id: string;
  account_id: string;
  instrument_id: string;
  side: 'buy' | 'sell';
  price: string;
  quantity: string;
  fee: string;
  fee_asset: string;
  liquidity: 'maker' | 'taker';
  flags: Generated<string[]>;
  basis: ColumnType<Json, Json, Json>;
  reset_epoch: number;
  filled_at: Date;
  created_at: Generated<Date>;
}

/** One change of an available balance; balances are sums of these for the current period. */
export interface TradingLedgerTable {
  id: Generated<string>;
  account_id: string;
  reset_epoch: number;
  asset: string;
  amount: string;
  reason: 'start' | 'reserve' | 'release' | 'fill' | 'fee';
  order_id: string | null;
  fill_id: string | null;
  created_at: Generated<Date>;
}

/** The broker's journal of inputs that changed something, for replays (criterion 14.3). */
export interface TradingJournalTable {
  seq: Generated<string>;
  at: Generated<Date>;
  kind: 'load' | 'place' | 'cancel' | 'reset' | 'trade' | 'setup' | 'strategy';
  input: ColumnType<Json, Json, Json>;
  fills: ColumnType<string[], string[] | undefined, string[]>;
  /** The auto-trader's digest lines (migration 0013). */
  decisions: ColumnType<string[], string[] | undefined, string[]>;
}

/** A user's automatic practice trading rules (migration 0013, ADR 022). */
export interface TradingStrategiesTable {
  id: string;
  user_id: string;
  enabled: Generated<boolean>;
  rules: ColumnType<Json, Json, Json>;
  version: Generated<number>;
  paused_until: Date | null;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Every confirmed setup the auto-trader considered for a user (migration 0013). */
export interface TradingAutoDecisionsTable {
  id: string;
  strategy_id: string;
  user_id: string;
  setup_id: string;
  /** The setup's analysis run: it names the ruleset version. */
  run_id: string;
  instrument_id: string;
  pattern: string;
  outcome: 'placed' | 'skipped' | 'refused' | 'cancelled';
  reason: string | null;
  order_id: string | null;
  strategy_version: number;
  decided_at: Date;
  created_at: Generated<Date>;
}

/** One account's automatic trading on one UTC day (migration 0013). */
export interface TradingAutoDaysTable {
  account_id: string;
  /** The UTC day, `YYYY-MM-DD`. */
  day: string;
  orders: Generated<number>;
  result: ColumnType<string, string | undefined, string>;
  updated_at: Generated<Date>;
}

export interface TradingBrokerStateTable {
  id: number;
  lease_epoch: ColumnType<string, string | number | undefined, string | number>;
  commands_cursor: Generated<string>;
  /** Its position in an:events (migration 0013). */
  setups_cursor: Generated<string>;
  trade_cursors: ColumnType<
    Record<string, string>,
    Record<string, string> | undefined,
    Record<string, string>
  >;
  updated_at: Generated<Date>;
}

// ---------------------------------------------------------------- analysis (data model §5)

export type RunStatus = 'warming_up' | 'running' | 'completed' | 'failed' | 'superseded';

export interface DetectionRunsTable {
  id: string;
  mode: 'live' | 'replay';
  instrument_id: string;
  profile_id: string;
  ruleset_version: string;
  params_hash: string;
  from_time: Date;
  to_time: Date | null;
  /** Per timeframe, the open time (epoch ms) the run's series starts at, fixed once chosen. */
  series_origins: ColumnType<
    Record<string, number>,
    Record<string, number> | undefined,
    Record<string, number>
  >;
  status: RunStatus;
  requested_by: string | null;
  result_digest: string | null;
  started_at: Generated<Date>;
  finished_at: Date | null;
  /** For a replay, the live run it copied its origins and profile from (ADR 017). */
  source_run_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/** double precision columns come back from node-postgres as numbers, exactly as stored. */
export interface IndicatorValuesTable {
  instrument_id: string;
  timeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
  open_time: Date;
  run_id: string;
  rsi: number | null;
  macd: number | null;
  macd_signal: number | null;
  macd_hist: number | null;
  ema_fast: number | null;
  ema_mid: number | null;
  ema_slow: number | null;
  vwap: number | null;
  atr: number | null;
  volume_z: number | null;
  volume_anomaly: boolean | null;
  trend: 'bullish' | 'bearish' | 'neutral' | null;
  trend_strength: number | null;
}

type SmcTimeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface EngineCheckpointsTable {
  run_id: string;
  last_boundary: Date;
  /** bigint: a string from node-postgres. */
  lease_epoch: ColumnType<string, string | number, string | number>;
  state: Buffer;
  updated_at: Generated<Date>;
}

export interface DetectionEventsTable {
  run_id: string;
  /** bigint: a string from node-postgres. */
  seq: ColumnType<string, string | number, never>;
  candle_time: Date;
  instrument_id: string;
  timeframe: SmcTimeframe;
  type:
    | 'swing_confirmed'
    | 'structure'
    | 'range_detected'
    | 'range_ended'
    | 'level_created'
    | 'level_status'
    | 'sweep'
    | 'zone_created'
    | 'zone_status'
    | 'setup_transition'
    | 'gap_marker';
  entity_id: string | null;
  payload: ColumnType<unknown, string, never>;
}

export interface SwingPointsTable {
  id: string;
  run_id: string;
  instrument_id: string;
  timeframe: SmcTimeframe;
  kind: 'high' | 'low';
  structure_level: 'internal' | 'external';
  price: string;
  candle_time: Date;
  confirmed_at: Date;
  flags: ColumnType<string[], string[] | undefined, string[]>;
}

export interface StructureEventsTable {
  id: string;
  run_id: string;
  instrument_id: string;
  timeframe: SmcTimeframe;
  structure_level: 'internal' | 'external';
  type: 'bos' | 'choch' | 'mss';
  direction: 'bullish' | 'bearish';
  broken_swing_id: string | null;
  break_price: string;
  break_candle_time: Date;
  is_initial: ColumnType<boolean, boolean | undefined, boolean>;
  displacement: ColumnType<unknown, string | null, string | null>;
  flags: ColumnType<string[], string[] | undefined, string[]>;
}

export interface TradingRangesTable {
  id: string;
  run_id: string;
  instrument_id: string;
  timeframe: SmcTimeframe;
  high: string;
  low: string;
  equilibrium: string;
  window_start: Date;
  detected_at: Date;
  ended_at: Date | null;
  end_reason: 'breakout_up' | 'breakout_down' | 'expired' | 'data_gap' | null;
  flags: ColumnType<string[], string[] | undefined, string[]>;
}

export interface LiquidityLevelsTable {
  id: string;
  run_id: string;
  instrument_id: string;
  origin_timeframe: SmcTimeframe;
  type: string;
  side: 'buy_side' | 'sell_side';
  price: string;
  touches: ColumnType<number, number | undefined, number>;
  session_name: 'asia' | 'london' | 'new_york' | null;
  source_ref: ColumnType<unknown, string | null, string | null>;
  location: ColumnType<
    'internal' | 'external' | 'straddling' | 'none',
    'internal' | 'external' | 'straddling' | 'none' | undefined,
    'internal' | 'external' | 'straddling' | 'none'
  >;
  known_at: Date;
  status: 'active' | 'swept' | 'broken' | 'expired';
  status_changed_at: Date | null;
  sweep_count: ColumnType<number, number | undefined, number>;
  flags: ColumnType<string[], string[] | undefined, string[]>;
}

export interface SweepsTable {
  id: string;
  run_id: string;
  instrument_id: string;
  timeframe: SmcTimeframe;
  level_id: string;
  group_id: string;
  kind: 'wick' | 'false_breakout';
  side: 'buy_side' | 'sell_side';
  level_price: string;
  extreme_price: string;
  penetration_atr: number;
  breach_candle_time: Date;
  confirmed_candle_time: Date;
  notional_beyond_usd: string | null;
  flags: ColumnType<string[], string[] | undefined, string[]>;
}

/** Points of interest (rulebook §4, migration 0008). `fill_pct` is numeric(5, 2): a string. */
export interface PoiZonesTable {
  id: string;
  run_id: string;
  instrument_id: string;
  timeframe: SmcTimeframe;
  type: 'order_block' | 'fvg' | 'supply' | 'demand';
  direction: 'bullish' | 'bearish';
  top: string;
  bottom: string;
  origin_from: Date;
  origin_to: Date;
  known_at: Date;
  htf: ColumnType<boolean, boolean | undefined, boolean>;
  location: ColumnType<'internal' | 'external' | 'straddling' | 'none', string | undefined, string>;
  structure_event_id: string | null;
  linked_zone_id: string | null;
  swept_liquidity_at_origin: ColumnType<boolean, boolean | undefined, boolean>;
  status: 'untouched' | 'partially_filled' | 'filled' | 'invalidated' | 'expired';
  fill_pct: ColumnType<string, string | number | undefined, string | number>;
  first_touch_at: Date | null;
  status_changed_at: Date | null;
  flags: ColumnType<string[], string[] | undefined, string[]>;
}

/** Data model §5.2 (migration 0009): one row per setup, with its state after its latest transition. */
export interface SetupsTable {
  id: string;
  run_id: string;
  instrument_id: string;
  pattern: 'double_liquidity_trap' | 'eq_near_poi' | 'htf_order_block' | 'sweep_outside_fill_inside';
  variant: 'A' | 'B' | null;
  direction: 'bullish' | 'bearish';
  context_tf: SmcTimeframe;
  setup_tf: SmcTimeframe;
  state: 'forming' | 'triggered' | 'confirmed' | 'entry_active' | 'resolved';
  resolution: SetupResolution | null;
  entry_zone_id: string | null;
  entry_price: string | null;
  invalidation_price: string | null;
  target1_price: string | null;
  target2_price: string | null;
  /** {kind, id, price}. */
  target1_ref: ColumnType<unknown, string | null, string | null>;
  target2_ref: ColumnType<unknown, string | null, string | null>;
  rr_target1: number | null;
  /** numeric(4,1): a string from node-postgres. */
  confluence_score: ColumnType<string, string | number, string | number>;
  mandatory_passed: boolean;
  quality_flags: ColumnType<string[], string[] | undefined, string[]>;
  flags: ColumnType<string[], string[] | undefined, string[]>;
  refs: ColumnType<unknown, string, string>;
  created_candle_time: Date;
  updated_candle_time: Date;
  resolved_candle_time: Date | null;
}

export type SetupResolution =
  'target_reached' | 'invalidated' | 'expired_no_entry' | 'expired_open' | 'ambiguous' | 'expired';

export interface SetupTransitionsTable {
  id: GeneratedAlways<string>;
  setup_id: string;
  event_seq: ColumnType<string, string | number, never>;
  from_state: string | null;
  to_state: string;
  /** Open time of the deciding candle, and its close. */
  candle_time: Date;
  decided_at: Date;
  processed_at: Date;
  reason: string;
  evidence: ColumnType<unknown, string, string>;
}

export interface SetupChecklistResultsTable {
  setup_id: string;
  state: string;
  item: string;
  credit: number;
  weight: number;
  mandatory: boolean;
  evidence: ColumnType<unknown, string, string>;
}

export interface SetupOutcomesTable {
  setup_id: string;
  entry_touched_at: Date | null;
  resolved_at: Date;
  result: SetupResolution;
  mfe_r: number | null;
  mae_r: number | null;
  bars_held: number | null;
  resolved_with_tf: '1m' | null;
}

export type InstrumentRow = Selectable<InstrumentsTable>;
export type CandleRow = Selectable<CandlesTable>;
export type NewCandle = Insertable<CandlesTable>;
export type NewTrade = Insertable<TradesTable>;
export type DataGapRow = Selectable<DataGapsTable>;
export type DetectionRunRow = Selectable<DetectionRunsTable>;
export type IndicatorValueRow = Selectable<IndicatorValuesTable>;
export type EngineCheckpointRow = Selectable<EngineCheckpointsTable>;
export type DetectionEventRow = Selectable<DetectionEventsTable>;
export type NewDetectionEvent = Insertable<DetectionEventsTable>;
export type SwingPointRow = Selectable<SwingPointsTable>;
export type StructureEventRow = Selectable<StructureEventsTable>;
export type TradingRangeRow = Selectable<TradingRangesTable>;
export type LiquidityLevelRow = Selectable<LiquidityLevelsTable>;
export type SweepRow = Selectable<SweepsTable>;
export type PoiZoneRow = Selectable<PoiZonesTable>;
export type NewPoiZone = Insertable<PoiZonesTable>;
export type SetupRow = Selectable<SetupsTable>;
export type NewSetup = Insertable<SetupsTable>;
export type SetupTransitionRow = Selectable<SetupTransitionsTable>;
export type SetupChecklistResultRow = Selectable<SetupChecklistResultsTable>;
export type SetupOutcomeRow = Selectable<SetupOutcomesTable>;
export type NewIndicatorValue = Insertable<IndicatorValuesTable>;
export type AlertRuleRow = Selectable<AlertRulesTable>;
export type AlertEventRow = Selectable<AlertEventsTable>;
export type AlertNotificationRow = Selectable<AlertNotificationsTable>;
export type TradingAccountRow = Selectable<TradingAccountsTable>;
export type TradingOrderRow = Selectable<TradingOrdersTable>;
export type NewTradingOrder = Insertable<TradingOrdersTable>;
export type TradingFillRow = Selectable<TradingFillsTable>;
export type NewTradingFill = Insertable<TradingFillsTable>;
export type NewTradingLedgerEntry = Insertable<TradingLedgerTable>;
export type TradingStrategyRow = Selectable<TradingStrategiesTable>;
export type TradingAutoDecisionRow = Selectable<TradingAutoDecisionsTable>;
export type NewTradingAutoDecision = Insertable<TradingAutoDecisionsTable>;
export type TradingAutoDayRow = Selectable<TradingAutoDaysTable>;

export type UserRow = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type RefreshTokenRow = Selectable<RefreshTokensTable>;
export type AuditLogRow = Selectable<AuditLogTable>;
export type NewAuditLogRow = Insertable<AuditLogTable>;
