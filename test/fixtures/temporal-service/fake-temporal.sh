#!/bin/sh
# A stand-in for the `temporal` binary: `server start-dev` creates the database file when it is missing (schema: FAKE_SCHEMA_SQL),
# logs its argv to $FAKE_LOG and runs until TERM; the operator commands only log and succeed.
case "$1 $2" in
  "server start-dev")
    trap 'exit 0' TERM
    echo "start $*" >>"$FAKE_LOG"
    db=""
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--db-filename" ]; then db="$a"; fi
      prev="$a"
    done
    if [ -n "$db" ] && [ ! -f "$db" ]; then sqlite3 "$db" "$FAKE_SCHEMA_SQL"; fi
    while :; do
      sleep 0.2 &
      wait $!
    done
    ;;
  *)
    echo "$*" >>"$FAKE_LOG"
    exit 0
    ;;
esac
