import type { ErrorCode } from '@cip/contracts';

const TITLES: Record<ErrorCode, string> = {
  AUTH_REQUIRED: 'Authentication required',
  AUTH_EXPIRED: 'Access token expired',
  MFA_REQUIRED: 'Second factor required',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  VALIDATION_FAILED: 'Validation failed',
  CONFLICT: 'Conflict',
  BUDGET_EXHAUSTED: 'Budget exhausted',
  RATE_LIMITED: 'Too many requests',
  CHANNEL_UNKNOWN: 'Unknown channel',
  UNAVAILABLE: 'Service unavailable',
  INTERNAL: 'Internal error',
};

const STATUS: Record<ErrorCode, number> = {
  AUTH_REQUIRED: 401,
  AUTH_EXPIRED: 401,
  MFA_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  BUDGET_EXHAUSTED: 409,
  RATE_LIMITED: 429,
  CHANNEL_UNKNOWN: 400,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export interface FieldError {
  path: string;
  message: string;
}

/** An error that becomes an RFC 9457 problem response (API contracts §1 and §7). */
export class ProblemError extends Error {
  readonly status: number;
  readonly title: string;

  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly options: { errors?: FieldError[]; headers?: Record<string, string> } = {},
  ) {
    super(detail ?? TITLES[code]);
    this.name = 'ProblemError';
    this.status = STATUS[code];
    this.title = TITLES[code];
  }
}

export function statusForCode(code: ErrorCode): number {
  return STATUS[code];
}

export function titleForCode(code: ErrorCode): string {
  return TITLES[code];
}
