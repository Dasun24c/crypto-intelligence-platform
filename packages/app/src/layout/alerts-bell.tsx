import { Link } from '@tanstack/react-router';
import { Bell } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@cip/ui';
import { formatInstant } from '../lib/format.js';
import { useAlerts } from '../live/alerts.js';
import { useDisplayTimeZone } from '../session.js';

/** The header's bell: the unread count, and the latest alerts one click away (Phase 8). */
export function AlertsBell() {
  const { unread, items, markRead, markAllRead } = useAlerts();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const timeZone = useDisplayTimeZone();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const label = unread === 0 ? 'Alerts, none unread' : `Alerts, ${unread} unread`;
  return (
    <div ref={root} className="relative">
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        data-unread={unread}
      >
        <Bell className="size-4" aria-hidden />
        {unread > 0 ? (
          <span className="rounded-full bg-accent px-1.5 text-xs font-semibold text-accent-fg" aria-hidden>
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Latest alerts"
          className="absolute right-0 z-20 mt-2 w-96 rounded-md border border-border-strong bg-surface-2 p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg">Alerts</h2>
            <Button variant="ghost" size="sm" disabled={unread === 0} onClick={() => void markAllRead()}>
              Mark all read
            </Button>
          </div>
          {items.length === 0 ? (
            <p className="py-4 text-sm text-fg-muted">No alerts yet. Create rules in the Alert Center.</p>
          ) : (
            <ul className="max-h-96 space-y-1 overflow-y-auto">
              {items.slice(0, 8).map((n) => (
                <li key={n.id} data-notification-id={n.id} data-read={n.readAt !== null}>
                  <button
                    type="button"
                    className="w-full rounded px-2 py-1.5 text-left hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-focus"
                    onClick={() => void markRead(n.id)}
                  >
                    <span className="flex items-baseline gap-2">
                      {n.readAt === null ? (
                        <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="unread" />
                      ) : null}
                      <span className="text-sm text-fg">{n.event.title}</span>
                    </span>
                    <span className="block text-xs text-fg-muted">
                      {formatInstant(n.event.firedAt, timeZone)}
                      {n.event.late ? ' · late' : ''} · {n.event.ruleName}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Link
            to="/alerts"
            className="mt-2 block text-sm text-accent hover:underline"
            onClick={() => setOpen(false)}
          >
            Open the Alert Center
          </Link>
        </div>
      ) : null}
    </div>
  );
}
