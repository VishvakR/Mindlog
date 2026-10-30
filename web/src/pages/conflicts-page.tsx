import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Scale } from 'lucide-react';
import { useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api } from '@/lib/api';
import type { ConflictView, MemoryView } from '@/lib/memory';
import { formatScope, initialScope } from '@/lib/memory';

const when = (ms: number) => new Date(ms).toLocaleString();

function Fact({ label, memory, score }: { label: string; memory?: MemoryView; score: number }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums">contradiction {score.toFixed(2)}</span>
      </div>
      {memory ? (
        <>
          <p className="text-sm leading-snug">{memory.text}</p>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={memory.trust === 'quarantined' ? 'destructive' : 'outline'}>
              {memory.trust}
            </Badge>
            <Badge variant="outline">{memory.source.type}</Badge>
            {memory.validToMs && <Badge variant="secondary">ended {when(memory.validToMs)}</Badge>}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {memory.source.principal} · {when(memory.createdAtMs)}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No longer stored</p>
      )}
    </div>
  );
}

/** Conflicts inbox (PLAN 17, ADR-0015): contradicting facts side by side, resolved by a human. */
export function ConflictsPage() {
  const client = useQueryClient();
  const [scope, setScope] = useState(initialScope);
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [since, setSince] = useState<Record<string, string>>({});
  const list = useQuery({
    queryKey: ['conflicts', scope.tenant, scope.scope, show],
    queryFn: () => api.memoryConflicts(scope.tenant, scope.scope, show === 'all'),
    retry: false,
  });
  const resolve = useMutation({
    mutationFn: ({ c, keep }: { c: ConflictView; keep: 'a' | 'b' | 'both' }) =>
      api.memoryResolve(scope.tenant, scope.scope, c.id, keep, since[c.id] || undefined),
    onSuccess: () => {
      toast.success('Resolved; the other fact stays in history.');
      void client.invalidateQueries({ queryKey: ['conflicts'] });
    },
    onError: (e) => toast.error(e.message),
  });
  const conflicts = list.data?.conflicts ?? [];

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Conflicts</CardTitle>
          <CardDescription>
            Facts that contradict each other. The newer one (b) is quarantined until you decide;
            nothing is deleted, the losing fact's validity ends.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <ScopePicker value={scope} onChange={setScope} />
            </div>
            <ToggleGroup
              value={[show]}
              onValueChange={(v: string[]) => setShow(v[0] === 'all' ? 'all' : 'open')}
              variant="outline"
            >
              <ToggleGroupItem value="open">Open</ToggleGroupItem>
              <ToggleGroupItem value="all">All</ToggleGroupItem>
            </ToggleGroup>
          </div>
          {list.isError && <p className="text-sm text-destructive">{list.error.message}</p>}
          {list.isPending && <Skeleton className="h-32" />}
          {list.isSuccess && conflicts.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Scale />
                </EmptyMedia>
                <EmptyTitle>
                  No {show === 'open' ? 'open ' : ''}conflicts in {formatScope(scope.scope)}
                </EmptyTitle>
                <EmptyDescription>
                  Mindlog checks each new fact against similar ones before it is stored.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {conflicts.map((c) => (
            <section key={c.id} className="flex flex-col gap-3 rounded-xl border p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant={c.status === 'open' ? 'destructive' : 'secondary'}>
                  {c.status}
                </Badge>
                <span>
                  {c.origin === 'ingest' ? 'found on remember' : c.origin.replace(':', ' ')}
                </span>
                <span>· policy {c.policy}</span>
                <span>· {when(c.detectedAtMs)}</span>
                <span className="ml-auto font-mono">{c.id}</span>
              </div>
              <div className="flex flex-col gap-3 md:flex-row">
                <Fact label="a · existing" memory={c.a} score={c.scores[0]} />
                <Fact label="b · new" memory={c.b} score={c.scores[1]} />
              </div>
              {c.status === 'open' ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resolve.mutate({ c, keep: 'a' })}
                  >
                    Keep a
                  </Button>
                  <Button size="sm" onClick={() => resolve.mutate({ c, keep: 'b' })}>
                    Keep b
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resolve.mutate({ c, keep: 'both' })}
                  >
                    Keep both
                  </Button>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`since-${c.id}`} className="text-xs text-muted-foreground">
                      b true since (optional, with Keep both)
                    </Label>
                    <Input
                      id={`since-${c.id}`}
                      type="date"
                      className="h-8 w-40"
                      value={since[c.id] ?? ''}
                      onChange={(e) => setSince({ ...since, [c.id]: e.target.value })}
                    />
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Kept {c.keep} {c.resolvedBy ? `· by ${c.resolvedBy}` : ''}{' '}
                  {c.resolvedAtMs ? `· ${when(c.resolvedAtMs)}` : ''}
                </p>
              )}
            </section>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
