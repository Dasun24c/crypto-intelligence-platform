import type { EngineFill } from './types.js';

/**
 * One fill's line in a run digest (criterion 14.3): what the engine decided, from the inputs alone.
 * The broker hashes the lines of a period in order; a replay of the same inputs must give the same
 * hash.
 */
export function fillDigestLine(f: EngineFill): string {
  return [
    f.id,
    f.orderId,
    f.side,
    f.price,
    f.quantity,
    f.fee,
    f.feeAsset,
    f.liquidity,
    f.flags.join('+'),
    f.at,
  ].join('|');
}
