/**
 * Which stack the end-to-end tests run against. CI starts the replay stack (criterion 2.11, ADR 015:
 * `COMPOSE_FILE` adds `compose.replay.yaml`): recorded data on the replay venue, with Binance and
 * Coinbase disabled. Specs that need the live venues (their pairs, books and trades) run only
 * against the live stack, and are skipped, saying why, on the replay stack. `E2E_STACK=replay` says
 * the same when the stack was started some other way.
 */
export const REPLAY_STACK =
  /compose.replay.ya?ml/.test(process.env['COMPOSE_FILE'] ?? '') || process.env['E2E_STACK'] === 'replay';

export const LIVE_ONLY =
  'needs the live stack (Binance and Coinbase); the replay stack (CI) has only the replay venue';
