SELECT "userId", "status", "createdAt" FROM orders WHERE "productId"='p-1001' ORDER BY "createdAt" ASC LIMIT 30;
SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='SUCCESS') AS success FROM orders WHERE "productId"='p-1001';
SELECT "remainingStock", "version" FROM products WHERE "productId"='p-1001';
SELECT COUNT(*) FROM orders;
SELECT "userId", COUNT(*) FROM orders WHERE "productId"='p-1001' GROUP BY "userId" ORDER BY COUNT(*) DESC LIMIT 5;