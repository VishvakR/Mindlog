import { create, fromBinary } from '@bufbuild/protobuf';
import type { MindlogErrorCode } from '@mindlog/core';
import { mindlogError, toErrorDetail } from '@mindlog/core';
import type { CommandResult, StoredSchema } from '@mindlog/proto';
import { CommandResultSchema, ErrorDetailSchema, StoredSchemaSchema } from '@mindlog/proto';
import type { ApplyContext } from '@mindlog/statemachine';
import { errorResult, inSpan } from '@mindlog/statemachine';
import { collectionKey, schemaKey } from '../keys.js';
import type { CollectionSchema } from '../schema/collection-schema.js';
import { collectionSchema } from '../schema/collection-schema.js';

export function recordOutcome(ids: string[], versions: bigint[]): CommandResult {
  return create(CommandResultSchema, { outcome: { case: 'record', value: { ids, versions } } });
}

/** An error result with per-field messages (PocketBase-style validation data). */
export function fieldErrors(
  code: MindlogErrorCode,
  message: string,
  fields: Record<string, string>,
): CommandResult {
  const detail = toErrorDetail(mindlogError(code, message, { fields }));
  return create(CommandResultSchema, {
    outcome: { case: 'error', value: create(ErrorDetailSchema, detail) },
  });
}

export function outsideRange(ctx: ApplyContext, collection: string): CommandResult | undefined {
  return inSpan(ctx.descriptor, collectionKey(ctx.command.tenant, collection))
    ? undefined
    : errorResult('RANGE_MOVED', `collection is not in range ${String(ctx.descriptor.rangeId)}`);
}

export interface LoadedSchema {
  readonly schema: CollectionSchema;
  readonly version: bigint;
}

/** Decodes a stored schema; stored schemas were validated when written. */
export function decodeSchema(bytes: Uint8Array): LoadedSchema {
  const stored: StoredSchema = fromBinary(StoredSchemaSchema, bytes);
  const schema = collectionSchema.parse(JSON.parse(new TextDecoder().decode(stored.schema)));
  return { schema, version: stored.version };
}

export async function loadSchema(
  get: (key: Uint8Array) => Promise<Uint8Array | undefined>,
  tenant: string,
  collection: string,
): Promise<LoadedSchema | undefined> {
  const bytes = await get(schemaKey(tenant, collection));
  return bytes === undefined ? undefined : decodeSchema(bytes);
}
