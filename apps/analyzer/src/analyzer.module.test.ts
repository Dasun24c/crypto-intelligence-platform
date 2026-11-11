import { describe, expect, it } from 'vitest';
import { AnalyzerStatus } from './analyzer.module.js';

function status(db: () => Promise<unknown>, redis: () => Promise<unknown>) {
  const pool = { query: db, end: () => Promise.resolve() };
  return new AnalyzerStatus(pool as never, { ping: redis } as never);
}

describe('analyzer status', () => {
  it('is ready only when the database and Redis answer', async () => {
    const ok = status(
      () => Promise.resolve({ rows: [] }),
      () => Promise.resolve('PONG'),
    );
    expect((await ok.readiness()).status).toBe('ok');
    const noDb = status(
      () => Promise.reject(new Error('refused')),
      () => Promise.resolve('PONG'),
    );
    expect(await noDb.readiness()).toEqual({ status: 'down', detail: 'unreachable: database' });
  });

  it('closes its pool on shutdown', async () => {
    let ended = false;
    const pool = {
      query: () => Promise.resolve(),
      end: () => {
        ended = true;
        return Promise.resolve();
      },
    };
    await new AnalyzerStatus(
      pool as never,
      { ping: () => Promise.resolve('PONG') } as never,
    ).onApplicationShutdown();
    expect(ended).toBe(true);
  });
});
