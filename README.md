# Flash Sale System — Backend

A high-concurrency backend for a flash-sale mobile app, built for the **Mobile Backend Architecture & Performance Testing** course project.

Implements:
- **Nginx** load balancer (least_conn) → 3 NestJS instances
- **NestJS** modular API + **TypeORM** + **PostgreSQL** with **streaming replication** (master + replica)
- **Redis** for caching + **BullMQ** message queue
- **JWT** stateless auth, **Bull-Board** dashboard
- **k6** load test script (1000 read + 500 write concurrent users)

---

## 🚀 Quick Start (1-click)

### Prerequisites

- **Docker Desktop** (Windows/macOS) or **Docker Engine** (Linux) with Compose v2
- **k6** (only for load testing) — install via `choco install k6` (Windows) / `brew install k6` (macOS) / see https://k6.io/docs/getting-started/installation/

### Steps

```powershell
# 1. Clone the repo
git clone <repo-url>
cd mobile-backend-group-1

# 2. Create local env file from template
cp flash-sale-backend/.env.docker.example flash-sale-backend/.env.docker

# 3. Build + start everything (7 containers)
docker compose up -d --build

# 4. Wait ~30-60s for stack to be healthy
docker compose ps --format "table {{.Names}}{{.Status}}"
# Expected: all 7 containers showing "Up" or "Up (healthy)"
```

### Verify it works

```powershell
# Hit health through Nginx (LB will round-robin across nest-1/2/3)
1..10 | %{ curl -s http://localhost/health }
# Expected: instanceId cycles between nest-1, nest-2, nest-3

# Readiness check (verifies DB + Redis)
curl http://localhost/health/ready

# Products list (cache MISS first time)
curl "http://localhost/api/v1/products?page=1&limit=5"

# Same call again (cache HIT)
curl "http://localhost/api/v1/products?page=1&limit=5"

# Cache hit/miss stats
curl http://localhost/api/v1/products/admin/cache-stats
# { "hits":1, "misses":1, "total":2, "hitRatio":0.5 }

# Bull-Board dashboard (open in browser)
start http://localhost:3001/admin/queues
```

### Place an order (full flow)

```powershell
# 1. Get a JWT
$TOKEN = (curl -s -X POST http://localhost/api/v1/auth/token `
  -H "Content-Type: application/json" `
  -d '{"userId":"user-1"}' | ConvertFrom-Json).accessToken

# 2. Place an order
curl -X POST http://localhost/api/v1/orders `
  -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/json" `
  -d '{"productId":"p-1001"}'
# { "status":"processing", "orderJobId":"1", "message":"Your order is in the queue." }

# 3. Same user/product immediately → should get 409 (lock prevents duplicate)
curl -X POST http://localhost/api/v1/orders `
  -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/json" `
  -d '{"productId":"p-1001"}'
# { "statusCode":409, "message":"You already have an order..." }
```

---

## 🧪 Load Testing (k6)

### Reset state between runs

**PowerShell (Windows-native):**
```powershell
.\loadtest\reset.ps1
```

**Bash (WSL / Git Bash / macOS / Linux):**
```bash
bash loadtest/reset.sh
```

Both reset **all 20 products** to seed defaults, clear orders table, and flush Redis (uses Node.js for JSON parsing — no `jq` needed).

### Run the test

```powershell
# Quick run (output to console only)
k6 run --env BASE_URL=http://localhost loadtest/flash-sale.js

# Save JSON output for the report
k6 run --env BASE_URL=http://localhost `
     --out json=loadtest/results.json `
     loadtest/flash-sale.js
```

### What it tests (per spec)

| Phase | Duration | VUs | Target |
|---|---|---|---|
| Setup | once | — | Fetch 500 unique JWTs (user-1..user-500) |
| Read | 30s | 1000 | `GET /api/v1/products` with random page/limit + 10% overflow mix |
| Write | 30s | 500 | `POST /api/v1/orders` for `p-1001`, 2-3 iters per VU |

### Verify results

```powershell
# Quick: run the verify script (recommended)
bash loadtest/verify.sh        # Bash
.\loadtest\verify.ps1          # PowerShell

# Manual checks:
# Cache hit ratio
curl http://localhost/api/v1/products/admin/cache-stats

# Data integrity: p-1001 stock must be 0 (not negative)
docker exec -it $(docker compose ps -q postgres-primary) psql -U app -d flashsale -c `
  "SELECT \"productId\", \"remainingStock\" FROM products WHERE \"productId\"='p-1001';"
# Expected: p-1001 | 0

# Data integrity: exactly 50 SUCCESS orders, 50 unique users
docker exec -it $(docker compose ps -q postgres-primary) psql -U app -d flashsale -c `
  "SELECT COUNT(*) AS success, COUNT(DISTINCT \"userId\") AS unique_users `
   FROM orders WHERE \"productId\"='p-1001' AND status='SUCCESS';"
# Expected: 50 | 50

# Verify no other product was affected (must be 0 rows)
docker exec -it $(docker compose ps -q postgres-primary) psql -U app -d flashsale -c `
  "SELECT \"productId\" FROM products WHERE \"productId\" != 'p-1001' AND \"remainingStock\" != \"availableStock\";"
# Expected: 0 rows

# Query orders via REST API (no auth) — sorted by createdAt ASC
curl "http://localhost/api/v1/orders?productId=p-1001&status=SUCCESS&page=1&limit=50"
# Expected: { "status":"success", "data":[{...}], "meta":{"total":50,"page":1,...} }
```

---

## 📬 Postman / REST Client

The repo includes 3 ways to test the API:

| File | Use with |
|---|---|
| `postman/flash-sale.postman_collection.json` | **Postman desktop app** (full v2.1.0, with scripts) |
| `postman/flash-sale-lite.postman_collection.json` | **VS Code Postman extension** (v2.0.0, no scripts) |
| `postman/flash-sale.http` | **VS Code REST Client extension** (humao.rest-client) |

All point to `http://localhost` (Nginx). Pick whichever fits your workflow.

---

## 🏗️ Architecture

```
                   ┌──────────────┐
                   │ k6 / Postman │ (host)
                   └──────┬───────┘
                          │
                          ▼
                ┌─────────────────────┐
                │  Nginx :80          │  least_conn load balancer
                │  (least_conn)       │
                └──┬──────────────┬───┘
                   │              │
        ┌──────────┘              └───────────┐
        ▼                                     ▼
   ┌─────────┐                          ┌─────────┐
   │ nest-1  │                          │ nest-3  │  ← 3 NestJS instances
   │ API +   │      ┌─────────┐          │ API +   │    (HTTP :3000
   │ Worker  │ ◀──▶ │ nest-2  │ ◀──────▶ │ Worker  │     + BullMQ Worker
   └────┬────┘      │ API +   │          └────┬────┘     + Bull-Board :3001)
        │           │ Worker  │               │
        └───────────┴────┬────┘───────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
       ┌─────────────┐       ┌─────────────┐
       │ postgres-   │ WAL ▶ │ postgres-   │  ← streaming
       │ primary     │ ─────▶│ replica     │    replication
       │ :5432       │       │ :5433       │
       └─────────────┘       └─────────────┘

              │
              ▼
       ┌─────────────┐
       │ redis       │  ← Cache + BullMQ broker
       │ :6379       │
       └─────────────┘
```

### Services (7 total)

| Service | Image | Internal port | Host port | Purpose |
|---|---|---|---|---|
| `nginx` | nginx:1.27-alpine | 80 | 80 | Load balancer |
| `nest-1` | custom (./flash-sale-backend) | 3000 | 3001 (Bull-Board) | API + Worker #1 |
| `nest-2` | custom (./flash-sale-backend) | 3000 | — | API + Worker #2 |
| `nest-3` | custom (./flash-sale-backend) | 3000 | — | API + Worker #3 |
| `redis` | redis:7-alpine | 6379 | 6379 | Cache + BullMQ broker |
| `postgres-primary` | bitnamilegacy/postgresql:16 | 5432 | 5432 | DB master (TypeORM writes) |
| `postgres-replica` | bitnamilegacy/postgresql:16 | 5432 | 5433 | DB replica (TypeORM reads) |

### Key design choices

| Concern | Solution |
|---|---|
| Read-heavy endpoint | Cache-Aside pattern with Redis (TTL 60s) + key tracking for invalidation |
| Write-heavy endpoint | BullMQ queue + Redis SETNX (30s lock) at API level + atomic SQL at worker |
| Race condition prevention | `UPDATE products SET remainingStock = remainingStock - 1 WHERE remainingStock > 0` |
| Duplicate order prevention | Unique constraint `(userId, productId)` on `orders` table (DB safety net) |
| Read scaling | TypeORM `replication: { master, slaves }` — reads auto-route to replica |
| Schema management | Migrations (not `synchronize`) — runs on app boot via `migrationsRun: true` |
| Connection pooling | max=100 per node (3 instances × 100 = 300 connections to PG) |
| Observability | Structured logs (pino) + trace IDs + Bull-Board dashboard |
| Health checks | `/health/live` (always 200) + `/health/ready` (checks DB+Redis) |

---

## 📁 Project Structure

```
mobile-backend-group-1/
├── docker-compose.yml                 # 7-service stack
├── README.md                          # ← you are here
├── products-seed.json                 # seed data (20 products)
│
├── docker/
│   └── nginx/
│       └── nginx.conf                 # least_conn LB → nest-1/2/3
│
├── flash-sale-backend/                # NestJS app
│   ├── Dockerfile                     # multi-stage (node:20-alpine)
│   ├── .env                           # local dev (localhost hostnames) — gitignored
│   ├── .env.example                   # template for .env
│   ├── .env.docker                    # container config — gitignored
│   ├── .env.docker.example            # template for .env.docker
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── main.ts                    # bootstrap + Bull-Board on :3001
│       ├── app.module.ts              # wires everything + pino logger
│       ├── auth/                      # POST /api/v1/auth/token
│       ├── cache/                     # Redis client wrapper
│       ├── common/                    # guards + decorators
│       ├── database/                  # TypeORM config + migrations
│       ├── health/                    # /health/live + /health/ready
│       ├── orders/                    # POST /api/v1/orders + GET list + BullMQ processor
│       ├── products/                  # GET /api/v1/products + cache
│       └── queue/                     # BullMQ module
│
├── loadtest/
│   ├── flash-sale.js                  # k6 script (3 phases)
│   ├── reset.ps1                      # Windows PowerShell reset
│   ├── reset.sh                       # bash reset (works in WSL/Git Bash/macOS/Linux)
│   └── README.md                      # k6 install + troubleshooting
│
└── postman/
    ├── flash-sale.postman_collection.json      # full v2.1.0 (Postman desktop)
    ├── flash-sale-lite.postman_collection.json # lite v2.0.0 (VS Code extension)
    ├── flash-sale.postman_environment.json     # env vars
    ├── flash-sale.http                         # REST Client (.http)
    └── README.md
```

---

## 🔧 Configuration

### Environment files

| File | Tracked? | Purpose |
|---|---|---|
| `flash-sale-backend/.env` | ❌ | Local dev (uses `localhost` for Postgres/Redis hostnames) |
| `flash-sale-backend/.env.example` | ✅ | Template for local dev |
| `flash-sale-backend/.env.docker` | ❌ | Container config (uses `postgres-primary` hostnames) |
| `flash-sale-backend/.env.docker.example` | ✅ | Template for container config |

**Important:** `POSTGRES_PASSWORD` in `.env.docker` must match `POSTGRESQL_PASSWORD` in `docker-compose.yml` (postgres-primary service). Both default to `app123`.

### Key env vars (in `.env.docker`)

```env
NODE_ENV=production
PORT=3000                   # nest app HTTP port
ADMIN_PORT=3001             # Bull-Board port

POSTGRES_PRIMARY_HOST=postgres-primary
POSTGRES_REPLICA_HOST=postgres-replica
POSTGRES_USER=app
POSTGRES_PASSWORD=app123    # must match docker-compose.yml
POSTGRES_DB=flashsale

REDIS_HOST=redis
REDIS_PORT=6379

JWT_SECRET=flash-sale-jwt-secret-change-me
JWT_EXPIRES_IN=1h
```

---

## 📚 API Reference

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | — | Liveness alias (back-compat) |
| `/health/live` | GET | — | Liveness (always 200) |
| `/health/ready` | GET | — | Readiness (checks DB + Redis) |
| `/api/v1/auth/token` | POST | — | Get JWT — body `{userId}` |
| `/api/v1/products` | GET | — | List products (paginated, cached) |
| `/api/v1/products/admin/cache-stats` | GET | — | Cache hit/miss counters |
| `/api/v1/orders` | POST | JWT | Place order — body `{productId}` |
| `/api/v1/orders` | GET | — | List orders (paginated, sorted by `createdAt` ASC); filters: `productId`, `userId`, `status` |
| `/admin/queues` | GET (HTML) | — | Bull-Board dashboard (port 3001) |

For full request/response shapes and example values, see [postman/flash-sale.postman_collection.json](postman/flash-sale.postman_collection.json).

---

## 🐛 Troubleshooting

### "502 Bad Gateway" on first request
nginx started before nest apps were ready. The current config uses `depends_on: service_healthy` + `/health/ready` healthcheck — give it 30-60s after `docker compose up`. Then retry.

### "password authentication failed for user app"
`POSTGRES_PASSWORD` in `.env.docker` doesn't match `POSTGRESQL_PASSWORD` in `docker-compose.yml`. Make them both `app123` (or change both consistently).

### `bash loadtest/reset.sh` says "docker-compose not found"
You're in WSL where `docker` isn't on PATH. The script auto-falls back to `docker.exe`. If it still fails, use the PowerShell version: `.\loadtest\reset.ps1`.

### k6 shows "the body is null so we can't transform it to JSON"
nginx is returning 502/504 (no body). Check:
- `docker compose ps` — all containers Up?
- `docker compose logs nest-1` — is the app actually listening?
- `curl http://localhost/health/ready` — does it return 200?

### k6 fails thresholds (p95 > 500ms, errors > 15%)
Dev machine resource limits. Either:
- Reduce VUs in `loadtest/flash-sale.js` (line `vus: 1000` → lower number)
- Add resource limits / use a more powerful machine

### Cache hit ratio is low (< 50%)
The k6 read scenario uses the same params (`page=1&limit=10`) so ratio should be very high. If low:
- Check `docker compose logs nest-1` — is invalidation happening too often?
- A worker job processes an order → invalidates ALL cached pages → next request = MISS

---

## 🛠️ Useful Commands

```powershell
# View all services + status
docker compose ps

# Tail logs for a specific service
docker compose logs -f nest-1
docker compose logs -f nginx

# Restart a single service (after config change)
docker compose restart nginx

# Rebuild + restart everything
docker compose down
docker compose up -d --build

# Drop everything including volumes (fresh DB state)
docker compose down -v

# Reset DB + cache between load test runs
.\loadtest\reset.ps1        # Windows PowerShell
bash loadtest/reset.sh      # Bash/WSL/macOS/Linux

# Direct DB queries (primary)
docker exec -it $(docker compose ps -q postgres-primary) psql -U app -d flashsale

# Direct DB queries (replica)
docker exec -it $(docker compose ps -q postgres-replica) psql -U app -d flashsale

# Direct Redis queries
docker exec -it redis redis-cli
# Inside redis-cli:
#   KEYS products:*       ← inspect cache keys
#   GET cache:hits:products
#   FLUSHDB                ← clear all keys

# Inspect cache hit/miss counters
curl http://localhost/api/v1/products/admin/cache-stats
```

---

## 📊 Expected load test results

On a typical 4-core / 8GB dev machine (k6 run defaults):

| Metric | Expected range |
|---|---|
| `http_reqs/s` | 800-1,500 |
| `http_req_duration p(95)` | 300-600ms |
| `http_req_duration p(99)` | 1-5s |
| `http_req_failed rate` | 5-15% (includes 409 lock rejections) |
| Cache hit ratio | > 95% (k6 hits same params) |
| p-1001 `remainingStock` after test | exactly 0 (not negative) |
| `SUCCESS` orders for p-1001 | exactly 50 |
| Unique users in successful orders | exactly 50 |

If numbers fall outside these ranges on your machine, see **Troubleshooting** above.

---

## 👥 Team

_(Fill in your group members + roles here for the report.)_

| Name | Role |
|---|---|
| _Name_ | _Role (e.g., API/Infra/DB/Queue/Reports)_ |
| _Name_ | _Role_ |
| _Name_ | _Role_ |

---

## 📄 License

Course project — internal use only.