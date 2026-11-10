import { useQuery } from '@tanstack/react-query';
import type { HealthStatus, SystemHealth } from '@cip/contracts';
import {
  Alert,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@cip/ui';
import { formatAge } from '../lib/format.js';
import { useNow, useSession } from '../session.js';

const TONE = { ok: 'ok', degraded: 'warn', down: 'crit' } as const;
const LABEL = { ok: 'OK', degraded: 'Degraded', down: 'Down' } as const;

function Status({ status }: { status: HealthStatus }) {
  return <StatusBadge tone={TONE[status]} label={LABEL[status]} />;
}

/** System Health skeleton (architecture §16): dependencies and service heartbeats, refreshed every 5 s. */
export function SystemHealthPage() {
  const { client } = useSession();
  const now = useNow();
  const health = useQuery({
    queryKey: ['system', 'health'],
    queryFn: () => client.request<SystemHealth>('GET', '/api/v1/system/health'),
    refetchInterval: 5_000,
  });

  if (health.isPending) return <Spinner label="Checking services" />;
  if (health.isError)
    return (
      <Alert tone="crit" title="System health is unavailable">
        {health.error.message}
      </Alert>
    );
  const data = health.data;
  const age = now - data.checkedAt;

  return (
    <div className="max-w-5xl space-y-6">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">System Health</h1>
        <Status status={data.status} />
        <span className="text-xs text-fg-subtle">checked {formatAge(age)} ago · refreshes every 5 s</span>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Dependencies</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Component</Th>
                <Th>Status</Th>
                <Th>Latency</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {data.dependencies.map((d) => (
                <tr key={d.name}>
                  <Td className="capitalize">{d.name}</Td>
                  <Td>
                    <Status status={d.status} />
                  </Td>
                  <Td className="font-mono">{d.latencyMs === null ? '—' : `${d.latencyMs} ms`}</Td>
                  <Td className="text-fg-muted">{d.detail}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Services</CardTitle>
          <span className="text-xs text-fg-subtle">from heartbeats; an instance silent for 15 s is down</span>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Service</Th>
                <Th>Status</Th>
                <Th>Instance</Th>
                <Th>Version</Th>
                <Th>State</Th>
                <Th>Last heartbeat</Th>
              </tr>
            </thead>
            <tbody>
              {data.services.flatMap((s) =>
                s.instances.length === 0
                  ? [
                      <tr key={s.service}>
                        <Td>{s.service}</Td>
                        <Td>
                          <Status status={s.status} />
                        </Td>
                        <Td colSpan={4} className="text-fg-muted">
                          No running instance
                        </Td>
                      </tr>,
                    ]
                  : s.instances.map((i) => (
                      <tr key={`${s.service}:${i.instance}`}>
                        <Td>{s.service}</Td>
                        <Td>
                          <Status status={i.status} />
                        </Td>
                        <Td className="font-mono text-xs">{i.instance}</Td>
                        <Td className="font-mono text-xs">{i.version}</Td>
                        <Td className="text-fg-muted">{i.detail}</Td>
                        <Td className="font-mono">{formatAge(i.ageMs)} ago</Td>
                      </tr>
                    )),
              )}
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
