import { useMutation } from '@tanstack/react-query';
import { Search, Snowflake } from 'lucide-react';
import { useState } from 'react';
import { ScopePicker } from '@/components/memory/scope-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import type { RecallResult, RecallSignals, RecipeName } from '@/lib/memory';
import { RECIPES, initialScope, presentSignals, retrieverColumns } from '@/lib/memory';

const SIGNAL_INFO: Record<keyof RecallSignals, { label: string; hint: string }> = {
  vector: { label: 'Vector', hint: 'Cosine similarity of the embeddings' },
  keyword: { label: 'BM25', hint: 'Keyword score' },
  entity: { label: 'Entity', hint: 'Query entities the memory mentions' },
  ppr: { label: 'PPR', hint: 'Personalized PageRank mass in the memory graph' },
  theme: { label: 'Theme', hint: 'Position in a community found for a broad question' },
  rerank: { label: 'Rerank', hint: 'Cross-encoder relevance (raw logit)' },
  fused: { label: 'Fused', hint: 'Weighted reciprocal rank fusion, normalised' },
  recency: { label: 'Recency', hint: '0.995 ^ hours since last access' },
  importance: { label: 'Importance', hint: 'Set when remembered' },
  retention: { label: 'Retention', hint: 'Forgetting curve e^(−t/S)' },
};
const SCORE_SIGNALS: Array<keyof RecallSignals> = ['fused', 'recency', 'importance', 'retention'];

const ROUTE_HINT: Record<RecallResult['route'], string> = {
  specific: 'One thing asked: default weights',
  multihop: 'Two or more entities: graph (PPR) weighs 1.2',
  broad: 'An overview asked: themes run and weigh 1.5',
};

function Signal({ value, scaled = true }: { value: number | undefined; scaled?: boolean }) {
  if (value === undefined) return <span className="text-muted-foreground">–</span>;
  if (!scaled) return <span className="tabular-nums">{value.toFixed(2)}</span>;
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

/** Recall playground (PLAN 17): run a recipe, see each retriever's ranking, the scores and the packing. */
export function RecallPage() {
  const [scope, setScope] = useState(initialScope);
  const [query, setQuery] = useState('');
  const [k, setK] = useState('10');
  const [budget, setBudget] = useState('1000');
  const [inherit, setInherit] = useState(false);
  const [includeCold, setIncludeCold] = useState(false);
  const [recipe, setRecipe] = useState<RecipeName>('full');
  const recall = useMutation({
    mutationFn: () =>
      api.memoryRecall(scope.tenant, scope.scope, query, {
        k: Number(k) || 10,
        tokenBudget: Number(budget) || 1000,
        inherit,
        recipe,
        includeCold,
      }),
  });
  const r = recall.data;
  const signals = r ? [...presentSignals(r.items), ...SCORE_SIGNALS] : [];
  const columns = r ? retrieverColumns(r) : [];
  const recipeLabel = (name: string) => RECIPES.find((x) => x.name === name)?.label ?? name;

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Recall playground</CardTitle>
          <CardDescription>
            The same pipeline agents use: a recipe of retrievers (vector, keyword, entity, graph,
            themes), fused, reranked and scored, then packed to a token budget.
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
              <div className="flex flex-col gap-1.5">
                <Label>Recipe</Label>
                <Select
                  value={recipe}
                  onValueChange={(v) => {
                    if (v) setRecipe(v as RecipeName);
                  }}
                >
                  <SelectTrigger className="w-44" aria-label="Recall recipe">
                    <SelectValue>{(v: string) => recipeLabel(v)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {RECIPES.map((x) => (
                        <SelectItem key={x.name} value={x.name} title={x.hint}>
                          {x.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <Toggle variant="outline" pressed={inherit} onPressedChange={setInherit}>
                Include parent scopes
              </Toggle>
              <Toggle variant="outline" pressed={includeCold} onPressedChange={setIncludeCold}>
                <Snowflake /> Include cold
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
              <CardTitle className="flex flex-wrap items-center gap-2">
                Results
                <Badge variant="outline">{recipeLabel(r.recipe)}</Badge>
                <Badge variant="outline" title={ROUTE_HINT[r.route]}>
                  {r.route} query
                </Badge>
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
                    {signals.map((key) => (
                      <TableHead key={key} className="text-right" title={SIGNAL_INFO[key].hint}>
                        {SIGNAL_INFO[key].label}
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
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          {item.memory.kind}
                          {item.memory.tier === 'cold' && (
                            <span className="inline-flex items-center gap-0.5 text-sky-600 dark:text-sky-400">
                              <Snowflake className="size-3" /> cold
                            </span>
                          )}
                        </div>
                      </TableCell>
                      {signals.map((key) => (
                        <TableCell key={key} className="text-right">
                          <Signal
                            value={item.signals[key]}
                            scaled={key !== 'rerank' && key !== 'keyword' && key !== 'entity'}
                          />
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
          {columns.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Retrievers</CardTitle>
                <CardDescription>
                  Each retriever&apos;s own ranking before fusion. Grey ids were not among the
                  results shown above.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                  {columns.map((col) => (
                    <div key={col.name} className="flex min-w-0 flex-col gap-2">
                      <div className="flex items-center justify-between text-sm font-medium">
                        {SIGNAL_INFO[col.name as keyof RecallSignals]?.label ?? col.name}
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {col.total}
                        </span>
                      </div>
                      {col.rows.length === 0 ? (
                        <p className="text-xs text-muted-foreground">Nothing found.</p>
                      ) : (
                        <ol className="flex flex-col gap-1 text-xs">
                          {col.rows.map((row) => (
                            <li key={row.id} className="flex gap-2">
                              <span className="w-4 shrink-0 text-right text-muted-foreground tabular-nums">
                                {row.rank}
                              </span>
                              {row.text === undefined ? (
                                <span className="truncate font-mono text-muted-foreground">
                                  {row.id}
                                </span>
                              ) : (
                                <span className="truncate" title={row.text}>
                                  {row.text}
                                </span>
                              )}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  ))}
                </div>
                {(r.explain?.themes.length ?? 0) > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Themes found:</span>
                    {r.explain?.themes.map((t) => (
                      <Badge key={t.label + String(t.ids.length)} variant="secondary">
                        {t.label || 'unnamed'} · {t.ids.length}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Packed context</CardTitle>
              <CardDescription>
                What an agent puts in its prompt: the best candidates per token, grouped by kind.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-muted"
                  role="meter"
                  aria-label="Tokens used of the budget"
                  aria-valuemin={0}
                  aria-valuemax={r.budget}
                  aria-valuenow={r.tokens}
                >
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${String(Math.min(100, (r.tokens / Math.max(1, r.budget)) * 100))}%`,
                    }}
                  />
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span>
                    <span className="font-medium text-foreground tabular-nums">{r.tokens}</span> of{' '}
                    {r.budget} tokens
                  </span>
                  <span>{r.groups.reduce((n, g) => n + g.ids.length, 0)} packed</span>
                  <span>{r.dropped.length} left out</span>
                  {r.compressed.length > 0 && <span>{r.compressed.length} shortened</span>}
                </div>
                {r.groups.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {r.groups.map((g) => (
                      <Badge key={g.name} variant="outline">
                        {g.name} · {g.ids.length}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
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
