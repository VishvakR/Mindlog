import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, Pin, Snowflake } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ScopePicker } from '@/components/memory/scope-picker';
import { VersionHistory } from '@/components/memory/version-history';
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Toggle } from '@/components/ui/toggle';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import type { MemoryView } from '@/lib/memory';
import { MEMORY_KINDS, formatScope, initialScope } from '@/lib/memory';

const ALL = 'all';
const when = (ms: number) => new Date(ms).toLocaleString();
const trustVariant = (t: string) =>
  t === 'quarantined' ? 'destructive' : t === 'verified' ? 'default' : 'outline';

/** Memory explorer (PLAN 17): browse a scope, inspect a memory and its history, forget it. */
export function MemoryPage() {
  const client = useQueryClient();
  const [scope, setScope] = useState(initialScope);
  const [kind, setKind] = useState<string>(ALL);
  const [open, setOpen] = useState<MemoryView | undefined>();
  const [forgetting, setForgetting] = useState<MemoryView | undefined>();
  const [quarantinedOnly, setQuarantinedOnly] = useState(false);
  const list = useInfiniteQuery({
    queryKey: ['memories', scope.tenant, scope.scope, kind],
    queryFn: ({ pageParam }) =>
      api.memoryList(scope.tenant, scope.scope, pageParam, kind === ALL ? undefined : kind),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next,
    retry: false,
  });
  const history = useQuery({
    queryKey: ['memory-history', scope.tenant, open?.id],
    queryFn: () => api.memoryHistory(scope.tenant, { user: open?.user ?? '' }, open?.id ?? ''),
    enabled: open !== undefined,
  });
  const forget = useMutation({
    mutationFn: (m: MemoryView) => api.memoryForget(scope.tenant, { user: m.user }, m.id),
    onSuccess: (r) => {
      toast.success(r.count === 1 ? 'Forgotten; its history is kept.' : 'Already forgotten.');
      setOpen(undefined);
      void client.invalidateQueries({ queryKey: ['memories'] });
    },
    onError: (e) => toast.error(e.message),
  });
  const trust = useMutation({
    mutationFn: ({ m, level }: { m: MemoryView; level: string }) =>
      api.memoryTrust(scope.tenant, { user: m.user }, m.id, level),
    onSuccess: (_r, { level }) => {
      toast.success(
        level === 'normal' ? 'Released: agents can recall it now.' : `Marked ${level}.`,
      );
      setOpen(undefined);
      void client.invalidateQueries({ queryKey: ['memories'] });
    },
    onError: (e) => toast.error(e.message),
  });
  const pin = useMutation({
    mutationFn: (m: MemoryView) => api.memoryPin(scope.tenant, { user: m.user }, m.id, !m.pinned),
    onSuccess: (_r, m) => {
      toast.success(
        m.pinned ? 'Unpinned: it can fade to the cold tier again.' : 'Pinned: it stays hot.',
      );
      setOpen(undefined);
      void client.invalidateQueries({ queryKey: ['memories'] });
    },
    onError: (e) => toast.error(e.message),
  });
  const memories = (list.data?.pages.flatMap((p) => p.memories) ?? []).filter(
    (m) => !quarantinedOnly || (m.trust === 'quarantined' && !m.expiredAtMs),
  );

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Memory</CardTitle>
          <CardDescription>
            What agents remembered in a scope, oldest first. Forgotten memories stay for history.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <ScopePicker value={scope} onChange={setScope} />
            </div>
            <Select value={kind} onValueChange={(v) => setKind(v ?? ALL)}>
              <SelectTrigger className="w-40" aria-label="Filter by kind">
                <SelectValue>{(v: string) => (v === ALL ? 'All kinds' : v)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={ALL}>All kinds</SelectItem>
                  {MEMORY_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Toggle
              variant="outline"
              pressed={quarantinedOnly}
              onPressedChange={setQuarantinedOnly}
              aria-label="Show only quarantined memories"
            >
              Quarantined
            </Toggle>
          </div>
          {list.isError && <p className="text-sm text-destructive">{list.error.message}</p>}
          {list.isSuccess && memories.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Brain />
                </EmptyMedia>
                <EmptyTitle>No memories in {formatScope(scope.scope)}</EmptyTitle>
                <EmptyDescription>
                  Agents add them with the MCP <code>remember</code> tool or <code>MEM.ADD</code>.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Memory</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Trust</TableHead>
                  <TableHead className="text-right">Importance</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {memories.map((m) => (
                  <TableRow
                    key={m.id}
                    className="cursor-pointer"
                    data-state={m.expiredAtMs ? 'disabled' : undefined}
                    onClick={() => setOpen(m)}
                  >
                    <TableCell className="max-w-xl">
                      <div
                        className={
                          m.expiredAtMs ? 'truncate text-muted-foreground line-through' : 'truncate'
                        }
                      >
                        {m.text}
                      </div>
                      <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                        {m.tier === 'cold' && (
                          <Snowflake className="size-3 text-sky-500" aria-label="cold tier" />
                        )}
                        {m.pinned && <Pin className="size-3" aria-label="pinned" />}
                        <span className="truncate">
                          {formatScope(m)} · {m.id}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{m.kind}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={trustVariant(m.trust)}>{m.trust}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m.importance.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {when(m.createdAtMs)}
                    </TableCell>
                  </TableRow>
                ))}
                {list.isPending && (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-5" />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
          {list.hasNextPage && (
            <Button
              variant="outline"
              className="self-center"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              Load more
            </Button>
          )}
        </CardContent>
      </Card>

      <Sheet open={open !== undefined} onOpenChange={(o) => !o && setOpen(undefined)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle className="text-base leading-snug">{open.text}</SheetTitle>
                <SheetDescription className="font-mono text-xs">
                  {formatScope(open)} · {open.id}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-5 px-4 pb-6 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">{open.kind}</Badge>
                  <Badge variant={trustVariant(open.trust)}>{open.trust}</Badge>
                  <Badge variant="outline">source: {open.source.type}</Badge>
                  {open.expiredAtMs && <Badge variant="destructive">forgotten</Badge>}
                  {open.tier === 'cold' && (
                    <Badge variant="secondary">
                      <Snowflake /> cold tier
                    </Badge>
                  )}
                  {open.pinned && (
                    <Badge variant="outline">
                      <Pin /> pinned
                    </Badge>
                  )}
                </div>
                <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5">
                  <dt className="text-muted-foreground">Created</dt>
                  <dd>{when(open.createdAtMs)}</dd>
                  <dt className="text-muted-foreground">By</dt>
                  <dd className="font-mono text-xs">{open.source.principal}</dd>
                  <dt className="text-muted-foreground">Importance</dt>
                  <dd className="tabular-nums">{open.importance.toFixed(2)}</dd>
                  <dt className="text-muted-foreground">Strength</dt>
                  <dd className="tabular-nums">
                    {open.strength.toFixed(1)} days · recalled {open.recallCount}×
                    {open.lastRecalledAtMs ? `, last ${when(open.lastRecalledAtMs)}` : ''}
                  </dd>
                  <dt className="text-muted-foreground">Version</dt>
                  <dd className="tabular-nums">{open.version}</dd>
                  {open.expiredAtMs && (
                    <>
                      <dt className="text-muted-foreground">Forgotten</dt>
                      <dd>
                        {when(open.expiredAtMs)} {open.forgetReason ? `(${open.forgetReason})` : ''}
                      </dd>
                    </>
                  )}
                </dl>
                <section>
                  <h3 className="mb-1.5 font-medium">Entities</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {open.entities.length === 0 && (
                      <span className="text-muted-foreground">None</span>
                    )}
                    {open.entities.map((e) => (
                      <Badge key={e} variant="outline" className="font-mono">
                        {e}
                      </Badge>
                    ))}
                  </div>
                </section>
                <section>
                  <h3 className="mb-1.5 font-medium">Links</h3>
                  {open.links.length === 0 && <p className="text-muted-foreground">None</p>}
                  <ul className="flex flex-col gap-1">
                    {open.links.map((l) => (
                      <li key={`${l.relation}:${l.to}`} className="font-mono text-xs">
                        {l.relation} → {l.to} ({l.weight.toFixed(2)})
                      </li>
                    ))}
                  </ul>
                </section>
                {open.tier === 'cold' && (
                  <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
                    Faded to the cold tier: this is its stub. Recall with “Include cold” brings it
                    back, and recalling it makes it hot again.
                  </p>
                )}
                <section>
                  <h3 className="mb-1.5 font-medium">Version history</h3>
                  <VersionHistory entries={history.data} pending={history.isPending} />
                </section>
                {!open.expiredAtMs && (
                  <div className="flex flex-wrap gap-2">
                    {open.trust === 'quarantined' && (
                      <Button onClick={() => trust.mutate({ m: open, level: 'normal' })}>
                        Release
                      </Button>
                    )}
                    {open.trust !== 'verified' && (
                      <Button
                        variant="outline"
                        onClick={() => trust.mutate({ m: open, level: 'verified' })}
                      >
                        Mark verified
                      </Button>
                    )}
                    <Button variant="outline" onClick={() => pin.mutate(open)}>
                      <Pin /> {open.pinned ? 'Unpin' : 'Pin'}
                    </Button>
                    <Button variant="destructive" onClick={() => setForgetting(open)}>
                      {open.trust === 'quarantined' ? 'Reject (forget)' : 'Forget'}
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={forgetting !== undefined}
        onOpenChange={(o) => !o && setForgetting(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget this memory?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents will no longer recall it. Mindlog keeps the record and its history for audit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (forgetting) forget.mutate(forgetting);
                setForgetting(undefined);
              }}
            >
              Forget
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
