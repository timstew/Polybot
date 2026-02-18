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
npx wrangler d1 execute polybot --file=schema.sql  # apply schema
npx wrangler d1 execute polybot --remote --command "SELECT ..."  # query D1

# Frontend (from web/)
cd web && npm run dev                           # local dev (rewrites /api/* to localhost:8000)
npm run build:pages                             # static export for Cloudflare Pages
npx wrangler pages deploy out --project-name polybot --branch main

# Cloud Run (from repo root)
gcloud run deploy polybot-api --source . --region us-central1 --allow-unauthenticated

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
    │      └── Cron: auto-restarts both DOs every minute if not user-stopped
    │
    ├──> Cloud Run / Python  (polybot-api-182262919086.us-central1.run.app)
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

## D1 Database Tables (worker/schema.sql)

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `copy_targets` | Wallets being copy-traded | wallet (PK), mode, trade_pct, max_position_usd, active, username |
| `copy_trades` | Every copy trade (paper or real) | id (PK), source_wallet, asset_id, side, price, size, exec_price, source_price, fee_amount, title |
| `suspect_bots` | Detected bots with scores | wallet (PK), confidence, category, copy_score, pnl_pct, win_rate, profit_1d/7d/30d/all, username |
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
| `polybot/categories.py` | Market category inference from titles |

### Worker (Cloudflare)
| File | Role |
|------|------|
| `worker/src/index.ts` | All HTTP routing, CopyListenerDO class, FIFO P&L in TypeScript, CORS, cron handler |
| `worker/src/firehose-do.ts` | FirehoseDO: trade polling, wallet harvesting, detection batch orchestration |
| `worker/src/listener.ts` | pollCycle(), fetchWalletActivity(), calculateCopyTrade(), handlePositionExit() |
| `worker/src/categories.ts` | marketHasFees() + DEFAULT_FEE_RATE (0.0625) |
| `worker/src/types.ts` | TypeScript interfaces: CopyTarget, CopyTrade, DataApiTrade, Env |
| `worker/schema.sql` | Full D1 schema (all 5 tables + indexes) |
| `worker/wrangler.toml` | D1 binding (DB → polybot), DO bindings, PYTHON_API_URL var, cron trigger |

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

## External APIs

| API | Base URL | Used for |
|-----|----------|----------|
| Data API | `https://data-api.polymarket.com` | /trades, /activity, /positions, /v1/leaderboard, /v1/market-positions |
| Leaderboard API | `https://lb-api.polymarket.com` | /profit, /volume (per-window P&L and volume) |
| Gamma API | `https://gamma-api.polymarket.com` | /markets (active market metadata) |
| CLOB API | `https://clob.polymarket.com` | Order placement (real mode), price fetching |
| RTDS WebSocket | `wss://ws-live-data.polymarket.com` | Real-time trade stream (used by full listener) |

## Important Patterns

- **Username sources**: D1 `copy_targets.username` (from /activity API at add time) is canonical. Leaderboard API may return a different name. Wallet page shows both if they differ.
- **FIFO P&L**: Computed on-the-fly in TypeScript (worker) from D1 copy_trades. Not stored. Includes peak capital tracking.
- **Fee detection**: `marketHasFees()` checks title for crypto keywords (Bitcoin, Ethereum, up or down, above). Default: assume fees when title is empty. Rate: 6.25%. Formula: `fee = exec_price * (1 - exec_price) * 0.0625 * size`.
- **Market categories**: `classifyTitle()` in worker categorizes by title keywords → crypto/sports/politics/other.
- **SPA routing on CF Pages**: `/wallet/[address]` uses `_redirects` rewrite to `/_spa/wallet` (extensionless). The build script moves the generated HTML out of `/wallet/` to avoid CF Pages near-miss 308 redirects.
- **Cron auto-restart**: Worker cron runs every minute, restarts DOs if not user-stopped. `userStopped` flag persisted in DO storage.
- **Copy sizing**: Paper=100% of source notional (no cap). Real=trade_pct% of source (capped at max_position_usd).
- **Continuous detection**: FirehoseDO processes 100 wallets per batch, calling Cloud Run `/api/detect/cloud` for analysis.

## Deployment Checklist

1. **Cloud Run**: `gcloud run deploy polybot-api --source . --region us-central1 --allow-unauthenticated`
2. **Worker**: `cd worker && npx wrangler deploy`
3. **Pages**: `cd web && npm run build:pages && npx wrangler pages deploy out --project-name polybot --branch main`
4. **D1 schema changes**: `npx wrangler d1 execute polybot --remote --file=schema.sql` (or ALTER TABLE for migrations)

## Environment Variables

- **Cloud Run**: `CLOUDFLARE_WORKER_URL`, `POLYBOT_DB_PATH`, `PORT=8080`
- **Worker** (`wrangler.toml`): `PYTHON_API_URL`, D1 binding `DB` → polybot
- **Pages**: `NEXT_PUBLIC_API_URL=https://polybot-copy-listener.timstew.workers.dev`
- **Local dev**: `.env` with `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER_ADDRESS` (for real trading only)
