import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ProblemError } from './problem.js';

/**
 * Parses a request body or query string with its contract schema. Unknown fields are rejected by the
 * schemas themselves (`z.strictObject`), so a typo never silently does nothing.
 */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    throw new ProblemError('VALIDATION_FAILED', 'The request does not match the schema.', {
      errors: result.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
    });
  }
}
