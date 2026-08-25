# Postman Collection — Flash Sale API

## Files

- `flash-sale.postman_collection.json` — collection (12 requests in 5 folders)
- `flash-sale.postman_environment.json` — local environment

## Import

1. Open Postman → **Import** → drop both JSON files
2. Select environment **"Flash Sale (local)"** from the dropdown (top-right)
3. Make sure your stack is running (`docker compose up -d` or local `npm run start:dev`)

## Folders & recommended run order

| # | Folder | Request | Status | Purpose |
|---|---|---|---|---|
| 1 | Health | `GET /health` | 200 | Instance identity |
| 2 | Auth | `POST /auth/token` | 200 | **Saves JWT to env** |
| 2 | Auth | `POST /auth/token` (empty) | 400 | Validation check |
| 3 | Products | `GET /products?page=1&limit=10` | 200 | First call → cache MISS |
| 3 | Products | same again | 200 | Second call → cache HIT |
| 3 | Products | `?page=2&limit=5` | 200 | Different page → cache MISS |
| 3 | Products | `?limit=999` | 400 | Validation check |
| 4 | Orders | `POST /orders` (auth) | **202** | Enqueues job; saves `orderJobId` |
| 4 | Orders | `POST /orders` (same user) | **409** | API-level lock blocks duplicate |
| 4 | Orders | `POST /orders` (no auth) | 401 | JWT guard blocks |
| 4 | Orders | `POST /orders` (bad token) | 401 | JWT guard blocks |
| 5 | Bull-Board | dashboard URL | HTML | Open in browser for visual UI |

## How to run end-to-end

Use **Collection Runner** (right-click collection → "Run collection") to execute all requests sequentially with the environment selected. After the run finishes:

- All test scripts should be green
- Check `docker compose logs -f nest-1` for `[CACHE HIT]` lines
- Check Bull-Board to see the completed order job

## What you'll see after a successful order

```sql
-- Connect to primary
docker exec -it <primary-container> psql -U app -d flashsale -c "SELECT \"userId\", \"productId\", status, \"createdAt\" FROM orders;"
-- 1 row: user-1 | p-1001 | SUCCESS | <timestamp>

-- Stock decremented from 50 → 49
docker exec -it <primary-container> psql -U app -d flashsale -c "SELECT \"remainingStock\" FROM products WHERE \"productId\"='p-1001';"
-- 49

-- Same data on replica (replication works)
docker exec -it <replica-container> psql -U app -d flashsale -c "SELECT \"remainingStock\" FROM products WHERE \"productId\"='p-1001';"
-- 49
```