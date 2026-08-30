# Mobile Backend Architecture & Performance Testing
## Flash Sale System — High-Concurrency Backend (กลุ่ม 1)

> **Production-grade, high-concurrency Flash Sale backend** engineered to absorb massive, instantaneous request spikes while **completely preventing overselling**.
>
> ระบบหลังบ้านสำหรับแอปพลิเคชันมือถือในสถานการณ์ Flash Sale ที่รองรับผู้ใช้จำนวนมากเข้ามาดูสินค้าและสั่งซื้อพร้อมกัน พร้อมระบบป้องกันการขายสินค้าเกินจำนวน (Overselling) และ Cache Invalidation ที่ถูกต้อง

---

## 📑 สารบัญ (Table of Contents)

1. [ภาพรวมโปรเจกต์ (Project Overview)](#1-ภาพรวมโปรเจกต์-project-overview)
2. [สถาปัตยกรรมระบบ (System Architecture)](#2-สถาปัตยกรรมระบบ-system-architecture)
3. [Redis State Registry — 11 Key Patterns](#3-redis-state-registry--11-key-patterns)
4. [API Endpoints Specification](#4-api-endpoints-specification)
5. [กลยุทธ์ Cache Invalidation](#5-กลยุทธ์-cache-invalidation)
6. [กลไกป้องกัน Concurrency & Race Condition](#6-กลไกป้องกัน-concurrency--race-condition)
7. [Atomic Lua Fast-Fail Script (Single Round-Trip)](#7-atomic-lua-fast-fail-script-single-round-trip)
8. [Worker Pipeline & Pessimistic Locking](#8-worker-pipeline--pessimistic-locking)
9. [ผลลัพธ์ Load Test](#9-ผลลัพธ์-load-test)
10. [คำแนะนำการ Deploy & การใช้งาน](#10-คำแนะนำการ-deploy--การใช้งาน)
11. [สมาชิกในกลุ่ม (Team Members)](#11-สมาชิกในกลุ่ม-team-members)

---

## 1. ภาพรวมโปรเจกต์ (Project Overview)

### 1.1 ปัญหาที่ต้องแก้

Flash Sale คือสถานการณ์ที่ท้าทายที่สุดใน E-commerce:
- **Request spike มหาศาลในเวลาสั้น** (พัน-หมื่น requests ต่อวินาที)
- **สต็อกจำกัด** (เช่น 50 ชิ้น) แต่มีคนแย่งกันซื้อหลายร้อย-พันคน
- **ต้องป้องกัน Overselling** อย่างเด็ดขาด (ห้ามขายเกินสต็อก)
- **ต้องตอบสนองเร็ว** (Low Latency)
- **ข้อมูลต้องถูกต้อง** (No Race Condition)

### 1.2 หลักการออกแบบหลัก

> **"Keep the hot path short, deterministic, and Redis-first. Let the asynchronous worker safely complete the durable workflow in PostgreSQL."**

แนวคิด: **แยกประเภทงานตามความเหมาะสม**
- **Read path** (GET products) → Redis Cache-Aside + Lazy Hydration
- **Write path** (POST orders) → Redis Fast-Fail (atomic Lua) → BullMQ Async → Worker PG Pessimistic Lock
- **Recovery** → Single-flight dedup + self-heal TTL

### 1.3 ผลลัพธ์ที่บรรลุ (Achieved Goals)

| เป้าหมาย | ผลลัพธ์ |
|---|---|
| ✅ งาน 50 ชิ้นขายได้ครบ | 50/50 SUCCESS orders |
| ✅ ผู้ใช้ 50 คนได้ของคนละ 1 ชิ้น | 50 unique users |
| ✅ remainingStock = 0 พอดี (ไม่ติดลบ) | verified |
| ✅ ป้องกัน Overselling | DB guard + Redis DECR |
| ✅ 0 Wasted jobs | BullMQ failed = 0 |
| ✅ 0 Wasted PG transactions | (lock contention eliminated) |

---

## 2. สถาปัตยกรรมระบบ (System Architecture)

### 2.1 Infrastructure Topology

```
                ┌──────────────┐
                │  Clients / k6 │
                └──────┬───────┘
                       │ HTTP (stateless)
                       ▼
            ┌─────────────────────┐
            │  Nginx (least_conn) │  ← event-driven, non-blocking
            └──────────┬──────────┘    handles persistent user connections
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
┌────────────────────────────────────────────────┐
│   6 stateless NestJS instances (nest-1..6)     │
│   • Each: API + BullMQ Worker (concurrency:2)   │
│   • Stateless JWT auth                          │
└─────────────┬──────────────────────────────────┘
              │
       ┌──────┴──────┐
       ▼             ▼
┌─────────────┐ ┌──────────────────────────┐
│ Redis :6379 │ │ PostgreSQL               │
│ • Cache     │ │ • Primary :5432 (writes) │
│ • Lua atomic│ │ • Replica  :5433 (reads) │
│ • BullMQ    │ │ • Streaming Replication │
│ • Cooldowns │ │   (WAL)                  │
└─────────────┘ └──────────────────────────┘
```

### 2.2 ทำไมไม่ใช้ Sticky Session

**Nginx** ใช้ `least_conn` Load Balancing Policy โดย:
- **ทุก request เป็น stateless** → Nginx กระจายไปยัง instance ใดก็ได้
- **State ทั้งหมดอยู่ใน Redis** (inventory, locks, idempotency flags, cache)
- **Horizontal Scale-out** ได้เต็มที่ — เพิ่ม instance เมื่อโหลดสูง
- **Seamless Failover** — instance ตาย → traffic ไป instance อื่นทันที

### 2.3 Read/Write Split (Database)

ใช้ TypeORM `replication` config:
- **Writes** (POST orders worker) → `postgres-primary:5432`
- **Reads** (GET products hydration) → `postgres-replica:5433`
- **Streaming Replication** (WAL) ซิงค์ข้อมูลจาก primary → replica

```typescript
replication: {
  master:  { host: 'postgres-primary', port: 5432 },
  slaves:  [{ host: 'postgres-replica', port: 5432 }],
}
```

### 2.4 Connection Pooling

```
6 NestJS instances × max:100 connections = 600 connections total
per instance: min:10, idle:30s, connect timeout:5s
```

### 2.5 บริการหลัก (Core Services)

| Service | บทบาท |
|---|---|
| **`BootstrapperService`** | Warm-up `products:id_list` ตอน startup (index-only, ไม่โหลด payload) |
| **`ProductsService`** | Read path หลัก — index-only routing + lazy hydration + cache telemetry |
| **`OrdersService`** | Fast-fail guard + DECR overflow tracker + cooldown + BullMQ enqueue |
| **`OrdersProcessor`** (Worker) | Pessimistic PG lock + post-commit Redis update |
| **`AuthService`** | JWT generation (stateless) |

---

## 3. Redis State Registry — 11 Key Patterns

### 3.1 ตาราง Key Patterns

Redis ถือเป็น **shared state registry และ coordination layer** โดยใช้ 11 key patterns ที่ออกแบบมาให้แต่ละ key มีหน้าที่เดียว (Single Responsibility) และเก็บค่าขนาดเล็ก (compact IDs, integers, flags) เพื่อให้ Redis memory footprint ต่ำ

| # | Key Pattern | Type | TTL | บทบาท |
|---|---|---|---|---|
| 1 | `products:id_list` | List | 1 ชม. | Active flash-sale product ID index (paginated routing + warm-up) |
| 2 | `product:static:{productId}` | String (JSON) | 24 ชม. | Static product details (name, price, description) |
| 3 | `stock:{productId}` | String (int) | 1 ชม. | **Short-TTL overflow counter** — DECR'd atomically ที่ API layer |
| 4 | `product:soldout:{productId}` | String flag | 24 ชม. | **Sticky sold-out flag** — authoritative signal จาก worker (PG confirms stock=0) |
| 5 | `order:purchased:{userId}:{productId}` | String flag | 24 ชม. | Idempotency marker (set post-commit หลัง COMMIT สำเร็จ) |
| 6 | `order:lock:{userId}:{productId}` | String lock | 60 วินาที | In-flight marker (ครอบคลุมทั้ง job lifecycle) |
| 7 | `user:cooldown:{userId}:{productId}` | String flag | 3 วินาที | **Same-user dedup** — ปิด race window ระหว่าง API Lua และ worker post-commit SET |
| 8 | `products:id_list:warmup_lock` | String lock | 30 วินาที | Startup warm-up singleton lock |
| 9 | `products:id_list:rebuild_lock` | String lock | 10 วินาที | Cache-rebuild concurrency control |
| 10 | `cache:hits:products` | Counter | - | Atomic read-success telemetry |
| 11 | `cache:misses:products` | Counter | - | Atomic DB-fallback telemetry |

### 3.2 Two-Layer Sold-Out Defense

ระบบมี **2 ชั้น** ในการป้องกัน overselling:

**Layer 1: Sticky Flag** (`product:soldout:{id}`, TTL 24h)
- Worker ตั้งค่าเมื่อ PG ยืนยัน `remainingStock=0` (post-commit หลัง COMMIT สำเร็จ)
- ProductsService hydration ก็ตั้งค่าถ้า hydrate มาเจอ 0
- Lua fast-fail เช็คตัวนี้เป็นชั้นแรก → SOLD_OUT 409

**Layer 2: DECR Counter** (`stock:{id}`, TTL 1 ชม.)
- API Lua DECR ทุกครั้งที่ผ่าน
- ถ้า DECR ติดลบ → INCR rollback + DEL lock + DEL cooldown → return `TOO_MANY_REQUESTS` (HTTP 429)
- Cold-start protection: ถ้า key หาย → ถือว่า sold-out (over-reject ปลอดภัยกว่า under-reject)

### 3.3 Cache Consistency: Post-Commit Redis Update

Worker (หลัง COMMIT สำเร็จ) SETs ค่าใหม่:
- `order:purchased:{u}:{p} = "1", EX 86400` — idempotency marker (เฉพาะเมื่อ INSERT สำเร็จ)
- ถ้า `N-1==0` → `product:soldout:{id} = "1", EX 86400` — sticky flag

Worker ปลด lock ใน `finally`:
- `DEL order:lock:{u}:{p}` — release in-flight marker

---

## 4. API Endpoints Specification

### 4.1 Authentication — POST /api/v1/auth/token

จำลอง Login เพื่อรับ JWT

**Request Body:**
```json
{ "userId": "user-999" }
```

**Response 200 OK:**
```json
{
  "status": "success",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6Ik..."
}
```

JWT Payload:
```json
{ "sub": "user-999", "iat": ..., "exp": ... }
```
TTL: 1 ชั่วโมง (configurable ผ่าน `JWT_EXPIRES_IN`)

### 4.2 GET /api/v1/products (Read-Heavy)

ดึงรายการสินค้าแบบ Paginated พร้อม Cache-Aside

**Query Parameters:**
- `page` (default: 1) — หน้าที่ต้องการ
- `limit` (default: 10) — จำนวนต่อหน้า

**Response 200 OK:**
```json
{
  "status": "success",
  "data": [
    {
      "productId": "p-1001",
      "name": "Limited Edition Sneaker",
      "description": "รองเท้ารุ่นลิมิเต็ด ยอดฮิตสำหรับนักสะสม",
      "price": 2990,
      "availableStock": 50,
      "remainingStock": 30,
      "isFlashSaleActive": true
    }
  ],
  "meta": {
    "total": 20,
    "page": 1,
    "limit": 10,
    "totalPages": 2
  }
}
```

**Cache Strategy:**
1. `LRANGE products:id_list` ดึง IDs ตาม page
2. `MGET product:static:{id} + stock:{id}` สำหรับ IDs ทั้งหมด
3. ถ้า fragment ใดขาด → `loadMissingProducts()` (single-flight dedup) → query PG → MSET cache

### 4.3 POST /api/v1/orders (Write-Heavy)

จำลองการจองสินค้า (Limit 1 ต่อ User ต่อ Product)

**Headers:**
```
Authorization: Bearer <JWT_ACCESS_TOKEN>
Content-Type: application/json
```

**Request Body:**
```json
{ "productId": "p-1001" }
```

**Response 202 Accepted:**
```json
{
  "status": "processing",
  "orderJobId": "1",
  "message": "Your order is in the queue."
}
```

**Response 409 Conflict** (SOLD_OUT / ALREADY_PURCHASED / LOCKED):
```json
{
  "status": "conflict",
  "message": "Product is sold out"
}
```

**Response 429 Too Many Requests** (DECR overflow):
```json
{
  "status": "too_many_requests",
  "message": "Too much request, try again"
}
```

**Business Rules:**
- ✅ Limit 1 per user per product (enforced ทั้ง API + Worker + DB unique constraint)
- ✅ JWT validation (stateless)
- ✅ Atomic Redis fast-fail (single round-trip)
- ✅ BullMQ enqueue (asynchronous persistence)

---

## 5. กลยุทธ์ Cache Invalidation

### 5.1 ทำไมต้อง Cache Invalidation ที่ดี

API GET /api/v1/products ต้องคืนค่า `remainingStock` ที่ถูกต้องเสมอ ดังนั้นเมื่อ worker ตัดสต็อกสำเร็จ ระบบต้อง update cache ทันที

### 5.2 Invalidation Strategy: Post-Commit Redis Update

```
┌─────────────────────────────────────────────────────────┐
│  Worker (row lock held inside PG transaction):           │
│                                                          │
│  1. UPDATE products SET remainingStock = N-1             │
│  2. INSERT order                                         │
│  3. COMMIT                                               │
│                                                          │
│  4. POST-COMMIT: SET order:purchased:{u}:{p} = "1"      │
│     EX 86400                                             │
│  5. POST-COMMIT: if N-1 == 0 → SET product:soldout:{id} │
│     = "1", EX 86400                                      │
│  6. finally: DEL order:lock:{u}:{p}                      │
│                                                          │
│  Redis เขียนเฉพาะเมื่อ DB COMMIT สำเร็จ → ไม่เกิด         │
│  false-positive sold-out / purchased หลัง DB rollback    │
│  (เช่น 23505 duplicate-key failure)                      │
└─────────────────────────────────────────────────────────┘
```

### 5.3 Self-Healing via Short TTL

- `stock:{id}` TTL = **1 ชั่วโมง** (เคยเป็น 30 วินาที ซึ่งสั้นเกินไป ทำให้ race condition ระหว่าง Read+Write phase ใน load test)
- เมื่อ TTL หมด → next read จะ hydrate ใหม่จาก PG replica (จริง)
- ถ้า cache drift (เช่น worker crash) → self-heal ภายใน 1 ชม.

### 5.4 Cold-Start Protection

ถ้า Redis ถูก flush หรือ TTL หมด:
- ทั้ง `stockKey` และ `soldoutKey` หาย
- Lua fast-fail จะ return `SOLD_OUT` (over-reject ปลอดภัยกว่า under-reject)
- Next `GET /api/v1/products` จะ hydrate ทั้งสอง keys กลับมา
- ระหว่างนั้น writes จะถูก block → ไม่มี flood เข้า queue

---

## 6. กลไกป้องกัน Concurrency & Race Condition

### 6.1 Race Conditions ที่ต้องป้องกัน

| # | ปัญหา | ผลกระทบ | กลไกป้องกัน |
|---|---|---|---|
| 1 | **Overselling** | ขายสินค้าเกินสต็อก → ลูกค้าได้ของที่ไม่มี | Redis DECR + PG `SELECT FOR UPDATE` |
| 2 | **Duplicate Purchase** | User 1 คนซื้อสินค้าเดียวกัน 2 ครั้ง | `order:purchased` + `user:cooldown` + DB UNIQUE |
| 3 | **Same-User Race** | User กด 2 ครั้งใน 100ms ทั้ง 2 ได้ 202 | `user:cooldown` (3s TTL) |
| 4 | **Cold-Start Flood** | หลัง reset, ทุก request ผ่าน → queue ระเบิด | Cold-start protection (SOLD_OUT เมื่อ stock หาย) |
| 5 | **Lock Contention** | 60 workers ชน row lock → 55P03 | `concurrency: 2` per worker + `attempts: 2` retry |
| 6 | **Worker Crash Mid-Process** | Job ค้างใน queue, lock ไม่ถูกปลด | `lock_timeout = 2000ms` (auto-recover) + `attempts: 2` |
| 7 | **Stock Fragment Stale** | `stockKey` ไม่ sync กับ PG หลัง worker SET | Worker ไม่ SET stockKey (DECR เป็น authoritative) |

### 6.2 การป้องกัน Concurrency ในแต่ละ Layer

#### **Layer 1: Redis Atomic Lua (API Hot Path)**

5 ขั้นตอน atomic ใน single round-trip (ดู Section 7)

#### **Layer 2: Per-User In-Flight Lock** (`order:lock:{u}:{p}`)

- **Acquire**: API Lua `SET NX EX 60`
- **Release**: Worker `finally: DEL`
- **ผลลัพธ์**: ป้องกัน user เดียวกันกดพร้อมกันหลาย request ในจังหวะเดียว

#### **Layer 3: Same-User Cooldown** (`user:cooldown:{u}:{p}`)

- **Set**: API Lua atomically หลัง lock acquire (TTL 3 วินาที)
- **Check**: API Lua เช็คเป็นชั้นแรกสุด
- **ปิด race window**: ระหว่าง worker `COMMIT` และ Redis `order:purchased` post-commit write

**ทำไมต้องมี cooldown แยก?** เพราะ:
- `lockKey` ถูก release ใน ~10ms (หลัง worker DEL)
- แต่ `purchasedKey` อาจจะยังไม่ visible ในช่วง 10-50ms (network/race)
- Cooldown 3s ครอบคลุม race window นี้

#### **Layer 4: PG Pessimistic Lock** (Worker)

```sql
BEGIN;
SET LOCAL lock_timeout = 2000;
SELECT remainingStock FROM products WHERE productId = $1 FOR UPDATE;
-- ถ้า N > 0 → UPDATE และ INSERT
-- ถ้า N <= 0 → throw OUT_OF_STOCK (ไม่เขียน FAILED row)
COMMIT;
```

#### **Layer 5: DB Unique Constraint** (Defense-in-Depth)

```sql
ALTER TABLE orders ADD CONSTRAINT UQ_orders_user_product UNIQUE (userId, productId)
```

แม้ทุก layer ก่อนหน้าพลาด DB ก็จะปฏิเสธ INSERT ที่ซ้ำ → 23505 → rollback ทั้ง transaction

### 6.3 ตาราง Decision Matrix: ใครจัดการอะไร

| สถานการณ์ | API Lua | Worker Defense | PG Guard | DB UNIQUE |
|---|---|---|---|---|
| ของหมด (stock=0 ใน PG) | `SOLD_OUT` | `OUT_OF_STOCK` → throw (no row) | ✓ | - |
| User ซื้อซ้ำ (กด 2 ครั้งใน 3s) | `ALREADY_PURCHASED` (cooldown) | `ALREADY_PURCHASED` | - | - |
| User ซื้อซ้ำ (หลัง 3s แต่ใน 24h) | `ALREADY_PURCHASED` (purchasedKey) | - | - | - |
| User กดพร้อมกัน (sub-100ms) | `LOCKED` (lockKey) | - | - | - |
| Overflow (DECR < 0) | `TOO_MANY_REQUESTS` (429) | - | ✓ | - |
| Worker crash mid-process | - | - | ✓ (lock_timeout) | - |
| Worker 23505 race | - | - | - | ✓ |

---

## 7. Atomic Lua Fast-Fail Script (Single Round-Trip)

### 7.1 โค้ด Lua Script (เรียกใช้ผ่าน EVAL)

```lua
-- KEYS[1] = cooldownKey     (user:cooldown:{userId}:{productId})
-- KEYS[2] = soldOutKey      (product:soldout:{productId})
-- KEYS[3] = stockKey        (stock:{productId})
-- KEYS[4] = purchasedKey    (order:purchased:{userId}:{productId})
-- KEYS[5] = lockKey         (order:lock:{userId}:{productId})
-- ARGV[1] = lockTtlSeconds  (60)
-- ARGV[2] = cooldownTtlSeconds (3)

-- Step 1: Same-user cooldown (ปิด same-user race window 3s)
if redis.call('GET', KEYS[1]) then return 'ALREADY_PURCHASED' end

-- Step 2: Sticky sold-out flag (จาก worker เมื่อ PG=0)
if redis.call('GET', KEYS[2]) then return 'SOLD_OUT' end

-- Step 3: Stock counter (with cold-start protection)
local stockVal = redis.call('GET', KEYS[3])
if stockVal == false then return 'SOLD_OUT' end  -- cold-start
if tonumber(stockVal) <= 0 then return 'SOLD_OUT' end

-- Step 4: Idempotency (24h)
if redis.call('GET', KEYS[4]) then return 'ALREADY_PURCHASED' end

-- Step 5: Per-user in-flight lock
if redis.call('SET', KEYS[5], '1', 'EX', ARGV[1], 'NX') == nil then
  return 'LOCKED'
end

-- Step 6: Set cooldown (atomic กับ lock)
redis.call('SET', KEYS[1], '1', 'EX', ARGV[2])

-- Step 7: DECR with overflow rollback
if stockVal ~= false then
  local newStock = redis.call('DECR', KEYS[3])
  if newStock < 0 then
    redis.call('INCR', KEYS[3])
    redis.call('DEL', KEYS[5])
    redis.call('DEL', KEYS[1])
    return 'TOO_MANY_REQUESTS'
  end
end

return 'OK'
```

### 7.2 ทำไมต้องเป็น Atomic Lua

✅ **ไม่มี race condition** — ทุก check/set/decrement เกิดใน single Lua execution
✅ **Performance** — 1 round-trip แทนที่จะ 7 trips
✅ **Deterministic** — concurrent requests ไม่เห็น intermediate state
✅ **Atomic rollback** — DECR overflow → INCR + DEL locks (all atomic)

---

## 8. Worker Pipeline & Pessimistic Locking

### 8.1 Worker Flow (orders.processor.ts)

```typescript
@Processor('orders', { concurrency: 2 })  // 12 parallel jobs total (6 instances × 2)
export class OrdersProcessor {
  async process(job) {
    // 1. Defense check
    if (await this.redis.get(purchasedKey)) {
      throw new Error('ALREADY_PURCHASED');
    }

    await this.dataSource.transaction(async (manager) => {
      // 2. Pessimistic PG lock
      await manager.query('SET LOCAL lock_timeout = 2000');
      const rows = await manager.query(
        'SELECT remainingStock FROM products WHERE productId = $1 FOR UPDATE',
        [productId],
      );
      const remainingStock = Number(rows[0].remainingStock);

      // 3. PG guard
      if (remainingStock <= 0) {
        throw new Error('OUT_OF_STOCK');
      }

      // 4. Atomic decrement
      await manager.query(
        'UPDATE products SET remainingStock = $1 WHERE productId = $2',
        [remainingStock - 1, productId],
      );

      // 5. INSERT order (no Redis writes in-tx)
      await manager.query(`INSERT INTO orders ... SUCCESS ...`);
    }); // COMMIT here — row lock released

    // POST-COMMIT: Redis writes only after DB commit succeeds
    await this.redis.set(purchasedKey, '1', 24 * 60 * 60);
    if (remainingStock - 1 === 0) {
      await this.redis.set(soldOutKey, '1', 24 * 60 * 60);
    }
  } finally {
    // Release lock
    await this.redis.del(lockKey);
  }
}
```

### 8.2 ทำไม `concurrency: 2`?

- **ก่อนหน้านี้** (`concurrency: 10`): 60 workers ชน row lock เดียวกัน → `canceling statement due to lock timeout` (PG 55P03)
- **ตอนนี้** (`concurrency: 2`): 12 parallel workers → minimal contention → 0 lock timeouts
- **Trade-off**: throughput ลดลง (12 jobs/sec vs 60 jobs/sec) แต่ 50 jobs จบใน < 5s (เร็วพอ)

### 8.3 ทำไม `attempts: 2` + Backoff?

- Transient errors (เช่น 55P03, network blip) → retry หลัง 250ms
- โอกาสสำเร็จในครั้งที่ 2 สูง (lock queue clear)
- Final result: 0 งานหายจาก lock_timeout

### 8.4 ทำไม `purchasedKey` ต้อง set หลัง `COMMIT`?

- **ปัญหาเดิม**: ถ้า set Redis ใน transaction ก่อน `COMMIT` แล้ว `INSERT` หรือ transaction ล้ม (เช่น `23505`), PostgreSQL rollback แต่ Redis ยังมี stale flag → เกิด false-positive sold-out / purchased
- **แก้เป็น post-commit**: worker ทำ DB work ทั้งหมดใน transaction ก่อน, แล้ว set `order:purchased` กับ `product:soldout` หลัง `COMMIT` สำเร็จเท่านั้น
- **ผลลัพธ์**: Redis ไม่เคย claim ว่าซื้อสำเร็จหรือ sold-out ถ้า DB rollback จริง
- **Safety net**: DB unique constraint + API Lua cooldown ยังป้องกัน duplicate purchase เมื่อ Redis state sync lagging เล็กน้อยหลัง commit

---

## 9. ผลลัพธ์ Load Test

### 9.1 Load Test Configuration

ใช้ k6 v0.50 (3 phases):
- **Setup**: 500 JWTs
- **Read**: 1,000 VUs × 20s, GET /api/v1/products
- **Write**: 500 VUs × 20s, POST /api/v1/orders (p-1001, stock=50), 2-3 iters/VU

### 9.2 ผลลัพธ์ 3 รอบติดต่อกัน (3 Consecutive Runs)

| Metric | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| **202 ACCEPTED** | 50 | 50 | 50 |
| **409 Conflicts** | 17,370 | 21,939 | 25,238 |
| **DB SUCCESS** | **50** ✅ | **50** ✅ | **50** ✅ |
| **Unique Users** | **50** ✅ | **50** ✅ | **50** ✅ |
| **BullMQ Failed** | **0** ✅ | **0** ✅ | **0** ✅ |
| **Wasted PG tx** | **0** ✅ | **0** ✅ | **0** ✅ |

### 9.3 Data Integrity Verification

```sql
-- ต้องการ: remainingStock = 0 พอดี
SELECT remainingStock FROM products WHERE productId = 'p-1001';
-- Result: 0 ✅

-- ต้องการ: 50 SUCCESS orders, 50 unique users
SELECT COUNT(*), COUNT(DISTINCT userId) 
FROM orders WHERE productId = 'p-1001' AND status = 'SUCCESS';
-- Result: 50, 50 ✅

-- ต้องการ: ไม่มี overselling
SELECT remainingStock FROM products WHERE productId = 'p-1001';
-- Result: 0 (ไม่ติดลบ) ✅

-- ต้องการ: product อื่นไม่ได้รับผลกระทบ
SELECT productId FROM products 
WHERE productId != 'p-1001' AND remainingStock != availableStock;
-- Result: 0 rows ✅
```

### 9.4 Performance Metrics

```
http_req_duration: avg=213ms  p(95)=697ms  p(99)=...
http_req_failed (includes 409): ~89% (most are SOLD_OUT expected)
http_reqs: ~136,000 / 42s = ~3,200 req/s
order_accepted_total: 50 (exactly)
order_conflicted_total: ~20,000 (overflow correctly rejected)
```

### 9.5 การเปรียบเทียบ: Before vs After Fixes

| Fix | Before | After | Δ |
|---|---|---|---|
| Fix 1: Worker ไม่ SET stockKey | 167 ACCEPTED | 50 ACCEPTED | -70% |
| Fix 3: Post-commit purchasedKey | 34 × 23505 | 0 | -100% |
| Fix 4: ไม่เขียน FAILED OUT_OF_STOCK | 63 × PG tx | 0 | -100% |
| Cold-start protection | 1254 ACCEPTED (cold) | 0 ACCEPTED | -100% |
| stockKey TTL 30s → 1h | race window | closed | - |
| concurrency 10 → 2 | 24 lock_timeout | 0 | -100% |
| attempts 1 → 2 + backoff | lost jobs | recovered | - |
| user:cooldown 3s | same-user race | closed at API | - |

---

## 10. คำแนะนำการ Deploy & การใช้งาน

### 10.1 Prerequisites

- **Docker Desktop** (Windows/macOS) หรือ **Docker Engine** (Linux) + Compose v2
- **k6** (สำหรับ load test) — `choco install k6` / `brew install k6`

### 10.2 Quick Start (1-click)

```bash
# 1. Clone
git clone <repo-url>
cd mobile-backend-group-1

# 2. สร้าง .env.docker
cp flash-sale-backend/.env.docker.example flash-sale-backend/.env.docker

# 3. Build + Start (10 containers)
docker compose up -d --build

# 4. รอ ~30-60s
docker compose ps --format "table {{.Names}}{{.Status}}"
```

### 10.3 Verify System

```bash
# Health check (ผ่าน Nginx)
1..10 | %{ curl -s http://localhost/health }

# Readiness (ตรวจ DB + Redis)
curl http://localhost/health/ready

# Products list (cache MISS ครั้งแรก)
curl "http://localhost/api/v1/products?page=1&limit=5"

# Cache stats
curl http://localhost/api/v1/products/admin/cache-stats
# { "hits": 1, "misses": 1, "total": 2, "hitRatio": 0.5 }

# Bull-Board dashboard
open http://localhost:3001/admin/queues
```

### 10.4 ตัวอย่างการสั่งซื้อ (Full Flow)

```powershell
# 1. ขอ JWT
$TOKEN = (curl -s -X POST http://localhost/api/v1/auth/token `
  -H "Content-Type: application/json" `
  -d '{"userId":"user-1"}' | ConvertFrom-Json).accessToken

# 2. สั่งซื้อ
curl -X POST http://localhost/api/v1/orders `
  -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/json" `
  -d '{"productId":"p-1001"}'
# { "status":"processing", "orderJobId":"1", "message":"Your order is in the queue." }

# 3. ลองสั่งซื้อซ้ำทันที → จะได้ 409
curl -X POST http://localhost/api/v1/orders ... 
# { "statusCode":409, "message":"You have already purchased this product" }
```

### 10.5 Run Load Test

```bash
# Reset state ก่อน
bash loadtest/reset.sh

# รัน k6 (40s: 20s read + 20s write)
k6 run --env BASE_URL=http://localhost loadtest/flash-sale.js

# ดูผลรวม + ตรวจสอบ data integrity
bash loadtest/verify.sh
```

### 10.6 Reset Between Runs

```bash
# PowerShell (Windows-native)
.\loadtest\reset.ps1

# Bash (WSL / Git Bash / macOS / Linux)
bash loadtest/reset.sh
```

Reset ทำอะไรบ้าง:
- Reset `remainingStock` ทุก product กลับเป็น seed value
- `TRUNCATE TABLE orders`
- `FLUSHDB` Redis cache + counters

---

## 11. สมาชิกในกลุ่ม (Team Members)

| Name | Role | Responsibilities |
|---|---|---|
| _ชื่อ สมาชิก 1_ | _Backend Lead_ | NestJS architecture, Redis Lua atomic script, API endpoints |
| _ชื่อ สมาชิก 2_ | _Database & Worker_ | TypeORM schema, migrations, PG pessimistic locking, BullMQ worker |
| _ชื่อ สมาชิก 3_ | _DevOps & Testing_ | Docker Compose, Nginx, k6 load test, observability (Bull-Board, logs) |

---

## 📄 License

Course project — internal use only.