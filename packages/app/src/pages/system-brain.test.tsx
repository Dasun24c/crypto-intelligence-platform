import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ActivitySnapshot, channels, emptyActivitySnapshot } from '@cip/contracts';
import { BTC_BINANCE, BTC_COINBASE, INSTRUMENTS } from '../test/fixtures.js';
import { mockApi, renderApp, signedIn } from '../test/harness.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const ACTIVITY = channels.systemActivity;

function activity(over: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  const empty = emptyActivitySnapshot(Date.now());
  return {
    ...empty,
    ingest: { msgsPerSec: 240.5, perVenue: { binance: 200.5, coinbase: 40 }, state: 'ok' },
    ...over,
  };
}

async function brainPage(snapshot: ActivitySnapshot | null = activity()) {
  mockApi({ 'GET /api/v1/instruments': INSTRUMENTS });
  const { session, server, user } = await signedIn('viewer');
  if (snapshot) server.snapshots[ACTIVITY] = snapshot;
  renderApp('/brain', session, user);
  await screen.findByRole('heading', { name: 'System Brain' });
  await waitFor(() => expect(server.subscribed()).toContain(ACTIVITY));
  const status = () => within(screen.getByRole('region', { name: 'Status' }));
  return { server, status };
}

describe('System Brain (Phase 10)', () => {
  it('says what the platform is doing in words beside the view, from the activity snapshot (10.4)', async () => {
    const { status } = await brainPage();
    await waitFor(() => expect(status().getByText('Receiving data')).toBeTruthy());
    expect(status().getByText('241 venue messages a second.')).toBeTruthy();
    expect(
      status().getByText(/241 venue messages a second \(Binance 201, Coinbase 40\); every venue connected/),
    ).toBeTruthy();
    expect(status().getByText(/0 candles a second; 0 analysing, 0 waiting, 0 held back/)).toBeTruthy();
    expect(status().getByText('no call in progress; none yet')).toBeTruthy();
    expect(status().getByText('0 fired in the last minute')).toBeTruthy();
    expect(status().getByText('None')).toBeTruthy();
    // The state is announced politely, by itself.
    expect(screen.getByRole('status', { name: '' }).textContent).toBe('System brain: Receiving data');
    // jsdom draws nothing: without WebGL2 the 2D view stands in, with a meter per region.
    expect(screen.getByText(/WebGL2 is not available/)).toBeTruthy();
    const meters = screen.getAllByRole('meter');
    expect(meters.map((m) => m.getAttribute('aria-label'))).toEqual([
      'Ingestion activity',
      'Analysis activity',
      'AI activity',
      'Alerts activity',
    ]);
    expect(Number(meters[0]!.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
    expect(screen.getByText('2D view: no animation.')).toBeTruthy();
    // Nothing to animate in 2D: the animation controls are off.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Pause animation' }).disabled).toBe(true);
  });

  it('follows injected activity: analysing, a pulse with its instrument, an error, then the connection lost (10.1)', async () => {
    const { server, status } = await brainPage();
    await waitFor(() => expect(status().getByText('Receiving data')).toBeTruthy());

    server.push(
      ACTIVITY,
      'activity.snapshot',
      activity({
        analysis: { candlesPerSec: 3, activeJobs: 2, backlog: 1, paused: 0 },
        ai: { inflight: 1, queued: 2, lastCompletedAt: Date.now() - 120_000, lastResult: 'accepted' },
      }),
    );
    await waitFor(() => expect(status().getByText('Analysing')).toBeTruthy());
    expect(status().getByText('2 instruments analysing; 1 AI call in progress.')).toBeTruthy();
    expect(status().getByText(/a call in progress, 2 waiting; the last accepted 2 min ago/)).toBeTruthy();

    server.push(ACTIVITY, 'activity.pulse', {
      ts: Date.now(),
      kind: 'pattern',
      refId: 's1',
      instrumentId: BTC_BINANCE.id,
    });
    server.push(ACTIVITY, 'activity.pulse', {
      ts: Date.now(),
      kind: 'sweep',
      refId: 'w1',
      instrumentId: BTC_COINBASE.id,
    });
    server.push(ACTIVITY, 'activity.pulse', { ts: Date.now(), kind: 'alert', refId: '9-0' });
    // A pulse that does not match the contract is ignored.
    server.push(ACTIVITY, 'activity.pulse', { kind: 'random' });
    await waitFor(() => expect(status().getByText(/Alert fired$/)).toBeTruthy());
    const latest = [...document.querySelectorAll('[data-brain-pulses] li')].map((li) => li.textContent);
    expect(latest).toHaveLength(3);
    expect(latest[0]).toMatch(/Alert fired$/);
    expect(latest[1]).toMatch(/Sweep on Coinbase BTC\/USD$/);
    expect(latest[2]).toMatch(/Setup change on Binance BTC\/USDT$/);

    server.push(
      ACTIVITY,
      'activity.snapshot',
      activity({
        errors: [
          { component: 'ingestor', severity: 'critical', detail: 'no instance is running' },
          { component: 'analyzer', severity: 'warning', detail: '1 paused on a data gap' },
        ],
      }),
    );
    await waitFor(() => expect(status().getByText('Error')).toBeTruthy());
    expect(status().getByText('The ingestor: no instance is running.')).toBeTruthy();
    expect(status().getByText('The ingestor (critical): no instance is running')).toBeTruthy();
    expect(status().getByText('The analyzer: 1 paused on a data gap')).toBeTruthy();
    // Ingestion shows the problem; the analyzer's warning shows in analysis and alerts.
    expect(screen.getAllByText(/ %, problem$/)).toHaveLength(1);
    expect(screen.getAllByText(/ %, warning$/)).toHaveLength(2);

    act(() => server.sockets.last.drop());
    await waitFor(() => expect(status().getByText('Disconnected')).toBeTruthy());
    expect(status().getByText('The live connection is down.')).toBeTruthy();
    expect(screen.getByRole('status', { name: '' }).textContent).toBe('System brain: Disconnected');
  });

  it('waits for its first report, and remembers the view and quality chosen in this browser', async () => {
    window.localStorage.setItem('cip.brain.quality', 'medium');
    window.localStorage.setItem('cip.brain.view', 'holographic');
    const { status } = await brainPage(null);
    expect(status().getByText('Disconnected')).toBeTruthy();
    expect(status().getByText('Waiting for the first activity report.')).toBeTruthy();
    expect(screen.getAllByRole('meter').every((m) => m.getAttribute('aria-valuenow') === '0')).toBe(true);

    // A stored choice that is not one falls back to the default.
    expect(screen.getByLabelText<HTMLSelectElement>('View').value).toBe('3d');
    const quality = screen.getByLabelText<HTMLSelectElement>('Quality');
    expect(quality.value).toBe('medium');
    // Nothing is drawn in 2D: the quality is not for choosing then.
    expect(quality.disabled).toBe(true);
    const u = userEvent.setup();
    await u.selectOptions(screen.getByLabelText('View'), '2d');
    expect(window.localStorage.getItem('cip.brain.view')).toBe('2d');
    // Chosen, the 2D view needs no explanation.
    expect(screen.queryByText(/WebGL2 is not available/)).toBeNull();
    expect(screen.getByRole('link', { name: 'System Brain' }).getAttribute('href')).toBe('/brain');
  });
});
