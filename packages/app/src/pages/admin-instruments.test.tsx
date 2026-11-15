import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Instrument } from '@cip/contracts';
import { BTC_COINBASE, BTC_REPLAY, health, INSTRUMENTS } from '../test/fixtures.js';
import { json, mockApi, problem, renderApp, signedIn } from '../test/harness.js';

const DISABLED_REPLAY: Instrument = { ...BTC_REPLAY, enabled: false, venueStatus: 'halted' };
const LIST = [...INSTRUMENTS, DISABLED_REPLAY];
const XRP: Instrument = {
  ...BTC_COINBASE,
  id: '019a6f00-0000-7000-8000-000000000030',
  venue: 'binance',
  venueSymbol: 'XRPUSDT',
  base: 'XRP',
  quote: 'USDT',
  displayName: 'XRP · Binance XRP/USDT',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openForm() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add instrument' }));
  return user;
}

describe('Instruments (admin)', () => {
  it('lists every instrument, disabled ones too, with venue status and switches', async () => {
    mockApi({ 'GET /api/v1/admin/instruments': LIST });
    const { session, user } = await signedIn('admin');
    renderApp('/admin/instruments', session, user);
    const row = await screen.findByRole('row', { name: /BTC · Replay BTC\/USDT/ });
    expect(within(row).getByText('Halted')).toBeTruthy();
    expect(within(row).getByText('Replay')).toBeTruthy();
    const enabled = within(row).getByRole('switch', { name: `Enabled: ${BTC_REPLAY.displayName}` });
    expect(enabled.getAttribute('aria-checked')).toBe('false');
    const primary = screen.getByRole('switch', {
      name: `Primary venue for BTC: ${BTC_COINBASE.displayName}`,
    });
    expect(primary.getAttribute('aria-checked')).toBe('false');
    expect(screen.getAllByRole('row')).toHaveLength(LIST.length + 1);
  });

  it('disables an instrument only after confirmation', async () => {
    const api = mockApi({
      'GET /api/v1/admin/instruments': LIST,
      [`PATCH /api/v1/admin/instruments/${BTC_COINBASE.id}`]: { ...BTC_COINBASE, enabled: false },
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { session, user } = await signedIn('admin');
    renderApp('/admin/instruments', session, user);
    const control = await screen.findByRole('switch', { name: `Enabled: ${BTC_COINBASE.displayName}` });
    const clicker = userEvent.setup();
    await clicker.click(control);
    expect(confirm).toHaveBeenCalledWith(
      `Disable ${BTC_COINBASE.displayName}? Its feed stops; its history is kept.`,
    );
    expect(api.find('PATCH', `/api/v1/admin/instruments/${BTC_COINBASE.id}`)).toHaveLength(0);
    await clicker.click(control);
    await waitFor(() =>
      expect(api.find('PATCH', `/api/v1/admin/instruments/${BTC_COINBASE.id}`)).toHaveLength(1),
    );
    expect(api.find('PATCH', `/api/v1/admin/instruments/${BTC_COINBASE.id}`)[0]!.body).toEqual({
      enabled: false,
    });
    // The list is reloaded after the change.
    await waitFor(() => expect(api.find('GET', '/api/v1/admin/instruments').length).toBeGreaterThan(1));
  });

  it('checks the form before sending anything', async () => {
    const api = mockApi({ 'GET /api/v1/admin/instruments': LIST });
    const { session, user } = await signedIn('admin');
    renderApp('/admin/instruments', session, user);
    const u = await openForm();
    await u.type(screen.getByLabelText('Venue symbol'), 'not a symbol');
    await u.click(screen.getByRole('button', { name: 'Add instrument' }));
    expect(
      await screen.findByText(
        'Use the symbol as the venue lists it: BTCUSDT on Binance, BTC-USD on Coinbase.',
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText('Venue symbol').getAttribute('aria-describedby')).toBe(
      'instrument-symbol-error',
    );
    expect(screen.getAllByText('Use 2–10 capital letters or digits.')).toHaveLength(2);
    expect(api.find('POST', '/api/v1/admin/instruments')).toHaveLength(0);
  });

  it('shows the problem details when the venue does not list the symbol', async () => {
    const api = mockApi({
      'GET /api/v1/admin/instruments': LIST,
      'POST /api/v1/admin/instruments': problem(400, 'binance does not list XRPUSDX.', {
        correlationId: 'req-42',
      }),
    });
    const { session, user } = await signedIn('admin');
    renderApp('/admin/instruments', session, user);
    const u = await openForm();
    await u.type(screen.getByLabelText('Venue symbol'), 'xrpusdx');
    await u.type(screen.getByLabelText('Base asset'), 'xrp');
    await u.type(screen.getByLabelText('Quote asset'), 'usdt');
    await u.click(screen.getByRole('button', { name: 'Add instrument' }));
    expect(await screen.findByText('Instrument not added: Validation failed')).toBeTruthy();
    expect(screen.getByText('binance does not list XRPUSDX.')).toBeTruthy();
    expect(screen.getByText('HTTP 400 · VALIDATION_FAILED · reference req-42')).toBeTruthy();
    expect(api.find('POST', '/api/v1/admin/instruments')[0]!.body).toEqual({
      venue: 'binance',
      venueSymbol: 'XRPUSDX',
      base: 'XRP',
      quote: 'USDT',
      assetClass: 'crypto',
      role: 'monitored',
      isPrimaryVenue: false,
      underlyingCalendar: null,
      storeRawTrades: true,
    });
  });

  it('shows a conflict from the API', async () => {
    mockApi({
      'GET /api/v1/admin/instruments': LIST,
      'POST /api/v1/admin/instruments': problem(409, 'XRPUSDT is halted on binance.'),
    });
    const { session, user } = await signedIn('admin');
    renderApp('/admin/instruments', session, user);
    const u = await openForm();
    await u.type(screen.getByLabelText('Venue symbol'), 'XRPUSDT');
    await u.type(screen.getByLabelText('Base asset'), 'XRP');
    await u.type(screen.getByLabelText('Quote asset'), 'USDT');
    await u.click(screen.getByRole('button', { name: 'Add instrument' }));
    expect(await screen.findByText('Instrument not added: Conflict')).toBeTruthy();
    expect(screen.getByText('XRPUSDT is halted on binance.')).toBeTruthy();
  });

  it('adds an instrument', async () => {
    const api = mockApi({
      'GET /api/v1/admin/instruments': LIST,
      'POST /api/v1/admin/instruments': json(201, XRP),
    });
    const { session, user } = await signedIn('admin');
    renderApp('/admin/instruments', session, user);
    const u = await openForm();
    await u.selectOptions(screen.getByLabelText('Venue'), 'coinbase');
    await u.type(screen.getByLabelText('Venue symbol'), 'XRP-USD');
    await u.type(screen.getByLabelText('Base asset'), 'XRP');
    await u.type(screen.getByLabelText('Quote asset'), 'USD');
    await u.selectOptions(screen.getByLabelText('Role'), 'reference');
    await u.click(screen.getByLabelText('Store raw trades'));
    await u.click(screen.getByRole('button', { name: 'Add instrument' }));
    expect(await screen.findByText('XRP · Binance XRP/USDT added')).toBeTruthy();
    expect(api.find('POST', '/api/v1/admin/instruments')[0]!.body).toMatchObject({
      venue: 'coinbase',
      venueSymbol: 'XRP-USD',
      role: 'reference',
      storeRawTrades: false,
    });
  });

  it('reports when the instruments cannot be loaded', async () => {
    mockApi({ 'GET /api/v1/admin/instruments': problem(500, 'The database is unreachable.') });
    const { session, user } = await signedIn('admin');
    renderApp('/admin/instruments', session, user);
    expect(await screen.findByText('Instruments could not be loaded')).toBeTruthy();
    expect(screen.getByText('The database is unreachable.')).toBeTruthy();
  });

  it('is not offered to other roles', async () => {
    mockApi({ 'GET /api/v1/instruments': [], 'GET /api/v1/system/health': health([]) });
    const { session, user } = await signedIn('analyst');
    renderApp('/admin/instruments', session, user);
    expect(await screen.findByRole('heading', { name: 'Command Center' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Instruments' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Market Activity' })).toBeTruthy();
  });
});
