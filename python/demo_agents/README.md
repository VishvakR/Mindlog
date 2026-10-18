# mindlog-demo-agents

The phase 5 demo (PLAN 24): a scripted agent built on the MCP Python SDK. Session 1 tells Mindlog a preference. Session 2 is a new connection with no state in the agent, and it asks a question that needs that preference. The run passes only if the preference comes back from Mindlog.

```bash
# a running node, and a key for it (made while the node is stopped, or POST /api/admin/api-keys)
node packages/server/dist/bin.js apikey create --tenant default --user demo --name demo --data-dir <dir>
cd python
MINDLOG_API_KEY=mlk_… MINDLOG_MCP_URL=http://127.0.0.1:8765/mcp uv run python -m demo_agents
```

`scripts/offline-demo.sh` runs the same agent in Docker on a network with no route out, then runs it again with the model service stopped (degraded mode).
