#!/usr/bin/env bash
# Reset p-1001 stock to 50, clear orders table, flush Redis cache.
set -euo pipefail

DOCKER=""
for candidate in docker docker.exe; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" version >/dev/null 2>&1; then
    DOCKER="$candidate"
    break
  fi
done

if [ -z "$DOCKER" ]; then
  echo "ERROR: docker (or docker.exe) not found."
  exit 1
fi

COMPOSE_CMD=("$DOCKER" "compose")
: "${POSTGRES_USER:=app}"
: "${POSTGRES_PASSWORD:=app123}"
: "${POSTGRES_DB:=flashsale}"

echo "-> Resetting p-1001 stock to 50 and clearing orders..."
"${COMPOSE_CMD[@]}" exec -T -e "PGPASSWORD=$POSTGRES_PASSWORD" postgres-primary \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'UPDATE products SET "remainingStock" = 50 WHERE "productId" = '\''p-1001'\''; TRUNCATE TABLE "orders";'

echo "-> Flushing Redis cache + counters..."
"${COMPOSE_CMD[@]}" exec -T redis redis-cli FLUSHDB > /dev/null

echo "-> Verifying reset..."
"${COMPOSE_CMD[@]}" exec -T -e "PGPASSWORD=$POSTGRES_PASSWORD" postgres-primary \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT "productId", "remainingStock" FROM products WHERE "productId" = '\''p-1001'\'';'
"${COMPOSE_CMD[@]}" exec -T -e "PGPASSWORD=$POSTGRES_PASSWORD" postgres-primary \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT count(*) AS "orders" FROM orders;'

echo "[OK] Reset complete. Ready for k6 run."
echo "  Run: k6 run --env BASE_URL=http://localhost loadtest/flash-sale.js"