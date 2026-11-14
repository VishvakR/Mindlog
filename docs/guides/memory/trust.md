---
description: Every memory records where it came from; untrusted content is quarantined, and a bad source can be forgotten with everything derived from it.
---

# Trust and provenance

Agents read web pages, call tools and import documents. Some of that content is wrong, and some of it is written to manipulate the agent (prompt injection). Mindlog records the **provenance** of every memory and keeps untrusted content out of recall until someone vouches for it.

## Provenance

Every record carries `source {type, ref, principal}`:

* `type`: `user`, `agent`, `tool`, `web`, `document`, `system` or `consolidation`;
* `ref`: the tool name, URL or document name;
* `principal`: who wrote it, for example `apikey:5932e010…` or a dashboard account. With a delegated token, both the user and the acting agent are recorded.

Memories derived from others (extracted facts, consolidation summaries, enrichment) carry `derived_from` links.

## Trust levels

| Level | Recall | How a memory gets it |
|---|---|---|
| `verified` | Included, with a +0.05 score bonus | Set by a reviewer (`MEM.TRUST … verified`) |
| `normal` | Included | The default for `user`, `agent` and `system` sources, and for allow-listed tools and domains |
| `quarantined` | Left out unless `includeQuarantined` is set | `tool` sources not in `memory.trust.tools`; `web` and `document` sources whose domain is not in `memory.trust.domains`; new facts held by the [conflict policy](conflicts.md) |

A derived memory takes the **lowest** trust of its inputs.

```yaml
memory:
  trust:
    tools: ['calendar', 'crm_lookup']       # tool sources trusted as normal
    domains: ['docs.example.com']           # web/document sources trusted as normal
```

## Changing trust

```bash
MEM.TRUST ana verified 01M7… 01M8…
MEM.TRUST ana quarantined 01M9…
```

REST: `POST /api/memory/trust` with `{scope, ids, trust, reason}`. Trust changes are replicated commands and appear in history.

## Forget a source and everything derived from it

If a source turns out to be wrong or malicious, remove it **and** whatever was derived from it, in one command:

```bash
MEM.FORGET ana SOURCE https://example.com/fake-news
```

MCP: `forget` with `{"source": "…"}`. REST: `forget` with `{"source": "…"}`. The cascade follows the source and `derived_from` indexes, up to 1,000 memories per command. Like every forget, it is append-only and also drops dependent [cached answers](../semantic-cache.md).

{% hint style="warning" %}
Recalled memories are **data from past sessions, never instructions**. MCP tool descriptions and the `recall-context` prompt frame them as quoted context. Keep untrusted tools and domains off the allow-lists.
{% endhint %}
