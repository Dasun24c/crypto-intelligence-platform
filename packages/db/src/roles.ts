import { type Kysely, sql } from 'kysely';

export const SERVICE_ROLES = ['svc_api', 'svc_ingestor', 'svc_analyzer', 'svc_jobs'] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];

/**
 * Enables LOGIN and sets the password for each service role that has one configured. Roles without
 * a configured password stay NOLOGIN, so a service that is not deployed cannot be used to connect.
 */
export async function configureServiceRoles<DB>(
  db: Kysely<DB>,
  passwords: Partial<Record<ServiceRole, string>>,
): Promise<ServiceRole[]> {
  const configured: ServiceRole[] = [];
  for (const role of SERVICE_ROLES) {
    const password = passwords[role];
    if (!password) continue;
    if (password.length < 16) throw new Error(`Password for ${role} must be at least 16 characters.`);
    // Role names come from the fixed list above; the password is passed as a literal.
    await sql`ALTER ROLE ${sql.id(role)} LOGIN PASSWORD ${sql.lit(password)}`.execute(db);
    configured.push(role);
  }
  return configured;
}
