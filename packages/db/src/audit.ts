import { type Kysely, sql } from 'kysely';

export interface AuditChainVerification {
  ok: boolean;
  checkedRows: number;
  firstBrokenSeq: number | null;
}

/** Walks the whole audit hash chain in the database (`app.verify_audit_chain`). */
export async function verifyAuditChain<DB>(db: Kysely<DB>): Promise<AuditChainVerification> {
  const { rows } = await sql<{ ok: boolean; checked_rows: string; first_broken_seq: string | null }>`
    SELECT ok, checked_rows, first_broken_seq FROM app.verify_audit_chain()
  `.execute(db);
  const row = rows[0];
  if (!row) throw new Error('verify_audit_chain returned no row');
  return {
    ok: row.ok,
    checkedRows: Number(row.checked_rows),
    firstBrokenSeq: row.first_broken_seq === null ? null : Number(row.first_broken_seq),
  };
}
