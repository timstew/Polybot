# Polybot Operations Runbook

Quick reference for monitoring, debugging, and deploying the copy trading and strategy execution systems.

## Architecture

- **Cloud Run** (Python/FastAPI): `https://polybot-api-182262919086.europe-west4.run.app` — order execution, bot detection
- **Cloudflare Worker**: `https://polybot-copy-listener.timstew.workers.dev` — copy trading, strategy execution, D1 storage
- **Cloudflare Pages** (Next.js): dashboard UI
- **D1 Database**: `polybot` (copy trades + strategy data), `polybot-firehose` (market data + bot detection)
- **Durable Objects**: CopyListenerDO, FirehoseDO, WatchlistDO, StrategyDO
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

## Strategy Execution

### Data Dependencies

All strategies run on **REST polling only** — no streaming/WebSocket required for core functionality:

| Data | Source | Transport | Polling interval |
|------|--------|-----------|-----------------|
| Spot prices | Binance REST API | HTTPS | Every tick (5s), 1s cache |
| Fallback prices | Coinbase REST API | HTTPS | On Binance failure |
| Market discovery | Data API /trades | HTTPS | Every 15-30s |
| Market resolution | Gamma API /markets | HTTPS | On window end + 10s |
| Order books | CLOB API /book | HTTPS | Every tick (paper model) |

**Optional enhancement (local dev only)**: Setting `enable_order_flow: true` in strategy params opens a Binance WebSocket (`wss://stream.binance.com:9443/ws/{symbol}@aggTrade`) for real-time buy/sell volume imbalance. This adds a 6th signal layer (confidence multiplier 0.4-1.5x) but **does not work in deployed CF Workers** (Workers cannot hold persistent outbound WebSocket connections). Default is `false`.

### Local Development Setup

```bash
cd worker

# Start wrangler dev with persistent DO state, debug logging, port 8787
./dev.sh

# Apply schema (first time only)
npx wrangler d1 execute polybot --file=schema-ops.sql

# Create a spread sniper strategy
curl -X POST localhost:8787/api/strategy/configs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sniper paper",
    "strategy_type": "spread-sniper",
    "mode": "paper",
    "max_capital_usd": 2000,
    "params": {"enable_order_flow": true}
  }'

# Create with balance protection (ratchet lock)
# balance_usd=100 means: start with $100 bankroll, lock profits in $100 increments,
# auto-stop when working capital hits $0. lock_increment_usd defaults to balance_usd.
curl -X POST localhost:8787/api/strategy/configs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sniper protected",
    "strategy_type": "spread-sniper",
    "mode": "paper",
    "max_capital_usd": 2000,
    "balance_usd": 100,
    "params": {"enable_order_flow": true}
  }'

# Create a directional maker strategy
curl -X POST localhost:8787/api/strategy/configs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Maker paper",
    "strategy_type": "directional-maker",
    "mode": "paper",
    "max_capital_usd": 2000,
    "params": {"enable_order_flow": true}
  }'

# Start strategies
curl -X POST localhost:8787/api/strategy/start/<config-id>

# Monitor
curl -s localhost:8787/api/strategy/statuses | python3 -m json.tool
curl -s localhost:8787/api/strategy/status/<config-id> | python3 -m json.tool
curl -s localhost:8787/api/strategy/logs/<config-id>?limit=30
```

**Local dev notes**:
- Always use `./dev.sh` (never `npm exec wrangler dev` — it swallows flags). See `dev.sh` for details.
- **`./dev.sh` kills and restarts all services** (worker, Python API, web) every time it's run. If a previous `dev.sh` is running, it kills that too. This is the correct way to pick up code changes — just re-run `./dev.sh`.
- `--persist-to .wrangler/state` keeps DO state across wrangler restarts
- `enable_order_flow: true` works because `wrangler dev` runs in Node.js (WebSocket connections persist via DO alarms)
- DOs may lose state on eviction — strategy configs are in D1 (durable), but window state (active positions, inventory) is in-memory
- The cron trigger (`* * * * *`) auto-restarts DOs but only in production; locally, restart manually if ticking stops

#### Auto-start on login (macOS LaunchAgent)

A LaunchAgent at `~/Library/LaunchAgents/com.polybot.worker.plist` auto-starts the worker dev server on login and restarts it if it crashes. This is **local dev only** — the deployed worker runs on Cloudflare.

```bash
# Load (enable auto-start)
launchctl load ~/Library/LaunchAgents/com.polybot.worker.plist

# Unload (disable auto-start)
launchctl unload ~/Library/LaunchAgents/com.polybot.worker.plist

# Manual stop/start
launchctl stop com.polybot.worker
launchctl start com.polybot.worker

# Logs
tail -f worker/launchd-out.log
tail -f worker/launchd-err.log
```

If the Node.js path changes (e.g. nvm version update), edit the `PATH` in the plist to match `which npx`.

### Remote Mac Mini (Always-On Dev Server)

The Mac mini at `clawdia@100.70.186.4` (Tailscale) runs all three services 24/7 with auto-restart on crash/reboot.

| Service | Port | URL from laptop |
|---------|------|-----------------|
| Worker (wrangler dev) | 8787 | `http://100.70.186.4:8787` |
| Python API (uvicorn) | 8000 | `http://100.70.186.4:8000` |
| Web (next dev) | 3000 | `http://100.70.186.4:3000` |

```bash
# SSH in
ssh clawdia@100.70.186.4

# Open the dashboard from your laptop
open http://100.70.186.4:3000

# Check strategy status from laptop
curl -s http://100.70.186.4:8787/api/strategy/statuses | python3 -m json.tool
```

#### Managing the services

All three services are managed by `worker/dev-remote.sh`, which binds to `0.0.0.0` and health-checks every 10s.

```bash
# Restart all services
ssh clawdia@100.70.186.4 'cd ~/Projects/Polybot/worker && kill $(cat .dev-remote.pid) 2>/dev/null; sleep 2; nohup ./dev-remote.sh > /dev/null 2>&1 &'

# Stop all services
ssh clawdia@100.70.186.4 'cd ~/Projects/Polybot/worker && kill $(cat .dev-remote.pid) 2>/dev/null'

# View logs
ssh clawdia@100.70.186.4 'tail -50 ~/Projects/Polybot/worker/wrangler-dev.log'
ssh clawdia@100.70.186.4 'tail -50 ~/Projects/Polybot/worker/python-api.log'
ssh clawdia@100.70.186.4 'tail -50 ~/Projects/Polybot/worker/next-dev.log'
```

#### Syncing code changes from laptop

```bash
rsync -avz \
  --exclude node_modules --exclude .wrangler --exclude wrangler-data \
  --exclude .venv --exclude __pycache__ --exclude .next --exclude out \
  ~/Projects/Polybot/ clawdia@100.70.186.4:~/Projects/Polybot/

# Then restart services to pick up changes
ssh clawdia@100.70.186.4 'cd ~/Projects/Polybot/worker && kill $(cat .dev-remote.pid) 2>/dev/null; sleep 2; nohup ./dev-remote.sh > /dev/null 2>&1 &'
```

#### Auto-start on boot (LaunchAgent)

A LaunchAgent at `~/Library/LaunchAgents/com.polybot.worker.plist` runs `dev-remote.sh` on login with `KeepAlive=true`.

```bash
# Enable (already loaded)
ssh clawdia@100.70.186.4 'launchctl load ~/Library/LaunchAgents/com.polybot.worker.plist'

# Disable
ssh clawdia@100.70.186.4 'launchctl unload ~/Library/LaunchAgents/com.polybot.worker.plist'

# LaunchAgent logs
ssh clawdia@100.70.186.4 'tail -30 ~/Projects/Polybot/worker/launchd-stdout.log'
ssh clawdia@100.70.186.4 'tail -30 ~/Projects/Polybot/worker/launchd-stderr.log'
```

#### Environment on the Mac mini

- **Bun** 1.3.11: `~/.bun/bin/bun` (package manager + script runner)
- **Node.js** v22.16.0: `~/.local/node/bin/node` (required by wrangler)
- **Python** 3.12: via Homebrew, venv at `~/Projects/Polybot/.venv`
- **Homebrew**: `/opt/homebrew/bin/brew`
- **Wrangler auth**: OAuth token at `~/Library/Preferences/.wrangler/config/default.toml` (auto-refreshes)
- **Config**: `.env` and `worker/.dev.vars` copied from laptop

### Remote/Production Setup

```bash
cd worker

# Deploy worker
npx wrangler deploy

# Apply schema to remote D1
npx wrangler d1 execute polybot --remote --file=schema-ops.sql

# Balance protection migration (one-time, if not yet applied to remote)
npx wrangler d1 execute polybot --remote --command "ALTER TABLE strategy_configs ADD COLUMN balance_usd REAL DEFAULT NULL;"
npx wrangler d1 execute polybot --remote --command "ALTER TABLE strategy_configs ADD COLUMN lock_increment_usd REAL DEFAULT NULL;"

# Create strategy (use deployed worker URL)
WORKER=https://polybot-copy-listener.timstew.workers.dev
curl -X POST $WORKER/api/strategy/configs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sniper production",
    "strategy_type": "spread-sniper",
    "mode": "paper",
    "max_capital_usd": 2000,
    "params": {}
  }'

# Start
curl -X POST $WORKER/api/strategy/start/<config-id>

# Monitor
curl -s $WORKER/api/strategy/statuses | python3 -m json.tool
```

**Production notes**:
- Do NOT set `enable_order_flow: true` — CF Workers cannot hold WebSocket connections across requests
- All price data comes from Binance/Coinbase REST APIs (no streaming dependency)
- Strategy signal uses 5 layers: magnitude, momentum, acceleration, volatility regime, hysteresis (all REST-based)
- The cron trigger restarts DOs every minute as a heartbeat; `userStopped` flag prevents unwanted restarts
- The cron also sweeps unredeemed positions via Cloud Run `/api/redeem/sweep` every minute, independent of strategy lifecycle
- After deploying, StrategyDO may run old code — stop and restart strategies to pick up changes

### Strategy Types

| Type | File | Approach | Best for |
|------|------|----------|----------|
| `spread-sniper` | `spread-sniper.ts` | Direction-agnostic, neutral fair value, pure spread capture | Consistent returns, low variance |
| `directional-maker` | `directional-maker.ts` | Aggressive signal-biased maker, sells ALL losing-side inventory on flip | Trending markets (higher variance) |
| `safe-maker` | `safe-maker.ts` | Conservative signal-biased maker, protects paired inventory from sale | Lower risk directional |
| `conviction-maker` | `conviction-maker.ts` | One-sided conviction bets, only bids when signal > 0.60, hold to resolution | Strong trends, BTC lead-lag |
| `avellaneda-maker` | `avellaneda-maker.ts` | Avellaneda-Stoikov market maker with P_true + Delta pricing | Volatile markets |
| `certainty-taker` | `certainty-taker.ts` | BoneReader-style taker, sweeps at P_true > 0.95 | High-conviction late-window |
| `directional-taker` | `directional-taker.ts` | Market-takes based on signal | Not viable (ultra-wide spreads) |
| `unified-adaptive` | `unified-adaptive.ts` | Picks sniper/maker per window, adaptive sizing | Mixed conditions |
| `orchestrator` | `orchestrator.ts` | Meta-strategy: regime-based tactic selection with Thompson Sampling bandit | Adaptive regime switching |
| `split-arb` | `split-arb.ts` | Complementary token arbitrage | Low-spread opportunities |
| `passive-mm` | `passive-mm.ts` | Passive market making | General market making |

### Snapshot Recording & Optimization

See [OPTIMIZER.md](./OPTIMIZER.md) for full architecture and future plans.

A safe-maker with `record_snapshots: true` runs 24/7 on the Mac mini, capturing per-tick market data for offline parameter optimization.

```bash
# Check recording status (on Mac mini)
ssh clawdia@100.70.186.4 'export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:$PATH"; cd ~/Projects/Polybot/worker && npx wrangler d1 execute polybot --command "SELECT count(*) as rows, round(sum(length(ticks))/1024.0/1024.0,1) as mb FROM strategy_snapshots"'

# Breakdown by symbol and duration
ssh clawdia@100.70.186.4 'export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:$PATH"; cd ~/Projects/Polybot/worker && npx wrangler d1 execute polybot --command "SELECT crypto_symbol, window_duration_ms/60000 as min, count(*) as n FROM strategy_snapshots GROUP BY 1,2"'

# Run optimizer (on Mac mini — reads local D1 SQLite directly)
ssh clawdia@100.70.186.4 'export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:$PATH"; cd ~/Projects/Polybot/worker && npx tsx src/optimizer/optimize.ts'
```

### Monitoring Commands

```bash
# All strategy statuses
curl -s localhost:8787/api/strategy/statuses | python3 -c "
import json, sys
for sid, s in json.load(sys.stdin).items():
    c = s.get('state', {}).get('custom', {})
    pnl = c.get('totalPnl', s.get('state', {}).get('total_pnl', 0))
    aw = len(c.get('activeWindows', []))
    cw = len(c.get('completedWindows', []))
    print(f'{s.get(\"config\",{}).get(\"name\",sid)}: PnL=\${pnl:.2f} active={aw} done={cw}')
"

# Detailed window view for a single strategy
curl -s localhost:8787/api/strategy/status/<id> | python3 -c "
import json, sys
d = json.load(sys.stdin)
c = d['state']['custom']
for w in c.get('activeWindows', []):
    t = w['market']['title']
    print(f'  ACTIVE {t}: inv={w[\"upInventory\"]}/{w[\"downInventory\"]}')
for w in c.get('completedWindows', [])[-5:]:
    print(f'  DONE {w[\"title\"]}: {w[\"outcome\"]} pnl=\${w[\"netPnl\"]:.2f}')
"

# Signal-level logs
curl -s "localhost:8787/api/strategy/logs/<id>?limit=30&level=signal"

# Strategy trades from D1
curl -s localhost:8787/api/strategy/trades/<id> | python3 -m json.tool | head -40
```

### D1 Strategy Queries

```sql
-- Strategy performance summary
SELECT strategy_id, COUNT(*) as trades,
  ROUND(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END), 2) as wins,
  ROUND(SUM(CASE WHEN pnl < 0 THEN pnl ELSE 0 END), 2) as losses,
  ROUND(SUM(pnl), 2) as net_pnl
FROM strategy_trades GROUP BY strategy_id;

-- Recent signal logs (flips, dead zones)
SELECT timestamp, symbol, direction, signal_strength, flip_count, phase, message
FROM strategy_logs
WHERE strategy_id = '<id>' AND level = 'signal'
ORDER BY timestamp DESC LIMIT 50;

-- Delete old strategy logs (cleanup)
DELETE FROM strategy_logs WHERE timestamp < datetime('now', '-24 hours');
```

### Troubleshooting

### Stopping Strategies (Graceful Wind-Down)

Clicking stop enters **wind-down mode** instead of killing immediately:
- No new window entries
- Bids on the light side to create matched pairs (reduces unmatched exposure)
- Waits for existing windows to resolve, then auto-stops

```bash
# First stop = wind-down (keeps ticking, completes existing windows)
curl -X POST localhost:8787/api/strategy/stop/<id>
# Returns: {"status": "winding_down"}

# Second stop = force-stop (immediate halt, same as old behavior)
curl -X POST localhost:8787/api/strategy/stop/<id>
# Returns: {"status": "stopped"}

# Or force-stop directly (skip wind-down)
curl -X POST localhost:8787/api/strategy/force-stop/<id>
```

Safety triggers (balance protection, balance alarm) also enter wind-down rather than hard-killing, so in-flight positions can resolve profitably.

**Strategy stopped ticking**: The DO alarm chain can break if an error occurs or the DO is evicted. The `/status` endpoint has self-heal logic that re-arms the alarm if stale >30s, so check status first. If still stuck, force-stop and restart:
```bash
# Check if self-heal kicks in
curl -s localhost:8787/api/strategy/status/<id> | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'running={d[\"running\"]} ticks={d[\"state\"][\"ticks\"]} last_tick={d[\"state\"][\"last_tick_at\"]}')"

# If still stuck, force-stop and restart
curl -X POST localhost:8787/api/strategy/force-stop/<id>
curl -X POST localhost:8787/api/strategy/start/<id>
```

**One-sided inventory**: If a strategy accumulates heavily on one side (e.g., 90 UP / 0 DN), check:
1. Per-tick safety is running (cancels heavy-side bids every tick)
2. `max_inventory_ratio` is set (default 2:1 for maker)
3. Signal amplitude isn't overwhelming inventory skew (maker: signal=0.20, skew=0.25)

**Strategy code not updating**: After editing `.ts` files, wrangler dev auto-rebuilds, but running DOs keep old code in memory. Stop the strategy (wind-down first if mid-trade, then restart once windows resolve) or force-stop if no positions are in flight:
```bash
# Safe: wind-down → wait for auto-stop → restart
curl -X POST localhost:8787/api/strategy/stop/<id>
# ... wait for active windows to resolve, then:
curl -X POST localhost:8787/api/strategy/start/<id>

# Quick: force-stop if no active windows / positions
curl -X POST localhost:8787/api/strategy/force-stop/<id>
curl -X POST localhost:8787/api/strategy/start/<id>
```

**5-min windows losing money**: The spread sniper uses adaptive bid sizing — 5-min windows get smaller bids (10 instead of 30) to prevent one-sided accumulation. If you see 30/0 inventory on 5-min windows, the adaptive sizing may not be active.

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
cd web && npm run build && npx wrangler pages deploy out --project-name=polybot
```
Dashboard URL: `https://polybot-b5l.pages.dev`

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

### full_copy_below_usd threshold
When set on a copy target, trades with notional below this threshold are copied at 100% regardless of trade_pct. Trades above the threshold use the configured percentage. This prevents tiny trades from being sized down to below the minimum. **Caution**: many small trades copied at 100% can still drain the account if a bot makes dozens of sub-threshold trades on the same market. Consider pairing with a per-market capital cap.

### Account draining from many small trades
MuseumOfBees copied 98 sub-$20 trades at 100% on one market, totaling $699. The per-trade threshold was met but aggregate exposure was not capped. Future improvement: add per-market capital cap to the Worker.

### Durable Object caching old code
After deploying the Worker, the Durable Object may keep running old code. Restart it:
```bash
curl -s -X POST https://polybot-copy-listener.timstew.workers.dev/stop
curl -s -X POST https://polybot-copy-listener.timstew.workers.dev/start
```
