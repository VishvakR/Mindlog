import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Clock3 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { TypeChip } from '@/components/type-chip';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import type { KeySummary, KeyType } from '@/lib/api';
import { api } from '@/lib/api';
import { formatTtl } from '@/lib/key-types';
import { cn } from '@/lib/utils';

/** A plain search becomes a prefix match; text with glob characters is used as is. */
const toPattern = (search: string): string | undefined => {
  const s = search.trim();
  if (!s) return undefined;
  return /[*?[\]]/.test(s) ? s : `${s}*`;
};

interface KeyListProps {
  search: string;
  type: KeyType | undefined;
  selected: string | undefined;
  onSelect: (key: KeySummary) => void;
}

/** SCAN-paged, virtualized key list; pages load as the list scrolls. */
export function KeyList({ search, type, selected, onSelect }: KeyListProps) {
  const match = toPattern(search);
  const keys = useInfiniteQuery({
    queryKey: ['keys', match, type],
    queryFn: ({ pageParam }) =>
      api.scan({
        cursor: pageParam,
        ...(match ? { match } : {}),
        ...(type ? { type } : {}),
        count: 500,
      }),
    initialPageParam: '0',
    getNextPageParam: (last) => (last.cursor === '0' ? undefined : last.cursor),
  });
  const rows = keys.data?.pages.flatMap((p) => p.keys) ?? [];
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 40,
    overscan: 12,
  });
  const items = virtual.getVirtualItems();
  const lastIndex = items[items.length - 1]?.index ?? 0;

  // SCAN pages can be sparse with filters: keep loading until the view is full or the scan ends.
  useEffect(() => {
    if (keys.hasNextPage && !keys.isFetchingNextPage && lastIndex >= rows.length - 20)
      void keys.fetchNextPage();
  }, [keys, lastIndex, rows.length]);

  if (keys.isPending) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  }
  if (keys.isError)
    return (
      <p className="p-4 text-sm text-destructive">Could not list keys: {keys.error.message}</p>
    );
  if (rows.length === 0 && !keys.hasNextPage) {
    return (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyTitle>{match || type ? 'No matching keys' : 'No keys yet'}</EmptyTitle>
          <EmptyDescription>
            {match || type
              ? 'Change the search or type filter.'
              : 'Create one with New key, or write from any Redis client.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div ref={parent} className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Keys">
      <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
        {items.map((item) => {
          const k = rows[item.index];
          if (!k) return null;
          const active = k.key === selected;
          return (
            <button
              key={`${k.encoding}:${k.key}`}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => onSelect(k)}
              className={cn(
                'absolute left-0 flex w-full items-center gap-2 px-3 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
                active && 'bg-accent text-accent-foreground hover:bg-accent',
              )}
              style={{ height: item.size, transform: `translateY(${String(item.start)}px)` }}
            >
              <TypeChip type={k.type} />
              <span className="min-w-0 flex-1 truncate font-mono">
                {k.encoding === 'base64' ? `base64:${k.key}` : k.key}
              </span>
              {k.ttlMs !== null && (
                <span
                  className="flex shrink-0 items-center gap-1 text-xs text-ttl"
                  title="Time to live"
                >
                  <Clock3 className="size-3" aria-hidden />
                  {formatTtl(k.ttlMs)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {keys.isFetchingNextPage && (
        <p className="px-3 py-2 text-xs text-muted-foreground">Loading more…</p>
      )}
    </div>
  );
}
