export interface Packed {
  readonly ids: string[];
  readonly context: string;
  readonly tokens: number;
}

/** Rough tokens of a text (~4 characters each); a tokenizer-exact count comes with phase 6 packing. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Simple packing (PLAN 12.4 stage 9): one `- text` line per item, best first,
 * skipping items that no longer fit the budget. Items are never cut.
 */
export function pack(items: ReadonlyArray<{ id: string; text: string }>, budget: number): Packed {
  const lines: string[] = [];
  const ids: string[] = [];
  let tokens = 0;
  for (const item of items) {
    const line = `- ${item.text}`;
    const cost = estimateTokens(line);
    if (tokens + cost > budget) continue;
    lines.push(line);
    ids.push(item.id);
    tokens += cost;
  }
  return { ids, context: lines.join('\n'), tokens };
}
