import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { startTestDatabase } from '@cip/db/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    dbOwnerUrl: string;
    dbRoleUrls: Record<'svc_api' | 'svc_ingestor' | 'svc_analyzer' | 'svc_jobs', string>;
    redisUrl: string;
  }
}

/** One TimescaleDB and one Valkey for the whole run, the same images as production. */
export default async function setup(project: TestProject) {
  const [db, valkey] = await Promise.all([
    startTestDatabase(),
    new GenericContainer('valkey/valkey:9.1.3')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start(),
  ]);
  project.provide('dbOwnerUrl', db.ownerUrl);
  project.provide('dbRoleUrls', db.roleUrls);
  project.provide('redisUrl', `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`);
  return async () => {
    await Promise.all([db.stop(), valkey.stop()]);
  };
}
