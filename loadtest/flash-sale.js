/**
 * k6 Load Test — Flash Sale System (Comprehensive Coverage)
 *
 * Run with:
 *   k6 run --env BASE_URL=http://localhost loadtest/flash-sale.js
 *
 * Phases (per spec):
 *   1. Setup   — fetch 500 unique JWTs (user-1 .. user-500)
 *   2. Read    — 1000 concurrent users, 30s, GET /api/v1/products
 *                Distributed limit range [5,10,15,20,25,50] + 10% overflow mix
 *   3. Write   — 500 concurrent users, 30s, POST /api/v1/orders for p-1001 only
 *                2-3 iterations per VU (double/triple click simulation)
 *
 * Cache keys generated (expected):
 *   - Normal: products:list:page:{1-4}:limit:{5,10,15,20,25,50}  (~11-14 keys)
 *   - Overflow: products:list:page:{5-34}:limit:*  +  limit:{51-100}  (~50 keys)
 *
 * Tags:
 *   - scenario: read_load | write_load
 *   - page / limit: query params used (for per-key analysis)
 */

import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://localhost';
const TOTAL_USERS = 500;
const TARGET_PRODUCT = 'p-1001';
const TOTAL_PRODUCTS = 20;
const OVERFLOW_RATE = 0.10;

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
    const page = Math.floor(Math.random() * 30) + 5;
    return { page, limit };
  }
  return { page: 1, limit: Math.floor(Math.random() * 50) + 51 };
}

export const options = {
  scenarios: {
    read_load: {
      executor: 'constant-vus',
      vus: 1000,
      duration: '30s',
      exec: 'readScenario',
      gracefulStop: '5s',
    },
    write_load: {
      executor: 'constant-vus',
      vus: 500,
      duration: '30s',
      startTime: '35s',
      exec: 'writeScenario',
      gracefulStop: '5s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.20'],
    'http_req_duration{scenario:read_load}': ['p(95)<300'],
    'http_req_duration{scenario:write_load}': ['p(95)<500'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const tokens = [];
  for (let i = 1; i <= TOTAL_USERS; i++) {
    const res = http.post(
      `${BASE_URL}/api/v1/auth/token`,
      JSON.stringify({ userId: `user-${i}` }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (res.status !== 200) {
      throw new Error(`Setup failed: cannot fetch JWT for user-${i} (status=${res.status})`);
    }
    const body = res.json();
    if (!body.accessToken) {
      throw new Error(`Setup failed: no accessToken in response for user-${i}`);
    }
    tokens.push(body.accessToken);
  }
  console.log(`Setup complete: fetched ${tokens.length} JWTs`);
  return { tokens };
}

export function readScenario() {
  let page;
  let limit;

  if (Math.random() < OVERFLOW_RATE) {
    const o = pickOverflowQuery();
    page = o.page;
    limit = o.limit;
  } else {
    limit = pickLimit();
    page = pickValidPage(limit);
  }

  const res = http.get(
    `${BASE_URL}/api/v1/products?page=${page}&limit=${limit}`,
    { tags: { name: 'products', page: String(page), limit: String(limit) } },
  );

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has meta object': (r) => {
      try {
        const j = r.json();
        return j && typeof j.meta === 'object';
      } catch {
        return false;
      }
    },
  });
}

export function writeScenario(data) {
  const vuId = (exec.vu.idInTest - 1) % TOTAL_USERS;
  const token = data.tokens[vuId];

  const iterations = Math.random() < 0.5 ? 2 : 3;

  for (let i = 0; i < iterations; i++) {
    const res = http.post(
      `${BASE_URL}/api/v1/orders`,
      JSON.stringify({ productId: TARGET_PRODUCT }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        tags: { name: 'orders' },
      },
    );
    check(res, {
      'status is 202 or 409': (r) => r.status === 202 || r.status === 409,
    });
  }
}
