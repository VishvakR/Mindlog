/** A ranked candidate for the prompt (PLAN 13.6). */
export interface PackItem {
  readonly id: string;
  readonly text: string;
  readonly kind: string;
  readonly score: number;
}

export interface PackGroup {
  readonly name: string;
  readonly ids: readonly string[];
}

export interface Packed {
  /** Packed ids in context order. */
  readonly ids: string[];
  readonly context: string;
  readonly tokens: number;
  readonly budget: number;
  /** Candidates left out, best first. */
  readonly dropped: string[];
  /** Ids included in a shortened form. */
  readonly compressed: string[];
  readonly groups: PackGroup[];
}

/** Rough tokens of a text (~4 characters each, PLAN 13.6 default). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Context groups in output order, by memory kind (PLAN 13.6). */
const GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Facts', ['semantic']],
  ['Themes', ['theme']],
  ['Procedures', ['procedural']],
  ['Recent episodes', ['episodic', 'working', 'tool_trace']],
];
const groupOf = (kind: string): string =>
  GROUPS.find(([, kinds]) => kinds.includes(kind))?.[0] ?? 'Recent episodes';

const SENTENCE = /[^.!?\n]+[.!?]*/gu;

/**
 * The longest prefix of whole leading sentences within `tokens`, or undefined.
 *
 * shortcut: extractive (leading sentences); use the Summarizer port once the model service serves one.
 */
export function compress(text: string, tokens: number): string | undefined {
  let out = '';
  for (const [s] of text.matchAll(SENTENCE)) {
    const next = `${out}${s}`.trim();
    if (estimateTokens(`- ${next} …`) > tokens) break;
    out = `${out}${s}`;
  }
  const kept = out.trim();
  return kept === '' || kept === text.trim() ? undefined : `${kept} …`;
}

interface Choice {
  readonly item: PackItem;
  readonly text: string;
  readonly cost: number;
  readonly value: number;
}

const line = (text: string) => `- ${text}`;
const header = (name: string) => `## ${name}`;

function render(chosen: readonly Choice[]): {
  context: string;
  groups: PackGroup[];
  ids: string[];
} {
  const groups: PackGroup[] = [];
  const blocks: string[] = [];
  for (const [name] of GROUPS) {
    const members = chosen
      .filter((c) => groupOf(c.item.kind) === name)
      .sort((a, b) => b.item.score - a.item.score || (a.item.id < b.item.id ? -1 : 1));
    if (members.length === 0) continue;
    groups.push({ name, ids: members.map((c) => c.item.id) });
    blocks.push([header(name), ...members.map((c) => line(c.text))].join('\n'));
  }
  return { context: blocks.join('\n\n'), groups, ids: groups.flatMap((g) => g.ids) };
}

/**
 * Token-budget packing (PLAN 13.6): greedy by value per token, shortening an
 * item to its leading sentences when it no longer fits whole, then one pass
 * that swaps a packed item for a more valuable unpacked one when the budget
 * allows. Output is grouped by kind under `## <group>` headers, which count
 * against the budget; the result never exceeds it.
 */
export function pack(items: readonly PackItem[], budget: number): Packed {
  const valueOf = (i: PackItem) => Math.max(i.score, 1e-9);
  const order = [...items].sort(
    (a, b) =>
      valueOf(b) / estimateTokens(line(b.text)) - valueOf(a) / estimateTokens(line(a.text)) ||
      (a.id < b.id ? -1 : 1),
  );
  // Each group's header and its blank separator, paid once by its first item.
  const headerCost = (name: string) => estimateTokens(header(name)) + 1;
  const chosen: Choice[] = [];
  let used = 0;
  const groupsUsed = new Set<string>();
  const extra = (item: PackItem) =>
    groupsUsed.has(groupOf(item.kind)) ? 0 : headerCost(groupOf(item.kind));
  const take = (c: Choice) => {
    used += c.cost + extra(c.item);
    groupsUsed.add(groupOf(c.item.kind));
    chosen.push(c);
  };
  for (const item of order) {
    const room = budget - used - extra(item);
    const full = estimateTokens(line(item.text));
    if (full <= room) take({ item, text: item.text, cost: full, value: valueOf(item) });
    else {
      const short = compress(item.text, room);
      if (short !== undefined) {
        const cost = estimateTokens(line(short));
        take({ item, text: short, cost, value: (valueOf(item) * cost) / full });
      }
    }
  }
  // One improvement pass: an unpacked item replaces the least valuable packed one if it fits.
  const packed = new Set(chosen.map((c) => c.item.id));
  for (const item of [...items].sort((a, b) => valueOf(b) - valueOf(a))) {
    if (packed.has(item.id)) continue;
    const cost = estimateTokens(line(item.text));
    const weakest = chosen.reduce<Choice | undefined>(
      (w, c) => (!w || c.value < w.value ? c : w),
      undefined,
    );
    if (!weakest || valueOf(item) <= weakest.value) continue;
    // A group emptied by the swap keeps its header cost: conservative, and the render below is exact.
    if (used - weakest.cost + cost + extra(item) > budget) continue;
    chosen.splice(chosen.indexOf(weakest), 1);
    packed.delete(weakest.item.id);
    used -= weakest.cost;
    take({ item, text: item.text, cost, value: valueOf(item) });
    packed.add(item.id);
  }
  // Exact count of the rendered text; drop the least valuable until it fits (headers may have emptied).
  let out = render(chosen);
  while (estimateTokens(out.context) > budget && chosen.length > 0) {
    const weakest = chosen.reduce((w, c) => (c.value < w.value ? c : w));
    chosen.splice(chosen.indexOf(weakest), 1);
    out = render(chosen);
  }
  const inside = new Set(out.ids);
  return {
    ...out,
    tokens: out.context === '' ? 0 : estimateTokens(out.context),
    budget,
    dropped: items.filter((i) => !inside.has(i.id)).map((i) => i.id),
    compressed: chosen.filter((c) => c.text !== c.item.text).map((c) => c.item.id),
  };
}
