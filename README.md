# Flash Sale System — High-Concurrency Backend

> **Production-grade, high-concurrency Flash Sale backend** engineered to absorb massive, instantaneous request spikes while **completely preventing overselling**.

A distributed flash-sale platform built for the **Mobile Backend Architecture & Performance Testing** course project. It is architected to remain correct and responsive under thousands of concurrent requests per second, using a Redis-first fast-fail hot path backed by a durable PostgreSQL source of truth.

---

## 1. Project Overview & Core Mission

Flash sales produce the single most hostile traffic pattern in e-commerce: a brief, violent burst of demand against a small, fixed inventory. The system's core mission is to serve that burst with **low latency, absolute inventory correctness, and zero oversell**.

Key guarantees the architecture is built to deliver:

- **No overselling.** Inventory is reserved atomically in Redis and re-validated in PostgreSQL; stock can never fall below zero.
- **Low-latency hot path.** Requests are answered by in-memory Redis state, not by synchronous database round-trips.
- **Horizontal scale-out.** Nginx fans traffic across six stateless NestJS instances; any instance can serve any request.
- **Durable, async writes.** Valid orders are persisted through BullMQ, isolating slow I/O from the request path.
- **Observable behavior.** Cache hit/miss telemetry and structured logs expose exactly how the system performs under load.

The system's philosophy is summarized in one principle: **keep the hot path short, deterministic, and Redis-first, then let the asynchronous worker safely complete the durable workflow in PostgreSQL.**

---

## 2. High-Level Architecture & Connection Flow

### Infrastructure Topology

The platform uses an **event-driven, non-blocking** connection model at the edge and a **stateless** application tier, so session state never lives in a single app instance.

```
        ┌──────────────┐
        │  Clients / k6 │
        └──────┬───────┘
               │  HTTP (stateless)
               ▼
        ┌─────────────────────┐
        │  Nginx (least_conn) │  ← event-driven, non-blocking
        └──────────┬──────────┘   handles persistent user connections
                   │
                   ▼
   ┌───────────────────────────────┐
   │  6 stateless NestJS instances │  (nest-1 … nest-6)
   │  API + BullMQ Worker each     │
   └───────────────┬───────────────┘
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
  ┌─────────────┐      ┌────────────────────┐
  │ Redis :6379 │      │ PostgreSQL         │
  │ state +     │      │  ┌──────────────┐  │
  │ BullMQ      │      │  │ primary :5432│  │
  └─────────────┘      │  │    │ WAL     │  │
                       │  │    ▼         │  │
                       │  │ replica :5433│  │
                       │  └──────────────┘  │
                       └────────────────────┘
```

**Why no sticky sessions:** Nginx routes each request independently using a `least_conn` load-balancing policy. Because **all shared state — inventory, locks, idempotency flags, cache — lives in Redis**, there is no per-user state held in any app instance. This means Nginx can distribute traffic freely across all six instances without session affinity, enabling true horizontal scale-out and seamless failover.

**Read/write split:** writes route to the PostgreSQL **primary**, while reads are load-balanced to the **replica** through TypeORM's `replication` config. Streaming replication (WAL) keeps the replica in sync with the primary.

### Core Service Collaboration

Three NestJS services divide responsibility cleanly across the request lifecycle:

| Service | Role |
|---|---|
| **`BootstrapperService`** | Lightweight startup synchronization — performs an **index-only warm-up** of the active product ID list. |
| **`ProductsService`** | Index-only catalog routing with **on-demand lazy hydration** and **per-product cache telemetry**. |
| **`OrdersService`** | Redis **fast-fail guard**, distributed **concurrency locking**, and **idempotency control** for purchases. |

#### `BootstrapperService` — Lightweight Startup Sync

On application bootstrap, it loads **only** the IDs of active flash-sale products into Redis (`products:id_list`). It deliberately avoids pre-loading full product detail fragments, keeping startup fast and memory footprint minimal. A singleton lock ensures only one instance performs the warm-up.

#### `ProductsService` — Index-Only Routing + Lazy Hydration

Serves catalog reads from a compact Redis index, fetching paginated IDs first, then hydrating **only the missing** static/stock fragments from PostgreSQL on demand. Concurrent cold-start requests are collapsed into a single database fallback (single-flight deduplication), preventing thundering-herd pressure on the database.

#### `OrdersService` — Redis Fast-Fail Guard

Acts as the request gatekeeper: it checks sold-out and already-purchased flags, acquires a per-user/per-product lock, and atomically reserves stock via Redis `DECR` — all **before** any queue work is scheduled. Oversold or duplicate attempts are rejected immediately with HTTP `409 Conflict`.

---

## 3. The Redis Layer (11 State Patterns)

Redis is the system's shared state registry and coordination layer. It holds **11 distinct key patterns**, each engineered for a single, minimal responsibility. This registry is intentionally **light and memory-efficient** — it stores compact IDs, integers, flags, and counters rather than bloated serialized objects.

| # | Key pattern | Purpose |
|---|---|---|
| 1 | `products:id_list` | Active flash-sale product ID index (paginated routing + warm-up). |
| 2 | `product:static:{productId}` | Immutable static product details (name, price, description). |
| 3 | `stock:{productId}` | Atomic inventory counter for reservation. |
| 4 | `product:soldout:{productId}` | Fast-fail flag for exhausted products. |
| 5 | `order:purchased:{userId}:{productId}` | Idempotency flag preventing duplicate purchases. |
| 6 | `order:lock:{userId}:{productId}` | Distributed lock serializing concurrent order attempts. |
| 7 | `products:id_list:warmup_lock` | Startup warm-up singleton lock. |
| 8 | `products:id_list:rebuild_lock` | Cache-rebuild concurrency control lock. |
| 9 | `cache:hits:products` | Atomic read-success telemetry counter. |
| 10 | `cache:misses:products` | Atomic database-fallback telemetry counter. |
| 11 | `cache:tracked:products` | Set tracking active cache keys for invalidation. |

**Design intent:** each pattern solves one narrow problem — indexing (`1`), fragment caching (`2`), atomic stock (`3`), fail-fast flags (`4`, `5`), concurrency control (`6`, `7`, `8`), and observability/invalidation (`9`–`11`). By keeping values tiny and TTLs tight, the entire state layer stays small enough to remain entirely in Redis memory even at scale.

> Full details (types, TTLs, services) are in [docs/README.md](docs/README.md).

---

## 4. Resiliency & Load Testing Insights

### Load Testing (k6)

The system is validated with **k6** under a mixed workload — **1000 concurrent readers** hitting `GET /api/v1/products` and **500 concurrent writers** posting `POST /api/v1/orders` against a single hot product, over a 30-second burst.

### Fast-Fail Rejection Protects the Database

The write path is deliberately front-loaded with Redis checks. Invalid, duplicate, or oversold requests are rejected at the edge with **HTTP 409 Conflict** — *before* any queue entry is created and *before* any PostgreSQL write occurs. This keeps the database from ever being touched by doomed requests, preserving its capacity for legitimate work.

### Clean BullMQ Pipeline (Zero Job Failures)

Because only valid requests survive the Redis guard, the BullMQ queue receives **exclusively legitimate order candidates**. The worker performs a simple, deterministic job — persist the order, decrement inventory with a `remainingStock > 0` guard, and record the idempotency marker. The result is a **failure-free execution pipeline**: overselling never reaches the queue, so there is nothing for jobs to fail on.

### What the Hit Ratio Really Means

The high cache hit ratio is not just "Redis is working" — it is direct evidence of the lazy-hydration strategy succeeding:

- After the first read hydrates a product's fragments, **every subsequent read is served from Redis** with no database fallback.
- Misses are counted **per distinct missing product**, not per request, so the metric reflects genuine database pressure rather than request volume.
- A high hit ratio proves the system absorbs the read burst almost entirely in memory, leaving PostgreSQL to focus on the much smaller, correctly-gated write workload.

---

## 📚 Documentation Map

- **[docs/README.md](docs/README.md)** — deep technical design: full Redis key registry (types/TTLs/services), bootstrap & lazy-loading strategy, and resiliency/failure-handling model.
- **[flash-sale-backend/README.md](flash-sale-backend/README.md)** — backend setup, runtime commands, and API usage.
- **This README** — project overview, architecture entry point, and operational guide (below).

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

# 3. Build + start everything (10 containers)
docker compose up -d --build

# 4. Wait ~30-60s for stack to be healthy
docker compose ps --format "table {{.Names}}{{.Status}}"
# Expected: all 10 containers showing "Up" or "Up (healthy)"
```

### Verify it works

```powershell
# Hit health through Nginx (LB will round-robin across nest-1…nest-6)
1..10 | %{ curl -s http://localhost/health }
# Expected: instanceId cycles between nest-1, nest-2, …, nest-6

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

## 🏗️ Deployment Architecture (10 Services)

### Services (10 total)

| Service | Image | Internal port | Host port | Purpose |
|---|---|---|---|---|
| `nginx` | nginx:1.27-alpine | 80 | 80 | Load balancer |
| `nest-1` | custom (./flash-sale-backend) | 3000 | 3001 (Bull-Board) | API + Worker #1 |
| `nest-2` | custom (./flash-sale-backend) | 3000 | — | API + Worker #2 |
| `nest-3` | custom (./flash-sale-backend) | 3000 | — | API + Worker #3 |
| `nest-4` | custom (./flash-sale-backend) | 3000 | — | API + Worker #4 |
| `nest-5` | custom (./flash-sale-backend) | 3000 | — | API + Worker #5 |
| `nest-6` | custom (./flash-sale-backend) | 3000 | — | API + Worker #6 |
| `redis` | redis:7-alpine | 6379 | 6379 | Cache + BullMQ broker |
| `postgres-primary` | bitnamilegacy/postgresql:16 | 5432 | 5432 | DB primary (TypeORM writes) |
| `postgres-replica` | bitnamilegacy/postgresql:16 | 5432 | 5433 | DB replica (TypeORM reads, streaming replication) |

### Key design choices

| Concern | Solution |
|---|---|
| Read-heavy endpoint | Cache-Aside pattern with Redis (TTL 60s) + key tracking for invalidation |
| Write-heavy endpoint | BullMQ queue + Redis SETNX (30s lock) at API level + atomic SQL at worker |
| Race condition prevention | `UPDATE products SET remainingStock = remainingStock - 1 WHERE remainingStock > 0` |
| Duplicate order prevention | Unique constraint `(userId, productId)` on `orders` table (DB safety net) |
| Read scaling | TypeORM `replication: { master, slaves }` — reads auto-route to replica |
| Schema management | Migrations (not `synchronize`) — runs on app boot via `migrationsRun: true` |
| Connection pooling | max=100 per node (6 instances × 100 = 600 connections to PG) |
| Observability | Structured logs (pino) + trace IDs + Bull-Board dashboard |
| Health checks | `/health/live` (always 200) + `/health/ready` (checks DB+Redis) |

---

## 📁 Project Structure

```
mobile-backend-group-1/
├── docker-compose.yml                 # 10-service stack
├── README.md                          # ← you are here
├── products-seed.json                 # seed data (20 products)
│
├── docker/
│   └── nginx/
│       └── nginx.conf                 # least_conn LB → nest-1…nest-6
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