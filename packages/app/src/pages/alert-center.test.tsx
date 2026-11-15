import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AlertRule, type AlertRuleTestResult, channels, type Notification } from '@cip/contracts';
import { SEEN_UNTIL_KEY } from '../live/alerts.js';
import { type ApiRequest, mockApi, renderApp, signedIn } from '../test/harness.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const T = Date.UTC(2026, 10, 12, 10, 0);
const RULE_ID = '019a7000-0000-7000-8000-0000000000a1';

function notification(n: number, extra: Partial<Notification> = {}): Notification {
  return {
    id: `019a7000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    createdAt: T + n * 1000,
    readAt: null,
    event: {
      id: `019a7000-0000-7000-8000-${String(100 + n).padStart(12, '0')}`,
      ruleId: RULE_ID,
      ruleName: 'Halts',
      firedAt: T + n * 1000,
      severity: 'critical',
      title: `Alert ${n}`,
      body: `Body ${n}`,
      instrumentId: null,
      sourceRefs: {},
      late: false,
    },
    ...extra,
  };
}
const fired = (n: Notification, channelsAsked: ('desktop' | 'web')[], quiet = false) => ({
  notification: n,
  channels: channelsAsked,
  quiet,
});

const RULE: AlertRule = {
  id: RULE_ID,
  ownerId: 'user-1',
  name: 'Halts',
  enabled: true,
  scope: {},
  condition: { kind: 'feed_health', events: ['halted'] },
  severity: 'critical',
  cooldownSec: 300,
  channels: ['in_app', 'desktop'],
  quietHours: null,
  version: 1,
  createdAt: T,
  updatedAt: T,
};

function api(inbox: Notification[] = [], extra: Record<string, unknown> = {}) {
  return mockApi({
    'GET /api/v1/notifications': {
      items: inbox,
      nextCursor: null,
      unread: inbox.filter((n) => n.readAt === null).length,
    },
    'GET /api/v1/alerts/rules': [RULE],
    'GET /api/v1/alerts/events': { items: inbox.map((n) => n.event), nextCursor: null },
    'GET /api/v1/instruments': [],
    ...extra,
  });
}

const bell = () => screen.getByRole('button', { name: /^Alerts, / });

describe('alerts in the app (Phase 8)', () => {
  it('shows a live alert as a native notification when its rule asks for this app, never when quiet', async () => {
    api();
    const notify = vi.fn(() => Promise.resolve());
    const { session, server, user } = await signedIn('viewer', { platform: { kind: 'desktop', notify } });
    renderApp('/', session, user);
    await waitFor(() => expect(server.subscribed()).toContain(channels.alerts));
    server.push(channels.alerts, 'alert.fired', fired(notification(1), ['desktop']));
    server.push(channels.alerts, 'alert.fired', fired(notification(2), ['desktop'], true));
    server.push(channels.alerts, 'alert.fired', fired(notification(3), ['web']));
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Alerts, 3 unread'));
    expect(notify.mock.calls).toEqual([[{ title: 'Alert 1', body: 'Body 1' }]]);
  });

  it('summarises alerts missed while away in one notification, replayed or not (criterion 8.4)', async () => {
    api();
    const notify = vi.fn(() => Promise.resolve());
    const { session, server, user } = await signedIn('viewer', { platform: { kind: 'desktop', notify } });
    renderApp('/', session, user);
    await waitFor(() => expect(server.subscribed()).toContain(channels.alerts));
    server.push(channels.alerts, 'alert.fired', fired(notification(1), ['desktop']));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));

    // Back after a short drop: three alerts replayed, one summary.
    server.resyncReplays[channels.alerts] = [2, 3, 4].map((n) => ({
      type: 'alert.fired',
      data: fired(notification(n), ['desktop']),
    }));
    const socket = server.sockets.last;
    act(() => socket.drop());
    act(() => socket.open());
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(notify.mock.calls[1]).toEqual([
      { title: '3 alerts while you were away', body: 'They are in the Alert Center.' },
    ]);
    expect(bell().getAttribute('aria-label')).toBe('Alerts, 4 unread');

    // Away too long to replay: the snapshot's unread count says how many arrived.
    delete server.resyncReplays[channels.alerts];
    server.resyncSnapshots[channels.alerts] = { unread: 6, latest: [notification(5), notification(6)] };
    act(() => socket.drop());
    act(() => socket.open());
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(3));
    expect(notify.mock.calls[2]).toEqual([
      { title: '2 alerts while you were away', body: 'They are in the Alert Center.' },
    ]);
  });

  it('summarises, when the desktop app starts, the unread alerts that arrived since it last ran', async () => {
    localStorage.setItem(SEEN_UNTIL_KEY, String(T + 1_500));
    api([notification(1), notification(2), notification(3, { readAt: T + 4_000 })]);
    const notify = vi.fn(() => Promise.resolve());
    const { session, user } = await signedIn('viewer', { platform: { kind: 'desktop', notify } });
    renderApp('/', session, user);
    // Alert 2 is unread and newer than the last run; alert 1 is older; alert 3 was read.
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0]).toEqual([
      { title: '1 alert while you were away', body: 'They are in the Alert Center.' },
    ]);
  });

  it('marks alerts read from the bell, and follows reads made on another device', async () => {
    const { find } = api([notification(1), notification(2)], {
      [`POST /api/v1/notifications/${notification(2).id}/read`]: new Response(null, { status: 204 }),
    });
    const { session, server, user } = await signedIn();
    renderApp('/', session, user);
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Alerts, 2 unread'));
    await userEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Latest alerts' });
    await userEvent.click(within(panel).getByText('Alert 2'));
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Alerts, 1 unread'));
    expect(find('POST', `/api/v1/notifications/${notification(2).id}/read`)).toHaveLength(1);
    server.push(channels.alerts, 'notification.read', { ids: [notification(1).id] });
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Alerts, none unread'));
  });

  it('creates a rule from the form, as the contract defines it, and tests one on the last 24 hours', async () => {
    const result: AlertRuleTestResult = {
      ruleId: RULE_ID,
      from: T - 86_400_000,
      to: T,
      evaluated: 5,
      suppressed: 1,
      wouldHaveFired: [
        {
          at: T - 3_600_000,
          title: 'ETH: feed halted',
          body: '',
          dedupeKey: 'feed:halted:1',
          instrumentId: null,
          sourceRefs: {},
        },
      ],
      note: null,
    };
    const { find } = api([], {
      'POST /api/v1/alerts/rules': (r: ApiRequest) => ({ ...RULE, ...(r.body as object), id: 'new' }),
      [`POST /api/v1/alerts/rules/${RULE_ID}/test`]: result,
    });
    const { session, user } = await signedIn();
    renderApp('/alerts', session, user);
    expect(await screen.findByRole('heading', { name: 'Alert Center', level: 1 })).toBeTruthy();
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`li[data-rule-id="${RULE_ID}"]`);
      if (!el) throw new Error('the rule is not listed yet');
      return el;
    });
    expect(within(row).getByText(/^Feed halted · all instruments$/)).toBeTruthy();

    await userEvent.click(within(row).getByRole('button', { name: 'Test Halts on the last 24 hours' }));
    expect(
      await within(row).findByText(
        /would have fired once \(1 more dropped by its cooldown\), from 5 events checked/,
      ),
    ).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'New rule' }));
    const form = screen.getByRole('form', { name: 'New alert rule' });
    await userEvent.type(within(form).getByLabelText('Name'), 'Big BTC buys');
    await userEvent.selectOptions(within(form).getByLabelText('Alert me on'), 'large_trade');
    await userEvent.clear(within(form).getByLabelText('At least (USD, optional)'));
    await userEvent.type(within(form).getByLabelText('At least (USD, optional)'), '2000000');
    await userEvent.click(within(form).getByLabelText('buy'));
    await userEvent.click(within(form).getByLabelText('In the browser'));
    await userEvent.click(within(form).getByRole('button', { name: 'Create rule' }));
    await waitFor(() => expect(find('POST', '/api/v1/alerts/rules')).toHaveLength(1));
    expect(find('POST', '/api/v1/alerts/rules')[0]!.body).toEqual({
      name: 'Big BTC buys',
      enabled: true,
      scope: {},
      condition: { kind: 'large_trade', minUsd: '2000000', sides: ['buy'] },
      severity: 'info',
      cooldownSec: 300,
      channels: ['in_app', 'desktop'],
      quietHours: null,
    });
  });

  it('refuses an invalid rule with the contract’s reason, before sending it', async () => {
    const { find } = api();
    const { session, user } = await signedIn();
    renderApp('/alerts', session, user);
    await userEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    const form = screen.getByRole('form', { name: 'New alert rule' });
    await userEvent.click(within(form).getByRole('button', { name: 'Create rule' }));
    expect(await within(form).findByText(/^name: /)).toBeTruthy();
    expect(find('POST', '/api/v1/alerts/rules')).toHaveLength(0);
  });
});
