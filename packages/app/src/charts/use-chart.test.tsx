import { cleanup, render } from '@testing-library/react';
import type * as LightweightCharts from 'lightweight-charts';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartRemoved, useChart } from './use-chart.js';

// jsdom has no canvas: a stand-in chart that, like the library's, throws when asked to remove a
// series after the chart itself was removed.
vi.mock('lightweight-charts', async (importOriginal) => ({
  ...(await importOriginal<typeof LightweightCharts>()),
  createChart: () => {
    let removed = false;
    return {
      remove: () => {
        removed = true;
      },
      removeSeries: () => {
        if (removed) throw new Error('Value is undefined');
      },
    };
  },
}));

/** A chart component's series effect, as the Liquidity Map and Technical Analysis charts have. */
function Probe({ tick, log }: { tick: number; log: string[] }) {
  const { ref, chart } = useChart('UTC');
  useEffect(() => {
    if (!chart) return;
    return () => {
      if (chartRemoved(chart)) {
        log.push(`${tick}: the chart was already removed`);
        return;
      }
      chart.removeSeries({} as never);
      log.push(`${tick}: series removed`);
    };
  }, [chart, tick, log]);
  return <div ref={ref} />;
}

describe('useChart', () => {
  afterEach(cleanup);

  it('keeps the chart while its series change, so a cleanup removes them', () => {
    const log: string[] = [];
    const { rerender } = render(<Probe tick={1} log={log} />);
    rerender(<Probe tick={2} log={log} />);
    expect(log).toEqual(['1: series removed']);
  });

  it('says the chart is removed when unmounting runs the effect cleanups after the ref cleanup', () => {
    // Switching an instrument shows a spinner in place of the chart: an unmount. Removing the
    // series then threw, and the page showed its error screen (found by the e2e tests).
    const log: string[] = [];
    const { unmount } = render(<Probe tick={1} log={log} />);
    expect(() => unmount()).not.toThrow();
    expect(log).toEqual(['1: the chart was already removed']);
  });
});
