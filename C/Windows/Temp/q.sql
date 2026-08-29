SELECT "productId", "remainingStock", "availableStock" FROM products WHERE "productId"='p-1001';
SELECT COUNT(*) FROM orders WHERE "productId"='p-1001' AND status='SUCCESS';
SELECT "userId" FROM orders WHERE "productId"='p-1001' AND status='SUCCESS' ORDER BY "createdAt" ASC LIMIT 30;