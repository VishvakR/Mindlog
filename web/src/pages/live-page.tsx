import { Radio } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ScopePicker } from '@/components/memory/scope-picker';
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
import { followChanges } from '@/lib/api';
import type { ChangeEvent } from '@/lib/memory';
import { formatScope, initialScope } from '@/lib/memory';

/** Events kept on screen. */
const KEEP = 200;
const RETRY_MS = 2000;

const tone = (type: string) =>
  type.startsWith('conflict.raised')
    ? 'destructive'
    : type.endsWith('forgotten') || type.endsWith('dropped')
      ? 'outline'
      : 'secondary';

/** Live feed (PLAN 13.5, 17): a scope's changes as they commit, resuming after drops. */
export function LivePage() {
  const [scope, setScope] = useState(initialScope);
  const [on, setOn] = useState(true);
  const [events, setEvents] = useState<ChangeEvent[]>([]);
  const [state, setState] = useState<'connecting' | 'live' | 'retrying'>('connecting');
  const cursor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!on) return;
    const abort = new AbortController();
    cursor.current = undefined;
    setEvents([]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      setState('connecting');
      followChanges(
        scope.tenant,
        scope.scope.user,
        cursor.current,
        (e) => {
          if (e.type === 'resync') return;
          const change = e as ChangeEvent;
          cursor.current = change.cursor;
          setEvents((list) => [change, ...list].slice(0, KEEP));
        },
        abort.signal,
        () => setState('live'),
      )
        .catch(() => undefined)
        .finally(() => {
          if (abort.signal.aborted) return;
          setState('retrying');
          timer = setTimeout(run, RETRY_MS);
        });
    };
    run();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [on, scope.tenant, scope.scope.user]);

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Live feed
            {on && (
              <Badge variant={state === 'live' ? 'default' : 'outline'}>
                {state === 'live' ? 'live' : state}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Memories added and forgotten, conflicts and branches of a user scope, as they commit.
            After a drop the stream resumes from its last cursor.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <ScopePicker value={scope} onChange={setScope} />
            </div>
            <Button variant="outline" onClick={() => setOn(!on)}>
              {on ? 'Pause' : 'Resume'}
            </Button>
          </div>
          {events.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Radio />
                </EmptyMedia>
                <EmptyTitle>
                  Waiting for changes in {formatScope({ user: scope.scope.user })}
                </EmptyTitle>
                <EmptyDescription>
                  Remember something for this user from an agent, <code>MEM.ADD</code> or the Recall
                  page.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {events.map((e) => (
                <li
                  key={`${e.cursor}:${e.type}`}
                  className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
                >
                  <Badge variant={tone(e.type)}>{e.type}</Badge>
                  {e.branch && <Badge variant="outline">branch {e.branch}</Badge>}
                  <span className="font-mono text-xs">{e.ids.slice(0, 3).join(' ')}</span>
                  {e.ids.length > 3 && (
                    <span className="text-xs text-muted-foreground">+{e.ids.length - 3}</span>
                  )}
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {e.principal} · {new Date(e.atMs).toLocaleTimeString()} · {e.cursor}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
