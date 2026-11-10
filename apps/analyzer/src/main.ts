import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigError, PinoNestLogger, runService } from '@cip/observability';
import { loadAnalyzerConfig } from './config.js';
import { AnalyzerModule, AnalyzerStatus } from './analyzer.module.js';

async function main(): Promise<void> {
  const config = loadAnalyzerConfig();
  await runService('analyzer', config, async ({ log, redis }) => {
    const app = await NestFactory.createApplicationContext(AnalyzerModule.forRoot(config, redis), {
      logger: new PinoNestLogger(log),
    });
    const status = app.get(AnalyzerStatus);
    return { probe: () => status.probe(), readiness: () => status.readiness(), stop: () => app.close() };
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    err instanceof ConfigError ? `${err.message}\n` : `analyzer failed to start: ${String(err)}\n`,
  );
  process.exit(1);
});
