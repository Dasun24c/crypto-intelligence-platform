import { z } from 'zod';
import { TsSchema } from './common.js';
import { FeedStatusSchema } from './market.js';

export const HEALTH_STATUSES = ['ok', 'degraded', 'down'] as const;
export const HealthStatusSchema = z.enum(HEALTH_STATUSES);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const SERVICE_NAMES = ['api', 'ingestor', 'analyzer', 'jobs'] as const;
export const ServiceNameSchema = z.enum(SERVICE_NAMES);
export type ServiceName = z.infer<typeof ServiceNameSchema>;

/** Written by every service instance to Redis every few seconds, with a TTL (architecture §16). */
export const ServiceHeartbeatSchema = z.object({
  service: ServiceNameSchema,
  instance: z.string(),
  version: z.string(),
  startedAt: TsSchema,
  sentAt: TsSchema,
  status: HealthStatusSchema,
  /** Short human-readable state, e.g. "idle: no feeds configured". */
  detail: z.string(),
});
export type ServiceHeartbeat = z.infer<typeof ServiceHeartbeatSchema>;

export const DependencyHealthSchema = z.object({
  name: z.enum(['database', 'redis']),
  status: HealthStatusSchema,
  latencyMs: z.number().nullable(),
  detail: z.string(),
});
export type DependencyHealth = z.infer<typeof DependencyHealthSchema>;

export const ServiceHealthSchema = z.object({
  service: ServiceNameSchema,
  status: HealthStatusSchema,
  instances: z.array(ServiceHeartbeatSchema.extend({ ageMs: z.number() })),
});
export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;

/** `GET /system/health` */
export const SystemHealthSchema = z.object({
  status: HealthStatusSchema,
  checkedAt: TsSchema,
  dependencies: z.array(DependencyHealthSchema),
  services: z.array(ServiceHealthSchema),
  /** Per instrument and stream (Phase 2); a feed that is not connected makes the system degraded. */
  feeds: z.array(FeedStatusSchema),
});
export type SystemHealth = z.infer<typeof SystemHealthSchema>;

/** A heartbeat older than this marks the instance as down. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_STALE_MS = 15_000;
