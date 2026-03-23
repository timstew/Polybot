# Strategy Parameter Optimizer

Offline replay and parameter optimization system for Polybot strategies. Records live market data per-tick, replays it with different parameters, and uses Bayesian optimization (TPE) to find optimal configurations — bucketed by crypto symbol, window duration, time of day, and day of week.

## Architecture

```
Live Strategy (safe-maker w/ record_snapshots: true)
    │
    │  Per tick: signal, regime, fair values, book conviction,
    │            trade tape (volume-bucketed), book bids, market context
    │
    ▼
D1 strategy_snapshots (one row per resolved window)
    │
    │  npx tsx src/optimizer/optimize.ts
    │
    ▼
Replay Engine (pure function, no API calls)
    │  replayWindow(snapshot, params) → ReplayResult
    │
    ▼
TPE Optimizer (2,000 iterations)
    │  Objective: maximize Sharpe ratio
    │  20% holdout for overfitting detection
    │
    ▼
Optimal params (global + per-symbol + per-duration + per-time-of-day)
```

## Components

### 1. Snapshot Recorder (`safe-maker.ts`)

Enabled by setting `record_snapshots: true` in strategy params. Captures per-tick market state during live trading:

**Per-tick data captured:**
| Field | Size | Purpose |
|-------|------|---------|
| `tapeBuckets` | ~8KB | Volume bucketed by token×price ($0.01 increments) — supports fill simulation at any bid price |
| `tapeMeta` | ~100B | Aggregate: totalTrades, totalVolume, uniqueWallets |
| `signal` | ~500B | Full 16-field signal (direction, strength, momentum, acceleration, vol regime, dead zone) |
| `regime` + `regimeFeatures` + `regimeScores` | ~400B | Classification + all 6 features + all 6 EMA scores |
| `fairUp` / `fairDown` | ~50B | Pre-discount fair values |
| `bookConviction` | ~200B | 7-field book analysis (direction, strength, depth ratio, agreement) |
| `bookBids` | ~200B | Top 5 CLOB bid levels (price + size) for queue depth |
| `price` | ~20B | Spot price (Binance) |
| Window state | ~300B | Current inventory, avg costs, bid prices/sizes |

**Total: ~14KB per tick, ~40MB per day** (was 317MB before tape compression).

**Per-window metadata (stored in snapshot row):**
- `crypto_symbol` — BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT
- `window_duration_ms` — 300000 (5min), 900000 (15min), 14400000 (4hr), etc.
- `hour_utc` — 0-23, for time-of-day bucketing
- `day_of_week` — 0=Sun, 6=Sat
- `outcome` — UP or DOWN (filled after Gamma API resolution)
- `up_token_id` / `down_token_id` — for fill simulation per token

**Snapshots flush to D1 on window resolution.** If the DO evicts before resolution, in-progress snapshots are lost (they're memory-only to avoid SQLITE_TOOBIG on DO storage). The `persistState()` fix strips `tickSnapshots` before writing to DO storage and re-initializes them on hydration.

### 2. Replay Engine (`optimizer/replay.ts`)

Pure function — deterministic, no API calls, no randomness:

```typescript
replayWindow(snap: WindowSnapshot, params: DirectionalMakerParams): ReplayResult
```

Mirrors the safe-maker tick loop:
- Direction tracking with hysteresis (dead zone, confirmed flips)
- Regime-based fair value discounts
- Conviction-biased bid sizing
- Inventory ratio checks and one-sided caps
- Cross-fill guards (cap bid so `existing_avg_cost + new_bid <= max_pair_cost`)
- Time decay on bid prices
- Per-tick safety cancels on heavy side
- Fill simulation via `checkBucketFill()` using recorded volume buckets + queue depth

**Not replayed (uses recorded values):** signal computation, regime classification, fair values, trade tape fetching. These are expensive to recompute and don't depend on strategy parameters.

**Output:**
```typescript
interface ReplayResult {
  upInventory: number; downInventory: number;
  upAvgCost: number; downAvgCost: number;
  totalBuyCost: number; realizedSellPnl: number;
  fillCount: number; sellCount: number; flipCount: number;
  netPnl: number;  // from final inventory + recorded outcome
}
```

### 3. TPE Optimizer (`optimizer/optimize.ts`)

Standalone Node.js script that reads local D1 SQLite directly (no worker needed):

```bash
cd worker && npx tsx src/optimizer/optimize.ts [--iterations 2000] [--holdout 0.20] [--db path] [--objective sharpe|sortino]
```

**Algorithm:** Tree of Parzen Estimators (TPE). Maintains two distributions — `l(x)` from top 20% (good params) and `g(x)` from bottom 80% (bad). Samples candidates from `l(x)`, evaluates, updates. Converges in ~2,000 iterations without exhaustive grid search.

**13-parameter search space:**
| Param | Range | Type |
|-------|-------|------|
| `bid_offset` | 0.01–0.06 | continuous |
| `max_pair_cost` | 0.88–0.96 | continuous |
| `conviction_bias` | 1.0–3.0 | continuous |
| `min_signal_strength` | 0.30–0.70 | continuous |
| `base_bid_size` | 5–60 | integer |
| `max_flips_per_window` | 1–5 | integer |
| `max_inventory_ratio` | 1.5–4.0 | continuous |
| `max_bid_per_side` | 0.35–0.55 | continuous |
| `vol_offset_scale_high` | 1.0–2.5 | continuous |
| `vol_offset_scale_low` | 0.3–1.0 | continuous |
| `tighten_start_pct` | 0.50–0.90 | continuous |
| `dead_zone_pct` | 0–0.05 | continuous |
| `sell_excess` | true/false | boolean |

**Objective functions** (`--objective` flag):
- **Sharpe ratio** (default) — `mean(pnls) / std(pnls)`. Classic risk-adjusted return. Penalizes all volatility equally.
- **Sortino ratio** — `mean(pnls) / downside_std(pnls)`. Only penalizes downside deviation — doesn't punish outsized wins. Better for strategies where upside variance is desirable.

Both objectives also report: profit factor (gross wins / gross losses), fill rate, and total P&L for additional context.

**Overfitting guards:**
- **Chronological holdout** (last 20% of windows by time). No temporal leakage — training data is always earlier than test data. Previous versions used random holdout which could interleave train/test windows in time.
- **Minimum bucket size** (100 windows). Bucketed optimization skips any bucket with fewer windows to prevent overfitting on thin samples.
- **Scaled bucket iterations** — `min(500, bucket_size × 3)`. Thin buckets get proportionally fewer search iterations, reducing the risk of finding spurious optima.
- **Boundary warnings** — after optimization, flags any optimal params within 10% of their search bounds (suggests widening the range and re-running).
- **Convergence curve** — logs best objective vs iteration count. Detects whether TPE has converged or needs more iterations.

**Time-bucketed analysis** (runs after global optimization):
- 4 time-of-day buckets (0-5, 6-11, 12-17, 18-23 UTC)
- Weekday vs weekend
- Per crypto symbol (BTC, ETH, SOL, XRP)
- Per window duration (5min, 15min, 4hr)
- Iterations scaled to bucket size, reports whether bucket-specific params outperform global

**Output:** Top 10 parameter sets with Sharpe, Sortino, profit factor, mean P&L. Convergence curve with recommendation on whether more iterations would help. Best params as JSON for direct use in strategy config.

## Schema

Table: `strategy_snapshots` in D1 `polybot` database (defined in `schema-ops.sql`):

```sql
CREATE TABLE IF NOT EXISTS strategy_snapshots (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    window_title TEXT NOT NULL,
    crypto_symbol TEXT NOT NULL,
    window_open_time INTEGER NOT NULL,
    window_end_time INTEGER NOT NULL,
    window_duration_ms INTEGER NOT NULL,
    oracle_strike REAL,
    price_at_open REAL NOT NULL,
    hour_utc INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL,
    up_token_id TEXT NOT NULL DEFAULT '',
    down_token_id TEXT NOT NULL DEFAULT '',
    outcome TEXT,              -- UP/DOWN/UNKNOWN
    ticks TEXT NOT NULL,       -- JSON array of TickSnapshot[]
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Indexes: `strategy_id`, `(hour_utc, day_of_week)`.

## Key Files

| File | Purpose |
|------|---------|
| `worker/src/optimizer/types.ts` | Shared types: `TickSnapshot`, `WindowSnapshot`, `ReplayResult`, `TapeBucket`, `TapeMeta` |
| `worker/src/optimizer/replay.ts` | Pure replay engine: `replayWindow()` + `checkBucketFill()` |
| `worker/src/optimizer/optimize.ts` | TPE optimizer CLI (reads local D1 SQLite via better-sqlite3) |
| `worker/src/optimizer/migrate-tape.ts` | One-time migration: raw tape → volume buckets (ran March 23, 120MB → 35MB) |
| `worker/src/strategies/safe-maker.ts` | Snapshot recording (behind `record_snapshots: true`) |
| `worker/src/strategy.ts` | `persistState()` strips `tickSnapshots`; status endpoint strips them from response |
| `worker/schema-ops.sql` | `strategy_snapshots` table definition |

## Operations

### Enable recording
```bash
# Create a safe-maker with recording enabled
curl -X POST localhost:8787/api/strategy/configs -d '{
  "name": "safe-maker-recorder",
  "strategy_type": "safe-maker",
  "params": { "record_snapshots": true }
}'
curl -X POST localhost:8787/api/strategy/start/strat-<id>
```

### Check recording status
```bash
# Count snapshots and total size
npx wrangler d1 execute polybot --command \
  "SELECT count(*) as rows, round(sum(length(ticks))/1024.0/1024.0,1) as mb FROM strategy_snapshots"

# Breakdown by symbol and duration
npx wrangler d1 execute polybot --command \
  "SELECT crypto_symbol, window_duration_ms/60000 as min, count(*) as n FROM strategy_snapshots GROUP BY 1,2"

# Latest snapshots
npx wrangler d1 execute polybot --command \
  "SELECT created_at, window_title, outcome, length(ticks) as bytes FROM strategy_snapshots ORDER BY created_at DESC LIMIT 5"
```

### Run optimizer
```bash
cd worker && npx tsx src/optimizer/optimize.ts                    # default: 2000 iterations, sharpe, 20% holdout
cd worker && npx tsx src/optimizer/optimize.ts --objective sortino # optimize sortino ratio (ignore upside variance)
cd worker && npx tsx src/optimizer/optimize.ts --iterations 500   # quick test
cd worker && npx tsx src/optimizer/optimize.ts --holdout 0.30     # larger holdout
```

### Migrate old tape data (already done March 23)
```bash
cd worker && npx tsx src/optimizer/migrate-tape.ts
```

## Data Growth

| Duration | Rate | Notes |
|----------|------|-------|
| Per tick | ~14 KB | After tape bucketing (was 43KB with raw tape) |
| Per 5-min window | ~200 KB | ~60 ticks |
| Per 15-min window | ~450 KB | ~180 ticks |
| Per 4-hr window | ~40 MB | ~2,880 ticks — consider reducing tick frequency |
| Per day | ~40 MB | ~264 windows across 4 symbols |
| Per week | ~280 MB | Sustainable for local D1 |
| Per month | ~1.2 GB | May want retention policy after 2-3 months |

## Known Issues & Fixes

**SQLITE_TOOBIG crash (fixed March 23):** `tickSnapshots` in active windows caused DO state to exceed SQLite's 1MB blob limit. Fix: `persistState()` strips snapshots before writing, restores after. Snapshots re-initialized on hydration.

**DO eviction loses in-progress snapshots:** Snapshots are memory-only until window resolves. If the DO evicts mid-window, those snapshots are lost. Mitigated by keep-alive pinging in `dev-remote.sh` (checks strategy status every 60s, restarts if stopped). Long windows (4hr) are most vulnerable.

**Status endpoint was slow:** Serializing `tickSnapshots` in the `/status` response made dashboard polling timeout. Fix: status endpoint strips `tickSnapshots` from response, replaces with `snapshotCount` integer.

## Future Plans

### Near-term
- **Run first optimization** once 500+ windows accumulated (~2 days of recording). Compare optimized vs default params on holdout set.
- **Deploy optimized params** to a second safe-maker instance running alongside the recorder, compare live performance.
- **Reduce tick frequency for long windows** — record every 3rd tick for windows > 60min to keep snapshot size manageable.
- **Parameter stability analysis** — after finding optimal params, perturb each ±10-20% and check how the objective changes. Sharp peaks (small perturbation → big drop) indicate fragile params unlikely to hold up live. Prefer broad, flat optima.
- **Fill discount sensitivity** — add a `--fill-discount 0.7` flag that assumes only X% of simulated fills would occur live (accounts for our orders consuming liquidity that others would have taken). If Sharpe collapses with mild discounts, the params are overfitting to favorable fill assumptions.

### Medium-term
- **Walk-forward validation** — replace or supplement chronological holdout with rolling walk-forward: train on weeks 1-3, test on week 4, then roll forward. More realistic for non-stationary markets. Requires 2+ weeks of data.
- **CMA-ES or Optuna** — if TPE convergence is poor or misses parameter correlations (check convergence curve), switch to CMA-ES (handles correlated continuous params via covariance matrix) or Optuna (battle-tested TPE with pruning and multi-objective). TPE treats params somewhat independently.
- **Multi-objective optimization** — Sharpe/Sortino alone can hide problems. A strategy with Sharpe 2.0 but 15 trades is different from Sharpe 1.5 with 200 trades. Optimize Sharpe + fill count jointly (Pareto frontier), pick from the frontier based on risk preferences. Optuna's `NSGAIISampler` handles this.
- **Composite objective** — blend Sortino with profit factor (`0.6 * sortino + 0.4 * profit_factor`). Sortino can be gamed by one huge win + many small losses; profit factor catches that.
- **Regularization** — add penalty for param sets far from defaults: `objective = sortino - λ × distance_from_defaults`. Prevents exotic combinations that work on historical data but are fragile.
- **Expand search space to signal params** — currently signal computation, regime classification, and fair values are recorded and accepted as-is. The optimizer finds the best downstream response to a fixed signal. Expanding to include signal parameters (thresholds, layer weights) would optimize the full pipeline, but requires recomputing signals during replay (expensive).
- **Add recording to other strategies** — the snapshot data is strategy-agnostic. Wire recording into orchestrator, avellaneda-maker, or any future strategy. Same `TickSnapshot` format, same replay engine.
- **Multi-strategy replay** — build replay functions for other strategies (not just safe-maker). Replay the same recorded data through different strategy logic to compare approaches head-to-head.
- **Automated optimization pipeline** — cron job that runs the optimizer nightly on new data, alerts if optimal params have shifted significantly.
- **Parameter scheduling** — if time-bucketed analysis shows strong patterns (e.g., tighter params during low-liquidity hours), auto-switch params by time of day.
- **Partial snapshot writes** — write in-progress snapshots to D1 every N ticks with a `complete` flag. Prevents data loss on DO eviction for long windows (4hr). Currently snapshots are memory-only until window resolves.
- **Book conviction in search space** — 7-field bookConviction is recorded per tick but only a subset is used by the replay engine. Adding conviction-derived params (e.g., "ignore signal when book conviction disagrees") could improve results.
- **Data retention** — at ~1.2GB/month, D1 will need rotation. Archive snapshots older than 2-3 months to external storage, keep only recent data for active optimization.

### Long-term
- **Online learning** — lightweight param adjustment during live trading based on recent window outcomes (bandit-style, not full TPE).
- **Feature importance** — analyze which recorded features (regime scores, book conviction, wallet count, trade volume) most predict profitability. Drop uninformative features to reduce snapshot size further.
- **Cross-strategy meta-optimization** — use recorded data to decide *which strategy to run* for a given market condition (regime + symbol + duration), feeding into the orchestrator's tactic selection.
