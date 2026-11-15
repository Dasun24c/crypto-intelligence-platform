import type { TestProject } from 'vitest/node';
import { startTestDatabase } from '../src/testing.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    dbOwnerUrl: string;
    dbRoleUrls: Record<'svc_api' | 'svc_ingestor' | 'svc_analyzer' | 'svc_jobs', string>;
  }
}

export default async function setup(project: TestProject) {
  const db = await startTestDatabase();
  project.provide('dbOwnerUrl', db.ownerUrl);
  project.provide('dbRoleUrls', db.roleUrls);
  return async () => {
    await db.stop();
  };
}
