import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can } from '@cip/contracts';
import type { Logger } from '@cip/observability';
import { ACCESS_KEY, type AccessPolicy, type ApiRequest } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { LIMITS, RateLimiter } from '../common/rate-limiter.js';
import { CLOCK, type Clock, LOGGER } from '../tokens.js';
import { effectiveStatus, toSummary, UsersRepository } from '../users/users.repository.js';
import { TokenService } from './token.service.js';

/**
 * The single gate in front of every route (architecture §14): authenticates the bearer token,
 * reloads the user so that disabling an account or changing a role takes effect immediately, applies
 * the per-user rate limit and checks the route's policy against the RBAC matrix. Default deny.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly users: UsersRepository,
    private readonly rateLimiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (policy === undefined) {
      this.log.error({ path: req.path, method: req.method }, 'route has no access policy: refused');
      throw new ProblemError('FORBIDDEN');
    }
    if (policy === 'public') return true;

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new ProblemError('AUTH_REQUIRED');
    const claims = await this.tokens.verifyAccessToken(header.slice('Bearer '.length));
    const user = await this.users.findById(claims.userId);
    const now = this.clock();
    if (!user || effectiveStatus(user, now) !== 'active') throw new ProblemError('AUTH_REQUIRED');
    // Tokens issued before the last password change are no longer valid.
    if (claims.issuedAt < Math.floor(user.password_changed_at.getTime() / 1000)) {
      throw new ProblemError('AUTH_EXPIRED');
    }
    req.user = toSummary(user);

    const decision = await this.rateLimiter.take(`rest:${user.id}`, LIMITS.rest, now);
    if (!decision.allowed) {
      throw new ProblemError('RATE_LIMITED', undefined, {
        headers: { 'retry-after': String(decision.retryAfterSeconds) },
      });
    }
    if (policy === 'authenticated' || can(user.role, policy)) return true;
    throw new ProblemError('FORBIDDEN', 'Your role does not allow this.');
  }
}
