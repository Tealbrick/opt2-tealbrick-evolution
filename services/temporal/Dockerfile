# Evolution `temporal` companion: the Temporal CLI single binary (MIT, start-dev server + SQLite file on the service
# volume) at a pinned version with a pinned sha256, + sqlite3 for the backup, + the tb-exec layer (every Teal Brick
# companion must claim within 10 minutes). Build context: repository root.
# Bump the CLI version, both sha256 values and services/temporal/schema.sha256 together, in their own Evolution
# release with a backup first (the dev server never migrates an existing SQLite file; see ARCHITECTURE.md).
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS tb
# C62/BSD-10: tb-exec from the integrity-pinned lock (services/temporal/tb-exec), no install scripts.
COPY services/temporal/tb-exec/package.json services/temporal/tb-exec/package-lock.json /opt/tb/
RUN npm ci --prefix /opt/tb --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
# tb-exec reads the app manifest (claim digest, backup) from its default path.
COPY tealbrick.manifest.json /opt/tb/tealbrick.manifest.json

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS cli
ARG TEMPORAL_CLI_VERSION=1.9.1
ARG TEMPORAL_CLI_SHA256_AMD64=09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5
ARG TEMPORAL_CLI_SHA256_ARM64=6c57c352d52fc3df34412376fd9ba6f74b7e3ace8e426e6cba8600156d36a145
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in amd64) sha="$TEMPORAL_CLI_SHA256_AMD64" ;; arm64) sha="$TEMPORAL_CLI_SHA256_ARM64" ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
  && curl -fsSL -o /tmp/temporal.tar.gz "https://github.com/temporalio/cli/releases/download/v${TEMPORAL_CLI_VERSION}/temporal_cli_${TEMPORAL_CLI_VERSION}_linux_${arch}.tar.gz" \
  && echo "${sha}  /tmp/temporal.tar.gz" | sha256sum -c - \
  && mkdir /out && tar -xzf /tmp/temporal.tar.gz -C /out temporal LICENSE \
  && /out/temporal --version | grep -q "temporal version ${TEMPORAL_CLI_VERSION} "

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates sqlite3 && rm -rf /var/lib/apt/lists/*
COPY --from=tb /opt/tb /opt/tb
COPY --from=cli /out/temporal /usr/local/bin/temporal
COPY --from=cli /out/LICENSE /usr/share/doc/temporal-cli/LICENSE
COPY services/temporal/run.sh services/temporal/temporal-dump services/temporal/temporal-restore services/temporal/schema-hash services/temporal/schema.sha256 /opt/temporal/
RUN chmod 0755 /opt/temporal/run.sh /opt/temporal/temporal-dump /opt/temporal/temporal-restore /opt/temporal/schema-hash \
  && mkdir -p /data && chown 1000:1000 /data
EXPOSE 7233
ENTRYPOINT ["node", "/opt/tb/node_modules/@opt2-tealbrick/miniapp-sdk/dist/exec/cli.js", "--"]
CMD ["/opt/temporal/run.sh"]
