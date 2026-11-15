/**
 * The practice-order command stream (ADR 021): the api appends `place`, `cancel` and `reset` after
 * a person's request, and the broker applies them in order. Fields: `type`, `user`, and `orderId`
 * or `accountId`.
 *
 * Only the api's practice module and the broker may import this module (a dependency rule): setups,
 * alerts, the AI and scheduled jobs cannot place, change or cancel an order (TRD-05).
 */
export const PRACTICE_COMMANDS_STREAM = 'practice:commands';

export type PracticeCommandType = 'place' | 'cancel' | 'reset';
