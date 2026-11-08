/**
 * @mindlog/collections — full-stack collections (PLAN 16, ADR-0034): schemas,
 * field types, and the `RecordWrite` and `SchemaChange` commands.
 */
export type {
  AuthOptions,
  CollectionInput,
  CollectionSchema,
  FieldDef,
  FieldType,
  ViewDef,
} from './schema/collection-schema.js';
export {
  NAME,
  collectionSchema,
  fieldSchema,
  parseSchema,
  viewSchema,
} from './schema/collection-schema.js';
export {
  AUTH_FIELDS,
  SYSTEM_FIELDS,
  checkSchema,
  fieldInfo,
  indexesOf,
  isMulti,
  schemaView,
  storedFields,
} from './schema/system-fields.js';
export type { FieldSpec } from './fields/field-spec.js';
export { fieldNormalize, fieldValidate, fieldZero, specOf } from './fields/registry.js';
export { FILE_NAME, RECORD_ID } from './fields/list-fields.js';
export { sanitizeHtml } from './fields/sanitize-html.js';
export { normalizeDate } from './fields/text-fields.js';
export { checkView, computeView, viewSources } from './view.js';
export type { IndexEntry, RecordFields, RecordMeta } from './record-data.js';
export { completeRecord, indexEntries } from './record-data.js';
export {
  collectionKey,
  collectionsPrefix,
  indexPrefix,
  indexRowKey,
  recordKey,
  recordPrefix,
  schemaKey,
  uniqueKey,
  uniquePrefix,
} from './keys.js';
export type { DecodedRecord } from './apply/record-rows.js';
export { decodeRecord } from './apply/record-rows.js';
export type { LoadedSchema } from './apply/results.js';
export { decodeSchema, loadSchema } from './apply/results.js';
export { MAX_RECORD_OPS, recordWriteHandler } from './apply/record-write-handler.js';
export { MAX_REWRITE_RECORDS, schemaChangeHandler } from './apply/schema-change-handler.js';
