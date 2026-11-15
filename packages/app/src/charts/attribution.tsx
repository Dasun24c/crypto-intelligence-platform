import type { MouseEvent } from 'react';
import { useSession } from '../session.js';

const TRADINGVIEW = 'https://www.tradingview.com/';

/**
 * The chart library's attribution (Apache-2.0 with TradingView's terms; feasibility §7.3): the
 * NOTICE text of Lightweight Charts 5.2.1 and a link to tradingview.com, opened through the host
 * (the system browser on desktop).
 */
export function ChartAttribution() {
  const { platform } = useSession();
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    void platform.openExternal(TRADINGVIEW);
  };
  return (
    <p className="text-xs text-fg-muted" data-attribution="lightweight-charts">
      Charts: TradingView Lightweight Charts™, Copyright (с) 2025 TradingView, Inc.{' '}
      <a
        href={TRADINGVIEW}
        onClick={open}
        className="text-accent underline"
        rel="noopener noreferrer"
        target="_blank"
      >
        tradingview.com
      </a>
    </p>
  );
}
