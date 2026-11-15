import { type QueryClient, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  channels,
  type Page,
  PracticeAccountMessageSchema,
  type PracticeAccounts,
  PracticeAccountsSchema,
  type PracticeFill,
  PracticeFillMessageSchema,
  type PracticeOrder,
  PracticeOrderMessageSchema,
  type PracticePosition,
  PracticeSnapshotSchema,
} from '@cip/contracts';
import { applyAccount, applyOrder, isLiveOrder } from '../lib/practice.js';
import { useSession } from '../session.js';
import { useChannel } from './hooks.js';

/**
 * The signed-in user's practice account (ADR 021): REST for the state, the `practice` channel for
 * every change after. A reconnect that cannot replay what it missed brings the balances and open
 * orders back from the server's snapshot (criterion 14.9).
 */
export const PRACTICE_KEYS = {
  all: ['practice'],
  account: ['practice', 'account'],
  open: ['practice', 'orders', 'open'],
  done: ['practice', 'orders', 'done'],
  fills: ['practice', 'fills'],
  positions: ['practice', 'positions'],
} as const;

const PAGE = 50;

export function usePracticeAccount() {
  const { client } = useSession();
  return useQuery({
    queryKey: PRACTICE_KEYS.account,
    queryFn: async () =>
      PracticeAccountsSchema.parse(await client.request<unknown>('GET', '/api/v1/practice/account')),
  });
}

export function useOpenPracticeOrders() {
  const { client } = useSession();
  return useQuery({
    queryKey: PRACTICE_KEYS.open,
    queryFn: async () =>
      [
        ...(
          await client.request<Page<PracticeOrder>>('GET', '/api/v1/practice/orders?status=open&limit=1000')
        ).items,
      ].sort((a, b) => a.createdAt - b.createdAt),
  });
}

/** Valued at the last prices: refreshed every 5 s while shown, and after each fill. */
export function usePracticePositions() {
  const { client } = useSession();
  return useQuery({
    queryKey: PRACTICE_KEYS.positions,
    queryFn: () => client.request<PracticePosition[]>('GET', '/api/v1/practice/positions'),
    refetchInterval: 5_000,
  });
}

export function usePracticeHistory() {
  const { client } = useSession();
  return useInfiniteQuery({
    queryKey: PRACTICE_KEYS.done,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      client.request<Page<PracticeOrder>>(
        'GET',
        `/api/v1/practice/orders?status=done&limit=${PAGE}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function usePracticeFills() {
  const { client } = useSession();
  return useInfiniteQuery({
    queryKey: PRACTICE_KEYS.fills,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      client.request<Page<PracticeFill>>(
        'GET',
        `/api/v1/practice/fills?limit=${PAGE}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Puts an order into the open orders (or takes it out once finished). */
/**
 * The newest copy of every order this client has seen, finished ones included. The answer to a
 * request (placing or cancelling) can arrive after the channel has already said how the order ended:
 * a market order often fills before its own answer is read. That older copy must not bring a
 * finished order back into the open orders.
 */
const newestSeen = new WeakMap<QueryClient, Map<string, PracticeOrder>>();

function seenBy(queryClient: QueryClient): Map<string, PracticeOrder> {
  let seen = newestSeen.get(queryClient);
  if (!seen) {
    seen = new Map<string, PracticeOrder>();
    newestSeen.set(queryClient, seen);
  }
  return seen;
}

/** Whether `a` is a later state of the order than `b`. */
function later(a: PracticeOrder, b: PracticeOrder): boolean {
  return a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && !isLiveOrder(a) && isLiveOrder(b));
}

/** Remembers the copies a server snapshot brought, so older ones that arrive later are ignored. */
function remember(queryClient: QueryClient, orders: readonly PracticeOrder[]): void {
  const seen = seenBy(queryClient);
  for (const o of orders) {
    const held = seen.get(o.id);
    if (!held || !later(held, o)) seen.set(o.id, o);
  }
}

/** Puts an order into the open orders (or takes it out once finished), unless a newer copy was seen. */
export function useApplyOrder() {
  const queryClient = useQueryClient();
  return (order: PracticeOrder) => {
    const seen = seenBy(queryClient);
    const held = seen.get(order.id);
    if (held && later(held, order)) return;
    seen.set(order.id, order);
    queryClient.setQueryData<PracticeOrder[]>(PRACTICE_KEYS.open, (prev) =>
      prev ? applyOrder(prev, order) : prev,
    );
    if (!isLiveOrder(order)) void queryClient.invalidateQueries({ queryKey: PRACTICE_KEYS.done });
  };
}

/**
 * Follows the `practice` channel for as long as the page is shown. `onFill` hears each new fill
 * (not those replayed after a reconnect), for an announcement.
 */
export function usePracticeChannel(onFill?: (fill: PracticeFill, order: PracticeOrder) => void): void {
  const queryClient = useQueryClient();
  const applyOrderUpdate = useApplyOrder();
  useChannel(channels.practice, {
    onSnapshot: (raw) => {
      const snap = PracticeSnapshotSchema.safeParse(raw);
      if (!snap.success) return;
      queryClient.setQueryData<PracticeAccounts>(PRACTICE_KEYS.account, (prev) =>
        prev ? { ...prev, accounts: snap.data.accounts } : prev,
      );
      remember(queryClient, snap.data.openOrders);
      queryClient.setQueryData<PracticeOrder[]>(PRACTICE_KEYS.open, snap.data.openOrders);
      for (const key of [PRACTICE_KEYS.done, PRACTICE_KEYS.fills, PRACTICE_KEYS.positions])
        void queryClient.invalidateQueries({ queryKey: key });
    },
    onMessage: (message, meta) => {
      if (message.type === 'practice.order') {
        const m = PracticeOrderMessageSchema.safeParse(message.data);
        if (m.success) applyOrderUpdate(m.data.order);
      } else if (message.type === 'practice.fill') {
        const m = PracticeFillMessageSchema.safeParse(message.data);
        if (!m.success) return;
        applyOrderUpdate(m.data.order);
        void queryClient.invalidateQueries({ queryKey: PRACTICE_KEYS.fills });
        void queryClient.invalidateQueries({ queryKey: PRACTICE_KEYS.positions });
        if (!meta.resync) onFill?.(m.data.fill, m.data.order);
      } else if (message.type === 'practice.account') {
        const m = PracticeAccountMessageSchema.safeParse(message.data);
        if (!m.success) return;
        queryClient.setQueryData<PracticeAccounts>(PRACTICE_KEYS.account, (prev) =>
          prev ? { ...prev, accounts: applyAccount(prev.accounts, m.data.account) } : prev,
        );
      }
    },
  });
}
