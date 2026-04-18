# Reaper Roadmap

> Goal: Build a superior version of Bonereaper's strategy — matching fill rate,
> beating pair cost, adding capabilities BR doesn't have (mid-window merging,
> multi-strategy, smarter sizing).

## Current State (April 17, 2026)

**Working:**
- Event-driven engine with boundary timers + market WS + grounded tape fills
- Pluggable bid strategies (mimic, hybrid-maker-taker, taker, ladder)
- Multi-crypto (BTC/ETH/SOL, 5m + 15m windows)
- Instant oracle-based resolution with Gamma confirmation
- Mid-window merging (BR doesn't do this — our edge)
- Inventory guard with ratio-based suppression
- Dashboard with live P&L, sparklines, order book, detail panels
- 31K+ BR shadow trades recorded for analysis
- Git-based deploy to mac mini

**Broken / Missing:**
- Grounded fills are too generous (tape accumulator grants unrealistic volume)
- No taker execution (bids AT the ask for crossing fills)
- No queue priority simulation (paper fills ignore CLOB queue position)
- No real-money testing yet
- No P&L tracking across sessions (DB resets lost history)
- Dashboard doesn't show session-level cumulative stats

---

## Phase 1: Fix Fill Accuracy (Current Priority)

The paper fill system determines whether our P&L numbers mean anything.
Without accurate fills, strategy tuning is meaningless.

### 1.1 WS-Only Fill Mode
- [ ] Make the Market WS the **primary** fill source (it gives per-trade events
      with real prices and sizes)
- [ ] Demote the tape poller to a **gap-filler** that only runs when WS has been
      down for >30s, with conservative matching (exact price match, no volume
      aggregation)
- [ ] Each WS trade event: check all resting orders for that token/side, fill
      at OUR bid price if `tradePrice <= ourBid`, size = `min(tradeSize, orderRemaining)`

### 1.2 Queue Position Simulation
- [ ] Paper bids don't have real queue priority — we assume we'd be filled on
      every matching trade, but in reality we'd be behind existing orders
- [ ] Add a **fill probability** based on our bid price vs best bid:
      `fillProb = 1.0` if `ourBid >= bestAsk` (taker cross),
      `fillProb = 0.3-0.5` if `ourBid == bestBid` (back of queue),
      `fillProb = 0.8` if `ourBid > bestBid` (price improvement)
- [ ] This will reduce fill counts to realistic levels and make P&L trustworthy

### 1.3 Taker Execution
- [ ] When placing a bid AT or ABOVE the ask price, mark it as a taker order
- [ ] Taker fills: immediate (no queue), but charge 6.25% fee
- [ ] Strategy should account for fee in pair cost calculations

---

## Phase 2: Match BR's Behavior

Based on BONEREAPER-ANALYSIS.md findings. Each item references the section.

### 2.1 Entry Timing (Section 0.4)
- [x] Boundary-crossing detection for T+0 entry
- [x] Sub-second window entry (currently 0-4s after open)
- [ ] Target: first bid placed within 2s of window open, first fill within 5s

### 2.2 Symmetric Open (Sections 0.9, 2.1)
- [x] Both sides bid ~$0.50 at window open
- [x] Market-anchored pricing (last trade, not P_true derived)
- [ ] Verify: are our open-window fills matching BR's price distribution?

### 2.3 Late-Window Certainty Sweep (Section 0.3)
- [x] Maker sweeps: resting bids at $0.01-$0.50 on losing side (gap-sized)
- [x] Late-window taker sweep: cross the ask on short side for pair completion
- [x] Certainty loading: cross the ask on winning side
- [ ] **Verify**: are sweeps actually executing? Check fill logs for L4+ orders
      in the final 30% of windows
- [ ] **Tune**: BR's sweep at +254s bought 1,104 tokens at $0.12. Our sweeps
      need to match this aggression level

### 2.4 Size Scaling (Section 0.9)
- [x] 5x size in final 30% on winning side
- [ ] Verify size scaling is actually happening (check order sizes in late fills)
- [ ] BR's avg size goes from 23 → 124 tokens. Ours should match at unlimited capital.

### 2.5 Inventory Management (Sections 0.5, 1)
- [x] Never sell — exits only via merge + redeem
- [x] Inventory guard suppresses heavy-side ladder bids
- [x] Sweeps exempt from inventory guard
- [ ] Ratio-based guard (2:1 trigger) may still be too loose — monitor

### 2.6 BR's Three Profit Streams (Section 2.7)
1. **Maker rebates (early)**: We get these too if we go real. Not relevant in paper.
2. **Merge profit (late)**: Mid-window merging is our edge — BR only merges post-resolution.
3. **Directional excess (resolution)**: Unpaired winning tokens pay $1. Our guard limits
   this — may need to allow more winning-side excess.

---

## Phase 3: Beat BR

Things BR doesn't do that we can exploit.

### 3.1 Mid-Window Capital Recycling
- [x] Auto-merge when pair cost < $1.00
- [ ] Measure: how much capital does merging free? Track `total_merged * pairCost`
      per window as "recycled capital"
- [ ] Use freed capital for late-window certainty sweeps (BR can't do this
      because they don't merge until post-resolution)

### 3.2 Multi-Strategy A/B Testing
- [x] Pluggable BidStrategy interface
- [ ] Run two strategies simultaneously on different windows (e.g., hybrid on
      BTC, mimic on ETH) and compare P&L
- [ ] Dashboard: per-strategy P&L breakdown

### 3.3 Smarter Sweep Pricing
- [ ] BR sweeps at $0.01-$0.20 catching panic sellers. We do this too.
- [ ] Add: **calculated sweep ceiling** based on current pair cost. If heavy avg
      is $0.60, sweep up to $0.40 (pair cost = $1.00). If heavy avg is $0.45,
      sweep up to $0.55. Dynamic, not fixed.
- [ ] Add: **book-aware sweep sizing**. Check CLOB depth at sweep price — don't
      bid for more than what's available.

### 3.4 Replay + Backtest
- [x] Tape bucket recording in window_ticks
- [x] Backtest engine (backtest-v2.ts)
- [ ] Accumulate 48+ hours of tape data across all 3 cryptos
- [ ] Run backtests comparing strategies on the same windows
- [ ] Use backtest results to tune parameters (offsets, thresholds, size multipliers)

---

## Phase 4: Go Real

### 4.1 Pre-Flight Checks
- [ ] Paper P&L is consistently positive across 100+ windows
- [ ] Fill accuracy validated (paper fills match what real CLOB would give)
- [ ] Pair cost distribution matches or beats BR (median < $1.00)
- [ ] Inventory balance stays within 3:1 ratio
- [ ] All three cryptos profitable independently

### 4.2 Real Mode Implementation
- [x] CLOB v1/v2 adapters (order placement, cancellation, balance)
- [x] On-chain merge/redeem via ethers (CTF operations)
- [ ] Wallet funded with test capital ($100-$500)
- [ ] Rate limit handling (CLOB API limits)
- [ ] Order tracking: reconcile placed orders with actual CLOB state
- [ ] Error recovery: handle partial fills, rejected orders, network failures

### 4.3 Capital Scaling
- [ ] Start at $100, measure actual fill rate and P&L
- [ ] If profitable, scale to $500, then $1K, then $5K
- [ ] At each level, measure if fill rate scales linearly or if queue position
      becomes the bottleneck
- [ ] Compare our fill rate vs BR's at each capital level

---

## Phase 5: Production Hardening

### 5.1 Monitoring
- [ ] Alerts for: zero fills in a window, WS disconnected >60s, resolution
      disagreement (oracle vs Gamma), P&L below threshold
- [ ] Daily summary email/notification with P&L, fill rate, pair cost stats
- [ ] Dashboard: session-level cumulative P&L chart

### 5.2 Resilience
- [ ] Auto-restart on crash (systemd/launchd service on mac mini)
- [ ] DB backup (periodic SQLite snapshots to cloud storage)
- [ ] Graceful shutdown: cancel all CLOB orders, save state

### 5.3 Multi-Machine
- [ ] Run on multiple machines for redundancy
- [ ] Or: move to cloud (fly.io/railway) with persistent volume for DB
