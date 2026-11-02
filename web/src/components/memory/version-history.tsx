import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { HistoryEntry } from '@/lib/memory';
import { versionChanges } from '@/lib/memory';

const when = (ms: number) => new Date(ms).toLocaleString();

/**
 * A memory's versions newest first (PLAN 17.2): each revision with what
 * changed since the one before it (evolution, review, tier moves).
 */
export function VersionHistory({
  entries,
  pending,
}: {
  entries?: HistoryEntry[];
  pending: boolean;
}) {
  if (pending) return <Skeleton className="h-10" />;
  const list = entries ?? [];
  if (list.length === 0) return <p className="text-muted-foreground">No history kept.</p>;
  return (
    <ol className="relative flex flex-col gap-3 border-l pl-4">
      {list.map((h, i) => {
        const older = list[i + 1];
        const changes = older ? versionChanges(older.memory, h.memory) : [];
        return (
          <li key={`${String(h.revision)}:${h.version}:${String(i)}`} className="relative text-xs">
            <span className="absolute -left-[1.3rem] top-1 size-2 rounded-full bg-primary" />
            <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
              <Badge variant="outline" className="tabular-nums">
                v{h.revision}
              </Badge>
              <span>{when(h.atMs)}</span>
              {h.memory.tier === 'cold' && <Badge variant="secondary">cold</Badge>}
              {h.memory.expiredAtMs && <Badge variant="destructive">forgotten</Badge>}
            </div>
            {older ? (
              changes.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-0.5 font-mono">
                  {changes.map((c) => (
                    <li key={c} className="break-words">
                      {c}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted-foreground">Recall statistics only</p>
              )
            ) : (
              <p className="mt-1">{h.memory.text}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
