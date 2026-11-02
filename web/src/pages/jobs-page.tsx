import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ListChecks, Play, Snowflake, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ScopePicker } from '@/components/memory/scope-picker';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api } from '@/lib/api';
import type { JobView, LifecycleView } from '@/lib/memory';
import { formatScope, initialScope } from '@/lib/memory';

const when = (ms: number) => new Date(ms).toLocaleString();
const short = (kind: string) => kind.replace('consolidation.', '');
const STATE_VARIANT = { queued: 'outline', leased: 'default', dead: 'destructive' } as const;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
      {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function Lifecycle({ l }: { l: LifecycleView }) {
  const total = l.hot + l.cold;
  const coldShare = total === 0 ? 0 : Math.round((100 * l.cold) / total);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="Hot memories" value={String(l.hot)} hint="In the vector index" />
      <Stat
        label="Cold tier"
        value={String(l.cold)}
        hint={l.coldTier ? `${String(coldShare)}% of current memory` : 'No cold tier configured'}
      />
      <Stat
        label="Since sleep-time"
        value={String(l.writesSinceSleep)}
        hint={`${String(l.writesSinceEvolve)} since evolution`}
      />
      <Stat
        label="Embedding model"
        value={l.reembed ? 'Re-embedding' : 'Current'}
        hint={l.embedModel || 'none yet'}
      />
    </div>
  );
}

function download(name: string, base64: string): void {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Jobs page (PLAN 17.2): a scope's background work, its lifecycle counts, export and import. */
export function JobsPage() {
  const client = useQueryClient();
  const [scope, setScope] = useState(initialScope);
  const [state, setState] = useState<'all' | JobView['state']>('all');
  const file = useRef<HTMLInputElement>(null);
  const jobs = useQuery({
    queryKey: ['jobs', scope.tenant, scope.scope, state],
    queryFn: () => api.memoryJobs(scope.tenant, scope.scope, state === 'all' ? undefined : state),
    refetchInterval: 5000,
    retry: false,
  });
  const consolidate = useMutation({
    mutationFn: () => api.memoryConsolidate(scope.tenant, scope.scope),
    onSuccess: (r) => {
      toast.success(
        r.enqueued.length === 0
          ? 'Every worker already has a job queued.'
          : `Queued ${r.enqueued.map(short).join(', ')}.`,
      );
      void client.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (e) => toast.error(e.message),
  });
  const exported = useMutation({
    mutationFn: () => api.memoryExport(scope.tenant, scope.scope),
    onSuccess: (r) => {
      download(`${formatScope(scope.scope).replaceAll('/', '-') || 'tenant'}.mcube`, r.data);
      toast.success(`Exported ${(r.bytes / 1024).toFixed(1)} KB.`);
    },
    onError: (e) => toast.error(e.message),
  });
  const imported = useMutation({
    mutationFn: async (f: File) =>
      api.memoryImport(
        scope.tenant,
        scope.scope,
        await toBase64(f),
        f.name.endsWith('.mcube') ? 'mcube' : 'cogx',
        f.name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 128),
      ),
    onSuccess: (r) => {
      toast.success(
        `Imported ${String(r.imported)} memories${r.skipped ? `, skipped ${String(r.skipped)}` : ''}; they are quarantined until reviewed.`,
      );
      void client.invalidateQueries({ queryKey: ['memories'] });
    },
    onError: (e) => toast.error(e.message),
  });
  const list = jobs.data?.jobs ?? [];

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Jobs</CardTitle>
          <CardDescription>
            Background work on a scope: enrichment, consolidation (sleep-time, evolution, dedup,
            themes, entity summaries), forgetting into the cold tier and re-embedding. Dead jobs
            stay here after five failed attempts.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <ScopePicker value={scope} onChange={setScope} />
            </div>
            <Button onClick={() => consolidate.mutate()} disabled={consolidate.isPending}>
              <Play /> Run consolidation
            </Button>
          </div>
          {jobs.isError && <p className="text-sm text-destructive">{jobs.error.message}</p>}
          {jobs.isPending && <Skeleton className="h-20" />}
          {jobs.data && <Lifecycle l={jobs.data.lifecycle} />}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ToggleGroup
              value={[state]}
              onValueChange={(v: string[]) => setState((v[0] as typeof state | undefined) ?? 'all')}
              variant="outline"
            >
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              <ToggleGroupItem value="queued">Queued</ToggleGroupItem>
              <ToggleGroupItem value="leased">Running</ToggleGroupItem>
              <ToggleGroupItem value="dead">Dead</ToggleGroupItem>
            </ToggleGroup>
            {jobs.data?.lifecycle.tickAtMs && (
              <span className="text-xs text-muted-foreground">
                Next consolidation check {when(jobs.data.lifecycle.tickAtMs)}
              </span>
            )}
          </div>
          {jobs.isSuccess && list.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ListChecks />
                </EmptyMedia>
                <EmptyTitle>No jobs in {formatScope(scope.scope)}</EmptyTitle>
                <EmptyDescription>
                  Writes schedule a consolidation check; enrichment runs when models were down.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>Runs at</TableHead>
                  <TableHead>Why or last error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell>
                      <div className="font-medium">{short(j.kind)}</div>
                      <div className="font-mono text-xs text-muted-foreground">{j.id}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATE_VARIANT[j.state]}>
                        {j.state === 'leased' ? 'running' : j.state}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {j.attempts}
                      {j.deferrals > 0 && (
                        <span className="text-muted-foreground"> ({j.deferrals} deferred)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {when(j.leaseUntilMs ?? j.runAtMs)}
                    </TableCell>
                    <TableCell className="max-w-sm text-xs">
                      {j.error ? (
                        <span className="text-destructive">{j.error}</span>
                      ) : (
                        <span className="text-muted-foreground">{j.why ?? '—'}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Memory cubes</CardTitle>
          <CardDescription>
            Export the scope as a <code>.mcube</code>, cold memories included, or import a cube or a
            COGX archive (Cognee's exchange format, also produced from Mem0, Letta and Zep).
            Imported memories follow the trust policy.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => exported.mutate()} disabled={exported.isPending}>
            <Download /> Export {formatScope(scope.scope) || 'scope'}
          </Button>
          <Button
            variant="outline"
            onClick={() => file.current?.click()}
            disabled={imported.isPending}
          >
            <Upload /> Import archive
          </Button>
          <input
            ref={file}
            type="file"
            accept=".mcube,.gz,.tgz,.cogx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) imported.mutate(f);
              e.target.value = '';
            }}
          />
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Snowflake className="size-3" /> Cold memories are read back from the blob store.
          </span>
        </CardContent>
      </Card>
    </div>
  );
}
