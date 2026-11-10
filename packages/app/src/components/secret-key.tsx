import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@cip/ui';

/** Shows a new TOTP secret once, grouped for manual entry, with the otpauth link for apps that accept it. */
export function SecretKey({ secret, uri }: { secret: string; uri: string }) {
  const [copied, setCopied] = useState(false);
  const grouped = secret.match(/.{1,4}/g)?.join(' ') ?? secret;
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-2 p-3 text-sm">
      <p className="text-fg-muted">
        Add this key to your authenticator app (choose &ldquo;enter a setup key&rdquo;, time-based). It is
        shown only now.
      </p>
      <p className="break-all font-mono text-base tracking-wider text-fg" aria-label="Setup key">
        {grouped}
      </p>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={async () => {
          await navigator.clipboard.writeText(uri);
          setCopied(true);
        }}
      >
        <Copy className="size-3.5" aria-hidden /> {copied ? 'Link copied' : 'Copy otpauth link'}
      </Button>
    </div>
  );
}
