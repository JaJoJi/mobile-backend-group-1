#!/usr/bin/env bash
# loadtest/diag.sh — capture 4 diagnostic timelines while k6 runs
# Run on the Ubuntu VM where docker compose lives.
# k6 runs separately on your PC.

set -uo pipefail

DURATION="${1:-70}"        # total sampling duration in seconds
OUT_DIR="${2:-loadtest/results/diag-$(date +%Y%m%d-%H%M%S)}"

# prereq check
command -v docker >/dev/null || { echo "ERROR: docker not installed" >&2; exit 1; }
docker compose ps >/dev/null 2>&1 || { echo "ERROR: docker compose stack not running" >&2; exit 1; }

mkdir -p "$OUT_DIR"

echo "=========================================="
echo " Loadtest Diagnostic Capture"
echo "=========================================="
echo "  Duration  : ${DURATION}s"
echo "  Output    : $OUT_DIR"
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

# Sampler 3: PG active/blocked queries
{
  echo "time,epoch_ms,active,blocked,total_conn"
  while true; do
    S=$(docker compose exec -T postgres-primary psql -U app -d flashsale -tA -c "
      SELECT 
        COUNT(*) FILTER (WHERE state='active'),
        COUNT(*) FILTER (WHERE wait_event IS NOT NULL),
        COUNT(*)
      FROM pg_stat_activity WHERE pid != pg_backend_pid();" 2>/dev/null)
    printf "%s,%s,%s\n" \
      "$(date +%H:%M:%S)" "$(date +%s%3N)" "${S:-0,0,0}"
    sleep 1
  done
} > "$OUT_DIR/pg-timeline.csv" 2>/dev/null &
SAMPLERS+=($!)

# Sampler 4: nginx established connections
{
  echo "time,epoch_ms,established"
  while true; do
    N=$(docker compose exec -T nginx sh -c \
        "ss -tan state established 2>/dev/null | wc -l" 2>/dev/null)
    printf "%s,%s,%s\n" \
      "$(date +%H:%M:%S)" "$(date +%s%3N)" "${N:-0}"
    sleep 1
  done
} > "$OUT_DIR/nginx-conns.csv" 2>/dev/null &
SAMPLERS+=($!)

cleanup() {
  echo
  echo "[diag] stopping samplers..."
  for pid in "${SAMPLERS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
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

# summary
{
  echo "=== Diagnostic Capture Summary ==="
  echo "  Output directory   : $OUT_DIR"
  echo
  for f in cache-timeline.csv cpu-timeline.csv pg-timeline.csv nginx-conns.csv; do
    if [ -f "$OUT_DIR/$f" ]; then
      rows=$(wc -l < "$OUT_DIR/$f")
      first=$(head -2 "$OUT_DIR/$f" | tail -1 | cut -c1-19)
      last=$(tail -1 "$OUT_DIR/$f" | cut -c1-19)
      echo "  $f : $rows rows  (first $first, last $last)"
    fi
  done
} | tee "$OUT_DIR/summary.txt"

# tarball for easy sharing
TARBALL="$OUT_DIR.tar.gz"
tar -czf "$TARBALL" -C "$(dirname "$OUT_DIR")" "$(basename "$OUT_DIR")" 2>/dev/null || true

echo
echo "=========================================="
echo " Done. Results:"
echo "   Directory : $OUT_DIR"
[ -f "$TARBALL" ] && echo "   Tarball   : $TARBALL ($(du -h "$TARBALL" | cut -f1))"
echo "=========================================="
echo
echo "To share with me, paste:"
echo "  1. summary.txt contents"
echo "  2. head -15 + tail -5 of each CSV"
echo "  3. base64 $TARBALL  (if small enough)"
