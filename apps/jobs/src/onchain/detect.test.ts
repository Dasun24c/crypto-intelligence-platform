import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bitcoinTransfer,
  type DetectContext,
  type EsploraTx,
  type EthBlock,
  type EthLog,
  ethereumTransfers,
  minUnits,
  paxgEvent,
  type SolanaTx,
  solanaTransfer,
  TOPICS,
  unitsToDecimal,
  usdValue,
} from './detect.js';

/** Recorded chain data (each file names where it came from). */
function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../../test/fixtures/onchain/${name}`, import.meta.url), 'utf8'),
  ) as T;
}

const ctx = (min: bigint | null, priceUsd: string | null = null): DetectContext => ({
  min,
  priceUsd,
  provider: 'test',
});

describe('amounts', () => {
  it('turns base units into exact decimal strings', () => {
    expect(unitsToDecimal(62_987_400_000_000_000_000n, 18)).toBe('62.9874');
    expect(unitsToDecimal(1n, 18)).toBe('0.000000000000000001');
    expect(unitsToDecimal(10_000_095_775n, 8)).toBe('100.00095775');
    expect(unitsToDecimal(0n, 9)).toBe('0');
  });

  it('finds the smallest amount worth the threshold, rounding up; none without a price', () => {
    // $1,000,000 at $65,000 a bitcoin: 15.38461538… BTC, so 1,538,461,539 satoshis.
    expect(minUnits('1000000', '65000', 8)).toBe(1_538_461_539n);
    expect(minUnits('250000', '4000', 18)).toBe(62_500_000_000_000_000_000n);
    expect(minUnits('1000000', null, 8)).toBeNull();
    expect(minUnits('1000000', '0', 8)).toBeNull();
  });

  it('values an amount to the cent', () => {
    expect(usdValue('100.00095775', '65000')).toBe('6500062.25');
    expect(usdValue('1', null)).toBeNull();
  });
});

describe('Bitcoin', () => {
  const recorded = fixture<{
    block: { height: number; timestamp: number };
    txs: [EsploraTx, EsploraTx, EsploraTx];
  }>('btc-block-976172.json');
  const block = { height: recorded.block.height, time: recorded.block.timestamp * 1000 };
  const [coinbase, small, large] = recorded.txs;
  const min = minUnits('1000000', '65000', 8);

  it('records what a transaction pays to other addresses, from its largest input to its largest recipient', () => {
    const e = bitcoinTransfer(large, block, ctx(min, '65000'))!;
    expect(e).toMatchObject({
      chain: 'bitcoin',
      asset: 'BTC',
      kind: 'transfer',
      txHash: '7663e888950a2341d27366e341408671127e4f989b126872969e0a8ae9e018ec',
      position: 0,
      blockNumber: 976_172,
      blockTime: 1_794_854_967_000,
      from: '33uVWjMEXvu1xBWjydjPod9K87jgjm7WXm',
      to: '1KbDEg1tDz2ErYgaDbaDhhawnLrSQFaFx5',
      amount: '100.00095775',
      priceUsd: '65000',
      usdValue: '6500062.25',
    });
    expect(e.details).toMatchObject({ inputs: 1, outputs: 39, recipients: 39 });
  });

  it('leaves out coinbase transactions, small ones, and everything without a price', () => {
    expect(bitcoinTransfer(coinbase, block, ctx(min, '65000'))).toBeNull();
    expect(bitcoinTransfer(small, block, ctx(min, '65000'))).toBeNull();
    expect(bitcoinTransfer(large, block, ctx(null))).toBeNull();
  });

  it('does not count change returning to the sender as transferred', () => {
    const tx: EsploraTx = {
      txid: 'f'.repeat(64),
      vin: [{ prevout: { scriptpubkey_address: 'bc1qsender0000', value: 30e8 } }],
      vout: [
        { scriptpubkey_address: 'bc1qrecipient00', value: 10e8 },
        { scriptpubkey_address: 'bc1qsender0000', value: 19.9e8 },
      ],
    };
    expect(bitcoinTransfer(tx, block, ctx(11n * 100_000_000n, '65000'))).toBeNull();
    expect(bitcoinTransfer(tx, block, ctx(10n * 100_000_000n, '65000'))!.amount).toBe('10');
  });
});

describe('Ethereum', () => {
  const recorded = fixture<{ block: EthBlock }>('eth-block-26429557.json');

  it('records transactions moving at least the threshold in ETH itself', () => {
    const min = minUnits('1000000', '3200', 18);
    const events = ethereumTransfers(recorded.block, ctx(min, '3200'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      chain: 'ethereum',
      asset: 'ETH',
      kind: 'transfer',
      txHash: '0x1ae7ecf44df7e9b00a5e8e0aee85e65425b33afc8bc75ad663059e3f3b8738bd',
      blockNumber: 26_429_557,
      blockTime: 1_794_855_791_000,
      from: '0xbc748540db5c76335d324d353f6903e9cf77c65d',
      to: '0x2729284c6382557c98710e1cdc8e6c8090cb4c5e',
      amount: '16517.6664708876044614',
    });
  });

  it('skips contract creations, and records nothing without a price', () => {
    const block: EthBlock = {
      ...recorded.block,
      transactions: [{ hash: '0xabc', from: '0x1', to: null, value: '0xde0b6b3a7640000000' }],
    };
    expect(ethereumTransfers(block, ctx(1n, '3200'))).toEqual([]);
    expect(ethereumTransfers(recorded.block, ctx(null))).toEqual([]);
  });
});

describe('PAXG (criterion 11.2: a known mint and burn)', () => {
  interface Recorded {
    block: { number: number; timestamp: number };
    receipt: { logs: EthLog[] };
  }
  const mint = fixture<Recorded>('paxg-mint-26429062.json');
  const burn = fixture<Recorded>('paxg-burn-26429307.json');
  const paxgLogs = (r: Recorded) =>
    r.receipt.logs.filter((l) => l.address.toLowerCase() === '0x45804880de22913dafe09f4980848ece6ecbaf78');
  const big = ctx(minUnits('250000', '4000', 18), '4000');

  it('records the mint of 2026-11-16 17:23:59 UTC from SupplyIncreased, and not its Transfer from zero', () => {
    const [supply, transfer] = paxgLogs(mint);
    expect(supply!.topics[0]).toBe(TOPICS.supplyIncreased);
    expect(paxgEvent(supply!, mint.block.timestamp * 1000, big)).toMatchObject({
      chain: 'ethereum',
      asset: 'PAXG',
      kind: 'mint',
      txHash: '0xef39a122bccb55760d2568db1b832ff9ebf42e2140dcc51e80a1b9719702e2ff',
      position: 132,
      blockNumber: 26_429_062,
      blockTime: Date.UTC(2026, 10, 16, 17, 23, 59),
      from: null,
      to: '0xedd40fe35a559b8f5340b77af93083f3462ebb42',
      amount: '62.9874',
      usdValue: '251949.6',
    });
    expect(transfer!.topics[0]).toBe(TOPICS.transfer);
    expect(paxgEvent(transfer!, mint.block.timestamp * 1000, ctx(1n, '4000'))).toBeNull();
  });

  it('records the burn of 2026-11-16 18:12:59 UTC from SupplyDecreased, and not its Transfer to zero', () => {
    const [supply, transfer] = paxgLogs(burn);
    expect(supply!.topics[0]).toBe(TOPICS.supplyDecreased);
    expect(paxgEvent(supply!, burn.block.timestamp * 1000, big)).toMatchObject({
      kind: 'burn',
      txHash: '0xf74c23dbadd747a6fc48c9e37a33b1ef8ea4b6f100529dfd83e0bd0f8b64b044',
      position: 164,
      blockNumber: 26_429_307,
      blockTime: Date.UTC(2026, 10, 16, 18, 12, 59),
      from: '0xf58e79a7bd26532ff525db5b78456eb2e79076ec',
      to: null,
      amount: '3.2',
    });
    expect(paxgEvent(transfer!, burn.block.timestamp * 1000, ctx(1n, '4000'))).toBeNull();
  });

  it('records a mint or burn whatever its size, even without a price', () => {
    const [supply] = paxgLogs(burn);
    expect(paxgEvent(supply!, 0, ctx(null))!.kind).toBe('burn');
  });

  it('records a large Transfer between two holders, and ignores other contracts', () => {
    const transfer: EthLog = {
      address: '0x45804880De22913dAFE09f4980848ECE6EcbAf78',
      topics: [
        TOPICS.transfer,
        `0x${'0'.repeat(24)}${'a'.repeat(40)}`,
        `0x${'0'.repeat(24)}${'b'.repeat(40)}`,
      ],
      data: `0x${(100n * 10n ** 18n).toString(16)}`,
      blockNumber: '0x1',
      transactionHash: '0x01',
      logIndex: '0x5',
    };
    expect(paxgEvent(transfer, 1_000, ctx(50n * 10n ** 18n, '4000'))).toMatchObject({
      kind: 'transfer',
      from: `0x${'a'.repeat(40)}`,
      to: `0x${'b'.repeat(40)}`,
      amount: '100',
      position: 5,
      usdValue: '400000',
    });
    expect(paxgEvent(transfer, 1_000, ctx(200n * 10n ** 18n, '4000'))).toBeNull();
    expect(paxgEvent({ ...transfer, address: `0x${'c'.repeat(40)}` }, 1_000, ctx(1n, '4000'))).toBeNull();
  });
});

describe('Solana', () => {
  const exchange = 'ExchangeWa11et1111111111111111111111111111';
  const whale = 'Wha1e111111111111111111111111111111111111111';
  const tx = (pre: number[], post: number[], err: unknown = null): SolanaTx => ({
    slot: 300_000_000,
    blockTime: 1_794_855_000,
    transaction: {
      signatures: ['5ig'],
      message: { accountKeys: [whale, exchange, '11111111111111111111111111111111'] },
    },
    meta: { err, preBalances: pre, postBalances: post },
  });
  const sol = 1_000_000_000;
  const min = ctx(BigInt(5_000 * sol), '200');

  it('records SOL moving into a watched exchange wallet', () => {
    const e = solanaTransfer(
      tx([60_000 * sol, 10 * sol, 1], [10_000 * sol - 5_000, 50_010 * sol, 1]),
      new Set([exchange]),
      min,
      0,
    );
    expect(e).toMatchObject({
      chain: 'solana',
      asset: 'SOL',
      txHash: '5ig',
      blockNumber: 300_000_000,
      blockTime: 1_794_855_000_000,
      from: whale,
      to: exchange,
      amount: '50000',
      usdValue: '10000000',
    });
  });

  it('records nothing for a failed transaction, an unwatched one, or a small one', () => {
    const moved = [
      [60_000 * sol, 0, 1],
      [10_000 * sol, 50_000 * sol, 1],
    ] as const;
    expect(
      solanaTransfer(
        tx([...moved[0]], [...moved[1]], { InstructionError: [0, 'x'] }),
        new Set([exchange]),
        min,
        0,
      ),
    ).toBeNull();
    expect(solanaTransfer(tx([...moved[0]], [...moved[1]]), new Set(['Other']), min, 0)).toBeNull();
    expect(
      solanaTransfer(tx([100 * sol, 0, 1], [50 * sol, 50 * sol, 1]), new Set([exchange]), min, 0),
    ).toBeNull();
  });
});
