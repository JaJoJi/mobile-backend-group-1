#!/usr/bin/env bash
# loadtest/diag.sh — capture 4 diagnostic timelines while k6 runs
# Run on the Ubuntu VM where docker compose lives.
# k6 runs separately on your PC.

set -uo pipefail

DURATION="${1:-70}"        # total sampling duration in seconds
OUT_DIR="${2:-loadtest/results/diag-$(date +%Y%m%d-%H%M%S)}"
LATEST="$(dirname "$OUT_DIR")/latest"

# prereq check
command -v docker >/dev/null || { echo "ERROR: docker not installed" >&2; exit 1; }
command -v ss     >/dev/null || { echo "ERROR: ss (iproute2) not installed" >&2; exit 1; }
docker compose ps >/dev/null 2>&1 || { echo "ERROR: docker compose stack not running" >&2; exit 1; }

mkdir -p "$OUT_DIR"

echo "=========================================="
echo " Loadtest Diagnostic Capture"
echo "=========================================="
echo "  Duration  : ${DURATION}s"
echo "  Output    : $OUT_DIR"
echo "  Latest    : $LATEST"
echo "=========================================="
echo

SAMPLERS=()

# Sampler 1: Redis cache hit/miss timeline
{
  echo "time,epoch_ms,hits,misses"
  while true; do
    R=$(docker compose exec -T redis redis-cli mget \
        cache:hits:products cache:misses:products 2>/dev/null)
    H=$(echo "$R" | sed -n 1p)
    M=$(echo "$R" | sed -n 2p)
    printf "%s,%s,%s,%s\n" \
      "$(date +%H:%M:%S)" "$(date +%s%3N)" "${H:-0}" "${M:-0}"
    sleep 1
  done
} > "$OUT_DIR/cache-timeline.csv" 2>/dev/null &
SAMPLERS+=($!)
echo "cache" > "$OUT_DIR/.sampler-cache.pid"

# Sampler 2: per-instance CPU
{
  echo "time,epoch_ms,nest1,nest2,nest3,nest4,nest5,nest6"
  while true; do
    S=$(docker stats --no-stream nest-1 nest-2 nest-3 nest-4 nest-5 nest-6 \
        --format '{{.Name}},{{.CPUPerc}}' 2>/dev/null)
    F=$(echo "$S" | sort)
    n1=$(echo "$F" | grep '^nest-1,' | cut -d, -f2)
    n2=$(echo "$F" | grep '^nest-2,' | cut -d, -f2)
    n3=$(echo "$F" | grep '^nest-3,' | cut -d, -f2)
    n4=$(echo "$F" | grep '^nest-4,' | cut -d, -f2)
    n5=$(echo "$F" | grep '^nest-5,' | cut -d, -f2)
    n6=$(echo "$F" | grep '^nest-6,' | cut -d, -f2)
    printf "%s,%s,%s,%s,%s,%s,%s,%s\n" \
      "$(date +%H:%M:%S)" "$(date +%s%3N)" \
      "${n1:-0}" "${n2:-0}" "${n3:-0}" "${n4:-0}" "${n5:-0}" "${n6:-0}"
    sleep 1
  done
} > "$OUT_DIR/cpu-timeline.csv" 2>/dev/null &
SAMPLERS+=($!)
echo "cpu" > "$OUT_DIR/.sampler-cpu.pid"

# Sampler 3: PG active/blocked queries
#   - Three sub-queries (instead of FILTER on a single scan) so we always get
#     numbers even if pg_stat_activity changes between calls.
#   - 'active' = currently executing; 'lock_wait' = waiting on a row/table
#     lock; 'total_conn' = every back-end connection (incl. idle pool).
{
  echo "time,epoch_ms,active,lock_wait,total_conn"
  while true; do
    S=$(docker compose exec -T postgres-primary psql -U app -d flashsale -tA -c "
      SELECT
        (SELECT COUNT(*) FROM pg_stat_activity WHERE state='active'),
        (SELECT COUNT(*) FROM pg_stat_activity WHERE wait_event_type='Lock'),
        (SELECT COUNT(*) FROM pg_stat_activity);" 2>/dev/null)
    printf "%s,%s,%s\n" \
      "$(date +%H:%M:%S)" "$(date +%s%3N)" "${S:-0,0,0}"
    sleep 1
  done
} > "$OUT_DIR/pg-timeline.csv" 2>/dev/null &
SAMPLERS+=($!)
echo "pg" > "$OUT_DIR/.sampler-pg.pid"

# Sampler 4: nginx established connections (HOST-side)
#   The nginx container is alpine and doesn't ship `ss`; running the
#   query on the host avoids that and counts every TCP conn to port 80.
{
  echo "time,epoch_ms,established"
  while true; do
    N=$(ss -tan state established 2>/dev/null | awk '$5 ~ /:80$/' | wc -l)
    printf "%s,%s,%s\n" \
      "$(date +%H:%M:%S)" "$(date +%s%3N)" "${N:-0}"
    sleep 1
  done
} > "$OUT_DIR/nginx-conns.csv" 2>/dev/null &
SAMPLERS+=($!)
echo "nginx" > "$OUT_DIR/.sampler-nginx.pid"

# Background heartbeat writer — every 10s, record that samplers are alive.
# If a sampler dies (e.g. docker exec failing) the heartbeat for its csv
# file will stop growing, which is visible in the summary.
(
  while true; do
    for csv in cache-timeline.csv cpu-timeline.csv pg-timeline.csv nginx-conns.csv; do
      rows=$(wc -l < "$OUT_DIR/$csv" 2>/dev/null || echo 0)
      echo "$(date +%H:%M:%S) $csv rows=$rows" >> "$OUT_DIR/.heartbeat.log"
    done
    sleep 10
  done
) &
HEARTBEAT_PID=$!

cleanup() {
  echo
  echo "[diag] stopping samplers..."
  for pid in "${SAMPLERS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  kill "$HEARTBEAT_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[diag] samplers running. Capturing 10s pre-test baseline..."
sleep 10

echo
echo "============================================================"
echo " READY — start k6 on your PC now"
echo "   Command on PC:"
echo "     k6 run --env BASE_URL=http://<VM-IP>:80 \\"
echo "        --out json=loadtest\results\k6-remote.json \\"
echo "        loadtest\flash-sale.js"
echo "============================================================"
echo
echo "[diag] capturing for ${DURATION}s..."
sleep "$DURATION"

cleanup

# Summary file (written BEFORE we create the latest symlink)
SUMMARY="$OUT_DIR/summary.txt"
{
  echo "=== Diagnostic Capture Summary ==="
  echo "  Output directory   : $OUT_DIR"
  echo "  Latest symlink     : $LATEST"
  echo "  Wall-clock span    : $(head -2 "$OUT_DIR/cache-timeline.csv" | tail -1 | cut -d, -f1) → $(tail -1 "$OUT_DIR/cache-timeline.csv" | cut -d, -f1)"
  echo
  for f in cache-timeline.csv cpu-timeline.csv pg-timeline.csv nginx-conns.csv; do
    if [ -f "$OUT_DIR/$f" ]; then
      rows=$(wc -l < "$OUT_DIR/$f")
      first=$(head -2 "$OUT_DIR/$f" | tail -1 | cut -d, -f1)
      last=$(tail -1 "$OUT_DIR/$f" | cut -d, -f1)
      # count non-zero data lines as a proxy for "did this sampler actually capture something?"
      nonzero=$(awk -F, 'NR>1 && ($3!=0 || $4!=0 || $5!=0 || $6!=0 || $7!=0 || $8!=0 || $9!=0)' "$OUT_DIR/$f" | wc -l)
      echo "  $f : $rows rows ($nonzero non-zero)  span $first → $last"
    else
      echo "  $f : MISSING"
    fi
  done
  echo
  echo "  Heartbeat (last 3):"
  tail -3 "$OUT_DIR/.heartbeat.log" 2>/dev/null | sed 's/^/    /'
} | tee "$SUMMARY"

# Latest symlink (overwrites any previous one)
ln -sfn "$OUT_DIR" "$LATEST"

# Tarball for easy sharing
TARBALL="$OUT_DIR.tar.gz"
tar -czf "$TARBALL" -C "$(dirname "$OUT_DIR")" "$(basename "$OUT_DIR")" 2>/dev/null || true

echo
echo "=========================================="
echo " Done. Results:"
echo "   Directory : $OUT_DIR"
echo "   Latest    : $LATEST"
[ -f "$TARBALL" ] && echo "   Tarball   : $TARBALL ($(du -h "$TARBALL" | cut -f1))"
echo "=========================================="
echo
echo "On the VM, paste these commands and send me their output:"
echo "  cat loadtest/results/latest/summary.txt"
echo "  head -15 loadtest/results/latest/cache-timeline.csv"
echo "  tail -n 5 loadtest/results/latest/cache-timeline.csv"
echo "  head -15 loadtest/results/latest/cpu-timeline.csv"
echo "  tail -n 5 loadtest/results/latest/cpu-timeline.csv"
echo "  head -15 loadtest/results/latest/pg-timeline.csv"
echo "  tail -n 5 loadtest/results/latest/pg-timeline.csv"
echo "  head -15 loadtest/results/latest/nginx-conns.csv"
echo "  tail -n 5 loadtest/results/latest/nginx-conns.csv"
echo
echo "On your PC, paste:"
echo "  - the k6 boxed report (between the \u2554 and \u255a lines)"
echo "  - the bottom k6 metrics block"
