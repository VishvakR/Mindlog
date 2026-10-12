# syntax=docker/dockerfile:1
# Mindlog server with the dashboard (PLAN 24 phase 2). Build: docker build -t mindlog .
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Production dependencies only, with workspace packages copied in (their dist/ and dashboard/).
RUN pnpm --filter @mindlog/server deploy --legacy --prod /out

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /out .
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 6379 8090
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8090/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["node", "dist/bin.js"]
CMD ["--single-node", "--data-dir", "/data"]
