# Polybot Roadmap

## Current State (March 2026)

**Paper trading on two machines** — laptop (local dev) and always-on Mac mini (24/7 recording):
- Worker (`wrangler dev`) — strategy execution, copy trading, D1 storage
- Python API (`uvicorn`) — bot detection, CLOB order execution
- Frontend (`next dev`) — dashboard with strategy monitoring

Real trading infrastructure complete (CLOB orders, position redemption, balance protection).
Safe-maker recording tick-level snapshots 24/7 on the Mac mini for offline optimization.

See [STRATEGY-IMPROVEMENTS.md](./STRATEGY-IMPROVEMENTS.md) for the top-10 improvement hitlist and per-strategy analysis.
See [OPTIMIZER.md](./OPTIMIZER.md) for the offline replay and parameter optimization system.

---

## Phase 1: Cloud Paper Trading (current infrastructure)

Deploy existing paper trading to the cloud. No wallet or on-chain interaction needed.

| Component | Host | Cost | Status |
|-----------|------|------|--------|
| Worker + StrategyDO | Cloudflare Workers (free tier) | $0 | Deployed (copy trading works, strategies TODO) |
| D1 databases | Cloudflare D1 (free tier, 500MB each) | $0 | Deployed |
| Python API | Cloud Run (request-based, scales to zero) | ~$0 | Deployed (bot detection only) |
| Frontend | Cloudflare Pages (free tier) | $0 | Deployed |

**Remaining work:**
- [ ] Deploy unified-adaptive strategy config to production Worker
- [ ] Verify StrategyDO alarm persistence across evictions (configs in D1, state rebuilds)
- [ ] Add strategy dashboard page to frontend
- [ ] Monitor paper PnL for 1+ week to validate cloud execution matches local results

**Limitation:** No Binance WebSocket order flow in deployed Workers (CF can't hold outbound WS connections). Signal runs on 5 REST layers only — order flow bonus is 0. This is acceptable; order flow is layer 6 and optional.

---

## Phase 2: GCE Microservice (persistent services)

Add a GCE e2-micro instance for services that need persistent connections or on-chain access.
CF Workers and Cloud Run (request-based) can't maintain WebSocket clients or long-running processes.

| Component | Host | Cost |
|-----------|------|------|
| Binance WebSocket order flow | GCE e2-micro | **Free tier** (1 e2-micro in us-central1/us-east1/us-west1) |
| Position redemption service | GCE e2-micro | (same instance) |
| Everything else | Unchanged | $0 |

**Total incremental cost: $0** (GCE free tier includes 1 e2-micro instance 24/7)

If free-tier e2-micro is insufficient (CPU/memory), upgrade to e2-small (~$7/month).

### Architecture

```
GCE e2-micro (always-on, us-central1)
  ├── Binance aggTrade WebSocket (BTC, ETH, SOL, XRP)
  │     → GET /api/orderflow/{symbol} — returns OrderFlowSignal
  │
  ├── Polymarket CLOB WebSocket (per active token)
  │     → GET /api/book/{tokenId} — live order book snapshot
  │     → GET /api/fills/{strategyId} — fill notifications for our orders
  │     → Replaces polling CLOB REST /book every tick
  │
  ├── Polymarket RTDS WebSocket (real-time trade stream)
  │     → GET /api/tape?since={ms} — trade tape since timestamp
  │     → Continuous tape for grounded fill model (no 200-trade limit)
  │     → Also feeds copy trading listener (replaces /activity polling)
  │
  └── Redemption service
        → POST /api/redeem — redeems all winning positions for USDC
        → Uses py-clob-client + web3 (or polymarket-apis)

Worker polls GCE each tick for buffered state (order flow, book, tape, fills)
rather than maintaining its own connections or hitting external REST APIs.
```

The microservice is a lightweight FastAPI app (can reuse existing `polybot/api.py` or be a separate service). Runs via systemd or Docker on the VM.

**Remaining work:**
- [ ] Create EOA wallet (signature_type=0) for programmatic trading + redemption
- [ ] Fund EOA with POL (gas) + USDC.e on Polygon
- [ ] Set contract allowances (6 approve txns, one-time)
- [ ] Add `/api/orderflow/{symbol}` endpoint with background Binance WS thread
- [ ] Add `/api/book/{tokenId}` endpoint with background CLOB WS (live book + fill events)
- [ ] Add `/api/tape?since={ms}` endpoint with background RTDS WS (continuous trade tape)
- [ ] Add `/api/fills/{strategyId}` endpoint (buffers fill notifications from CLOB WS)
- [ ] Add `/api/redeem` endpoint using py-clob-client or polymarket-apis
- [ ] Deploy to GCE e2-micro with systemd service
- [ ] Update Worker to poll GCE for order flow, book, tape, fills instead of REST APIs
- [ ] Update Worker to call GCE for redemption after `resolveWindows()`

### Alternative: Cloud Run always-on

If we later need more than e2-micro can handle, Cloud Run with `--min-instances=1` and CPU-always-allocated costs ~$65/month for 1 vCPU + 512MB. Only worth it if the bot's monthly PnL justifies it.

---

## Phase 3: Real Trading

Switch from paper to real order execution. Requires EOA wallet from Phase 2.

| Component | Change |
|-----------|--------|
| Strategy mode | `paper` → `real` in strategy_configs |
| Order placement | Worker calls Cloud Run/GCE `/api/strategy/order` (already exists) |
| Order cancellation | Worker calls `/api/strategy/cancel` (already exists) |
| Fill detection | Poll CLOB API for order status instead of simulated fills |
| Position redemption | GCE `/api/redeem` after each resolved window |
| Risk management | Unified-adaptive wallet management enforces capital limits |

**Completed:**
- [x] Real-mode order placement and cancellation via CLOB API
- [x] Fill detection via CLOB order status polling
- [x] Redemption via Cloud Run `/api/redeem/sweep` (cron-driven)
- [x] Balance protection with HWM profit locking
- [x] Kill switch: manual stop via dashboard + auto-stop on low capital
- [x] Real P&L tracking in D1 strategy_trades
- [x] DO config reload on update (no restart needed)

**Remaining work — adverse selection fixes (critical for profitability):**
- [ ] Graduated pair-first scaling: start 5 tokens, scale to 15→30 only after pairing confirmed
- [ ] Ask-aware bid pricing: never bid above best ask minus buffer
- [ ] Fill-velocity feedback: cancel wrong-side bids after 3 same-side fills in 60s
- [ ] Regime-conditional tactic behavior: conviction-only in trending, paired in oscillating
- [ ] Per-tactic real-mode defaults: smaller bid sizes, faster fill-side cancellation
- [ ] Paper vs real fill model comparison: log paper-predicted fills alongside real fills to calibrate

**Remaining work — infrastructure:**
- [ ] On-chain balance verification (compare wallet USDC to tracked balance)
- [ ] Order reconciliation: compare tracked orderIds against CLOB open orders
- [ ] Monitor slippage: compare real fill prices to paper model predictions

See [STRATEGY-IMPROVEMENTS.md — Real-Mode Adverse Selection](./STRATEGY-IMPROVEMENTS.md#real-mode-adverse-selection-march-22-2026) for full analysis.

### Wallet Setup (one-time)

See [redemption-code.md](./redemption-code.md) for detailed EOA wallet setup:
1. Generate EOA keypair (`eth_account.Account.create()`)
2. Fund on Polygon: POL for gas + USDC.e for trading
3. Approve Polymarket contracts (CTF Exchange, Neg Risk Exchange, Neg Risk Adapter)
4. Set env vars: `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER_ADDRESS`, `POLYMARKET_SIGNATURE_TYPE=0`

---

## Phase 3b: Autoresearch — Offline Strategy Optimization

Replay recorded market data to iterate on strategy logic without waiting for live windows.
See [OPTIMIZER.md](./OPTIMIZER.md) for full architecture, schema, operations, and future plans.

- [x] Design `strategy_snapshots` schema (one row per resolved window, JSON ticks array)
- [x] Add snapshot recording to safe-maker tick loop (behind `record_snapshots: true` param)
- [x] Build pure-function replay engine (`optimizer/replay.ts`)
- [x] Build TPE optimizer CLI (`optimizer/optimize.ts`) — 13-param search, Sharpe objective, 20% holdout
- [x] Compress tape data: raw trades → volume buckets (14KB/tick, ~40MB/day)
- [x] Fix DO persistence crash (strip `tickSnapshots` from DO storage)
- [x] Deploy recorder on always-on Mac mini, accumulating data 24/7
- [ ] Accumulate 500+ windows (~2 days) then run first optimization
- [ ] Deploy optimized params alongside default, compare live performance
- [ ] Add recording to other strategies (orchestrator, avellaneda-maker)
- [ ] Multi-strategy replay: test same data through different strategy logic
- [ ] Automated nightly optimization pipeline

---

## Phase 4: Production Hardening

After real trading is validated, harden for unattended 24/7 operation.

- [ ] Alerting: PagerDuty/Telegram on drawdown, DO stall, or API errors
- [ ] Metrics: Grafana dashboard with PnL, fill rates, latency, wallet balance
- [ ] Auto-recovery: Worker cron already restarts DOs; add GCE systemd watchdog
- [ ] Backup: Export D1 strategy_trades daily for audit trail
- [ ] Rate limiting: Respect Polymarket CLOB API limits, back off on 429s
- [ ] Multi-region: Consider EU GCE instance to reduce latency to Polygon RPC
- [ ] Capital scaling: Increase bid sizes and max_capital as track record grows
- [ ] Order reconciliation: periodically compare tracked orderIds against CLOB open orders, flag/cancel orphans
- [ ] Activity-based fill audit: cross-reference strategy_trades against Data API /activity to detect missed fills

---

## Cost Summary

| Phase | Monthly Cost |
|-------|-------------|
| Phase 1: Cloud Paper Trading | $0 (all free tiers) |
| Phase 2: GCE Microservice | $0 (e2-micro free tier) |
| Phase 3: Real Trading | $0 infra + trading capital |
| Phase 4: Production | $0-7/month (e2-small if needed) |

The entire infrastructure runs on free tiers until trading volume or reliability requirements demand upgrades.
