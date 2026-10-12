import { useQuery } from '@tanstack/react-query';
import { MousePointerClick, RefreshCw, Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { useSearchParams } from 'react-router';
import { KeyEditor } from '@/components/data/key-editor';
import { KeyList } from '@/components/data/key-list';
import { NewKeyDialog } from '@/components/data/new-key-dialog';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import type { KeyType } from '@/lib/api';
import { ApiError, api } from '@/lib/api';
import { KEY_TYPE_ORDER, KEY_TYPES } from '@/lib/key-types';
import { cn } from '@/lib/utils';

const ALL = 'all';

/** Two panes: keys on the left (search, type filter, SCAN paging), the selected key's editor on the right. */
export function DataPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('key') ?? undefined;
  const newType = params.get('new') as KeyType | null;
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [type, setType] = useState<KeyType | typeof ALL>(ALL);
  const queries = useQueryClient();

  const detail = useQuery({
    queryKey: ['key', selected],
    queryFn: () => api.read(selected ?? ''),
    enabled: selected !== undefined && !newType,
  });
  const select = (key: string | undefined, create?: KeyType) => {
    const next = new URLSearchParams();
    if (key !== undefined) next.set('key', key);
    if (create) next.set('new', create);
    setParams(next);
  };
  const missing = detail.error instanceof ApiError && detail.error.problem.status === 404;

  return (
    <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(18rem,26rem)_1fr]">
      <section
        aria-label="Keys"
        className={cn('flex min-h-0 flex-col border-r', selected && 'hidden md:flex')}
      >
        <div className="flex flex-col gap-2 border-b p-3">
          <div className="flex gap-2">
            <InputGroup>
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Search keys by prefix or pattern"
                className="font-mono"
                placeholder="user:  or  session:*:token"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </InputGroup>
            <Button
              variant="outline"
              size="icon"
              aria-label="Refresh keys"
              onClick={() => void queries.invalidateQueries({ queryKey: ['keys'] })}
            >
              <RefreshCw />
            </Button>
          </div>
          <div className="flex gap-2">
            <Select value={type} onValueChange={(v) => setType((v ?? ALL) as KeyType | typeof ALL)}>
              <SelectTrigger className="flex-1" aria-label="Filter by type">
                <SelectValue>
                  {(v: string) => (v === ALL ? 'All types' : KEY_TYPES[v as KeyType].label)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={ALL}>All types</SelectItem>
                  {KEY_TYPE_ORDER.map((t) => (
                    <SelectItem key={t} value={t}>
                      {KEY_TYPES[t].label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <NewKeyDialog onCreate={(name, t) => select(name, t)} />
          </div>
        </div>
        <KeyList
          search={deferredSearch}
          type={type === ALL ? undefined : type}
          selected={selected}
          onSelect={(k) => select(k.key)}
        />
      </section>

      <section
        aria-label="Key"
        className={cn('flex min-h-0 flex-col', !selected && 'hidden md:flex')}
      >
        {selected === undefined ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MousePointerClick />
              </EmptyMedia>
              <EmptyTitle>Select a key</EmptyTitle>
              <EmptyDescription>
                Its value, type and expiry show here, ready to edit.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : newType ? (
          <KeyEditor
            key={`new:${selected}:${newType}`}
            name={selected}
            detail={undefined}
            newType={newType}
            onSaved={() => select(selected)}
            onDeleted={() => select(undefined)}
          />
        ) : detail.isPending ? (
          <div className="flex flex-col gap-3 p-4">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-64" />
          </div>
        ) : detail.isError ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyTitle>
                {missing ? 'This key does not exist' : 'Could not load this key'}
              </EmptyTitle>
              <EmptyDescription>
                {missing
                  ? 'It may have expired or been deleted. Pick another key, or create it with New key.'
                  : detail.error.message}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <KeyEditor
            key={`${selected}:${String(detail.dataUpdatedAt)}`}
            name={selected}
            detail={detail.data}
            onSaved={() => undefined}
            onDeleted={() => select(undefined)}
          />
        )}
        {selected !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            className="m-2 self-start md:hidden"
            onClick={() => select(undefined)}
          >
            Back to keys
          </Button>
        )}
      </section>
    </div>
  );
}
