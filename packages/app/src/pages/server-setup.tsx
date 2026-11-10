import { useState } from 'react';
import { Alert, Button, Card, CardContent, Input, Label } from '@cip/ui';
import { useSession } from '../session.js';

/** Desktop first run (architecture §13): which server to connect to, then sign in. */
export function ServerSetupPage() {
  const session = useSession();
  const [url, setUrl] = useState('https://');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-5 p-6">
          <header className="space-y-1">
            <h1 className="text-lg font-semibold">Connect to your server</h1>
            <p className="text-sm text-fg-muted">
              Enter the address your administrator gave you. It is remembered on this computer.
            </p>
          </header>
          {error ? (
            <Alert tone="crit" title="Cannot use this address">
              {error}
            </Alert>
          ) : null}
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                await session.chooseServer(new URL(url).origin);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Invalid address.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="server">Server address</Label>
              <Input id="server" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
            </div>
            <Button type="submit" className="w-full" busy={busy}>
              Continue
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
