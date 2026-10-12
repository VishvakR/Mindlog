import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatBytes, formatTtl } from '@/lib/key-types';

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '—');

export function OverviewPage() {
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    refetchInterval: 5000,
  });
  const o = overview.data;
  const stats = [
    {
      label: 'Keys',
      value: o ? num(o.keys).toLocaleString() : undefined,
      hint: 'In the default tenant',
    },
    {
      label: 'Connected clients',
      value: o ? num(o.clients).toLocaleString() : undefined,
      hint: 'RESP and console',
    },
    {
      label: 'Applied index',
      value: o ? text(o.appliedIndex) : undefined,
      hint: 'Last command applied from the log',
    },
    {
      label: 'Memory',
      value: o ? formatBytes(num(o.rssBytes)) : undefined,
      hint: `Heap ${o ? formatBytes(num(o.heapUsedBytes)) : '…'}`,
    },
  ];
  const node: [string, string][] = o
    ? [
        ['Node', text(o.nodeId)],
        ['Version', text(o.version)],
        ['Profile', text(o.profile)],
        ['Up for', formatTtl(num(o.uptimeMs))],
        ['Started', new Date(text(o.startedAt)).toLocaleString()],
        ['RESP', text(o.resp)],
        ['HTTP', text(o.http)],
      ]
    : [];

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <section aria-label="Activity" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} size="sm">
            <CardHeader>
              <CardDescription>{s.label}</CardDescription>
              <CardTitle className="font-mono text-2xl tabular-nums">
                {s.value ?? <Skeleton className="h-8 w-24" />}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">{s.hint}</CardContent>
          </Card>
        ))}
      </section>
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>This node</CardTitle>
          <CardDescription>Refreshes every 5 seconds.</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.isError ? (
            <p className="text-sm text-destructive">
              Could not load the overview: {overview.error.message}
            </p>
          ) : (
            <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
              {node.length === 0
                ? Array.from({ length: 5 }, (_, i) => (
                    <Skeleton key={i} className="col-span-2 h-5" />
                  ))
                : node.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="truncate font-mono">{v}</dd>
                    </div>
                  ))}
            </dl>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
