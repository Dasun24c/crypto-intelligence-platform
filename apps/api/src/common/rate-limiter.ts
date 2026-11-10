import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../tokens.js';

/**
 * Token bucket in Redis (one Lua call, atomic across api replicas). Refill is continuous, so
 * "20 per second, burst 60" means at most 60 at once and 20 per second sustained.
 */
const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * per_ms)
local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) / per_ms)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / per_ms) + 1000)
return { allowed, retry_ms }
`;

export interface BucketSpec {
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export interface Decision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** API contracts §8. */
export const LIMITS = {
  /** 5 per minute per IP and per account (no burst beyond 5). */
  login: { capacity: 5, refillPerSecond: 5 / 60 },
  /** REST per user: 20/s sustained, burst 60. */
  rest: { capacity: 60, refillPerSecond: 20 },
} satisfies Record<string, BucketSpec>;

@Injectable()
export class RateLimiter {
  private readonly sha: Promise<string>;

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    this.sha = redis.script('LOAD', TOKEN_BUCKET_LUA) as Promise<string>;
  }

  async take(key: string, spec: BucketSpec, now = Date.now(), cost = 1): Promise<Decision> {
    const args = [String(spec.capacity), String(spec.refillPerSecond / 1000), String(now), String(cost)];
    let reply: [number, number];
    try {
      reply = (await this.redis.evalsha(await this.sha, 1, `rl:${key}`, ...args)) as [number, number];
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('NOSCRIPT')) throw err;
      reply = (await this.redis.eval(TOKEN_BUCKET_LUA, 1, `rl:${key}`, ...args)) as [number, number];
    }
    return { allowed: reply[0] === 1, retryAfterSeconds: Math.max(1, Math.ceil(reply[1] / 1000)) };
  }
}
