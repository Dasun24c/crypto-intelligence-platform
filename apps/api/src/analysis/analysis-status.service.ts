import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { type AnalysisStatus, AnalysisStatusSchema, analysisStatusKey } from '@cip/contracts';
import { MarketRepository } from '../market/market.repository.js';
import { REDIS } from '../tokens.js';

/**
 * Each analysed instrument's state, as the analyzer holding its lease publishes it
 * (`analysis:status:{id}`, 15 s TTL). An instrument no analyzer reports is simply absent: the
 * analyzer's own heartbeat shows whether the service is running.
 */
@Injectable()
export class AnalysisStatusService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly market: MarketRepository,
  ) {}

  async all(): Promise<AnalysisStatus[]> {
    const ids = (await this.market.instruments({ includeDisabled: false })).map((i) => i.id);
    if (ids.length === 0) return [];
    const raw = await this.redis.mget(ids.map(analysisStatusKey));
    return raw.flatMap((value) => {
      if (!value) return [];
      const parsed = AnalysisStatusSchema.safeParse(JSON.parse(value));
      return parsed.success ? [parsed.data] : [];
    });
  }
}
