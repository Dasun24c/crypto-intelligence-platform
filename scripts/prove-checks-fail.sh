#!/usr/bin/env bash
# Criterion 1.2: a deliberate violation of each check must fail it. Each case plants one file, runs
# the command CI runs, records the exit code (non-zero = the check caught it) and removes the file.
# The Playwright case needs the stack running (docker compose up --build --wait) and a web build.
# Usage: bash scripts/prove-checks-fail.sh   (prints a Markdown table)
set -u
cd "$(dirname "$0")/.."

cleanup() { rm -f packages/contracts/src/zz-*.ts e2e/tests/zz-fail.spec.ts; rm -rf "${NEG_DIR:-}"; }
trap cleanup EXIT

echo "| Check | Planted violation | Command | Exit code | Caught |"
echo "|---|---|---|---|---|"

prove() { # name, file, content, command
  local name="$1" file="$2" content="$3" cmd="$4"
  printf '%s\n' "$content" > "$file"
  bash -c "$cmd" > /dev/null 2>&1
  local rc=$?
  rm -f "$file"
  echo "| $name | \`$file\` | \`$cmd\` | $rc | $([ "$rc" -ne 0 ] && echo yes || echo NO) |"
}

prove "Formatting" packages/contracts/src/zz-format.ts "export const   badly = {a:1,b:2};" "pnpm format:check"
prove "Lint" packages/contracts/src/zz-lint.ts "export function noisy(): void { console.log('x'); }" "pnpm lint"
prove "Typecheck" packages/contracts/src/zz-types.ts "export const n: number = 'not a number';" "pnpm typecheck"
prove "Dependency rules" packages/contracts/src/zz-deps.ts \
  "import { readFileSync } from 'node:fs'; export const f = readFileSync;" "pnpm depcruise"
prove "Unit tests" packages/contracts/src/zz-fail.test.ts \
  "import { expect, it } from 'vitest'; it('fails on purpose', () => { expect(1).toBe(2); });" \
  "pnpm --filter @cip/contracts test"
prove "Build" packages/contracts/src/zz-build.ts "export const = ;" "pnpm --filter @cip/contracts build"
prove "No-trading check" packages/contracts/src/zz-trade.ts \
  "export const url = 'https://api.binance.com/api/v3/order';" "pnpm check:no-trading"
prove "Playwright smoke" e2e/tests/zz-fail.spec.ts \
  "import { expect, test } from '@playwright/test'; test('fails on purpose', async ({ page }) => { await page.goto('/'); await expect(page.getByRole('heading', { name: 'Not on this page' })).toBeVisible({ timeout: 2000 }); });" \
  "pnpm e2e --grep 'fails on purpose'"

NEG_DIR="$(mktemp -d)"
cp -r apps/web/dist "$NEG_DIR/web"
echo 'const leak = "MFA_ENCRYPTION_KEY";' > "$NEG_DIR/web/assets/zz-leak.js"
node scripts/scan-artifacts.mjs "$NEG_DIR/web" > /dev/null 2>&1
rc=$?
echo "| Artefact scan | \`assets/zz-leak.js\` in a copy of \`apps/web/dist\` | \`pnpm scan:artifacts <dir>\` | $rc | $([ "$rc" -ne 0 ] && echo yes || echo NO) |"
