import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, session } from '@/lib/api';
import type { FieldDraft, RecordRow, Schema } from '@/lib/collections';
import { cellText, collectionsApi, fieldValue } from '@/lib/collections';

const PER_PAGE = 20;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const AUTH_FIELDS: FieldDraft[] = [
  { name: 'email', type: 'email' },
  { name: 'verified', type: 'bool' },
];
const READ_ONLY = new Set(['autodate', 'vector', 'file']);

function problem(e: Error): string {
  const fields = e instanceof ApiError ? e.problem.fields : undefined;
  return fields
    ? Object.entries(fields)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ')
    : e.message;
}

/** `<img>` cannot send the bearer token, so the image is fetched and shown from a blob URL. */
function Preview({
  tenant,
  collection,
  id,
  file,
}: {
  tenant: string;
  collection: string;
  id: string;
  file: string;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let current: string | undefined;
    let stale = false;
    const token = session.token();
    void fetch(`/api/files/${collection}/${id}/${encodeURIComponent(file)}`, {
      headers: {
        'x-mindlog-tenant': tenant,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
      .then((r) => (r.ok ? r.blob() : undefined))
      .then((b) => {
        if (!b || stale) return;
        current = URL.createObjectURL(b);
        setUrl(current);
      });
    return () => {
      stale = true;
      if (current) URL.revokeObjectURL(current);
    };
  }, [tenant, collection, id, file]);
  return url ? (
    <img src={url} alt={file} className="size-8 rounded object-cover" />
  ) : (
    <Skeleton className="size-8" />
  );
}

function Cell({
  field,
  row,
  tenant,
  collection,
}: {
  field: FieldDraft;
  row: RecordRow;
  tenant: string;
  collection: string;
}) {
  const value = row[field.name];
  if (field.type === 'file') {
    const files = [value].flat().filter((f): f is string => typeof f === 'string' && f !== '');
    return (
      <span className="flex flex-wrap gap-1">
        {files.map((f) =>
          IMAGE.test(f) ? (
            <Preview key={f} tenant={tenant} collection={collection} id={row.id} file={f} />
          ) : (
            <Badge key={f} variant="outline">
              {f}
            </Badge>
          ),
        )}
      </span>
    );
  }
  if (field.type === 'bool')
    return <Badge variant={value === true ? 'default' : 'outline'}>{String(value)}</Badge>;
  return <span className="block max-w-56 truncate">{cellText(value)}</span>;
}

function RecordDialog({
  tenant,
  schema,
  row,
  onClose,
}: {
  tenant: string;
  schema: Schema;
  row: RecordRow | undefined;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const auth = schema.type === 'auth';
  const fields = [...(auth ? AUTH_FIELDS : []), ...schema.fields].filter(
    (f) => !READ_ONLY.has(f.type),
  );
  const asText = (v: unknown) =>
    v === undefined || v === null
      ? ''
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v as string | number);
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.name,
        f.type === 'bool' ? row?.[f.name] === true : asText(row?.[f.name]),
      ]),
    ),
  );
  const [password, setPassword] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      for (const f of fields) {
        const v = values[f.name];
        body[f.name] = typeof v === 'boolean' ? v : fieldValue(f.type, v ?? '');
      }
      if (auth && !row) Object.assign(body, { password, passwordConfirm: password });
      return row
        ? collectionsApi.updateRecord(tenant, schema.name, row.id, body)
        : collectionsApi.createRecord(tenant, schema.name, body);
    },
    onSuccess: () => {
      toast.success(row ? 'Record saved.' : 'Record created.');
      void client.invalidateQueries({ queryKey: ['records', tenant, schema.name] });
      onClose();
    },
    onError: (e) => toast.error(problem(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{row ? `Edit ${row.id}` : `New ${schema.name} record`}</DialogTitle>
          <DialogDescription>Files are uploaded through the API or an app.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {fields.map((f) => {
            const id = `record-${f.name}`;
            const v = values[f.name];
            const set = (next: string | boolean) => {
              setValues({ ...values, [f.name]: next });
            };
            return (
              <div key={f.name} className="flex flex-col gap-1">
                <label htmlFor={id} className="text-sm font-medium">
                  {f.name}{' '}
                  <span className="text-xs font-normal text-muted-foreground">{f.type}</span>
                </label>
                {typeof v === 'boolean' ? (
                  <input
                    id={id}
                    type="checkbox"
                    className="size-4"
                    checked={v}
                    onChange={(e) => {
                      set(e.target.checked);
                    }}
                  />
                ) : f.type === 'json' || f.type === 'editor' ? (
                  <Textarea
                    id={id}
                    value={v}
                    onChange={(e) => {
                      set(e.target.value);
                    }}
                    className="font-mono"
                  />
                ) : (
                  <Input
                    id={id}
                    value={v ?? ''}
                    type={f.type === 'number' ? 'number' : 'text'}
                    onChange={(e) => {
                      set(e.target.value);
                    }}
                  />
                )}
              </div>
            );
          })}
          {auth && !row && (
            <div className="flex flex-col gap-1">
              <label htmlFor="record-password" className="text-sm font-medium">
                Password
              </label>
              <Input
                id="record-password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              save.mutate();
            }}
            disabled={save.isPending}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({
  tenant,
  collection,
  row,
  onClose,
}: {
  tenant: string;
  collection: string;
  row: RecordRow;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const reset = useMutation({
    mutationFn: () =>
      collectionsApi.updateRecord(tenant, collection, row.id, {
        password,
        passwordConfirm: password,
      }),
    onSuccess: () => {
      toast.success('Password changed; the user must sign in again.');
      onClose();
    },
    onError: (e) => toast.error(problem(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            {cellText(row['email'])}: every session of this user ends.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="New password"
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
        <DialogFooter>
          <Button
            onClick={() => {
              reset.mutate();
            }}
            disabled={reset.isPending || password.length < 8}
          >
            Reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Records of a collection: filter, pages, edit, delete and, for users, a password reset. */
export function RecordsPanel({ tenant, schema }: { tenant: string; schema: Schema }) {
  const client = useQueryClient();
  const [typed, setTyped] = useState('');
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<RecordRow | 'new' | undefined>();
  const [resetting, setResetting] = useState<RecordRow | undefined>();
  const name = schema.name;
  const rows = useQuery({
    queryKey: ['records', tenant, name, page, filter],
    queryFn: () =>
      collectionsApi.records(tenant, name, { page, perPage: PER_PAGE, filter, sort: '-created' }),
    retry: false,
  });
  const remove = useMutation({
    mutationFn: (id: string) => collectionsApi.deleteRecord(tenant, name, id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['records', tenant, name] });
    },
    onError: (e) => toast.error(problem(e)),
  });
  const columns = [...(schema.type === 'auth' ? AUTH_FIELDS : []), ...schema.fields].filter(
    (f) => f.type !== 'vector',
  );
  const readOnly = schema.type === 'view';
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter(typed);
          setPage(1);
        }}
      >
        <Input
          aria-label="Filter"
          className="font-mono"
          placeholder="title ~ 'milk' && done = false"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
          }}
        />
        <Button type="submit" variant="outline">
          Filter
        </Button>
        {!readOnly && (
          <Button
            type="button"
            onClick={() => {
              setEditing('new');
            }}
          >
            <Plus /> New record
          </Button>
        )}
      </form>
      {rows.isError && <p className="text-sm text-destructive">{rows.error.message}</p>}
      {rows.isPending && <Skeleton className="h-32" />}
      {rows.data?.items.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>No records{filter ? ' match this filter' : ''}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {rows.data && rows.data.items.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>id</TableHead>
                {columns.map((f) => (
                  <TableHead key={f.name}>{f.name}</TableHead>
                ))}
                <TableHead>updated</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.data.items.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.id}</TableCell>
                  {columns.map((f) => (
                    <TableCell key={f.name}>
                      <Cell field={f} row={row} tenant={tenant} collection={name} />
                    </TableCell>
                  ))}
                  <TableCell className="text-xs text-muted-foreground">
                    {cellText(row['updated'])}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {schema.type === 'auth' && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Reset password of ${row.id}`}
                        onClick={() => {
                          setResetting(row);
                        }}
                      >
                        <KeyRound />
                      </Button>
                    )}
                    {!readOnly && (
                      <>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Edit ${row.id}`}
                          onClick={() => {
                            setEditing(row);
                          }}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Delete ${row.id}`}
                          onClick={() => {
                            remove.mutate(row.id);
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {rows.data.totalItems} {rows.data.totalItems === 1 ? 'record' : 'records'}
            </span>
            <span className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => {
                  setPage(page - 1);
                }}
              >
                Previous
              </Button>
              Page {page} of {Math.max(rows.data.totalPages, 1)}
              <Button
                size="sm"
                variant="outline"
                disabled={page >= rows.data.totalPages}
                onClick={() => {
                  setPage(page + 1);
                }}
              >
                Next
              </Button>
            </span>
          </div>
        </>
      )}
      {editing && (
        <RecordDialog
          tenant={tenant}
          schema={schema}
          row={editing === 'new' ? undefined : editing}
          onClose={() => {
            setEditing(undefined);
          }}
        />
      )}
      {resetting && (
        <ResetPasswordDialog
          tenant={tenant}
          collection={name}
          row={resetting}
          onClose={() => {
            setResetting(undefined);
          }}
        />
      )}
    </div>
  );
}
