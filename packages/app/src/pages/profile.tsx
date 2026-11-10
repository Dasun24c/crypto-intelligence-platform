import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { type MfaSecretResponse, PasswordSchema, TotpCodeSchema } from '@cip/contracts';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, StatusBadge } from '@cip/ui';
import { SecretKey } from '../components/secret-key.js';
import { useSession, useSessionState } from '../session.js';

const PasswordForm = z
  .object({ currentPassword: z.string().min(1), newPassword: PasswordSchema, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, { error: 'The passwords do not match.', path: ['confirm'] });

function ChangePassword() {
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof PasswordForm>>({ resolver: zodResolver(PasswordForm) });
  const { errors, isSubmitting } = form.formState;
  return (
    <form
      noValidate
      className="max-w-sm space-y-4"
      aria-label="Change password"
      onSubmit={form.handleSubmit(async ({ currentPassword, newPassword }) => {
        setError(null);
        try {
          await session.client.request<void>('PUT', '/api/v1/me/password', { currentPassword, newPassword });
          await session.logout('Password changed. Sign in with your new password.');
        } catch (err) {
          setError(err instanceof Error ? err.message : 'The password was not changed.');
        }
      })}
    >
      {error ? (
        <Alert tone="crit" title="Password not changed">
          {error}
        </Alert>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="current-password">Current password</Label>
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          {...form.register('currentPassword')}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          aria-invalid={!!errors.newPassword}
          {...form.register('newPassword')}
        />
        {errors.newPassword ? <p className="text-xs text-crit">{errors.newPassword.message}</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm-password">Repeat new password</Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          aria-invalid={!!errors.confirm}
          {...form.register('confirm')}
        />
        {errors.confirm ? <p className="text-xs text-crit">{errors.confirm.message}</p> : null}
      </div>
      <p className="text-xs text-fg-subtle">Changing your password signs you out on every device.</p>
      <Button type="submit" busy={isSubmitting}>
        Change password
      </Button>
    </form>
  );
}

function SetUpMfa() {
  const session = useSession();
  const [secret, setSecret] = useState<MfaSecretResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm<{ code: string }>({ resolver: zodResolver(z.object({ code: TotpCodeSchema })) });
  if (!secret) {
    return (
      <div className="space-y-3">
        {error ? (
          <Alert tone="crit" title="Could not start set-up">
            {error}
          </Alert>
        ) : null}
        <Button
          variant="secondary"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setSecret(await session.client.request<MfaSecretResponse>('POST', '/api/v1/me/mfa/setup'));
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Set-up failed.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Set up authenticator
        </Button>
      </div>
    );
  }
  return (
    <form
      noValidate
      className="max-w-sm space-y-4"
      onSubmit={form.handleSubmit(async ({ code }) => {
        setError(null);
        try {
          await session.client.request<void>('POST', '/api/v1/me/mfa/confirm', { code });
          await session.reloadMe();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'The code was not accepted.');
        }
      })}
    >
      <SecretKey secret={secret.secret} uri={secret.otpauthUri} />
      {error ? (
        <Alert tone="crit" title="Code not accepted">
          {error}
        </Alert>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="mfa-code">Code from your authenticator</Label>
        <Input
          id="mfa-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          {...form.register('code')}
        />
      </div>
      <Button type="submit" busy={form.formState.isSubmitting}>
        Confirm
      </Button>
    </form>
  );
}

export function ProfilePage() {
  const state = useSessionState();
  if (state.status !== 'signed-in') return null;
  const { me } = state;
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">Profile</h1>
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-fg-muted">Name</dt>
            <dd>{me.user.displayName}</dd>
            <dt className="text-fg-muted">E-mail</dt>
            <dd>{me.user.email}</dd>
            <dt className="text-fg-muted">Role</dt>
            <dd>{me.role}</dd>
            <dt className="text-fg-muted">Two-step sign-in</dt>
            <dd>
              {me.mfaEnabled ? (
                <StatusBadge tone="ok" label="Enabled" />
              ) : (
                <StatusBadge tone="warn" label="Not set up" />
              )}
            </dd>
          </dl>
        </CardContent>
      </Card>
      {!me.mfaEnabled ? (
        <Card>
          <CardHeader>
            <CardTitle>Two-step sign-in</CardTitle>
          </CardHeader>
          <CardContent>
            <SetUpMfa />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
        </CardHeader>
        <CardContent>
          <ChangePassword />
        </CardContent>
      </Card>
    </div>
  );
}
