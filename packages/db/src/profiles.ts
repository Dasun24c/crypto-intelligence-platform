/**
 * The launch instrument profiles, version 1 of each, seeded by migration 0006. Tokenised gold uses
 * the gold profile; every other instrument uses crypto-majors.
 */
export const LAUNCH_PROFILE_IDS = {
  'crypto-majors': '019a6f00-0000-7000-8000-000000000201',
  gold: '019a6f00-0000-7000-8000-000000000202',
} as const;

export function launchProfileFor(assetClass: string): string {
  return assetClass === 'tokenised_gold' ? LAUNCH_PROFILE_IDS.gold : LAUNCH_PROFILE_IDS['crypto-majors'];
}
