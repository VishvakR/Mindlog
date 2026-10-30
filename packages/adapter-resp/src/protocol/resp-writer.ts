import type { MindlogErrorCode } from '@mindlog/core';
import { ERROR_CODES } from '@mindlog/core';
import { formatDouble } from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';

export type ProtocolVersion = 2 | 3;

const INITIAL_BYTES = 4096;

const respPrefix = (code: string): string =>
  code in ERROR_CODES ? ERROR_CODES[code as MindlogErrorCode].resp : 'ERR';

/** Simple strings and errors are one line: CR and LF become spaces (Valkey addReplyError). */
const oneLine = (text: string): string => text.replace(/[\r\n]/g, ' ');

const resp3Double = (value: number): string => (Number.isNaN(value) ? 'nan' : formatDouble(value));

/**
 * Serialises `KvReply` values as RESP3, or downgrades them to RESP2 the way
 * Valkey does: maps become flat arrays, sets arrays, doubles bulk strings,
 * booleans integers and null `$-1`. Replies accumulate in one growing buffer
 * so a pipeline's replies leave in a single socket write.
 */
export class RespWriter {
  #buf: Buffer = Buffer.allocUnsafe(INITIAL_BYTES);
  #len = 0;

  /** Bytes written and not yet taken. */
  get length(): number {
    return this.#len;
  }

  write(reply: KvReply, protocol: ProtocolVersion): void {
    const kind = reply.kind;
    switch (kind.case) {
      case 'null':
        this.#ascii(protocol === 3 ? '_\r\n' : '$-1\r\n');
        return;
      case 'integer':
        this.#ascii(`:${kind.value.toString()}\r\n`);
        return;
      case 'bulk':
        this.#bulk(kind.value);
        return;
      case 'simple':
        this.#ascii('+');
        this.#text(oneLine(kind.value));
        this.#ascii('\r\n');
        return;
      case 'double':
        if (protocol === 3) this.#ascii(`,${resp3Double(kind.value)}\r\n`);
        else this.#bulk(Buffer.from(formatDouble(kind.value), 'latin1'));
        return;
      case 'boolean':
        this.#ascii(
          protocol === 3 ? (kind.value ? '#t\r\n' : '#f\r\n') : kind.value ? ':1\r\n' : ':0\r\n',
        );
        return;
      case 'array':
      case 'set':
        this.#list(kind.case, kind.value.items, kind.value.pairs, protocol);
        return;
      case 'map':
        this.#ascii(
          `${protocol === 3 ? '%' : '*'}${kind.value.entries.length * (protocol === 3 ? 1 : 2)}\r\n`,
        );
        for (const entry of kind.value.entries) {
          this.#optional(entry.key, protocol);
          this.#optional(entry.value, protocol);
        }
        return;
      case 'error':
        this.writeError(kind.value.code, kind.value.message);
        return;
      case undefined:
        this.#ascii(protocol === 3 ? '_\r\n' : '$-1\r\n');
        return;
    }
  }

  /** `-PREFIX message`, the prefix from the error table (CLAUDE.md §9). */
  writeError(code: string, message: string): void {
    this.#ascii(`-${respPrefix(code)} `);
    this.#text(oneLine(message));
    this.#ascii('\r\n');
  }

  /** An out-of-band push (`>` in RESP3, an array in RESP2 as for pub/sub messages). */
  writePush(items: readonly KvReply[], protocol: ProtocolVersion): void {
    this.#ascii(`${protocol === 3 ? '>' : '*'}${String(items.length)}\r\n`);
    for (const item of items) this.write(item, protocol);
  }

  /** Returns the bytes written so far and starts a new buffer. */
  take(): Buffer {
    const out = Buffer.from(this.#buf.subarray(0, this.#len));
    this.#len = 0;
    if (this.#buf.length > INITIAL_BYTES * 16) this.#buf = Buffer.allocUnsafe(INITIAL_BYTES);
    return out;
  }

  #list(
    kind: 'array' | 'set',
    items: readonly KvReply[],
    pairs: boolean,
    protocol: ProtocolVersion,
  ): void {
    if (pairs && protocol === 2) {
      let count = 0;
      for (const item of items)
        count += item.kind.case === 'array' ? item.kind.value.items.length : 1;
      this.#ascii(`*${count}\r\n`);
      for (const item of items) {
        if (item.kind.case === 'array')
          for (const inner of item.kind.value.items) this.write(inner, 2);
        else this.write(item, 2);
      }
      return;
    }
    this.#ascii(`${kind === 'set' && protocol === 3 ? '~' : '*'}${items.length}\r\n`);
    for (const item of items) this.write(item, protocol);
  }

  #optional(reply: KvReply | undefined, protocol: ProtocolVersion): void {
    if (reply) this.write(reply, protocol);
    else this.#ascii(protocol === 3 ? '_\r\n' : '$-1\r\n');
  }

  #bulk(bytes: Uint8Array): void {
    this.#ascii(`$${bytes.length}\r\n`);
    this.#reserve(bytes.length + 2);
    this.#buf.set(bytes, this.#len);
    this.#len += bytes.length;
    this.#ascii('\r\n');
  }

  #ascii(text: string): void {
    this.#reserve(text.length);
    this.#len += this.#buf.write(text, this.#len, 'latin1');
  }

  #text(text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8');
    this.#reserve(bytes);
    this.#len += this.#buf.write(text, this.#len, 'utf8');
  }

  #reserve(extra: number): void {
    const needed = this.#len + extra;
    if (needed <= this.#buf.length) return;
    let size = this.#buf.length * 2;
    while (size < needed) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.#buf.copy(next, 0, 0, this.#len);
    this.#buf = next;
  }
}
