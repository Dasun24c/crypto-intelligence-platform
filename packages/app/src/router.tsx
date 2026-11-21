import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { type Capability, can, type Tf, type UserSummary } from '@cip/contracts';
import { Shell } from './layout/shell.js';
import { isTimeframe } from './lib/analysis.js';
import { readAiSearch, readLiquiditySearch, readPracticeSearch, readScannerSearch } from './lib/search.js';
import { AdminAuditPage } from './pages/admin-audit.js';
import { AdminInstrumentsPage } from './pages/admin-instruments.js';
import { AdminUsersPage } from './pages/admin-users.js';
import { HomePage } from './pages/home.js';
import { LabellingPage } from './pages/labelling.js';
import { MarketActivityPage } from './pages/market-activity.js';
import { ProfilePage } from './pages/profile.js';
import { SystemHealthPage } from './pages/system-health.js';

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
    component: lazyRouteComponent(() => import('./pages/technical-analysis.js'), 'TechnicalAnalysisPage'),
  }),
  // Phase 7. The chart pages load lazily, with the chart library, in their own chunks.
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/liquidity',
    beforeLoad: requireCapability('dashboards.view'),
    validateSearch: readLiquiditySearch,
    component: lazyRouteComponent(() => import('./pages/liquidity-map.js'), 'LiquidityMapPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/setups',
    beforeLoad: requireCapability('dashboards.view'),
    validateSearch: readScannerSearch,
    component: lazyRouteComponent(() => import('./pages/setup-scanner.js'), 'SetupScannerPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/setups/$setupId',
    beforeLoad: requireCapability('dashboards.view'),
    component: lazyRouteComponent(() => import('./pages/setup-detail.js'), 'SetupDetailPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/calendar',
    beforeLoad: requireCapability('dashboards.view'),
    component: lazyRouteComponent(() => import('./pages/economic-calendar.js'), 'EconomicCalendarPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/alerts',
    beforeLoad: requireCapability('alerts.own'),
    component: lazyRouteComponent(() => import('./pages/alert-center.js'), 'AlertCenterPage'),
  }),
  // Phase 11: the Whale Tracker, exchange flow and on-chain (every role; admins keep the labels).
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/whales',
    beforeLoad: requireCapability('dashboards.view'),
    component: lazyRouteComponent(() => import('./pages/whale-tracker.js'), 'WhaleTrackerPage'),
  }),
  // Phase 9: the AI Intelligence Center (every role reads; analysts and admins ask).
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/ai',
    beforeLoad: requireCapability('dashboards.view'),
    validateSearch: readAiSearch,
    component: lazyRouteComponent(() => import('./pages/ai-center.js'), 'AiCenterPage'),
  }),
  // Phase 10: the 3D brain, driven by the services' activity (every role).
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/brain',
    beforeLoad: requireCapability('dashboards.view'),
    component: lazyRouteComponent(() => import('./pages/system-brain.js'), 'SystemBrainPage'),
  }),
  // Phase 14: practice trading on the user's own practice account (every role).
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/practice',
    beforeLoad: requireCapability('practice.own'),
    validateSearch: readPracticeSearch,
    component: lazyRouteComponent(() => import('./pages/practice-trading.js'), 'PracticeTradingPage'),
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
  // Development only: the page itself checks Platform.devTools.
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/dev/labelling',
    beforeLoad: requireCapability('fixtures.label'),
    component: LabellingPage,
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
