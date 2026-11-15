import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { channels } from '@cip/contracts';
import { SessionContext } from '../session.js';
import { BTC_BINANCE } from '../test/fixtures.js';
import { signedIn } from '../test/harness.js';
import { useChannel, useLatest, useLiveConnection } from './hooks.js';

const BOOK = channels.book(BTC_BINANCE.id);
const TRADES = channels.trades(BTC_BINANCE.id);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('live hooks', () => {
  it('renders a fast channel at most every 250 ms and always ends on the latest value', async () => {
    const { session, server } = await signedIn();
    let renders = 0;
    function Book() {
      const book = useLatest<{ n: number }>(BOOK);
      renders++;
      return <p>{book.data ? `n=${book.data.n}` : `none (${book.status.state})`}</p>;
    }
    render(
      <SessionContext.Provider value={session}>
        <Book />
      </SessionContext.Provider>,
    );
    expect(await screen.findByText('none (live)')).toBeTruthy();
    const before = renders;
    for (let n = 1; n <= 10; n++) server.push(BOOK, 'book.snapshot', { n });
    expect(await screen.findByText('n=10')).toBeTruthy();
    // The first message shows at once; the other nine are conflated into one trailing render.
    expect(renders - before).toBeLessThanOrEqual(2);
  });

  it('gives a component mounted later the value the shared subscription already holds', async () => {
    const { session, server } = await signedIn();
    server.snapshots[BOOK] = { n: 1 };
    function Book({ label }: { label: string }) {
      const book = useLatest<{ n: number }>(BOOK);
      return <p>{`${label}: ${book.data?.n ?? 'none'}`}</p>;
    }
    const { rerender } = render(
      <SessionContext.Provider value={session}>
        <Book label="first" />
      </SessionContext.Provider>,
    );
    expect(await screen.findByText('first: 1')).toBeTruthy();
    server.push(BOOK, 'book.snapshot', { n: 2 });
    expect(await screen.findByText('first: 2')).toBeTruthy();
    rerender(
      <SessionContext.Provider value={session}>
        <Book label="first" />
        <Book label="second" />
      </SessionContext.Provider>,
    );
    expect(screen.getByText('second: 2')).toBeTruthy();
    expect(server.subscribed().filter((ch) => ch === BOOK)).toHaveLength(1);
  });

  it('delivers durable messages and resync snapshots to the latest handlers, and reports the connection', async () => {
    const { session, server } = await signedIn();
    const seen: string[] = [];
    function Trades({ tag }: { tag: string }) {
      const connection = useLiveConnection();
      useChannel(TRADES, {
        onMessage: (m) => seen.push(`${tag} ${m.type}`),
        onSnapshot: (s, ch) => seen.push(`${tag} snapshot ${ch} ${JSON.stringify(s)}`),
      });
      return <p>connection: {connection.state}</p>;
    }
    const { rerender } = render(
      <SessionContext.Provider value={session}>
        <Trades tag="a" />
      </SessionContext.Provider>,
    );
    expect(await screen.findByText('connection: live')).toBeTruthy();
    await waitFor(() => expect(server.subscribed()).toContain(TRADES));
    server.push(TRADES, 'trade.large', { id: 't1' });
    rerender(
      <SessionContext.Provider value={session}>
        <Trades tag="b" />
      </SessionContext.Provider>,
    );
    server.push(TRADES, 'trade.large', { id: 't2' });
    expect(seen).toEqual(['a trade.large', 'b trade.large']);

    // A reconnect whose gap cannot be replayed hands over a snapshot.
    const socket = server.sockets.last;
    socket.respond = () => ({
      ok: true,
      results: { [TRADES]: { mode: 'snapshot', seq: '9000-0', snapshot: { largeTrades: [] } } },
    });
    act(() => socket.drop());
    expect(screen.getByText('connection: reconnecting')).toBeTruthy();
    act(() => socket.open());
    await waitFor(() => expect(seen).toContain(`b snapshot ${TRADES} {"largeTrades":[]}`));
    expect(socket.subscribeRequests().at(-1)?.since).toEqual({ [TRADES]: '2001-0' });
  });
});
