import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type AlertFiredMessage,
  AlertFiredMessageSchema,
  AlertsSnapshotSchema,
  channels,
  type Notification,
  NotificationPageSchema,
  NotificationReadMessageSchema,
} from '@cip/contracts';
import { useSession } from '../session.js';
import { useChannel } from './hooks.js';

/** What the header's bell and the Alert Center read (Phase 8, ADR 020). */
export interface AlertsApi {
  /** The user's unread inbox items. */
  unread: number;
  /** The latest inbox items, newest first. */
  items: readonly Notification[];
  loaded: boolean;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const AlertsContext = createContext<AlertsApi | null>(null);
const LATEST = 50;
/** Desktop: when this app last followed the user's alerts, to summarise what arrived while it was closed. */
export const SEEN_UNTIL_KEY = 'cip.alerts.seenUntil';

function readSeenUntil(): number | null {
  try {
    const v = Number(localStorage.getItem(SEEN_UNTIL_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
function writeSeenUntil(ms: number): void {
  try {
    localStorage.setItem(SEEN_UNTIL_KEY, String(ms));
  } catch {
    // Storage unavailable: the next start shows no summary.
  }
}

/** Newest first, one per id; `incoming` wins over what was there. */
function merge(incoming: readonly Notification[], existing: readonly Notification[]): Notification[] {
  const byId = new Map<string, Notification>();
  for (const n of [...existing, ...incoming]) byId.set(n.id, n);
  return [...byId.values()]
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
    .slice(0, LATEST);
}

/**
 * The signed-in user's alerts: the inbox and the `alerts` channel. A live `alert.fired` that is not
 * quiet and names this app's channel (`desktop` in the desktop app, `web` in a browser) becomes a
 * native notification. Alerts that arrived while the app was away are not shown one by one: the
 * desktop app shows one summary (criterion 8.4) after reconnecting, or when it starts.
 */
export function AlertsProvider({ children }: { children: ReactNode }) {
  const { client, platform } = useSession();
  const [state, setState] = useState<{ unread: number; items: Notification[]; loaded: boolean }>({
    unread: 0,
    items: [],
    loaded: false,
  });
  const missed = useRef(0);
  const native = platform.kind === 'desktop' ? 'desktop' : 'web';
  const wants = useCallback((m: AlertFiredMessage) => m.channels.includes(native), [native]);

  const summarise = useCallback(
    (n: number) => {
      if (n <= 0 || platform.kind !== 'desktop') return;
      void platform.notify({
        title: n === 1 ? '1 alert while you were away' : `${n} alerts while you were away`,
        body: 'They are in the Alert Center.',
      });
    },
    [platform],
  );

  useEffect(() => {
    let cancelled = false;
    void client
      .request<unknown>('GET', `/api/v1/notifications?limit=${LATEST}`)
      .then((raw) => {
        const page = NotificationPageSchema.safeParse(raw);
        if (cancelled || !page.success) return;
        setState((prev) => ({
          unread: page.data.unread,
          items: merge(page.data.items, prev.items),
          loaded: true,
        }));
        // Desktop: unread alerts that arrived since this app last followed them, in one summary.
        const since = readSeenUntil();
        if (since !== null)
          summarise(page.data.items.filter((n) => n.readAt === null && n.createdAt > since).length);
        writeSeenUntil(Date.now());
      })
      .catch(() => undefined);
    const timer = setInterval(() => writeSeenUntil(Date.now()), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, summarise]);

  useChannel(channels.alerts, {
    onSnapshot: (raw) => {
      const snap = AlertsSnapshotSchema.safeParse(raw);
      if (!snap.success) return;
      setState((prev) => {
        // A resync that could not replay: the unread count says how many arrived meanwhile.
        if (prev.loaded) missed.current += Math.max(0, snap.data.unread - prev.unread);
        return { unread: snap.data.unread, items: merge(snap.data.latest, prev.items), loaded: true };
      });
    },
    onMessage: (message, meta) => {
      if (message.type === 'alert.fired') {
        const fired = AlertFiredMessageSchema.safeParse(message.data);
        if (!fired.success) return;
        const n = fired.data.notification;
        setState((prev) => {
          const known = prev.items.some((i) => i.id === n.id);
          return {
            ...prev,
            unread: known || n.readAt !== null ? prev.unread : prev.unread + 1,
            items: merge([n], prev.items),
          };
        });
        writeSeenUntil(Date.now());
        if (meta.resync) {
          if (wants(fired.data)) missed.current++;
        } else if (!fired.data.quiet && wants(fired.data)) {
          void platform.notify({ title: n.event.title, body: n.event.body });
        }
      } else if (message.type === 'notification.read') {
        const read = NotificationReadMessageSchema.safeParse(message.data);
        if (!read.success) return;
        const now = message.ts;
        setState((prev) => {
          const hit = (n: Notification) =>
            n.readAt === null &&
            ('ids' in read.data ? read.data.ids.includes(n.id) : n.createdAt <= read.data.before);
          const changed = prev.items.filter(hit).length;
          return {
            ...prev,
            unread:
              'ids' in read.data
                ? Math.max(0, prev.unread - changed)
                : prev.items.filter((n) => n.readAt === null && !hit(n)).length,
            items: prev.items.map((n) => (hit(n) ? { ...n, readAt: now } : n)),
          };
        });
      }
    },
    onResynced: () => {
      const n = missed.current;
      missed.current = 0;
      summarise(n);
    },
  });

  const markRead = useCallback(
    async (id: string) => {
      await client.request('POST', `/api/v1/notifications/${id}/read`);
      setState((prev) => {
        const was = prev.items.find((n) => n.id === id);
        return {
          ...prev,
          unread: was && was.readAt === null ? Math.max(0, prev.unread - 1) : prev.unread,
          items: prev.items.map((n) => (n.id === id && n.readAt === null ? { ...n, readAt: Date.now() } : n)),
        };
      });
    },
    [client],
  );
  const markAllRead = useCallback(async () => {
    const before = Date.now();
    await client.request('POST', '/api/v1/notifications/read-all', { before });
    setState((prev) => ({
      ...prev,
      unread: 0,
      items: prev.items.map((n) => (n.readAt === null ? { ...n, readAt: before } : n)),
    }));
  }, [client]);

  const api = useMemo<AlertsApi>(() => ({ ...state, markRead, markAllRead }), [state, markRead, markAllRead]);
  return <AlertsContext.Provider value={api}>{children}</AlertsContext.Provider>;
}

export function useAlerts(): AlertsApi {
  const api = useContext(AlertsContext);
  if (!api) throw new Error('useAlerts outside AlertsProvider');
  return api;
}
