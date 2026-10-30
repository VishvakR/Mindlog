import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ScopePicker } from '@/components/memory/scope-picker';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import type { BranchView, MemoryView, MergePolicy } from '@/lib/memory';
import { MERGE_POLICIES, formatScope, initialScope } from '@/lib/memory';

const when = (ms: number) => new Date(ms).toLocaleString();
const statusVariant = (s: string) =>
  s === 'open' ? 'default' : s === 'merged' ? 'secondary' : 'outline';

function Changes({ title, items, tone }: { title: string; items: MemoryView[]; tone: string }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-sm font-medium">
        {title} <span className="text-muted-foreground">({items.length})</span>
      </h3>
      {items.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
      <ul className="flex flex-col gap-1">
        {items.map((m) => (
          <li key={m.id} className={`rounded-md border-l-2 px-2 py-1 text-sm ${tone}`}>
            {m.text}
            <span className="ml-2 font-mono text-xs text-muted-foreground">{m.id}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Branches (PLAN 17, ADR-0013): what a branch changed, and merging or dropping it. */
export function BranchesPage() {
  const client = useQueryClient();
  const [scope, setScope] = useState(initialScope);
  const [selected, setSelected] = useState<BranchView | undefined>();
  const [policy, setPolicy] = useState<MergePolicy>('raise');
  const [dropping, setDropping] = useState(false);
  const branches = useQuery({
    queryKey: ['branches', scope.tenant, scope.scope],
    queryFn: () => api.memoryBranches(scope.tenant, scope.scope),
    retry: false,
  });
  const open = selected?.status === 'open' ? selected : undefined;
  const diff = useQuery({
    queryKey: ['branch-diff', scope.tenant, scope.scope, open?.name],
    queryFn: () => api.memoryDiff(scope.tenant, scope.scope, open?.name ?? ''),
    enabled: open !== undefined,
  });
  const done = () => {
    setSelected(undefined);
    void client.invalidateQueries({ queryKey: ['branches'] });
    void client.invalidateQueries({ queryKey: ['conflicts'] });
  };
  const merge = useMutation({
    mutationFn: (name: string) => api.memoryMerge(scope.tenant, scope.scope, name, policy),
    onSuccess: (r) => {
      if (!r.merged) {
        toast.error(`Not merged: ${String(r.conflicts.length)} facts contradict main.`);
        return;
      }
      toast.success(
        `Merged ${String(r.added.length)} memories` +
          (r.conflicts.length ? `; ${String(r.conflicts.length)} conflicts to review.` : '.'),
      );
      done();
    },
    onError: (e) => toast.error(e.message),
  });
  const drop = useMutation({
    mutationFn: (name: string) => api.memoryDrop(scope.tenant, scope.scope, name),
    onSuccess: () => {
      toast.success('Branch dropped; main is unchanged.');
      done();
    },
    onError: (e) => toast.error(e.message),
  });
  const list = branches.data ?? [];

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Branches</CardTitle>
          <CardDescription>
            Agents try plans on a branch: it sees main as it was when it was made, plus its own
            changes. Merging checks its new facts against main.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ScopePicker value={scope} onChange={setScope} />
          {branches.isError && <p className="text-sm text-destructive">{branches.error.message}</p>}
          {branches.isPending && <Skeleton className="h-24" />}
          {branches.isSuccess && list.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <GitBranch />
                </EmptyMedia>
                <EmptyTitle>No branches in {formatScope(scope.scope)}</EmptyTitle>
                <EmptyDescription>
                  Agents create them with the MCP <code>branch_create</code> tool or{' '}
                  <code>MEM.BRANCH</code>.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Branch</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Memories</TableHead>
                  <TableHead>Forked</TableHead>
                  <TableHead>By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((b) => (
                  <TableRow
                    key={b.name}
                    className="cursor-pointer"
                    data-state={selected?.name === b.name ? 'selected' : undefined}
                    onClick={() => setSelected(b)}
                  >
                    <TableCell className="font-mono">{b.name}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(b.status)}>{b.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{b.writes}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {when(b.forkAtMs)} · index {b.forkIndex}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{b.createdBy}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {open && (
        <Card>
          <CardHeader>
            <CardTitle className="font-mono">{open.name}</CardTitle>
            <CardDescription>Changes relative to main at the fork.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {diff.isPending && <Skeleton className="h-24" />}
            {diff.data && (
              <div className="grid gap-5 md:grid-cols-3">
                <Changes title="Added" items={diff.data.added} tone="border-emerald-500" />
                <Changes title="Forgotten" items={diff.data.forgotten} tone="border-rose-500" />
                <Changes title="Changed" items={diff.data.changed} tone="border-amber-500" />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={policy}
                onValueChange={(v) => setPolicy((v ?? 'raise') as MergePolicy)}
              >
                <SelectTrigger className="w-48" aria-label="Merge policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {MERGE_POLICIES.map((p) => (
                      <SelectItem key={p.name} value={p.name}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button disabled={merge.isPending} onClick={() => merge.mutate(open.name)}>
                Merge into main
              </Button>
              <Button variant="outline" onClick={() => setDropping(true)}>
                Drop
              </Button>
              <span className="text-xs text-muted-foreground">
                {MERGE_POLICIES.find((p) => p.name === policy)?.hint}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={dropping} onOpenChange={setDropping}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Drop branch {open?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its memories are deleted. Main memory is not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (open) drop.mutate(open.name);
                setDropping(false);
              }}
            >
              Drop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
