# Todo app

A real app on Mindlog alone: sign-up and sign-in, per-user data enforced by collection rules, file attachments with thumbnails, live updates, and an assistant agent that reads a user's todos through a delegated token.

```bash
pnpm build
mindlog-server superuser upsert admin@example.com 'a long password' --data-dir ./data
MINDLOG_COLLECTIONS__MIGRATIONS_DIR=examples/todo-app/migrations \
  node packages/server/dist/bin.js --single-node --http-port 8090 --data-dir ./data
pnpm --filter todo-app dev   # open the printed URL
```

The agent: `MINDLOG_API_KEY=mlk_… USER_EMAIL=… USER_PASSWORD=… pnpm --filter todo-app agent`. Create the key with `mindlog-server apikey create --tenant default --name assistant` while the server is stopped.

`scripts/phase9-demo.sh` runs the whole flow headless (`DEMO_OTP=1` adds the opt-in OTP sign-in).
