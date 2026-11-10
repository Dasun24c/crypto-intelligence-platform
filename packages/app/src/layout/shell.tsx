import { Link, Outlet } from '@tanstack/react-router';
import {
  Activity,
  LayoutDashboard,
  LogOut,
  ScrollText,
  UserCircle,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useSyncExternalStore, type ComponentType } from 'react';
import { type Capability, can } from '@cip/contracts';
import { Badge, Button, cn } from '@cip/ui';
import { useCurrentUser, useSession } from '../session.js';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  capability?: Capability;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Command Center', icon: LayoutDashboard },
  { to: '/system', label: 'System Health', icon: Activity },
  { to: '/admin/users', label: 'Users', icon: Users, capability: 'users.manage' },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText, capability: 'audit.view' },
  { to: '/profile', label: 'Profile', icon: UserCircle },
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
          {NAV.filter((item) => !item.capability || can(user.role, item.capability)).map((item) => (
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
        <p className="px-4 py-3 text-xs text-fg-subtle">v{session.platform.appVersion}</p>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center justify-end gap-3 border-b border-border px-4">
          <ConnectionStatus />
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
