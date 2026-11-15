import { pino, type Logger, type LoggerOptions } from 'pino';

/** Paths removed from every log line (architecture §14: secrets never reach the logs). */
export const REDACT_PATHS = [
  'password',
  'currentPassword',
  'newPassword',
  'accessToken',
  'refreshToken',
  'mfaToken',
  'secret',
  'code',
  'token',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.accessToken',
  '*.refreshToken',
  '*.mfaToken',
  '*.secret',
  '*.token',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
];

export interface CreateLoggerOptions {
  service: string;
  instance: string;
  level?: string;
  /** Pretty, human-readable output for local development. JSON otherwise. */
  pretty?: boolean;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? 'info',
    base: { service: opts.service, instance: opts.instance },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
  if (opts.pretty) {
    return pino({ ...options, transport: { target: 'pino-pretty', options: { singleLine: true } } });
  }
  return pino(options);
}

export type { Logger };
