# Bonereaper Analysis

> Consolidated analysis of Bonereaper (`0xeebde7a0e019a63e6b476eb425505b7b3e6eba30`), a profitable automated trader on Polymarket's crypto "Up or Down" binary markets.
>
> Data sources: 982 trades across 11 windows (initial analysis, early April), 192 trades cross-referenced with oracle data (April 9 correlation study), 10,000 trade live pull (April 11 via Data API), position snapshot (April 11), BabyBoneR replication testing (April 11).
>
> Last updated: April 12, 2026 (major revision — live side-by-side comparison overturned fixed-offset model).

---

## 1. Live Trade Data (April 11, 2026) — Most Reliable Source

Pulled 10,000 most recent trades + 25 open positions directly from the Data API. This is the ground truth for current behavior.

### Key Findings

| Metric | Value | Implication |
|--------|-------|-------------|
| Total trades in sample | 9,800 buys + 100 merges + 100 redeems | Zero sells |
| Time span | 25 minutes (~400 trades/min) | Extremely high frequency |
| Markets | BTC only (100%) | Narrowed from 6-market to BTC-only |
| Window types | 62% 5-min, 38% 15-min | Both durations active |
| Avg fill size | 53.6 tokens (P50=26.4, range 0.2-639) | Highly variable |
| Avg buy price | $0.55 (P10=$0.26, P90=$0.86) | Full price range |
| Sell count | **0 out of 9,800** | Exits ONLY via merge+redeem |
| Tokens per window | 30,000-90,000 | Massive volume per window |

### Zero Sells — Confirmed

Across the full 3,000 accessible items (2.5 hours, API max), there are ZERO sell trades. All exits are via MERGE (token pairs → $1.00 USDC) and REDEEM (winning tokens → $1.00 at resolution).

### Open Positions Reveal Directional Skew

| Window | UP tokens | DN tokens | Ratio | Pair Cost |
|--------|-----------|-----------|-------|-----------|
| 1:45-1:50 AM (5m) | 1,758 @ $0.13 | 4,393 @ $0.88 | 29/71 | $1.01 |
| 1:40-1:45 AM (5m) | 1,659 @ $0.48 | 2,803 @ $0.57 | 37/63 | $1.05 |
| 1:55-2:00 AM (5m) | 436 @ $0.14 | 2,668 @ $0.77 | 14/86 | $0.91 |
| 1:50-1:55 AM (5m) | 1,238 @ $0.12 | 1,594 @ $0.75 | 44/56 | $0.87 |
| 1:30-1:45 AM (15m) | 1,319 @ $0.72 | 1,486 @ $0.31 | 47/53 | $1.03 |

**Key observations**:
- Position ratios range from 14/86 to 47/53 — often skewed, NOT always balanced
- Pair costs range $0.87-$1.05 — sometimes above $1.00
- Winning side accumulates more inventory via maker fills at favorable prices
- Losing side gets cheap crossing fills that auto-merge into immediate profit

### Intra-Window Directional Flipping

Temporal analysis of 7 windows shows the heavy side flips WITHIN individual windows in 5 out of 7 cases. This is consistent with fixed-offset pricing where the "winning" determination flips with P_true.

---

## 2. What Bonereaper Actually Does (Current Understanding)

> **Major revision: April 12, 2026.** Live side-by-side comparison with Bonereaper overturned the fixed $0.72/$0.28 model. The new understanding is based on real-time Data API monitoring of Bonereaper's fills alongside BabyBoneR's shadow trading.

### Core Strategy: Aggressive Two-Sided Volume Engine with Merge/Redeem Exit

1. **Pricing**: NOT fixed $0.72/$0.28 — that was an artifact of analyzing mid-window fills. Bonereaper bids **near $0.50 on both sides at window open**, then follows the market as P_true drifts. Fill prices observed:
   - At window open (P_true ≈ 0.50): UP $0.47-$0.53, DN $0.47-$0.53 — nearly symmetric
   - Mid-window (P_true drifted): winning side $0.55-$0.87, losing side $0.13-$0.35
   - Within any 30-second bucket: only ~2.7 distinct price levels (repricing over time, not a deep ladder)

2. **Fill rate**: Extremely aggressive — 200-800 tokens per 5-minute window, across both sides. Fills within the first 10 seconds of window open. Both sides accumulate simultaneously.

3. **Pair cost often above $1.00**: Bonereaper shows pc=$0.94-$1.08 across windows. They accept pc>$1.00 (negative merge edge) because **maker rebates compensate**. The strategy optimizes for **throughput** (volume × rebate) not pair cost.

4. **No sells**: Confirmed across all data. All exits via merge (pair UP+DOWN → $1.00 USDC) and redeem (winners → $1.00 at resolution). Zero sell orders across 10,000+ trades.

5. **Auto-merge + capital recycling**: Pairs merged continuously within windows, freeing capital for more fills. A single 5-minute window can see 600+ merged pairs — the same capital recycled many times.

6. **Pairing ratio**: 30-90% depending on P_true stability. When P_true stays near 0.50, pairing exceeds 80%. When it drifts strongly, one side dominates (~30% paired). Average across many windows: ~50-60%.

7. **Three-phase profit model** (confirmed April 12 via pair cost analysis by time-in-window):
   - **Early window (0-33%)**: Buy both sides near $0.50. Pair cost ~$1.05 (negative merge edge). Purpose: generate maximum volume for **maker rebates**.
   - **Late window (66-100%)**: Buy both sides at extreme P_true prices (winning $0.76-$0.91, losing $0.13-$0.21). Pair cost drops to **$0.96-$0.98** — profitable merges. Late fills are the BEST fills.
   - **Resolution**: Merge ALL pairs (batch, not continuous). Late pairs subsidize early pairs. Redeem excess unmatched winners at $1.00 for directional profit.

   Evidence: In the 3:30-3:35 window, full-window pc=$1.019 (loss on merges), but late-only pc=$0.962 (profit). The late fills fix the pair cost.

8. **Merges at resolution, not during window**: Data API shows MERGE events only at window end (0 merges during 5m windows with 40-120 buys). Bonereaper holds all inventory until resolution, then batch-merges. This is different from BabyBoneR's auto-merge-every-tick approach.

### What Changed from the Previous Model

| Aspect | Old Model (April 11) | New Model (April 12) | Evidence |
|--------|---------------------|---------------------|----------|
| **Bid prices** | Fixed $0.72/$0.28 | Dynamic, follows market, ~$0.50 at open | Live Data API monitoring |
| **Price mechanism** | Fixed offset from $1.00 | Repricing every few seconds as P_true moves | 30s bucket analysis: 2.7 distinct prices/bucket |
| **Pair cost target** | < $1.00 (profitable merges) | ≈ $1.00-$1.05 (break-even or slight loss) | Live fill comparison |
| **Primary profit** | Merge spread | Three streams: rebates (early) + merge (late) + directional (excess) | pc>$1.00 early is intentional for rebate volume |
| **Merge timing** | Continuous (auto-merge each tick) | Batch at resolution | Data API shows 0 merges during windows |
| **Pairing priority** | Balance inventory | Volume first; late fills fix pair cost | Late pc=$0.96 subsidizes early pc=$1.05 |

### How BabyBoneR Replicates This (v6+, Shadow Mode)

BabyBoneR now uses a **shadow fill model** that watches Bonereaper's actual trades via the Data API:

1. **Shadow fills**: Every 10s, fetch Bonereaper's last 200 trades. For each fill in our market: if our bid ≥ their fill price → grant a shadow fill at their actual execution price.

2. **Pricing**: Hybrid model — `max(0.55, P_true)` for both sides. The 0.55 floor ensures we cover Bonereaper's minimum fill prices (~$0.51). Winning side follows P_true up; losing side stays at $0.55 minimum.

3. **No cooldown**: Process ALL matching Bonereaper fills per tick. Capital/inventory gates are the only constraint.

4. **Alternating fill order**: Light side fills first to maximize pairing.

5. **Smart capital gate**: When max cost exceeded, only suppress the heavy side — always allow light side to pair.

6. **Direct slug-based market discovery**: Generate window slugs from timestamps (`btc-updown-5m-{unix_ts}`) and look up via Gamma API. Avoids the slow discovery pipeline.

**Results (shadow mode, first 45 minutes)**:
- $1,266 P&L on $20 starting capital
- 94%+ coverage of Bonereaper's fills
- Pair costs match Bonereaper's exactly (same execution prices)
- 100% pairing in balanced windows, 0-80% in trending windows
- Massive capital recycling via auto-merge (1,400+ pairs merged in a single window)

---

## 3. Platform Incentive Analysis

Polymarket has two reward programs relevant to Bonereaper's strategy:

### Maker Rebates Program
- Crypto markets: **20% of taker fees** redistributed to makers
- Rebate proportional to your share of executed maker volume in each market
- Paid daily in USDC

### Liquidity Rewards
- Separate daily USDC pool per market
- Quadratic spread scoring: `S(v,s) = ((v-s)/v)² · b`
- Two-sided quoting required (3x penalty for single-sided when mid in 0.10-0.90)
- Rewards earned even for unfilled resting orders

**Assessment**: Rewards are meaningful supplemental income but NOT the primary profit driver. The position skew proves directional conviction — a pure reward farmer would maintain ~50/50 balance.

---

## 4. Debunked Hypotheses

### "Bonereaper Sells Both Sides" (from external analysis)
**Status: DEBUNKED.** Zero sells across 10,000+ trades. Exits only via merge+redeem. This was the most definitively disproven claim.

### "Mean-Reversion Profit-Taking" (BabyBoneR v1 design)
**Status: DEBUNKED.** Built into BabyBoneR v1 as sell-based mean-reversion. Removed after confirming zero sells in trade data.

### "Dynamic Market-Following Pricing"
**Status: CONFIRMED (April 12).** Live monitoring proved Bonereaper reprices as P_true moves. 30-second bucket analysis showed ~2.7 distinct price levels per bucket, with full-window prices spanning $0.13-$0.87. The fixed $0.72/$0.28 model was wrong — those were mid-window snapshots, not the actual bidding strategy.

### "Skew-Adaptive Balance Recovery"
**Status: PARTIALLY CONFIRMED.** Pure 50/50 rebalancing destroys pair cost (as previously tested). But Bonereaper DOES bid aggressively on the light side to maintain balance — they pay above fair value ($0.55-$0.66) for the losing side to accumulate pairs. The mechanism is market-following pricing, not explicit skew correction.

### "Fade the Retail Flow"
**Status: DEBUNKED.** 36% fade rate (worse than random), 0.0s reaction lag proves passive maker with resting orders, diffuse counterparties.

### "Binance-Correlated Directional Signal"
**Status: DEBUNKED.** 8% alignment with BTC direction (12 flips analyzed). The signal source is NOT external price feeds. However, the oracle strike vs spot DOES determine which side is "winning" — it's just that the market microstructure (which side has cheap asks) is what actually drives fill patterns.

---

## 5. What Still Holds

| Claim | Status | Evidence |
|-------|--------|----------|
| Zero sells | **Confirmed** | 10,000 trade sample, zero sell orders |
| Merge + redeem exit | **Confirmed** | Only exit mechanism observed |
| Both UP and DOWN sides | **Confirmed** | Buys both, 30-90% paired depending on P_true stability |
| Fixed bid levels ($0.72/$0.28) | **OVERTURNED** | Live monitoring shows dynamic pricing ~$0.50 at open, follows P_true |
| High frequency | **Confirmed** | 200-800 tokens per 5m window |
| BTC-focused (currently) | **Mostly** | ~90% BTC, some ETH observed in live monitoring |
| Passive maker + aggressive taker | **Confirmed** | Resting GTC + immediate crosses on both sides |
| Auto-merge + capital recycling | **Confirmed** | 600+ pairs merged in single windows |
| Pair cost < $1.00 | **OVERTURNED** | Often pc=$1.01-$1.08; accepts negative merge edge for volume |
| Maker rebates significant | **Confirmed** | Estimated $1,100-$1,900/hr — compensates for pc>$1.00 |
| Throughput > pair cost | **NEW** | Optimizes volume for rebates, not pair cost for merge spread |

---

## 6. Three Tests (April 11, 2026)

Ran three quantitative tests against 15,000 trade items (14,760 buys + 120 merges + 120 redeems) across 6 concurrent windows in a 20-minute sample.

### Test 1: Is Pricing Truly Fixed?

**Method**: Grouped trades by window, classified each trade as winning-side (higher median price in that window) or losing-side, bucketed by time-in-window (early/mid/late).

**Results**:

| Metric | Value |
|--------|-------|
| Cross-window σ of winning-side medians | $0.114 (n=6) |
| Cross-window σ of losing-side medians | $0.156 (n=6) |
| Per-window winning medians | $0.56, $0.60, $0.74, $0.74, $0.82, $0.84 |
| Per-window losing medians | $0.18, $0.25, $0.28, $0.37, $0.53, $0.56 |
| Winning price time progression | Early $0.62 → Mid $0.79 → Late $0.84 |

**Interpretation**: Fill prices DO vary across windows (σ > $0.10). But this doesn't prove adaptive *bidding*. The variance is explained by:
- **Crossing fills at ask price**: Ask prices vary with P_true (low P_true = cheap asks on losing side)
- **P_true drift within window**: Early fills happen when P_true ≈ 0.50 (both sides near $0.50), late fills happen after P_true has drifted (winning side $0.85+, losing side $0.15)
- **Fixed bids produce variable fill prices**: A fixed $0.72 bid crosses a $0.05 ask and fills at $0.05, not $0.72

**Verdict**: INCONCLUSIVE — fill price variance is consistent with BOTH fixed and adaptive bidding. Cannot distinguish from fill data alone. Would need order placement data (not available via Data API) to determine if bids themselves change.

### Test 2: Does Edge Increase Near Expiry?

**Method**: For each window, computed implied pair cost (avg UP price + avg DN price) in 5 time slices. Also tracked crossing fill frequency (fills at price < $0.10).

**Results**:

| Time slice | Avg Pair Cost | σ(PC) | Crossing % | Avg Size | n(windows) |
|-----------|---------------|-------|-----------|----------|------------|
| 0-20% (early) | $1.004 | 0.067 | 0.0% | 29.0 | 6 |
| 20-40% | $0.991 | 0.042 | 0.0% | 29.7 | 5 |
| 40-60% (mid) | $0.995 | 0.047 | 6.7% | 48.2 | 5 |
| 60-80% | $1.012 | 0.117 | 0.8% | 96.2 | 4 |

Early PC: $1.004 → Mid PC: $0.995 → Late PC: $1.012 (Δ < $0.02)

**Interpretation**: Pair cost is flat across window duration — no statistical edge increase near expiry. Crossing fills appear mid-window (6.7%) when P_true has drifted enough for one side to become cheap, then decrease late-window as the dominant side prices itself toward $1.00. Fill SIZES increase late-window (29 → 96) but this is likely from accumulated resting orders filling against late directional flow, not deliberate size scaling.

**Verdict**: NO TIME DECAY EFFECT. Edge is constant across window duration.

### Test 3: Are Rewards Meaningful?

**Method**: Computed taker fees generated by Bonereaper's maker fills, estimated maker rebate share.

**Results** (20-minute sample):

| Metric | Value |
|--------|-------|
| Total notional | $627,213 |
| Taker fees on BR fills | $6,283 |
| Avg taker fee per token | $0.0137 |
| Merge events | 120 |
| Merge tokens | 3,996 pairs |
| Merge payout | ~$3,996 (at $1.00/pair) |

**Rebate estimate**: $6,283 taker fees in 20 min → ~$18,849/hour in taker fees generated. If Bonereaper captures 30-50% of maker volume, their share of the 20% rebate pool = $1,131-$1,885/hour.

**Merge profit estimate**: 3,996 pairs in 20 min × (1.00 - ~0.85 pair cost) = ~$599 in merge profit, or ~$1,798/hour.

**Reward-to-merge ratio**: Roughly 60-100% — rewards are comparable to merge profit.

**Caveats**: Extrapolating 20 minutes to hourly rates is noisy. The actual reward calculation depends on total market volume (not just Bonereaper's share). These are order-of-magnitude estimates.

**Verdict**: REWARDS ARE LIKELY MEANINGFUL. At these volume levels, maker rebates appear comparable to merge profit. Bonereaper may be optimizing for both simultaneously — the zero-sell, high-volume, two-sided quoting strategy is perfectly aligned with Polymarket's reward structure.

---

## 7. Open Questions

1. ~~**Bid vs fill prices**~~ — **RESOLVED**: Live monitoring confirmed dynamic pricing. Bids follow P_true, not fixed offsets.
2. **Fill size variation** — Sizes range from 0.2 to 639 tokens. Partial fills on thin books, or deliberate sizing? Still unexplored.
3. **Reward optimization** — Almost certainly yes. The strategy structure (never sells, resting GTC on both sides, extreme volume, accepts pc>$1.00) is optimal for maker rebate farming. Estimated $1,100-$1,900/hr in rebates.
4. **Queue priority** — Critical for real-mode replication. Our real-mode test showed one-sided fills because we couldn't match Bonereaper's queue position. Shadow mode bypasses this by using their fills as proof of fillability.
5. **Break-even pair cost** — At what pc does merge loss exceed rebate income? Bonereaper shows pc up to $1.08. With 20% taker fee rebate on their volume, that may be ~$0.02-$0.05/pair in rebates, covering pc up to ~$1.05.
6. **Scaling from shadow to real** — Shadow mode proves the pricing logic works. But real mode needs actual CLOB queue position, which we can't replicate at small scale. The path may be: shadow validate → small real test → scale up as fill rate improves.

---

## 8. Shadow Fill Model (April 12, 2026)

The breakthrough for validating BabyBoneR against Bonereaper without spending real money.

### How It Works

1. Every 10 seconds, fetch Bonereaper's last 200 trades from the Data API
2. For each Bonereaper BUY fill in the same market (matched by slug):
   - If our bid price ≥ Bonereaper's fill price → grant a shadow fill at **Bonereaper's price**
   - Track processed fill IDs to avoid double-counting
3. No cooldown — process ALL matching fills, limited only by capital/inventory gates
4. Auto-merge profitable pairs immediately, recycling capital

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Fill at Bonereaper's price, not ours | Our bid is the upper bound; their price is the actual market clearing price |
| Bid floor at $0.55 both sides | Bonereaper's minimum fill price is ~$0.51; $0.55 covers all their fills |
| No cooldown | Every Bonereaper fill = a fill opportunity for us (limited by capital gate) |
| Capital gate suppresses heavy side only | Always allow light-side fills for pairing |
| Direct slug-based discovery | Predictable slugs: `btc-updown-5m-{unix_open_time}` — no slow trade-based discovery |

### Results

| Metric | Shadow BabyBoneR | Bonereaper |
|--------|-----------------|------------|
| Fill coverage | 94%+ of Bonereaper's fills | 100% (reference) |
| Pair cost | Matches exactly | $0.94-$1.08 |
| Pairing ratio | 67-100% (balanced windows) | 30-90% |
| Capital recycling | 600+ merges per window | Similar |
| P&L (45 min) | +$1,266 on $20 paper capital | N/A (much larger capital) |

---

## 9. Analysis Scripts

Scripts in `worker/src/optimizer/` for ongoing Bonereaper analysis:

| Script | Purpose |
|--------|---------|
| `bonereaper-analysis.ts` | Per-market stats, fill size distribution, UP/DOWN breakdown, per-window aggregation |
| `bonereaper-temporal.ts` | Intra-window directional flipping, cross-window bias timeline |
| `bonereaper-flip-corr.ts` | 30-second bucket bias vs Binance BTC 1s klines, flip alignment analysis |
| `bonereaper-frf.ts` | "Fade the Retail Flow" test: global tape cross-reference, counterparty analysis |
| `bonereaper-3tests.ts` | Three-test suite: pricing variance, time decay, reward estimation |

| `bonereaper-ladder-test.ts` | Per-window per-side fill price clustering: distinct prices, top-2 concentration |
| `bonereaper-bucket-test.ts` | 30-second time-bucket analysis: distinct prices per bucket (key evidence for repricing-over-time model) |

Usage: `cd worker && ./node_modules/.bin/tsx src/optimizer/bonereaper-3tests.ts`

### Shadow Fill Strategy

The shadow fill model runs as `bbr-shadow-v6` strategy config in paper mode. It watches Bonereaper's live trades and simulates fills at their execution prices. See Section 8 for details.
