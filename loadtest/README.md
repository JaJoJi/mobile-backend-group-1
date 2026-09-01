# k6 Load Test — Flash Sale System

Comprehensive coverage: distributed cache keys (with overflow mix), strict p-1001 write target, full data-integrity verification, **rich stage-banners + final ASCII report**.

## Install k6

**Windows (chocolatey):**
```powershell
choco install k6
```

**macOS:**
```bash
brew install k6
```

**Linux:**
```bash
sudo apt-key adv --keyserver haproxy.org --recv-keys CD5EF9D7
echo "deb https://haproxy.org/download/2.4/k6 $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

> **Note:** The reset scripts only require **Node.js** (already a project dependency) to parse `products-seed.json`. No `jq` or other JSON tools needed.

## Files

| File | Purpose |
|---|---|
| `flash-sale.js` | k6 script — **5 stages** (pre-flight + auth + read 1k VUs + write 500 VUs + post-flight) with stage banners and a rich final ASCII report |
| `reset.sh` / `reset.ps1` | Reset all 20 products from `products-seed.json` |
| `verify.sh` / `verify.ps1` | Post-test SQL + Redis integrity report (console output) |

## Run the test

**Bash / WSL / macOS / Linux:**
```bash
# 1. Make sure stack is up
cd mobile-backend-group-1
docker compose up -d --build

# 2. Reset DB + Redis (also creates loadtest/results/)
bash loadtest/reset.sh

# 3. Run k6 (goes through Nginx :80 → nest-1/2/3)
k6 run --env BASE_URL=http://localhost \
       --out json=loadtest/results/summary.json \
       loadtest/flash-sale.js

# 4. Verify data integrity + cache state
bash loadtest/verify.sh
```

**PowerShell (Windows-native):**
```powershell
docker compose up -d --build
.\loadtest\reset.ps1
k6 run --env BASE_URL=http://localhost `
       --out json=loadtest\results\summary.json `
       loadtest\flash-sale.js
.\loadtest\verify.ps1
```

## What the script does

The script runs **5 stages**, each with its own ASCII banner printed to stdout so you can watch progress live:

| Stage | Time | VUs | Target | Banner |
|---|---|---|---|---|
| 0  pre-flight  | once | — | `GET /health/ready` + `GET /api/v1/products/admin/cache-stats` (baseline) | `STAGE 0 · PRE-FLIGHT` |
| 1  auth        | once | — | Fetch 500 JWTs sequentially (user-1 … user-500) with progress every 50 | `STAGE 1 · AUTH` |
| 2  read load   | 30 s | 1000 | `GET /api/v1/products` with random page/limit | (k6 default progress) |
| 3  write load  | 30 s | 500  | `POST /api/v1/orders` for `p-1001`, 2-3 iters/VU | (k6 default progress) |
| 4  post-flight | once | — | `GET /api/v1/products/admin/cache-stats` + `GET /api/v1/orders?status=SUCCESS` | `STAGE 4 · POST-FLIGHT` |

## Read scenario — distributed cache key coverage

**Limit options:** `[5, 10, 15, 20, 25, 50]` (6 values, uniformly picked per VU per iteration)

**Valid cache keys generated:**
| Limit | Max Page (20 products) | Cache Keys |
|---|---|---|
| 5 | 4 | `page:1..4:limit:5` |
| 10 | 2 | `page:1..2:limit:10` |
| 15 | 2 | `page:1..2:limit:15` |
| 20 | 1 | `page:1:limit:20` (all 20 products) |
| 25 | 1 | `page:1:limit:25` (capped at 20) |
| 50 | 1 | `page:1:limit:50` (capped at 20) |

**Overflow mix (10% of read traffic):**
- 50% of overflow: `page=5..34` with random limit → returns empty array (200 OK)
- 50% of overflow: `limit=51..100` (within DTO Max=100) → returns ≤20 rows (200 OK)

**Expected cache key count in Redis:** 11–60 keys (depends on overflow distribution)

## Write scenario — p-1001 only with double/triple click

- Every VU targets `p-1001` exclusively (stock=50)
- 50% of VUs fire 2 iterations, 50% fire 3 iterations
- Total requests: ~1,250 (500 VUs × ~2.5 iters)
- Expected: 50 SUCCESS + ~1,200 HTTP 409 (lock conflict)

## Pass / fail semantics

| Layer | Counts as pass | Counts as fail (test exits non-zero) |
|---|---|---|
| HTTP | `200` (read), `202` / `409` / `429` (write) | Any `4xx` other than `409`/`429`, any `5xx`, timeout > 10 s, connection refused, DNS/TLS error |
| Business | `202` = order accepted, `409` = sold-out / duplicate / lock, `429` = rate-limit | — (no business-level "fail" — all are valid outcomes) |

Thresholds that gate the test (uses a **custom** `http_infra_failures` metric — k6's built-in `http_req_failed` counts every 4xx as failure, including our expected `409`/`429`):

```
http_infra_failures rate                    < 1%    (5xx + timeout + non-409 4xx + 401)
http_infra_failures{scenario:read_load}     < 1%
http_infra_failures{scenario:write_load}    < 1%
checks rate                                 > 99%   (every check() must pass)
checks{scenario:read_load}                  > 99%
checks{scenario:write_load}                 > 99%
http_req_duration p(95)                     < 500 ms (per scenario too)
```

Per-request timeout is **10 s** (`REQ_PARAMS.timeout`).

## Custom summary output — boxed ASCII report

At the end of the test, `handleSummary` writes a single boxed report to stdout and also saves a plain-text copy to `loadtest/results/report.txt` and the full k6 metrics to `loadtest/results/summary.json`. The report covers every deliverable in section 3 of the spec:

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
│ ────────────── ──────── ───────── ────── ────── ────── ──────                │
│ READ  (1k vu)     28500     950.0   2.34   12.5   45.7    123                │
│ WRITE (500vu)      1234      41.1   5.10   28.7   67.3    235                │
│ ALL               29734     495.6   3.10   18.4   52.6    235                │
│                                                                            │
│ latency unit = ms   |   read status : 2xx=28500  4xx=0  5xx=0  net=0       │
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

The boxes use Unicode box-drawing characters so they line up in any monospace terminal. Bar charts (`█░`) make hit/miss and order-outcome proportions easy to scan at a glance. ANSI colors (✓ green / ✗ red) are emitted to stdout but stripped from `report.txt`.

Counters / rates emitted by the script (also visible in the standard k6 metric dump that follows the boxed report):

| Metric | Type | Tags |
|---|---|---|
| `auth_latency_ms` | Trend | scenario=auth_setup |
| `read_status_2xx` / `read_status_4xx` / `read_status_5xx` / `read_status_net_err` | Counter | scenario=read_load |
| `order_accepted_202` | Counter | scenario=write_load |
| `order_conflict_409` | Counter | scenario=write_load |
| `order_conflict_429` | Counter | scenario=write_load |
| `order_auth_fail_401` | Counter | scenario=write_load |
| `order_server_5xx` | Counter | scenario=write_load |
| `order_net_err` | Counter | scenario=write_load |
| `http_infra_failures` | Rate | all scenarios |

## Reset script — all 20 products

Both `reset.sh` and `reset.ps1`:
1. Read `products-seed.json` (uses Node.js / `ConvertFrom-Json`)
2. Generate `UPDATE products SET "remainingStock" = CASE "productId" WHEN 'p-1001' THEN 50 ... END`
3. `TRUNCATE orders`
4. `FLUSHDB` Redis

## Verify script — console report

`verify.sh` / `verify.ps1` checks 6 categories:
1. **Stock integrity** — all 20 products, `remainingStock >= 0`
2. **Non-target products** — 19 non-p-1001 products must be unchanged
3. **p-1001 target** — `remainingStock=0`, sold=SUCCESS, unique users match
4. **Order integrity** — no duplicate `(userId, productId)` pairs, stock_sold == SUCCESS_total
5. **Redis cache state** — hit ratio ≥ 70%, tracked keys count
6. **Summary** — pass/fail counts

## Save k6 results

```powershell
k6 run --env BASE_URL=http://localhost `
     --out json=loadtest/results/summary.json `
     loadtest/flash-sale.js
```

## Common issues

| Error | Cause | Fix |
|---|---|---|
| `setup failed: cannot fetch JWT` | stack not ready | wait longer after `docker compose up` |
| `connection refused` | wrong BASE_URL | use `http://localhost` not `https://` |
| `All requests time out` | nginx not up | check `docker compose ps` |
| `reset.sh: node: command not found` | Node.js not installed | install Node.js LTS |
| `verify: cache hit ratio < 70%` | 10% overflow mix pollutes cache | expected — see "WARN" in report |
| `k6: the body is null so we can't transform it to JSON` | nginx returning 502/504 | check `docker compose ps` and `curl /health/ready` |
