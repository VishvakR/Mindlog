---
description: Use Mindlog as the storage behind CrewAI's memory classes.
---

# CrewAI

`mindlog.sdk.crewai.MindlogCrewStorage` implements CrewAI's memory `Storage` interface (`save`, `search`, `reset`), so CrewAI's memory classes can keep their data in Mindlog. It does not import CrewAI itself, so no extra is needed: install CrewAI in your own project.

```python
from crewai.memory import ShortTermMemory, EntityMemory
from mindlog.sdk import Client
from mindlog.sdk.crewai import MindlogCrewStorage

client = Client("http://localhost:8090", api_key="mlk_…")

short_term = ShortTermMemory(storage=MindlogCrewStorage(client, user="crew-trip"))
entities = EntityMemory(storage=MindlogCrewStorage(client, user="crew-trip", recipe="hybrid"))
```

| Method | Behaviour |
|---|---|
| `save(value, metadata=None)` | Remembers `value`, tagged `agent:<name>` from the metadata, with the metadata kept under `meta.crewai` |
| `search(query, limit=3, score_threshold=0.35)` | Mindlog recall. Returns `[{id, context, metadata, score}]`, with scores scaled so the best hit is 1.0 and hits below the threshold dropped |
| `reset()` | Forgets everything in the scope (append-only, so history is kept) |

`recipe` selects the [recall recipe](../guides/memory/recall.md#recipes); the default is the server's (`full`).
