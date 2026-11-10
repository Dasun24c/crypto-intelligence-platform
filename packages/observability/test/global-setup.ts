import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    redisUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const valkey = await new GenericContainer('valkey/valkey:9.1.3')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  project.provide('redisUrl', `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`);
  return async () => {
    await valkey.stop();
  };
}
