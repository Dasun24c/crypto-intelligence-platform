import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigError, PinoNestLogger, runService } from '@cip/observability';
import { loadIngestorConfig } from './config.js';
import { IngestorModule, IngestorStatus } from './ingestor.module.js';

async function main(): Promise<void> {
  const config = loadIngestorConfig();
  await runService('ingestor', config, async ({ log, redis }) => {
    const app = await NestFactory.createApplicationContext(IngestorModule.forRoot(config, redis), {
      logger: new PinoNestLogger(log),
    });
    const status = app.get(IngestorStatus);
    return { probe: () => status.probe(), readiness: () => status.readiness(), stop: () => app.close() };
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    err instanceof ConfigError ? `${err.message}\n` : `ingestor failed to start: ${String(err)}\n`,
  );
  process.exit(1);
});
