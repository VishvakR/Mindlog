import type { MessageInitShape } from '@bufbuild/protobuf';
import { create } from '@bufbuild/protobuf';
import type { MindlogErrorCode } from '@mindlog/core';
import type { KvReply } from '@mindlog/proto';
import { KvReplySchema } from '@mindlog/proto';

type KindInit = NonNullable<MessageInitShape<typeof KvReplySchema>['kind']>;

const reply = (kind: KindInit): KvReply => create(KvReplySchema, { kind });

export const nil = (): KvReply => reply({ case: 'null', value: {} });
export const ok = (): KvReply => reply({ case: 'simple', value: 'OK' });
export const simple = (value: string): KvReply => reply({ case: 'simple', value });
export const integer = (value: bigint | number): KvReply =>
  reply({ case: 'integer', value: BigInt(value) });
export const bulk = (value: Uint8Array): KvReply => reply({ case: 'bulk', value });
export const double = (value: number): KvReply => reply({ case: 'double', value });
export const array = (items: KvReply[]): KvReply => reply({ case: 'array', value: { items } });
export const set = (items: KvReply[]): KvReply => reply({ case: 'set', value: { items } });
/** [element, score] pairs: nested in RESP3, flattened in RESP2. */
export const pairs = (items: (readonly [KvReply, KvReply])[]): KvReply =>
  reply({ case: 'array', value: { items: items.map(([a, b]) => array([a, b])), pairs: true } });
export const map = (entries: (readonly [KvReply, KvReply])[]): KvReply =>
  reply({ case: 'map', value: { entries: entries.map(([key, value]) => ({ key, value })) } });

export const error = (code: MindlogErrorCode, message: string): KvReply =>
  reply({ case: 'error', value: { code, message, fields: {}, retryable: false } });

/** Valkey's shared error replies (server.c createSharedObjects). */
export const errors = {
  wrongType: () => error('WRONG_TYPE', 'Operation against a key holding the wrong kind of value'),
  syntax: () => error('INVALID_ARGUMENT', 'syntax error'),
  notInteger: () => error('INVALID_ARGUMENT', 'value is not an integer or out of range'),
  notFloat: () => error('INVALID_ARGUMENT', 'value is not a valid float'),
  overflow: () => error('INVALID_ARGUMENT', 'increment or decrement would overflow'),
  noSuchKey: () => error('INVALID_ARGUMENT', 'no such key'),
  indexOutOfRange: () => error('INVALID_ARGUMENT', 'index out of range'),
  arity: (name: string) =>
    error('INVALID_ARGUMENT', `wrong number of arguments for '${name.toLowerCase()}' command`),
};

export const isError = (r: KvReply): boolean => r.kind.case === 'error';
