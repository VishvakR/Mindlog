import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock3, Save, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { TypeChip } from '@/components/type-chip';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
import type { KeyDetail, KeyType } from '@/lib/api';
import { api } from '@/lib/api';
import { formatTtl } from '@/lib/key-types';
import type { Draft } from './draft';
import { emptyDraft, fromDraft, toDraft } from './draft';
import { RowsEditor, TextEditor } from './value-editors';

interface KeyEditorProps {
  name: string;
  /** Loaded value; undefined while creating a new key of `newType`. */
  detail: KeyDetail | undefined;
  newType?: KeyType;
  onSaved: () => void;
  onDeleted: () => void;
}

const COLUMNS = {
  hash: [{ label: 'Field' }, { label: 'Value' }],
  list: [{ label: 'Element' }],
  set: [{ label: 'Member' }],
  zset: [{ label: 'Member' }, { label: 'Score', numeric: true, width: 'w-32' }],
};

/** Typed editor for one key: value, TTL and delete. Saving replaces the whole value atomically. */
export function KeyEditor({ name, detail, newType, onSaved, onDeleted }: KeyEditorProps) {
  const type = detail?.type ?? newType ?? 'string';
  const initial = detail ? toDraft(detail) : emptyDraft(type);
  const [draft, setDraft] = useState<Draft>(initial);
  const [problem, setProblem] = useState<string>();
  const [ttlSeconds, setTtlSeconds] = useState('');
  const queries = useQueryClient();
  const readOnly = Boolean(detail?.truncated);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const refresh = async () => {
    await queries.invalidateQueries({ queryKey: ['keys'] });
    await queries.invalidateQueries({ queryKey: ['key', name] });
  };

  const save = useMutation({
    mutationFn: async () => {
      const value = fromDraft(draft);
      if (typeof value === 'string') throw new Error(value);
      await api.write(name, {
        ...value,
        ttlMs: detail?.ttlMs ?? null,
        ...(detail?.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
      });
    },
    onMutate: () => setProblem(undefined),
    onSuccess: async () => {
      toast.success(detail ? `Saved ${name}` : `Created ${name}`);
      await refresh();
      onSaved();
    },
    onError: (e) => setProblem(e.message),
  });

  const ttl = useMutation({
    mutationFn: (ms: number | null) => api.setTtl(name, ms),
    onSuccess: async (_, ms) => {
      toast.success(
        ms === null ? `${name} no longer expires` : `${name} expires in ${formatTtl(ms)}`,
      );
      setTtlSeconds('');
      await refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: () => api.remove(name),
    onSuccess: async () => {
      toast.success(`Deleted ${name}`);
      await queries.invalidateQueries({ queryKey: ['keys'] });
      onDeleted();
    },
    onError: (e) => toast.error(e.message),
  });

  const seconds = Number(ttlSeconds);
  const ttlValid = ttlSeconds.trim() !== '' && Number.isFinite(seconds) && seconds > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <TypeChip type={type} label />
        <h2 className="min-w-0 flex-1 truncate font-mono text-base font-semibold" title={name}>
          {name}
        </h2>
        {detail && (
          <span className="text-sm text-muted-foreground tabular-nums">
            {detail.type === 'string' || detail.type === 'json'
              ? null
              : `${detail.length.toLocaleString()} ${detail.length === 1 ? 'element' : 'elements'}`}
          </span>
        )}
        {detail && (
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
              <Trash2 data-icon="inline-start" />
              Delete
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The key and its value are removed for every client. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep key</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
                  Delete key
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {detail?.truncated && (
          <Alert>
            <AlertTitle>
              Showing the first {Array.isArray(detail.value) ? detail.value.length : 0} of{' '}
              {detail.length.toLocaleString()} elements
            </AlertTitle>
            <AlertDescription>
              Large collections are read-only here. Use the console to change them.
            </AlertDescription>
          </Alert>
        )}
        {detail?.encoding === 'base64' && (
          <Alert>
            <AlertTitle>Binary value</AlertTitle>
            <AlertDescription>
              Bytes that are not UTF-8 text are shown and saved as base64.
            </AlertDescription>
          </Alert>
        )}

        {detail && (
          <section aria-label="Expiry" className="flex flex-wrap items-center gap-2 text-sm">
            <Clock3 className="size-4 text-ttl" aria-hidden />
            <span className={detail.ttlMs === null ? 'text-muted-foreground' : 'text-ttl'}>
              {detail.ttlMs === null ? 'No expiry' : `Expires in ${formatTtl(detail.ttlMs)}`}
            </span>
            <form
              className="ml-auto flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (ttlValid) ttl.mutate(Math.round(seconds * 1000));
              }}
            >
              <InputGroup className="w-40">
                <InputGroupInput
                  aria-label="Expire after seconds"
                  inputMode="decimal"
                  placeholder="3600"
                  value={ttlSeconds}
                  onChange={(e) => setTtlSeconds(e.target.value)}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>seconds</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!ttlValid || ttl.isPending}
              >
                Set expiry
              </Button>
              {detail.ttlMs !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={ttl.isPending}
                  onClick={() => ttl.mutate(null)}
                >
                  Never expire
                </Button>
              )}
            </form>
          </section>
        )}

        {type === 'string' || type === 'json' ? (
          <TextEditor
            label={type === 'json' ? 'JSON document' : 'Value'}
            value={draft.text}
            disabled={readOnly}
            invalid={problem !== undefined}
            onChange={(text) => setDraft({ ...draft, text })}
          />
        ) : (
          <RowsEditor
            columns={COLUMNS[type]}
            rows={draft.rows}
            numbered={type === 'list'}
            disabled={readOnly}
            onChange={(rows) => setDraft({ ...draft, rows })}
          />
        )}
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 border-t px-4 py-3">
        <span className="text-xs text-muted-foreground">
          {detail
            ? 'Saving replaces the whole value and keeps the expiry.'
            : 'The key is created when you save.'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={!dirty || save.isPending}
          onClick={() => setDraft(initial)}
        >
          <Undo2 data-icon="inline-start" />
          Discard changes
        </Button>
        <Button
          size="sm"
          disabled={readOnly || (!dirty && detail !== undefined) || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <Save data-icon="inline-start" />
          )}
          {detail ? 'Save' : 'Create key'}
        </Button>
      </div>
    </div>
  );
}
