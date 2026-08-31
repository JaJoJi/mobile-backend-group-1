# k6 Load Test — Flash Sale System

Comprehensive k6 script for the Mobile Backend (Flash Sale) project. Covers the three required APIs (auth, products, orders) with full observability, cache-aware read load, race-condition probing on writes, and a built-in pass/fail verdict.

## Install k6

**Windows (chocolatey):**
```powershell
choco install k6
```

**macOS:**
```bash
brew install k6
```

**Linux (Debian/Ubuntu):**
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver haproxy.org --recv-keys CD5EF9D7
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://haproxy.org/download/2.4/k6 $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

> The reset scripts only require **Node.js** (already a project dependency) to parse `products-seed.json`. No `jq` needed.

## Files

| File | Purpose |
|---|---|
| `flash-sale.js` | k6 script — 3 scenarios (warmup + read 1,000 VUs + write 500 VUs), full metrics + verdict |
| `reset.sh` / `reset.ps1` | Reset all 20 products from `products-seed.json`, truncate orders, flush Redis |
| `verify.sh` / `verify.ps1` | Post-test SQL + Redis integrity report (console output) |

## Run the test

**Bash / WSL / macOS / Linux:**
```bash
# 1. Stack up
cd mobile-backend-group-1
docker compose up -d --build

# 2. Reset DB + Redis
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

| Phase | Time | VUs | Target | Excluded from thresholds? |
|---|---|---|---|---|
| Setup | once | — | Fetch 500 JWTs (parallel batches of 50) + prime every (page,limit) cache key | yes |
| Read warmup | 0–5 s | 200 | `GET /api/v1/products` — fill cache | yes (looser p95 limit) |
| Read load | 5–35 s | 1000 | `GET /api/v1/products` — distributed page/limit + 5% overflow mix | no |
| Write load | 5–35 s | 500 | `POST /api/v1/orders` for `p-1001`, 2–4 iters/VU | no |

## Status taxonomy

Every response is classified into exactly one bucket:

| Status | Meaning | Counter | Counts as infra failure? |
|---|---|---|---|
| `200` | read success | `read_ok_total` | no |
| `202` | order accepted by queue | `order_accepted_total` | no |
| `409` + body says "sold out" | stock exhausted | `order_sold_out_total` | no |
| `409` + body says "already purchased" | 24h idempotency hit | `order_already_purchased_total` | no |
| `409` + body says "already have an order" | in-flight lock | `order_locked_total` | no |
| `409` + anything else | unknown conflict | `order_other_conflict_total` | no |
| `429` | Lua DECR rolled back (over-decrement) | `order_rate_limited_total` | no |
| `5xx`, `0`, timeout, anything else | infra-broken | `http_infra_failures` (rate) | **yes** |

The script classifies 409s by parsing the backend's `message` field, so the report shows *why* each rejected order was rejected — not just "409".

## Read scenario — distributed cache-key coverage

**Limit options:** `[5, 10, 15, 20, 25, 50]` (uniform pick per iteration)

**Valid cache keys generated:**

| Limit | Max Page (20 products) | Cache Keys |
|---|---|---|
| 5 | 4 | `page:1..4:limit:5` |
| 10 | 2 | `page:1..2:limit:10` |
| 15 | 2 | `page:1..2:limit:15` |
| 20 | 1 | `page:1:limit:20` |
| 25 | 1 | `page:1:limit:25` (capped at 20) |
| 50 | 1 | `page:1:limit:50` (capped at 20) |

**Overflow mix (5% of read traffic):**
- 50% of overflow: `page=5..34` with random limit → returns empty array (200 OK)
- 50% of overflow: `limit=51..100` (within DTO max=100) → returns ≤20 rows (200 OK)

**Cache priming:** `setup()` issues one GET for each of the ~11 valid (page,limit) pairs before any VU starts, so the first seconds of `read_load` aren't dominated by cold-cache misses.

**Expected cache key count in Redis after warmup:** 11–60 keys (depends on overflow distribution).

## Write scenario — p-1001 with double/triple/quadruple click

- Every VU targets `p-1001` exclusively (stock = 50).
- Each VU picks a random user index in `[0, 500)` once and uses that user's JWT for **all** its iterations — so within a VU, clicks are real "double-click" semantics.
- Iteration count per VU: 35% → 2, 50% → 3, 15% → 4 (the 4-iter branch deliberately exercises the cooldown-lock path more aggressively).
- Total requests: ~1,250 (500 VUs × ~2.5 iters).
- Expected: **50 SUCCESS** + ~1,200 of various 409s + occasional 429s at the zero-stock boundary.

Across VUs, ~37% of user indices will collide by birthday paradox — those collisions surface as extra `already_purchased` 409s, which is realistic and does not break the 50-stock invariant.

## Pass / fail semantics

| Layer | Counts as pass | Counts as infra failure |
|---|---|---|
| HTTP read | `200` | anything else |
| HTTP write | `202`, `409`, `429` | anything else |
| Business verdict | `accepted == 50` AND infra < 1% AND p95 < 500 ms (per scenario) | — |

The **business verdict** is printed at the end of every run:

```
============================================================
  FLASH SALE LOAD TEST — BUSINESS VERDICT
============================================================
  orders accepted         (HTTP 202) :    50    [expect 50]
  orders sold_out         (HTTP 409) :  1180
  orders already_purchased (HTTP 409):    12
  orders locked           (HTTP 409) :     8
  orders rate_limited     (HTTP 429) :     0
  orders other_conflict   (HTTP 409) :     0
  -------------------------------------------
  write total                      :  1250
  read requests (200)              : 30042
  infra failure rate               : 0.00%    [limit 1%]
  ---------------------------------------------------------------
  read_load  p95                   :     47ms    [limit 500ms]
  write_load p95                   :     38ms    [limit 500ms]
  read_warmup p95 (excluded)       :     65ms
============================================================
  VERDICT: ✅ PASS
============================================================
```

If any check fails, the verdict prints `❌ FAIL` followed by the reason(s).

## Thresholds

```
http_req_duration{scenario:read_warmup}  p(95) < 800 ms
http_req_duration{scenario:read_load}    p(95) < 500 ms
http_req_duration{scenario:write_load}   p(95) < 500 ms
http_infra_failures                       rate < 1%
http_infra_failures{scenario:read_load}   rate < 1%
http_infra_failures{scenario:write_load}  rate < 1%
checks{scenario:read_load}                rate > 99%
checks{scenario:write_load}               rate > 99%
```

Per-request timeout is **60 s**. We use a custom `http_infra_failures` rate (not k6's built-in `http_req_failed`) because the built-in counts every 4xx as a failure, including our expected 409s and 429s.

## Custom summary output

`handleSummary` writes three artifacts:

| Path | Contents |
|---|---|
| `stdout` | Verdict banner + standard k6 text summary |
| `loadtest/results/summary.json` | Full k6 metric dump (for `k6 report` / custom analysis) |
| `loadtest/results/business.txt` | Verdict + counters only (text-only, for PDF screenshots) |

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
3. **p-1001 target** — `remainingStock=0`, sold==SUCCESS, unique users match
4. **Order integrity** — no duplicate `(userId, productId)` pairs, stock_sold == SUCCESS_total
5. **Redis cache state** — hit ratio ≥ 70%, tracked keys count
6. **Summary** — pass/fail counts

## Common issues

| Error | Cause | Fix |
|---|---|---|
| `setup failed: cannot fetch JWT` | stack not ready | wait longer after `docker compose up` |
| `connection refused` | wrong BASE_URL | use `http://localhost` not `https://` |
| `All requests time out` | nginx not up | check `docker compose ps` |
| `reset.sh: node: command not found` | Node.js not installed | install Node.js LTS |
| `verify: cache hit ratio < 70%` | 5% overflow mix pollutes cache | expected — see "WARN" in report |
| `VERDICT: ❌ FAIL — accepted=N (expected 50)` | worker stock race or threshold too tight | inspect `loadtest/results/summary.json` + `verify.sh` output |
| `k6: the body is null so we can't transform it to JSON` | nginx returning 502/504 | check `docker compose ps` and `curl /health/ready` |