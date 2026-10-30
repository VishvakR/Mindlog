import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ScopePicker } from '@/components/memory/scope-picker';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import type { MemoryView } from '@/lib/memory';
import { formatScope, initialScope } from '@/lib/memory';

const when = (ms: number) => new Date(ms).toLocaleString();

/** What changed about a memory between then and now. */
function since(then: MemoryView, now: MemoryView | undefined): string | undefined {
  if (!now) return undefined;
  if (now.expiredAtMs && !then.expiredAtMs) return 'forgotten since';
  if (now.trust !== then.trust) return `now ${now.trust}`;
  if (now.validToMs && !then.validToMs) return 'superseded since';
  return undefined;
}

/** Time travel (PLAN 13.3, 17): the scope as it was at a moment (ASOF), against now. */
export function TimeTravelPage() {
  const [scope, setScope] = useState(initialScope);
  const [at, setAt] = useState<number | undefined>();
  const current = useQuery({
    queryKey: ['memories-now', scope.tenant, scope.scope],
    queryFn: () => api.memoryList(scope.tenant, scope.scope),
    retry: false,
  });
  const nowList = current.data?.memories ?? [];
  const [start, end] = useMemo(() => {
    const times = nowList.map((m) => m.createdAtMs);
    const first = times.length ? Math.min(...times) : Date.now() - 3_600_000;
    return [first - 1000, Date.now()];
  }, [nowList]);
  const t = at ?? end;
  const past = useQuery({
    queryKey: ['memories-asof', scope.tenant, scope.scope, t],
    queryFn: () => api.memoryAsOf(scope.tenant, scope.scope, t),
    retry: false,
  });
  const byId = new Map(nowList.map((m) => [m.id, m]));
  const then = (past.data?.memories ?? []).filter((m) => !m.expiredAtMs);
  const added = nowList.filter((m) => m.createdAtMs > t && !m.expiredAtMs).length;

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Time travel</CardTitle>
          <CardDescription>
            Read a scope as it was at any moment, straight from the log's versions. Drag back to see
            what agents knew before a plan or a merge.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <ScopePicker value={scope} onChange={setScope} />
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <Label htmlFor="asof">As of</Label>
              <span className="font-mono text-sm tabular-nums">{when(t)}</span>
            </div>
            <input
              id="asof"
              type="range"
              className="w-full accent-primary"
              min={start}
              max={end}
              step={1000}
              value={t}
              onChange={(e) => setAt(Number(e.target.value))}
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{when(start)}</span>
              <button type="button" className="underline" onClick={() => setAt(undefined)}>
                now
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="secondary">{then.length} current then</Badge>
            <Badge variant="outline">{added} added since</Badge>
          </div>
          {(past.isPending || current.isPending) && <Skeleton className="h-32" />}
          {past.isError && <p className="text-sm text-destructive">{past.error.message}</p>}
          {past.isSuccess && then.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <History />
                </EmptyMedia>
                <EmptyTitle>Nothing in {formatScope(scope.scope)} at that time</EmptyTitle>
                <EmptyDescription>Move the slider later, or pick another scope.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {then.map((m) => {
                const change = since(m, byId.get(m.id));
                return (
                  <li key={m.id} className="flex items-start gap-3 rounded-md border p-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className={change ? 'text-muted-foreground' : ''}>{m.text}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {when(m.createdAtMs)} · {m.id}
                      </div>
                    </div>
                    <Badge variant="secondary">{m.kind}</Badge>
                    {change && <Badge variant="outline">{change}</Badge>}
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
