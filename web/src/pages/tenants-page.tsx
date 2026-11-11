import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Building2,
  Download,
  KeyRound,
  Plus,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { Quotas, TenantInfo } from '@/lib/api';
import { api, session } from '@/lib/api';

const ROLES = ['tenant_admin', 'developer', 'agent', 'readonly'] as const;
type Role = (typeof ROLES)[number];

const failed = (e: Error) => {
  toast.error(e.message);
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'TB'}`;
}

function UsageBar(props: {
  label: string;
  used: number;
  limit: number | undefined;
  format?: (n: number) => string;
}) {
  const { label, used, limit, format = String } = props;
  const share = limit ? Math.min(100, Math.round((100 * used) / limit)) : 0;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-sm tabular-nums">
          {format(used)}
          {limit !== undefined && (
            <span className="text-muted-foreground"> of {format(limit)}</span>
          )}
        </span>
      </div>
      {limit !== undefined && (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={label}
          aria-valuenow={share}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={share >= 90 ? 'h-full bg-destructive' : 'h-full bg-primary'}
            style={{ width: `${String(share)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function QuotaEditor({ tenant }: { tenant: TenantInfo }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(tenant.quotas).map(([k, v]) => [k, String(v)])),
  );
  const save = useMutation({
    mutationFn: () => {
      const quotas: Quotas = Object.fromEntries(
        Object.entries(draft)
          .filter(([, v]) => v !== '')
          .map(([k, v]) => [k, Number(v)]),
      );
      return api.tenantSetQuotas(tenant.name, quotas);
    },
    onSuccess: () => {
      toast.success('Quotas saved');
      void client.invalidateQueries({ queryKey: ['tenants'] });
    },
    onError: failed,
  });
  const FIELDS: readonly (readonly [keyof Quotas, string])[] = [
    ['writeQps', 'Writes per second'],
    ['recallQps', 'Recalls per second'],
    ['storageBytes', 'Storage (bytes)'],
    ['keys', 'Keys'],
    ['memories', 'Memories'],
    ['modelSecondsPerHour', 'Model seconds per hour'],
    ['connections', 'Connections'],
  ];
  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {FIELDS.map(([field, label]) => (
        <div key={field} className="flex flex-col gap-1.5">
          <Label htmlFor={`quota-${field}`}>{label}</Label>
          <Input
            id={`quota-${field}`}
            inputMode="numeric"
            placeholder="No limit"
            value={draft[field] ?? ''}
            onChange={(e) => {
              setDraft({ ...draft, [field]: e.target.value.trim() });
            }}
          />
        </div>
      ))}
      <Button type="submit" className="self-end" disabled={save.isPending}>
        Save quotas
      </Button>
    </form>
  );
}

function ApiKeys({ tenant }: { tenant: string }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const [secret, setSecret] = useState<string>();
  const keys = useQuery({
    queryKey: ['tenant-keys', tenant],
    queryFn: () => api.tenantKeys(tenant),
  });
  const refresh = () => void client.invalidateQueries({ queryKey: ['tenant-keys', tenant] });
  const create = useMutation({
    mutationFn: () => api.tenantCreateKey(tenant, { name, role }),
    onSuccess: (k) => {
      setSecret(k.key);
      setName('');
      refresh();
    },
    onError: failed,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.tenantRevokeKey(tenant, id),
    onSuccess: refresh,
    onError: failed,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> API keys
        </CardTitle>
        <CardDescription>
          For agents, programs and Redis clients (AUTH with the key).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="key-name">Name</Label>
            <Input
              id="key-name"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="key-role">Role</Label>
            <Select
              value={role}
              onValueChange={(v) => {
                setRole(v as Role);
              }}
            >
              <SelectTrigger id="key-role" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={create.isPending}>
            <Plus /> Create key
          </Button>
        </form>
        {secret && (
          <p className="rounded-md border bg-muted p-3 text-sm">
            Copy this key now, it is not shown again:{' '}
            <code className="break-all font-mono text-xs">{secret}</code>
          </p>
        )}
        {keys.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : keys.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {keys.error.message}
          </p>
        ) : keys.data.keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No API keys yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Limited to</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.data.keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>{k.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{k.role}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {k.user ?? k.scopes?.join(', ') ?? 'all users'}
                    </TableCell>
                    <TableCell>{new Date(k.created).toLocaleDateString()}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Revoke ${k.name}`}
                        onClick={() => {
                          revoke.mutate(k.id);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Members({ tenant }: { tenant: string }) {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('developer');
  const members = useQuery({
    queryKey: ['tenant-members', tenant],
    queryFn: () => api.tenantMembers(tenant),
  });
  const refresh = () => void client.invalidateQueries({ queryKey: ['tenant-members', tenant] });
  const save = useMutation({
    mutationFn: () => api.tenantSaveMember(tenant, { email, password, role }),
    onSuccess: () => {
      setEmail('');
      setPassword('');
      refresh();
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (who: string) => api.tenantRemoveMember(tenant, who),
    onSuccess: refresh,
    onError: failed,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4" /> Members
        </CardTitle>
        <CardDescription>People who sign in to this dashboard for this tenant.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="member-email">Email</Label>
            <Input
              id="member-email"
              type="email"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="member-password">Password</Label>
            <Input
              id="member-password"
              type="password"
              required
              minLength={10}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="member-role">Role</Label>
            <Select
              value={role}
              onValueChange={(v) => {
                setRole(v as Role);
              }}
            >
              <SelectTrigger id="member-role" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.filter((r) => r !== 'agent').map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={save.isPending}>
            <Plus /> Save member
          </Button>
        </form>
        {members.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : members.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {members.error.message}
          </p>
        ) : members.data.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {members.data.members.map((m) => (
              <li key={m.email} className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-2 text-sm">
                  {m.email}
                  <Badge variant="outline">{m.role}</Badge>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${m.email}`}
                  onClick={() => {
                    remove.mutate(m.email);
                  }}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Redaction, export and deletion: what the tenant's data may contain, and its way out. */
function TenantData({ tenant, operator }: { tenant: TenantInfo; operator: boolean }) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const refresh = () => void client.invalidateQueries({ queryKey: ['tenants'] });
  const exported = useQuery({
    queryKey: ['tenant-export', tenant.name],
    queryFn: () => api.tenantExport(tenant.name),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2_000 : false),
  });
  const redaction = useMutation({
    mutationFn: (enabled: boolean) => api.tenantSettings(tenant.name, { redaction: { enabled } }),
    onSuccess: () => {
      toast.success('Redaction policy saved');
      refresh();
    },
    onError: failed,
  });
  const start = useMutation({
    mutationFn: () => api.tenantStartExport(tenant.name),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['tenant-export', tenant.name] }),
    onError: failed,
  });
  const download = useMutation({
    mutationFn: () => api.tenantArchive(tenant.name),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${tenant.name}-export.ndjson.gz`;
      link.click();
      URL.revokeObjectURL(url);
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: () => api.tenantDelete(tenant.name),
    onSuccess: () => {
      toast.success(`${tenant.name} will be purged after the grace period`);
      refresh();
    },
    onError: failed,
  });
  const state = exported.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" /> Data
        </CardTitle>
        <CardDescription>
          Mask personal data in new memories, take everything out, or delete the tenant.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">PII redaction</span>
            <span className="text-xs text-muted-foreground">
              Emails, phone numbers, ID numbers and cards become placeholders before storage.
            </span>
          </div>
          <ToggleGroup
            aria-label="PII redaction"
            value={[tenant.redaction.enabled ? 'on' : 'off']}
            onValueChange={(v) => {
              const next = v[0];
              if (next) redaction.mutate(next === 'on');
            }}
          >
            <ToggleGroupItem value="off">Off</ToggleGroupItem>
            <ToggleGroupItem value="on">On</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Export</span>
            <span className="text-xs text-muted-foreground">
              {state
                ? state.status === 'done'
                  ? `Ready: ${formatBytes(state.bytes ?? 0)}, ${new Date(state.finishedAt ?? 0).toLocaleString()}`
                  : state.status === 'running'
                    ? 'Running…'
                    : `Failed: ${state.error ?? 'unknown error'}`
                : 'KV keys, collections, memories and files, as one gzipped NDJSON archive.'}
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={start.isPending || state?.status === 'running'}
              onClick={() => {
                start.mutate();
              }}
            >
              <Archive /> Export
            </Button>
            {state?.status === 'done' && (
              <Button
                disabled={download.isPending}
                onClick={() => {
                  download.mutate();
                }}
              >
                <Download /> Download
              </Button>
            )}
          </div>
        </div>
        {operator && tenant.status === 'active' && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 p-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Delete this tenant</span>
              <span className="text-xs text-muted-foreground">
                Its requests are refused at once; its data is purged after the grace period, and its
                keys are destroyed. This cannot be undone afterwards.
              </span>
            </div>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(true);
              }}
            >
              <Trash2 /> Delete
            </Button>
          </div>
        )}
      </CardContent>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {tenant.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every key, memory, record and file of this tenant will be purged, and the name cannot
              be used again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                remove.mutate();
              }}
            >
              Delete tenant
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function TenantDetail({ tenant, operator }: { tenant: TenantInfo; operator: boolean }) {
  const usage = useQuery({
    queryKey: ['tenant-usage', tenant.name],
    queryFn: () => api.tenantUsage(tenant.name),
    refetchInterval: 30_000,
  });
  const q = tenant.quotas;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {tenant.name}
            {tenant.status !== 'active' && (
              <Badge variant="destructive">
                {tenant.status === 'deleting' ? 'being deleted' : 'deleted'}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>Usage is approximate and refreshes every 30 seconds.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {usage.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {usage.error.message}
            </p>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              <UsageBar
                label="Storage"
                used={usage.data?.bytes ?? 0}
                limit={q.storageBytes}
                format={formatBytes}
              />
              <UsageBar label="Keys" used={usage.data?.keys ?? 0} limit={q.keys} />
              <UsageBar label="Memories" used={usage.data?.memories ?? 0} limit={q.memories} />
            </div>
          )}
          {operator && <QuotaEditor key={tenant.name} tenant={tenant} />}
        </CardContent>
      </Card>
      <TenantData tenant={tenant} operator={operator} />
      <ApiKeys tenant={tenant.name} />
      <Members tenant={tenant.name} />
    </div>
  );
}

/** Tenants, their usage against quotas, and their keys and members (PLAN 17, 18). */
export function TenantsPage() {
  const client = useQueryClient();
  const operator = session.tenant() === null;
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string>();
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: api.tenants });
  const create = useMutation({
    mutationFn: () => api.tenantCreate(name),
    onSuccess: (t) => {
      setName('');
      setSelected(t.name);
      void client.invalidateQueries({ queryKey: ['tenants'] });
    },
    onError: failed,
  });
  if (tenants.isPending) return <Skeleton className="h-64 w-full" />;
  if (tenants.isError)
    return (
      <p className="text-sm text-destructive" role="alert">
        {tenants.error.message}
      </p>
    );
  const list = tenants.data.tenants;
  const current = list.find((t) => t.name === selected) ?? list[0];
  return (
    <div className="flex flex-col gap-4">
      {operator && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 pt-6">
            <form
              className="flex flex-1 flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                <Label htmlFor="tenant-name">New tenant</Label>
                <Input
                  id="tenant-name"
                  required
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value.trim());
                  }}
                />
              </div>
              <Button type="submit" disabled={create.isPending}>
                <Plus /> Create tenant
              </Button>
            </form>
            {list.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tenant-select">Tenant</Label>
                <Select
                  value={current?.name ?? ''}
                  onValueChange={(v) => {
                    setSelected(v ?? undefined);
                  }}
                >
                  <SelectTrigger id="tenant-select" className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {list.map((t) => (
                      <SelectItem key={t.name} value={t.name}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {current ? (
        <TenantDetail key={current.name} tenant={current} operator={operator} />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Building2 />
            </EmptyMedia>
            <EmptyTitle>No tenants registered</EmptyTitle>
            <EmptyDescription>Register one to set quotas and hand out access.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
