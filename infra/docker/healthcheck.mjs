// Docker HEALTHCHECK without curl: exits 0 when the URL answers 2xx within 3 s.
const url = process.argv[2] ?? 'http://127.0.0.1:3000/readyz';
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
