import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@cip/observability';
import { BatchWriter, isTransient } from './writers.js';

const poolTimeout = () => new Error('timeout exceeded when trying to connect');

function serverError(code: string): pg.DatabaseError {
  const err = new pg.DatabaseError('rejected', 0, 'error');
  err.code = code;
  return err;
}

function writer(insert: (rows: string[]) => Promise<void>, maxPending?: number) {
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const w = new BatchWriter<string>(insert, log as unknown as Logger, 'trades', 1_000, maxPending);
  return { w, log };
}

describe('BatchWriter', () => {
  it('keeps rows it could not store while the database was out of reach, and stores them next time (2026-11-16)', async () => {
    const insert = vi
      .fn<(rows: string[]) => Promise<void>>()
      .mockRejectedValueOnce(poolTimeout())
      .mockResolvedValue(undefined);
    const { w, log } = writer(insert);
    w.add('a');
    w.add('b');
    w.add('c');
    await w.flush();
    expect(w.pending).toBe(3);
    expect(w.failed).toBe(0);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ writer: 'trades', rows: 3, kept: 3 }),
      'batch insert failed',
    );

    w.add('d');
    await w.flush();
    expect(insert).toHaveBeenLastCalledWith(['a', 'b', 'c', 'd']);
    expect([w.written, w.pending, w.failed]).toEqual([4, 0, 0]);
  });

  it('drops rows the database rejects, so one bad row cannot hold the others back', async () => {
    const insert = vi
      .fn<(rows: string[]) => Promise<void>>()
      .mockRejectedValueOnce(serverError('22003')) // numeric value out of range
      .mockResolvedValue(undefined);
    const { w } = writer(insert);
    w.add('bad');
    w.add('b');
    await w.flush();
    expect([w.written, w.pending, w.failed]).toEqual([0, 0, 2]);
    w.add('c');
    await w.flush();
    expect(insert).toHaveBeenLastCalledWith(['c']);
    expect(w.written).toBe(1);
  });

  it('never runs two flushes at once: the interval waits for the running one', async () => {
    let finish!: () => void;
    const insert = vi.fn<(rows: string[]) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { w } = writer(insert);
    w.add('a');
    const first = w.flush();
    expect(w.flush()).toBe(first);
    w.add('b'); // arrives while the first flush is running
    expect(insert).toHaveBeenCalledTimes(1);
    finish();
    await first;
    const stopping = w.stop(); // stores what is left
    await vi.waitFor(() => expect(insert).toHaveBeenCalledTimes(2));
    finish();
    await stopping;
    expect(insert.mock.calls).toEqual([[['a']], [['b']]]);
    expect(w.written).toBe(2);
  });

  it('inserts 1,000 rows a statement and keeps the rest from the one that failed', async () => {
    const insert = vi
      .fn<(rows: string[]) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(serverError('57P01')) // the server is shutting down
      .mockResolvedValue(undefined);
    const { w } = writer(insert);
    for (let i = 0; i < 2_500; i++) w.add(String(i));
    await w.flush();
    expect(insert.mock.calls.map(([rows]) => rows.length)).toEqual([1_000, 1_000]);
    expect([w.written, w.pending, w.failed]).toEqual([1_000, 1_500, 0]);
    await w.flush();
    expect(insert.mock.calls.slice(2).map(([rows]) => [rows.length, rows[0]])).toEqual([
      [1_000, '1000'],
      [500, '2000'],
    ]);
    expect([w.written, w.pending]).toEqual([2_500, 0]);
  });

  it('keeps at most maxPending rows, dropping the oldest', async () => {
    let fail!: (err: unknown) => void;
    const insert = vi.fn<(rows: string[]) => Promise<void>>(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { w } = writer(insert, 3);
    w.add('a');
    w.add('b');
    w.add('c');
    const flushing = w.flush();
    w.add('d');
    w.add('e');
    fail(poolTimeout());
    await flushing;
    expect([w.pending, w.failed]).toEqual([3, 2]); // c, d, e kept; a and b dropped
    w.add('f');
    expect([w.pending, w.failed]).toEqual([3, 3]); // c dropped for f
    insert.mockResolvedValue(undefined);
    await w.flush();
    expect(insert).toHaveBeenLastCalledWith(['d', 'e', 'f']);
  });
});

describe('isTransient', () => {
  it('retries what the database could not answer or gave up on, never what it rejected', () => {
    expect(isTransient(poolTimeout())).toBe(true);
    expect(isTransient(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(
      true,
    );
    expect(isTransient(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true);
    for (const code of ['08006', '40001', '40P01', '53300', '55P03', '57014', '57P01', '58030'])
      expect(isTransient(serverError(code)), code).toBe(true);
    for (const code of ['22003', '22P02', '23505', '23514', '42501', '42P01'])
      expect(isTransient(serverError(code)), code).toBe(false);
  });
});
