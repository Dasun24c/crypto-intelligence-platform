import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@cip/observability';
import { LargeTradeSeeder, type OrderBinRow } from './seed.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function detector() {
  return { seed: vi.fn<(rows: readonly OrderBinRow[]) => void>(), start: vi.fn<() => void>() };
}

function logger() {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

describe('LargeTradeSeeder', () => {
  it('seeds one instrument at a time, each detector starting when its own seed is in (2026-11-16)', async () => {
    const pending = [deferred<OrderBinRow[]>(), deferred<OrderBinRow[]>(), deferred<OrderBinRow[]>()];
    let calls = 0;
    const bins = vi.fn((_id: string, _until: number, _usd: number) => pending[calls++]!.promise);
    const seeder = new LargeTradeSeeder(bins, logger() as unknown as Logger);
    const [a, b, c] = [detector(), detector(), detector()];
    let usdtRate = 1;

    void seeder.add({ id: 'a', venueSymbol: 'BTCUSDT' }, a, 1_000, () => usdtRate);
    void seeder.add({ id: 'b', venueSymbol: 'BTC-USD' }, b, 2_000, () => 1);
    const last = seeder.add({ id: 'c', venueSymbol: 'ETHUSDT' }, c, 3_000, () => usdtRate);
    await settle();
    expect(bins).toHaveBeenCalledTimes(1); // the others wait their turn
    expect(bins).toHaveBeenLastCalledWith('a', 1_000, 1);

    const rows = [{ hour: 498_000, bin: 30, count: 12 }];
    pending[0]!.resolve(rows);
    await settle();
    expect(a.seed).toHaveBeenCalledWith(rows);
    expect(a.start).toHaveBeenCalledTimes(1);
    expect(b.start).not.toHaveBeenCalled();
    expect(bins).toHaveBeenCalledTimes(2);
    expect(bins).toHaveBeenLastCalledWith('b', 2_000, 1);

    usdtRate = 0.9998; // the USDT-USD mid became known meanwhile: read when the seed runs
    pending[1]!.resolve([]);
    await settle();
    expect(b.start).toHaveBeenCalledTimes(1);
    expect(bins).toHaveBeenLastCalledWith('c', 3_000, 0.9998);
    pending[2]!.resolve([]);
    await last;
    expect(c.start).toHaveBeenCalledTimes(1);
  });

  it('logs a failed seed, starts that detector on its floor and still runs the next one', async () => {
    const log = logger();
    const timeout = new Error('canceling statement due to statement timeout');
    const bins = vi
      .fn<(id: string, until: number, usd: number) => Promise<OrderBinRow[]>>()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce([{ hour: 498_001, bin: 31, count: 3 }]);
    const seeder = new LargeTradeSeeder(bins, log as unknown as Logger);
    const [a, b] = [detector(), detector()];

    void seeder.add({ id: 'a', venueSymbol: 'BTC-USD' }, a, 1_000, () => 1);
    await seeder.add({ id: 'b', venueSymbol: 'ETH-USD' }, b, 1_000, () => 1);

    expect(a.seed).not.toHaveBeenCalled();
    expect(a.start).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({ err: timeout, instrument: 'BTC-USD' }, 'large-trade seed failed');
    expect(b.seed).toHaveBeenCalledWith([{ hour: 498_001, bin: 31, count: 3 }]);
    expect(b.start).toHaveBeenCalledTimes(1);
  });
});
