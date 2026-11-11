/**
 * The launch instrument profiles, version 2 of each (indicators and SMC), seeded by migration 0007.
 * Tokenised gold uses the gold profile; every other instrument uses crypto-majors. Version 1
 * (migration 0006, indicators only) stays for the runs that used it.
 */
export const LAUNCH_PROFILE_IDS = {
  'crypto-majors': '019a6f00-0000-7000-8000-000000000203',
  gold: '019a6f00-0000-7000-8000-000000000204',
} as const;

export function launchProfileFor(assetClass: string): string {
  return assetClass === 'tokenised_gold' ? LAUNCH_PROFILE_IDS.gold : LAUNCH_PROFILE_IDS['crypto-majors'];
}
