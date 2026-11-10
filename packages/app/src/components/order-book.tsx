import type { BookSnapshot, Instrument } from '@cip/contracts';
import { cn } from '@cip/ui';
import { formatBps, formatDecimal, spreadBps, stepDecimals } from '../lib/decimal.js';

type Level = BookSnapshot['bids'][number];

function LevelRow({
  level,
  side,
  max,
  priceDp,
}: {
  level: Level;
  side: 'bid' | 'ask';
  max: number;
  priceDp: number;
}) {
  const [price, qty] = level;
  // The bar is a picture of the size: decorative, the number is in the cell.
  const pct = max > 0 ? Math.min(100, (Number(qty) / max) * 100) : 0;
  return (
    <tr>
      <td className={cn('px-3 py-0.5', side === 'bid' ? 'text-bull' : 'text-bear')}>
        {formatDecimal(price, priceDp)}
      </td>
      <td className="relative px-3 py-0.5 text-right text-fg">
        <span
          aria-hidden
          className={cn('absolute inset-y-0 right-0', side === 'bid' ? 'bg-bull/15' : 'bg-bear/15')}
          style={{ width: `${pct.toFixed(1)}%` }}
        />
        <span className="relative">{formatDecimal(qty)}</span>
      </td>
    </tr>
  );
}

/** The top levels of a live book: asks above (best ask last), bids below, the spread between. */
export function OrderBookTable({
  book,
  instrument,
  levels = 10,
}: {
  book: BookSnapshot;
  instrument: Instrument;
  levels?: number;
}) {
  const priceDp = stepDecimals(instrument.priceTick);
  const asks = book.asks.slice(0, levels);
  const bids = book.bids.slice(0, levels);
  const max = Math.max(0, ...[...asks, ...bids].map(([, q]) => Number(q)));
  const bestBid = bids[0]?.[0];
  const bestAsk = asks[0]?.[0];
  const spread = bestBid && bestAsk ? spreadBps(bestBid, bestAsk) : null;
  return (
    <table className="w-full border-collapse font-mono text-xs tabular-nums">
      <caption className="sr-only">
        Top {levels} ask and bid levels of the {instrument.displayName} order book
      </caption>
      <thead>
        <tr>
          <th scope="col" className="px-3 py-1 text-left font-sans font-medium text-fg-muted">
            Price ({instrument.quote})
          </th>
          <th scope="col" className="px-3 py-1 text-right font-sans font-medium text-fg-muted">
            Size ({instrument.base})
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="rowgroup" colSpan={2} className="px-3 pt-1 text-left font-sans font-medium text-bear">
            Asks (sell side)
          </th>
        </tr>
        {[...asks].reverse().map((l) => (
          <LevelRow key={`a${l[0]}`} level={l} side="ask" max={max} priceDp={priceDp} />
        ))}
      </tbody>
      <tbody>
        <tr>
          <td colSpan={2} className="border-y border-border px-3 py-1 font-sans text-fg-muted">
            Spread {formatBps(spread)} · book covers ±{book.coverageBps.toFixed(0)} bps around mid
          </td>
        </tr>
      </tbody>
      <tbody>
        <tr>
          <th scope="rowgroup" colSpan={2} className="px-3 pt-1 text-left font-sans font-medium text-bull">
            Bids (buy side)
          </th>
        </tr>
        {bids.map((l) => (
          <LevelRow key={`b${l[0]}`} level={l} side="bid" max={max} priceDp={priceDp} />
        ))}
      </tbody>
    </table>
  );
}
