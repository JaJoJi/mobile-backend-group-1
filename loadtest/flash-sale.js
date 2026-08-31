/**
 * ============================================================================
 *  k6 Load Test — Flash Sale System  (Mobile Backend Assignment)
 * ============================================================================
 *
 *  PURPOSE
 *    Runs the 3-phase load test defined in the assignment spec:
 *      STAGE 1  AUTH    — fetch 500 unique JWTs (user-1 .. user-500)
 *      STAGE 2  READ    — 1,000 concurrent users, GET /api/v1/products
 *      STAGE 3  WRITE   —   500 concurrent users, POST /api/v1/orders
 *                          (p-1001 only, stock=50, 2-3 iter / VU)
 *
 *    Plus 2 helper stages around the run:
 *      STAGE 0  PRE-FLIGHT  — healthcheck + initial cache stats from backend
 *      STAGE 4  POST-FLIGHT — final cache stats + SUCCESS order count
 *
 *  OUTPUT
 *    Every stage prints its own ASCII banner + progress to stdout so you can
 *    watch the run live.  At the end, handleSummary() renders a single
 *    boxed report that covers every deliverable in section 3 of the spec:
 *      - Cache Performance  (Hit / Miss / Ratio with bar chart)
 *      - Queue / Order Outcomes (202 vs 409 vs 429)
 *      - Throughput & Latency (req/s, p50/p90/p95/p99/max per scenario)
 *      - Business Rules Proof  (50 unique winners for p-1001)
 *
 *  USAGE
 *    k6 run --env BASE_URL=http://localhost loadtest/flash-sale.js
 *    k6 run --env BASE_URL=http://localhost --out json=results.json loadtest/flash-sale.js
 *
 *  TAGS (used by k6 cloud / InfluxDB dashboards)
 *    scenario: preflight | auth_setup | read_load | write_load | postflight
 *    name:     health | cache_stats | auth | products | orders | orders_verify
 *    page / limit: query params used (per-cache-key analysis)
 * ============================================================================
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.3/index.js';

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------
const BASE_URL        = __ENV.BASE_URL || 'http://localhost';
const TOTAL_USERS     = 500;
const TARGET_PRODUCT  = 'p-1001';
const TOTAL_PRODUCTS  = 20;
const OVERFLOW_RATE   = 0.05;
const REQ_TIMEOUT     = '60s';

// Per-request default tags. `expected_response:true` tells k6 these codes
// are NOT errors (otherwise http_req_failed would count every 409 as a fail).
const BASE_TAGS = { expected_response: 'true' };

// --------------------------------------------------------------------------
// Custom metrics — every counter / trend is named so it shows up clearly
// in the k6 summary and can be split by scenario using tag filters.
// --------------------------------------------------------------------------
// Stage 1 — AUTH
const authLatency      = new Trend('auth_latency_ms', true);
// Stage 2 — READ
const read2xx          = new Counter('read_status_2xx');
const read4xx          = new Counter('read_status_4xx');
const read5xx          = new Counter('read_status_5xx');
const readNetErr       = new Counter('read_status_net_err');
// Stage 3 — WRITE
const orderAccepted    = new Counter('order_accepted_202');
const orderConflict409 = new Counter('order_conflict_409');
const orderConflict429 = new Counter('order_conflict_429');
const orderAuthFail    = new Counter('order_auth_fail_401');
const orderServerErr   = new Counter('order_server_5xx');
const orderNetErr      = new Counter('order_net_err');
// Overall infra-failure rate (5xx + timeout + non-409 4xx + net errors)
const httpFailures     = new Rate('http_infra_failures');

// Shared result object — written by setup/teardown, read by handleSummary.
// k6 does NOT pass teardown's return value to handleSummary, so we use a
// module-level object to bridge the two.
const runState = {
  preflightOk:       false,
  preCacheStats:     null,
  postCacheStats:    null,
  successOrders:     null,
  postflightError:   null,
};

// --------------------------------------------------------------------------
// Small UI helpers (ASCII boxes + bars + alignment). Used by setup() /
// teardown() progress logs and by handleSummary() for the final report.
// Box width: 80 chars total → 76 chars inner content.
// --------------------------------------------------------------------------
const BOX_INNER = 76;

const HR = '─'.repeat(BOX_INNER);

function banner(title, color = 96) { // 96 = bright cyan
  return [
    '',
    `\x1b[1;${color}m┌${'─'.repeat(BOX_INNER)}┐\x1b[0m`,
    `\x1b[1;${color}m│ ${title.padEnd(BOX_INNER - 2)} │\x1b[0m`,
    `\x1b[1;${color}m└${'─'.repeat(BOX_INNER)}┘\x1b[0m`,
  ].join('\n');
}

/** Top / bottom border of a section box — width matches rows exactly.
 *  `┌── ${label} ─────...───┐`  → 80 chars wide, label sits flush left. */
function boxTop(label) {
  const prefix = `┌── ${label} `;
  const suffix = `┐`;
  const dashes = Math.max(3, 80 - prefix.length - suffix.length);
  return `${prefix}${'─'.repeat(dashes)}${suffix}`;
}
function boxBottom() { return `└${'─'.repeat(BOX_INNER)}┘`; }

/** Wrap `content` so its inner length is exactly BOX_INNER chars. */
function row(content) {
  const c = String(content);
  if (c.length === BOX_INNER) return `│ ${c} │`;
  if (c.length  < BOX_INNER) return `│ ${c}${' '.repeat(BOX_INNER - c.length)} │`;
  return `│ ${c.slice(0, BOX_INNER)} │`;
}

function bar(pct, width = 30) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function pad(s, w, align = 'left') {
  s = String(s);
  if (s.length >= w) return s.slice(0, w);
  const fill = ' '.repeat(w - s.length);
  return align === 'right' ? fill + s : s + fill;
}

function fmtMs(v) {
  if (v == null || Number.isNaN(v)) return '   -  ';
  return `${v.toFixed(1).padStart(7)} ms`;
}

/** Compact ms formatter — 6-char right-aligned, no unit suffix.
 *  Use in tables where the column header already says "ms". */
function fmtMsShort(v) {
  if (v == null || Number.isNaN(v)) return '    - ';
  const s = v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0);
  return s.padStart(6);
}

function fmtPct(v) {
  if (v == null) return '    -   ';
  return `${(v * 100).toFixed(2).padStart(6)}%`;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function isInfraFailure(status) {
  if (status === 0) return true;          // timeout / network error
  if (status >= 500) return true;         // server error
  if (status === 401) return true;        // unauthenticated (we sent a JWT — infra bug)
  if (status >= 400 && status !== 409 && status !== 429) return true;
  return false;
}

const LIMIT_OPTIONS = [5, 10, 15, 20, 25, 50];

function pickLimit() {
  return LIMIT_OPTIONS[Math.floor(Math.random() * LIMIT_OPTIONS.length)];
}
function pickValidPage(limit) {
  const maxPage = Math.ceil(TOTAL_PRODUCTS / limit);
  return Math.floor(Math.random() * maxPage) + 1;
}
function pickOverflowQuery() {
  if (Math.random() < 0.5) {
    const limit = pickLimit();
    const page = Math.floor(Math.random() * 30) + 5;   // empty page
    return { page, limit };
  }
  return { page: 1, limit: Math.floor(Math.random() * 50) + 51 }; // limit > data
}

// --------------------------------------------------------------------------
// k6 options — 3 scenarios that match the assignment's load profile
// --------------------------------------------------------------------------
export const options = {
  scenarios: {
    read_load: {
      executor: 'constant-vus',
      vus: 1000,
      duration: '30s',
      exec: 'readScenario',
      gracefulStop: '5s',
      tags: { scenario: 'read_load' },
    },
    write_load: {
      executor: 'constant-vus',
      vus: 500,
      duration: '30s',
      exec: 'writeScenario',
      gracefulStop: '5s',
      tags: { scenario: 'write_load' },
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    'http_req_duration{scenario:read_load}':  ['p(95)<500'],
    'http_req_duration{scenario:write_load}': ['p(95)<500'],
    http_infra_failures: ['rate<0.01'],
    'http_infra_failures{scenario:read_load}':  ['rate<0.01'],
    'http_infra_failures{scenario:write_load}': ['rate<0.01'],
    checks: ['rate>0.99'],
    'checks{scenario:read_load}':  ['rate>0.99'],
    'checks{scenario:write_load}': ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ==========================================================================
// STAGE 0 + STAGE 1 — setup() runs ONCE before any VU starts
// ==========================================================================
export function setup() {
  console.log(banner('STAGE 0 · PRE-FLIGHT — verify stack + read initial cache stats'));

  // 0a — healthcheck (any instance, routed via nginx)
  const ready = http.get(`${BASE_URL}/health/ready`, {
    timeout: '10s',
    tags: { ...BASE_TAGS, scenario: 'preflight', name: 'health' },
  });
  runState.preflightOk = ready.status === 200;
  console.log(`  [preflight] /health/ready   → HTTP ${ready.status}  ${runState.preflightOk ? '✓' : '✗'}`);

  // 0b — initial cache stats from backend's admin endpoint
  const cs = http.get(`${BASE_URL}/api/v1/products/admin/cache-stats`, {
    timeout: '10s',
    tags: { ...BASE_TAGS, scenario: 'preflight', name: 'cache_stats' },
  });
  if (cs.status === 200) {
    runState.preCacheStats = cs.json();
    const s = runState.preCacheStats;
    console.log(`  [preflight] cache baseline  → hits=${s.hits}  misses=${s.misses}  ratio=${(s.hitRatio*100).toFixed(2)}%`);
  } else {
    console.log(`  [preflight] cache stats unreachable (HTTP ${cs.status}) — will skip ratio calc`);
  }

  // ---------------------------------------------------------------- STAGE 1
  console.log(banner(`STAGE 1 · AUTH — fetch ${TOTAL_USERS} unique JWTs (user-1 .. user-${TOTAL_USERS})`));

  const tokens = [];
  const authSamples = [];  // collect latencies for inline avg/min/max (Trend
                           // aggregates are not available until handleSummary)
  const authStart = Date.now();
  const PROGRESS_EVERY = 50;

  for (let i = 1; i <= TOTAL_USERS; i++) {
    const t0 = Date.now();
    const res = http.post(
      `${BASE_URL}/api/v1/auth/token`,
      JSON.stringify({ userId: `user-${i}` }),
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: '10s',
        tags: { ...BASE_TAGS, scenario: 'auth_setup', name: 'auth' },
      },
    );
    const dt = Date.now() - t0;
    authLatency.add(dt);
    authSamples.push(dt);

    if (res.status !== 200) {
      throw new Error(`Setup failed: cannot fetch JWT for user-${i} (HTTP ${res.status})`);
    }
    const body = res.json();
    if (!body.accessToken) {
      throw new Error(`Setup failed: no accessToken in response for user-${i}`);
    }
    tokens.push(body.accessToken);

    if (i % PROGRESS_EVERY === 0 || i === TOTAL_USERS) {
      const pct = ((i / TOTAL_USERS) * 100).toFixed(0).padStart(3);
      console.log(`  [auth] ${pct}%  ${String(i).padStart(3)}/${TOTAL_USERS} tokens fetched`);
    }
  }

  const authSecs = ((Date.now() - authStart) / 1000).toFixed(1);
  const authAvg = authSamples.reduce((a, b) => a + b, 0) / authSamples.length;
  const authMin = Math.min(...authSamples);
  const authMax = Math.max(...authSamples);
  console.log(`  [auth] ✓ done in ${authSecs}s  (avg ${authAvg.toFixed(1)} ms / token, min ${authMin} ms, max ${authMax} ms)`);

  return { tokens };
}

// ==========================================================================
// STAGE 2 — READ LOAD  (1,000 concurrent VUs for 30s)
// ==========================================================================
export function readScenario() {
  let page, limit, isOverflow = false;

  if (Math.random() < OVERFLOW_RATE) {
    ({ page, limit } = pickOverflowQuery());
    isOverflow = true;
  } else {
    limit = pickLimit();
    page  = pickValidPage(limit);
  }

  const res = http.get(
    `${BASE_URL}/api/v1/products?page=${page}&limit=${limit}`,
    {
      timeout: REQ_TIMEOUT,
      tags: {
        ...BASE_TAGS,
        scenario: 'read_load',
        name: 'products',
        page: String(page),
        limit: String(limit),
        overflow: String(isOverflow),
      },
    },
  );

  // Per-status counters
  if (res.status >= 200 && res.status < 300) read2xx.add(1);
  else if (res.status >= 500)                  read5xx.add(1);
  else if (res.status >= 400)                  read4xx.add(1);
  else                                         readNetErr.add(1);

  check(res, {
    'read: status is 200': (r) => r.status === 200,
    'read: response has meta object': (r) => {
      try { return r.json() && typeof r.json().meta === 'object'; }
      catch { return false; }
    },
  });
  httpFailures.add(isInfraFailure(res.status));
}

// ==========================================================================
// STAGE 3 — WRITE LOAD  (500 concurrent VUs for 30s, 2-3 iters each)
// ==========================================================================
export function writeScenario(data) {
  const vuId  = (exec.vu.idInTest - 1) % TOTAL_USERS;
  const token = data.tokens[vuId];

  // 50/50 split: half the VUs double-click, half triple-click
  const iterations = Math.random() < 0.5 ? 2 : 3;

  for (let i = 0; i < iterations; i++) {
    const res = http.post(
      `${BASE_URL}/api/v1/orders`,
      JSON.stringify({ productId: TARGET_PRODUCT }),
      {
        timeout: REQ_TIMEOUT,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        tags: {
          ...BASE_TAGS,
          scenario: 'write_load',
          name: 'orders',
          vu_user: String(vuId + 1),
        },
      },
    );

    // Per-status counters
    switch (res.status) {
      case 202: orderAccepted.add(1);    break;
      case 409: orderConflict409.add(1); break;
      case 429: orderConflict429.add(1); break;
      case 401: orderAuthFail.add(1);    break;
      default:
        if (res.status >= 500) orderServerErr.add(1);
        else                   orderNetErr.add(1);
    }

    check(res, {
      'write: status is 202 or 409 or 429': (r) =>
        r.status === 202 || r.status === 409 || r.status === 429,
    });
    httpFailures.add(isInfraFailure(res.status));
  }
}

// ==========================================================================
// STAGE 4 — POST-FLIGHT (runs after all VUs stop, before summary)
//   • Final cache stats from backend (to compute hit ratio)
//   • Order listing filtered by p-1001 SUCCESS (to verify 50 unique winners)
// ==========================================================================
export function teardown(data) {
  console.log(banner('STAGE 4 · POST-FLIGHT — verify cache + order integrity'));

  // Give BullMQ workers a moment to drain any in-flight jobs. Workers commit
  // synchronously in their own process, but BullMQ → Redis finalization is
  // async. 2s is enough in practice; safe upper bound 5s.
  sleep(2);

  // 4a — final cache stats
  const cs = http.get(`${BASE_URL}/api/v1/products/admin/cache-stats`, {
    timeout: '10s',
    tags: { ...BASE_TAGS, scenario: 'postflight', name: 'cache_stats' },
  });
  if (cs.status === 200) {
    runState.postCacheStats = cs.json();
  } else {
    runState.postflightError = `cache-stats endpoint returned HTTP ${cs.status}`;
    console.log(`  [postflight] ✗ ${runState.postflightError}`);
  }

  // 4b — final order count for p-1001 (SUCCESS only)
  //   Pagination: limit=100 is the API max; with 50 winners we always fit
  //   on page 1. If limit ever changes we paginate defensively.
  let allSuccess = [];
  let page = 1;
  const limit = 100;
  for (let safety = 0; safety < 10; safety++) {
    const r = http.get(
      `${BASE_URL}/api/v1/orders?productId=${TARGET_PRODUCT}&status=SUCCESS&page=${page}&limit=${limit}`,
      {
        timeout: '10s',
        tags: { ...BASE_TAGS, scenario: 'postflight', name: 'orders_verify' },
      },
    );
    if (r.status !== 200) {
      runState.postflightError = `orders endpoint returned HTTP ${r.status}`;
      console.log(`  [postflight] ✗ ${runState.postflightError}`);
      break;
    }
    const j = r.json();
    allSuccess = allSuccess.concat(j.data || []);
    if (!j.meta || page >= j.meta.totalPages) break;
    page++;
  }
  runState.successOrders = allSuccess;

  const uniqueUsers = new Set(allSuccess.map((o) => o.userId));
  console.log(`  [postflight] p-1001 SUCCESS orders : ${allSuccess.length}`);
  console.log(`  [postflight] unique winners        : ${uniqueUsers.size}`);
  if (runState.postCacheStats) {
    const s = runState.postCacheStats;
    console.log(`  [postflight] cache final           : hits=${s.hits}  misses=${s.misses}  ratio=${(s.hitRatio*100).toFixed(2)}%`);
  }
}

// ==========================================================================
// Custom summary — rich, boxed, and aligned for easy copy-paste into the
// project report (PDF deliverable section 3).
// ==========================================================================
export function handleSummary(data) {
  const m = data.metrics;

  // ---- pull values with safe defaults -----------------------------------
  const accepted    = m.order_accepted_202?.values?.count    ?? 0;
  const conflict409 = m.order_conflict_409?.values?.count    ?? 0;
  const conflict429 = m.order_conflict_429?.values?.count    ?? 0;
  const authFail    = m.order_auth_fail_401?.values?.count   ?? 0;
  const serverErr   = m.order_server_5xx?.values?.count      ?? 0;
  const netErr      = m.order_net_err?.values?.count         ?? 0;

  const r2xx  = m.read_status_2xx?.values?.count  ?? 0;
  const r4xx  = m.read_status_4xx?.values?.count  ?? 0;
  const r5xx  = m.read_status_5xx?.values?.count  ?? 0;
  const rNet  = m.read_status_net_err?.values?.count ?? 0;

  const infraRate = m.http_infra_failures?.values?.rate ?? 0;

  // auth latency summary (custom Trend)
  const authAvg = m.auth_latency_ms?.values?.avg;
  const authMin = m.auth_latency_ms?.values?.min;
  const authMax = m.auth_latency_ms?.values?.max;

  // http_req_duration per scenario (the built-in Trend has both forms)
  const httpAll = m.http_req_duration?.values || {};
  const readM   = m['http_req_duration{scenario:read_load}']?.values  || {};
  const writeM  = m['http_req_duration{scenario:write_load}']?.values || {};

  // http_reqs per scenario (built-in Counter — values.count is the count,
  // values.rate is the req/s over the test wall-clock).
  const reqAll  = m.http_reqs?.values || {};
  const reqR    = m['http_reqs{scenario:read_load}']?.values  || {};
  const reqW    = m['http_reqs{scenario:write_load}']?.values || {};

  // ---- cache stats -------------------------------------------------------
  const pre  = runState.preCacheStats;
  const post = runState.postCacheStats;
  const cacheTestHits  = pre && post ? post.hits  - pre.hits  : (post?.hits  ?? 0);
  const cacheTestMiss  = pre && post ? post.misses - pre.misses : (post?.misses ?? 0);
  const cacheTotal     = cacheTestHits + cacheTestMiss;
  const cacheRatio     = cacheTotal > 0 ? cacheTestHits / cacheTotal : 0;

  // ---- business rule proof ----------------------------------------------
  const winners      = runState.successOrders || [];
  const uniqueUsers  = new Set(winners.map((o) => o.userId));
  const expectedStock = 50;
  const stockIntact  = winners.length === expectedStock && uniqueUsers.size === expectedStock;

  // ---- assemble report ---------------------------------------------------
  const lines = [];
  const push = (s = '') => lines.push(s);

  push('\n');
  push('╔══════════════════════════════════════════════════════════════════════════╗');
  push('║              FLASH SALE — LOAD TEST FINAL REPORT                       ║');
  push('╚══════════════════════════════════════════════════════════════════════════╝');
  push('');

  // ── 0. Stage results ───────────────────────────────────────────────────
  push(boxTop('0. STAGE RESULTS'));
  push(row(`STAGE 0  pre-flight  : ${runState.preflightOk ? '\x1b[1;92m✓ OK\x1b[0m'   : '\x1b[1;91m✗ FAIL\x1b[0m'}`));
  push(row(`STAGE 1  auth setup  : \x1b[1;92m✓ OK\x1b[0m  (${TOTAL_USERS} tokens fetched)`));
  push(row(`STAGE 2  read load   : ${infraRate < 0.01 ? '\x1b[1;92m✓ OK\x1b[0m' : '\x1b[1;93m⚠ infra failures > 1%\x1b[0m'}`));
  push(row(`STAGE 3  write load  : ${serverErr + netErr === 0 ? '\x1b[1;92m✓ OK\x1b[0m' : '\x1b[1;93m⚠ server/network errors\x1b[0m'}`));
  push(row(`STAGE 4  post-flight : ${runState.successOrders !== null ? '\x1b[1;92m✓ OK\x1b[0m' : '\x1b[1;91m✗ FAIL\x1b[0m'}`));
  push(boxBottom());
  push('');

  // ── 1. Cache Performance ───────────────────────────────────────────────
  push(boxTop('1. CACHE PERFORMANCE (during test window)'));
  push(row(`hits              : ${pad(cacheTestHits, 8)}`));
  push(row(`misses            : ${pad(cacheTestMiss, 8)}`));
  push(row(`total read reqs   : ${pad(cacheTotal, 8)}`));
  push(row(`hit ratio         : ${pad((cacheRatio*100).toFixed(2)+'%', 8)}  ${bar(cacheRatio*100, 28)}`));
  if (pre)  push(row(`baseline (pre)    : hits=${pre.hits}  misses=${pre.misses}  ratio=${(pre.hitRatio*100).toFixed(2)}%`));
  if (post) push(row(`final    (post)   : hits=${post.hits}  misses=${post.misses}  ratio=${(post.hitRatio*100).toFixed(2)}%`));
  push(boxBottom());
  push('');

  // ── 2. Queue / Order Outcomes ──────────────────────────────────────────
  const totalOrders = accepted + conflict409 + conflict429 + authFail + serverErr + netErr;
  push(boxTop('2. ORDER OUTCOMES (POST /api/v1/orders)'));
  push(row(`HTTP 202  accepted          : ${pad(accepted, 5)}  ${bar(accepted/Math.max(1,totalOrders)*100, 25)}`));
  push(row(`HTTP 409  sold-out/dup/lock : ${pad(conflict409, 5)}  ${bar(conflict409/Math.max(1,totalOrders)*100, 25)}`));
  push(row(`HTTP 429  too many reqs     : ${pad(conflict429, 5)}  ${bar(conflict429/Math.max(1,totalOrders)*100, 25)}`));
  push(row(`HTTP 401  auth fail         : ${pad(authFail, 5)}`));
  push(row(`HTTP 5xx  server error      : ${pad(serverErr, 5)}`));
  push(row(`network / timeout           : ${pad(netErr, 5)}`));
  push(row(`${'─'.repeat(4)} ${'─'.repeat(56)} ${'─'.repeat(4)}`));
  push(row(`TOTAL attempts              : ${pad(totalOrders, 5)}`));
  push(boxBottom());
  push('');

  // ── 3. Throughput & Latency ────────────────────────────────────────────
  push(boxTop('3. THROUGHPUT & LATENCY'));
  // Column widths: 14 + 8 + 9 + 6 + 6 + 6 + 6 + 5 spaces = 60 (fits in 76)
  push(row(`${pad('scenario', 14)} ${pad('reqs', 8, 'right')} ${pad('req/s', 9, 'right')} ${pad('p50', 6, 'right')} ${pad('p95', 6, 'right')} ${pad('p99', 6, 'right')} ${pad('max', 6, 'right')}`));
  push(row(`${pad('─'.repeat(14), 14)} ${pad('─'.repeat(8), 8, 'right')} ${pad('─'.repeat(9), 9, 'right')} ${pad('─'.repeat(6), 6, 'right')} ${pad('─'.repeat(6), 6, 'right')} ${pad('─'.repeat(6), 6, 'right')} ${pad('─'.repeat(6), 6, 'right')}`));
  push(row(`${pad('READ  (1k vu)', 14)} ${pad(reqR.count ?? 0, 8, 'right')} ${pad((reqR.rate ?? 0).toFixed(1), 9, 'right')} ${fmtMsShort(readM['p(50)'])} ${fmtMsShort(readM['p(95)'])} ${fmtMsShort(readM['p(99)'])} ${fmtMsShort(readM.max)}`));
  push(row(`${pad('WRITE (500vu)', 14)} ${pad(reqW.count ?? 0, 8, 'right')} ${pad((reqW.rate ?? 0).toFixed(1), 9, 'right')} ${fmtMsShort(writeM['p(50)'])} ${fmtMsShort(writeM['p(95)'])} ${fmtMsShort(writeM['p(99)'])} ${fmtMsShort(writeM.max)}`));
  push(row(`${pad('ALL', 14)} ${pad(reqAll.count ?? 0, 8, 'right')} ${pad((reqAll.rate ?? 0).toFixed(1), 9, 'right')} ${fmtMsShort(httpAll['p(50)'])} ${fmtMsShort(httpAll['p(95)'])} ${fmtMsShort(httpAll['p(99)'])} ${fmtMsShort(httpAll.max)}`));
  push('');
  push(row(`latency unit = ms   |   read status : 2xx=${r2xx}  4xx=${r4xx}  5xx=${r5xx}  net=${rNet}`));
  push(row(`infra failure rate  : ${fmtPct(infraRate)}  (target < 1%)`));
  push(row(`auth setup latency  : avg=${fmtMs(authAvg)}  min=${fmtMs(authMin)}  max=${fmtMs(authMax)}`));
  push(boxBottom());
  push('');

  // ── 4. Business Rules Proof ────────────────────────────────────────────
  push(boxTop('4. BUSINESS RULES PROOF (p-1001, stock=50)'));
  push(row(`expected winners          : ${expectedStock}`));
  push(row(`SUCCESS orders in DB      : ${winners.length}`));
  push(row(`unique userIds            : ${uniqueUsers.size}`));
  push(row(`no duplicate (u,p) pairs  : ${winners.length === uniqueUsers.size ? '\x1b[1;92m✓ YES\x1b[0m' : '\x1b[1;91m✗ NO\x1b[0m'}`));
  push(row(`integrity check           : ${stockIntact ? '\x1b[1;92m✓ PASS\x1b[0m — no oversell, no underfill' : '\x1b[1;91m✗ FAIL\x1b[0m'}`));
  push(boxBottom());
  push('');

  // ── Verdict ────────────────────────────────────────────────────────────
  const verdictPass =
    runState.preflightOk &&
    runState.successOrders !== null &&
    stockIntact &&
    infraRate < 0.01 &&
    serverErr === 0 &&
    authFail === 0;

  push('╔══════════════════════════════════════════════════════════════════════════╗');
  push(`║  OVERALL VERDICT :  ${verdictPass ? '\x1b[1;92m✓ PASS\x1b[0m' : '\x1b[1;91m✗ FAIL\x1b[0m'}${' '.repeat(53)}║`);
  push('╚══════════════════════════════════════════════════════════════════════════╝');
  push('');

  // Hand off to the standard k6 summary for full metric dump, then prepend
  // our report on top.
  const std = textSummary(data, { indent: ' ', enableColors: true });

  return {
    stdout: lines.join('\n') + '\n' + std,
    'loadtest/results/summary.json': JSON.stringify(data, null, 2),
    'loadtest/results/report.txt':   lines.join('\n') + '\n',
  };
}
