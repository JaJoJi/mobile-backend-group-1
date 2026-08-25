# k6 Load Test — Flash Sale System

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

## Files

- `flash-sale.js` — k6 script (3 phases per spec)
- `reset.sh` — reset DB stock + Redis between runs

## Run the test

```powershell
# 1. Make sure your stack is up
cd D:\work\mobile-backend-group-1
docker compose up -d --build

# 2. Wait for stack to be healthy (~10s)
# 3. Reset DB to known state
bash loadtest/reset.sh
# (on Windows + WSL, you may need: wsl bash loadtest/reset.sh)

# 4. Run k6 (goes through Nginx :80 → nest-1/2/3)
k6 run --env BASE_URL=http://localhost loadtest/flash-sale.js
```

## Test against a friend's deployment

```powershell
k6 run --env BASE_URL=http://<friend-ip-or-host> loadtest/flash-sale.js
```

## What the script does

| Phase | Time | VUs | What |
|---|---|---|---|
| Setup | once | — | Fetch 500 JWTs (user-1 … user-500) |
| Read | 0–30s | 1000 | GET /api/v1/products?page=1&limit=10 |
| Write | 35–65s | 500 | POST /api/v1/orders for p-1001, 2-3 iters per VU |

## Expected output (key metrics)

```
     ✓ status is 200
     ✓ has data array
     ✓ status is 202 or 409

     checks.........................: 100.00% ✓
     data_received..................: 45 MB
     data_sent......................: 12 MB
     http_req_blocked...............: avg=1.2ms    p(95)=5ms
     http_req_connecting............: avg=800µs    p(95)=3ms
     http_req_duration..............: avg=120ms    p(95)=280ms
     http_req_failed................: 5.20%   (409s from duplicate lock)
     http_reqs......................: 45,231   823.4/s
     iteration_duration.............: avg=2.3s    p(95)=4.1s
     vus............................: 500      min=0   max=1000
```

## Save results to JSON

```powershell
k6 run --env BASE_URL=http://localhost `
     --out json=loadtest/results/summary.json `
     loadtest/flash-sale.js
```

(Summaries are also printed to stdout at end of run.)

## Common issues

| Error | Cause | Fix |
|---|---|---|
| `setup failed: cannot fetch JWT` | stack not ready | wait longer after `docker compose up` |
| `connection refused` | wrong BASE_URL | use `http://localhost` not `https://` |
| All requests time out | nginx not up | check `docker compose ps` |
| `products count: 0` after reset | seeder hasn't run yet | wait, then re-run reset |