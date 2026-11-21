import { describe, expect, it } from 'vitest';
import {
  deliveryMs,
  explorerUrl,
  party,
  shortAddress,
  sourceTone,
  thresholdsSentence,
  windowMs,
} from './whales.js';

describe('Whale Tracker helpers', () => {
  it('shortens long addresses and names a listed owner instead', () => {
    expect(shortAddress('0xedd40fe35a559b8f5340b77af93083f3462ebb42')).toBe('0xedd4…bb42');
    expect(shortAddress('short')).toBe('short');
    expect(party('0xedd40fe35a559b8f5340b77af93083f3462ebb42', 'Paxos')).toBe('Paxos');
    expect(party('0xedd40fe35a559b8f5340b77af93083f3462ebb42', null)).toBe('0xedd4…bb42');
    expect(party(null, null)).toBe('—');
  });

  it('links each chain to a public block explorer', () => {
    expect(explorerUrl('bitcoin', 'abc')).toBe('https://mempool.space/tx/abc');
    expect(explorerUrl('ethereum', '0xabc')).toBe('https://etherscan.io/tx/0xabc');
    expect(explorerUrl('solana', '5ig')).toBe('https://solscan.io/tx/5ig');
  });

  it('gives each source state a tone: never colour alone, the label goes with it', () => {
    expect(sourceTone('connected')).toBe('ok');
    expect(sourceTone('no_key')).toBe('warn');
    expect(sourceTone('unreachable')).toBe('crit');
    expect(sourceTone('idle')).toBe('info');
  });

  it('states the thresholds in words', () => {
    expect(thresholdsSentence({ BTC: '1000000', ETH: '1000000', SOL: '1000000', PAXG: '250000' })).toBe(
      "Transfers worth at least $1,000,000 in BTC, $1,000,000 in ETH, $1,000,000 in SOL, $250,000 in PAXG, valued at the platform's own prices when they arrive; every PAXG mint and burn, whatever its size.",
    );
  });

  it('measures delivery from the block to the platform', () => {
    expect(deliveryMs({ blockTime: 1_000, receivedAt: 13_500 })).toBe(12_500);
    expect(deliveryMs({ blockTime: 2_000, receivedAt: 1_000 })).toBe(0);
    expect(windowMs('7d')).toBe(7 * 86_400_000);
  });
});
