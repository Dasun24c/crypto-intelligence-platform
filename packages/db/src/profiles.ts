/**
 * The launch instrument profiles, version 3 of each (indicators, SMC structure and liquidity, and
 * points of interest), seeded by migration 0008. Tokenised gold uses the gold profile; every other
 * instrument uses crypto-majors. Versions 1 (0006, indicators only) and 2 (0007, without zones)
 * stay for the runs that used them.
 */
export const LAUNCH_PROFILE_IDS = {
  'crypto-majors': '019a6f00-0000-7000-8000-000000000205',
  gold: '019a6f00-0000-7000-8000-000000000206',
} as const;

export function launchProfileFor(assetClass: string): string {
  return assetClass === 'tokenised_gold' ? LAUNCH_PROFILE_IDS.gold : LAUNCH_PROFILE_IDS['crypto-majors'];
}
