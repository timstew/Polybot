# Reaper Roadmap

> Goal: Build a superior version of Bonereaper's strategy — matching fill rate,
> beating pair cost, adding capabilities BR doesn't have (mid-window merging,
> multi-strategy, smarter sizing).
>
> Source of truth for BR behavior: [../BONEREAPER-ANALYSIS.md](../BONEREAPER-ANALYSIS.md).
> When we learn new things about BR, update that doc first, then cross-reference
> the relevant roadmap item.
>
> How fills work today: [FILL-SYSTEM.md](./FILL-SYSTEM.md) — queue-sim, tape
> gap-filler, taker fees, reprice logic.

## Current State (April 18, 2026)

**Working:**
- Event-driven engine with boundary timers + market WS + grounded tape fills
- Pluggable bid strategies (mimic, hybrid-maker-taker, taker, ladder, hybrid)
- Multi-crypto (BTC/ETH/SOL, 5m + 15m windows)
- Instant oracle-based resolution with Gamma confirmation
- Mid-window merging (BR doesn't do this — our edge)
- **Queue-position fill simulation** (Phase 1.1): paper fills roll against
  queue priority (price-improved → 0.90 prob; tied → 0.25)
- **WS-primary fill mode** (Phase 1.2): tape poller demoted to gap-filler,
  runs only when market WS is unhealthy
- **Conservative tape gap-fill** (Phase 1.3): fresh fetches + per-(order,trade)
  dedup; single roll per unique pair across calls
- **Taker-fee accounting** (Phase 1.4): `isMaker=false` call sites now pay
  6.25% `p*(1-p)*size` fee; `resolveWindow` subtracts total fees from net P&L
- **Sliding-ratchet inventory guard** (Phase 3.6): tiered suppression
  (balanced → halve-top → deepest-only → full) replaces binary 90% cutoff
- Dashboard with live P&L, sparklines, order book, detail panels
- 31K+ BR shadow trades recorded for analysis
- Git-based deploy to mac mini
- Ledger-first order placement (DB PENDING row before CLOB call)
- **Test coverage** (Phase 2.1–2.4): 163 tests across 14 files covering
  queue-sim, grounded-fills dedup, fee accounting, engine scaling,
  P&L aggregation, fill-processor entry points, all 5 strategies, and
  window lifecycle. Previously 0% on engine/fill-processor/window-manager.
- `bin/fill-compare.ts` analysis helper: us-vs-BR fill rate + token ratios
  for live calibration of queue_fill_mult

**Broken / Missing:**
- No session-level P&L across restarts (DB resets lose history)
- `placeBuyOrder` doesn't use `withRetry()` — single 429 → FAILED
- Startup does cancel-all instead of reconciling with CLOB `getOrders()`
- No monitoring/alerts (silent failures in real mode would bleed capital)
- Sliding-ratchet guard wired into `pricing.ts` + `bonereaper-ladder.ts`;
  mimic/taker/hybrid-maker-taker still use their inline per-strategy guards
  (follow-up: unify through `inventory-guard.ts`)
- Engine `tick()` loop / boundary timer / `onMarketTrade` still untested end-to-end
  (requires feed + CLOB mocking scaffolding)
- No real-money testing yet

---

## Phase 1: Fix Fill Accuracy (HARD BLOCKER for everything downstream)

Paper fills determine whether every other P&L number means anything. Queue
simulation comes first — without it, tuning strategies on paper P&L is noise.

### 1.1 Queue Position Simulation (HIGHEST PRIORITY) — DONE
- [x] `orders/queue-sim.ts`: `queueFillProbability(ourBid, tradePrice)` with
      three tiers (price improvement → 0.90, sub-tick → 0.60, tied → 0.25)
- [x] `rollForFill(prob, mult)` with configurable `queue_fill_mult` for
      live calibration, and `queue_fill_sim=false` kill-switch
- [x] Applied in both paths: `engine.ts` `onMarketTrade` (WS) and
      `grounded-fills.ts` (tape poller). Volume consumed regardless of roll
      outcome — competition wins misses.
- [x] Unit tests: `tests/queue-sim.test.ts` (11 tests covering tiers,
      multiplier clamping, empirical rate convergence)
- [x] Baseline captured: 106.9% fill count, 25.9% token ratio over 48h pre-fix
- [ ] Post-landing: re-run `bun src/analysis/fill-compare.ts --since=24h` after
      24h live paper run; tune `queue_fill_mult` if rate drifts outside 5–20%

### 1.2 WS-Only Fill Mode — DONE
- [x] Tape poller gated on `marketWs.isConnected()` — only runs as gap-filler
- [x] `tape_always=true` override for debugging
- [x] Activity log entry when falling back (`TAPE_GAPFILL`)

### 1.3 Conservative Tape Gap-Fill — DONE
- [x] Removed global `accumulatedTrades` — fresh fetches per call
- [x] Per-(order, trade) dedup via `evaluatedPairs` Map with 10min TTL
- [x] Integration tests: `tests/grounded-fills.test.ts` (7 tests) cover
      dedup across calls, queue-miss stickiness, bypass flag, wrong-side
      filtering, price-below-bid filtering
- [ ] (follow-up 1.5) Volume aggregation at the price-bucket level if
      over-filling still occurs post-queue-sim at larger capital

### 1.4 Taker Execution + Fee Accounting — DONE
- [x] `takerFee(price, size)` = `price * (1-price) * 0.0625 * size`
- [x] `processReconcileFill` accepts `isMaker` param (default `true`);
      `isMaker=false` at `paper_book` + `evaluateTaker` call sites
- [x] `resolveWindow` subtracts `SUM(fee)` from `net_pnl` and logs the breakdown
- [x] Tests: `tests/fill-processor.test.ts` covers formula extremes,
      symmetry, size linearity, integration through all three entry points,
      and net-P&L subtraction
- [ ] (follow-up) Pair-cost merge threshold: currently `merge_threshold_pc=$1.00`.
      With taker fees, a taker-filled pair at pc=$0.98 may still be a merge loss
      after fees. Adjust merge threshold to `$1.00 - expected_fee_per_pair`
      once taker strategies see live use.

---

## Phase 2: Test Foundation (before real money, before heavy tuning)

Currently `core/engine.ts` (46KB, the whole tick loop) has 0% coverage. Every
refactor is risk. This phase is cheap and unblocks confident iteration.

### 2.1 Engine Integration Tests — DONE (partial)
- [x] `tests/engine.test.ts`: 17 tests covering `getScaledConfig` across
      capital tiers ($30 → $5000), `getTotalPnl` aggregation across resolved
      windows, `getEffectiveCapital` with P&L gains/losses and cap ceiling
- [x] Window resolution P&L scenarios (balanced, one-sided, merge + resolve,
      UNKNOWN outcome)
- [ ] (follow-up) Full `tick()` loop with mocked feeds + CLOB — needs a
      feed/CLOB mocking layer. Deferred; captured as a Phase 5 item.

### 2.2 Fill Processor Tests — DONE
- [x] `tests/fill-processor.test.ts`: 19 tests covering taker-fee formula,
      `processReconcileFill` with/without `isMaker`, `processImmediateFill`
      (taker path), `processUserWsFill` (real WS path including unknown-order
      rejection)
- [x] Inventory avg cost recalc across multiple fills (VWAP correctness)
- [x] `fill_count` increments, `peak_up_inventory` HWM, partial→FILLED transition
- [x] Dedup: repeated tradeId inserts once

### 2.3 Strategy Tests — DONE
- [x] All 5 strategies covered: hybrid, bonereaper-ladder, bonereaper-mimic,
      bonereaper-taker, bonereaper-hybrid-maker-taker (34 tests total)
- [x] Sticky state transitions verified
- [x] Tiered inventory-guard behavior verified (50–75% halve-top,
      75–90% deepest-only, 90%+ full)
- [x] Fixed 2 pre-existing mimic sweep-catcher tests (needed seeded inventory
      to trigger the pairing gap that activates sweeps)

### 2.4 Window Manager Tests — DONE
- [x] `tests/window-manager.test.ts`: 12 tests covering lifecycle (active →
      resolving → resolved), `getActiveWindows` filter + ordering,
      `resolveWindow` re-resolution protection, boundary-crossing idempotence
- [x] P&L edge cases: zero inventory, pc=$1.00 neutral, pc<$1.00 positive
      regardless of outcome
- [ ] (follow-up) `discoverWindows`/`enterWindow` need Gamma API + Binance
      mocking — deferred to Phase 5 harness work.

---

## Phase 3: Match BR's Behavior

Based on BONEREAPER-ANALYSIS.md findings. Each item references the section.

### 3.1 Entry Timing (§0.4)
- [x] Boundary-crossing detection for T+0 entry
- [x] Sub-second window entry (currently 0-4s after open)
- [ ] Target: first bid placed within 2s of window open, first fill within 5s

### 3.2 Symmetric Open (§0.9, §2.1)
- [x] Both sides bid ~$0.50 at window open
- [x] Market-anchored pricing (last trade, not P_true derived)
- [ ] Verify: are our open-window fills matching BR's price distribution?

### 3.3 Late-Window Certainty Sweep (§0.3, §10)
- [x] Maker sweeps: resting bids at $0.01-$0.50 on losing side (gap-sized)
- [x] Late-window taker sweep: cross the ask on short side for pair completion
- [x] Certainty loading: cross the ask on winning side
- [ ] Verify sweeps actually execute (check fill logs for L4+ orders in final 30%)
- [ ] Tune: BR's sweep at +254s bought 1,104 tokens at $0.12. Match this aggression.

### 3.4 Deep-Value Ladder Level (§10)
- [x] `bonereaper-ladder` bids $0.15 at deepest level
- [ ] §10 shows **41% of BR's fills are at $0.01–$0.20** — largest fill bucket by count
- [ ] Scale deepest-tier size disproportionately (not linear with capital) —
      this is where BR's highest-edge fills live (deep value + rare panic sellers)
- [ ] Add a $0.05 tier below the $0.15 tier at larger capital

### 3.5 Size Scaling (§0.9)
- [x] 5x size in final 30% on winning side
- [ ] Verify scaling actually happens (check order sizes in late fills)
- [ ] BR's avg size goes from 23 → 124 tokens. Match at unlimited capital.

### 3.6 Sliding Ratchet Inventory Guard — DONE
- [x] New `strategies/inventory-guard.ts` with `computeSkewGuard()` +
      `applyGuardToLadder()` — pure functions with 17 unit tests
- [x] Tiered suppression:
  - 0–50% skew: normal ladder
  - 50–75%: halve top (fair-priced) bid on heavy side
  - 75–90%: heavy side keeps only deepest (cheap) bid for pairing
  - 90%+: suppress heavy entirely
- [x] Wired into `core/pricing.ts` and `strategies/bonereaper-ladder.ts`
- [x] Ladder strategy tests verify tier behavior (60/40, 80/20, 95/5 scenarios)
- [ ] (follow-up) Port into `bonereaper-mimic.ts`, `bonereaper-taker.ts`,
      `bonereaper-hybrid-maker-taker.ts` which still use their bespoke guards

### 3.7 BR's Three Profit Streams (§2.7)
1. **Maker rebates (early)**: We earn these in real mode. Not relevant in paper.
2. **Merge profit (late)**: Mid-window merging is our edge — BR only merges
   post-resolution.
3. **Directional excess (resolution)**: Unpaired winning tokens pay $1. Our guard
   may over-limit this — revisit after 3.6 lands.

---

## Phase 4: Beat BR

Things BR doesn't do that we can exploit.

### 4.1 Mid-Window Capital Recycling
- [x] Auto-merge when pair cost < $1.00
- [ ] Measure: how much capital does merging free? Track
      `total_merged * pairCost` per window as "recycled capital"
- [ ] Use freed capital for late-window certainty sweeps

### 4.2 Merge-Mode Orchestration
- [ ] Config `merge_mode`:
  - `eager` — merge as soon as cost < $1.00 (current)
  - `lazy` — hold to resolution; realize directional excess at $1.00/redeem
  - `smart` — learned per (crypto, duration, time-of-day)
- [ ] **Why it matters**: §12 shows 15m windows have 69% heavy skew and merge
      P&L ≈ $0 — profit is from directional excess. Eager-merging 15m leaves $
      on the table. 5m windows are the opposite (42% pairing, merge-dominant).
- [ ] Default: `eager` for 5m, `lazy` for 15m until data says otherwise.

### 4.3 Multi-Strategy A/B Testing
- [x] Pluggable BidStrategy interface
- [ ] Run two strategies simultaneously on different windows (e.g., hybrid on
      BTC, mimic on ETH) and compare P&L
- [ ] Dashboard: per-strategy P&L breakdown

### 4.4 Regime Classification → Strategy Routing
- [ ] `binance-feed.ts`: compute 2-min autocorrelation of returns
  - High positive → trending → keep winning-side loaded
  - Negative → mean-reverting → increase losing-side sweeps
  - Low → choppy → balanced ladder
- [ ] Record `volatility_regime` in `window_ticks` for post-hoc analysis
- [ ] Per-window strategy selection based on regime (later: Thompson bandit
      like polybot's `orchestrator.ts`)

### 4.5 Smarter Sweep Pricing
- [ ] BR sweeps at $0.01-$0.20 catching panic sellers. We do this too.
- [ ] Dynamic **sweep ceiling** based on current pair cost:
  - heavy avg $0.60 → sweep up to $0.40 (pair cost $1.00)
  - heavy avg $0.45 → sweep up to $0.55
- [ ] **Book-aware sweep sizing**: check CLOB depth at sweep price, don't bid
      for more than what's available.

### 4.6 Snapshot-Based Replay & Tuning (extend `backtest-v2.ts`)
- [x] Tape bucket recording in `window_ticks`
- [x] Backtest engine (backtest-v2.ts)
- [ ] Add to `window_ticks`: `order_flow_imbalance`, `volatility_regime`,
      `certainty_state` (for UI debugging and offline replay)
- [ ] Accumulate 48+ hours of tape data across all 3 cryptos
- [ ] Multi-strategy comparison on the same windows
- [ ] TPE parameter sweep (ladder_levels, deep_value_price, sweep_ceiling,
      size_multiplier) against real tape
- [ ] Rolling 7-day backtest to auto-tune

### 4.7 Continuous BR Divergence Tracking
- [ ] Dashboard panel: per window, BR's fills vs our fills at matching prices
- [ ] Red-flag windows where we systematically miss liquidity BR captures —
      this signals queue-position or sizing bugs early

### 4.8 Goldsky Subgraph Backfill — DONE (scaffold)
- [x] `src/feeds/goldsky-feed.ts` — GraphQL client with sticky-cursor
      pagination (ported from warproxxx/poly_data; TS, zero Python deps)
- [x] `src/analysis/goldsky-backfill.ts` — per-(wallet, role) orchestrator +
      CLI; engine runs it on a 5min cron
- [x] Tables: `goldsky_trades` (raw dump) + `goldsky_cursor` (resume state)
- [x] 16 tests covering cursor state machine + backfill dedup + multi-wallet
- [x] Live smoke test: pulled 4000 BR events in 1.2s across 6 batches
- [ ] Analysis scripts that consume `goldsky_trades`:
  - [ ] Refresh §10-12 stats in BONEREAPER-ANALYSIS.md from larger sample
  - [ ] Fee-rebate estimate from real `fee` field (vs our formula)
  - [ ] BR wallet rotation detector (no events for N windows → warn)
  - [ ] Candidate-replacement finder (top-volume crypto wallets outside
        our tracked list)

---

## Phase 5: Operational Maturity (before real money)

### 5.1 Session Persistence
- [ ] New `sessions` table:
      `(id, start_time, end_time, starting_capital, ending_capital,
      total_pnl, window_count, fill_count, strategy)`
- [ ] Startup creates session; graceful shutdown finalizes it
- [ ] Dashboard: cumulative P&L chart across sessions, not just current run

### 5.2 Order Retry / Backoff
- [ ] `errors.ts` has `withRetry()` but `order-placer.ts` doesn't use it
- [ ] Wrap `placeLimitOrder` + `cancelOrder`:
      exponential backoff 300ms base, 2× per attempt, max 3 retries
- [ ] Retry on 429 (rate limit) + 5xx. Don't retry on 4xx client errors.

### 5.3 Startup CLOB Reconciliation
- [ ] Currently `main.ts:36` does cancel-all on startup (blunt)
- [ ] Better: fetch CLOB `getOrders()`, cross-check against DB, reconcile
- [ ] Handles partial-placement orphans that cancel-all misses
- [ ] Log any orphans found (signals a prior crash path to investigate)

### 5.4 Monitoring & Alerts
- [ ] Emit metrics: `windows_count`, `fills_per_sec`, `avg_pair_cost`,
      `oracle_staleness`, `capital_remaining`
- [ ] Alerts (email or push):
  - Zero fills for 10 consecutive windows
  - WS data age > 60s
  - Pair cost > $1.05 (structural loss)
  - Capital < $10 (running dry)
  - Resolution disagreement (oracle vs Gamma)
- [ ] Daily summary: P&L, fill rate, pair cost distribution

---

## Phase 6: Go Real

### 6.1 Pre-Flight Validation Gate
- [ ] Startup check blocks `mode=real` unless:
  - Last 100 windows paper P&L > 0
  - Median pair cost < $1.02
  - Fill rate > X fills/window (to be calibrated)
  - Phase 1, 2, 5 all green
- [ ] Prints what failed, refuses to start

### 6.2 Real Mode Implementation
- [x] CLOB v1/v2 adapters (order placement, cancellation, balance)
- [x] On-chain merge/redeem via ethers (CTF operations)
- [ ] Wallet funded with test capital ($100-$500)
- [ ] Rate limit handling (CLOB API limits)
- [ ] Order tracking: reconcile placed orders with actual CLOB state
- [ ] Error recovery: handle partial fills, rejected orders, network failures

### 6.3 Capital Scaling
- [ ] Start $100, measure fill rate + P&L per window + pair cost
- [ ] Scale to $500, $1K, $5K
- [ ] At each level, check if fill rate scales linearly or queue position bottlenecks
- [ ] Compare our fill rate vs BR's at each capital level

---

## Phase 7: Production Hardening

### 7.1 Resilience
- [ ] Auto-restart on crash (systemd/launchd service on mac mini)
- [ ] DB backup (periodic SQLite snapshots to cloud storage)
- [ ] Graceful shutdown: cancel all CLOB orders, save state

### 7.2 Multi-Machine
- [ ] Run on multiple machines for redundancy
- [ ] Or: move to cloud (fly.io/railway) with persistent volume for DB

---

## Cross-Cutting: Keep BONEREAPER-ANALYSIS.md Alive

- [ ] Monthly: re-pull 10K BR trades + position snapshot, update §1, §5, §10–12
- [ ] When BR behavior diverges from our model, update the analysis doc first,
      then add/modify the relevant roadmap item
- [ ] Record "debunked" hypotheses in §4 with evidence — prevents rediscovery
