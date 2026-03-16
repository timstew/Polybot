# Polybot

Detects automated trading bots on [Polymarket](https://polymarket.com) and runs algorithmic strategies on crypto binary options ("Will BTC be above $X?").

## Architecture

```
Cloudflare Worker    — strategy execution, copy trading, D1 storage
Cloud Run (Python)   — bot detection, CLOB order placement
Cloudflare Pages     — Next.js dashboard
```

Three proven strategies for "Up or Down" crypto markets:
- **Spread Sniper** — direction-agnostic market making, 100% paper win rate
- **Directional Maker** — signal-biased maker with conviction sizing
- **Unified Adaptive** — picks sniper/maker per window, adaptive bid sizing, wallet management

## Quick Start

```bash
# Python API (from repo root)
pip install -e ".[dev]"
uvicorn polybot.api:app --port 8000 --reload

# Worker (from worker/)
cd worker && npm exec wrangler dev --persist-to .wrangler/state

# Frontend (from web/)
cd web && npm run dev
```

## Strategy Management

```bash
# Create and start a strategy (local dev)
curl -X POST localhost:8787/api/strategy/configs \
  -d '{"name":"my-sniper","strategy_type":"spread-sniper","params":{"bid_size":60}}'

# With balance protection (ratchet lock): auto-stops when working capital exhausted
curl -X POST localhost:8787/api/strategy/configs \
  -d '{"name":"my-sniper","strategy_type":"spread-sniper","balance_usd":100,"params":{"bid_size":60}}'

curl -X POST localhost:8787/api/strategy/start/strat-<id>

# Monitor
curl localhost:8787/api/strategy/statuses
curl localhost:8787/api/strategy/logs/strat-<id>?limit=50
```

## Documentation

| Doc | Purpose |
|-----|---------|
| [ROADMAP.md](./ROADMAP.md) | Phased plan from local paper trading to cloud-hosted real trading |
| [STRATEGY-IMPROVEMENTS.md](./STRATEGY-IMPROVEMENTS.md) | Top-10 improvement hitlist, per-strategy analysis, paper trading results |
| [CLAUDE.md](./CLAUDE.md) | Developer reference: architecture, data flows, key files, API endpoints |
| [RUNBOOK.md](./RUNBOOK.md) | Deployment procedures and operational notes |
| [redemption-code.md](./redemption-code.md) | EOA wallet setup for on-chain position redemption |

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
