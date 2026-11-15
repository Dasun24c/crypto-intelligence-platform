import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { AdminUser, Role, UserSummary } from '@cip/contracts';
import type { Database, NewUser, UserRow, UserUpdate } from '@cip/db';
import { DB } from '../tokens.js';

export type Executor = Kysely<Database>;

/** A temporary lockout that has expired counts as active again. */
export function effectiveStatus(row: UserRow, now: number): AdminUser['status'] {
  if (row.status === 'locked' && row.locked_until && row.locked_until.getTime() <= now) return 'active';
  return row.status;
}

export function toSummary(row: UserRow): UserSummary {
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
}

export function toAdminUser(row: UserRow, now: number): AdminUser {
  return {
    ...toSummary(row),
    status: effectiveStatus(row, now),
    mfaEnabled: row.mfa_secret_enc !== null,
    createdAt: row.created_at.getTime(),
    lastLoginAt: row.last_login_at?.getTime() ?? null,
  };
}

@Injectable()
export class UsersRepository {
  constructor(@Inject(DB) private readonly db: Executor) {}

  findById(id: string, ex: Executor = this.db): Promise<UserRow | undefined> {
    return ex.selectFrom('app.users').selectAll().where('id', '=', id).executeTakeFirst();
  }

  findByEmail(email: string, ex: Executor = this.db): Promise<UserRow | undefined> {
    return ex.selectFrom('app.users').selectAll().where('email', '=', email).executeTakeFirst();
  }

  list(ex: Executor = this.db): Promise<UserRow[]> {
    return ex.selectFrom('app.users').selectAll().orderBy('created_at').orderBy('id').execute();
  }

  insert(user: NewUser, ex: Executor = this.db): Promise<UserRow> {
    return ex.insertInto('app.users').values(user).returningAll().executeTakeFirstOrThrow();
  }

  update(id: string, patch: UserUpdate, ex: Executor = this.db): Promise<UserRow | undefined> {
    return ex
      .updateTable('app.users')
      .set({ ...patch, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  async countActiveAdmins(ex: Executor = this.db): Promise<number> {
    const row = await ex
      .selectFrom('app.users')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('role', '=', 'admin' satisfies Role)
      .where('status', '!=', 'disabled')
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** Locks the user row for the rest of the transaction (serialises concurrent admin changes). */
  lockById(id: string, ex: Executor): Promise<UserRow | undefined> {
    return ex.selectFrom('app.users').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  }
}
