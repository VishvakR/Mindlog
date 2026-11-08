# @mindlog/collections

Full-stack collections (PLAN 16, ADR-0034): PocketBase-style schemas and records, replicated through Raft. This package owns the schema model, the field types and the two commands. Rules live in `@mindlog/rules`; requests, auth and rule enforcement live in `@mindlog/services`.

## Public API

- **Schemas**: `collectionSchema` (Zod) and `parseSchema`, `checkSchema`. Types are `base`, `auth` and `view`. Fields are `text number bool email url editor date autodate select file relation json geoPoint password vector memory`; `maxSelect > 1` makes select, file and relation multi-valued. Indexes may be unique. Rule slots: `listRule viewRule createRule updateRule deleteRule` (+ `manageRule` for auth).
- **Field types** are plugins (`FieldSpec`: `zero`, `normalize`, `validate`), one per type, in a registry (`specOf`, `fieldNormalize`, `fieldValidate`, `fieldZero`). `normalize` runs on the leader (form text to typed values); `validate` also runs in apply. `editor` HTML goes through an allow-list sanitizer whose output is canonical.
- **Keys** (`keys.ts`): `c/(coll,'s')` schema, `c/(coll,'r',id)` records, `c/(coll,'x',index,…values,id)` index rows, `c/(coll,'u',index,…values)` unique claims, `c/(coll,'j',…)` jobs (`collectionScope` in `@mindlog/jobs`).
- **Apply handlers**:
  - `recordWriteHandler` (`RecordWrite`, body 50): up to 100 ops on one collection, all or nothing. Creates, updates (fenced by `expect_version`), deletes, and upserts (view rows only). It fills zero values, validates every field, maintains index rows, and refuses a unique value another record holds. It may finish the job that produced it and enqueue jobs.
  - `schemaChangeHandler` (`SchemaChange`, body 51): create (`expect_version = 0`), replace or delete, fenced by version. Index or field changes rewrite every record (up to 10,000; larger is refused) and fail if existing records break a new unique index.
- **Views** (`computeView`, `checkView`): a join, group and select over other collections, materialized as ordinary rows; row ids hash the group key.
- **Cron** (`parseCron`, `nextFire`): five UTC fields with `* , - /`.
- **Auth collections** add `email` (unique when not empty), `emailVisibility`, `verified`, `password` (argon2id PHC string, hashed on the leader) and `tokenKey`.

## Invariants

- Apply is deterministic: no clock (times are `cmd.hlc`), no models (vectors are computed before proposing), no reads outside the collection's range.
- Writes are staged and flushed only when every op passed, because apply flushes the transaction even for an error result.
- Unique claims and index rows always match the records (simulator `SIM_COLL=1`).

## Metrics

None in apply; the collection service counts requests, rule checks and scans.
