# Polybot Operations Runbook

Quick reference for monitoring, debugging, and deploying the copy trading system.

## Architecture

- **Cloud Run** (Python/FastAPI): `https://polybot-api-182262919086.europe-west4.run.app` — order execution, bot detection
- **Cloudflare Worker**: `https://polybot-copy-listener.timstew.workers.dev` — polls bot activity, decides what to copy, records trades in D1
- **Cloudflare Pages** (Next.js): dashboard UI
- **D1 Database**: `polybot` (main), `polybot-firehose` (market data)
- **Bot wallet** (hue8883): `0x2ba9075a4393227d4f1bee910725a6706de0b078`
- **Funder wallet**: `0xe0ef345be76588f0975f4ca1c87e609e138c5222`

## Monitoring

### Check listener status
```bash
curl -s https://polybot-copy-listener.timstew.workers.dev/api/copy/listener/cloud-status
```

### Watch worker logs in real-time
```bash
cd worker && npx wrangler tail --format pretty
# Filter for trade activity only:
cd worker && npx wrangler tail --format pretty 2>&1 | grep -E '\[REAL\]|error|Error'
```

### Check Cloud Run logs
```bash
# Recent errors
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="polybot-api" AND severity>=WARNING' --limit=10 --format='value(timestamp,textPayload)'

# Execute endpoint requests
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="polybot-api" AND httpRequest.requestUrl:"/api/copy/execute"' --limit=10 --format='value(timestamp,httpRequest.status)'

# Errors after a specific time
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="polybot-api" AND severity>=WARNING AND timestamp>="2026-02-19T07:00:00Z"' --limit=10 --format='value(timestamp,textPayload)'
```

## D1 Database Queries

All queries use: `cd /Users/tim/Projects/Polybot && npx wrangler d1 execute polybot --remote --command "...""`

### Trade summary (by side/status)
```sql
SELECT side, status, COUNT(*) as cnt,
  ROUND(SUM(size * price), 2) as total_notional
FROM copy_trades
WHERE source_wallet = '0x2ba9075a4393227d4f1bee910725a6706de0b078'
  AND mode = 'real'
  AND timestamp > datetime('now', '-24 hours')
GROUP BY side, status ORDER BY side, status
```

### Recent filled trades
```sql
SELECT timestamp, side, status, ROUND(size,2) as size,
  ROUND(price,4) as price, ROUND(size*price,2) as notional, title
FROM copy_trades
WHERE source_wallet = '0x2ba9075a4393227d4f1bee910725a6706de0b078'
  AND mode = 'real' AND status = 'filled'
ORDER BY timestamp DESC LIMIT 20
```

### Recent trades (all statuses)
```sql
SELECT timestamp, side, status, ROUND(size,2) as size,
  ROUND(price,4) as price, ROUND(size*price,2) as notional, title
FROM copy_trades
WHERE source_wallet = '0x2ba9075a4393227d4f1bee910725a6706de0b078'
  AND mode = 'real' AND timestamp > '2026-02-19T07:00:00Z'
ORDER BY timestamp DESC LIMIT 20
```

### P&L summary
```sql
WITH positions AS (
  SELECT asset_id, title,
    SUM(CASE WHEN side='BUY' THEN size ELSE 0 END) as bought,
    SUM(CASE WHEN side='SELL' THEN size ELSE 0 END) as sold,
    SUM(CASE WHEN side='BUY' THEN size * price ELSE 0 END) as cost,
    SUM(CASE WHEN side='SELL' THEN size * price ELSE 0 END) as revenue
  FROM copy_trades
  WHERE source_wallet = '0x2ba9075a4393227d4f1bee910725a6706de0b078'
    AND mode = 'real' AND status = 'filled'
  GROUP BY asset_id
)
SELECT
  COUNT(*) as markets,
  ROUND(SUM(cost), 2) as total_cost,
  ROUND(SUM(revenue), 2) as total_revenue,
  ROUND(SUM(revenue - cost), 2) as total_pnl,
  SUM(CASE WHEN bought > sold + 0.01 THEN 1 ELSE 0 END) as open_positions,
  ROUND(SUM(CASE WHEN bought > sold + 0.01 THEN cost - revenue ELSE 0 END), 2) as unrealized_cost
FROM positions
```

### Split trades vs resolutions (price=1.0 = market resolved as winner)
```sql
SELECT
  CASE WHEN price >= 0.99 THEN 'resolution' ELSE 'trade' END as type,
  side, status, COUNT(*) as cnt,
  ROUND(SUM(size * price), 2) as total_notional
FROM copy_trades
WHERE source_wallet = '0x2ba9075a4393227d4f1bee910725a6706de0b078'
  AND mode = 'real' AND status = 'filled'
GROUP BY type, side, status ORDER BY type, side
```

### Open positions (held shares)
```sql
SELECT asset_id, title,
  ROUND(SUM(CASE WHEN side='BUY' THEN size ELSE 0 END), 2) as bought,
  ROUND(SUM(CASE WHEN side='SELL' THEN size ELSE 0 END), 2) as sold,
  ROUND(SUM(CASE WHEN side='BUY' THEN size ELSE 0 END) - SUM(CASE WHEN side='SELL' THEN size ELSE 0 END), 2) as held,
  ROUND(SUM(CASE WHEN side='BUY' THEN size*price ELSE -size*price END), 2) as net_cost
FROM copy_trades
WHERE source_wallet = '0x2ba9075a4393227d4f1bee910725a6706de0b078'
  AND mode = 'real' AND status = 'filled'
GROUP BY asset_id
HAVING ABS(bought - sold) > 0.01
ORDER BY timestamp DESC
```

### Phantom sells (sold > bought — should be zero after fix)
```sql
SELECT COUNT(*) as phantom_markets,
  ROUND(SUM(sold - bought), 2) as total_phantom_shares
FROM (
  SELECT asset_id,
    SUM(CASE WHEN side='BUY' THEN size ELSE 0 END) as bought,
    SUM(CASE WHEN side='SELL' THEN size ELSE 0 END) as sold
  FROM copy_trades
  WHERE source_wallet = '0x2ba9075a4393227d4f1bee910725a6706de0b078'
    AND mode = 'real' AND status = 'filled'
  GROUP BY asset_id
  HAVING sold > bought + 0.01
)
```

### Detailed trade log for a specific market
```sql
SELECT timestamp, side, ROUND(size,2) as size, ROUND(price,4) as price,
  ROUND(size*price,2) as notional, status
FROM copy_trades
WHERE source_wallet = '0x2ba9075a4393227d4f1bee910725a6706de0b078'
  AND mode = 'real' AND status = 'filled'
  AND asset_id = '<ASSET_ID_HERE>'
ORDER BY timestamp
```

### Trade date range
```sql
SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest, COUNT(*) as total
FROM copy_trades
WHERE source_wallet = '0x2ba9075a4393227d4f1bee910725a6706de0b078'
  AND mode = 'real' AND status = 'filled'
```

### D1 schema inspection
```sql
PRAGMA table_info(copy_trades)
```

### List D1 databases
```bash
npx wrangler d1 list
```

## Deployment

### Deploy Worker (from worker/ dir)
```bash
cd worker && npx wrangler deploy
```

### Deploy Cloud Run
**IMPORTANT**: The `.env` file does NOT contain the private key or funder address. These are set on Cloud Run directly. Use `--env-vars-file` to preserve them across deploys.

```bash
# 1. Extract env vars from current working revision
gcloud run revisions describe <REVISION_NAME> --region europe-west4 --format=json | python3 -c "
import json,sys
rev = json.load(sys.stdin)
envs = rev['spec']['containers'][0].get('env',[])
with open('/tmp/polybot-env.yaml', 'w') as f:
    for e in envs:
        f.write(f\"{e['name']}: \\\"{e.get('value','')}\\\"\n\")
"

# 2. Deploy with those env vars
gcloud run deploy polybot-api --source . --region europe-west4 --allow-unauthenticated --env-vars-file=/tmp/polybot-env.yaml

# 3. Clean up
rm /tmp/polybot-env.yaml
```

To find the last working revision:
```bash
gcloud run revisions list --service=polybot-api --region=europe-west4 --limit=5
```

To check env vars on current service:
```bash
gcloud run services describe polybot-api --region europe-west4 --format=json | python3 -c "
import json,sys
svc = json.load(sys.stdin)
envs = svc['spec']['template']['spec']['containers'][0].get('env',[])
for e in envs:
    n = e.get('name','')
    v = e.get('value','')
    if 'KEY' in n or 'PRIVATE' in n:
        print(f'{n}=***{v[-4:] if len(v)>4 else \"(empty)\"}')
    else:
        print(f'{n}={v}')
"
```

### Deploy Dashboard (Cloudflare Pages)
```bash
cd web && npm run build && npx wrangler pages deploy .next --project-name=polybot-dashboard
```

## Testing

### Test execute endpoint directly
```bash
curl -s -X POST https://polybot-api-182262919086.europe-west4.run.app/api/copy/execute \
  -H "Content-Type: application/json" \
  -d '{"asset_id":"<TOKEN_ID>","side":"BUY","size":11.0,"price":0.25,"source_wallet":"0x2ba9075a4393227d4f1bee910725a6706de0b078","market":"test"}'
```

### Check Polymarket positions for funder wallet
```bash
curl -s "https://data-api.polymarket.com/positions?user=0xe0ef345be76588f0975f4ca1c87e609e138c5222" | python3 -m json.tool | head -50
```

## Known Issues & Fixes

### Env vars lost on deploy
The `--set-env-vars` flag from `.env` file will **overwrite** all env vars including the private key (which isn't in `.env`). Always use `--env-vars-file` extracted from a working revision.

### Polymarket geoblocking
Cloud Run must be in **europe-west4** (Netherlands). US, Belgium (europe-west1), and Singapore (asia-southeast1) are all blocked.

### Decimal precision
Using `create_order` (size-based) instead of `create_market_order` (notional-based) because the py-clob-client library's `get_market_order_amounts` has a rounding bug where it allows 4 decimal places on taker amount, but Polymarket now requires max 2.

### Phantom sells (overselling)
Multiple SELLs in the same poll cycle could each read the same DB position and all pass the "held" check. Fixed with in-memory `pendingSells` map that tracks sell sizes within a single poll cycle.

### Minimum order sizes
Polymarket requires: minimum 5 shares, minimum $1 notional. Orders below these thresholds are rejected.
