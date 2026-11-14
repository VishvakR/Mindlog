---
description: Collection schemas, field types, indexes, views, migrations, and the records API.
---

# Collections and records

## Collection types

| Type | Holds |
|---|---|
| `base` | Ordinary records |
| `auth` | Users who can sign in. Adds `email`, `emailVisibility`, `verified`, `password` and `tokenKey` |
| `view` | Read-only rows computed from other collections (below) |

Every record has `id`, `created` and `updated`.

## Defining collections

Collections are created by a superuser through the dashboard **Collections** page, `POST /api/collections`, or **migrations**. A migration is a file in `collections.migrationsDir`; files run in name order when the node starts.

{% code title="migrations/001_todos.ts" %}
```ts
export default async function migrate(m) {
  await m.save({
    name: 'users',
    type: 'auth',
    fields: [{ name: 'name', type: 'text' }],
    listRule: 'id = @request.auth.id',
    viewRule: 'id = @request.auth.id',
    createRule: '',                      // anyone may sign up
    updateRule: 'id = @request.auth.id',
  });
  await m.save({
    name: 'todos',
    fields: [
      { name: 'title', type: 'text', required: true, max: 200 },
      { name: 'done', type: 'bool' },
      { name: 'user', type: 'relation', collection: 'users', required: true, cascadeDelete: true },
      { name: 'attachment', type: 'file', mimeTypes: ['image/png', 'application/pdf'], thumbs: ['96x96'] },
    ],
    indexes: [{ name: 'by_user', fields: ['user'] }],
    listRule: "@request.auth.id != '' && user = @request.auth.id",
    viewRule: "@request.auth.id != '' && user = @request.auth.id",
    createRule: "@request.auth.id != '' && @request.body.user = @request.auth.id",
    updateRule: "@request.auth.id != '' && user = @request.auth.id && @request.body.user:changed = false",
    deleteRule: "@request.auth.id != '' && user = @request.auth.id",
  });
}
```
{% endcode %}

Over HTTP, the same object is the body of `POST /api/collections` (or `PATCH /api/collections/:name`), sent by a superuser with `X-Mindlog-Tenant: <tenant>`.

## Field types

Every field takes `name`, `required` (default false) and `hidden` (default false; hidden fields are never returned or filterable by non-superusers).

| Type | Options | Value |
|---|---|---|
| `text` | `min`, `max` (characters; 0 = no limit), `pattern` (regex) | string |
| `number` | `min`, `max`, `onlyInt` | number |
| `bool` | | boolean |
| `email` | `onlyDomains` | string |
| `url` | | string |
| `editor` | `maxSize` | HTML, sanitized against an allow-list |
| `date` | | ISO date-time |
| `autodate` | `onCreate` (true), `onUpdate` (false) | Set by the server |
| `select` | `values` (required), `maxSelect` | string, or string[] when `maxSelect > 1` |
| `file` | `maxSelect`, `maxSize` (5 MB), `mimeTypes`, `thumbs` (`WxH`, `WxHt/b/f`), `protected` | file name(s) |
| `relation` | `collection` (required), `maxSelect`, `minSelect`, `cascadeDelete` | record id(s) |
| `json` | `maxSize` | any JSON |
| `geoPoint` | | `{lon, lat}` |
| `password` | `min` (8) | Write-only; stored as an argon2id hash |
| `vector` | `source` (a text field), `dimensions` | Embedding of `source`, computed automatically on write |
| `memory` | | The id of an agent memory (a ULID), linking a record to what an agent remembered |

A collection may have up to 200 fields and 20 indexes of up to 4 fields each. `unique: true` makes an index a unique constraint. Changing fields or indexes rewrites every record (up to 10,000), and fails if existing records would break a new unique index.

## View collections

A view is a small JSON pipeline, not SQL. Its rows are materialized as ordinary records and refreshed by jobs when their sources change, so views also produce realtime events.

```json
{
  "name": "todo_stats",
  "type": "view",
  "view": {
    "from": "todos",
    "join": [{ "collection": "users", "on": { "field": "id", "equals": "user" }, "type": "inner" }],
    "group": ["users.id"],
    "select": { "owner": "users.name", "todos": "count(todos.id)" }
  },
  "listRule": "@request.auth.id != ''"
}
```

Up to 3 joins (`left` or `inner`), 5 group keys; `select` accepts `count`, `sum`, `avg`, `min`, `max` or a plain `collection.field`.

## Records API

| Method and path | Purpose |
|---|---|
| `GET /api/collections/:c/records` | List: `page`, `perPage` (≤ 500), `filter`, `sort`, `expand`, `fields`, `skipTotal` |
| `GET /api/collections/:c/records/:id` | View one: `expand`, `fields` |
| `POST /api/collections/:c/records` | Create (JSON, or `multipart/form-data` with files) |
| `PATCH /api/collections/:c/records/:id` | Update |
| `DELETE /api/collections/:c/records/:id` | Delete (follows `cascadeDelete` relations) |

* **filter** uses the [rule language](rules.md): `done = false && title ~ 'milk'`.
* **sort**: comma-separated fields, `-` for descending: `-created,title`.
* **expand**: follow relations and inline them: `expand=user`.
* **fields**: return only these fields.
* **Modifiers** on update, for `select`, `relation` and `file` fields: `"tags+": "x"` appends, `"+tags": "x"` prepends and `"tags-": "x"` removes. On `number` fields, `"count+": 2` adds and `"count-": 1` subtracts.

List responses are `{page, perPage, totalItems, totalPages, items}`. Writes are all-or-nothing and fenced by the version the node read, so concurrent updates never silently overwrite each other.

## Limits

Collection writes need cluster version 9 or newer. One `RecordWrite` carries up to 100 operations on one collection.
