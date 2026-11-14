---
description: Move memory between scopes and systems as archives, and record tool calls as procedural memory.
---

# Import, export and tool traces

## Memory cubes (`.mcube`)

A memory cube is a portable archive of a scope: a gzip tar of its memories, entities and links, with a SHA-256 checksum per file.

```bash
MEM.EXPORT ana                     # the archive as one binary bulk string
MEM.EXPORT ana ASOF 2026-05-10     # the scope as it was then
```

Over REST, `POST /api/memory/export` returns the same archive base64-encoded, which is easier to save from a script:

```bash
curl -s localhost:8090/api/memory/export -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"scope":{"user":"ana"}}' \
  | jq -r .data | base64 -d > ana.mcube
```

Import into any scope, on the same or another cluster:

```bash
MEM.IMPORT bob <archive> FORMAT mcube NAME ana-handover
```

REST: `POST /api/memory/import` with `{scope, format, data (base64, ≤ 32 MB decoded), name}`.

* `FORMAT cogx` imports a COGX archive from other memory systems.
* Imported memories have source `document` with reference `import:<name>`, so the [trust policy](trust.md) applies: unless the source is trusted, they arrive quarantined for review.

Tenant-wide exports for compliance are a separate admin feature ([Tenants](../tenants-and-access.md#export-and-deletion)).

## Tool traces

Agents learn from what worked. Record a tool call as a `tool_trace` memory, and later recalls can surface it as a procedure:

{% tabs %}
{% tab title="RESP" %}
```bash
MEM.TRACE ana calendar.create ok ARGS '{"title":"flight to Lisbon"}' RESULT 'created event 42'
MEM.TRACE ana payments.refund failed RESULT 'card expired'
```
{% endtab %}

{% tab title="MCP" %}
```json
{ "name": "remember_tool_call",
  "arguments": { "tool": "calendar.create", "args": {"title": "flight to Lisbon"},
                 "result": "created event 42", "success": true } }
```
{% endtab %}

{% tab title="REST" %}
```json
{ "scope": {"user": "ana"},
  "toolTrace": { "tool": "calendar.create", "args": {"title": "flight"}, "result": "created event 42", "success": true } }
```
{% endtab %}
{% endtabs %}

Arguments and results are truncated to 500 characters each. Traces appear under **Recent episodes** in packed context.
