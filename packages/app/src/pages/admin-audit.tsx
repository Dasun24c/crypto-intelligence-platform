import { useMutation, useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { AuditChainStatus, AuditEntry, Page } from '@cip/contracts';
import { Alert, Button, Card, CardContent, Input, Label, Spinner, Table, Td, Th } from '@cip/ui';
import { formatInstant } from '../lib/format.js';
import { useSession } from '../session.js';

export function AdminAuditPage() {
  const { client } = useSession();
  const [action, setAction] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const params = new URLSearchParams({
    limit: '100',
    ...(action ? { action } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const page = useQuery({
    queryKey: ['admin', 'audit', action, cursor],
    queryFn: () => client.request<Page<AuditEntry>>('GET', `/api/v1/admin/audit?${params.toString()}`),
  });
  const verify = useMutation({
    mutationFn: () => client.request<AuditChainStatus>('GET', '/api/v1/admin/audit/verify'),
  });

  return (
    <div className="max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-semibold">Audit log</h1>
        <div className="flex items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="action-filter">Action starts with</Label>
            <Input
              id="action-filter"
              placeholder="e.g. auth.login"
              value={action}
              onChange={(e) => {
                setAction(e.target.value.trim());
                setCursors([]);
              }}
            />
          </div>
          <Button variant="secondary" busy={verify.isPending} onClick={() => verify.mutate()}>
            <ShieldCheck className="size-4" aria-hidden /> Verify chain
          </Button>
        </div>
      </header>
      {verify.data ? (
        verify.data.ok ? (
          <Alert tone="ok" title="Hash chain intact">
            All {verify.data.checkedRows} entries verify against their predecessors.
          </Alert>
        ) : (
          <Alert tone="crit" title="Hash chain broken">
            Entry #{verify.data.firstBrokenSeq} does not verify: it or an earlier entry was altered outside
            the application.
          </Alert>
        )
      ) : null}
      {verify.isError ? (
        <Alert tone="crit" title="Verification failed">
          {verify.error.message}
        </Alert>
      ) : null}
      <Card>
        <CardContent className="p-0">
          {page.isPending ? (
            <div className="p-4">
              <Spinner />
            </div>
          ) : page.isError ? (
            <div className="p-4">
              <Alert tone="crit" title="Audit log could not be loaded">
                {page.error.message}
              </Alert>
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Time (UTC)</Th>
                  <Th>Action</Th>
                  <Th>Actor</Th>
                  <Th>Target</Th>
                  <Th>IP</Th>
                  <Th>Details</Th>
                </tr>
              </thead>
              <tbody>
                {page.data.items.map((e) => (
                  <tr key={e.id}>
                    <Td className="font-mono text-xs text-fg-subtle">{e.id}</Td>
                    <Td className="whitespace-nowrap text-xs">{formatInstant(e.at)}</Td>
                    <Td className="font-mono text-xs">{e.action}</Td>
                    <Td className="font-mono text-xs">{e.actorUserId ?? e.actorType}</Td>
                    <Td className="font-mono text-xs">{e.targetId ?? '—'}</Td>
                    <Td className="font-mono text-xs">{e.ip ?? '—'}</Td>
                    <Td
                      className="max-w-xs truncate font-mono text-xs text-fg-muted"
                      title={JSON.stringify(e.details)}
                    >
                      {JSON.stringify(e.details)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={cursors.length === 0}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          Newer
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!page.data?.nextCursor}
          onClick={() => {
            const next = page.data?.nextCursor;
            if (next) setCursors((c) => [...c, next]);
          }}
        >
          Older
        </Button>
      </div>
    </div>
  );
}
