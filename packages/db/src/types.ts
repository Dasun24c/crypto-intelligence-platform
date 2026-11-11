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
  'analysis.detection_runs': DetectionRunsTable;
  'analysis.indicator_values': IndicatorValuesTable;
  'analysis.engine_checkpoints': EngineCheckpointsTable;
  'analysis.detection_events': DetectionEventsTable;
  'analysis.swing_points': SwingPointsTable;
  'analysis.structure_events': StructureEventsTable;
  'analysis.trading_ranges': TradingRangesTable;
  'analysis.liquidity_levels': LiquidityLevelsTable;
  'analysis.sweeps': SweepsTable;
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
export type NewIndicatorValue = Insertable<IndicatorValuesTable>;

export type UserRow = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type RefreshTokenRow = Selectable<RefreshTokensTable>;
export type AuditLogRow = Selectable<AuditLogTable>;
export type NewAuditLogRow = Insertable<AuditLogTable>;
