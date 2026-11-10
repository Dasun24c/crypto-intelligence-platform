import { Inject, Injectable } from '@nestjs/common';
import type { AuditEntry, AuditQuery, Page } from '@cip/contracts';
import { type AuditLogRow, verifyAuditChain } from '@cip/db';
import type { Executor } from '../users/users.repository.js';
import { DB } from '../tokens.js';

export interface AuditEvent {
  actorType: 'user' | 'system';
  actorUserId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
}

function toEntry(row: AuditLogRow): AuditEntry {
  return {
    id: row.chain_seq,
    at: row.at.getTime(),
    actorType: row.actor_type,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    ip: row.ip,
    details: row.details,
  };
}

/**
 * Appends to the hash-chained audit log (architecture §14). Pass the transaction of the change being
 * audited, so the change and its audit entry commit or roll back together.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Executor) {}

  async record(event: AuditEvent, ex: Executor = this.db): Promise<void> {
    await ex
      .insertInto('app.audit_log')
      .values({
        actor_type: event.actorType,
        actor_user_id: event.actorUserId ?? null,
        action: event.action,
        target_type: event.targetType ?? null,
        target_id: event.targetId ?? null,
        ip: event.ip ?? null,
        user_agent: event.userAgent ?? null,
        details: event.details ?? {},
      })
      .execute();
  }

  /** Newest first; the cursor is the chain sequence of the last entry returned. */
  async query(q: AuditQuery): Promise<Page<AuditEntry>> {
    let query = this.db
      .selectFrom('app.audit_log')
      .selectAll()
      .orderBy('chain_seq', 'desc')
      .limit(q.limit + 1);
    if (q.actor) query = query.where('actor_user_id', '=', q.actor);
    if (q.action) query = query.where('action', 'like', `${q.action.replace(/[%_\\]/g, '\\$&')}%`);
    if (q.from !== undefined) query = query.where('at', '>=', new Date(q.from));
    if (q.to !== undefined) query = query.where('at', '<', new Date(q.to));
    if (q.cursor) query = query.where('chain_seq', '<', q.cursor);
    const rows = await query.execute();
    const items = rows.slice(0, q.limit).map(toEntry);
    return { items, nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null };
  }

  verifyChain() {
    return verifyAuditChain(this.db);
  }
}
