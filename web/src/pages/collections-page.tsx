import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RecordsPanel } from '@/components/collections/records-panel';
import { RuleEditor } from '@/components/collections/rule-editor';
import { SchemaEditor } from '@/components/collections/schema-editor';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api';
import type { CollectionInfo, RuleSlot, Schema } from '@/lib/collections';
import { RULE_SLOTS, collectionsApi } from '@/lib/collections';

function problem(e: Error): string {
  const fields = e instanceof ApiError ? e.problem.fields : undefined;
  return fields
    ? Object.entries(fields)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ')
    : e.message;
}

function NewCollection({ tenant, onDone }: { tenant: string; onDone: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<Schema['type']>('base');
  const create = useMutation({
    mutationFn: () =>
      collectionsApi.create(tenant, {
        name,
        type,
        ...(type === 'view' ? { view: { from: '', select: {} } } : {}),
      }),
    onSuccess: () => {
      setOpen(false);
      setName('');
      onDone(name);
    },
    onError: (e) => toast.error(problem(e)),
  });
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Plus /> New
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New collection</DialogTitle>
            <DialogDescription>
              Rules start locked: only superusers can reach its records.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Collection name"
            placeholder="todos"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <Select
            value={type}
            onValueChange={(v) => {
              setType(v as Schema['type']);
            }}
          >
            <SelectTrigger aria-label="Collection type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="base">Base</SelectItem>
                <SelectItem value="auth">Auth (users)</SelectItem>
                <SelectItem value="view">View</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button
              onClick={() => {
                create.mutate();
              }}
              disabled={create.isPending || name === ''}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CollectionDetail({
  tenant,
  info,
  names,
  onDeleted,
}: {
  tenant: string;
  info: CollectionInfo;
  names: string[];
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(info.schema);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    setDraft(info.schema);
  }, [info]);
  const refresh = () => client.invalidateQueries({ queryKey: ['collections', tenant] });
  const save = useMutation({
    mutationFn: () => collectionsApi.save(tenant, draft, info.version),
    onSuccess: () => {
      toast.success('Collection saved.');
      void refresh();
    },
    onError: (e) => toast.error(problem(e)),
  });
  const remove = useMutation({
    mutationFn: () => collectionsApi.remove(tenant, info.schema.name),
    onSuccess: () => {
      toast.success('Collection deleted.');
      onDeleted();
      void refresh();
    },
    onError: (e) => toast.error(problem(e)),
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(info.schema);
  const slots: RuleSlot[] = draft.type === 'auth' ? [...RULE_SLOTS, 'manageRule'] : [...RULE_SLOTS];
  return (
    <Card className="min-w-0 flex-1">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            {draft.name} <Badge variant="outline">{draft.type}</Badge>
          </CardTitle>
          <CardDescription>Version {info.version}</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              save.mutate();
            }}
            disabled={!dirty || save.isPending}
          >
            Save changes
          </Button>
          <Button
            variant="outline"
            aria-label={`Delete ${draft.name}`}
            onClick={() => {
              setDeleting(true);
            }}
          >
            <Trash2 />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="records">
          <TabsList>
            <TabsTrigger value="records">Records</TabsTrigger>
            <TabsTrigger value="schema">Schema</TabsTrigger>
            <TabsTrigger value="rules">Rules</TabsTrigger>
          </TabsList>
          <TabsContent value="records" className="pt-3">
            <RecordsPanel tenant={tenant} schema={info.schema} />
          </TabsContent>
          <TabsContent value="schema" className="pt-3">
            <SchemaEditor draft={draft} collections={names} onChange={setDraft} />
          </TabsContent>
          <TabsContent value="rules" className="flex flex-col gap-4 pt-3">
            {slots.map((slot) => (
              <RuleEditor
                key={slot}
                label={slot}
                tenant={tenant}
                draft={draft}
                value={draft[slot]}
                onChange={(value) => {
                  setDraft({ ...draft, [slot]: value });
                }}
              />
            ))}
          </TabsContent>
        </Tabs>
      </CardContent>
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {draft.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the collection and all its records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                remove.mutate();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/** Collections (PLAN 17): schemas, rules with live checks, and records. */
export function CollectionsPage() {
  const client = useQueryClient();
  const [tenant, setTenant] = useState('default');
  const [selected, setSelected] = useState<string>();
  const [system, setSystem] = useState(false);
  const collections = useQuery({
    queryKey: ['collections', tenant],
    queryFn: () => collectionsApi.list(tenant),
    retry: false,
  });
  const all = collections.data?.items ?? [];
  const shown = all.filter((c) => system || !c.schema.name.startsWith('_'));
  const info = all.find((c) => c.schema.name === selected) ?? shown[0];
  return (
    <div className="flex flex-col gap-4 p-4 md:p-6 lg:flex-row lg:items-start">
      <Card className="w-full shrink-0 lg:w-64">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Collections</CardTitle>
          <NewCollection
            tenant={tenant}
            onDone={(name) => {
              setSelected(name);
              void client.invalidateQueries({ queryKey: ['collections', tenant] });
            }}
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            aria-label="Tenant"
            value={tenant}
            onChange={(e) => {
              setTenant(e.target.value);
              setSelected(undefined);
            }}
          />
          {collections.isPending && <Skeleton className="h-24" />}
          {collections.isError && (
            <p className="text-sm text-destructive">{collections.error.message}</p>
          )}
          <nav aria-label="Collections" className="flex flex-col gap-0.5">
            {shown.map((c) => (
              <button
                key={c.schema.name}
                type="button"
                aria-current={c === info ? 'true' : undefined}
                className={`flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${c === info ? 'bg-accent font-medium' : ''}`}
                onClick={() => {
                  setSelected(c.schema.name);
                }}
              >
                {c.schema.name}
                {c.schema.type !== 'base' && <Badge variant="outline">{c.schema.type}</Badge>}
              </button>
            ))}
          </nav>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={system}
              onChange={(e) => {
                setSystem(e.target.checked);
              }}
            />
            Show system collections
          </label>
        </CardContent>
      </Card>
      {info ? (
        <CollectionDetail
          key={`${tenant}/${info.schema.name}`}
          tenant={tenant}
          info={info}
          names={all.map((c) => c.schema.name)}
          onDeleted={() => {
            setSelected(undefined);
          }}
        />
      ) : (
        collections.isSuccess && (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Boxes />
              </EmptyMedia>
              <EmptyTitle>No collections in {tenant}</EmptyTitle>
              <EmptyDescription>Create one to start storing app records.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      )}
    </div>
  );
}
