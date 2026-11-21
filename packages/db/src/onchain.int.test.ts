import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb } from './client.js';
import {
  advanceOnchainCursor,
  deleteOnchainEvents,
  type DetectedOnchainEvent,
  insertOnchainEvents,
  onchainCursor,
} from './onchain.js';
import type { Database } from './types.js';

let owner: Kysely<Database>;
let api: Kysely<Database>;
let jobs: Kysely<Database>;
let others: Kysely<Database>[];

beforeAll(() => {
  owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
  api = createDb({ connectionString: inject('dbRoleUrls').svc_api, max: 2 });
  jobs = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 2 });
  others = (['svc_ingestor', 'svc_analyzer', 'svc_broker'] as const).map((r) =>
    createDb({ connectionString: inject('dbRoleUrls')[r], max: 1 }),
  );
});

afterAll(async () => {
  for (const db of [owner, api, jobs, ...others]) await db.destroy();
});

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

/** 4 July 2026: a day no other test writes on-chain events for. */
const T = Date.UTC(2026, 6, 4, 12);

function detected(
  over: Partial<DetectedOnchainEvent> = {},
): DetectedOnchainEvent & { id: string; receivedAt: number } {
  return {
    id: randomUUID(),
    receivedAt: T + 30_000,
    chain: 'ethereum',
    asset: 'PAXG',
    kind: 'mint',
    txHash: `0x${randomUUID().replace(/-/g, '')}`,
    position: 132,
    blockNumber: 26_429_062,
    blockTime: T,
    from: null,
    to: '0xedd40fe35a559b8f5340b77af93083f3462ebb42',
    amount: '62.9874',
    priceUsd: null,
    usdValue: null,
    provider: 'alchemy',
    ...over,
  };
}

describe('on-chain events (migration 0015, ADR 025)', () => {
  it('lets only the jobs service record events, once per transaction, asset and position', async () => {
    const e = detected();
    expect(await insertOnchainEvents(jobs, [e])).toEqual([e.id]);
    // The same block read twice, or a log pushed twice, adds nothing (criterion 11.2).
    expect(await insertOnchainEvents(jobs, [{ ...e, id: randomUUID() }])).toEqual([]);
    // The same transaction may also move ETH itself at position 0: a different asset is a new event.
    const eth = {
      ...detected({
        asset: 'ETH',
        kind: 'transfer',
        position: 132,
        from: '0x' + '1'.repeat(40),
        to: '0x' + '2'.repeat(40),
        priceUsd: '3200',
        usdValue: '201559.68',
      }),
      txHash: e.txHash,
    };
    expect(await insertOnchainEvents(jobs, [eth])).toEqual([eth.id]);
    expect(await sqlState(insertOnchainEvents(api, [detected()]))).toBe('42501');
    expect(
      await sqlState(
        jobs.updateTable('onchain.events').set({ amount: '1' }).where('id', '=', e.id).execute(),
      ),
    ).toBe('42501');
    // A replaced block's event goes (an Ethereum reorg).
    expect(await deleteOnchainEvents(jobs, 'ethereum', e.txHash, 132)).toBe(2);
    expect(await sqlState(api.deleteFrom('onchain.events').where('id', '=', eth.id).execute())).toBe('42501');
  });

  it('checks each kind: a mint has no sender, a burn no recipient, only PAXG mints and burns', async () => {
    expect(await sqlState(insertOnchainEvents(owner, [detected({ from: '0x' + '1'.repeat(40) })]))).toBe(
      '23514',
    );
    expect(
      await sqlState(insertOnchainEvents(owner, [detected({ kind: 'burn', to: '0x' + '1'.repeat(40) })])),
    ).toBe('23514');
    expect(await sqlState(insertOnchainEvents(owner, [detected({ asset: 'ETH' })]))).toBe('23514');
    expect(await sqlState(insertOnchainEvents(owner, [detected({ priceUsd: '4000' })]))).toBe('23514');
  });

  it("moves a chain's cursor forward only", async () => {
    await advanceOnchainCursor(jobs, 'solana', 300_000_010);
    await advanceOnchainCursor(jobs, 'solana', 300_000_005);
    expect(await onchainCursor(jobs, 'solana')).toBe(300_000_010);
    expect(await onchainCursor(api, 'solana')).toBe(300_000_010);
    expect(await sqlState(advanceOnchainCursor(api, 'solana', 1))).toBe('42501');
  });

  it('lets the api keep the exchange labels, which the jobs service only reads', async () => {
    const label = {
      id: randomUUID(),
      chain: 'ethereum' as const,
      address: '0x' + '7'.repeat(40),
      owner: 'Test exchange',
      source: 'https://example.com/proof-of-reserves',
    };
    await api.insertInto('onchain.labels').values(label).execute();
    expect(
      await jobs.selectFrom('onchain.labels').select('owner').where('id', '=', label.id).executeTakeFirst(),
    ).toEqual({ owner: 'Test exchange' });
    expect(
      await sqlState(
        jobs
          .insertInto('onchain.labels')
          .values({ ...label, id: randomUUID(), address: '0x' + '8'.repeat(40) })
          .execute(),
      ),
    ).toBe('42501');
    // Ethereum addresses are stored lowercased.
    expect(
      await sqlState(
        api
          .insertInto('onchain.labels')
          .values({ ...label, id: randomUUID(), address: '0x' + 'A'.repeat(40) })
          .execute(),
      ),
    ).toBe('23514');
    await api.deleteFrom('onchain.labels').where('id', '=', label.id).execute();
  });

  it('gives the other services no access', async () => {
    for (const db of others) {
      expect(await sqlState(db.selectFrom('onchain.events').select('id').execute())).toBe('42501');
      expect(await sqlState(db.selectFrom('onchain.labels').select('id').execute())).toBe('42501');
    }
  });
});
