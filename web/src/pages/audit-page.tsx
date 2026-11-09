import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ScrollText, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AuditEntry } from '@/lib/api';
import { api, session } from '@/lib/api';

const when = (ms: number) => new Date(ms).toLocaleString();

function AuditTrail() {
  const [tenant, setTenant] = useState(session.tenant() ?? 'default');
  const [filter, setFilter] = useState('');
  const pages = useInfiniteQuery({
    queryKey: ['audit', tenant],
    queryFn: ({ pageParam }) => api.audit(tenant, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor,
    enabled: tenant !== '',
  });
  const needle = filter.toLowerCase();
  const rows: AuditEntry[] = (pages.data?.pages ?? [])
    .flatMap((p) => p.items)
    .filter((e) =>
      `${e.principal} ${e.action} ${e.resource} ${e.detail}`.toLowerCase().includes(needle),
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit trail</CardTitle>
        <CardDescription>
          Who did what, newest first. Refused requests appear with the reason.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="audit-tenant">Tenant</Label>
            <Input
              id="audit-tenant"
              value={tenant}
              disabled={session.tenant() !== null}
              onChange={(e) => {
                setTenant(e.target.value.trim());
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="audit-filter">Filter</Label>
            <Input
              id="audit-filter"
              placeholder="principal, action, resource or reason"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
              }}
            />
          </div>
        </div>
        {pages.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : pages.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {pages.error.message}
          </p>
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldCheck />
              </EmptyMedia>
              <EmptyTitle>Nothing recorded</EmptyTitle>
              <EmptyDescription>Security-relevant changes will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">{when(e.atMs)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {e.principal}
                      {e.actor && <span className="text-muted-foreground"> via {e.actor}</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.action}</TableCell>
                    <TableCell className="font-mono text-xs">{e.resource}</TableCell>
                    <TableCell>
                      <Badge variant={e.ok ? 'outline' : 'destructive'}>
                        {e.ok ? 'done' : 'refused'}
                      </Badge>
                      {e.detail && (
                        <span className="ml-2 text-xs text-muted-foreground">{e.detail}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {pages.hasNextPage && (
          <Button
            variant="outline"
            className="self-center"
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            Load older
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

const LEVEL_VARIANT = {
  info: 'outline',
  warn: 'secondary',
  error: 'destructive',
  fatal: 'destructive',
} as const;

function RecentLogs() {
  const logs = useQuery({ queryKey: ['logs'], queryFn: api.logs, refetchInterval: 5_000 });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent logs</CardTitle>
        <CardDescription>The last entries on this node. Secrets are removed.</CardDescription>
      </CardHeader>
      <CardContent>
        {logs.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : logs.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {logs.error.message}
          </p>
        ) : logs.data.entries.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ScrollText />
              </EmptyMedia>
              <EmptyTitle>No log entries yet</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col divide-y font-mono text-xs">
            {logs.data.entries.map((l, i) => (
              <li key={`${String(l.atMs)}-${String(i)}`} className="flex flex-wrap gap-2 py-1.5">
                <span className="tabular-nums text-muted-foreground">{when(l.atMs)}</span>
                <Badge variant={LEVEL_VARIANT[l.level]}>{l.level}</Badge>
                <span>{l.message}</span>
                {Object.keys(l.fields).length > 0 && (
                  <span className="break-all text-muted-foreground">
                    {JSON.stringify(l.fields)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The audit trail, and for operators the node's recent logs (PLAN 17). */
export function AuditPage() {
  if (session.tenant() !== null) return <AuditTrail />;
  return (
    <Tabs defaultValue="audit">
      <TabsList>
        <TabsTrigger value="audit">Audit trail</TabsTrigger>
        <TabsTrigger value="logs">Recent logs</TabsTrigger>
      </TabsList>
      <TabsContent value="audit">
        <AuditTrail />
      </TabsContent>
      <TabsContent value="logs">
        <RecentLogs />
      </TabsContent>
    </Tabs>
  );
}
