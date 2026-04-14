# Polybot

Detects automated trading bots on [Polymarket](https://polymarket.com) and runs algorithmic strategies on crypto binary options ("Will BTC be above $X?").

## Architecture

```
Standalone Runner    — primary local strategy execution (pure Node.js, real WebSockets)
Cloudflare Worker    — copy trading, D1 storage, cloud strategy execution (DO/alarm)
Cloud Run (Python)   — bot detection, CLOB order placement
Cloudflare Pages     — Next.js dashboard
Mac mini (always-on) — standalone runner, shadow trading, 24/7 recording
```

Primary strategy: **BabyBoneR** — reverse-engineered from Bonereaper, a profitable automated trader on Polymarket. See [BONEREAPER-ANALYSIS.md](./BONEREAPER-ANALYSIS.md) for the full analysis.

## Quick Start

```bash
# Python API (from repo root)
pip install -e ".[dev]"
uvicorn polybot.api:app --port 8000 --reload

# Standalone runner (from worker/ — recommended for local dev)
cd worker && npx tsx src/standalone-runner.ts

# Worker (from worker/ — needed for API routes, copy trading, dashboard)
cd worker && ./dev.sh

# Frontend (from web/)
cd web && npm run dev

# Tests (from worker/)
cd worker && bun test
```

## Standalone Runner (Primary Local Execution)

The **standalone runner** (`worker/src/standalone-runner.ts`) is the primary way to run strategies locally. It runs as pure Node.js outside the Cloudflare Worker runtime, eliminating all CF limitations:

- **Real `setInterval` tick loops** — no DO alarm hacks
- **Real WebSocket connections** — Oracle (Chainlink), CLOB, Binance order flow all work natively
- **No DO eviction** — state lives in memory for the process lifetime
- **Direct D1 SQLite access** — uses `better-sqlite3` to read/write the same `.wrangler/state` D1 database that `wrangler dev` uses
- **Graceful shutdown** — `SIGTERM`/`SIGINT` flushes state but preserves `active` flags, so strategies auto-restart after deploys
- **Boundary-crossing discovery** — detects new 5m/15m windows within 1-3 seconds of opening (pre-fetches markets 5s before window open)

```bash
cd worker && npx tsx src/standalone-runner.ts
```

The strategy code (`init/tick/stop` interface) is identical to the CF Worker path — only the execution wrapper differs. The standalone runner reads strategy configs from D1, starts tick loops, and writes trades/logs back to D1.

### Tick Simulator (deprecated intermediate step)

The in-worker tick simulator (`worker/src/tick-simulator.ts`, `USE_SIMULATOR` env var) was an intermediate approach that ran inside the CF Worker process. It solved DO eviction but still suffered from CF I/O context issues (WebSocket connections, module imports). The standalone runner supersedes it. The `USE_SIMULATOR` env var is no longer needed.

### Cloudflare Deployment

For cloud deployment, the existing DO/alarm system in `strategy.ts` still works. Strategies run via `StrategyDO` alarms with state serialization to DO storage. WebSocket-dependent features (Oracle, CLOB WS, Binance WS) fall back to REST polling.

## Paper Fill Systems

Paper mode has three fill systems. The choice depends on what question you're answering:

### 1. Shadow Fills (bot-mimicking)

**Question: "If we copied this bot's exact behavior, would we get the same fills?"**

Watches a real trader's fills via the Polymarket Data API and only grants fills that the real trader achieved. Used by BabyBoneR when `shadow_wallet` is set.

1. Every 10s, fetch the shadow wallet's last 200 trades
2. For each fill in the same market: if our bid price >= their fill price, grant a fill at their execution price and size
3. Only process fills that occurred after we entered the window (prevents inheriting stale one-sided inventory)
4. Track processed fill IDs to prevent double-counting

Best for: replicating a known profitable bot (e.g., Bonereaper). Only useful when you have a specific wallet to shadow.

### 2. Grounded Fills (market-realistic)

**Question: "Would the real market have filled our order?"**

Checks whether our bid crosses the real CLOB ask, and if there's enough volume on the trade tape to fill our size. Used by most strategies when `grounded_fills: true` (default).

1. If bid >= best ask and enough size available at ask levels, fill at ask price
2. Otherwise, check the real trade tape for volume at our price level, accounting for queue position
3. No fill if insufficient real-world liquidity

Best for: realistic paper trading without a specific bot to shadow. The default for most strategies.

### 3. Probabilistic Fills (simulation)

**Question: "Roughly how often would orders at this price get filled?"**

Uses a probability model based on distance from best ask and book depth. Not grounded in real market activity — useful for fast iteration but overly optimistic.

Active when `grounded_fills: false` and no `shadow_wallet` is set.

### Configuration

```json
{
  "shadow_wallet": "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30",
  "pricing_mode": "hybrid"
}
```

- `shadow_wallet` set → shadow fills (BabyBoneR only)
- `grounded_fills: true` (default) → grounded fills
- `grounded_fills: false` → probabilistic fills

In **real mode**, none of these apply. Orders go directly to the Polymarket CLOB and fill against real counterparties.

## Strategy Management

```bash
# Create a BabyBoneR strategy with shadow fills (paper mode)
curl -X POST localhost:8787/api/strategy/configs \
  -d '{
    "name": "bbr-shadow",
    "strategy_type": "babyboner",
    "mode": "paper",
    "max_capital_usd": 20,
    "balance_usd": 20,
    "params": {
      "target_cryptos": ["Bitcoin"],
      "shadow_wallet": "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30",
      "ladder_enabled": false,
      "winning_share": 0.55,
      "merge_exit": true,
      "profit_reinvest_pct": 0.25
    }
  }'

# Start / stop / monitor
curl -X POST localhost:8787/api/strategy/start/strat-<id>
curl -X POST localhost:8787/api/strategy/stop/strat-<id>
curl localhost:8787/api/strategy/statuses
curl localhost:8787/api/strategy/status/strat-<id>
curl "localhost:8787/api/strategy/logs/strat-<id>?limit=50"
```

### Dynamic Capital Scaling

BabyBoneR automatically scales position sizes based on available capital:

| Capital | Bid Size | Max Windows | Window Duration |
|---------|----------|-------------|-----------------|
| $20 | 5 tokens | 1 | 5 min only |
| $60 | 6 tokens | 2 | 5 min only |
| $80+ | 8+ tokens | 2+ | 5 min + 15 min |

### Balance Protection (Ratchet Lock)

When `balance_usd` is set, the HWM ratchet lock protects profits:
- Locks `(1 - profit_reinvest_pct)` of peak profits above initial balance
- Reduces position sizing as working capital shrinks
- Auto-stops only when balance goes to zero (all capital + all profits lost)
- Initial `balance_usd` is always available as working capital

## Documentation

| Doc | Purpose |
|-----|---------|
| [BONEREAPER-ANALYSIS.md](./BONEREAPER-ANALYSIS.md) | Reverse-engineering of Bonereaper bot: pricing model, fill patterns, profit mechanics |
| [ROADMAP.md](./ROADMAP.md) | Phased plan from local paper trading to cloud-hosted real trading |
| [STRATEGY-IMPROVEMENTS.md](./STRATEGY-IMPROVEMENTS.md) | Top-10 improvement hitlist, per-strategy analysis |
| [CLAUDE.md](./CLAUDE.md) | Developer reference: architecture, data flows, key files, API endpoints |
| [RUNBOOK.md](./RUNBOOK.md) | Deployment procedures and operational notes |
| [OPTIMIZER.md](./OPTIMIZER.md) | Offline replay and parameter optimization system |
| [redemption-code.md](./redemption-code.md) | EOA wallet setup for on-chain position redemption |

## Key Files

### Strategy System
| File | Purpose |
|------|---------|
| `worker/src/strategies/babyboner.ts` | BabyBoneR: Bonereaper-replication strategy with shadow fills |
| `worker/src/standalone-runner.ts` | Standalone runner: pure Node.js strategy execution (primary for local dev) |
| `worker/src/tick-simulator.ts` | In-worker tick simulator (deprecated, superseded by standalone runner) |
| `worker/src/strategy.ts` | StrategyDO: Cloudflare DO wrapper (used for cloud deployment) |
| `worker/src/strategy-core.ts` | Shared types, interfaces, PaperStrategyAPI, RealStrategyAPI, balance protection |
| `worker/src/strategies/price-feed.ts` | Price fetching, P_true calculation, market discovery |
| `worker/src/strategies/merge.ts` | Auto-merge logic for profitable pairs |

### Tests
| File | Covers |
|------|--------|
| `worker/tests/pricing.test.ts` | Hybrid and ladder pricing at various P_true values |
| `worker/tests/shadow-fills.test.ts` | Shadow fill matching: slug, side, bid coverage, deduplication |
| `worker/tests/capital-gate.test.ts` | Balance protection, capital gate, dynamic scaling |
| `worker/tests/skew-guard.test.ts` | Inventory skew guard (either side capped at 90%) |
| `worker/tests/api-routes.test.ts` | Config parsing, status shape, slug generation, constraints |

## Deployment

```bash
# Worker
cd worker && npx wrangler deploy

# Cloud Run
gcloud run deploy polybot-api --source . --region europe-west4 --allow-unauthenticated

# Frontend
cd web && npm run build:pages && npx wrangler pages deploy out --project-name polybot --branch main
```

See [ROADMAP.md](./ROADMAP.md) for the full deployment plan and cost breakdown ($0/month on free tiers).
