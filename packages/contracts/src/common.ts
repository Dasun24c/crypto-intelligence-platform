import { z } from 'zod';

/** Epoch milliseconds, UTC (API contracts §1). */
export const TsSchema = z.number().int().nonnegative();
export type Ts = z.infer<typeof TsSchema>;

export const UuidSchema = z.uuid();

/** Error codes (API contracts §7). */
export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'MFA_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'BUDGET_EXHAUSTED',
  'RATE_LIMITED',
  'CHANNEL_UNKNOWN',
  'UNAVAILABLE',
  'INTERNAL',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** RFC 9457 problem details, as returned with `application/problem+json`. */
export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: ErrorCodeSchema,
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  correlationId: z.string().optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

/** Cursor pagination query (API contracts §1): default 100, max 1000. */
export const PageQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
