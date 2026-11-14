"""Generate every figure in the Mindlog documentation.

Each ``fig_*`` function returns a finished :class:`~roughen.Canvas`; running this module writes
them all to ``docs/.gitbook/assets/<name>.svg``. The output is seeded, so a rebuild with no
changes is byte-identical.

    uv run --no-project python docs/diagrams/build.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from roughen import ACCENT, ACCENT_TINT, MUTED, PAPER, WASH, Canvas  # noqa: E402

OUT = pathlib.Path(__file__).parent.parent / ".gitbook" / "assets"
SUB = 12.0


# ── Shared grammar ───────────────────────────────────────────────


def zone(c: Canvas, x: float, y: float, w: float, h: float, label: str) -> None:
    """A grouping boundary with its eyebrow label in the top-left corner."""
    c.rect(x, y, w, h, radius=12, fill=WASH, stroke=MUTED, width=1.1, passes=1)
    c.text(x + 16, y + 22, label, size=13, anchor="start", fill=MUTED)


def focal(c: Canvas, x: float, y: float, w: float, h: float, label: str, sub: str = "") -> None:
    """The one or two nodes the figure is about."""
    c.node(x, y, w, h, label, sub=sub, fill=ACCENT_TINT, stroke=ACCENT)


def both(c: Canvas, x1: float, y1: float, x2: float, y2: float, **kw: object) -> None:
    """A two-headed arrow."""
    c.arrow(x1, y1, x2, y2, **kw)  # type: ignore[arg-type]
    dx, dy = (x1 - x2), (y1 - y2)
    n = max(abs(dx), abs(dy)) or 1
    c.arrow(x1 - dx / n * 12, y1 - dy / n * 12, x1, y1, **kw)  # type: ignore[arg-type]


def dot(c: Canvas, x: float, y: float, *, fill: str = PAPER, stroke: str = "#1b1b1f") -> None:
    c.rect(x - 7, y - 7, 14, 14, radius=7, fill=fill, stroke=stroke, width=1.4, passes=1)


def lifeline(c: Canvas, x: float, top: float, bottom: float, name: str, sub: str = "") -> None:
    """A sequence-diagram participant: header box plus dashed lifeline."""
    c.line(x, top + 56, x, bottom, stroke=MUTED, width=1.0, dashed=True, passes=1)
    c.node(x - 78, top, 156, 56, name, sub=sub, size=15)


def msg(c: Canvas, x1: float, x2: float, y: float, text: str, *, dashed: bool = False,
        accent: bool = False) -> None:
    """A sequence message with its label above the line."""
    stroke = ACCENT if accent else "#1b1b1f"
    c.arrow(x1, y, x2, y, stroke=stroke, dashed=dashed, width=1.4)
    c.label((x1 + x2) / 2, y - 16, text, size=12.5, fill="#1b1b1f" if not dashed else MUTED)


def note(c: Canvas, x: float, y: float, w: float, text: str) -> None:
    """A self-action box hanging on a lifeline."""
    lines = text.split("\n")
    h = len(lines) * 16 + 14
    c.rect(x, y, w, h, radius=5, fill=PAPER, stroke=MUTED, width=1.1, passes=1)
    c.text(x + 10, y + 21, text, size=12.5, anchor="start", leading=16)


# ── Architecture ─────────────────────────────────────────────────


def fig_system_context() -> Canvas:
    """Who talks to Mindlog, over what, and what Mindlog depends on."""
    c = Canvas(940, 440, seed=101)
    clients = [
        ("Backend apps", "any Redis client", "RESP :6379"),
        ("AI agents", "Claude, LangGraph, CrewAI", "MCP :8765"),
        ("Web & mobile apps", "TypeScript / Python SDK", "REST + SSE :8090"),
        ("Operators", "browser", "dashboard /_/"),
    ]
    for i, (name, sub, port) in enumerate(clients):
        y = 40 + i * 96
        c.arrow(236, y + 32, 400, y + 32)
        c.label(318, y + 16, port)
        c.node(28, y, 208, 64, name, sub=sub)
    deps = [
        ("Model service", "local ONNX models", "gRPC :50051"),
        ("Object store", "files, cold tier, backups", "local or S3"),
        ("Prometheus / OTel", "metrics and traces", "/metrics, OTLP"),
    ]
    for i, (name, sub, port) in enumerate(deps):
        y = 60 + i * 120
        c.arrow(600, y + 36, 716, y + 36)
        c.label(658, y + 18, port, size=11.5)
        c.node(716, y, 200, 72, name, sub=sub)
    focal(c, 400, 40, 200, 352, "Mindlog cluster", "Raft-replicated, offline")
    c.text(500, 250, "KV · memory · collections", size=12.5, fill=MUTED)
    c.text(500, 268, "one log, many projections", size=12.5, fill=MUTED)
    return c


def fig_deployment() -> Canvas:
    """Three nodes, each with a model sidecar, plus the placement driver."""
    c = Canvas(940, 440, seed=102)
    for i in range(3):
        x = 24 + i * 308
        zone(c, x, 24, 276, 214, f"Node {i + 1}")
        c.arrow(x + 138, 116, x + 138, 160)
        c.text(x + 148, 142, ":50051", size=11.5, fill=MUTED, anchor="start")
        c.node(x + 28, 56, 220, 60, "mindlog-server", sub="RESP · HTTP · MCP")
        c.node(x + 28, 160, 220, 56, "mindlog-models", sub="ONNX sidecar", dashed=True)
    for i in range(2):
        x1 = 24 + i * 308 + 248
        both(c, x1 + 2, 86, x1 + 86, 86)
        c.label(x1 + 44, 108, ":7000", size=11.5)
    c.text(470, 420, "Raft, snapshots and forwarding between nodes: gRPC + mTLS on :7000, full mesh",
           size=12.5, fill=MUTED)
    c.route([(162, 238), (162, 352), (340, 352)])
    c.arrow(470, 238, 470, 320)
    c.route([(778, 238), (778, 352), (600, 352)])
    c.label(560, 292, "heartbeats, TSO", size=11.5)
    focal(c, 340, 320, 260, 68, "mindlog-pd × 3", "placement driver · own Raft group · :7100")
    return c


def fig_layers() -> Canvas:
    """The six layers and the composition root."""
    c = Canvas(940, 486, seed=103)
    layers = [
        ("Interfaces", "adapter-resp · adapter-mcp · adapter-http (REST, SSE, dashboard)"),
        ("Application", "auth · router · services (Kv, Memory, Collections, Admin)"),
        ("Domain", "memory · consolidation · branching · cache · collections · rules · txn · kv · jobs"),
        ("Replication", "raft (pure) · multiraft · statemachine · transport · pd"),
        ("Storage & indexes", "storage · blob · index-vector · index-text · index-graph"),
        ("Core", "types · Result · errors · HLC · keys · config · logging · metrics · eventbus"),
    ]
    for i, (name, pkgs) in enumerate(layers):
        y = 24 + i * 72
        if name == "Replication":
            c.rect(64, y, 640, 58, radius=8, fill=ACCENT_TINT, stroke=ACCENT)
        else:
            c.rect(64, y, 640, 58, radius=8, fill=PAPER)
        c.text(84, y + 25, name, size=16, anchor="start", fill=ACCENT if name == "Replication" else "#1b1b1f")
        c.text(84, y + 45, pkgs, size=12, anchor="start", fill=MUTED)
    c.arrow(34, 30, 34, 440)
    c.text(64, 470, "imports only point down; lint and madge enforce it", size=12.5, fill=MUTED,
           anchor="start")
    c.rect(740, 24, 176, 418, radius=10, fill=WASH, stroke=MUTED, dashed=True, width=1.2)
    c.text(828, 200, "server", size=16)
    c.text(828, 224, "composition root:", size=12, fill=MUTED)
    c.text(828, 242, "the only package", size=12, fill=MUTED)
    c.text(828, 260, "that wires concrete", size=12, fill=MUTED)
    c.text(828, 278, "adapters to ports", size=12, fill=MUTED)
    return c


def fig_log_truth() -> Canvas:
    """Non-deterministic work happens once, on the leader; replicas only apply."""
    c = Canvas(940, 420, seed=104)
    zone(c, 24, 24, 292, 352, "Leader, before proposing")
    steps = [
        ("request", "remember(scope, text)"),
        ("ids and HLC", "ULID, hybrid clock"),
        ("model inference", "facts, embeddings, NLI"),
        ("command", "every output embedded"),
    ]
    for i, (name, sub) in enumerate(steps):
        y = 56 + i * 80
        if i < 3:
            c.arrow(170, y + 56, 170, y + 80)
        c.node(48, y, 244, 56, name, sub=sub)
    c.route([(292, 324), (334, 324), (334, 205), (364, 205)])
    focal(c, 364, 172, 150, 66, "Raft log", "committed commands")
    ys = [115, 205, 295]
    c.route([(514, 190), (538, 190), (538, ys[0]), (562, ys[0])])
    c.arrow(514, 205, 562, 205)
    c.route([(514, 220), (538, 220), (538, ys[2]), (562, ys[2])])
    for i, y in enumerate(ys):
        c.node(562, y - 26, 148, 52, f"replica {i + 1}", sub="apply()")
    c.route([(710, ys[0]), (734, ys[0]), (734, 176), (756, 176)])
    c.arrow(710, 205, 756, 205)
    c.route([(710, ys[2]), (734, ys[2]), (734, 234), (756, 234)])
    c.node(756, 150, 160, 110, "identical state", sub="KV · memory · indexes")
    c.text(620, 400, "apply() never reads the clock, randomness, the network or a model",
           size=12.5, fill=MUTED)
    return c


def fig_write_path() -> Canvas:
    """Sequence of one remember call."""
    c = Canvas(940, 560, seed=105)
    xs = [96, 278, 470, 662, 846]
    names = [
        ("Agent", "MCP / RESP / REST"),
        ("Adapter", "auth + route"),
        ("MemoryService", "range leader"),
        ("Model service", "local ONNX"),
        ("Raft replicas", "state machine"),
    ]
    for x, (n, s) in zip(xs, names):
        lifeline(c, x, 20, 540, n, s)
    msg(c, xs[0], xs[1], 116, "remember(scope, text, requestId)")
    msg(c, xs[1], xs[2], 166, "allowed? forward to leader")
    msg(c, xs[2], xs[3], 216, "embed, facts, NER, NLI")
    msg(c, xs[3], xs[2], 266, "model outputs", dashed=True)
    note(c, xs[2] + 8, 284, 180, "entities, importance,\nconflicts → command")
    msg(c, xs[2], xs[4], 362, "propose(command)", accent=True)
    note(c, xs[4] - 172, 380, 164, "quorum fsync, commit,\none WriteBatch:\nrecord + indexes")
    msg(c, xs[4], xs[2], 470, "applied at index i", dashed=True)
    msg(c, xs[2], xs[0], 516, "ids, conflicts, degraded", dashed=True)
    return c


def fig_raft_loop() -> Canvas:
    """The Ready / advance loop of a replica."""
    c = Canvas(820, 430, seed=106)
    c.arrow(190, 180, 250, 180)
    c.node(24, 150, 166, 60, "tick · step", sub="propose, messages")
    focal(c, 250, 140, 180, 80, "Raft core", "pure, no I/O")
    steps = [
        ("Ready", "hardState, entries, messages"),
        ("1  persist", "fsync, one batch for all ranges"),
        ("2  send", "messages to peers"),
        ("3  apply", "committed entries, in order"),
        ("4  advance()", "tell the core it is done"),
    ]
    c.route([(430, 160), (476, 160), (476, 56), (520, 56)])
    for i, (name, sub) in enumerate(steps):
        y = 28 + i * 78
        if i < 4:
            c.arrow(650, y + 56, 650, y + 78)
        c.node(520, y, 260, 56, name, sub=sub)
    c.route([(520, 368), (340, 368), (340, 220)])
    c.text(160, 300, "persist before send:", size=13, fill=MUTED)
    c.text(160, 318, "no message ever promises", size=13, fill=MUTED)
    c.text(160, 336, "what is not on disk", size=13, fill=MUTED)
    return c


def fig_range_states() -> Canvas:
    """States of a range."""
    c = Canvas(900, 430, seed=107)
    ax, ay, aw, ah = 370, 180, 160, 70
    # Splitting (top)
    c.arrow(425, ay, 425, 96)
    c.arrow(475, 96, 475, ay)
    c.text(415, 142, "> 64 MiB, or hot 60 s", size=12, anchor="end", fill=MUTED)
    c.text(485, 142, "split applied: two ranges", size=12, anchor="start", fill=MUTED)
    c.node(370, 36, 160, 60, "Splitting")
    # Moving (bottom)
    c.arrow(425, ay + ah, 425, 334)
    c.arrow(475, 334, 475, ay + ah)
    c.text(415, 296, "PD operator", size=12, anchor="end", fill=MUTED)
    c.text(485, 296, "learner → voter → leader moved", size=12, anchor="start", fill=MUTED)
    c.node(370, 334, 160, 60, "Moving")
    # Quiescent (left)
    c.arrow(ax, 202, 214, 202)
    c.arrow(214, 228, ax, 228)
    c.label(292, 186, "idle")
    c.label(292, 246, "proposal")
    c.node(54, 184, 160, 62, "Quiescent", sub="stops ticking")
    # Merging (right)
    c.arrow(ax + aw, 202, 686, 202)
    c.arrow(686, 228, ax + aw, 228)
    c.label(608, 186, "both < 16 MiB")
    c.label(608, 246, "merge applied")
    c.node(686, 184, 160, 62, "Merging", sub="with its neighbour")
    focal(c, ax, ay, aw, ah, "Active", "serving reads and writes")
    return c


def fig_storage() -> Canvas:
    """What one node keeps on disk and in memory."""
    c = Canvas(940, 360, seed=108)
    zone(c, 24, 24, 640, 312, "One node")
    c.arrow(312, 112, 380, 112)
    c.text(346, 100, "replay", size=12, fill=MUTED)
    c.arrow(500, 152, 500, 228)
    c.text(512, 194, "rebuild", size=12, fill=MUTED, anchor="start")
    c.route([(620, 100), (800, 100), (800, 228)])
    c.text(812, 160, "cold tier,", size=12, fill=MUTED, anchor="start")
    c.text(812, 176, "backups", size=12, fill=MUTED, anchor="start")
    focal(c, 56, 72, 256, 80, "LevelDB #1: Raft log", "hard state + entries, fsync before ack")
    c.node(380, 72, 256, 80, "LevelDB #2: state", sub="MVCC, appliedIndex in the batch")
    c.node(380, 228, 256, 80, "in-memory indexes", sub="vector, BM25 and graph caches")
    c.node(700, 228, 216, 80, "blob store", sub="files, cold tier, backups")
    c.text(184, 220, "the state store can be", size=12.5, fill=MUTED)
    c.text(184, 238, "rebuilt from the log, so", size=12.5, fill=MUTED)
    c.text(184, 256, "it skips fsync per write", size=12.5, fill=MUTED)
    return c


# ── Anatomy ──────────────────────────────────────────────────────


def fig_key_anatomy() -> Canvas:
    """One encoded key, segment by segment."""
    c = Canvas(940, 340, seed=109)
    segs = [
        ("acme", "tenant", 120),
        ("m", "family", 80),
        ("alice", "user", 120),
        ("r", "sub-tag", 80),
        ("01JD4…", "memory id", 150),
        ("0x40 ~v", "version", 150),
    ]
    x = 60.0
    for i, (val, role, w) in enumerate(segs):
        if i == 0:
            c.rect(x, 90, w, 64, radius=6, fill=ACCENT_TINT, stroke=ACCENT)
        else:
            c.rect(x, 90, w, 64, radius=6, fill=PAPER)
        c.text(x + w / 2, 129, val, size=18, fill=ACCENT if i == 0 else "#1b1b1f")
        c.text(x + w / 2, 180, role, size=13, fill=MUTED)
        x += w + 12
    c.text(60, 56, "key := tenant · family · tuple elements · [version]", size=15, anchor="start")
    notes = [
        "tenant first: tenants never share a range",
        "one prefix per user: a split never cuts a user's memory",
        "version stored inverted: the newest version sorts first",
    ]
    for i, text in enumerate(notes):
        c.text(60, 230 + i * 22, "· " + text, size=13, anchor="start", fill=MUTED)
    c.text(60, 318, "families: k = Redis values · m = memory · c/x/u = collections · s = system",
           size=12.5, anchor="start", fill=MUTED)
    return c


def fig_record_anatomy() -> Canvas:
    """The fields of a memory record and its four timestamps."""
    c = Canvas(940, 440, seed=110)
    c.rect(24, 24, 420, 392, radius=10, fill=PAPER)
    groups = [
        ("Identity", "id (ULID) · scope · branch · kind"),
        ("Content", "text · embedding · entities · links"),
        ("Provenance", "source {type, ref, principal} · trust"),
        ("Lifecycle", "importance · strength · recallCount · tier · pinned"),
        ("Time", "createdAt · expiredAt · validFrom · validTo"),
    ]
    for i, (name, fields) in enumerate(groups):
        y = 40 + i * 76
        if i:
            c.line(40, y - 10, 428, y - 10, stroke=MUTED, width=0.9, passes=1)
        c.text(44, y + 22, name, size=16, anchor="start", fill=ACCENT if name == "Time" else "#1b1b1f")
        c.text(44, y + 46, fields, size=12.5, anchor="start", fill=MUTED)
    # Two time axes
    c.text(500, 80, "world time: when the fact held", size=14, anchor="start")
    c.arrow(500, 130, 910, 130, stroke=MUTED, width=1.1)
    c.rect(560, 112, 220, 36, radius=6, fill=ACCENT_TINT, stroke=ACCENT)
    c.text(560, 172, "validFrom", size=12.5, fill=MUTED)
    c.text(780, 172, "validTo", size=12.5, fill=MUTED)
    c.text(500, 250, "system time: when Mindlog knew it", size=14, anchor="start")
    c.arrow(500, 300, 910, 300, stroke=MUTED, width=1.1)
    c.rect(620, 282, 200, 36, radius=6, fill=PAPER)
    c.text(620, 342, "createdAt", size=12.5, fill=MUTED)
    c.text(820, 342, "expiredAt", size=12.5, fill=MUTED)
    c.text(500, 396, "a newer fact sets validTo / expiredAt; nothing is overwritten",
           size=12.5, anchor="start", fill=MUTED)
    return c


def fig_ingest() -> Canvas:
    """The remember pipeline, grouped into four phases."""
    c = Canvas(940, 330, seed=111)
    phases = [
        ("Prepare", ["normalize", "redact (if on)", "chunk documents"], False),
        ("Enrich", ["extract facts", "recognize entities", "embed"], True),
        ("Decide", ["importance", "link notes", "trust", "detect conflicts"], False),
    ]
    for i, (name, stages, dashed) in enumerate(phases):
        x = 24 + i * 226
        if i:
            c.arrow(x - 26, 140, x, 140)
        c.rect(x, 40, 200, 200, radius=10, fill=PAPER, dashed=dashed)
        c.text(x + 20, 72, name, size=17, anchor="start")
        for j, s in enumerate(stages):
            c.text(x + 20, 106 + j * 28, s, size=13.5, anchor="start", fill=MUTED)
    c.text(350, 262, "needs the model service", size=12, fill=MUTED)
    c.arrow(676, 140, 702, 140)
    focal(c, 702, 96, 214, 88, "MemoryCommit", "one command, proposed to Raft")
    c.text(470, 306, "Models run only on the leader. Followers apply the outputs in the command.",
           size=12.5, fill=MUTED)
    return c


def fig_recall() -> Canvas:
    """The recall pipeline from query to packed context."""
    c = Canvas(940, 420, seed=112)
    c.arrow(190, 72, 236, 72)
    c.arrow(462, 72, 508, 72)
    c.arrow(676, 72, 722, 72)
    c.route([(822, 102), (822, 228)])
    c.arrow(722, 258, 676, 258)
    c.arrow(508, 258, 462, 258)
    c.arrow(296, 258, 250, 258)
    c.node(24, 42, 166, 60, "parse query", sub="entities, time, breadth")
    c.rect(236, 32, 226, 142, radius=8, fill=PAPER)
    c.text(256, 60, "retrieve (parallel)", size=16, anchor="start")
    for j, r in enumerate(["vector · k = 50", "BM25 keyword", "entity", "PPR graph walk", "theme"]):
        c.text(256, 84 + j * 18, r, size=12.5, anchor="start", fill=MUTED)
    c.node(508, 42, 168, 60, "fuse", sub="weighted RRF, k = 60")
    c.node(722, 42, 194, 60, "filter", sub="scope, trust, ASOF, branch")
    c.node(722, 228, 194, 60, "rerank", sub="cross-encoder, top 50")
    c.node(508, 228, 168, 60, "score", sub="relevance + signals")
    c.node(296, 228, 166, 60, "diversify", sub="MMR, λ = 0.7")
    focal(c, 24, 228, 226, 60, "pack", "token budget, grouped")
    c.text(470, 336, "score = 0.60·relevance + 0.15·recency + 0.15·importance + 0.10·retention",
           size=13, fill=MUTED)
    c.text(470, 358, "(+0.05 if verified; quarantined memories are filtered out first)",
           size=12.5, fill=MUTED)
    c.text(470, 396, "recipes pick the retrievers: rag · vector · hybrid · hybrid_ppr · full",
           size=12.5, fill=MUTED)
    return c


# ── Features ─────────────────────────────────────────────────────


def fig_conflicts() -> Canvas:
    """How a new fact is classified at commit time."""
    c = Canvas(940, 460, seed=113)
    c.arrow(190, 158, 236, 158)
    c.arrow(444, 158, 495, 158)
    c.route([(580, 110), (580, 60), (730, 60)])
    c.label(640, 44, "entails ≥ 0.90")
    c.arrow(665, 158, 730, 158)
    c.label(698, 142, "neutral")
    c.arrow(580, 206, 580, 268)
    c.label(580, 238, "contradicts ≥ 0.95")
    c.arrow(485, 320, 444, 320)
    c.label(464, 304, "no")
    c.arrow(675, 320, 730, 320)
    c.label(702, 304, "yes")
    c.node(24, 130, 166, 56, "new fact")
    c.node(236, 130, 208, 56, "similar facts", sub="top 5, cosine ≥ 0.5")
    c.diamond(580, 158, 170, 96, "NLI\nboth ways")
    c.node(730, 32, 186, 56, "duplicate", sub="not stored again")
    c.node(730, 130, 186, 56, "store", sub="no conflict")
    c.diamond(580, 320, 190, 104, "validity\nwindows\noverlap?", size=13)
    c.node(236, 292, 208, 56, "history", sub="newer fact supersedes")
    focal(c, 730, 286, 186, 68, "conflict", "apply the policy")
    c.text(470, 420, "policies: quarantine_new (default) · newest_wins · ask_human · prefer_verified",
           size=12.5, fill=MUTED)
    return c


def fig_branches() -> Canvas:
    """A memory branch: fork, isolated writes, merge with a policy."""
    c = Canvas(940, 380, seed=114)
    c.arrow(40, 110, 910, 110, stroke=MUTED, width=1.2)
    c.text(40, 86, "main", size=15, anchor="start")
    c.route([(250, 110), (250, 240), (640, 240)], arrow=False)
    c.arrow(640, 240, 640, 118)
    for x in (120, 250, 420, 560, 640, 760):
        dot(c, x, 110)
    for x in (340, 470, 560):
        dot(c, x, 240, fill=ACCENT_TINT, stroke=ACCENT)
    c.label(250, 176, "MEM.BRANCH plan-b", fill="#1b1b1f")
    c.text(450, 280, "writes with BRANCH plan-b", size=12.5, fill=MUTED)
    c.text(450, 298, "reads: branch over main, as of the fork", size=12.5, fill=MUTED)
    focal(c, 690, 150, 220, 64, "MEM.MERGE plan-b", "POLICY raise (default)")
    c.route([(690, 182), (648, 182)])
    c.text(40, 340, "merge policies: abort · raise (conflicts quarantined) · prefer_branch · prefer_main",
           size=12.5, anchor="start", fill=MUTED)
    return c


def fig_lifecycle() -> Canvas:
    """Forgetting curve and the hot / cold / deleted tiers."""
    c = Canvas(940, 360, seed=115)
    # Curve plot
    c.arrow(60, 280, 420, 280, stroke=MUTED, width=1.1)
    c.arrow(60, 280, 60, 40, stroke=MUTED, width=1.1)
    c.text(240, 310, "time since last recall", size=12.5, fill=MUTED)
    c.text(48, 52, "R", size=14, anchor="end", fill=MUTED)
    c.line(60, 232, 410, 232, stroke=ACCENT, width=1.0, dashed=True, passes=1)
    c.text(410, 224, "0.2: move to cold", size=12, anchor="end", fill=ACCENT)
    import math

    def curve(s: float) -> str:
        pts = [(60 + t * 3.5, 280 - 220 * math.exp(-t / s)) for t in range(0, 101, 4)]
        return "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts)

    c.raw(f'<path d="{curve(18)}" fill="none" stroke="#1b1b1f" stroke-width="1.6"/>')
    c.raw(f'<path d="{curve(48)}" fill="none" stroke="#1b1b1f" stroke-width="1.6" '
          'stroke-dasharray="6 5"/>')
    c.text(240, 110, "R = e^(−t/S)", size=13, anchor="start", fill=MUTED)
    c.text(260, 140, "each recall raises S", size=12.5, anchor="start", fill=MUTED)
    # Tiers
    c.arrow(640, 92, 700, 92)
    c.arrow(700, 124, 640, 124)
    c.label(670, 76, "R < 0.2")
    c.label(670, 142, "recalled")
    c.arrow(800, 136, 800, 228, dashed=True)
    c.text(812, 166, "opt-in tenants,", size=11.5, anchor="start", fill=MUTED)
    c.text(812, 182, "R < 0.02 and", size=11.5, anchor="start", fill=MUTED)
    c.text(812, 198, "importance < 0.2", size=11.5, anchor="start", fill=MUTED)
    focal(c, 480, 76, 160, 64, "hot", "indexed, recalled")
    c.node(700, 76, 200, 64, "cold", sub="blob segment + stub")
    c.node(700, 228, 200, 60, "deleted", sub="audited", dashed=True)
    c.text(560, 182, "MEM.PIN keeps", size=12.5, fill=MUTED)
    c.text(560, 200, "a memory hot", size=12.5, fill=MUTED)
    return c


def fig_consolidation() -> Canvas:
    """The per-scope tick job and the workers it runs."""
    c = Canvas(940, 320, seed=116)
    c.arrow(190, 100, 246, 100)
    c.label(218, 84, "enqueue")
    c.arrow(436, 100, 498, 100)
    c.route([(340, 70), (340, 34), (290, 34), (290, 70)])
    c.label(316, 20, "next tick (15 min)", size=11.5)
    c.arrow(646, 100, 690, 100)
    c.label(668, 84, "due")
    c.node(24, 70, 166, 60, "memory writes", sub="per user scope")
    focal(c, 246, 70, 190, 60, "tick job", "durable, leased")
    c.diamond(572, 100, 148, 84, "what is\ndue?", size=13)
    c.rect(690, 28, 226, 264, radius=10, fill=PAPER)
    c.text(710, 58, "workers", size=16, anchor="start")
    workers = ["sleep (on a branch)", "evolve links", "dedup", "themes (Louvain)",
               "entity summaries", "forget → cold tier", "re-embed", "cache janitor"]
    for j, w in enumerate(workers):
        c.text(710, 86 + j * 26, w, size=13, anchor="start", fill=MUTED)
    c.text(40, 200, "Every change a worker makes is a replicated", size=12.5, anchor="start", fill=MUTED)
    c.text(40, 218, "command (MemoryMaintain); workers are idempotent", size=12.5, anchor="start", fill=MUTED)
    c.text(40, 236, "and over-budget work is deferred, not failed.", size=12.5, anchor="start", fill=MUTED)
    return c


def fig_degraded() -> Canvas:
    """What happens to a write when the model service is down."""
    c = Canvas(940, 360, seed=117)
    c.arrow(190, 180, 255, 180)
    c.route([(330, 132), (330, 70), (480, 70)])
    c.label(392, 54, "yes")
    c.route([(330, 228), (330, 290), (480, 290)])
    c.label(392, 306, "no")
    c.arrow(680, 290, 736, 290)
    c.arrow(826, 260, 826, 100)
    c.label(826, 180, "models back")
    c.node(24, 152, 166, 56, "remember")
    c.diamond(330, 180, 150, 96, "models\nhealthy?", size=13)
    c.node(480, 40, 200, 60, "full pipeline", sub="facts, vectors, NLI")
    focal(c, 480, 260, 200, 60, "store raw episodic", "reply degraded: true")
    c.node(736, 260, 180, 60, "memory.enrich job", sub="durable, retried")
    c.node(736, 40, 180, 60, "derived facts", sub="derived_from links")
    c.text(470, 186, "breaker opens after 5 failures, for 10 s;", size=12.5, anchor="start", fill=MUTED)
    c.text(470, 204, "recall falls back to keyword + entity", size=12.5, anchor="start", fill=MUTED)
    return c


def fig_cache() -> Canvas:
    """Semantic cache lookup and its dependency-driven invalidation."""
    c = Canvas(940, 380, seed=118)
    c.arrow(170, 88, 226, 88)
    c.arrow(402, 88, 458, 88)
    c.label(430, 72, "miss")
    c.arrow(664, 88, 720, 88)
    c.label(692, 72, "≥ 0.92")
    c.route([(314, 60), (314, 30), (790, 30), (790, 60)])
    c.label(560, 30, "exact hit")
    c.node(24, 60, 146, 56, "prompt")
    c.node(226, 60, 176, 56, "L1: exact", sub="per node")
    c.node(458, 60, 206, 56, "L2: semantic", sub="cosine over the scope")
    focal(c, 720, 60, 196, 56, "cached answer", "plus tokens saved")
    c.text(240, 170, "a miss runs recall, then CACHE.SET … USING <memory ids>", size=12.5,
           anchor="start", fill=MUTED)
    zone(c, 24, 200, 892, 156, "Invalidation, inside apply")
    c.arrow(234, 284, 300, 284)
    c.arrow(610, 284, 676, 284)
    c.node(48, 256, 186, 56, "MEM.FORGET id")
    c.node(300, 256, 310, 56, "apply MemoryForget", sub="same WriteBatch")
    c.node(676, 256, 216, 56, "dependent entries", sub="dropped, never stale")
    return c


def fig_rbac() -> Canvas:
    """How a request is authorized."""
    c = Canvas(940, 340, seed=119)
    c.arrow(166, 100, 206, 100)
    c.arrow(406, 100, 446, 100)
    c.arrow(606, 100, 645, 100)
    c.route([(720, 148), (720, 196), (640, 196), (640, 228)])
    c.route([(795, 100), (830, 100), (830, 228)])
    c.label(672, 180, "allow")
    c.label(866, 160, "deny")
    c.node(24, 72, 142, 56, "request")
    c.node(206, 72, 200, 56, "identify", sub="API key, token, superuser")
    c.node(446, 72, 160, 56, "resolve tenant")
    c.diamond(720, 100, 150, 96, "role +\npolicies", size=13)
    c.node(560, 228, 160, 56, "service call")
    focal(c, 752, 228, 164, 60, "refuse + reason", "written to the audit log")
    c.text(40, 200, "roles: superuser · tenant_admin · developer", size=12.5, anchor="start", fill=MUTED)
    c.text(40, 218, "agent · app_user · readonly", size=12.5, anchor="start", fill=MUTED)
    c.text(40, 244, "deny rows win; agents never get admin actions", size=12.5, anchor="start", fill=MUTED)
    return c


def fig_replica() -> Canvas:
    """An embedded replica: local SQLite copy, offline queue, resumable stream."""
    c = Canvas(940, 380, seed=120)
    zone(c, 254, 24, 360, 332, "EmbeddedReplica · one SQLite file")
    c.route([(180, 168), (226, 168), (226, 106), (290, 106)])
    c.label(226, 136, "recall")
    c.arrow(180, 208, 290, 208)
    c.label(234, 192, "write")
    c.arrow(578, 208, 706, 208)
    c.label(642, 192, "replay in order")
    c.route([(706, 176), (646, 176), (646, 106), (578, 106)], dashed=True)
    c.label(646, 140, "SSE changes")
    c.route([(810, 238), (810, 300), (578, 300)], dashed=True)
    c.label(700, 284, "cursor")
    c.node(24, 150, 156, 80, "your app", sub="TS or Python")
    c.node(290, 76, 288, 60, "memories", sub="BM25 + optional vectors")
    focal(c, 290, 178, 288, 60, "queue", "offline writes, pending")
    c.node(290, 270, 288, 60, "cursors", sub="per followed user")
    c.node(706, 150, 210, 88, "Mindlog node", sub="/api/memory, /api/realtime")
    return c


def fig_backup() -> Canvas:
    """Full backups and the two ways to use one."""
    c = Canvas(940, 330, seed=121)
    c.route([(220, 70), (276, 70), (276, 136), (330, 136)])
    c.arrow(220, 166, 330, 166)
    c.route([(220, 266), (276, 266), (276, 196), (330, 196)])
    c.route([(570, 146), (626, 146), (626, 84), (680, 84)])
    c.route([(570, 186), (626, 186), (626, 236), (680, 236)])
    c.node(24, 40, 196, 60, "node 1", sub="leads r1, r4")
    c.node(24, 136, 196, 60, "node 2", sub="leads r2, r3")
    c.node(24, 236, 196, 60, "placement driver", sub="range 0")
    focal(c, 330, 116, 240, 100, "backups/<id>/", "<rangeId>.snap + .json")
    c.node(680, 54, 236, 60, "backup verify <id>", sub="restore in memory, check")
    c.node(680, 206, 236, 60, "backup restore <id>", sub="new data dir, one-node cluster")
    c.text(450, 270, "POST /api/admin/backups,", size=12.5, fill=MUTED)
    c.text(450, 288, "or every backup.intervalMs", size=12.5, fill=MUTED)
    return c


def fig_jobs() -> Canvas:
    """Durable job states."""
    c = Canvas(880, 300, seed=122)
    c.arrow(200, 136, 330, 136)
    c.label(265, 120, "lease")
    c.arrow(330, 168, 200, 168)
    c.label(265, 186, "fail, backoff 2ⁿ s")
    c.route([(490, 136), (560, 136), (560, 70), (640, 70)])
    c.label(600, 54, "complete")
    c.route([(490, 168), (560, 168), (560, 230), (640, 230)])
    c.label(600, 250, "5th failure")
    c.node(40, 122, 160, 60, "queued")
    focal(c, 330, 122, 160, 60, "leased", "fenced by attempt")
    c.node(640, 40, 180, 60, "done", sub="row deleted")
    c.node(640, 200, 180, 60, "dead", sub="kept, shown on dashboard")
    return c


def fig_collections_write() -> Canvas:
    """Sequence of one record create."""
    c = Canvas(940, 480, seed=123)
    xs = [110, 360, 610, 830]
    names = [("App (SDK)", "token in header"), ("Node", "takes the request"),
             ("Range leader", "of the collection"), ("Blob store", "local or S3")]
    for x, (n, s) in zip(xs, names):
        lifeline(c, x, 20, 460, n, s)
    msg(c, xs[0], xs[1], 116, "POST …/todos/records")
    note(c, xs[1] + 8, 134, 210, "identity, rules as the caller,\nmodifiers, hashes, vectors")
    msg(c, xs[1], xs[3], 230, "put files (after rules pass)")
    msg(c, xs[1], xs[2], 280, "RecordWrite (fenced)", accent=True)
    note(c, xs[2] + 8, 298, 196, "apply: validate, unique\nclaims, index rows, jobs")
    msg(c, xs[2], xs[1], 384, "versions", dashed=True)
    msg(c, xs[1], xs[0], 424, "the record, as you may see it", dashed=True)
    return c


FIGURES = {
    "system-context": fig_system_context,
    "deployment": fig_deployment,
    "layers": fig_layers,
    "log-truth": fig_log_truth,
    "write-path": fig_write_path,
    "raft-loop": fig_raft_loop,
    "range-states": fig_range_states,
    "storage": fig_storage,
    "key-anatomy": fig_key_anatomy,
    "record-anatomy": fig_record_anatomy,
    "ingest": fig_ingest,
    "recall": fig_recall,
    "conflicts": fig_conflicts,
    "branches": fig_branches,
    "lifecycle": fig_lifecycle,
    "consolidation": fig_consolidation,
    "degraded": fig_degraded,
    "cache": fig_cache,
    "rbac": fig_rbac,
    "replica": fig_replica,
    "backup": fig_backup,
    "jobs": fig_jobs,
    "collections-write": fig_collections_write,
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    only = set(sys.argv[1:])
    for name, fig in FIGURES.items():
        if only and name not in only:
            continue
        (OUT / f"{name}.svg").write_text(fig().render())
        print(f"wrote {name}.svg")


if __name__ == "__main__":
    main()
