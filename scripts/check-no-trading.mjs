#!/usr/bin/env node
// Architecture §14 "No trading": no exchange private endpoint may be implemented. This check fails
// the build if application code references order, account or user-data endpoints, or the headers
// used to sign private requests, of Binance or Coinbase.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo', 'target', 'gen', 'icons']);
const EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|rs|json)$/;

const FORBIDDEN = [
  // Binance spot: orders, account, own trades, user-data streams, signed requests
  {
    label: 'Binance order endpoint',
    pattern: /\/api\/v3\/(order|orderList|openOrders|allOrders|openOrderList|allOrderList|sor\/order)\b/,
  },
  {
    label: 'Binance account endpoint',
    pattern: /\/api\/v3\/(account|myTrades|myPreventedMatches|myAllocations|rateLimit\/order)\b/,
  },
  { label: 'Binance user-data stream', pattern: /\/api\/v3\/userDataStream|\blistenKey\b/ },
  { label: 'Binance SAPI/futures endpoint', pattern: /\/(sapi|fapi|dapi|papi)\/v\d/ },
  { label: 'Binance API-key header', pattern: /X-MBX-APIKEY/i },
  // Coinbase: Exchange and Advanced Trade private endpoints and signing headers
  { label: 'Coinbase signing header', pattern: /CB-ACCESS-(KEY|SIGN|PASSPHRASE|TIMESTAMP)/i },
  {
    label: 'Coinbase Advanced Trade orders/accounts',
    pattern: /\/api\/v3\/brokerage\/(orders|accounts|portfolios|convert)/,
  },
  {
    label: 'Coinbase Exchange private endpoint',
    pattern: /api\.exchange\.coinbase\.com\/(orders|accounts|fills|transfers|withdrawals|deposits)/,
  },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* walk(path);
    else if (EXTENSIONS.test(name)) yield path;
  }
}

const violations = [];
let files = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    files++;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(line))
          violations.push(`${relative(process.cwd(), file)}:${i + 1}  ${rule.label}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error(`No-trading check FAILED: ${violations.length} reference(s) to exchange private endpoints:`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`No-trading check passed (${files} files, ${FORBIDDEN.length} rules).`);
