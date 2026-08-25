# Reset p-1001 stock to 50, clear orders table, flush Redis cache.
# Native PowerShell — works from Windows PowerShell or PowerShell Core
# without needing WSL.
#
# Usage:
#   .\loadtest\reset.ps1

$ErrorActionPreference = "Stop"

# Locate repo root (this script's parent directory)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

Write-Host "→ Resetting p-1001 stock to 50 and clearing orders..." -ForegroundColor Cyan
docker compose exec -T postgres-primary psql -U app -d flashsale -c "UPDATE products SET `"remainingStock`" = 50 WHERE `"productId`" = 'p-1001'; TRUNCATE TABLE `"orders`";"

Write-Host "→ Flushing Redis cache + counters..." -ForegroundColor Cyan
docker compose exec -T redis redis-cli FLUSHDB | Out-Null

Write-Host "→ Verifying reset..." -ForegroundColor Cyan
docker compose exec -T postgres-primary psql -U app -d flashsale -c "SELECT `"productId`", `"remainingStock`" FROM products WHERE `"productId`" = 'p-1001';"
docker compose exec -T postgres-primary psql -U app -d flashsale -c "SELECT count(*) AS `"orders`" FROM orders;"

Write-Host "✓ Reset complete. Ready for k6 run." -ForegroundColor Green
Write-Host "  Run: k6 run --env BASE_URL=http://localhost loadtest/flash-sale.js" -ForegroundColor Yellow