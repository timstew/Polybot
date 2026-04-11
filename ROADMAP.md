# Polybot Roadmap

## Current State (April 2026)

**Paper trading on two machines** — laptop (local dev) and always-on Mac mini (24/7 recording):
- Worker (`wrangler dev`) — strategy execution, copy trading, D1 storage
- Standalone runner (`standalone-runner.ts`) — no DO eviction, primary execution on Mac mini
- Python API (`uvicorn`) — bot detection, CLOB order execution
- Frontend (`next dev`) — dashboard with strategy monitoring, orchestrator page

Real trading infrastructure complete (CLOB orders, position redemption, balance protection).
**Chainlink Data Streams integrated** — authenticated access to the same oracle Polymarket uses for settlement. All 13 strategies benefit via oracle-aware `computeSignal()`. Safe-maker uses oracle P_true as primary fair value (zero basis risk).
Safe-maker recording tick-level snapshots 24/7 on the Mac mini for offline optimization (now includes `oracleSpot` per tick).

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

**Limitation:** No Binance WebSocket order flow or Chainlink Data Streams in deployed Workers (CF can't hold outbound WS connections or run Node.js crypto). Signal runs on 5 REST layers only — order flow bonus is 0, oracle falls back to Polymarket RTDS → Binance REST. This is acceptable for cloud; the Mac mini standalone runner has full Chainlink + Binance WS access.

---

## Phase 2: GCE Microservice (persistent services)

Add a GCE e2-micro instance for services that need persistent connections or on-chain access.
CF Workers and Cloud Run (request-based) can't maintain WebSocket clients or long-running processes.

**Note:** The Mac mini standalone runner already provides most Phase 2 capabilities (Chainlink WS, Binance WS, CLOB WS). GCE is for cloud-hosted redundancy and production deployment.

| Component | Host | Cost | Mac Mini Status |
|-----------|------|------|-----------------|
| Chainlink Data Streams | GCE e2-micro | **Free tier** | DONE (standalone runner) |
| Binance WebSocket order flow | GCE e2-micro | (same) | DONE (standalone runner) |
| Polymarket CLOB WebSocket | GCE e2-micro | (same) | DONE (clob-feed.ts) |
| Position redemption service | GCE e2-micro | (same) | DONE (cron sweep) |
| Everything else | Unchanged | $0 | — |

**Total incremental cost: $0** (GCE free tier includes 1 e2-micro instance 24/7)

If free-tier e2-micro is insufficient (CPU/memory), upgrade to e2-small (~$7/month).

### Architecture

```
GCE e2-micro (always-on, us-central1)
  ├── Chainlink Data Streams WebSocket (BTC, ETH, SOL, XRP, DOGE, AVAX, LINK)
  │     → Authenticated V3 reports: price, bid, ask (18 decimal precision)
  │     → Primary settlement reference — zero basis risk
  │     → GET /api/oracle/{symbol} — returns OracleTick with bid/ask
  │
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
- [ ] Add `/api/oracle/{symbol}` endpoint — proxy Chainlink ticks (for cloud Worker fallback)
- [ ] Add `/api/book/{tokenId}` endpoint with background CLOB WS (live book + fill events)
- [ ] Add `/api/tape?since={ms}` endpoint with background RTDS WS (continuous trade tape)
- [ ] Add `/api/fills/{strategyId}` endpoint (buffers fill notifications from CLOB WS)
- [ ] Add `/api/redeem` endpoint using py-clob-client or polymarket-apis
- [ ] Deploy to GCE e2-micro with systemd service
- [ ] Update Worker to poll GCE for order flow, oracle, book, tape, fills instead of REST APIs
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
- [ ] **Oracle spread-gated entry**: skip window entry when oracle bid/ask spread is wide (high uncertainty = adverse selection risk). See Phase 3a Layer 3.
- [ ] **Binance-oracle divergence gate**: reduce bid sizes when Binance and oracle prices diverge (one source leading = directional move incoming). See Phase 3a Layer 4.

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

## Phase 3a: Chainlink Data Streams — Deep Integration

Authenticated Chainlink access is live (April 2026). Layer 1 (oracle-aware signals) and Layer 2 (safe-maker P_true) are complete. This phase extracts maximum value from the V3 report data.

**Completed:**
- [x] Chainlink SDK integration with authenticated WebSocket streaming
- [x] Two-layer fallback: Chainlink → Polymarket RTDS → Binance REST
- [x] `computeSignal()` uses oracle spot for direction/magnitude (all 13 strategies benefit)
- [x] Safe-maker uses oracle P_true as primary fair value (zero basis risk)
- [x] Oracle strike capture via WebSocket (instant) with REST fallback
- [x] `oracleSpot` recorded in tick snapshots for offline replay
- [x] Standalone runner auto-enables oracle feed from active strategy configs
- [x] CF Worker compatibility via dynamic import (graceful fallback)

**Layer 3 — Oracle bid/ask spread exploitation:**
- [ ] **Spread-as-regime signal**: Feed oracle `(ask - bid) / mid` into `regime.ts` as a market quality feature. Narrow spread = confident market, widening spread = incoming volatility. Auto-widen maker bid offsets in degraded conditions.
- [ ] **Spread-width volatility scaling**: Track EMA of oracle spread changes over time. Rapidly widening spread predicts vol spikes 1-5s before they show up in price — pull bids preemptively.
- [ ] **Bid/ask asymmetry signal**: When `(mid - bid) > (ask - mid)`, oracle is skewed bearish. Add as a 7th signal layer in `computeSignal()` — independent from Binance price movement.
- [ ] **P_true confidence bounds**: Compute `P_true_low` (pessimistic price) and `P_true_high` (optimistic price) from bid/ask. Wide range = uncertain → widen spreads. Tight range = confident → bid aggressively.
- [ ] **Oracle-informed inventory urgency**: Late in window with unmatched inventory: if bid/ask tight and close to strike → coin flip, exit faster. If tight and far from strike → outcome certain, hold.

**Layer 4 — Cross-source arbitrage signals:**
- [ ] **Binance-oracle divergence**: Compare Binance spot vs Chainlink spot in real-time. When they diverge, one source is leading. If Binance moves first → oracle (settlement) will follow. If oracle moves first → Binance traders haven't reacted. Latency arbitrage signal. **Note (April 9 analysis):** Oracle lags Binance by ~$7 / ~14s on average. Neither predicts market token prices — tokens are driven by speculative flow, not spot price. The real divergence to exploit is oracle-vs-market-token, not oracle-vs-Binance.
- [ ] **Cross-source confidence weighting**: When Binance and oracle agree on direction, conviction is high. When they diverge, reduce bid sizes and widen offsets.
- [ ] **Oracle-vs-token divergence fading (B1)**: When market token price diverges from oracle P_true by >$0.20 (e.g., Up token=$0.83 but P_true=0.51), the cheap OTHER side is massively underpriced. Buy it. See STRATEGY-IMPROVEMENTS.md Bonereaper Correlation Findings.
- [ ] **Balanced-window-only mode (B2)**: Skip windows where tokens diverge early. Only accumulate in windows where both sides stay near $0.45-$0.55 — these produce pair cost < $1.00 (guaranteed profit). See STRATEGY-IMPROVEMENTS.md "Oracle Correlation Findings & Future Strategy Concepts" for full analysis and B4 (anti-sweep contrarian) concept.

**Layer 5 — Report metadata exploitation:**
- [ ] **Staleness gating**: Capture `expiresAt` and `validFromTimestamp` from V3 reports. Skip P_true calculations when report is stale (>2s old). Prevents quoting on outdated settlement references during Chainlink latency spikes.
- [ ] **Oracle freshness monitoring**: Track `observationsTimestamp - now` latency. Log alerts when oracle stale (>2s delay). Early warning for Chainlink infrastructure issues.
- [ ] **Feed health dashboard**: Show oracle connection status, report frequency, average latency, and spread width per feed on the frontend.

**Impact estimate**: Layers 3-4 target the two biggest P&L drags — adverse selection (wrong-side fills) and timing (entering/exiting at wrong moments). Oracle bid/ask spread is the most direct measure of market uncertainty available. Expected improvement: 5-15% fewer adverse fills, 2-5% better timing on bid placement.

---

## Phase 3b: Autoresearch — Offline Strategy Optimization

Replay recorded market data to iterate on strategy logic without waiting for live windows.
See [OPTIMIZER.md](./OPTIMIZER.md) for full architecture, schema, operations, and future plans.

- [x] Design `strategy_snapshots` schema (one row per resolved window, JSON ticks array)
- [x] Add snapshot recording to safe-maker tick loop (behind `record_snapshots: true` param)
- [x] Build pure-function replay engine (`optimizer/replay.ts`)
- [x] Build TPE optimizer CLI (`optimizer/optimize.ts`) — 13-param search, Sharpe/Sortino objective, chronological holdout
- [x] Compress tape data: raw trades → volume buckets (14KB/tick, ~40MB/day)
- [x] Fix DO persistence crash (strip `tickSnapshots` from DO storage)
- [x] Deploy recorder on always-on Mac mini, accumulating data 24/7
- [x] Overfitting guards: min bucket size (100), scaled iterations, boundary warnings, convergence curve
- [ ] Accumulate 500+ windows (~2 days) then run first optimization
- [ ] Parameter stability analysis: perturb optimal params ±10-20%, check objective sensitivity
- [ ] Fill discount sensitivity: test robustness under reduced fill assumptions
- [ ] Deploy optimized params alongside default, compare live performance
- [ ] Walk-forward validation (needs 2+ weeks of data)
- [ ] Add recording to other strategies (orchestrator, avellaneda-maker)
- [ ] Oracle-enhanced replay: use recorded `oracleSpot` in replay engine for oracle-referenced P_true backtesting
- [ ] Replay with oracle bid/ask spread: test spread-gated strategies against historical oracle data
- [ ] Multi-strategy replay: test same data through different strategy logic
- [ ] Evaluate CMA-ES or Optuna if TPE convergence is poor
- [ ] Multi-objective optimization (Sharpe + fill count Pareto frontier)
- [ ] Automated nightly optimization pipeline

---

## Phase 4: Production Hardening

After real trading is validated, harden for unattended 24/7 operation.

- [ ] Alerting: PagerDuty/Telegram on drawdown, DO stall, or API errors
- [ ] Metrics: Grafana dashboard with PnL, fill rates, latency, wallet balance, oracle health
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
