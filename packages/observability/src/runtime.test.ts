import { describe, expect, it, vi } from 'vitest';
import {
  checkDependencies,
  createLogger,
  initMetrics,
  initTracing,
  PinoNestLogger,
  startOpsServer,
  type Logger,
} from './index.js';

const id = { service: 'test', instance: 'i-1', version: '0.0.0-test' };

describe('metrics', () => {
  it('serves process metrics in the Prometheus format on the ops endpoint', async () => {
    const metrics = initMetrics(id);
    metrics.meter.createCounter('cip_test_events_total').add(3, { kind: 'x' });
    const server = await startOpsServer({
      port: 0,
      host: '127.0.0.1',
      metrics: metrics.handle,
      readiness: () => Promise.resolve({ status: 'ok', detail: 'test' }),
    });
    try {
      const { port } = server.address() as { port: number };
      const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
      expect(text).toContain('cip_process_uptime_seconds');
      expect(text).toContain('cip_process_resident_memory_bytes');
      expect(text).toMatch(/cip_test_events_total\{[^}]*kind="x"[^}]*\} 3/);
    } finally {
      server.close();
      await metrics.shutdown();
    }
  });
});

describe('tracing', () => {
  it('stays off without an OTLP endpoint and switches on with one', async () => {
    const off = initTracing(id, undefined);
    expect(off.enabled).toBe(false);
    await off.shutdown();
    const on = initTracing(id, 'http://127.0.0.1:4318/');
    expect(on.enabled).toBe(true);
    await on.shutdown();
  });
});

describe('checkDependencies', () => {
  it('is ready only when every dependency answers', async () => {
    const ok = await checkDependencies({
      database: () => Promise.resolve(1),
      redis: () => Promise.resolve('PONG'),
    });
    expect(ok).toEqual({ status: 'ok', detail: 'reachable: database, redis' });
    const down = await checkDependencies({
      database: () => Promise.reject(new Error('refused')),
      redis: () => Promise.resolve('PONG'),
    });
    expect(down).toEqual({ status: 'down', detail: 'unreachable: database' });
  });
});

describe('logging', () => {
  it('creates a logger carrying the service and instance', () => {
    const log = createLogger({ service: 'svc', instance: 'i-9', level: 'warn' });
    expect(log.level).toBe('warn');
    expect(log.bindings()).toMatchObject({ service: 'svc', instance: 'i-9' });
  });

  it('routes NestJS framework logs to the matching pino levels', () => {
    const calls: string[] = [];
    const fake = {
      info: vi.fn(() => calls.push('info')),
      error: vi.fn(() => calls.push('error')),
      warn: vi.fn(() => calls.push('warn')),
      debug: vi.fn(() => calls.push('debug')),
      trace: vi.fn(() => calls.push('trace')),
    } as unknown as Logger;
    const nest = new PinoNestLogger(fake);
    nest.log('a', 'Ctx');
    nest.error('b', 'stack', 'Ctx');
    nest.warn('c');
    nest.debug('d');
    nest.verbose('e');
    expect(calls).toEqual(['info', 'error', 'warn', 'debug', 'trace']);
  });
});
