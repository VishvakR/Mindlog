import { splitInline } from './inline-args.js';

export interface ParserLimits {
  /** Largest bulk string accepted (Valkey proto-max-bulk-len). */
  readonly maxBulkBytes: number;
  /** Largest inline request or header line (Valkey: 64 KiB). */
  readonly maxInlineBytes: number;
  /** Most arguments in one multibulk request. */
  readonly maxArgs: number;
}

export type ParseEvent =
  | { readonly kind: 'command'; readonly argv: Uint8Array[] }
  | { readonly kind: 'error'; readonly message: string };

export const DEFAULT_LIMITS: ParserLimits = {
  maxBulkBytes: 512 * 1024 * 1024,
  maxInlineBytes: 64 * 1024,
  maxArgs: 1024 * 1024,
};

const CR = 0x0d;
const LF = 0x0a;
const STAR = 0x2a;
const DOLLAR = 0x24;

/**
 * Incremental parser for client requests: RESP multibulk arrays of bulk
 * strings plus inline commands (Valkey `processMultibulkBuffer` and
 * `processInlineBuffer`). Partial frames are kept between pushes with their
 * parse state, so a frame split anywhere never re-scans earlier bytes; large
 * bulks are buffered and concatenated once. After a protocol error the parser
 * stops, and the connection should be closed.
 */
export class RespParser {
  readonly #limits: ParserLimits;
  #buf: Buffer = Buffer.alloc(0);
  #pos = 0;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  /** Arguments of the multibulk request in progress, and how many are missing. */
  #args: Uint8Array[] | undefined;
  #remaining = 0;
  /** Length of the bulk string being read, or -1. */
  #bulkLen = -1;
  #failed = false;

  constructor(limits: ParserLimits = DEFAULT_LIMITS) {
    this.#limits = limits;
  }

  push(chunk: Buffer): ParseEvent[] {
    if (this.#failed || chunk.length === 0) return [];
    if (this.#bulkLen >= 0) {
      const needed = this.#bulkLen + 2 - (this.#buf.length - this.#pos);
      if (this.#pendingBytes + chunk.length < needed) {
        this.#pending.push(chunk);
        this.#pendingBytes += chunk.length;
        return [];
      }
    }
    const rest = this.#buf.subarray(this.#pos);
    this.#buf =
      rest.length === 0 && this.#pending.length === 0
        ? chunk
        : Buffer.concat([rest, ...this.#pending, chunk]);
    this.#pos = 0;
    this.#pending = [];
    this.#pendingBytes = 0;
    return this.#parse();
  }

  #parse(): ParseEvent[] {
    const events: ParseEvent[] = [];
    for (;;) {
      const event = this.#args ? this.#readBulks() : this.#readRequest();
      if (event === undefined) break;
      events.push(event);
      if (event.kind === 'error') {
        this.#failed = true;
        break;
      }
    }
    return events;
  }

  #fail(message: string): ParseEvent {
    return { kind: 'error', message: `Protocol error: ${message}` };
  }

  /** Index of the CR of the next CRLF from `from`, or -1. */
  #lineEnd(from: number): number {
    const lf = this.#buf.indexOf(LF, from);
    return lf > from && this.#buf[lf - 1] === CR ? lf - 1 : lf < 0 ? -1 : lf;
  }

  #readRequest(): ParseEvent | undefined {
    while (this.#pos < this.#buf.length) {
      if (this.#buf[this.#pos] !== STAR) return this.#readInline();
      const end = this.#lineEnd(this.#pos);
      if (end < 0) {
        if (this.#buf.length - this.#pos > this.#limits.maxInlineBytes) {
          return this.#fail('too big mbulk count string');
        }
        return undefined;
      }
      const count = Number(this.#buf.toString('latin1', this.#pos + 1, end));
      this.#pos = end + 2;
      if (!Number.isInteger(count) || count > this.#limits.maxArgs) {
        return this.#fail('invalid multibulk length');
      }
      if (count <= 0) continue;
      this.#args = [];
      this.#remaining = count;
      return this.#readBulks();
    }
    return undefined;
  }

  #readBulks(): ParseEvent | undefined {
    const args = this.#args as Uint8Array[];
    while (this.#remaining > 0) {
      if (this.#bulkLen < 0) {
        if (this.#pos >= this.#buf.length) return undefined;
        if (this.#buf[this.#pos] !== DOLLAR) {
          return this.#fail(
            `expected '$', got '${String.fromCharCode(this.#buf[this.#pos] ?? 0)}'`,
          );
        }
        const end = this.#lineEnd(this.#pos);
        if (end < 0) {
          if (this.#buf.length - this.#pos > this.#limits.maxInlineBytes) {
            return this.#fail('too big bulk count string');
          }
          return undefined;
        }
        const length = Number(this.#buf.toString('latin1', this.#pos + 1, end));
        if (!Number.isInteger(length) || length < 0 || length > this.#limits.maxBulkBytes) {
          return this.#fail('invalid bulk length');
        }
        this.#bulkLen = length;
        this.#pos = end + 2;
      }
      if (this.#buf.length - this.#pos < this.#bulkLen + 2) return undefined;
      args.push(Uint8Array.prototype.slice.call(this.#buf, this.#pos, this.#pos + this.#bulkLen));
      this.#pos += this.#bulkLen + 2;
      this.#bulkLen = -1;
      this.#remaining--;
    }
    this.#args = undefined;
    return { kind: 'command', argv: args.map((a) => new Uint8Array(a)) };
  }

  #readInline(): ParseEvent | undefined {
    const lf = this.#buf.indexOf(LF, this.#pos);
    if (lf < 0) {
      if (this.#buf.length - this.#pos > this.#limits.maxInlineBytes) {
        return this.#fail('too big inline request');
      }
      return undefined;
    }
    const lineEnd = lf > this.#pos && this.#buf[lf - 1] === CR ? lf - 1 : lf;
    const line = this.#buf.subarray(this.#pos, lineEnd);
    this.#pos = lf + 1;
    if (line.includes(0)) return this.#fail('embedded NUL byte in inline request');
    const argv = splitInline(line);
    if (argv === undefined) return this.#fail('unbalanced quotes in request');
    if (argv.length === 0) return this.#readRequest();
    return { kind: 'command', argv };
  }
}
