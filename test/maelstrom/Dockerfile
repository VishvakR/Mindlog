# syntax=docker/dockerfile:1
# Jepsen Maelstrom (EPL, used as a test tool only) around the mindlog-maelstrom
# node binary (docs/references/maelstrom.md). Built by test/maelstrom/run.sh.
ARG BASE=mindlog:maelstrom-base
FROM ${BASE}
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends default-jre-headless gnuplot-nox graphviz git curl bzip2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG MAELSTROM_VERSION=v0.2.4
RUN curl -fsSL "https://github.com/jepsen-io/maelstrom/releases/download/${MAELSTROM_VERSION}/maelstrom.tar.bz2" \
  | tar -xj -C /opt
RUN printf '#!/bin/sh\nexec node /app/dist/maelstrom/main.js\n' > /usr/local/bin/mindlog-maelstrom \
  && chmod +x /usr/local/bin/mindlog-maelstrom
WORKDIR /work
ENTRYPOINT ["/opt/maelstrom/maelstrom"]
CMD ["test", "-w", "lin-kv", "--bin", "/usr/local/bin/mindlog-maelstrom", "--node-count", "3", \
  "--concurrency", "2n", "--time-limit", "60", "--rate", "100", "--nemesis", "partition"]
