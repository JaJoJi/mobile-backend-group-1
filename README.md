# Mobile Backend Architecture & Performance Testing
## Flash Sale System — High-Concurrency Backend (กลุ่ม 1)

> **Production-grade, high-concurrency Flash Sale backend** engineered to absorb massive, instantaneous request spikes while **completely preventing overselling**.
>
> ระบบหลังบ้านสำหรับแอปพลิเคชันมือถือในสถานการณ์ Flash Sale ที่รองรับผู้ใช้จำนวนมากเข้ามาดูสินค้าและสั่งซื้อพร้อมกัน พร้อมระบบป้องกันการขายสินค้าเกินจำนวน (Overselling) และ Cache Invalidation ที่ถูกต้อง

---

## 📑 สารบัญ (Table of Contents)

1. [Project Layout](#1-project-layout)
2. [Quick Start](#2-quick-start)
3. [System Architecture](#3-system-architecture)
4. [Redis State Registry: 11 Key Patterns](#4-redis-state-registry-11-key-patterns)
5. [API Endpoints](#5-api-endpoints)
6. [Concurrency and Race-Condition Defense](#6-concurrency-and-race-condition-defense)
7. [Atomic Lua Fast-Fail](#7-atomic-lua-fast-fail)
8. [Worker Pipeline](#8-worker-pipeline)
9. [Load Test (k6)](#9-load-test-k6)
10. [Operations and Troubleshooting](#10-operations-and-troubleshooting)
11. [Team Members](#11-team-members)

> 📚 **Deeper architecture docs:**
> - `docs/README.md` — mermaid diagrams + Redis key details + bug-fix history
> - `loadtest/README.md` — full k6 reference + ASCII report sample + metric tables

---

## 1. Project Layout

```
mobile-backend-group-1/
├── README.md                        ← you are here (entry point + report PDF source)
├── docker-compose.yml               ← 1-click deploy: nginx + 6×nest + postgres-primary/replica + redis
├── products-seed.json               ← 20 product fixtures (p-1001..p-1020)
│
├── flash-sale-backend/              ← NestJS application (single source)
│   ├── src/
│   │   ├── auth/                    ← POST /api/v1/auth/token — stateless JWT
│   │   ├── products/                ← GET  /api/v1/products — cache-aside + lazy hydration
│   │   ├── orders/                  ← POST /api/v1/orders + BullMQ processor
│   │   ├── cache/                   ← RedisService (Lua + keys + counters)
│   │   ├── bootstrap/               ← BootstrapperService (startup warm-up)
│   │   ├── health/                  ← /health/live, /health/ready
│   │   ├── database/                ← TypeORM + 3 migrations
│   │   └── queue/                   ← BullMQ root + 'orders' queue
│   ├── .env.docker                  ← env template (already present)
│   └── Dockerfile
│
├── docker/nginx/                    ← nginx.conf (least_conn upstream, keepalive)
├── docs/README.md                   ← deep-dive architecture + bug-fix history
│
├── loadtest/                        ← k6 + reset + verify scripts
│   ├── flash-sale.js                ← 5-stage load test (see §9)
│   ├── reset.sh / reset.ps1         ← seed DB + FLUSHDB Redis
│   ├── verify.sh / verify.ps1       ← post-test SQL + Redis integrity check
│   └── README.md                    ← k6 reference
│
└── postman/                         ← Postman collection (12 requests, 5 folders)
    ├── flash-sale.postman_collection.json
    └── flash-sale.postman_environment.json
```

| Path | What lives there |
|---|---|
| `flash-sale-backend/src/` | NestJS modules — every behaviour described in §3–§8 lives here |
| `docker-compose.yml` | 10 services: nginx, 6×nest-{1..6}, postgres-primary, postgres-replica, redis |
| `loadtest/` | k6 + reset/verify scripts (Node.js as JSON parser, no jq needed) |
| `docs/README.md` | Mermaid flow diagrams + Redis registry + bug-fix narrative |
| `postman/` | Manual exploration collection with auto-saved JWT |

---

## 2. Quick Start

### 2.1 Prerequisites
- Docker Desktop (or Docker Engine + Compose v2)
- Node.js LTS — only used by the reset scripts to parse `products-seed.json`
- k6 — only needed for load testing (`choco install k6` / `brew install k6`)

### 2.2 Bring everything up

```bash
git clone <repo-url>
cd mobile-backend-group-1

# 1-click deploy — 10 services come up healthy in ~60 s
docker compose up -d --build

# Verify the stack
docker compose ps --format "table {{.Names}}\t{{.Status}}"
```

You should now have:
| URL | What |
|---|---|
| `http://localhost/health/ready` | Readiness check (DB + Redis ping) |
| `http://localhost/api/v1/products?page=1&limit=10` | Product list (cache miss on first call) |
| `http://localhost/api/v1/products/admin/cache-stats` | `{ hits, misses, total, hitRatio }` |
| `http://localhost:3001/admin/queues` | **Bull-Board** dashboard for the `orders` queue |

### 2.3 Smoke-test a full purchase

```bash
# 1. Mint a JWT
TOKEN=$(curl -s -X POST http://localhost/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"userId":"demo-user"}' | jq -r .accessToken)

# 2. Try to buy p-1001
curl -X POST http://localhost/api/v1/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"productId":"p-1001"}'
# → 202 { "status": "processing", "orderJobId": "...", ... }

# 3. Repeat immediately → 409 (cooldown lock blocks within 3 s)
```

### 2.4 Run the load test

```bash
bash loadtest/reset.sh                                    # clean state
k6 run --env BASE_URL=http://localhost \
       --out json=loadtest/results/summary.json \
       loadtest/flash-sale.js                             # ~60 s wall time
bash loadtest/verify.sh                                   # data-integrity report
```

See §9 for what the k6 report looks like.

---

## 3. System Architecture

### 3.1 Infrastructure Topology

```
                 ┌──────────────┐
                 │  Clients / k6 │
                 └──────┬───────┘
                        │ HTTP (stateless)
                        ▼
             ┌─────────────────────┐
             │  Nginx (least_conn) │  ← event-driven, non-blocking
             └──────────┬──────────┘    keepalive 512, retries on 502/503/504
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
 ┌───────────────────────────────────────────────┐
 │  6 × NestJS instances (nest-1..6)             │
 │  Each instance:                               │
 │    • API server on :3000                      │
 │    • BullMQ worker (concurrency: 2) on :3001  │ ← Bull-Board
 │    • Stateless JWT validation                 │
 └─────────────┬─────────────────────────────────┘
               │
        ┌──────┴──────┐
        ▼             ▼
 ┌─────────────┐ ┌──────────────────────────┐
 │ Redis :6379 │ │ PostgreSQL               │
 │ • Cache     │ │ • Primary :5432 (writes) │
 │ • Lua atomic│ │ • Replica  :5433 (reads) │
 │ • BullMQ    │ │ • Streaming Replication  │
 │ • Cooldowns │ │   via WAL                │
 └─────────────┘ └──────────────────────────┘
```

### 3.2 Why stateless?

| Choice | Reason |
|---|---|
| `least_conn` nginx | Every request can land on any instance — no sticky session needed |
| All state in Redis | Inventory, locks, idempotency flags, cache — shared, atomic |
| Stateless JWT | Each instance can validate any token without a session store |
| Worker on every instance | 12 × 2 = 24 parallel jobs; no separate worker tier to manage |

### 3.3 Read/Write Split (TypeORM replication)

```typescript
replication: {
  master: { host: 'postgres-primary', port: 5432 },
  slaves: [{ host: 'postgres-replica', port: 5432 }],
}
```

- **Writes** (orders worker INSERT/UPDATE) → primary :5432
- **Reads** (product cache hydration) → replica :5433
- Streaming replication keeps them within ~ms of each other

### 3.4 Connection pooling
6 NestJS instances × `max: 100` PG connections = **600 connection ceiling**, per instance `min: 10`, `idleTimeoutMillis: 30 s`.

### 3.5 Service responsibilities

| Module | Responsibility |
|---|---|
| `BootstrapperService` | Startup warm-up — populates only `products:id_list` (index-only, no payload) |
| `ProductsService` | Read path: index routing + lazy hydration + single-flight dedup + cache telemetry |
| `OrdersService` | Atomic Lua fast-fail + DECR + cooldown + BullMQ enqueue (with rollback on enqueue failure) |
| `OrdersProcessor` | Worker — pessimistic PG transaction, post-commit Redis flags, 23505 self-heal |
| `AuthService` | Stateless JWT (HS256, 1 h TTL) |
| `RedisService` | The 11 keys + atomic Lua + cache hit/miss counters |

---

## 4. Redis State Registry: 11 Key Patterns

Redis is the **shared state registry and coordination layer**. Each key has one job (single responsibility) and stores only compact values to keep memory footprint low.

| # | Key pattern | Type | TTL | Role |
|---|---|---|---|---|
| 1 | `products:id_list` | List | 1 h | Active flash-sale product IDs (paginated routing + startup warm-up) |
| 2 | `product:static:{productId}` | String (JSON) | 24 h | Immutable product details (name, price, description, flags) |
| 3 | `stock:{productId}` | String (int) | 1 h | **DECR'd overflow counter** — atomic at API layer, self-heals via hydration |
| 4 | `product:soldout:{productId}` | String flag | 24 h | **Sticky sold-out flag** — set by worker after PG confirms `remainingStock=0` |
| 5 | `order:purchased:{userId}:{productId}` | String flag | 24 h | Idempotency marker — set **post-commit only** |
| 6 | `order:lock:{userId}:{productId}` | String lock | 60 s | In-flight marker covering job lifecycle (worker DELs in `finally`) |
| 7 | `user:cooldown:{userId}:{productId}` | String flag | 3 s | **Same-user dedup** — closes API-vs-worker race window |
| 8 | `products:id_list:warmup_lock` | String lock | 30 s | Startup warm-up singleton lock |
| 9 | `products:id_list:rebuild_lock` | String lock | 10 s | Index-rebuild concurrency control |
| 10 | `cache:hits:products` | Counter | — | Atomic read-success telemetry (Redis `INCR`) |
| 11 | `cache:misses:products` | Counter | — | Atomic DB-fallback telemetry (Redis `INCRBY`) |

### 4.1 Two-layer sold-out defense

```
Layer 1 — Sticky flag (product:soldout:{id}, 24 h)
  └─ Set by worker post-commit when remainingStock hits 0
  └─ Lua fast-fail checks first → returns SOLD_OUT (409)

Layer 2 — DECR counter (stock:{id}, 1 h)
  └─ API Lua atomically DECRs on every accepted order
  └─ If DECR < 0 → INCR rollback + DEL lock + DEL cooldown → TOO_MANY_REQUESTS (429)
  └─ Cold-start protection: missing key → treat as sold-out (over-reject > under-reject)
```

### 4.2 Cache consistency — post-commit Redis writes

```
Worker (holds row lock inside PG transaction):
  1. UPDATE products SET remainingStock = N-1
  2. INSERT INTO orders ... SUCCESS
  3. COMMIT

POST-COMMIT only:
  4. SET order:purchased:{u}:{p} = "1" EX 86400   ← idempotency
  5. if N-1 == 0 → SET product:soldout:{id} = "1" EX 86400
  6. finally: DEL order:lock:{u}:{p}               ← release in-flight marker
```

Why post-commit? If we wrote Redis inside the transaction and `INSERT` or COMMIT failed (e.g. `23505`), PostgreSQL would roll back but Redis would keep a stale flag → false-positive "already purchased" or "sold out" forever. Post-commit guarantees Redis never claims a state the DB didn't durably accept.

### 4.3 Self-healing TTLs

`stock:{id}` carries a 1-hour TTL. When it expires, the next read hydrates the true value from the PG replica. If the worker crashes mid-write, Redis drift self-corrects within an hour.

---

## 5. API Endpoints

All endpoints are routed through nginx on port 80 → least_conn to one of `nest-1..6:3000`.

### 5.1 `POST /api/v1/auth/token` — Mint a JWT

**Request**
```json
{ "userId": "user-42" }
```

**Response 200**
```json
{
  "status": "success",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6Ik..."
}
```

JWT payload: `{ sub: "user-42", iat, exp }` · TTL: 1 h (configurable via `JWT_EXPIRES_IN`).

### 5.2 `GET /api/v1/products` — Read-heavy (cache-aside)

**Query params:** `page` (default 1), `limit` (default 10, max 100)

**Response 200**
```json
{
  "status": "success",
  "data": [
    {
      "productId": "p-1001",
      "name": "Limited Edition Sneaker",
      "description": "...",
      "price": 2990,
      "availableStock": 50,
      "remainingStock": 30,
      "isFlashSaleActive": true
    }
  ],
  "meta": { "total": 20, "page": 1, "limit": 10, "totalPages": 2 }
}
```

**Cache strategy** (see `docs/README.md` for the mermaid flow):
1. `LRANGE products:id_list` to get IDs for the requested page
2. `MGET product:static:{id} + stock:{id}` for those IDs
3. Missing fragments → `loadMissingProducts()` (single-flight dedup) → PG replica → `MSET` cache
4. Hit/miss recorded via Redis atomic `INCR`/`INCRBY`

### 5.3 `POST /api/v1/orders` — Write-heavy (queue)

**Headers:** `Authorization: Bearer <JWT>`

**Request**
```json
{ "productId": "p-1001" }
```

> Quantity is omitted by spec — one user can buy at most 1 unit per product.

**Response 202** (queued for worker)
```json
{
  "status": "processing",
  "orderJobId": "<uuid>",
  "message": "Your order is in the queue."
}
```

**Response 409** (rejected at API Lua, no job created)
```json
{ "status": "conflict", "message": "Product is sold out" }
// or: "You have already purchased this product"
// or: "You already have an order being processed for this product"
```

**Response 429** (DECR overflow)
```json
{ "status": "too_many_requests", "message": "Too much request, try again" }
```

### 5.4 Admin / observability

| Endpoint | Purpose |
|---|---|
| `GET /health` · `/health/live` · `/health/ready` | Liveness + readiness (DB + Redis ping) |
| `GET /api/v1/products/admin/cache-stats` | `{ hits, misses, total, hitRatio }` — read by the k6 report |
| `GET /api/v1/orders?productId=...&status=SUCCESS` | List orders (used by the k6 post-flight to count winners) |
| `http://localhost:3001/admin/queues` | **Bull-Board** UI for the `orders` queue |

---

## 6. Concurrency and Race-Condition Defense

### 6.1 The 7 race conditions we engineered against

| # | Problem | Impact | Defense |
|---|---|---|---|
| 1 | Overselling | Sell more than stock | Redis DECR + PG `SELECT ... FOR UPDATE` |
| 2 | Duplicate purchase | User buys same product twice | `order:purchased` + `user:cooldown` + DB `UNIQUE` |
| 3 | Same-user race (sub-100 ms) | Both clicks get 202 | `user:cooldown` (3 s TTL) |
| 4 | Cold-start flood | After reset, every request passes → queue explodes | Cold-start protection: missing stockKey → `SOLD_OUT` |
| 5 | Lock contention | Many workers hit one row → `55P03` | `concurrency: 2` per instance + `lock_timeout 2 s` + `attempts: 2` |
| 6 | Worker crash mid-process | Job stuck, lock held forever | `lock_timeout 2 s` + `lockKey TTL 60 s` + `finally` DEL |
| 7 | Stale idempotency after `23505` | False-positive "already purchased" for 24 h | `purchasedKey` only set post-commit; on `23505` we set it then return success (self-heal) |

### 6.2 The 5 layers (defense in depth)

1. **Atomic Redis Lua** — single round-trip: cooldown check → sold-out check → stock DECR → lock acquire (see §7).
2. **Per-user in-flight lock** (`order:lock:{u}:{p}`, 60 s) — API Lua acquires, worker `finally` releases.
3. **Same-user cooldown** (`user:cooldown:{u}:{p}`, 3 s) — covers the ~10 ms race between worker COMMIT and the post-commit `purchasedKey` write.
4. **PG pessimistic lock** — `SELECT ... FOR UPDATE` with `lock_timeout = 2 s`. If the row is contended past 2 s, PG raises `55P03` → BullMQ retry.
5. **DB unique constraint** — `UNIQUE("userId", "productId")` on `orders`. The worker's `INSERT` raises `23505` → worker self-heals by setting `purchasedKey` and returns `{ ok: true, reason: 'ALREADY_PURCHASED' }` instead of throwing.

### 6.3 Decision matrix

| Scenario | API Lua | Worker defense | PG guard | DB UNIQUE |
|---|---|---|---|---|
| Stock = 0 in PG | `SOLD_OUT` | `OUT_OF_STOCK` → throw (no FAILED row written) | ✓ | — |
| Same user, within 3 s | `ALREADY_PURCHASED` (cooldown) | `ALREADY_PURCHASED` (purchasedKey re-check) | — | — |
| Same user, after 3 s but within 24 h | `ALREADY_PURCHASED` (purchasedKey) | — | — | — |
| Two requests sub-100 ms | `LOCKED` (lockKey) | — | — | — |
| DECR overflow | `TOO_MANY_REQUESTS` (429) | — | ✓ | — |
| Worker crash mid-process | — | — | ✓ (lock_timeout) | — |
| Concurrent INSERTs that both reach worker | — | — | — | ✓ (23505) |

---

## 7. Atomic Lua Fast-Fail

The Lua script is one round-trip to Redis. Concurrent callers cannot observe intermediate state.

```lua
-- KEYS[1] = cooldownKey     (user:cooldown:{userId}:{productId})
-- KEYS[2] = soldOutKey      (product:soldout:{productId})
-- KEYS[3] = stockKey        (stock:{productId})
-- KEYS[4] = purchasedKey    (order:purchased:{userId}:{productId})
-- KEYS[5] = lockKey         (order:lock:{userId}:{productId})
-- ARGV[1] = lockTtlSeconds  (60)
-- ARGV[2] = cooldownTtlSeconds (3)

-- 1. Same-user cooldown (3 s)
if redis.call('GET', KEYS[1]) then return 'ALREADY_PURCHASED' end

-- 2. Sticky sold-out flag (24 h, set by worker)
if redis.call('GET', KEYS[2]) then return 'SOLD_OUT' end

-- 3. Stock counter — cold-start protection (missing key == sold-out)
local stockVal = redis.call('GET', KEYS[3])
if stockVal == false then return 'SOLD_OUT' end
if tonumber(stockVal) <= 0 then return 'SOLD_OUT' end

-- 4. Idempotency (24 h)
if redis.call('GET', KEYS[4]) then return 'ALREADY_PURCHASED' end

-- 5. Per-user in-flight lock (60 s)
if redis.call('SET', KEYS[5], '1', 'EX', ARGV[1], 'NX') == nil then
  return 'LOCKED'
end

-- 6. Set cooldown BEFORE DECR so we capture both success and overflow paths
redis.call('SET', KEYS[1], '1', 'EX', ARGV[2])

-- 7. DECR with overflow rollback
if stockVal ~= false then
  local newStock = redis.call('DECR', KEYS[3])
  if newStock < 0 then
    redis.call('INCR',  KEYS[3])
    redis.call('DEL',   KEYS[5])
    redis.call('DEL',   KEYS[1])
    return 'TOO_MANY_REQUESTS'
  end
end

return 'OK'
```

**Why Lua (not 7 round-trips)?**
- ✅ No intermediate state visible to concurrent callers — race-free
- ✅ One network round-trip instead of seven (Redis stays under load)
- ✅ Atomic rollback — DECR overflow → INCR + DEL happen together, no orphan state
- ✅ Deterministic under load — same caller set always reaches the same outcome

---

## 8. Worker Pipeline

### 8.1 Worker config

```typescript
@Processor('orders', { concurrency: 2 })
export class OrdersProcessor extends WorkerHost { /* ... */ }
```

```typescript
// OrdersService enqueue options:
{ removeOnComplete: 1000, removeOnFail: 1000, attempts: 2, backoff: { type: 'fixed', delay: 250 } }
```

12 instances × 2 concurrency = **24 parallel jobs** total.

### 8.2 Worker flow

```typescript
async process(job) {
  const { userId, productId } = job.data;
  const lockKey      = `order:lock:${userId}:${productId}`;
  const purchasedKey = `order:purchased:${userId}:${productId}`;
  const soldOutKey   = `product:soldout:${productId}`;

  // 1. Defense-in-depth re-check (API Lua should have caught this, but a
  //    cross-instance race in the ~10 ms after worker post-commit SET is
  //    possible — refuse to write a duplicate SUCCESS row).
  if (await this.redis.get(purchasedKey)) {
    return { ok: true, reason: 'ALREADY_PURCHASED' };
  }

  // 2. Pessimistic transaction (NO Redis writes inside)
  await this.dataSource.transaction(async (manager) => {
    await manager.query('SET LOCAL lock_timeout = 2000');
    const [{ remainingStock }] = await manager.query(
      'SELECT "remainingStock" FROM products WHERE "productId" = $1 FOR UPDATE',
      [productId],
    );
    if (remainingStock <= 0) throw new Error('OUT_OF_STOCK');
    await manager.query(
      'UPDATE products SET "remainingStock" = $1 WHERE "productId" = $2',
      [remainingStock - 1, productId],
    );
    await manager.query(`INSERT INTO "orders" ... SUCCESS ...`);
  }); // COMMIT here — row lock released, PG decrement visible

  // 3. POST-COMMIT: only now is the DB change durable
  await this.redis.set(purchasedKey, '1', 24 * 60 * 60);
  if (remainingStock - 1 === 0) {
    await this.redis.set(soldOutKey, '1', 24 * 60 * 60);
  }
  return { ok: true };
} catch (err) {
  // 4. 23505 (duplicate insert) → self-heal: set the flag, complete cleanly
  if (err instanceof QueryFailedError && err.code === '23505') {
    await this.redis.set(purchasedKey, '1', 24 * 60 * 60);
    return { ok: true, reason: 'ALREADY_PURCHASED' };
  }
  throw err; // any other error → BullMQ retry (attempts: 2, 250 ms backoff)
} finally {
  // 5. Release in-flight marker (worker died? lockKey TTL 60 s catches it)
  await this.redis.del(lockKey);
}
```

### 8.3 Why `concurrency: 2`?

Originally set to `16` (96 parallel jobs across 6 instances). That value was progressively lowered through load testing:

| Concurrency | Instances | Workers | Outcome |
|---|---|---|---|
| 16 (initial) | 6 | 96 | 152 × HTTP 5xx — workers hammering the same `p-1001` row caused measurable `55P03` lock timeouts |
| 4 (after 9 instances) | 9 | 36 | 7 × HTTP 5xx — fine |
| 4 (after 12 instances) | 12 | 48 | 0 × HTTP 5xx but write p95 doubled to 1456 ms — too many workers contending for the row lock |
| **2 (current)** | **12** | **24** | Expected write p95 back to ~700 ms with 0 × HTTP 5xx |

Why 2 keeps the system balanced:
- **24 parallel workers is still plenty** for 50 winners — they finish in ~2 s even with pessimistic locks
- **Lower contention** on the hot `p-1001` row means each worker's `SELECT ... FOR UPDATE` waits less in line
- **Per-instance PG connection usage** stays well under the 100-conn ceiling
- **`lock_timeout = 2 s` + `attempts: 2` + 250 ms backoff** absorb any transient `55P03` that does slip through

The trade-off is throughput: at `concurrency: 2` per instance, peak RPS is ~2000 instead of ~2400. We trade ~400 RPS for a ~50 % reduction in write p95 — the right call given that the assignment targets the latency threshold more strictly than peak throughput.

### 8.4 Why no `@OnWorkerEvent('failed')` stock-compensation handler?

The previous design tried to `INCR stock:{id}` from a `failed` event to "undo" a DECR. We removed it because:
1. DECR happens **at the API layer** (fast-fail), not in the worker. The worker never decrements Redis stock.
2. The DECR only happens **after** Lua has already validated stock > 0. If the worker's transaction then rolls back (`23505`/`OUT_OF_STOCK`/lock timeout), the user already had a stock unit reserved in Redis that they should rightfully keep losing — compensating would let another caller grab a phantom unit.
3. Self-healing is cheaper: the `stockKey` TTL (1 h) means any drift self-corrects on the next cache hydration.

---

## 9. Load Test (k6)

### 9.1 What the script does

`loadtest/flash-sale.js` runs **5 stages**, each announced with its own colored banner:

| Stage | Time | VUs | Banner | Target |
|---|---|---|---|---|
| 0  pre-flight | once | — | `STAGE 0 · PRE-FLIGHT` | `GET /health/ready` + baseline cache stats |
| 1  auth       | once | — | `STAGE 1 · AUTH` | 500 JWTs (user-1 … user-500) with progress every 50 |
| 2  read load  | 30 s | 1000 | (k6 default) | `GET /api/v1/products` with mixed page/limit |
| 3  write load | 30 s | 500  | (k6 default) | `POST /api/v1/orders` for `p-1001`, 2-3 iters/VU |
| 4  post-flight | once | — | `STAGE 4 · POST-FLIGHT` | final cache stats + `GET /api/v1/orders?status=SUCCESS` |

### 9.2 The final report

`handleSummary` writes a single boxed ASCII report covering every deliverable in the spec. Output saved to `loadtest/results/report.txt` (plain) and `loadtest/results/summary.json` (full metrics).

```
╔══════════════════════════════════════════════════════════════════════════╗
║              FLASH SALE — LOAD TEST FINAL REPORT                       ║
╚══════════════════════════════════════════════════════════════════════════╝

┌── 0. STAGE RESULTS ──────────────────────────────────────────────────────────┐
│ STAGE 0  pre-flight  : ✓ OK                                          │
│ STAGE 1  auth setup  : ✓ OK  (500 tokens fetched)                    │
│ STAGE 2  read load   : ✓ OK                                          │
│ STAGE 3  write load  : ✓ OK                                          │
│ STAGE 4  post-flight : ✓ OK                                          │
└────────────────────────────────────────────────────────────────────────────┘

┌── 1. CACHE PERFORMANCE (during test window) ─────────────────────────────────┐
│ hits              : 27000                                                    │
│ misses            : 1500                                                     │
│ total read reqs   : 28500                                                    │
│ hit ratio         : 94.74%    ███████████████████████████░                   │
│ baseline (pre)    : hits=0  misses=0  ratio=0.00%                            │
│ final    (post)   : hits=27000  misses=1500  ratio=94.74%                    │
└────────────────────────────────────────────────────────────────────────────┘

┌── 2. ORDER OUTCOMES (POST /api/v1/orders) ───────────────────────────────────┐
│ HTTP 202  accepted          : 50     █░░░░░░░░░░░░░░░░░░░░░░░░               │
│ HTTP 409  sold-out/dup/lock : 1180   ████████████████████████░               │
│ HTTP 429  too many reqs     : 4      ░░░░░░░░░░░░░░░░░░░░░░░░░               │
│ HTTP 401  auth fail         : 0                                              │
│ HTTP 5xx  server error      : 0                                              │
│ network / timeout           : 0                                              │
│ TOTAL attempts              : 1234                                           │
└────────────────────────────────────────────────────────────────────────────┘

┌── 3. THROUGHPUT & LATENCY ───────────────────────────────────────────────────┐
│ scenario           reqs     req/s    p50    p95    p99    max                │
│ READ  (1k vu)     28500     950.0   2.34   12.5   45.7    123                │
│ WRITE (500vu)      1234      41.1   5.10   28.7   67.3    235                │
│ ALL               29734     495.6   3.10   18.4   52.6    235                │
│ latency unit = ms   |   read status : 2xx=28500  4xx=0  5xx=0  net=0         │
│ infra failure rate  :   0.00%  (target < 1%)                                 │
│ auth setup latency  : avg=   12.3 ms  min=    8.1 ms  max=   45.6 ms        │
└────────────────────────────────────────────────────────────────────────────┘

┌── 4. BUSINESS RULES PROOF (p-1001, stock=50) ────────────────────────────────┐
│ expected winners          : 50                                               │
│ SUCCESS orders in DB      : 50                                               │
│ unique userIds            : 50                                               │
│ no duplicate (u,p) pairs  : ✓ YES                                            │
│ integrity check           : ✓ PASS — no oversell, no underfill              │
└────────────────────────────────────────────────────────────────────────────┘

╔══════════════════════════════════════════════════════════════════════════╗
║  OVERALL VERDICT :  ✓ PASS                                                  ║
╚══════════════════════════════════════════════════════════════════════════╝
```

The 5 boxes map 1:1 to the assignment's deliverables:
- §0 — did every stage finish cleanly?
- §1 — cache hit ratio (called out by the spec as "Cache Performance")
- §2 — queue/order outcomes (the spec's "Queue Monitoring")
- §3 — throughput + p95 latency (the spec's "Throughput & Latency")
- §4 — remainingStock == 0 + 50 unique users (the spec's "Data Integrity Proof")
- Verdict line — single PASS / FAIL gate

### 9.3 Pass / fail semantics

| Layer | Counts as pass | Counts as fail (test exits non-zero) |
|---|---|---|
| HTTP | `200` (read), `202` / `409` / `429` (write) | Any other 4xx, any 5xx, timeout, connection refused, DNS/TLS error |
| Business | `202` = accepted; `409` / `429` = valid rejection | (no business-level fail — every rejection is a valid outcome) |

Thresholds (the script uses a **custom** `http_infra_failures` rate — k6's built-in `http_req_failed` counts every 4xx as failure, including our expected 409/429):

```
http_infra_failures rate                    < 1%    (5xx + timeout + non-409/429/401 4xx)
http_infra_failures{scenario:read_load}     < 1%
http_infra_failures{scenario:write_load}    < 1%
checks rate                                 > 99%   (every check() must pass)
checks{scenario:read_load}                  > 99%
checks{scenario:write_load}                 > 99%
http_req_duration p(95)                     < 500 ms (per scenario too)
```

Per-request timeout: **10 s**.

### 9.4 Custom metrics emitted

| Metric | Type | Used in |
|---|---|---|
| `auth_latency_ms` | Trend | STAGE 1 — auth setup latency (avg/min/max in §3 of report) |
| `read_status_2xx` / `read_status_4xx` / `read_status_5xx` / `read_status_net_err` | Counter | STAGE 2 — per-status read counters |
| `order_accepted_202` | Counter | STAGE 3 — HTTP 202 (job queued) |
| `order_conflict_409` | Counter | STAGE 3 — HTTP 409 (sold-out / duplicate / lock) |
| `order_conflict_429` | Counter | STAGE 3 — HTTP 429 (DECR overflow) |
| `order_auth_fail_401` | Counter | STAGE 3 — HTTP 401 (treat as infra failure) |
| `order_server_5xx` | Counter | STAGE 3 — HTTP 5xx (infra failure) |
| `order_net_err` | Counter | STAGE 3 — timeout / network error |
| `http_infra_failures` | Rate | All stages — drives the PASS/FAIL thresholds |

### 9.5 Read scenario — distributed cache key coverage

Limits are picked uniformly from `[5, 10, 15, 20, 25, 50]`. With 20 products and 6 limit options, the read phase generates between **11 and 60 unique cache keys** (the upper bound comes from the 10 % overflow mix that polls beyond the catalogue — see `loadtest/README.md` §"Read scenario" for the full table).

### 9.6 Write scenario — double/triple-click simulation

Every VU targets `p-1001` (stock 50). 50 % of VUs fire 2 iterations, 50 % fire 3 — so each VU is exercising the same-user dedup path. Total attempts ≈ 1 250. Expected outcome: exactly **50 HTTP 202** and the rest HTTP 409 (cooldown / sold-out / duplicate).

---

## 10. Operations and Troubleshooting

### 10.1 Reset between runs

```bash
# Bash / WSL / Git Bash / macOS / Linux
bash loadtest/reset.sh

# PowerShell (Windows-native)
.\loadtest\reset.ps1
```

Both scripts (Node.js required for JSON parsing — no jq):
1. Read `products-seed.json`
2. `UPDATE products SET "remainingStock" = CASE "productId" WHEN 'p-1001' THEN 50 ... END`
3. `TRUNCATE TABLE orders`
4. `FLUSHDB` Redis (clears cache + counters + BullMQ queues)

### 10.2 Post-test verification

```bash
bash loadtest/verify.sh       # or .\loadtest\verify.ps1
```

6-category integrity report:
1. **Stock integrity** — all 20 products, no negative `remainingStock`
2. **Non-target products** — 19 non-`p-1001` products must be unchanged
3. **`p-1001` target** — `remainingStock = 0`, sold count = SUCCESS count, unique users = SUCCESS count
4. **Order integrity** — no duplicate `(userId, productId)` pairs, total stock-sold = total SUCCESS
5. **Redis cache state** — hit ratio + tracked keys
6. **Summary** — pass/fail counts

### 10.3 Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `setup failed: cannot fetch JWT` | Stack not ready yet | Wait longer after `docker compose up` |
| `connection refused` | Wrong `BASE_URL` | Use `http://localhost` (not `https://`) |
| `All requests time out` | Nginx not up | `docker compose ps` — check `nginx` container |
| `k6: the body is null…` | Nginx returning 502/504 | Check `curl http://localhost/health/ready` |
| `verify: cache hit ratio < 70 %` | 10 % overflow mix pollutes cache | Expected — see "WARN" in report, real hit ratio is computed from the in-test delta in §1 |
| `reset.sh: node: command not found` | Node.js missing | Install Node.js LTS |
| Reset warning: `password authentication failed` | `POSTGRES_PASSWORD` mismatch between compose and `.env.docker` | Change both files together (comment in `.env.docker` reminds you) |

### 10.4 Per-instance logs

```bash
docker compose logs -f nest-1      # one API/worker instance
docker compose logs -f redis       # Lua scripts + DECR + INCR events
docker compose logs -f postgres-primary | grep -E "55P03|23505"
```

Pin instance to debug sticky behaviour:

```bash
# Single-instance testing — kill 5 of 6 so all traffic lands on nest-1
docker compose stop nest-2 nest-3 nest-4 nest-5 nest-6
```

---

## 11. Team Members

| Name | Role | Responsibilities |
|---|---|---|
| _ชื่อ สมาชิก 1_ | _Backend Lead_ | NestJS module structure, Redis Lua atomic script, API endpoints, cache hydration |
| _ชื่อ สมาชิก 2_ | _Database & Worker_ | TypeORM schema + 3 migrations, PG pessimistic locking, BullMQ worker (23505 self-heal) |
| _ชื่อ สมาชิก 3_ | _DevOps & Testing_ | Docker Compose (10 services), Nginx `least_conn`, k6 load test (5 stages + ASCII report), reset/verify scripts |

> TODO: replace the `_ชื่อ สมาชิก N_` placeholders with real names before submission.

---

## 📄 License

Course project — internal use only.
