import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { TotpCodeSchema } from '@cip/contracts';
import { Alert, Button, Card, CardContent, Input, Label } from '@cip/ui';
import { ApiError } from '../api/client.js';
import { useSession, useSessionState } from '../session.js';
import { SecretKey } from '../components/secret-key.js';

const CredentialsSchema = z.object({
  email: z.email({ error: 'Enter your e-mail address.' }),
  password: z.string().min(1, { error: 'Enter your password.' }),
});
const CodeSchema = z.object({ code: TotpCodeSchema });

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'The server could not be reached. Check your connection and try again.';
}

function CredentialsStep({ notice }: { notice?: string | undefined }) {
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof CredentialsSchema>>({ resolver: zodResolver(CredentialsSchema) });
  const onSubmit = form.handleSubmit(async ({ email, password }) => {
    setError(null);
    try {
      await session.login(email, password);
    } catch (err) {
      setError(message(err));
    }
  });
  const { errors, isSubmitting } = form.formState;
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4" aria-label="Sign in">
      {notice ? <Alert tone="info" title={notice} /> : null}
      {error ? (
        <Alert tone="crit" title="Sign-in failed">
          {error}
        </Alert>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="email">E-mail</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          aria-invalid={!!errors.email}
          {...form.register('email')}
        />
        {errors.email ? <p className="text-xs text-crit">{errors.email.message}</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={!!errors.password}
          {...form.register('password')}
        />
        {errors.password ? <p className="text-xs text-crit">{errors.password.message}</p> : null}
      </div>
      <Button type="submit" className="w-full" busy={isSubmitting}>
        Sign in
      </Button>
    </form>
  );
}

function CodeStep() {
  const session = useSession();
  const state = useSessionState();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const form = useForm<z.infer<typeof CodeSchema>>({ resolver: zodResolver(CodeSchema) });
  if (state.status !== 'mfa') return null;

  const onSubmit = form.handleSubmit(async ({ code }) => {
    setError(null);
    try {
      await session.verifyMfa(code);
    } catch (err) {
      setError(message(err));
      form.reset({ code: '' });
    }
  });

  if (state.enrollmentRequired && !state.enrollment) {
    return (
      <div className="space-y-4">
        <Alert tone="warn" title="Set up two-step sign-in">
          Your role requires an authenticator app (such as Microsoft Authenticator, Google Authenticator or
          1Password). You set it up once, then enter its 6-digit code at each sign-in.
        </Alert>
        {error ? (
          <Alert tone="crit" title="Could not start set-up">
            {error}
          </Alert>
        ) : null}
        <Button
          className="w-full"
          busy={starting}
          onClick={async () => {
            setStarting(true);
            setError(null);
            try {
              await session.startEnrollment();
            } catch (err) {
              setError(message(err));
            } finally {
              setStarting(false);
            }
          }}
        >
          <KeyRound className="size-4" aria-hidden /> Set up authenticator
        </Button>
        <Button variant="ghost" className="w-full" onClick={() => session.cancelMfa()}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4" aria-label="Second factor">
      {state.enrollment ? (
        <SecretKey secret={state.enrollment.secret} uri={state.enrollment.otpauthUri} />
      ) : null}
      {error ? (
        <Alert tone="crit" title="Code not accepted">
          {error}
        </Alert>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="code">
          {state.enrollment ? 'Code shown by your authenticator' : 'Authenticator code'}
        </Label>
        <Input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          aria-invalid={!!form.formState.errors.code}
          {...form.register('code')}
        />
        {form.formState.errors.code ? (
          <p className="text-xs text-crit">{form.formState.errors.code.message}</p>
        ) : null}
      </div>
      <Button type="submit" className="w-full" busy={form.formState.isSubmitting}>
        <ShieldCheck className="size-4" aria-hidden /> Verify
      </Button>
      <Button type="button" variant="ghost" className="w-full" onClick={() => session.cancelMfa()}>
        Cancel
      </Button>
    </form>
  );
}

export function LoginPage() {
  const state = useSessionState();
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-6 p-6">
          <header className="space-y-1">
            <h1 className="text-lg font-semibold">Crypto Intelligence Platform</h1>
            <p className="text-sm text-fg-muted">
              {state.status === 'mfa' ? 'Two-step sign-in' : 'Sign in to continue'}
            </p>
          </header>
          {state.status === 'mfa' ? (
            <CodeStep />
          ) : (
            <CredentialsStep notice={state.status === 'signed-out' ? state.notice : undefined} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}
