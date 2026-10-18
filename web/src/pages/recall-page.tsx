import { useMutation } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { ScopePicker } from '@/components/memory/scope-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import { api } from '@/lib/api';
import type { RecallSignals } from '@/lib/memory';
import { initialScope } from '@/lib/memory';

const SIGNALS: Array<{ key: keyof RecallSignals; label: string; hint: string }> = [
  { key: 'vector', label: 'Vector', hint: 'Cosine similarity of the embeddings' },
  { key: 'keyword', label: 'BM25', hint: 'Keyword score' },
  { key: 'entity', label: 'Entity', hint: 'Query entities the memory mentions' },
  { key: 'fused', label: 'Fused', hint: 'Reciprocal rank fusion, normalised' },
  { key: 'recency', label: 'Recency', hint: '0.995 ^ hours since last access' },
  { key: 'importance', label: 'Importance', hint: 'Set when remembered' },
  { key: 'retention', label: 'Retention', hint: 'Forgetting curve e^(−t/S)' },
];

function Signal({ value }: { value: number | undefined }) {
  if (value === undefined) return <span className="text-muted-foreground">–</span>;
  const width = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="tabular-nums">{value.toFixed(2)}</span>
      <span
        className="hidden h-1.5 w-10 overflow-hidden rounded-full bg-muted 2xl:block"
        aria-hidden
      >
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${String(width)}%` }}
        />
      </span>
    </div>
  );
}

/** Recall playground (PLAN 17): run a query, see each retriever's signal and the packed context. */
export function RecallPage() {
  const [scope, setScope] = useState(initialScope);
  const [query, setQuery] = useState('');
  const [k, setK] = useState('10');
  const [budget, setBudget] = useState('1000');
  const [inherit, setInherit] = useState(false);
  const recall = useMutation({
    mutationFn: () =>
      api.memoryRecall(scope.tenant, scope.scope, query, {
        k: Number(k) || 10,
        tokenBudget: Number(budget) || 1000,
        inherit,
      }),
  });
  const r = recall.data;

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Recall playground</CardTitle>
          <CardDescription>
            The same pipeline agents use: vector, keyword and entity retrieval, fused and scored,
            then packed to a token budget.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) recall.mutate();
            }}
          >
            <ScopePicker value={scope} onChange={setScope} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recall-query">Query</Label>
              <Textarea
                id="recall-query"
                rows={2}
                placeholder="What coffee does the user like?"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex w-24 flex-col gap-1.5">
                <Label htmlFor="recall-k">Results</Label>
                <Input
                  id="recall-k"
                  inputMode="numeric"
                  value={k}
                  onChange={(e) => setK(e.target.value)}
                />
              </div>
              <div className="flex w-32 flex-col gap-1.5">
                <Label htmlFor="recall-budget">Token budget</Label>
                <Input
                  id="recall-budget"
                  inputMode="numeric"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
              </div>
              <Toggle variant="outline" pressed={inherit} onPressedChange={setInherit}>
                Include parent scopes
              </Toggle>
              <Button type="submit" disabled={!query.trim() || recall.isPending}>
                <Search /> Recall
              </Button>
            </div>
          </form>
          {recall.isError && (
            <p className="mt-4 text-sm text-destructive">{recall.error.message}</p>
          )}
        </CardContent>
      </Card>

      {r && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Results
                {r.degraded && (
                  <Badge variant="secondary" title="The model service is unavailable">
                    degraded
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                {r.items.length} memories. A dash means the retriever did not return the memory.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Memory</TableHead>
                    {SIGNALS.map((s) => (
                      <TableHead key={s.key} className="text-right" title={s.hint}>
                        {s.label}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">Score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.items.map((item) => (
                    <TableRow key={item.memory.id}>
                      <TableCell className="max-w-xs xl:max-w-md">
                        <div className="truncate">{item.memory.text}</div>
                        <div className="text-xs text-muted-foreground">{item.memory.kind}</div>
                      </TableCell>
                      {SIGNALS.map((s) => (
                        <TableCell key={s.key} className="text-right">
                          <Signal value={item.signals[s.key]} />
                        </TableCell>
                      ))}
                      <TableCell className="text-right font-medium tabular-nums">
                        {item.score.toFixed(3)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Packed context</CardTitle>
              <CardDescription>
                About {r.tokens} of {budget} tokens; this is what an agent puts in its prompt.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="rounded-lg bg-muted p-4 font-mono text-sm whitespace-pre-wrap">
                {r.context || 'Nothing relevant is remembered.'}
              </pre>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
