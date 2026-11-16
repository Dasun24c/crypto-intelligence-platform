import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { floorTo } from '@cip/domain';
import type { Logger } from '@cip/observability';
import type { StreamedInstrument } from './instruments.js';
import { CoinbasePipeline, type PipelineDeps } from './pipelines.js';
import type { BatchWriter, CandleWriter, GapRecorder } from './writers.js';

const instrument: StreamedInstrument = {
  id: '019a6f00-0000-7000-8000-000000000005',
  venue: 'coinbase',
  venueSymbol: 'BTC-USD',
  base: 'BTC',
  quote: 'USD',
  assetClass: 'crypto',
  role: 'reference',
  priceTick: '0.01',
  qtyStep: '0.00000001',
  isPrimaryVenue: false,
  underlyingCalendarId: null,
  storeRawTrades: true,
};

function deps(gaps: Pick<GapRecorder, 'record'>, log: Logger): PipelineDeps {
  const writer = <T>() => ({ add: vi.fn() }) as unknown as BatchWriter<T>;
  return {
    instrument,
    candles: {} as CandleWriter,
    trades: writer(),
    metrics: writer(),
    snapshots: writer(),
    gaps: gaps as GapRecorder,
    redis: { xadd: vi.fn().mockResolvedValue('1-0') } as unknown as Redis,
    log,
    closed: () => false,
    profileBuckets: 24,
  };
}

describe('InstrumentPipeline gaps', () => {
  it('logs a gap it could not record instead of leaving the rejection unhandled (2026-11-16 crash)', async () => {
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const timeout = new Error('timeout exceeded when trying to connect');
    const record = vi.fn().mockRejectedValue(timeout);
    const now = Date.UTC(2026, 10, 16, 14, 14, 2);
    // Planned to start a few minutes back: the first connection records the minutes it missed.
    const pipeline = new CoinbasePipeline(deps({ record }, log), {
      nextOpen: floorTo(now, '1m') - 5 * 60_000,
      lastClose: '91000',
    });

    pipeline.onConnectionOpen(now);
    pipeline.onConnectionClosed(now + 1_000);
    pipeline.onConnectionOpen(now + 3_600_000); // an hour later: the host slept
    // Unhandled rejections fail the run; these would have surfaced by now.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls.map((call) => (call[0] as { detectedBy: string }).detectedBy)).toEqual([
      'reconnect',
      'reconnect',
    ]);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenLastCalledWith(
      expect.objectContaining({
        err: timeout,
        instrumentId: instrument.id,
        stream: 'trades',
        detectedBy: 'reconnect',
      }),
      'data gap not recorded',
    );
    pipeline.close(now + 3_600_000);
  });
});
