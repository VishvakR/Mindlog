import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ClusterAction, ClusterNode, ClusterRange } from '@/lib/api';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/key-types';

interface Pending {
  action: ClusterAction;
  title: string;
  detail: string;
}

const stateVariant = (state: string) =>
  state === 'live'
    ? 'default'
    : state === 'draining' || state === 'suspect'
      ? 'secondary'
      : 'outline';

const span = (r: ClusterRange) => `${r.start || '−∞'} → ${r.end || '+∞'}`;

export function ClusterPage() {
  const client = useQueryClient();
  const [pending, setPending] = useState<Pending | undefined>();
  const overview = useQuery({
    queryKey: ['cluster'],
    queryFn: api.cluster,
    refetchInterval: 3000,
    retry: false,
  });
  const act = useMutation({
    mutationFn: api.clusterAction,
    onSuccess: (r) => {
      toast.success(r.message);
      void client.invalidateQueries({ queryKey: ['cluster'] });
    },
    onError: (e) => toast.error(e.message),
  });
  const c = overview.data;
  const leaderOf = (r: ClusterRange) => r.replicas.filter((p) => p.role === 'voter');

  const stats = [
    {
      label: 'Nodes',
      value: c ? String(c.nodes.length) : undefined,
      hint: 'Known to the placement driver',
    },
    {
      label: 'Ranges',
      value: c ? String(c.ranges.length) : undefined,
      hint: 'Key spans, each its own Raft group',
    },
    {
      label: 'Replicas',
      value: c ? String(c.ranges.reduce((n, r) => n + r.replicas.length, 0)) : undefined,
      hint: 'Across all ranges',
    },
    {
      label: 'Cluster version',
      value: c ? String(c.clusterVersion) : undefined,
      hint: 'Lowest binary version in use',
    },
  ];

  const drain = (n: ClusterNode) =>
    setPending({
      action: { action: n.state === 'draining' ? 'undrain-node' : 'drain-node', nodeId: n.id },
      title: `${n.state === 'draining' ? 'Stop draining' : 'Drain'} node ${n.id}?`,
      detail:
        n.state === 'draining'
          ? 'The node takes replicas again.'
          : 'Its replicas are moved to other nodes. It keeps serving until they are gone.',
    });

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {overview.isError && (
        <p className="text-sm text-destructive">
          {overview.error.message.includes('placement driver')
            ? 'This node has no placement driver, so there is no cluster view.'
            : `Could not load the cluster: ${overview.error.message}`}
        </p>
      )}
      <section aria-label="Totals" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} size="sm">
            <CardHeader>
              <CardDescription>{s.label}</CardDescription>
              <CardTitle className="font-mono text-2xl tabular-nums">
                {s.value ?? <Skeleton className="h-8 w-16" />}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">{s.hint}</CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Nodes</CardTitle>
          <CardDescription>Refreshes every 3 seconds.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Node</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Zone</TableHead>
                <TableHead className="text-right">Ranges</TableHead>
                <TableHead className="text-right">Leaders</TableHead>
                <TableHead className="text-right">Data</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(c?.nodes ?? []).map((n) => (
                <TableRow key={n.id}>
                  <TableCell>
                    <div className="font-mono">{n.id}</div>
                    <div className="text-xs text-muted-foreground">{n.address}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={stateVariant(n.state)}>{n.state}</Badge>
                  </TableCell>
                  <TableCell>{n.zone}</TableCell>
                  <TableCell className="text-right tabular-nums">{n.ranges}</TableCell>
                  <TableCell className="text-right tabular-nums">{n.leaders}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatBytes(n.usedBytes)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => drain(n)}>
                      {n.state === 'draining' ? 'Undrain' : 'Drain'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!c && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-5" />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ranges</CardTitle>
          <CardDescription>
            Each range is a Raft group over a span of keys; PD splits, merges and moves them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Range</TableHead>
                <TableHead>Span</TableHead>
                <TableHead>Epoch</TableHead>
                <TableHead>Replicas (node)</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(c?.ranges ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono">{r.id}</TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-xs" title={span(r)}>
                    {span(r)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.epoch}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {r.replicas.map((p) => (
                        <Badge
                          key={p.replicaId}
                          variant={p.role === 'voter' ? 'secondary' : 'outline'}
                          title={`replica ${p.replicaId}, ${p.role}`}
                        >
                          n{p.nodeId}
                          {p.role === 'learner' ? ' · learner' : ''}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={leaderOf(r).length === 0}
                      onClick={() =>
                        setPending({
                          action: { action: 'split', rangeId: r.id },
                          title: `Split range ${r.id}?`,
                          detail: 'The range is cut at the middle of its data into two ranges.',
                        })
                      }
                    >
                      Split
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Placement decisions</CardTitle>
          <CardDescription>What PD is doing now, and why.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(c?.operators.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">Nothing is moving.</p>
          )}
          {[...(c?.operators ?? []), ...(c?.recent ?? [])].map((o) => (
            <div key={`${o.id}-${o.status}`} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{o.scheduler}</Badge>
                <span className="font-mono">range {o.rangeId}</span>
                <span className="text-muted-foreground">
                  step {Math.min(o.step + 1, o.steps.length)} of {o.steps.length}:{' '}
                  {o.steps.join(' → ')}
                </span>
                <Badge variant="outline" className="ml-auto">
                  {o.status}
                </Badge>
              </div>
              <p className="mt-1 text-muted-foreground">{o.explanation}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <AlertDialog
        open={pending !== undefined}
        onOpenChange={(open) => !open && setPending(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            <AlertDialogDescription>{pending?.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) act.mutate(pending.action);
                setPending(undefined);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
