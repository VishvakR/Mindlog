"""A terminal chatbot whose only state is Mindlog: memory, chat history, cache and stats.

The bot itself stores nothing. Each turn it asks Mindlog for a packed, token-budgeted
context, sends that to a local Ollama model, then hands the message back to Mindlog,
which extracts facts, embeds them, links entities and detects conflicts.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import redis

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.5:4b-mlx")
BUDGET = 600  # tokens of memory the model gets per turn
HISTORY = 8  # recent chat lines sent with each turn
TTL_HISTORY = 7 * 24 * 3600
TTL_CACHE = 3600

# `/<word> args` runs `MEM.<WORD> <user> args` for these; no per-command code.
MEM_COMMANDS = {
    "search", "pack", "get", "history", "forget", "conflicts", "resolve", "trust", "branch",
    "branches", "diff", "merge", "drop", "pin", "unpin", "consolidate", "jobs", "trace",
}  # fmt: skip

HELP = """\
Just type to chat. Commands (args go straight to Mindlog, quote multi-word text):
  /search "q" [K n] [ASOF time|index] [VALID_AT t] [RECIPE name]   recall with scores
  /pack "q" [BUDGET n]        the context the model would get
  /get id | /history id       one memory | all its versions (time travel)
  /forget id…                 forget (drops cached answers built on it)
  /conflicts [ALL] | /resolve id KEEP a|b|both
  /trust verified|normal|quarantined id… | /pin id… | /unpin id…
  /branch name | /branches | /diff name | /merge name [POLICY p] | /drop name
  /on name | /off             chat on a what-if memory branch, or back on main
  /consolidate [worker…] | /jobs     run background workers | list jobs
  /trace tool outcome [ARGS a] [RESULT r]   remember a tool call
  /export file | /import file  .mcube archive of this user's memory
  /cache "q" | /stats | /help | /quit"""


def mem_argv(line: str, user: str) -> list[str] | None:
    """`/search "coffee" K 3` -> ['MEM.SEARCH', user, 'coffee', 'K', '3'], or None."""
    word, _, rest = line[1:].partition(" ")
    if word.lower() not in MEM_COMMANDS:
        return None
    return [f"MEM.{word.upper()}", user, *shlex.split(rest)]


def dec(x: Any) -> Any:
    """RESP3 replies come back as bytes; make them printable."""
    if isinstance(x, bytes):
        return x.decode(errors="replace")
    if isinstance(x, dict):
        return {dec(k): dec(v) for k, v in x.items()}
    if isinstance(x, (list, tuple, set)):
        return [dec(v) for v in x]
    return x


def show(reply: Any) -> None:
    print(json.dumps(dec(reply), indent=2, ensure_ascii=False, default=str))


def ollama(messages: list[dict[str, str]]) -> str:
    body = json.dumps(
        {"model": OLLAMA_MODEL, "messages": messages, "stream": False, "think": False}
    ).encode()
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat", body, {"content-type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return str(json.loads(r.read())["message"]["content"]).strip()


class Bot:
    def __init__(self, db: redis.Redis, user: str, session: str) -> None:
        self.db, self.user = db, user
        self.base_key = f"chat:{user}:{session}"
        self.stats_key = f"stats:{user}"
        self.branch: str | None = None

    @property
    def chat_key(self) -> str:
        """A branch keeps its own history, so dropping it leaves main's chat untouched."""
        return f"{self.base_key}:{self.branch}" if self.branch else self.base_key

    def on_branch(self) -> list[str]:
        return ["BRANCH", self.branch] if self.branch else []

    def turn(self, prompt: str) -> None:
        db = self.db
        # 1. semantic cache: a reworded question can skip the model entirely (main only)
        hit = None if self.branch else dec(db.execute_command("CACHE.GET", self.user, prompt))
        if hit:
            db.hincrby(self.stats_key, "cache_hits", 1)
            print(f"bot> {hit['answer']}")
            print(f"     [cache {hit['level']} hit, similarity {hit['similarity']}]")
            self.log(prompt, hit["answer"])
            return
        # 2. recall: Mindlog packs the relevant memories into a token budget
        pack = dec(
            db.execute_command("MEM.PACK", self.user, prompt, "BUDGET", BUDGET, *self.on_branch())
        )
        # 3. short-term memory: the last turns of this session, from a KV list
        recent = [json.loads(m) for m in dec(db.lrange(self.chat_key, -HISTORY, -1))]
        system = (
            f"You are a helpful assistant talking to {self.user}. Use what you remember "
            "about them when it helps; say so if you don't know. Be brief.\n\n"
            f"What you remember:\n{pack['context'] or '(nothing yet)'}"
        )
        answer = ollama([{"role": "system", "content": system}, *recent,
                         {"role": "user", "content": prompt}])  # fmt: skip
        print(f"bot> {answer}")
        # 4. remember: Mindlog extracts facts, embeds, links entities, checks conflicts
        added = dec(
            db.execute_command(
                "MEM.ADD", self.user, prompt, "SOURCE", "user", *self.on_branch(),
            )
        )  # fmt: skip
        # 5. cache the answer with the memories it used; forgetting one drops it
        if not self.branch:
            db.execute_command(
                "CACHE.SET", self.user, prompt, answer, *(["USING", *pack["ids"]] if pack["ids"]
                else []), "TTL", TTL_CACHE,
            )  # fmt: skip
        self.log(prompt, answer)
        flags = " · degraded (no model service)" if pack["degraded"] else ""
        where = f" · branch {self.branch}" if self.branch else ""
        print(
            f"     [used {len(pack['ids'])} memories, {pack['tokens']}/{BUDGET} tokens"
            f" · stored {len(added['ids'])}{where}{flags}]"
        )

    def log(self, prompt: str, answer: str) -> None:
        pipe = self.db.pipeline()
        pipe.rpush(self.chat_key, json.dumps({"role": "user", "content": prompt}),
                   json.dumps({"role": "assistant", "content": answer}))  # fmt: skip
        pipe.ltrim(self.chat_key, -50, -1)
        pipe.expire(self.chat_key, TTL_HISTORY)
        pipe.hincrby(self.stats_key, "turns", 1)
        pipe.execute()

    def command(self, line: str) -> bool:
        """Runs a slash command; False to quit."""
        word, _, rest = line[1:].partition(" ")
        word = word.lower()
        db = self.db
        if word in ("quit", "exit"):
            return False
        if word == "help":
            print(HELP)
        elif word == "on":
            self.branch = rest.strip() or None
            print(f"chatting on branch {self.branch}" if self.branch else "usage: /on name")
        elif word == "off":
            self.branch = None
            print("chatting on main")
        elif word == "export":
            data = db.execute_command("MEM.EXPORT", self.user)
            Path(rest.strip()).write_bytes(data)
            print(f"wrote {len(data)} bytes to {rest.strip()}")
        elif word == "import":
            show(db.execute_command("MEM.IMPORT", self.user, Path(rest.strip()).read_bytes()))
        elif word == "cache":
            show(db.execute_command("CACHE.GET", self.user, " ".join(shlex.split(rest))))
        elif word == "stats":
            show({**dec(db.hgetall(self.stats_key)), "history_len": db.llen(self.chat_key)})
        elif argv := mem_argv(line, self.user):
            show(db.execute_command(*argv))
        else:
            print("unknown command, try /help")
        return True


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--user", default="demo", help="memory scope (one per person)")
    p.add_argument("--session", default=time.strftime("%Y%m%d-%H%M%S"))
    p.add_argument("--resp", default=os.environ.get("MINDLOG_RESP", "127.0.0.1:6379"))
    a = p.parse_args()
    host, _, port = a.resp.rpartition(":")
    db = redis.Redis(host=host, port=int(port), protocol=3)
    try:
        db.ping()
    except redis.ConnectionError:
        sys.exit(f"cannot reach Mindlog at {a.resp}: start the node first (see README)")
    bot = Bot(db, a.user, a.session)
    print(f"Mindlog chat · user {a.user} · session {a.session} · model {OLLAMA_MODEL}. /help")
    while True:
        try:
            line = input("you> ").strip()
        except EOFError:
            break
        if not line:
            continue
        try:
            if line.startswith("/"):
                if not bot.command(line):
                    break
            else:
                bot.turn(line)
        except redis.ResponseError as e:
            print(f"mindlog: {e}")
        except (urllib.error.URLError, OSError) as e:
            print(f"error: {e} (is `ollama serve` running with {OLLAMA_MODEL}?)")
        except ValueError as e:  # bad quoting in a slash command
            print(f"error: {e}")


if __name__ == "__main__":
    main()
