import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { AI_EVENTS_STREAM, AI_QUEUE, AI_REQUESTS_PER_HOUR, type AiJob, type AiRequest } from '@cip/contracts';
import { ON_DEMAND_SCORE } from '@cip/ai';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { type BucketSpec, RateLimiter } from '../common/rate-limiter.js';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, CLOCK, type Clock, REDIS } from '../tokens.js';
import { AiRepository } from './ai.repository.js';

/** API contracts §8: 10 requests per hour per user (no burst beyond 10). */
export const AI_REQUEST_LIMIT: BucketSpec = {
  capacity: AI_REQUESTS_PER_HOUR,
  refillPerSecond: AI_REQUESTS_PER_HOUR / 3_600,
};
/** `ai:events` keeps about this many messages. */
const EVENTS_MAXLEN = '10000';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * On-demand AI analyses (API contracts §3, ADR 023). The API never calls the model: it checks the
 * request, the switch, the key's presence (as the jobs service reports it) and the budget, then
 * queues the analysis for the jobs service, which alone holds the key.
 */
@Injectable()
export class AiService implements OnModuleDestroy {
  private readonly queue: Queue<AiJob>;
  private readonly connection: Redis;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly repo: AiRepository,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
  ) {
    this.connection = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectionName: 'cip-api-ai',
      lazyConnect: true,
    });
    this.queue = new Queue<AiJob>(AI_QUEUE, { connection: this.connection, prefix: config.QUEUE_PREFIX });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }

  /**
   * Queues one analysis and returns its id. Refuses, in this order: an unknown or unanalysed
   * instrument, a setup on another pair, analyses switched off (409), no key (503), the budget
   * exhausted (409 BUDGET_EXHAUSTED), and more than 10 requests in an hour (429).
   */
  async request(
    user: AuthenticatedUser,
    body: AiRequest,
    meta: RequestMeta,
  ): Promise<{ analysisId: string }> {
    const instrument = await this.repo.instrument(body.instrumentId);
    if (!instrument) throw new ProblemError('NOT_FOUND', 'Unknown instrument.');
    if (!instrument.analysed)
      throw new ProblemError('VALIDATION_FAILED', 'This pair is not analysed.', {
        errors: [{ path: 'instrumentId', message: 'No analysis profile.' }],
      });
    if (body.setupId && (await this.repo.setupInstrument(body.setupId)) !== instrument.id)
      throw new ProblemError('VALIDATION_FAILED', 'That setup is not on this pair.', {
        errors: [{ path: 'setupId', message: 'Unknown setup for this pair.' }],
      });

    const now = this.clock();
    const settings = await this.repo.settings();
    if (!settings.enabled) throw new ProblemError('CONFLICT', 'AI analyses are switched off.');
    const status = await this.repo.status();
    if (status && !status.keyConfigured)
      throw new ProblemError('UNAVAILABLE', 'No Grok API key is configured.');
    const budget = await this.repo.budget(now, settings);
    if (budget.state === 'exhausted')
      throw new ProblemError('BUDGET_EXHAUSTED', 'AI budget reached: no analyses until the cap resets.');
    const decision = await this.limiter.take(`ai-requests:${user.id}`, AI_REQUEST_LIMIT, now);
    if (!decision.allowed)
      throw new ProblemError('RATE_LIMITED', `At most ${AI_REQUESTS_PER_HOUR} AI analyses an hour.`, {
        headers: { 'retry-after': String(decision.retryAfterSeconds) },
      });

    const analysisId = uuidv7();
    const job: AiJob = {
      analysisId,
      trigger: 'on_demand',
      instrumentId: instrument.id,
      score: ON_DEMAND_SCORE,
      triggerRefs: [{ kind: 'request', id: body.reason, score: ON_DEMAND_SCORE, at: now }],
      requestedBy: user.id,
      reason: body.reason,
      setupId: body.setupId ?? null,
      queuedAt: now,
    };
    await this.audit.record({
      actorType: 'user',
      actorUserId: user.id,
      action: 'ai.requested',
      targetType: 'ai_analysis',
      targetId: analysisId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: { instrumentId: instrument.id, reason: body.reason, setupId: body.setupId ?? null },
    });
    await this.queue.add('on_demand', job, {
      jobId: analysisId,
      attempts: 1,
      removeOnComplete: { age: 24 * 3_600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    });
    await this.redis.xadd(
      AI_EVENTS_STREAM,
      'MAXLEN',
      '~',
      EVENTS_MAXLEN,
      '*',
      'type',
      'ai.queued',
      'data',
      JSON.stringify({
        analysisId,
        instrumentId: instrument.id,
        trigger: 'on_demand',
        reason: body.reason,
        queuedAt: now,
      }),
    );
    return { analysisId };
  }
}
