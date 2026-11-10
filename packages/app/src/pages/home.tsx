import { Link } from '@tanstack/react-router';
import { Alert, Card, CardContent, CardHeader, CardTitle } from '@cip/ui';
import { useCurrentUser } from '../session.js';

/**
 * The Command Center fills up phase by phase. Until a feature exists it says so plainly: the platform
 * never shows placeholder numbers that could be mistaken for market data.
 */
const ROADMAP: [string, string][] = [
  ['Live market data (Binance, Coinbase, PAXG)', 'Phase 2'],
  ['Technical indicators', 'Phase 3'],
  ['Smart Money Concepts: structure, liquidity, points of interest, setups', 'Phases 4–6'],
  ['Liquidity Map, Setup Scanner, economic calendar', 'Phase 7'],
  ['Alerts and notifications', 'Phase 8'],
  ['AI analysis (Grok)', 'Phase 9'],
];

export function HomePage() {
  const user = useCurrentUser();
  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Command Center</h1>
        <p className="text-sm text-fg-muted">Signed in as {user.email}.</p>
      </header>
      <Alert tone="info" title="No market data is connected yet">
        This build is the platform foundation: sign-in, roles, audit log and system health.{' '}
        <Link to="/system" className="text-accent underline">
          See the services&apos; live status
        </Link>
        .
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>What arrives next</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border text-sm">
            {ROADMAP.map(([feature, phase]) => (
              <li key={feature} className="flex justify-between gap-4 py-2">
                <span>{feature}</span>
                <span className="shrink-0 text-fg-subtle">{phase}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
