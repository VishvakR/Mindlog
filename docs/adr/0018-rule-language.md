# ADR-0018: Rule language compatible with the PocketBase filter syntax

- Status: accepted
- Date: 2026-11-03
- PLAN: 16.3 (rules engine), 16.6 (realtime filtering), 22 (fuzzing, property tests)
- References: pocketbase.md (`tools/search/filter.go`, `identifier_macros.go`, `token_functions.go`, `core/record_field_resolver*.go`)

## Context

Collections need per-slot access rules (`listRule`, `viewRule`, `createRule`, `updateRule`, `deleteRule`, `manageRule`) and list filters. PocketBase's filter syntax is well known, documented and supported by its JS SDK. PocketBase compiles a filter to SQL; Mindlog has no SQL engine, so rules must be evaluated against records in LevelDB, and lists must use our own indexes.

## Decision

- **Syntax** is PocketBase's: `&&`, `||`, parentheses, `//` comments, the operators `= != > >= < <= ~ !~` and their `?`-prefixed "any" forms, single- or double-quoted strings, numbers, `true false null`, identifiers with `.` paths, the modifiers `:isset :changed :length :each :lower`, `@request.{auth,body,query,headers,method,context}.*`, `@collection.<name>[:alias].<path>`, the date macros (`@now`, `@todayStart`, …, `@second` … `@year`) and the functions `geoDistance` and `strftime`.
- **Semantics** follow PocketBase where they are observable:
  - `null` and `""` compare equal (PocketBase's null fallback); missing fields read as `null`.
  - `~` is a case-insensitive "contains"; if the right side has `%`, it is a LIKE pattern.
  - On a multi-valued operand (multi relation, multi select, file list, `:each`), a plain operator must hold for **every** value; a `?` operator for **any** value. An empty list is treated as one `null`.
  - Every `@collection` alias is bound to one row existentially for the whole expression, as SQL's `LEFT JOIN … WHERE` does, so `@collection.m.user ?= @request.auth.id && @collection.m.team ?= id` talks about one membership row. A collection with no rows binds a `null` row.
- **Pipeline**, in `@mindlog/rules` (pure, depends on core only): lexer → parser (AST with source positions) → checker (against a `SchemaView` port; errors and completions with positions) → planner (index choice, residual filter, `@collection` row hints) → evaluator (async, against a `RecordResolver` port). Parsed ASTs are cached by source text (bounded, 500 entries).
- **Bounds**: at most 200 comparisons per expression, at most 6 relation hops, at most 1,000 candidate rows per `@collection` alias (the planner narrows them with equality hints); exceeding a bound is `INVALID_ARGUMENT`.

## Alternatives considered

- **Compile to a query over a SQL engine (SQLite)**: a second storage engine beside the replicated LevelDB state; rejected.
- **A new rule language (CEL, Rego)**: more expressive, but loses PocketBase SDK and user familiarity, and the dashboard editor would have to teach it.
- **Bind `@collection` aliases per comparison**: simpler, but `a ?= x && b ?= y` would then match two different rows, unlike PocketBase.

## Consequences

- Rules work identically for REST, realtime filtering and delegated agents.
- The evaluator is a tree walk; a list without a usable index is a capped scan. `mindlog_rules_scan_rows` and the planner's chosen index are exposed in the explain output.
- Property tests check that the planner's results equal a naive full scan; a grammar fuzzer checks the parser never throws and round-trips.
