import { Rewind } from 'lucide-react';
import type { Instrument } from '@cip/contracts';
import { Badge, StatusBadge, type StatusTone } from '@cip/ui';
import { useLiveConnection } from '../live/hooks.js';
import { FEED_LABEL, type FeedState, type InstrumentFeed, VENUE_LABEL } from '../lib/market.js';

/** Replay instruments carry recorded data: always labelled, never mistaken for the live market. */
export function ReplayBadge() {
  return (
    <Badge tone="warn" title="Recorded market data played back, not the live market">
      <Rewind className="size-3.5" aria-hidden /> Replay
    </Badge>
  );
}

export function VenueBadge({ venue }: { venue: Instrument['venue'] }) {
  return venue === 'replay' ? <ReplayBadge /> : <Badge>{VENUE_LABEL[venue]}</Badge>;
}

const VENUE_STATUS: Record<Exclude<Instrument['venueStatus'], 'trading'>, [StatusTone, string]> = {
  halted: ['crit', 'Halted on venue'],
  delisted: ['crit', 'Delisted'],
  unknown: ['warn', 'Venue status unknown'],
};

/** Nothing while the pair trades normally. */
export function VenueStatusBadge({ status }: { status: Instrument['venueStatus'] }) {
  if (status === 'trading') return null;
  const [tone, label] = VENUE_STATUS[status];
  return <StatusBadge tone={tone} label={label} />;
}

export const FEED_TONE: Record<FeedState, StatusTone> = {
  connected: 'ok',
  degraded: 'warn',
  disconnected: 'crit',
};

/** An instrument's feed health, or why it is not known (yet). */
export type FeedView = InstrumentFeed | 'loading' | 'unavailable';

/** An instrument's feed health in words; the detail names the affected streams. */
export function FeedBadge({ feed, replay }: { feed: FeedView; replay: boolean }) {
  if (feed === 'loading') return <Badge>Feed status loading</Badge>;
  if (feed === 'unavailable') return <StatusBadge tone="warn" label="Feed status unavailable" />;
  if (feed.state === null)
    return <Badge>{replay ? 'Replay: no feed status' : 'No feed status reported'}</Badge>;
  const label =
    feed.state === 'connected' ? FEED_LABEL.connected : `${FEED_LABEL[feed.state]} · ${feed.detail}`;
  return (
    <span title={feed.detail} className="min-w-0">
      <StatusBadge tone={FEED_TONE[feed.state]} label={label} />
    </span>
  );
}

const CONNECTION: Record<string, [StatusTone, string]> = {
  connecting: ['info', 'Live: connecting'],
  live: ['ok', 'Live'],
  reconnecting: ['warn', 'Live: reconnecting'],
  disconnected: ['crit', 'Live: disconnected'],
};

/**
 * The shared live connection's state, for the header; nothing while no page uses live data. Announced
 * politely when it changes.
 */
export function LiveConnectionBadge() {
  const connection = useLiveConnection();
  const entry = CONNECTION[connection.state];
  return (
    <span aria-live="polite" title={connection.detail ?? undefined}>
      {entry ? <StatusBadge tone={entry[0]} label={entry[1]} /> : null}
    </span>
  );
}
