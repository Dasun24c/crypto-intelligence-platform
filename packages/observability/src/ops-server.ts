import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HealthStatus } from '@cip/contracts';

export interface Readiness {
  status: HealthStatus;
  detail: string;
}

export interface OpsServerOptions {
  port: number;
  host?: string;
  metrics?: (req: IncomingMessage, res: ServerResponse) => void;
  /** Readiness: `down` answers 503 so Docker and orchestrators can react. */
  readiness: () => Promise<Readiness>;
}

/**
 * Internal HTTP endpoint on every service: `/healthz` (liveness), `/readyz` (readiness) and
 * `/metrics` (Prometheus). It is never routed through Caddy.
 */
export async function startOpsServer(opts: OpsServerOptions): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (path === '/healthz') {
      json(res, 200, { status: 'ok' });
      return;
    }
    if (path === '/readyz') {
      opts.readiness().then(
        (r) => json(res, r.status === 'down' ? 503 : 200, r),
        (err: unknown) =>
          json(res, 503, { status: 'down', detail: err instanceof Error ? err.message : 'error' }),
      );
      return;
    }
    if (path === '/metrics' && opts.metrics) {
      opts.metrics(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => resolve());
  });
  return server;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
