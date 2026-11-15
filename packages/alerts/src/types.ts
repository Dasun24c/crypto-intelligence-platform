import type { AlertRule } from '@cip/contracts';

/** The parts of a rule that evaluation reads. */
export type EvaluableRule = Pick<
  AlertRule,
  'id' | 'ownerId' | 'name' | 'scope' | 'condition' | 'severity' | 'cooldownSec'
>;

/** One occurrence a rule matched. */
export interface AlertMatch {
  /** One logical occurrence: a rule never fires twice for the same key (data model `UNIQUE (rule_id, dedupe_key)`). */
  dedupeKey: string;
  /** What the cooldown counts per: an instrument, an economic event, the gold market or the PAXG spread. */
  subject: string;
  at: number;
  title: string;
  body: string;
  instrumentId: string | null;
  sourceRefs: Record<string, unknown>;
  late: boolean;
}

/** What a condition found, before the shared fields are added. */
export interface Found {
  dedupeKey: string;
  subject: string;
  refs: Record<string, unknown>;
  /** Values the message quotes. */
  facts: Record<string, string | number>;
}
