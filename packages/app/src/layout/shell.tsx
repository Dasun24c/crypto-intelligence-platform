import { Link, Outlet } from '@tanstack/react-router';
import {
  Activity,
  ChartCandlestick,
  ChartLine,
  Coins,
  LayoutDashboard,
  LogOut,
  ScrollText,
  Tags,
  UserCircle,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useSyncExternalStore, type ComponentType } from 'react';
import { type Capability, can } from '@cip/contracts';
import { Badge, Button, cn } from '@cip/ui';
import { LiveConnectionBadge } from '../components/market-badges.js';
import { useCurrentUser, useSession } from '../session.js';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  capability?: Capability;
  /** Development tools only (Platform.devTools). */
  dev?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Command Center', icon: LayoutDashboard },
  { to: '/market', label: 'Market Activity', icon: ChartCandlestick },
  { to: '/analysis', label: 'Technical Analysis', icon: ChartLine, capability: 'dashboards.view' },
  { to: '/system', label: 'System Health', icon: Activity },
  { to: '/admin/instruments', label: 'Instruments', icon: Coins, capability: 'instruments.manage' },
  { to: '/admin/users', label: 'Users', icon: Users, capability: 'users.manage' },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText, capability: 'audit.view' },
  { to: '/profile', label: 'Profile', icon: UserCircle },
  { to: '/dev/labelling', label: 'Fixture labelling', icon: Tags, capability: 'fixtures.label', dev: true },
];

function subscribeOnline(callback: () => void) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

function ConnectionStatus() {
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine);
  return online ? (
    <Badge tone="ok">
      <Wifi className="size-3.5" aria-hidden /> Online
    </Badge>
  ) : (
    <Badge tone="crit">
      <WifiOff className="size-3.5" aria-hidden /> Offline
    </Badge>
  );
}

export function Shell() {
  const session = useSession();
  const user = useCurrentUser();
  return (
    <div className="flex min-h-screen">
      <nav aria-label="Main" className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        <div className="px-4 py-4 text-sm font-semibold tracking-wide">Crypto Intelligence</div>
        <ul className="flex-1 space-y-0.5 px-2">
          {NAV.filter(
            (item) =>
              (!item.capability || can(user.role, item.capability)) &&
              (!item.dev || session.platform.devTools),
          ).map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                activeOptions={{ exact: item.to === '/' }}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg',
                )}
                activeProps={{ className: 'bg-surface-3 text-fg', 'aria-current': 'page' }}
              >
                <item.icon className="size-4" aria-hidden />
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        {/* fg-muted, not fg-subtle: small text needs 4.5:1 contrast on the surface (WCAG 1.4.3). */}
        <p className="px-4 py-3 text-xs text-fg-muted">v{session.platform.appVersion}</p>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center justify-end gap-3 border-b border-border px-4">
          <ConnectionStatus />
          <LiveConnectionBadge />
          <span className="text-sm text-fg-muted">{user.displayName}</span>
          <Badge tone="info">{user.role}</Badge>
          <Button variant="ghost" size="sm" onClick={() => void session.logout()}>
            <LogOut className="size-4" aria-hidden /> Sign out
          </Button>
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
