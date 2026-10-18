import { useMutation } from '@tanstack/react-query';
import { Share2 } from 'lucide-react';
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api } from '@/lib/api';
import type { GraphResult } from '@/lib/memory';
import { initialScope, radialLayout } from '@/lib/memory';

const WIDTH = 1000;
const HEIGHT = 460;
// Edges from entities named together (no extracted relation); unlabelled to keep the view readable.
const CO_MENTION = 'mentioned_with';

function GraphView({ graph, onPick }: { graph: GraphResult; onPick: (name: string) => void }) {
  const at = radialLayout(graph.nodes, WIDTH, HEIGHT);
  return (
    <svg
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      className="h-auto w-full rounded-lg border bg-muted/30"
      role="img"
      aria-label={`Graph around ${graph.nodes[0]?.name ?? ''}`}
    >
      {graph.edges.map((e) => {
        const a = at.get(e.src);
        const b = at.get(e.dst);
        if (!a || !b) return null;
        return (
          <g key={`${e.src}|${e.relation}|${e.dst}`}>
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className="stroke-border"
              strokeWidth={Math.min(4, 1 + Math.log2(e.weight + 1))}
            />
            <title>{`${e.src} ${e.relation} ${e.dst}`}</title>
            {e.relation !== CO_MENTION && (
              <text
                x={(a.x + b.x) / 2}
                y={(a.y + b.y) / 2 - 4}
                textAnchor="middle"
                className="fill-muted-foreground text-[11px]"
              >
                {e.relation}
              </text>
            )}
          </g>
        );
      })}
      {graph.nodes.map((n) => {
        const p = at.get(n.id);
        if (!p) return null;
        const r = n.depth === 0 ? 14 : 9;
        return (
          <g key={n.id} className="cursor-pointer" onClick={() => onPick(n.name)}>
            <title>{`${n.id} · ${String(n.mentions)} mentions`}</title>
            <circle
              cx={p.x}
              cy={p.y}
              r={r}
              className={n.depth === 0 ? 'fill-primary' : 'fill-background stroke-primary'}
              strokeWidth={2}
            />
            <text x={p.x} y={p.y + r + 13} textAnchor="middle" className="fill-foreground text-xs">
              {n.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Knowledge graph (PLAN 17, basic): an entity, its 1–2 hop neighbourhood and its memories. */
export function GraphPage() {
  const [scope, setScope] = useState(initialScope);
  const [entity, setEntity] = useState('');
  const [depth, setDepth] = useState('1');
  const graph = useMutation({
    mutationFn: (name: string) => api.memoryGraph(scope.tenant, scope.scope, name, Number(depth)),
  });
  const look = (name: string) => {
    setEntity(name);
    graph.mutate(name);
  };
  const g = graph.data;

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Knowledge graph</CardTitle>
          <CardDescription>
            People, places and things the memories mention, and how they relate. Click a node to
            centre on it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (entity.trim()) graph.mutate(entity.trim());
            }}
          >
            <ScopePicker value={scope} onChange={setScope} />
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                <Label htmlFor="graph-entity">Entity</Label>
                <Input
                  id="graph-entity"
                  placeholder="Ana, or person:ana"
                  value={entity}
                  onChange={(e) => setEntity(e.target.value)}
                />
              </div>
              <ToggleGroup
                variant="outline"
                value={[depth]}
                onValueChange={(v: string[]) => v[0] && setDepth(v[0])}
                aria-label="Hops"
              >
                <ToggleGroupItem value="1">1 hop</ToggleGroupItem>
                <ToggleGroupItem value="2">2 hops</ToggleGroupItem>
              </ToggleGroup>
              <Button type="submit" disabled={!entity.trim() || graph.isPending}>
                <Share2 /> Show
              </Button>
            </div>
          </form>
          {graph.isError && <p className="mt-4 text-sm text-destructive">{graph.error.message}</p>}
        </CardContent>
      </Card>

      {g && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {g.nodes[0]?.name}
                <Badge variant="secondary">{g.nodes[0]?.type}</Badge>
                {g.truncated && <Badge variant="outline">truncated</Badge>}
              </CardTitle>
              <CardDescription>
                {g.nodes.length} entities, {g.edges.length} relations, mentioned by{' '}
                {g.memories.length} memories.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <GraphView graph={g} onPick={look} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Relations</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>From</TableHead>
                    <TableHead>Relation</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead className="text-right">Weight</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.edges.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-muted-foreground">
                        No relations yet: extraction with an LLM adds them (EXTRACT_GGUF).
                      </TableCell>
                    </TableRow>
                  )}
                  {g.edges.map((e) => (
                    <TableRow key={`${e.src}|${e.relation}|${e.dst}`}>
                      <TableCell className="font-mono text-xs">{e.src}</TableCell>
                      <TableCell>{e.relation}</TableCell>
                      <TableCell className="font-mono text-xs">{e.dst}</TableCell>
                      <TableCell className="text-right tabular-nums">{e.weight}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
