import type { WallParams } from './walls.js';

/**
 * Exchange-flow detection settings per base asset (architecture §5.6). The multiple and window
 * follow the architecture; the USD floors are starting values to calibrate on live data, kept here
 * in one place until they become profile parameters.
 */
export interface DetectionParams {
  largeTradeFloorUsd: number;
  walls: WallParams;
}

const WALLS: Omit<WallParams, 'floorUsd'> = {
  multiple: 10,
  windowBps: 100,
  minLifetimeMs: 3_000,
  holdRatio: 0.5,
};

const FLOORS: Record<string, { largeTradeUsd: number; wallUsd: number }> = {
  BTC: { largeTradeUsd: 250_000, wallUsd: 1_000_000 },
  ETH: { largeTradeUsd: 150_000, wallUsd: 500_000 },
  SOL: { largeTradeUsd: 100_000, wallUsd: 250_000 },
  PAXG: { largeTradeUsd: 50_000, wallUsd: 100_000 },
};
const DEFAULT_FLOORS = { largeTradeUsd: 100_000, wallUsd: 250_000 };

export function detectionParams(baseAsset: string): DetectionParams {
  const floors = FLOORS[baseAsset] ?? DEFAULT_FLOORS;
  return { largeTradeFloorUsd: floors.largeTradeUsd, walls: { ...WALLS, floorUsd: floors.wallUsd } };
}

/**
 * The cross-venue price difference (architecture §5.5, GLD-04): the primary venue's USDT price
 * converted at the USDT-USD rate, against the secondary venue's USD price, in bps of the primary.
 */
export function crossVenueSpread(
  primaryQuote: number,
  usdPerQuote: number,
  secondaryUsd: number,
): { primaryUsd: number; spreadBps: number } {
  const primaryUsd = primaryQuote * usdPerQuote;
  return { primaryUsd, spreadBps: ((secondaryUsd - primaryUsd) / primaryUsd) * 10_000 };
}
