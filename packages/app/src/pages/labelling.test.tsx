import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartOverlay } from '@cip/contracts';
import { BTC_BINANCE, candle, run } from '../test/fixtures.js';
import { mockApi, renderApp, signedIn } from '../test/harness.js';

const T = Date.UTC(2026, 10, 10, 12, 0);
const M15 = 900_000;
const swingId = '019a6f00-0000-7000-8000-000000000a01';

const overlay = (to: number): ChartOverlay => ({
  instrumentId: BTC_BINANCE.id,
  tf: '15m',
  run: run(),
  swings: [
    {
      id: swingId,
      tf: '15m',
      kind: 'high',
      level: 'internal',
      price: '105',
      candleTime: to - 6 * M15,
      confirmedAt: to - 4 * M15,
      flags: [],
    },
  ],
  structure: [],
  ranges: [],
  levels: [],
  sweeps: [],
  zones: [],
  setups: [],
  closures: [],
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Fixture labelling', () => {
  it('is only in development builds', async () => {
    const { session, user } = await signedIn('analyst');
    mockApi({ 'GET /api/v1/instruments': [BTC_BINANCE] });
    renderApp('/dev/labelling', session, user);
    expect(await screen.findByText('Development only')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Fixture labelling' })).toBeNull();
  });

  it('loads a window, takes labels and downloads the fixture', async () => {
    const { session, user } = await signedIn('analyst', { devTools: true });
    const api = mockApi({
      'GET /api/v1/instruments': [BTC_BINANCE],
      [`GET /api/v1/market/${BTC_BINANCE.id}/candles`]: (req: { url: URL }) => {
        const from = Number(req.url.searchParams.get('from'));
        const to = Number(req.url.searchParams.get('to'));
        return Array.from({ length: (to - from) / M15 }, (_, i) =>
          candle(from + i * M15, String(100 + (i % 7))),
        );
      },
      [`GET /api/v1/smc/${BTC_BINANCE.id}/overlay`]: (req: { url: URL }) =>
        overlay(Number(req.url.searchParams.get('to'))),
    });
    const blobs: Blob[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (b: Blob) => (blobs.push(b), 'blob:x'),
        revokeObjectURL: () => undefined,
      }),
    );
    const ui = userEvent.setup();
    renderApp('/dev/labelling', session, user);
    expect(await screen.findByRole('link', { name: 'Fixture labelling' })).toBeTruthy();
    await ui.clear(screen.getByLabelText('Window ends (UTC)'));
    await ui.type(screen.getByLabelText('Window ends (UTC)'), '2026-11-10T12:00');
    await ui.click(screen.getByRole('button', { name: 'Load' }));
    const table = await screen.findByRole('table');
    // The platform's swing is offered; label it, then add a detection at a clicked candle.
    const row = within(table).getByText('internal swing high 105').closest('tr')!;
    await ui.click(within(row).getByLabelText('Must detect'));
    const requested = api.requests.find((r) => r.url.pathname.endsWith('/candles'))!;
    expect(Number(requested.url.searchParams.get('to'))).toBe(T);
    expect(Number(requested.url.searchParams.get('from'))).toBe(T - 220 * M15);

    await ui.type(screen.getByLabelText('Id'), 'swing-btc-001');
    await ui.type(screen.getByLabelText('What the window shows, and why each label holds'), 'A clear top.');
    await ui.click(screen.getByRole('button', { name: 'Download fixture' }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    const file = JSON.parse(await blobs[0]!.text()) as {
      expected: unknown[];
      candles: Record<string, unknown[]>;
      labelledBy: string;
    };
    expect(file.expected).toEqual([
      expect.objectContaining({ type: 'swing_confirmed', data: expect.objectContaining({ price: '105' }) }),
    ]);
    expect(file.candles['15m']).toHaveLength(220);
    expect(file.labelledBy).toBe('Test User');
  });

  it('is not for viewers', async () => {
    const { session, user } = await signedIn('viewer', { devTools: true });
    mockApi({ 'GET /api/v1/instruments': [BTC_BINANCE] });
    renderApp('/dev/labelling', session, user);
    await waitFor(() => expect(screen.queryByText('Fixture labelling', { selector: 'h1' })).toBeNull());
    expect(screen.queryByRole('link', { name: 'Fixture labelling' })).toBeNull();
  });
});
