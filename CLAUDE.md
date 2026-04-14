# CLAUDE.md

## What This Is

Polybot detects automated trading bots on Polymarket and copy-trades their strategies. It runs as a three-tier system: Cloud Run (Python/FastAPI API + bot detection), Cloudflare Worker (TypeScript copy execution + D1 storage), and Cloudflare Pages (Next.js dashboard).

## Commands

```bash
# Python (from repo root)
pip install -e ".[dev]"
pytest                                          # all tests
pytest tests/test_detector.py -v                # single file
polybot --help                                  # CLI

# Worker (from worker/)
cd worker && npx wrangler deploy                # deploy worker
npx wrangler d1 execute polybot --file=schema-ops.sql     # apply ops schema
npx wrangler d1 execute polybot --remote --command "SELECT ..."  # query D1
npx tsc --noEmit                                # type-check strategies

# Standalone runner (from worker/ — primary local strategy execution)
cd worker && npx tsx src/standalone-runner.ts    # pure Node.js, real WebSockets, direct D1 SQLite access
# Uses better-sqlite3 to read/write the same .wrangler/state D1 database as wrangler dev.
# Real setInterval tick loops, real WebSocket connections (Oracle, CLOB, Binance), no DO eviction.

# Worker local dev (from worker/ — needed for API routes, copy trading, dashboard)
cd worker && ./dev.sh                           # local dev with persistent DO state, debug logging, port 8787
# IMPORTANT: never use `npm exec wrangler dev` — it swallows --persist-to and --port flags.
# Always use ./dev.sh (or npx wrangler dev). Crash logs: worker/wrangler-dev.log

# Strategy management (local dev at localhost:8787, or use deployed worker URL)
curl -X POST localhost:8787/api/strategy/configs -d '{"name":"my-sniper","strategy_type":"spread-sniper","params":{"enable_order_flow":true}}'
curl -X POST localhost:8787/api/strategy/start/strat-<id>
curl -X POST localhost:8787/api/strategy/stop/strat-<id>
curl localhost:8787/api/strategy/statuses                          # all strategies
curl localhost:8787/api/strategy/status/strat-<id>                 # single strategy
curl localhost:8787/api/strategy/logs/strat-<id>?limit=50          # structured logs

# Frontend (from web/)
cd web && npm run dev                           # local dev (rewrites /api/* to localhost:8000)
npm run build:pages                             # static export for Cloudflare Pages
npx wrangler pages deploy out --project-name polybot --branch main

# Cloud Run (from repo root)
gcloud run deploy polybot-api --source . --region europe-west4 --allow-unauthenticated

# E2E tests (from web/)
npx playwright test                             # run all e2e tests
npx playwright test --ui                        # interactive mode
```

## System Architecture

```
Polymarket APIs (Data API, Leaderboard API, Gamma API, CLOB API)
    │
    ├──> Cloudflare Worker  (polybot-copy-listener.timstew.workers.dev)
    │      ├── CopyListenerDO: polls /activity per target every 5s, creates copy trades
    │      ├── FirehoseDO: polls /trades every 5s, harvests wallets every 30min
    │      ├── D1 "polybot": copy_targets, copy_trades, suspect_bots, firehose_trades, firehose_wallets
    │      └── Cron: auto-restarts DOs every minute + sweeps unredeemed positions via Cloud Run
    │
    ├──> Cloud Run / Python  (polybot-api-182262919086.europe-west4.run.app)
    │      ├── Bot detection engine (CPU-intensive signal analysis)
    │      ├── /api/detect/cloud: called BY the Worker for batch detection
    │      ├── /api/wallet/{address}: detailed wallet view with remote positions
    │      ├── Local SQLite (ephemeral in container)
    │      └── Proxies cloud-* routes to the Worker
    │
    └──> Cloudflare Pages  (polybot-b5l.pages.dev)
           ├── / : bot rankings dashboard (calls Worker /api/unified)
           ├── /copy : copy trading management (calls Worker /api/copy/*)
           └── /wallet/[address] : wallet detail (calls Worker /api/wallet/*)
```

**Key principle**: The dashboard talks to the Worker. The Worker handles all D1 reads/writes and FIFO P&L computation. The Worker calls Cloud Run only for bot detection (`/api/detect/cloud`) and proxies unmatched routes to Cloud Run.

### Strategy Execution

**Local development** uses the **standalone runner** (`worker/src/standalone-runner.ts`) — pure Node.js, no CF Worker limitations:
```
standalone-runner.ts reads configs from D1 SQLite (better-sqlite3)
  → starts real setInterval tick loops per strategy
  → strategy.tick(ctx) every 5s
    → fetchSpotPrice(symbol)         # Binance/Coinbase REST (1s cache)
    → computeSignal(...)             # 5-layer signal from price history
    → checkFills(ctx, window, ...)   # simulate fills against fair value
    → updateQuotes(ctx, window, ...) # place/cancel resting bids
    → resolveWindows(...)            # settle expired windows via Gamma API
  → real WebSocket connections: Oracle (Chainlink), CLOB, Binance order flow
State lives in process memory (no eviction), configs + trades persisted to D1 SQLite.
```

**Cloud deployment** uses the **StrategyDO** alarm system (`worker/src/strategy.ts`):
```
StrategyDO alarm (every 5s) → strategy.tick(ctx)
  → same tick logic as standalone runner
  → WebSocket features fall back to REST polling
State serialized to DO storage (lost on eviction), configs + trades persisted to D1.
```

**Data sources**:
- Binance REST `api/v3/ticker/price` — spot prices per symbol (primary)
- Coinbase REST `v2/prices/{pair}/spot` — fallback if Binance fails
- Gamma API `/markets?slug=` — market resolution verification
- Data API `/trades?limit=200` — market discovery

**WebSocket connections** (standalone runner only — CF Workers cannot maintain persistent outbound WS):
- Chainlink Data Streams — oracle prices for settlement-accurate P_true
- Polymarket CLOB WebSocket — real-time order book and fill notifications
- Binance aggTrade WebSocket — buy/sell volume imbalance (order flow signal)

## Data Flows

### Trade Ingestion (Firehose)
```
Data API /trades (every 5s) → FirehoseDO.pollTrades() → D1 firehose_trades + firehose_wallets
Leaderboard/Gamma APIs (every 30min) → FirehoseDO.harvestWallets() → D1 firehose_wallets
Retention: firehose_trades older than 7 days are auto-deleted each cycle
```

### Bot Detection
```
Dashboard POST /api/detect → Worker → FirehoseDO.processDetectBatch()
  → fetches 100 wallets at a time from firehose_wallets
  → POSTs them to Cloud Run /api/detect/cloud
  → Cloud Run: fetches /activity per wallet, analyzes signals, scores
  → returns bots array → Worker stores in D1 suspect_bots
```

### Copy Trading
```
CopyListenerDO alarm (every 5s) → pollCycle() in listener.ts
  → for each active target: fetch /activity?user=<wallet>
  → TRADE events → calculateCopyTrade() → D1 copy_trades
  → CONVERSION/REDEEM → handlePositionExit() → synthetic SELL in D1 copy_trades
Paper mode: 100% of source notional, no max position cap
Real mode: trade_pct% of source notional, capped at max_position_usd
```

### Dashboard Data
```
/ page → GET /api/unified → Worker reads D1 suspect_bots, computes efficiency
/copy page → GET /api/copy/targets/cloud → Worker reads D1 targets + trades, computes FIFO P&L
/wallet page → GET /api/wallet/{addr} → Worker reads D1 bot + copy trades + Data API positions
```

## D1 Database Tables

### `polybot` database (worker/schema-ops.sql)
| Table | Purpose | Key columns |
|-------|---------|-------------|
| `copy_targets` | Wallets being copy-traded | wallet (PK), mode, trade_pct, max_position_usd, active |
| `copy_trades` | Every copy trade (paper or real) | id (PK), source_wallet, asset_id, side, price, size, exec_price, fee_amount |
| `strategy_configs` | Strategy definitions | id (PK), name, strategy_type, mode, params (JSON), tick_interval_ms, max_capital_usd, balance_usd, lock_increment_usd |
| `strategy_orders` | Open/filled/cancelled orders | id (PK), strategy_id, token_id, side, price, size, status |
| `strategy_trades` | Executed strategy trades | id (PK), strategy_id, token_id, side, price, size, fee_amount, pnl |
| `strategy_logs` | Structured strategy logs | id (auto), strategy_id, tick, level, message, symbol, direction, signal_strength, flip_count |
| `strategy_snapshots` | Per-window tick recordings for offline replay | id (PK), strategy_id, crypto_symbol, window_duration_ms, outcome, ticks (JSON), hour_utc, day_of_week |
| `strategy_regime_log` | Orchestrator regime performance log | id (auto), strategy_id, regime, tactic_id, outcome, pnl |
| `tactic_scores` | Bandit tactic scores (Thompson Sampling) | (strategy_id, regime, tactic_id) PK, n, total_pnl, wins, losses |

### `polybot-firehose` database (worker/schema-firehose.sql)
| Table | Purpose | Key columns |
|-------|---------|-------------|
| `suspect_bots` | Detected bots with scores | wallet (PK), confidence, category, copy_score, pnl_pct, win_rate |
| `firehose_trades` | Raw trades from Data API | id (PK), market, taker, price, size, timestamp (7-day retention) |
| `firehose_wallets` | Discovered wallet addresses | wallet (PK), source, trade_count |

## Key Files

### Python (Cloud Run)
| File | Role |
|------|------|
| `polybot/api.py` | FastAPI app. All HTTP endpoints. Listener threads. Worker proxy routes. |
| `polybot/detector.py` | Bot detection: 14 signals per wallet → 0-1 confidence + category + 0-100 copy_score |
| `polybot/profitability.py` | FIFO P&L, win rate from positions API, leaderboard profit data |
| `polybot/firehose.py` | Polymarket REST/WebSocket clients, wallet harvesting |
| `polybot/listener.py` | Copy-only listener loop (local Python path, not used in cloud mode) |
| `polybot/copier.py` | Copy trade execution (paper=log, real=CLOB FOK order) |
| `polybot/db.py` | Local SQLite layer. 5 tables. Schema + migrations. |
| `polybot/models.py` | Pydantic v2 models: Trade, BotSignals, SuspectBot, CopyTarget, CopyTrade |
| `polybot/config.py` | Env config. API host constants. |
| `polybot/redeem.py` | Position redemption via poly-web3 + Polymarket relayer (gasless) |
| `polybot/categories.py` | Market category inference from titles |

### Worker (Cloudflare)
| File | Role |
|------|------|
| `worker/src/index.ts` | All HTTP routing, CopyListenerDO, StrategyDO routing, FIFO P&L, CORS, cron |
| `worker/src/firehose-do.ts` | FirehoseDO: trade polling, wallet harvesting, detection batch orchestration |
| `worker/src/listener.ts` | pollCycle(), fetchWalletActivity(), calculateCopyTrade(), handlePositionExit() |
| `worker/src/standalone-runner.ts` | Standalone runner: pure Node.js strategy execution, real setInterval/WebSocket, direct D1 SQLite (primary for local dev) |
| `worker/src/strategy.ts` | StrategyDO: CF Durable Object wrapper, alarm-based tick loop (used for cloud deployment) |
| `worker/src/strategies/price-feed.ts` | Price fetching (Binance/Coinbase REST), signal computation, market discovery, order flow (optional WS) |
| `worker/src/strategies/spread-sniper.ts` | Direction-agnostic spread strategy: neutral fair value, adaptive bid sizing, pair cost optimization |
| `worker/src/strategies/directional-maker.ts` | Aggressive signal-biased maker: sells ALL losing-side inventory on flip |
| `worker/src/strategies/safe-maker.ts` | Conservative signal-biased maker: protects paired inventory from being sold |
| `worker/src/strategies/bonestar.ts` | Three-phase accumulation + certainty sweep: reverse-engineered from Bonereaper bot, oracle-driven phases, never sells |
| `worker/src/strategies/conviction-maker.ts` | One-sided conviction bets: only bids when signal > 0.60, no hedging, hold to resolution |
| `worker/src/strategies/directional-taker.ts` | Taker strategy (not viable for wide-spread crypto markets) |
| `worker/src/strategies/unified-adaptive.ts` | Unified strategy: picks sniper/maker per window, adaptive bid sizing, wallet management |
| `worker/src/strategies/split-arb.ts` | Split arbitrage strategy |
| `worker/src/strategies/passive-mm.ts` | Passive market making strategy |
| `worker/src/strategies/orchestrator.ts` | Meta-strategy: regime-based tactic selection with Thompson Sampling bandit |
| `worker/src/strategies/regime.ts` | Regime classification (trending, oscillating, calm, volatile, near-strike, late-window) |
| `worker/src/optimizer/types.ts` | Shared types for snapshot recording and replay (TickSnapshot, WindowSnapshot, TapeBucket) |
| `worker/src/optimizer/replay.ts` | Pure replay engine: replayWindow(snapshot, params) → ReplayResult |
| `worker/src/optimizer/optimize.ts` | TPE optimizer CLI: reads D1 SQLite, runs Bayesian param search, outputs best configs |
| `worker/src/optimizer/migrate-tape.ts` | One-time migration: raw tape entries → volume buckets (ran March 23) |
| `worker/src/categories.ts` | marketHasFees() + DEFAULT_FEE_RATE (0.0625) |
| `worker/src/types.ts` | TypeScript interfaces: CopyTarget, CopyTrade, DataApiTrade, Env |
| `worker/schema-ops.sql` | D1 schema: copy_targets, copy_trades, strategy_configs, strategy_orders, strategy_trades, strategy_logs, strategy_snapshots |
| `worker/wrangler.toml` | D1 bindings (DB, FIREHOSE_DB), DO bindings (4 DOs), PYTHON_API_URL, cron trigger |

### Frontend (Next.js on Cloudflare Pages)
| File | Role |
|------|------|
| `web/lib/api.ts` | API client + all TypeScript types. Base URL: `NEXT_PUBLIC_API_URL` (Worker in prod) |
| `web/app/page.tsx` | Dashboard: bot rankings, sortable table, dismiss, copy-add |
| `web/app/copy/page.tsx` | Copy trading: targets table with expandable FIFO detail, listener controls |
| `web/app/wallet/[address]/client.tsx` | Wallet detail: bot signals, P&L cards, positions, trades |
| `web/components/copy-target-detail.tsx` | Expandable detail panel: P&L chart, open/closed positions |
| `web/public/_redirects` | SPA routing: `/wallet/* → /_spa/wallet 200` (avoids CF Pages 308 near-miss) |
| `web/next.config.ts` | `output: "export"` when NEXT_BUILD_EXPORT=1, dev rewrites /api/* to localhost:8000 |

### Tests
| File | Role |
|------|------|
| `tests/test_detector.py` | Bot detection signal computation + scoring |
| `tests/test_copier.py` | Copy trade sizing, paper/real mode, fee calculation |
| `tests/test_profitability.py` | FIFO P&L, win rate |
| `web/e2e/` | Playwright e2e tests (dashboard, copy page, wallet page) |

### Documentation
| File | Role |
|------|------|
| `ROADMAP.md` | Phased plan: cloud paper trading → GCE microservice → real trading → production |
| `OPTIMIZER.md` | Offline replay and parameter optimization: snapshot recording, replay engine, TPE optimizer |
| `STRATEGY-IMPROVEMENTS.md` | Top-10 improvement hitlist + per-strategy analysis + bid size test results |
| `redemption-code.md` | EOA wallet setup + on-chain position redemption for real trading |

## External APIs

| API | Base URL | Used for | Transport |
|-----|----------|----------|-----------|
| Data API | `https://data-api.polymarket.com` | /trades, /activity, /positions, /v1/leaderboard | REST |
| Leaderboard API | `https://lb-api.polymarket.com` | /profit, /volume (per-window P&L and volume) | REST |
| Gamma API | `https://gamma-api.polymarket.com` | /markets, /events (market metadata + resolution) | REST |
| CLOB API | `https://clob.polymarket.com` | Order placement (real mode), /book (order books) | REST |
| Binance | `https://api.binance.com` | /api/v3/ticker/price (spot prices for signal) | REST |
| Coinbase | `https://api.coinbase.com` | /v2/prices/{pair}/spot (fallback price source) | REST |
| RTDS WebSocket | `wss://ws-live-data.polymarket.com` | Real-time trade stream (copy listener only) | WebSocket |
| Binance WS | `wss://stream.binance.com:9443/ws/` | aggTrade order flow (**local dev only**, optional) | WebSocket |

## Important Patterns

### Copy Trading
- **Username sources**: D1 `copy_targets.username` (from /activity API at add time) is canonical. Leaderboard API may return a different name. Wallet page shows both if they differ.
- **FIFO P&L**: Computed on-the-fly in TypeScript (worker) from D1 copy_trades. Not stored. Includes peak capital tracking.
- **Copy sizing**: Paper=100% of source notional (no cap). Real=trade_pct% of source (capped at max_position_usd). If `full_copy_below_usd` is set and the source trade notional is below that threshold, real trades are copied at 100% instead of trade_pct%.
- **Continuous detection**: FirehoseDO processes 100 wallets per batch, calling Cloud Run `/api/detect/cloud` for analysis.

### Strategy Execution
- **Pair cost**: The dominant profit driver for binary "up or down" markets. When `upAvgCost + dnAvgCost < 1.00`, matched pairs are structurally profitable regardless of outcome. Target: 0.92 (sniper), 0.93 (maker).
- **Inventory balance > directional accuracy**: Balanced UP/DOWN inventory guarantees profit when pair cost < 1.00. One-sided inventory is the #1 loss scenario.
- **Per-tick inventory safety**: Both strategies cancel heavy-side resting bids every tick, not just on requote events. Without this, fills accumulate between requotes without inventory checks.
- **Adaptive bid sizing**: Spread sniper scales bid size with window duration — `bid_size * min(1.0, windowDurationMin / 15)`. 5-min windows use 10 units, 15-min windows use 30.
- **Signal computation (price-feed.ts)**: 5-layer signal from REST data only (magnitude, multi-window momentum, acceleration, volatility regime, dead-zone hysteresis). Optional 6th layer (order flow) requires WebSocket — local dev only.
- **Market discovery**: `discoverCryptoMarkets()` polls Data API `/trades` to find active "Up or Down" crypto markets. Extracts symbol, window timing, token IDs from market titles.
- **Resolution verification**: `checkMarketResolution()` calls Gamma API to confirm Polymarket's outcome. Binance price is used for narrative prediction only (never for actual outcome). 30-min timeout if Gamma never resolves.
- **Balance protection (ratchet lock)**: Per-strategy bankroll protection. Set `balance_usd` on a config to enable. `lock_increment_usd` (defaults to `balance_usd`) controls ratchet step size. The DO tracks `high_water_balance` in state and computes `locked_amount = max(0, floor(hwm / increment) - 1) * increment`. When `working_capital = current_balance - locked_amount <= 0`, the strategy auto-stops. Status endpoint returns `balance_protection` object with `current_balance`, `locked_amount`, `working_capital`, `high_water_balance`.

### Offline Optimization (see [OPTIMIZER.md](./OPTIMIZER.md))
- **Snapshot recording**: Safe-maker captures per-tick market state (signal, regime, fair values, book conviction, volume-bucketed trade tape) when `record_snapshots: true`. Data flushes to D1 `strategy_snapshots` on window resolution. ~14KB/tick, ~40MB/day.
- **Replay engine**: Pure function `replayWindow(snapshot, params)` mirrors safe-maker tick loop. Deterministic, no API calls. Uses `checkBucketFill()` against recorded volume buckets for fill simulation.
- **TPE optimizer**: Standalone CLI (`npx tsx src/optimizer/optimize.ts`) reads local D1 SQLite, runs 2,000-iteration Bayesian search over 13 parameters, maximizes Sharpe ratio with 20% holdout. Buckets by crypto symbol, window duration, time of day, weekday/weekend.
- **DO persistence**: `persistState()` strips `tickSnapshots` before writing (avoids SQLITE_TOOBIG). Status endpoint also strips them (prevents dashboard timeout). Both re-initialize on hydration.
- **Always-on recording**: Mac mini at `clawdia@100.70.186.4` runs the standalone runner (`npx tsx src/standalone-runner.ts`) 24/7. `dev-remote.sh` health-checks every 10s, keep-alive pings active strategies every 60s.

### Infrastructure
- **Fee detection**: `marketHasFees()` checks title for crypto keywords (Bitcoin, Ethereum, up or down, above). Default: assume fees when title is empty. Rate: 6.25%. Formula: `fee = exec_price * (1 - exec_price) * 0.0625 * size`.
- **Market categories**: `classifyTitle()` in worker categorizes by title keywords → crypto/sports/politics/other.
- **SPA routing on CF Pages**: `/wallet/[address]` uses `_redirects` rewrite to `/_spa/wallet` (extensionless). The build script moves the generated HTML out of `/wallet/` to avoid CF Pages near-miss 308 redirects.
- **Cron auto-restart**: Worker cron runs every minute, restarts DOs if not user-stopped. `userStopped` flag persisted in DO storage.
- **Cron redeem sweep**: Same cron calls Cloud Run `/api/redeem/sweep` every minute to redeem resolved positions. Runs independently of strategy lifecycle so positions get redeemed even after all strategies stop.

## Strategy API Endpoints

All served by the Worker. Strategy state lives in StrategyDO (Durable Object).

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/strategy/configs` | List all strategy configs |
| POST | `/api/strategy/configs` | Create a new strategy config |
| PUT | `/api/strategy/configs/:id` | Update a strategy config |
| DELETE | `/api/strategy/configs/:id` | Delete a config (stops DO first) |
| POST | `/api/strategy/start/:id` | Start a strategy (creates/wakes DO) |
| POST | `/api/strategy/stop/:id` | Stop a strategy |
| GET | `/api/strategy/statuses` | Status of all strategies (queries each DO) |
| GET | `/api/strategy/status/:id` | Single strategy status (config, state, windows) |
| GET | `/api/strategy/trades/:id` | Trades for a strategy (from D1) |
| GET | `/api/strategy/trades` | All strategy trades |
| GET | `/api/strategy/logs/:id?limit=N&level=signal` | Structured logs from D1 |

## Deployment Checklist

1. **Cloud Run**: `gcloud run deploy polybot-api --source . --region europe-west4 --allow-unauthenticated --env-vars-file=/tmp/polybot-env.yaml` (see RUNBOOK.md for extracting env vars from previous revision — **never use `--set-env-vars` from .env**, it overwrites the private key)
2. **Worker**: `cd worker && npx wrangler deploy`
3. **Pages**: `cd web && npm run build:pages && npx wrangler pages deploy out --project-name polybot --branch main`
4. **D1 schema changes**: `npx wrangler d1 execute polybot --remote --file=schema-ops.sql` (or ALTER TABLE for migrations)
5. **Strategy schema**: `npx wrangler d1 execute polybot --remote --file=schema-ops.sql` (strategy_configs, strategy_trades, strategy_logs tables)
6. **Balance protection migration** (one-time, if not yet applied):
   ```bash
   npx wrangler d1 execute polybot --remote --command "ALTER TABLE strategy_configs ADD COLUMN balance_usd REAL DEFAULT NULL;"
   npx wrangler d1 execute polybot --remote --command "ALTER TABLE strategy_configs ADD COLUMN lock_increment_usd REAL DEFAULT NULL;"
   ```

## Environment Variables

- **Cloud Run**: `CLOUDFLARE_WORKER_URL`, `POLYBOT_DB_PATH`, `PORT=8080`
- **Worker** (`wrangler.toml`): `PYTHON_API_URL`, D1 binding `DB` → polybot
- **Pages**: `NEXT_PUBLIC_API_URL=https://polybot-copy-listener.timstew.workers.dev`
- **Local dev**: `.env` with `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER_ADDRESS` (for real trading only)
