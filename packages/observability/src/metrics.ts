import type { IncomingMessage, ServerResponse } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { metrics, type Meter } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

export interface ServiceIdentity {
  service: string;
  instance: string;
  version: string;
}

export interface MetricsHandle {
  meter: Meter;
  /** Serves the Prometheus text format; mounted on the ops server at `/metrics`. */
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  shutdown: () => Promise<void>;
}

/** OpenTelemetry metrics exported for Prometheus (architecture §16). */
export function initMetrics(id: ServiceIdentity): MetricsHandle {
  const exporter = new PrometheusExporter({ preventServerStart: true });
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': `cip-${id.service}`,
      'service.instance.id': id.instance,
      'service.version': id.version,
    }),
    readers: [exporter],
  });
  metrics.setGlobalMeterProvider(provider);
  const meter = provider.getMeter(`cip-${id.service}`);

  // Basic process health, available on every service from the first phase.
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  meter
    .createObservableGauge('cip_process_resident_memory_bytes', {
      description: 'Resident set size',
      unit: 'By',
    })
    .addCallback((r) => r.observe(process.memoryUsage().rss));
  meter
    .createObservableGauge('cip_process_uptime_seconds', { description: 'Process uptime', unit: 's' })
    .addCallback((r) => r.observe(process.uptime()));
  meter
    .createObservableGauge('cip_event_loop_delay_p99_seconds', {
      description: 'Event loop delay, p99',
      unit: 's',
    })
    .addCallback((r) => {
      r.observe(loopDelay.percentile(99) / 1e9);
      loopDelay.reset();
    });

  return {
    meter,
    handle: (req, res) => exporter.getMetricsRequestHandler(req, res),
    shutdown: async () => {
      loopDelay.disable();
      await provider.shutdown();
    },
  };
}
