"""Mindlog model service: a stateless gRPC sidecar for local CPU inference (PLAN 14).

The service has no database access and only computes; the Mindlog server calls
it on the Raft leader before proposing, and embeds the results in commands.
"""

__version__ = "0.0.0"
