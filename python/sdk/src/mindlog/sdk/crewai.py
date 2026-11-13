"""CrewAI memory on Mindlog (PLAN 15.5).

`MindlogCrewStorage` has the methods of CrewAI's memory `Storage` (`save`, `search`, `reset`), so
it plugs into `ShortTermMemory(storage=…)`, `EntityMemory(storage=…)` and the like without this
package importing CrewAI.
"""

from __future__ import annotations

from typing import Any

from mindlog.sdk.client import Client


class MindlogCrewStorage:
    """One crew's memory as a Mindlog user scope: saves become memories, searches are recall."""

    def __init__(self, client: Client, user: str = "crewai", recipe: str | None = None) -> None:
        self._memory = client.memory(user)
        self._recipe = recipe

    def save(self, value: Any, metadata: dict[str, Any] | None = None) -> None:
        text = value if isinstance(value, str) else str(value)
        tags = [f"agent:{metadata['agent']}"] if metadata and metadata.get("agent") else None
        self._memory.remember(text, tags=tags, meta={"crewai": metadata or {}})

    def search(
        self, query: str, limit: int = 3, score_threshold: float = 0.35
    ) -> list[dict[str, Any]]:
        """CrewAI's result shape: `context`, `metadata` and `score`, best first."""
        items = self._memory.recall(query, k=limit, recipe=self._recipe)["items"]
        if not items:
            return []
        top = max(float(i["score"]) for i in items) or 1.0
        out = []
        for item in items:
            # Recall scores are not on a fixed scale; relative to the best one they are.
            score = float(item["score"]) / top
            if score >= score_threshold:
                memory = item["memory"]
                meta = (memory.get("meta") or {}).get("crewai", {})
                out.append(
                    {
                        "id": memory["id"],
                        "context": memory["text"],
                        "metadata": meta,
                        "score": score,
                    }
                )
        return out

    def reset(self) -> None:
        """Forgets every memory of the crew's scope (kept as history, ADR-0033)."""
        after: str | None = None
        while True:
            page = self._memory.list(limit=100, after=after)
            ids = [m["id"] for m in page["memories"]]
            if ids:
                self._memory.forget(ids, reason="crew memory reset")
            after = page.get("next")
            if not after:
                return
