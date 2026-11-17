# Mindlog chat demo

A terminal chatbot with **no storage of its own**. Long-term memory, chat history, cached answers and stats all live in Mindlog. The model is a small local one served by Ollama. It works well because Mindlog gives it a short, relevant context each turn instead of the whole transcript. The bot is one file, [`chat.py`](chat.py), and talks to Mindlog over the Redis protocol with `redis-py`.

## Run it

```bash
# 1. model service: embeddings, fact extraction, entities, conflict detection (NLI)
cd python && uv run python -m model_service

# 2. a Mindlog node using it
pnpm build
MINDLOG_MODELS__ENDPOINT=127.0.0.1:50051 node packages/server/dist/bin.js --single-node --data-dir ./data/demo

# 3. Ollama with a chat model
ollama serve            # and once: ollama pull qwen3.5:4b-mlx

# 4. chat
cd demo && uv run chat.py --user ana
```

| Setting | Default |
|---|---|
| `--user` | `demo` (memory scope; one per person) |
| `--session` | a timestamp (each session has its own chat history) |
| `MINDLOG_RESP` / `--resp` | `127.0.0.1:6379` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | `qwen3.5:4b-mlx` |

Without step 1 the node runs in degraded mode: memories are stored and found by keywords, and the footer says `degraded`.

## What happens on each message

| Step | Mindlog feature | Command |
|---|---|---|
| 1 | Semantic cache: a question that means the same thing gets the stored answer, and the model is not called | `CACHE.GET` |
| 2 | Recall: hybrid retrieval packed into a 600-token budget | `MEM.PACK … BUDGET 600` |
| 3 | Short-term memory: the last turns of the session | `LRANGE` on a KV list |
| 4 | *(Ollama answers using the packed context)* | |
| 5 | Remember: facts are extracted, embedded, linked to entities and checked against existing facts for conflicts | `MEM.ADD … SOURCE user` |
| 6 | Cache the answer, tied to the memories it used | `CACHE.SET … USING ids… TTL` |
| 7 | History and stats | `RPUSH`/`LTRIM`/`EXPIRE`, `HINCRBY` |

## A tour (type these)

```text
you> I live in Berlin and I work as a nurse.
you> /quit
$ uv run chat.py --user ana              # new session: no chat history
you> Where do I live?                    # answered from long-term memory
you> Where do I live?                    # [cache l1 hit]: no model call

you> Actually I live in Munich now.      # contradicts a stored fact
you> /conflicts                          # open conflict; the new fact is quarantined
you> /resolve <conflict id> KEEP b       # keep Munich; Berlin's validity ends

you> /search "where do I live" K 3 ASOF 2026-11-17T10:00:00Z   # recall as of a past time
you> /history <memory id>                # every version of a memory

you> /branch trip                        # a what-if branch of memory
you> /on trip
you> I am planning a trip to Japan.      # written only on the branch
you> /off
you> /diff trip                          # what the branch added
you> /merge trip                         # or /drop trip

you> /forget <memory id>                 # cached answers that used it are dropped too
you> /cache "Where do I live?"           # → null
you> /trust verified <id>   /pin <id>    # provenance and lifecycle
you> /consolidate           /jobs        # background workers (dedup, themes, forgetting…)
you> /export ana.mcube      /import ana.mcube
you> /stats
```

`/help` lists every command. `/<word> args` runs `MEM.<WORD> <user> args`, so any option in the [RESP reference](../docs/api/resp-compatibility.md) works. Open the dashboard at http://localhost:8090/_/ to watch the same memories, conflicts, branches and jobs live.

Not shown here: the `MEM.WATCH` push stream (see the dashboard's Live feed), collections, tenants and API keys, and cluster commands.

## Test

```bash
cd demo && uv run pytest
```
