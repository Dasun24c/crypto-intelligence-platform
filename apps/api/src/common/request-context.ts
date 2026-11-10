import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { NextFunction, Response } from 'express';
import type { Logger } from '@cip/observability';
import type { ApiRequest } from './access.js';

const tracer = trace.getTracer('cip-api');

/**
 * Correlation id (`x-request-id`, accepted from the caller when well-formed), one access-log line per
 * request and one span per request. The span is a no-op unless tracing is configured.
 */
export function requestContext(log: Logger) {
  return (req: ApiRequest, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && /^[\w.-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    req.correlationId = id;
    res.setHeader('x-request-id', id);
    const path = req.originalUrl.split('?')[0] ?? req.originalUrl;
    const span = tracer.startSpan(`${req.method} ${path}`, {
      attributes: { 'http.request.method': req.method, 'url.path': path, 'cip.correlation_id': id },
    });
    const started = performance.now();
    res.on('finish', () => {
      span.setAttribute('http.response.status_code', res.statusCode);
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      log.info(
        {
          correlationId: id,
          method: req.method,
          path,
          status: res.statusCode,
          ms: Math.round(performance.now() - started),
          userId: req.user?.id,
        },
        'request',
      );
    });
    next();
  };
}
