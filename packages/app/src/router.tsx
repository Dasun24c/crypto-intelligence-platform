import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Link,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { type Capability, can, type Tf, type UserSummary } from '@cip/contracts';
import { Shell } from './layout/shell.js';
import { isTimeframe } from './lib/analysis.js';
import { AdminAuditPage } from './pages/admin-audit.js';
import { AdminInstrumentsPage } from './pages/admin-instruments.js';
import { AdminUsersPage } from './pages/admin-users.js';
import { HomePage } from './pages/home.js';
import { MarketActivityPage } from './pages/market-activity.js';
import { ProfilePage } from './pages/profile.js';
import { SystemHealthPage } from './pages/system-health.js';
import { TechnicalAnalysisPage } from './pages/technical-analysis.js';

export interface RouterContext {
  user: UserSummary;
}

function NotFound() {
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <Link to="/" className="text-accent underline">
        Back to the Command Center
      </Link>
    </div>
  );
}

/** The UI hides what a role cannot use; the API enforces it regardless (architecture §14). */
function requireCapability(capability: Capability) {
  return ({ context }: { context: RouterContext }) => {
    // TanStack Router's redirect() returns a value designed to be thrown from beforeLoad.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (!can(context.user.role, capability)) throw redirect({ to: '/' });
  };
}

/** `/market?instrument=<id>`: which instrument Market Activity shows (deep links from the tiles). */
export interface MarketSearch {
  instrument?: string;
}

/** `/analysis?instrument=<id>&tf=<tf>`: the instrument and timeframe Technical Analysis shows. */
export interface AnalysisSearch {
  instrument?: string;
  tf?: Tf;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Shell,
  notFoundComponent: NotFound,
});

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/market',
    validateSearch: (search: Record<string, unknown>): MarketSearch =>
      typeof search['instrument'] === 'string' ? { instrument: search['instrument'] } : {},
    component: MarketActivityPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/analysis',
    beforeLoad: requireCapability('dashboards.view'),
    validateSearch: (search: Record<string, unknown>): AnalysisSearch => ({
      ...(typeof search['instrument'] === 'string' ? { instrument: search['instrument'] } : {}),
      ...(isTimeframe(search['tf']) ? { tf: search['tf'] } : {}),
    }),
    component: TechnicalAnalysisPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/system', component: SystemHealthPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/profile', component: ProfilePage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/users',
    beforeLoad: requireCapability('users.manage'),
    component: AdminUsersPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/instruments',
    beforeLoad: requireCapability('instruments.manage'),
    component: AdminInstrumentsPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/audit',
    beforeLoad: requireCapability('audit.view'),
    component: AdminAuditPage,
  }),
]);

/** The app's router; tests pass a memory history. */
export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({
    routeTree,
    // Provided for real by <RouterProvider context> once a user is signed in.
    context: { user: undefined as unknown as UserSummary },
    defaultPreload: 'intent',
    ...(options.history ? { history: options.history } : {}),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
