/** RESP2/RESP3 for the console: encode commands, decode replies, format like redis-cli. */

export type Reply =
  | { kind: 'simple'; value: string }
  | { kind: 'error'; value: string }
  | { kind: 'integer'; value: string }
  | { kind: 'bulk'; value: string }
  | { kind: 'verbatim'; value: string }
  | { kind: 'double'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'array' | 'set' | 'push'; items: Reply[] }
  | { kind: 'map'; entries: [Reply, Reply][] };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One multibulk frame for `args`. */
export function encodeCommand(args: readonly string[]): Uint8Array<ArrayBuffer> {
  const parts = args.map((a) => encoder.encode(a));
  const head = `*${String(parts.length)}\r\n`;
  const chunks: Uint8Array[] = [encoder.encode(head)];
  for (const p of parts)
    chunks.push(encoder.encode(`$${String(p.length)}\r\n`), p, encoder.encode('\r\n'));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Splits a console line into arguments like redis-cli: whitespace separates,
 * "double quotes" take \n \r \t \" \\ \xHH escapes, 'single quotes' are literal.
 * Returns null for an unterminated quote.
 */
export function splitArgs(line: string): string[] | null {
  const args: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i] ?? '')) i++;
    if (i >= line.length) break;
    let arg = '';
    const quote = line[i];
    if (quote === '"' || quote === "'") {
      i++;
      let closed = false;
      while (i < line.length) {
        const c = line[i] ?? '';
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        if (quote === '"' && c === '\\' && i + 1 < line.length) {
          const n = line[i + 1] ?? '';
          const hex = line.slice(i + 2, i + 4);
          if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(hex)) {
            arg += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            continue;
          }
          arg +=
            ({ n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' } as Record<string, string>)[n] ?? n;
          i += 2;
          continue;
        }
        arg += c;
        i++;
      }
      if (!closed) return null;
      if (i < line.length && !/\s/.test(line[i] ?? '')) return null;
    } else {
      while (i < line.length && !/\s/.test(line[i] ?? '')) arg += line[i++];
    }
    args.push(arg);
  }
  return args;
}

const CRLF = 0x0d;

/** Incremental decoder: push bytes, take complete replies. */
export class ReplyDecoder {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Reply[] {
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.length);
    this.#buffer = merged;
    const out: Reply[] = [];
    for (;;) {
      const parsed = parse(this.#buffer, 0);
      if (!parsed) break;
      out.push(parsed.reply);
      this.#buffer = this.#buffer.slice(parsed.next);
    }
    return out;
  }
}

function line(buf: Uint8Array, at: number): { text: string; next: number } | undefined {
  for (let i = at; i + 1 < buf.length; i++) {
    if (buf[i] === CRLF && buf[i + 1] === 0x0a)
      return { text: decoder.decode(buf.subarray(at, i)), next: i + 2 };
  }
  return undefined;
}

function many(
  buf: Uint8Array,
  at: number,
  count: number,
): { items: Reply[]; next: number } | undefined {
  const items: Reply[] = [];
  let next = at;
  for (let i = 0; i < count; i++) {
    const r = parse(buf, next);
    if (!r) return undefined;
    items.push(r.reply);
    next = r.next;
  }
  return { items, next };
}

function parse(buf: Uint8Array, at: number): { reply: Reply; next: number } | undefined {
  if (at >= buf.length) return undefined;
  const type = String.fromCharCode(buf[at] ?? 0);
  const head = line(buf, at + 1);
  if (!head) return undefined;
  const { text, next } = head;
  switch (type) {
    case '+':
      return { reply: { kind: 'simple', value: text }, next };
    case '-':
    case '!':
      return type === '-'
        ? { reply: { kind: 'error', value: text }, next }
        : blob(buf, next, Number(text), 'error');
    case ':':
    case '(':
      return { reply: { kind: 'integer', value: text }, next };
    case ',':
      return { reply: { kind: 'double', value: text }, next };
    case '#':
      return { reply: { kind: 'boolean', value: text === 't' }, next };
    case '_':
      return { reply: { kind: 'null' }, next };
    case '$':
      return Number(text) < 0
        ? { reply: { kind: 'null' }, next }
        : blob(buf, next, Number(text), 'bulk');
    case '=':
      return blob(buf, next, Number(text), 'verbatim');
    case '*':
    case '~':
    case '>': {
      if (Number(text) < 0) return { reply: { kind: 'null' }, next };
      const r = many(buf, next, Number(text));
      if (!r) return undefined;
      const kind = type === '*' ? 'array' : type === '~' ? 'set' : 'push';
      return { reply: { kind, items: r.items }, next: r.next };
    }
    case '%':
    case '|': {
      const r = many(buf, next, Number(text) * 2);
      if (!r) return undefined;
      const entries: [Reply, Reply][] = [];
      for (let i = 0; i + 1 < r.items.length; i += 2)
        entries.push([r.items[i] as Reply, r.items[i + 1] as Reply]);
      if (type === '|') return parse(buf, r.next); // attributes annotate the next reply; the console skips them
      return { reply: { kind: 'map', entries }, next: r.next };
    }
    default:
      return {
        reply: { kind: 'error', value: `protocol error: unexpected '${type}'` },
        next: buf.length,
      };
  }
}

function blob(buf: Uint8Array, at: number, length: number, kind: 'bulk' | 'verbatim' | 'error') {
  if (at + length + 2 > buf.length) return undefined;
  let value = decoder.decode(buf.subarray(at, at + length));
  if (kind === 'verbatim') value = value.slice(4); // drop the "txt:" format prefix
  return { reply: { kind, value } as Reply, next: at + length + 2 };
}

// Control characters are escaped on purpose, as redis-cli prints them.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/g;
const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

const quote = (s: string) =>
  `"${s
    .replace(/[\\"]/g, (c) => `\\${c}`)
    .replace(CONTROL, (c) => NAMED[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}"`;

/** The reply as redis-cli prints it, one string per line. */
export function formatReply(reply: Reply): string[] {
  switch (reply.kind) {
    case 'simple':
      return [reply.value];
    case 'error':
      return [`(error) ${reply.value}`];
    case 'integer':
      return [`(integer) ${reply.value}`];
    case 'bulk':
      return [quote(reply.value)];
    case 'verbatim':
      return reply.value.split('\n');
    case 'double':
      return [`(double) ${reply.value}`];
    case 'boolean':
      return [reply.value ? '(true)' : '(false)'];
    case 'null':
      return ['(nil)'];
    case 'array':
    case 'set':
    case 'push':
      return numbered(
        reply.items.map((r) => formatReply(r)),
        reply.kind === 'set' ? '~' : ')',
        reply.kind === 'set' ? '(empty set)' : '(empty array)',
      );
    case 'map':
      return numbered(
        reply.entries.map(([k, v]) => {
          const key = formatReply(k);
          const value = formatReply(v);
          return [
            ...key.slice(0, -1),
            `${key[key.length - 1] ?? ''} => ${value[0] ?? ''}`,
            ...value.slice(1),
          ];
        }),
        '#',
        '(empty hash)',
      );
  }
}

function numbered(items: string[][], mark: string, empty: string): string[] {
  if (items.length === 0) return [empty];
  const width = String(items.length).length;
  return items.flatMap((lines, i) => {
    const prefix = `${String(i + 1).padStart(width)}${mark} `;
    const pad = ' '.repeat(prefix.length);
    return lines.map((l, j) => (j === 0 ? prefix : pad) + l);
  });
}
