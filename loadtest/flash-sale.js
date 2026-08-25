/**
 * k6 Load Test — Flash Sale System
 *
 * Run with:
 *   k6 run --env BASE_URL=http://localhost loadtest/flash-sale.js
 *
 * Phases (per spec):
 *   1. Setup   — fetch 500 unique JWTs (user-1 .. user-500)
 *   2. Read    — 1000 concurrent users, 30s, GET /api/v1/products
 *   3. Write   — 500 concurrent users, 30s, POST /api/v1/orders for p-1001
 *                Each VU fires 2-3 requests to test duplicate-prevention lock.
 *
 * Output:
 *   - k6 console summary (req/s, p95, error rate)
 *   - JSON summary at ./loadtest/results/summary.json (when --out=json used)
 */

import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://localhost';
const TOTAL_USERS = 500;
const TARGET_PRODUCT = 'p-1001';

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
      startTime: '35s', // after read phase + 5s buffer
      exec: 'writeScenario',
      gracefulStop: '5s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.15'], // 409s count as failures in k6
    'http_req_duration{scenario:read_load}': ['p(95)<300'],
    'http_req_duration{scenario:write_load}': ['p(95)<500'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// Runs once before scenarios. Fetches 500 unique JWTs and returns them.
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
  console.log(`✓ Setup complete: fetched ${tokens.length} JWTs`);
  return { tokens };
}

export function readScenario() {
  const res = http.get(`${BASE_URL}/api/v1/products?page=1&limit=10`, {
    tags: { name: 'products' },
  });
  check(res, {
    'status is 200': (r) => r.status === 200,
    'has data array': (r) => {
      try {
        const j = r.json();
        return Array.isArray(j?.data);
      } catch {
        return false;
      }
    },
  });
}

export function writeScenario(data) {
  // Use VU id to pick a unique user (k6 VUs are 1..N)
  const vuId = (exec.vu.idInTest - 1) % TOTAL_USERS;
  const token = data.tokens[vuId];

  // Simulate double/triple click per spec
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
    // Acceptable: 202 (queued) or 409 (lock blocked duplicate)
    check(res, {
      'status is 202 or 409': (r) => r.status === 202 || r.status === 409,
    });
  }
}