import { describe, expect, it } from 'vitest';
import {
  ASSET_CHAIN,
  canonicalAddress,
  CreateExchangeLabelSchema,
  ExchangeFlowQuerySchema,
  flowOf,
  isAddressOf,
  OnchainQuerySchema,
  OnchainStatusResponseSchema,
  PAXG_CONTRACT,
} from './whales.js';

describe('Whale Tracker (Phase 11, ADR 025)', () => {
  it('keeps Ethereum addresses lowercase, and Bitcoin and Solana addresses as given', () => {
    expect(canonicalAddress('ethereum', ' 0x45804880De22913dAFE09f4980848ECE6EcbAf78 ')).toBe(PAXG_CONTRACT);
    expect(canonicalAddress('bitcoin', ' 1KbDEg1tDz2ErYgaDbaDhhawnLrSQFaFx5')).toBe(
      '1KbDEg1tDz2ErYgaDbaDhhawnLrSQFaFx5',
    );
    expect(canonicalAddress('solana', 'So11111111111111111111111111111111111111112 ')).toBe(
      'So11111111111111111111111111111111111111112',
    );
  });

  it("tells each chain's address formats apart", () => {
    const valid = {
      bitcoin: [
        'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        '1KbDEg1tDz2ErYgaDbaDhhawnLrSQFaFx5',
        '33uVWjMEXvu1xBWjydjPod9K87jgjm7WXm',
      ],
      ethereum: ['0x45804880De22913dAFE09f4980848ECE6EcbAf78', '0x0000000000000000000000000000000000000000'],
      solana: ['So11111111111111111111111111111111111111112', 'ExchangeWa11et1111111111111111111111111111'],
    } as const;
    for (const [chain, addresses] of Object.entries(valid))
      for (const a of addresses)
        expect(isAddressOf(chain as keyof typeof valid, a), `${chain} ${a}`).toBe(true);

    expect(isAddressOf('bitcoin', '0x45804880De22913dAFE09f4980848ECE6EcbAf78')).toBe(false);
    expect(isAddressOf('bitcoin', 'bc1bw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false); // "b" is not bech32
    expect(isAddressOf('bitcoin', '1KbDEg1tDz2ErYgaDbaDhhawnLrSQFaF00')).toBe(false); // "0" is not base58
    expect(isAddressOf('ethereum', '0x4580488')).toBe(false);
    expect(isAddressOf('ethereum', '1KbDEg1tDz2ErYgaDbaDhhawnLrSQFaFx5')).toBe(false);
    expect(isAddressOf('solana', 'So1111111111111111111111111111111111111111l')).toBe(false); // "l" is not base58
    expect(isAddressOf('solana', 'So111')).toBe(false);
  });

  it('takes an exchange address in its canonical form, with its owner and where it was published', () => {
    expect(
      CreateExchangeLabelSchema.parse({
        chain: 'ethereum',
        address: '0x45804880De22913dAFE09f4980848ECE6EcbAf78',
        owner: ' Paxos ',
        source: 'https://example.com/reserves',
      }),
    ).toEqual({
      chain: 'ethereum',
      address: PAXG_CONTRACT,
      owner: 'Paxos',
      wallet: 'unknown',
      source: 'https://example.com/reserves',
    });
    const wrong = CreateExchangeLabelSchema.safeParse({
      chain: 'solana',
      address: '0x45804880De22913dAFE09f4980848ECE6EcbAf78',
      owner: 'Example',
      source: 'x',
    });
    expect(wrong.success).toBe(false);
    expect(wrong.error?.issues[0]).toMatchObject({
      path: ['address'],
      message: "The address doesn't have its chain's format.",
    });
    const base = { chain: 'bitcoin', address: '1KbDEg1tDz2ErYgaDbaDhhawnLrSQFaFx5', owner: 'X', source: 'y' };
    expect(CreateExchangeLabelSchema.safeParse({ ...base, wallet: 'cold' }).success).toBe(true);
    expect(CreateExchangeLabelSchema.safeParse({ ...base, wallet: 'warm' }).success).toBe(false);
    expect(CreateExchangeLabelSchema.safeParse({ ...base, owner: 'x'.repeat(61) }).success).toBe(false);
    expect(CreateExchangeLabelSchema.safeParse({ ...base, note: 'extra' }).success).toBe(false);
  });

  it('names a transfer by the listed exchanges at its ends', () => {
    expect(flowOf('Binance', 'Coinbase')).toBe('between_exchanges');
    expect(flowOf(null, 'Coinbase')).toBe('to_exchange');
    expect(flowOf('Binance', null)).toBe('from_exchange');
    expect(flowOf(null, null)).toBe('other');
  });

  it('reads the query strings, and refuses anything else', () => {
    expect(OnchainQuerySchema.parse({ from: '1000', to: '2000', asset: 'PAXG', kind: 'mint' })).toEqual({
      from: 1000,
      to: 2000,
      asset: 'PAXG',
      kind: 'mint',
      limit: 100,
    });
    expect(OnchainQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
    expect(OnchainQuerySchema.safeParse({ asset: 'XAUUSD' }).success).toBe(false);
    expect(OnchainQuerySchema.safeParse({ chain: 'bitcoin' }).success).toBe(false);
    expect(ExchangeFlowQuerySchema.parse({ from: '5' })).toEqual({ from: 5 });
    expect(ExchangeFlowQuerySchema.safeParse({ asset: 'BTC' }).success).toBe(false);
  });

  it('puts PAXG on Ethereum, and reports each source with its state', () => {
    expect(ASSET_CHAIN).toEqual({ BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', PAXG: 'ethereum' });
    const status = {
      updatedAt: 1,
      sources: [
        {
          chain: 'bitcoin',
          provider: 'mempool.space',
          state: 'off',
          detail: 'switched off',
          lastBlock: null,
          lastBlockTime: null,
          watching: null,
        },
      ],
      thresholdsUsd: { BTC: '1000000', ETH: '1000000', SOL: '1000000', PAXG: '250000' },
      stale: false,
    };
    expect(OnchainStatusResponseSchema.parse(status)).toEqual(status);
    expect(
      OnchainStatusResponseSchema.safeParse({
        ...status,
        sources: [{ ...status.sources[0], state: 'asleep' }],
      }).success,
    ).toBe(false);
  });
});
