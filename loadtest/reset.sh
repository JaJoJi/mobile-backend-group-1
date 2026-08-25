#!/usr/bin/env bash
# Reset p-1001 stock to 50, clear orders table, flush Redis cache.
# Works from: PowerShell (calls WSL bash), WSL, Git Bash, Linux, macOS
#
# Usage:
#   bash loadtest/reset.sh
#   POSTGRES_PASSWORD=other bash loadtest/reset.sh

set -euo pipefail

# Pick the docker binary that actually works in this env
DOCKER=""
for candidate in docker docker.exe; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" version >/dev/null 2>&1; then
    DOCKER="$candidate"
    break
  fi
done

if [ -z "$DOCKER" ]; then
  echo "ERROR: docker (or docker.exe) not found / not responding."
  echo "  Is Docker Desktop running? Is WSL integration enabled?"
  exit 1
fi

# Compose v2 — use an ARRAY so the two tokens stay separate when expanded
COMPOSE_CMD=("$DOCKER" "compose")

if ! "${COMPOSE_CMD[@]}" version >/dev/null 2>&1; then
  echo "ERROR: '$DOCKER compose' not working."
  exit 1
fi

# Defaults match docker-compose.yml (POSTGRES_PASSWORD for the 'app' user)
: "${POSTGRES_USER:=app}"
: "${POSTGRES_PASSWORD:=app123}"
: "${POSTGRES_DB:=flashsale}"

# psql connection command — array of tokens
# forces TCP (no socket) and passes password via env var so psql never prompts
PSQL_CMD=(
  "${COMPOSE_CMD[@]}" exec -T
  -e "PGPASSWORD=$POSTGRES_PASSWORD"
  postgres-primary
  psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
)

echo "→ Using: ${COMPOSE_CMD[*]}"
echo "→ Resetting p-1001 stock to 50 and clearing orders..."
"${PSQL_CMD[@]}" <<'SQL'
UPDATE products SET "remainingStock" = 50 WHERE "productId" = 'p-1001';
TRUNCATE TABLE "orders";
SQL

echo "→ Flushing Redis cache + counters..."
"${COMPOSE_CMD[@]}" exec -T redis redis-cli FLUSHDB > /dev/null

echo "→ Verifying reset..."
"${COMPOSE_CMD[@]}" exec -T -e "PGPASSWORD=$POSTGRES_PASSWORD" postgres-primary \
  psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c \
  "SELECT \"productId\" || ' | ' || \"remainingStock\" FROM products WHERE \"productId\" = 'p-1001';"
"${COMPOSE_CMD[@]}" exec -T -e "PGPASSWORD=$POSTGRES_PASSWORD" postgres-primary \
  psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c \
  "SELECT 'orders count: ' || count(*) FROM orders;"

echo "✓ Reset complete. Ready for k6 run."
echo "  Run: k6 run --env BASE_URL=http://localhost loadtest/flash-sale.js"