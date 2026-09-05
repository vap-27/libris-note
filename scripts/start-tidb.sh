#!/bin/bash
# Start two local TiDB clusters (standalone unistore mode) for development.
#   Cluster A (books): port 4000, status 10080, data in db/tidb-books
#   Cluster B (notes): port 4001, status 10081, data in db/tidb-notes
#
# Requires a tidb-server binary. Point TIDB_SERVER at yours, e.g.:
#   TIDB_SERVER=$(which tidb-server) bash scripts/start-tidb.sh
# or download TiDB via tiup: https://docs.pingcap.com/tidb/stable/quick-start-with-tidb
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

TIDB_SERVER="${TIDB_SERVER:-$ROOT/tidb/tiup-home/components/tidb/v8.5.8/tidb-server}"
RUN_DIR="$ROOT/tidb/run"
CONF="${TIDB_CONF:-}"
mkdir -p "$RUN_DIR" "$ROOT/db/tidb-books" "$ROOT/db/tidb-notes"

if [ ! -x "$TIDB_SERVER" ]; then
  echo "tidb-server not found at: $TIDB_SERVER"
  echo "Set TIDB_SERVER=/path/to/tidb-server and re-run."
  exit 1
fi

start_cluster() {
  local NAME=$1 PORT=$2 STATUS_PORT=$3 DATA_DIR=$4
  if [ -f "$RUN_DIR/$NAME.pid" ] && kill -0 "$(cat "$RUN_DIR/$NAME.pid")" 2>/dev/null; then
    echo "$NAME already running (pid $(cat "$RUN_DIR/$NAME.pid"))"
    return 0
  fi
  GOMEMLIMIT=320MiB nohup "$TIDB_SERVER" \
    --store=unistore \
    --path="$DATA_DIR" \
    -P "$PORT" \
    --status="$STATUS_PORT" \
    ${CONF:+--config="$CONF"} \
    > "$RUN_DIR/$NAME.stdout" 2> "$RUN_DIR/$NAME.log" &
  echo $! > "$RUN_DIR/$NAME.pid"
  echo "$NAME started (pid $(cat "$RUN_DIR/$NAME.pid")) on port $PORT"
}

start_cluster books 4000 10080 "$ROOT/db/tidb-books"
start_cluster notes 4001 10081 "$ROOT/db/tidb-notes"

echo "Waiting for clusters to accept connections..."
for i in $(seq 1 30); do
  ok_books=$( (exec 3<>/dev/tcp/127.0.0.1/4000) 2>/dev/null && echo yes || echo no )
  ok_notes=$( (exec 3<>/dev/tcp/127.0.0.1/4001) 2>/dev/null && echo yes || echo no )
  if [ "$ok_books" = "yes" ] && [ "$ok_notes" = "yes" ]; then
    echo "BOTH CLUSTERS UP"
    exit 0
  fi
  sleep 2
done
echo "Clusters did not become ready in time; check tidb/run/*.log"
exit 1
