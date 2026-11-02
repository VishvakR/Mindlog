import type { RememberInput, ToolTrace } from '../types.js';

/** Characters of a tool's arguments or result kept, so a trace stays one passage (PLAN 13.11). */
export const TRACE_PART_CHARS = 500;

function part(value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > TRACE_PART_CHARS
    ? `${text.slice(0, TRACE_PART_CHARS)}… (${String(text.length - TRACE_PART_CHARS)} more characters)`
    : text;
}

/** The text a tool trace is stored as: tool, outcome, then truncated arguments and result. */
export function traceText(t: ToolTrace): string {
  const lines = [`Tool ${t.tool} ${t.success ? 'succeeded' : 'failed'}.`];
  const args = part(t.args);
  const result = part(t.result);
  if (args) lines.push(`Arguments: ${args}`);
  if (result) lines.push(`Result: ${result}`);
  return lines.join('\n');
}

/**
 * A remember of a tool trace as the pipeline takes it: stored verbatim as
 * `tool_trace`, from the agent that ran it (`ref` names the tool).
 */
export function fromToolTrace(input: RememberInput): RememberInput {
  const t = input.toolTrace;
  if (!t) return input;
  return {
    ...input,
    content: traceText(t),
    kind: 'tool_trace',
    source: input.source ?? { type: 'agent', ref: `tool:${t.tool}` },
    tags: [...(input.tags ?? []), `tool:${t.tool}`, t.success ? 'success' : 'failure'],
  };
}
