import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import {
  type AdminUser,
  type CreateUserRequest,
  CreateUserRequestSchema,
  type Page,
  ROLES,
  type Role,
  type UpdateUserRequest,
} from '@cip/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@cip/ui';
import { ApiError } from '../api/client.js';
import { formatInstant } from '../lib/format.js';
import { useCurrentUser, useSession } from '../session.js';

const USERS_KEY = ['admin', 'users'];

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.input<typeof CreateUserRequestSchema>, unknown, CreateUserRequest>({
    resolver: zodResolver(CreateUserRequestSchema),
    defaultValues: { role: 'viewer' },
  });
  const { errors, isSubmitting } = form.formState;
  return (
    <form
      noValidate
      aria-label="Create user"
      className="grid gap-4 md:grid-cols-2"
      onSubmit={form.handleSubmit(async (values) => {
        setError(null);
        try {
          await client.request<AdminUser>('POST', '/api/v1/admin/users', values);
          await queryClient.invalidateQueries({ queryKey: USERS_KEY });
          form.reset({ role: 'viewer' });
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not create the user.');
        }
      })}
    >
      {error ? (
        <div className="md:col-span-2">
          <Alert tone="crit" title="User not created">
            {error}
          </Alert>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="new-email">E-mail</Label>
        <Input id="new-email" type="email" aria-invalid={!!errors.email} {...form.register('email')} />
        {errors.email ? <p className="text-xs text-crit">{errors.email.message}</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-name">Display name</Label>
        <Input id="new-name" aria-invalid={!!errors.displayName} {...form.register('displayName')} />
        {errors.displayName ? <p className="text-xs text-crit">{errors.displayName.message}</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-role">Role</Label>
        <Select id="new-role" className="w-full" {...form.register('role')}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-password">Initial password</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          aria-invalid={!!errors.password}
          {...form.register('password')}
        />
        {errors.password ? <p className="text-xs text-crit">{errors.password.message}</p> : null}
      </div>
      <p className="text-xs text-fg-subtle md:col-span-2">
        Give the initial password to the person directly. Admins set up an authenticator at their first
        sign-in.
      </p>
      <div className="md:col-span-2">
        <Button type="submit" busy={isSubmitting}>
          Create user
        </Button>
      </div>
    </form>
  );
}

export function AdminUsersPage() {
  const { client } = useSession();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const users = useQuery({
    queryKey: USERS_KEY,
    queryFn: () => client.request<Page<AdminUser>>('GET', '/api/v1/admin/users'),
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateUserRequest }) =>
      client.request<AdminUser>('PATCH', `/api/v1/admin/users/${id}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
    onError: (err) => setActionError(err instanceof ApiError ? err.message : 'The change failed.'),
  });
  const resetMfa = useMutation({
    mutationFn: (id: string) => client.request<void>('POST', `/api/v1/admin/users/${id}/reset-mfa`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
    onError: (err) => setActionError(err instanceof ApiError ? err.message : 'The reset failed.'),
  });

  return (
    <div className="max-w-6xl space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Users</h1>
        <Button variant="secondary" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
          <UserPlus className="size-4" aria-hidden /> {creating ? 'Close' : 'New user'}
        </Button>
      </header>
      {creating ? (
        <Card>
          <CardHeader>
            <CardTitle>New user</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateUserForm onDone={() => setCreating(false)} />
          </CardContent>
        </Card>
      ) : null}
      {actionError ? (
        <Alert tone="crit" title="Change refused">
          {actionError}
        </Alert>
      ) : null}
      <Card>
        <CardContent className="p-0">
          {users.isPending ? (
            <div className="p-4">
              <Spinner />
            </div>
          ) : users.isError ? (
            <div className="p-4">
              <Alert tone="crit" title="Users could not be loaded">
                {users.error.message}
              </Alert>
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>User</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>MFA</Th>
                  <Th>Last sign-in (UTC)</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((u) => (
                  <tr key={u.id}>
                    <Td>
                      <div className="font-medium">{u.displayName}</div>
                      <div className="text-xs text-fg-muted">{u.email}</div>
                    </Td>
                    <Td>
                      <Select
                        aria-label={`Role of ${u.email}`}
                        value={u.role}
                        disabled={update.isPending}
                        onChange={(e) => {
                          setActionError(null);
                          const role = e.target.value as Role;
                          if (window.confirm(`Change ${u.email} to ${role}?`))
                            update.mutate({ id: u.id, patch: { role } });
                        }}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    <Td>
                      <StatusBadge
                        tone={u.status === 'active' ? 'ok' : u.status === 'locked' ? 'warn' : 'crit'}
                        label={u.status}
                      />
                    </Td>
                    <Td>{u.mfaEnabled ? <Badge tone="ok">enabled</Badge> : <Badge>off</Badge>}</Td>
                    <Td className="text-xs text-fg-muted">
                      {u.lastLoginAt ? formatInstant(u.lastLoginAt) : 'never'}
                    </Td>
                    <Td className="space-x-2 whitespace-nowrap">
                      {u.status === 'disabled' ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => update.mutate({ id: u.id, patch: { status: 'active' } })}
                        >
                          Enable
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={u.id === me.id}
                          onClick={() => {
                            setActionError(null);
                            if (window.confirm(`Disable ${u.email}? They are signed out everywhere.`)) {
                              update.mutate({ id: u.id, patch: { status: 'disabled' } });
                            }
                          }}
                        >
                          Disable
                        </Button>
                      )}
                      {u.status === 'locked' ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => update.mutate({ id: u.id, patch: { status: 'active' } })}
                        >
                          Unlock
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!u.mfaEnabled}
                        onClick={() => {
                          setActionError(null);
                          if (
                            window.confirm(
                              `Reset the authenticator of ${u.email}? They must set it up again.`,
                            )
                          )
                            resetMfa.mutate(u.id);
                        }}
                      >
                        Reset MFA
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
