---
description: The filter and access-rule language, compatible with PocketBase's syntax.
---

# Rules

Each collection has five rule slots, plus a sixth for auth collections. A rule is an expression in the same language as the `filter` query parameter, evaluated **as the caller**.

| Slot | Guards | When the rule does not match |
|---|---|---|
| `listRule` | `GET …/records`, realtime list events | The record is simply left out |
| `viewRule` | `GET …/records/:id`, `expand`, realtime events | 404 |
| `createRule` | `POST …/records` | 400 |
| `updateRule` | `PATCH …/records/:id` | 404 |
| `deleteRule` | `DELETE …/records/:id` | 404 |
| `manageRule` (auth only) | Changing other users' auth fields | 403 |

| Value | Meaning |
|---|---|
| `null` (the default) | Locked: superusers only (403 for everyone else) |
| `""` | Anyone, including anonymous callers |
| An expression | Allowed when it matches |

## Syntax

```
@request.auth.id != '' && user = @request.auth.id
status = 'published' || author = @request.auth.id   // comments are allowed
tags ?= 'urgent'
title ~ 'milk%'
@request.body.user:changed = false
created >= @todayStart
```

| Element | Forms |
|---|---|
| Operators | `=` `!=` `>` `>=` `<` `<=` `~` (contains / LIKE) `!~`, and the "any" forms `?=` `?!=` `?>` `?>=` `?<` `?<=` `?~` `?!~` |
| Logic | `&&` (binds tighter), `\|\|`, parentheses |
| Literals | `'text'` or `"text"`, numbers, `true`, `false`, `null` |
| Record fields | `title`, and relation paths `user.team.name` (up to 6 hops) |
| Request | `@request.auth.<field>` (the signed-in user), `@request.body.<field>`, `@request.query.<name>`, `@request.headers.<name>`, `@request.method`, `@request.context` |
| Other collections | `@collection.<name>.<field>`, with an alias: `@collection.members:m.user` |
| Modifiers | `:isset` (body, query, headers), `:changed` (body), `:length`, `:each`, `:lower` |
| Date macros (UTC) | `@now` `@yesterday` `@tomorrow` `@todayStart` `@todayEnd` `@monthStart` `@monthEnd` `@yearStart` `@yearEnd` `@second` `@minute` `@hour` `@day` `@weekday` `@month` `@year` |
| Functions | `geoDistance(lonA, latA, lonB, latB)` (km), `strftime(format, date)` |

## Semantics

* `null`, a missing value and `''` are equal. Ordering operators against `null` are false.
* `~` is a case-insensitive "contains", or a SQL `LIKE` pattern when the right side contains `%`.
* With multi-valued operands (multi-select, multi-relation, `:each`, `@collection`), a plain operator needs **every** value to match, and a `?` operator needs **any**.
* Each `@collection` alias binds one row for the whole expression, like a SQL `LEFT JOIN … WHERE`.

## Recipes

| Goal | Rule |
|---|---|
| Signed-in users only | `@request.auth.id != ''` |
| Owner only | `user = @request.auth.id` |
| Owner sets themselves as owner on create | `@request.body.user = @request.auth.id` |
| Owner cannot be changed | `@request.body.user:changed = false` |
| Team members | `@collection.members.team ?= team && @collection.members.user ?= @request.auth.id` |
| Published, or my drafts | `status = 'published' \|\| author = @request.auth.id` |
| Verified users only | `@request.auth.verified = true` |
| Nearby | `geoDistance(location.lon, location.lat, 13.4, 52.5) < 10` |

## Checking a rule

`POST /api/collections/rules/check` (superuser) parses and type-checks a rule against the schema and returns issues with character offsets. The dashboard rule editor uses it and offers completion for fields, relation paths, `@request.*`, collections, macros and functions.

## Bounds

At most 200 comparisons and nesting depth 32, 6 relation hops, 1,000 rows per `@collection` alias. Queries use an index when the top-level `&&` terms allow it; the rule is always re-checked on every candidate.
