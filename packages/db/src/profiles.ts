/**
 * The launch instrument profiles, version 4 of each (indicators, SMC structure and liquidity,
 * points of interest, and setups), seeded by migration 0009. Tokenised gold uses the gold profile;
 * every other instrument uses crypto-majors. Versions 1 (0006, indicators only), 2 (0007, without
 * zones) and 3 (0008, without setups) stay for the runs that used them.
 */
export const LAUNCH_PROFILE_IDS = {
  'crypto-majors': '019a6f00-0000-7000-8000-000000000207',
  gold: '019a6f00-0000-7000-8000-000000000208',
} as const;

export function launchProfileFor(assetClass: string): string {
  return assetClass === 'tokenised_gold' ? LAUNCH_PROFILE_IDS.gold : LAUNCH_PROFILE_IDS['crypto-majors'];
}
