# Polybot Roadmap

## Current State (March 2026)

**Paper trading locally** — all three tiers run on localhost:
- Worker (`wrangler dev`) — strategy execution, copy trading, D1 storage
- Python API (`uvicorn`) — bot detection, CLOB client
- Frontend (`next dev`) — dashboard

Strategies are paper-only: fills simulated via signal-derived fair value model.
Three strategies proven profitable: spread-sniper, directional-maker, unified-adaptive.

See [STRATEGY-IMPROVEMENTS.md](./STRATEGY-IMPROVEMENTS.md) for the top-10 improvement hitlist and per-strategy analysis.

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
  ├── Binance aggTrade WebSocket connections (BTC, ETH, SOL, XRP)
  │     → GET /api/orderflow/{symbol} — returns OrderFlowSignal
  │     → Worker polls this every tick (5s) instead of local WebSocket
  │
  └── Redemption service
        → POST /api/redeem — redeems all winning positions for USDC
        → Worker calls after resolution events
        → Uses py-clob-client + web3 (or polymarket-apis)
```

The microservice is a lightweight FastAPI app (can reuse existing `polybot/api.py` or be a separate service). Runs via systemd or Docker on the VM.

**Remaining work:**
- [ ] Create EOA wallet (signature_type=0) for programmatic trading + redemption
- [ ] Fund EOA with POL (gas) + USDC.e on Polygon
- [ ] Set contract allowances (6 approve txns, one-time)
- [ ] Add `/api/orderflow/{symbol}` endpoint with background WebSocket thread
- [ ] Add `/api/redeem` endpoint using py-clob-client or polymarket-apis
- [ ] Deploy to GCE e2-micro with systemd service
- [ ] Update Worker to call GCE for order flow instead of local WebSocket
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

**Remaining work:**
- [ ] Implement real-mode fill detection in `strategy.ts` (replace `checkFills()` simulation)
- [ ] Wire StrategyDO tick to call CLOB API for order placement/cancellation
- [ ] Add order status polling (fills, partial fills, cancellations)
- [ ] Integrate redemption call into `resolveWindows()` flow
- [ ] Set conservative initial capital ($100-200) for first real trades
- [ ] Add kill switch: manual stop via dashboard + automatic drawdown halt
- [ ] Add real P&L tracking with on-chain balance verification
- [ ] Monitor slippage: compare real fill prices to paper model predictions

### Wallet Setup (one-time)

See [redemption-code.md](./redemption-code.md) for detailed EOA wallet setup:
1. Generate EOA keypair (`eth_account.Account.create()`)
2. Fund on Polygon: POL for gas + USDC.e for trading
3. Approve Polymarket contracts (CTF Exchange, Neg Risk Exchange, Neg Risk Adapter)
4. Set env vars: `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER_ADDRESS`, `POLYMARKET_SIGNATURE_TYPE=0`

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
