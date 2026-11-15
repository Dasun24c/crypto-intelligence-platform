import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ErrorCode, Problem } from '@cip/contracts';
import type { Logger } from '@cip/observability';
import { LOGGER } from '../tokens.js';
import { ProblemError, titleForCode } from './problem.js';

/** Maps Nest's own HTTP errors (unknown route, body too large, ...) onto the API error codes. */
function codeForHttpStatus(status: number): ErrorCode {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'UNAVAILABLE';
  if (status >= 400 && status < 500) return 'VALIDATION_FAILED';
  return 'INTERNAL';
}

/** Every error leaves the API as `application/problem+json` (RFC 9457). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly log: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { correlationId?: string }>();
    const res = ctx.getResponse<Response>();
    let problem: Problem;
    let headers: Record<string, string> = {};

    if (exception instanceof ProblemError) {
      problem = {
        type: 'about:blank',
        title: exception.title,
        status: exception.status,
        code: exception.code,
        ...(exception.detail ? { detail: exception.detail } : {}),
        ...(exception.options.errors ? { errors: exception.options.errors } : {}),
      };
      headers = exception.options.headers ?? {};
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = codeForHttpStatus(status);
      problem = { type: 'about:blank', title: titleForCode(code), status, code };
    } else {
      this.log.error({ err: exception, correlationId: req.correlationId, path: req.path }, 'unhandled error');
      problem = { type: 'about:blank', title: titleForCode('INTERNAL'), status: 500, code: 'INTERNAL' };
    }
    if (req.correlationId) problem.correlationId = req.correlationId;

    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.status(problem.status).type('application/problem+json').send(JSON.stringify(problem));
  }
}
