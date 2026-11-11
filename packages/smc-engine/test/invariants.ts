import { TF_MS } from '@cip/domain';
import { toUnits } from '../src/price.js';
import type { SmcEvent } from '../src/types.js';

/**
 * Rulebook §13 invariants over one run's events. Returns the violations (empty when none):
 *
 * - `seq` counts up from 1 without holes;
 * - no event refers to a candle that had not closed when it was emitted;
 * - every price is a whole number of ticks (a range's equilibrium, a midpoint, is exempt);
 * - each entity is created once, and nothing refers to an entity before it exists;
 * - a level never changes after it was swept, broken or expired, and is never swept then;
 * - a zone (§4) has its top above its bottom; it changes only while live (not invalidated or
 *   expired), its status never moves back (untouched → partially_filled → filled), and its fill
 *   never shrinks and reaches 100 exactly when it is filled.
 */
export function invariantViolations(events: readonly SmcEvent[], tick: string): string[] {
  const out: string[] = [];
  const tickUnits = toUnits(tick);
  const created = new Set<string>();
  const levels = new Map<string, string>();
  const ranges = new Set<string>();
  const zones = new Map<string, { status: string; fill: number }>();
  const ORDER = ['untouched', 'partially_filled', 'filled'];
  let seq = 0;
  const onTick = (e: SmcEvent, price: string | null) => {
    if (price !== null && toUnits(price) % tickUnits !== 0) out.push(`${e.key}: ${price} is off the tick`);
  };
  const closed = (e: SmcEvent, openTime: number, what: string) => {
    if (openTime + TF_MS[e.tf] > e.time)
      out.push(`${e.key}: ${what} ${openTime} had not closed at ${e.time}`);
  };
  const known = (e: SmcEvent, at: number | null, what: string) => {
    if (at !== null && at > e.time) out.push(`${e.key}: ${what} ${at} is after ${e.time}`);
  };
  const createOnce = (e: SmcEvent) => {
    if (created.has(e.key)) out.push(`${e.key}: created twice`);
    created.add(e.key);
  };
  for (const e of events) {
    if (e.seq !== ++seq) out.push(`seq ${e.seq} where ${seq} was due`);
    switch (e.type) {
      case 'swing_confirmed':
        createOnce(e);
        onTick(e, e.data.price);
        closed(e, e.data.candleTime, 'swing candle');
        known(e, e.data.confirmedAt, 'confirmation');
        break;
      case 'structure':
        createOnce(e);
        onTick(e, e.data.breakPrice);
        closed(e, e.data.breakCandleTime, 'break candle');
        if (e.data.brokenSwing !== null && !created.has(e.data.brokenSwing))
          out.push(`${e.key}: breaks unknown swing ${e.data.brokenSwing}`);
        if (e.data.displacement) {
          closed(e, e.data.displacement.to, 'displacement');
          if (e.data.displacement.from > e.data.displacement.to)
            out.push(`${e.key}: displacement runs backwards`);
        }
        if (e.data.type === 'mss' && !e.data.displacement) out.push(`${e.key}: MSS without displacement`);
        break;
      case 'range_detected':
        createOnce(e);
        ranges.add(e.key);
        onTick(e, e.data.high);
        onTick(e, e.data.low);
        known(e, e.data.detectedAt, 'detection');
        closed(e, e.data.windowStart, 'window start');
        break;
      case 'range_ended':
        if (!ranges.delete(e.key)) out.push(`${e.key}: ends a range that is not active`);
        known(e, e.data.endedAt, 'end');
        break;
      case 'level_created':
        createOnce(e);
        levels.set(e.key, 'active');
        onTick(e, e.data.price);
        known(e, e.data.knownAt, 'knownAt');
        break;
      case 'level_status': {
        const was = levels.get(e.key);
        if (was !== 'active') out.push(`${e.key}: status ${e.data.status} after ${was ?? 'nothing'}`);
        levels.set(e.key, e.data.status);
        onTick(e, e.data.price);
        known(e, e.data.statusChangedAt, 'status change');
        break;
      }
      case 'sweep': {
        createOnce(e);
        if (levels.get(e.data.level) !== 'active')
          out.push(`${e.key}: sweeps ${e.data.level}, which is not active`);
        onTick(e, e.data.levelPrice);
        onTick(e, e.data.extremePrice);
        closed(e, e.data.breachCandleTime, 'breach candle');
        closed(e, e.data.confirmedCandleTime, 'confirming candle');
        const beyond =
          e.data.side === 'buy_side'
            ? toUnits(e.data.extremePrice) > toUnits(e.data.levelPrice)
            : toUnits(e.data.extremePrice) < toUnits(e.data.levelPrice);
        if (!beyond || !(e.data.penetrationAtr > 0)) out.push(`${e.key}: extreme is not beyond the level`);
        break;
      }
      case 'zone_created': {
        createOnce(e);
        zones.set(e.key, { status: 'untouched', fill: 0 });
        onTick(e, e.data.top);
        onTick(e, e.data.bottom);
        if (!(toUnits(e.data.top) > toUnits(e.data.bottom))) out.push(`${e.key}: top is not above bottom`);
        closed(e, e.data.originTo, 'last origin candle');
        if (e.data.originFrom > e.data.originTo) out.push(`${e.key}: origin runs backwards`);
        if (e.data.knownAt !== e.time) out.push(`${e.key}: known at ${e.data.knownAt}, decided at ${e.time}`);
        if (e.data.structureEvent !== null && !created.has(e.data.structureEvent))
          out.push(`${e.key}: refers to unknown structure ${e.data.structureEvent}`);
        if (e.data.linkedZone !== null && !zones.has(e.data.linkedZone))
          out.push(`${e.key}: linked to unknown zone ${e.data.linkedZone}`);
        if (e.data.htf && e.data.type !== 'order_block') out.push(`${e.key}: htf on a ${e.data.type}`);
        break;
      }
      case 'zone_status': {
        const was = zones.get(e.key);
        if (!was || !ORDER.includes(was.status)) {
          out.push(`${e.key}: status ${e.data.status} after ${was?.status ?? 'nothing'}`);
          break;
        }
        const live = ORDER.indexOf(e.data.status);
        if (live >= 0 && live < ORDER.indexOf(was.status))
          out.push(`${e.key}: status went back from ${was.status} to ${e.data.status}`);
        if (e.data.fillPct < was.fill)
          out.push(`${e.key}: fill shrank from ${was.fill} to ${e.data.fillPct}`);
        if (e.data.fillPct > 100) out.push(`${e.key}: filled ${e.data.fillPct}%`);
        if (live >= 0 && (e.data.status === 'filled') !== (e.data.fillPct === 100))
          out.push(`${e.key}: ${e.data.status} at ${e.data.fillPct}%`);
        if (e.data.status !== 'untouched' && e.data.status !== 'expired' && e.data.firstTouchAt === null)
          out.push(`${e.key}: ${e.data.status} without a touch`);
        known(e, e.data.firstTouchAt, 'first touch');
        known(e, e.data.statusChangedAt, 'status change');
        zones.set(e.key, { status: e.data.status, fill: e.data.fillPct });
        break;
      }
      case 'gap_marker':
        createOnce(e);
        closed(e, e.data.from, 'gap start');
        break;
    }
  }
  return out;
}
