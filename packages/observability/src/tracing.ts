import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import type { ServiceIdentity } from './metrics.js';

export interface TracingHandle {
  enabled: boolean;
  shutdown(): Promise<void>;
}

/**
 * Tracing skeleton (architecture §16), OpenTelemetry JS 3.x style: a tracer provider, an
 * AsyncLocalStorage context manager and W3C propagators. Spans are exported over OTLP/HTTP only
 * when an endpoint is configured, so development and CI run without a collector.
 */
export function initTracing(id: ServiceIdentity, endpoint: string | undefined): TracingHandle {
  if (!endpoint) return { enabled: false, shutdown: async () => {} };

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
  );
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      'service.name': `cip-${id.service}`,
      'service.instance.id': id.instance,
      'service.version': id.version,
    }),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
      }),
    ],
  });
  trace.setGlobalTracerProvider(provider);
  return { enabled: true, shutdown: () => provider.shutdown() };
}
