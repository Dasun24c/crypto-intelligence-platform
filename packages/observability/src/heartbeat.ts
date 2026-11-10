import type { Redis } from 'ioredis';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  type HealthStatus,
  type ServiceHeartbeat,
  ServiceHeartbeatSchema,
  type ServiceName,
} from '@cip/contracts';
import type { Logger } from './logger.js';

const INDEX_KEY = 'hb:index';
const RETAIN_MS = 60 * 60 * 1000;
const heartbeatKey = (member: string) => `hb:${member}`;

export interface HeartbeatProbe {
  status: Exclude<HealthStatus, 'down'>;
  detail: string;
}

export interface HeartbeatIdentity {
  service: ServiceName;
  instance: string;
  version: string;
  startedAt: number;
}

/**
 * Publishes this instance's heartbeat to Redis every HEARTBEAT_INTERVAL_MS. The System Health page
 * reads these, so it works without Prometheus (architecture §16).
 */
export class HeartbeatPublisher {
  private timer: NodeJS.Timeout | undefined;
  private readonly member: string;

  constructor(
    private readonly redis: Redis,
    private readonly id: HeartbeatIdentity,
    private readonly probe: () => HeartbeatProbe | Promise<HeartbeatProbe>,
    private readonly log?: Logger,
  ) {
    this.member = `${id.service}:${id.instance}`;
  }

  start(): void {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  async beat(now = Date.now()): Promise<void> {
    try {
      const probe = await this.probe();
      const heartbeat: ServiceHeartbeat = { ...this.id, sentAt: now, ...probe };
      await this.redis
        .multi()
        .set(heartbeatKey(this.member), JSON.stringify(heartbeat), 'PX', HEARTBEAT_STALE_MS * 4)
        .zadd(INDEX_KEY, now, this.member)
        .exec();
    } catch (err) {
      this.log?.warn({ err }, 'heartbeat publish failed');
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.redis
      .multi()
      .del(heartbeatKey(this.member))
      .zrem(INDEX_KEY, this.member)
      .exec()
      .catch(() => undefined);
  }
}

/** Heartbeats seen in the last hour, newest first; entries with expired keys are skipped. */
export async function readHeartbeats(redis: Redis, now = Date.now()): Promise<ServiceHeartbeat[]> {
  await redis.zremrangebyscore(INDEX_KEY, '-inf', now - RETAIN_MS);
  const members = await redis.zrevrangebyscore(INDEX_KEY, '+inf', now - RETAIN_MS);
  if (members.length === 0) return [];
  const values = await redis.mget(...members.map(heartbeatKey));
  const out: ServiceHeartbeat[] = [];
  for (const value of values) {
    if (!value) continue;
    const parsed = ServiceHeartbeatSchema.safeParse(JSON.parse(value));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** An instance whose last heartbeat is older than HEARTBEAT_STALE_MS is considered down. */
export function effectiveStatus(hb: ServiceHeartbeat, now = Date.now()): HealthStatus {
  return now - hb.sentAt > HEARTBEAT_STALE_MS ? 'down' : hb.status;
}
