# @mindlog/rules

The filter and access-rule language of full-stack collections (PLAN 16.3, ADR-0018). It is PocketBase's filter syntax with PocketBase's semantics, evaluated over records instead of compiled to SQL. Pure code: schemas and records come in through ports.

## Public API

- **`parseRule(source)`** → `Result<Expr, RuleIssue>`: lexer and recursive-descent parser. `&&` binds tighter than `||`; `//` comments; issues carry `{from, to}` offsets. `ParseCache` keeps 500 parsed sources. `printRule` prints a tree back to source.
- **`checkRule(expr, {collection, schema, allowHidden})`** → `RuleIssue[]`: fields, relation paths, `@request.*` sections, `@collection` names, modifiers, macros and function arity against a `SchemaView`.
- **`completeRule(source, cursor, collection, schema)`**: suggestions for the dashboard rule editor (fields, relation paths, `@request.*`, collections, macros, functions, modifiers).
- **`evaluateRule(expr, input)`** → `Result<boolean, RuleIssue>`: async, against a `RecordResolver` (`byIds`, `rows`) for relation hops and `@collection` joins.
- **`planScan(expr, indexes, input)`** → `ScanPlan`: `ids` for `id = …`, else the index covering the most leading equalities (then range bounds) of the top-level conjuncts, else a full scan. The rule is always re-evaluated on candidates.

## Semantics (ADR-0018)

- `null`, missing and `''` are equal; ordering operators are false against `null`.
- `~` is a case-insensitive contains, or a LIKE pattern when the right side has `%`.
- Multi-valued operands (multi relation/select/file, `:each`, plain operators on `@collection`): a plain operator needs every value to match, a `?` operator any. An empty list is one `null`.
- Each `@collection` alias binds one row for the whole expression (SQL `LEFT JOIN … WHERE`); top-level `?=` conjuncts narrow its candidate rows.
- `geoDistance` matches when any combination of its inputs does.

## Invariants

- The planner's candidates always contain every match (property test against a full scan).
- The parser never throws on any input and round-trips printed trees (grammar fuzzer).
- Bounds: 200 comparisons, depth 32, 6 relation hops, 1,000 rows per alias, 10,000 alias bindings.

## Metrics

None; callers count evaluations and scanned rows.
