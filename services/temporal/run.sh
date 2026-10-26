#!/bin/sh
# Supervisor for the Evolution `temporal` companion (the upstream command of tb-exec).
#
#  - starts the pinned Temporal dev server (one binary, SQLite file on the service volume, no UI, private network only);
#  - refuses to start on a database whose schema is not the schema of the pinned CLI (the dev server NEVER migrates an
#    existing SQLite file: a newer binary on an older file starts and then fails later, see "Temporal service" in
#    ARCHITECTURE.md);
#  - applies a pending restore (services/temporal/temporal-restore leaves /data/restore/pending.sqlite and stops the
#    server) while the server is stopped, keeping the replaced file as /data/restore/previous.sqlite;
#  - raises the `evolution` namespace retention once the server answers (dev-server namespaces start at 24 h).
# Signals reach this script from tb-exec; a stop signal is forwarded to the server and ends the loop.
set -u

DATA_DIR=${TEMPORAL_DATA_DIR:-/data}
DB="$DATA_DIR/temporal.db"
RESTORE_DIR="$DATA_DIR/restore"
PENDING="$RESTORE_DIR/pending.sqlite"
PIDFILE=${TEMPORAL_PIDFILE:-/tmp/temporal-server.pid}
EXPECTED_SCHEMA=${TEMPORAL_SCHEMA_SHA256_FILE:-/opt/temporal/schema.sha256}
NAMESPACE=evolution
RETENTION=${TEMPORAL_RETENTION:-336h}

log() { printf '%s temporal-run %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

child=0
stopping=0
on_stop() {
  stopping=1
  if [ "$child" -ne 0 ]; then kill -TERM "$child" 2>/dev/null; fi
}
trap on_stop TERM INT QUIT

SCHEMA_HASH=${TEMPORAL_SCHEMA_HASH_CMD:-/opt/temporal/schema-hash}

# 0 = the file has the pinned schema (or there is no file yet); 1 = it does not.
schema_ok() {
  [ -f "$1" ] || return 0
  want=$(cut -d' ' -f1 "$EXPECTED_SCHEMA")
  have=$("$SCHEMA_HASH" "$1")
  if [ "$have" = "$want" ]; then return 0; fi
  log "temporal_schema_mismatch file=$1 have=$have want=$want"
  return 1
}

apply_pending() {
  [ -f "$PENDING" ] || return 0
  if ! schema_ok "$PENDING"; then
    log "restore_rejected: the restored file has another schema than this image"
    mv -f "$PENDING" "$RESTORE_DIR/rejected.sqlite"
    return 0
  fi
  if [ -f "$DB" ]; then mv -f "$DB" "$RESTORE_DIR/previous.sqlite"; fi
  rm -f "$DB-wal" "$DB-shm" "$DB-journal"
  mv -f "$PENDING" "$DB"
  log "restore_applied"
}

set_retention() {
  i=0
  until temporal operator namespace describe --address 127.0.0.1:7233 --namespace "$NAMESPACE" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 180 ]; then log "retention_not_set: server did not answer"; return 1; fi
    sleep 1
  done
  if temporal operator namespace update --address 127.0.0.1:7233 --namespace "$NAMESPACE" --retention "$RETENTION" >/dev/null 2>&1; then
    log "retention_set namespace=$NAMESPACE retention=$RETENTION"
  else
    log "retention_not_set: update failed"
  fi
}

mkdir -p "$RESTORE_DIR"
rm -rf "$DATA_DIR"/.dump.* 2>/dev/null

while :; do
  apply_pending
  if ! schema_ok "$DB"; then exit 78; fi
  temporal server start-dev --headless --ip 0.0.0.0 --port 7233 --db-filename "$DB" --namespace "$NAMESPACE" --log-level warn &
  child=$!
  echo "$child" >"$PIDFILE"
  set_retention &
  helper=$!
  code=0
  while :; do
    wait "$child"
    code=$?
    kill -0 "$child" 2>/dev/null || break
  done
  kill "$helper" 2>/dev/null
  child=0
  rm -f "$PIDFILE"
  if [ "$stopping" -eq 1 ]; then exit "$code"; fi
  if [ -f "$PENDING" ]; then
    log "server stopped for a restore"
    continue
  fi
  log "server exited code=$code"
  exit "$code"
done
