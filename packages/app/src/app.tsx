import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Spinner } from '@cip/ui';
import { LoginPage } from './pages/login.js';
import { ServerSetupPage } from './pages/server-setup.js';
import { createAppRouter } from './router.js';
import { type Session, SessionContext } from './session.js';

export function App({ session }: { session: Session }) {
  const state = session.store((s) => s.state);
  const [router] = useState(createAppRouter);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 2_000 } },
      }),
  );

  useEffect(() => {
    void session.bootstrap();
  }, [session]);

  // After sleep or a network change, refetch everything and resync the live channels, so no widget
  // shows stale data as current.
  useEffect(
    () =>
      session.platform.onSleepWake(() => {
        void queryClient.invalidateQueries();
        session.live.reconnect();
      }),
    [session, queryClient],
  );

  // Nothing from a previous user's session survives sign-out.
  useEffect(() => {
    if (state.status === 'signed-out') queryClient.clear();
  }, [state.status, queryClient]);

  let content;
  if (state.status === 'loading') {
    content = (
      <main className="flex min-h-screen items-center justify-center">
        <Spinner label="Connecting" />
      </main>
    );
  } else if (state.status === 'needs-server') {
    content = <ServerSetupPage />;
  } else if (state.status === 'signed-in') {
    content = <RouterProvider router={router} context={{ user: state.user }} />;
  } else {
    content = <LoginPage />;
  }

  return (
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queryClient}>{content}</QueryClientProvider>
    </SessionContext.Provider>
  );
}
