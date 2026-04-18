# Bonereaper Analysis

> Consolidated analysis of Bonereaper (`0xeebde7a0e019a63e6b476eb425505b7b3e6eba30`), a profitable automated trader on Polymarket's crypto "Up or Down" binary markets.
>
> Data sources: 982 trades across 11 windows (initial analysis, early April), 192 trades cross-referenced with oracle data (April 9 correlation study), 10,000 trade live pull (April 11 via Data API), position snapshot (April 11), BabyBoneR replication testing (April 11). **April 18, 2026: 805,783 on-chain fills via Goldsky subgraph (see Section 13) — the first full-history dataset.**
>
> Last updated: April 18, 2026 (revised evening). **Added Section 14 (full-history correction) — completely overturns the "zero sells" claim. BR sells heavily as taker ~25 of 28 tracked days (only Mar 31–Apr 3 was a true no-sells window, 4 days). The /activity API that produced the original claim appears to filter or mis-categorize taker sells; Goldsky on-chain data is authoritative.** Section 13 is partially superseded by §14.

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

### Zero Sells — OVERTURNED (April 18, 2026, revised)

> **Claim is wrong.** Full Goldsky data (2.56M events, 28 days) shows BR
> sells heavily as taker ~25 of 28 tracked days (50K–108K sells/day).
> Only Mar 31 – Apr 3 was a true no-sells window — 4 days out of 28.
> The /activity API that produced the original "0 sells in 9800" claim
> appears to filter or mis-categorize taker sells; Goldsky is authoritative.
> See §14 for the full daily breakdown.

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
| Zero sells (current strategy) | **Confirmed** | Goldsky shows zero taker-sells from March 28 onward (§13) |
| Zero sells (full wallet history) | **False** | Mar 25–27 had 270K taker-sells; strategy changed around Mar 28 (§13) |
| Merge + redeem exit | **Confirmed (current)** | Primary exit since Mar 28; pre-Mar-28 the wallet also sold (§13) |
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
2. ~~**Fill size variation**~~ — **RESOLVED (April 14)**: Bonereaper sizes to available liquidity at each ask level. Fills range 0.2-639 because book depth varies. BabyBoneR now does the same (book-derived sizing).
3. **Reward optimization** — Almost certainly yes. The strategy structure (never sells, resting GTC on both sides, extreme volume, accepts pc>$1.00) is optimal for maker rebate farming. Estimated $1,100-$1,900/hr in rebates.
4. **Queue priority** — Critical for real-mode replication. Our real-mode test showed one-sided fills because we couldn't match Bonereaper's queue position. Shadow mode bypasses this by using their fills as proof of fillability.
5. **Break-even pair cost** — At what pc does merge loss exceed rebate income? Bonereaper shows pc up to $1.08. With 20% taker fee rebate on their volume, that may be ~$0.02-$0.05/pair in rebates, covering pc up to ~$1.05.
6. **Scaling from shadow to real** — Shadow mode proves the pricing logic works. But real mode needs actual CLOB queue position, which we can't replicate at small scale. The path may be: shadow validate → small real test → scale up as fill rate improves.
7. ~~**Late-window behavior**~~ — **RESOLVED (April 14)**: Bonereaper stops buying the losing side in 100% of windows and accelerates the winning side in 93% of windows. See Section 10.
8. ~~**Fill price distribution**~~ — **RESOLVED (April 14)**: 66% of fills are maker (price ≤ $0.60, zero fee), 34% are higher-priced. Average fill price $0.21. Most volume is deep value ($0.01-$0.20). See Section 10.

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

The shadow fill model runs as paper-mode BabyBoneR configs. It watches Bonereaper's live trades and simulates fills at their execution prices. See Section 8 for details.

---

## 10. New Behavioral Findings (April 14, 2026)

Analysis of 55,196 shadow_wallet_activity records (April 12-14) and 200 recent fills from the Data API.

### Late-Window Certainty Taking — Confirmed

Analyzed 54 windows with sufficient data (last 12 hours of 5-minute windows):

| Behavior | Frequency | Description |
|----------|-----------|-------------|
| Light side stops late | **100%** (54/54) | Bonereaper completely stops buying the losing side in the second half of every window |
| Heavy side accelerates late | **93%** (50/54) | Winning side receives 3,000-5,000 additional tokens in the last 2.5 minutes |

This is oracle-driven: once the price settles relative to the strike, Bonereaper knows which side will win and loads it aggressively while abandoning the other.

### Fill Price Distribution

200 recent BUY fills analyzed:

| Price range | Fills | Tokens | Interpretation |
|---|---|---|---|
| $0.01-0.20 | 81 (41%) | 8,588 | Deep value — resting maker fills |
| $0.21-0.40 | 21 (11%) | 496 | Value — resting maker fills |
| $0.41-0.60 | 30 (15%) | 767 | Near-fair — maker fills at $0.50 |
| $0.61-0.80 | 41 (21%) | 685 | Above fair — may be maker or taker |
| $0.81-0.95 | 27 (14%) | 1,315 | High conviction — likely taker sweeps |
| $0.96-0.99 | 0 (0%) | 0 | — |

**Key findings:**
- Average fill price: **$0.21** — most volume is deep value
- 66% maker fills (≤ $0.60): zero fee, possibly earning rebates
- Total taker fees: ~$15 across 200 fills (0.6% of cost) — negligible
- Estimated maker rebates: $6.75 per 200 fills

Bonereaper is overwhelmingly a **maker** — resting cheap bids that get filled when panicked sellers dump. The late-window certainty fills ($0.81-0.95) are the only significant taker activity.

### Three-Phase Behavioral Model (Refined)

Based on the above data, the refined model of Bonereaper's per-window behavior:

| Phase | When | Bid price | Volume | Fill type |
|---|---|---|---|---|
| **Deep value** | Early window, uncertain | $0.01-0.20 both sides | Moderate | Maker (resting) |
| **Following** | Mid-window, directional | P_true both sides | High | Mix |
| **Certainty load** | Late window, strong signal | $0.80-0.95 winning side only | Very high (3-5K tokens) | Taker (crossing) |

The "losing side stops" transition happens at ~50% of window duration when P_true moves beyond ~0.65.

### Multi-Level Bid Ladder — Confirmed

Bonereaper fills at many price levels within the same window — $0.05, $0.13, $0.21, $0.35, $0.48. This is not a single resting bid that gets repriced, but a **ladder of simultaneous bids** at multiple levels. Evidence: 41% of fills are at $0.01-0.20 (deep value), while 21% are at $0.61-0.80 (above fair). Both happen concurrently within the same window.

---

## 11. BabyBoneR Feature Gap Analysis (April 14, 2026)

### What BabyBoneR Does That Matches Bonereaper

| Feature | Status | Notes |
|---|---|---|
| Two-sided bidding | Done | Both UP and DOWN simultaneously |
| Zero sells | Done | Exit only via merge + redeem |
| Auto-merge | Done | Every tick (BR batch-merges at resolution — different timing but same net effect) |
| Capital recycling | Done | Merged pairs free capital for more fills |
| Dynamic pricing | Done | Follows P_true, not fixed offsets |
| BTC-focused | Done | `target_cryptos: ["Bitcoin"]` |
| Boundary-crossing discovery | Done | Detects new windows within 1-3s of opening |
| Event-driven fills | Done | CLOB WebSocket fires on book changes (millisecond latency) |
| Book-derived sizing | Done | Sizes to available liquidity at each ask level |
| Multi-level bid ladder | Done | 2-4 levels per side (deep value → fair), scales with capital |
| Balance protection | Done | HWM ratchet lock + capital cap |
| Deep value bidding | Done | Bonereaper mode bids $0.15 at deepest level |
| Late-window certainty loading | Done | Suppresses losing side, 2x size on winning side past 50% |
| Cancel-all on stop/startup | Done | Prevents orphan GTC orders draining balance |
| Capital-aware scaling | Done | Ladder levels, windows, duration all scale with capital |
| Three pricing modes | Done | `bonereaper` (adaptive), `hybrid` (shadow matching), `book` (CLOB ask) |

### What BabyBoneR Is Missing vs Bonereaper

| Gap | Impact | Description |
|---|---|---|
| **Sticky certainty mode** | Medium | When BR enters certainty mode late, they don't flip back on price wobbles. BabyBoneR can flip back to [STD] on a momentary P_true dip, buying losing-side tokens unnecessarily. |
| **Higher certainty bid prices** | Medium | BR bids $0.96-0.98 on the winning side late. BabyBoneR bids at P_true ($0.70-0.90). Missing the most aggressive certainty fills. |
| **Batch merge at resolution** | Low | BR merges all pairs at window end. BabyBoneR auto-merges every tick. Net P&L is similar but timing of capital freeing differs. |
| **Maker rebate income** | High | BR earns estimated $1,100-1,900/hr in maker rebates from volume. BabyBoneR at small capital generates negligible rebate volume. This is likely BR's largest profit source at scale. |
| **Queue priority** | High | BR has established queue position from persistent resting orders. BabyBoneR in real mode would be behind BR in the queue, getting fewer maker fills. |
| **Scale** | High | BR trades 30,000-90,000 tokens per window. BabyBoneR at small capital trades ~5-50. Many of BR's strategies (accepting pc>$1.00 for rebate volume) only work at scale. |

### Real-Mode Lessons Learned (April 14, 2026)

First real-mode test with $95 USDC revealed critical issues:

1. **Orphan orders**: Stopping the strategy did not cancel resting GTC orders on the CLOB. Orders continued filling after stop, draining the balance from $95 to $0.74. **Fixed**: cancel-all on stop and startup.

2. **Budget overflow**: Multi-level ladder placed 16 orders simultaneously (4 levels × 2 sides × 2 windows), exceeding the $95 balance in 2-3 tick cycles. **Fixed**: per-tick capital budget, break-on-failure, capital-aware ladder scaling (2 levels at $39, 3 at $100, 4 at $200+).

3. **Restart amnesia**: After process restart, the strategy lost track of resting CLOB orders and attempted to place duplicates, all rejected with "not enough balance." **Fixed**: cancel-all on init clears orphans before placing new orders.

4. **Window scaling**: $39 capital should trade 1 window at a time, 5m only. Dynamic scaling now: $39→1 window 5m, $80→15m unlocked, $120→2 concurrent, $200+→full 4-level ladder.

### Paper Fill Systems

BabyBoneR has three paper fill systems for validation:

| System | What it answers | Accuracy |
|---|---|---|
| **Shadow fills** | "Would BR's fills have been ours?" | High — uses BR's actual prices and sizes. Overly optimistic because we'd compete for the same liquidity. |
| **Grounded fills** | "Would the real market have filled us?" | Medium — checks CLOB book crossing + trade tape. More conservative on fill count. |
| **Bonereaper pricing mode** | "If we made BR's decisions independently, what happens?" | Best for untethered testing — makes the same decisions BR does but fill outcomes depend on the fill system used. |

Shadow and grounded fill results are remarkably similar over 24h+ runs, suggesting both are reasonable approximations. The bonereaper pricing mode outperformed both in initial testing (11/11 wins, avg +$147/window vs shadow +$57/window) by better directional loading.

---

## 12. 5-Minute vs 15-Minute Window Analysis (April 14, 2026)

Analysis of 1,018 5m windows and 269 15m windows from Bonereaper's shadow_wallet_activity (April 12-14).

### Key Metrics

| Metric | 5-minute | 15-minute |
|---|---|---|
| Windows analyzed | 1,018 | 269 |
| Avg tokens/window | 1,511 | 986 |
| Avg fills/window | 34 | 19 |
| **Pairing rate** | **42%** | **31%** |
| **Heavy skew (>70%)** | **60%** | **69%** |
| Avg pair cost | $0.731 | $0.597 |
| PC < $1.00 | 63% | 67% |
| Merge P&L/window | -$2.20 | $0.00 |
| **Merge P&L/token** | **$0.0033** | **$0.0010** |
| Well balanced (>80%) | 25% | 16% |

### Interpretation

**5-minute windows are better for merges.** Higher pairing rate (42% vs 31%), 3x more efficient per token ($0.003 vs $0.001 merge P&L/token), and 25% of windows are well-balanced vs only 16% for 15m.

**15-minute windows are directional bets.** 69% have heavy skew — the market has more time to trend one way, leaving excess on one side. Profit comes from the excess winning at resolution, not from merges (merge P&L ≈ $0 per window). When the directional bet is right, it pays well. When wrong, it's a larger loss than a 5m window.

**For capital-constrained accounts:**
- **5m windows are safer** — more merges, more pairing, less directional risk
- **15m windows require more capital** — need to survive occasional one-sided losses
- BabyBoneR unlocks 15m at $80 effective capital, which provides enough buffer

### Why Bonereaper Trades Both

Bonereaper trades both 5m and 15m concurrently. The 15m windows provide:
1. **Longer exposure** — more time for certainty to develop (P_true approaches 0 or 1)
2. **Larger directional profits** — 784 avg excess tokens × winning probability
3. **Diversification** — not all windows resolve the same way

At Bonereaper's scale (30K-90K tokens/window), the occasional 15m loss is absorbed easily. At small scale ($50-100), the same loss could wipe out a significant portion of capital.

---

## 13. Goldsky Subgraph Refresh (April 18, 2026) — Full-History Ground Truth

Backfilled BR's complete on-chain `orderFilledEvent` history from the public
Polymarket orderbook subgraph. **805,783 events across March 25 – April 1
(~7 days)**; cron continues catching up to present. First dataset with
every BR fill, not samples.

Tooling: `reaper/src/analysis/goldsky-backfill.ts` (TS-only, sticky-cursor
pagination). See `reaper/FILL-SYSTEM.md` for architecture.

### Two Regimes Discovered

BR's wallet splits into two behavioral regimes in this 7-day window:

| Period | Events | Buys-as-maker | Buys-as-taker | Sells-as-taker | Sells-as-maker |
|---|---|---|---|---|---|
| 2026-03-25 | 124,905 | 41,355 | 6,882 | 76,668 | 0 |
| 2026-03-26 | 173,033 | 64,623 | 9,987 | 98,422 | 1 |
| 2026-03-27 | 174,087 | 71,765 | 10,303 | 92,019 | 0 |
| 2026-03-28 | 69,609 | 69,609 | 0 | 0 | 0 |
| 2026-03-29 | 51,035 | 51,035 | 0 | 0 | 0 |
| 2026-03-30 | 103,783 | 103,783 | 0 | 0 | 0 |
| 2026-03-31 | 89,326 | 86,491 | 0 | 0 | 2,835 |
| 2026-04-01 | 20,005 | 19,945 | 0 | 0 | 60 |

- **March 25–27:** Active dual-sided trader. ~33% of events are taker sells
  (267,109 total). This is clearly NOT the "zero sells" strategy described in
  earlier sections.
- **March 28 onward:** Strategy flip. Pure maker-buy mode — zero taker sells,
  zero taker activity at all except rare maker-side sells (likely residual
  position management, not active strategy).

The original analysis observations (April 9–14) were all during the
post-March-28 "pure maker" regime. Those findings (zero sells, merge+redeem
exit, maker-rebate optimization) reflect that regime and remain valid for it.
Everything needs the caveat: **BR's strategy has changed at least once; it
may change again.**

### Refined Fill-Price Distribution (508K maker-buy fills, 2,500× larger sample)

| Price range | Fills | % | Tokens | Notional (USDC) | Avg price |
|---|---|---|---|---|---|
| $0.01–0.20 (deep value) | 97,288 | 19.1% | 3,266,858 | $311,588 | 0.115 |
| $0.21–0.40 (value) | 108,683 | 21.4% | 2,326,229 | $711,227 | 0.307 |
| $0.41–0.60 (near fair) | 148,058 | **29.1%** | 3,308,346 | $1,679,811 | 0.507 |
| $0.61–0.80 (above fair) | 97,538 | 19.2% | 2,387,283 | $1,669,605 | 0.696 |
| $0.81–0.95 (high conviction) | 44,776 | 8.8% | 1,835,769 | $1,624,505 | 0.872 |
| $0.96–0.99 (panic late) | 12,263 | 2.4% | 3,178,608 | $3,135,172 | 0.985 |

**Key corrections vs the 200-fill sample (§10):**

- **Near-fair is the largest bucket, not deep value.** 29.1% of fills at $0.41–
  0.60 vs the prior claim of 15%. Most BR activity is around fair price, not
  cheap panic-buying.
- **Panic-late bucket exists and is enormous.** The original sample found 0 fills
  at $0.96–0.99. Goldsky shows 12K fills there with **3.18M tokens / $3.14M
  notional** — nearly 19% of all BR's token volume comes from this tiny-count
  bucket. These are massive late-window "certainty loads" at prices guaranteeing
  tiny profits but no loss (token resolving at $1.00 in seconds). This is the
  real "end-of-window" behavior, not the 0.81–0.95 bucket.
- **Average price is NOT $0.21.** Notional-weighted average is ~$0.56 — BR's
  dollars go mostly to near-fair and high-conviction buys, not to pennies.

### Net Position Flow

Over 7 days, BR paid a net **$7.3M USDC** to acquire outcome tokens — massively
net long. Gross maker-paid USDC: $11.74M; gross taker-paid USDC: $21.0M.
Consistent with the "accumulate, merge, redeem" strategy pattern.

### Fee Field Ground Truth

The Goldsky `fee` field contains real on-chain fee values but **denomination is
not yet decoded**. Sample values:
- At price=$0.50, size=40 tokens, maker_amount=$20 USDC → fee=4.0 (units unclear;
  the ~20% ratio to maker_amount is too high to be a flat 6.25% crypto-market fee)
- Several distinct "fee_bps / maker_amount" clusters (2000, 1884, 1673, 1578…)
  suggest per-order `feeRateBps` parameters, not a flat market rate

Decoding this properly is a ROADMAP Phase 4.10 follow-up. The `fee` field is
ground truth for what Polymarket actually charged — once decoded, it replaces
our modeled `p*(1-p)*0.0625*size` formula for paper P&L.

### Data Limitations

- **Only 7 days covered so far (Mar 25 – Apr 1).** Cron is backfilling to
  present; the Goldsky server rate-limits heavy queries so we catch up slowly.
- **No window context yet.** Goldsky events carry `maker_asset_id` (the outcome
  token) but not the market slug or window boundaries. Late-window / phase /
  5m-vs-15m analyses (§10 phase-three model, §12 window-duration comparison)
  still need the `token_id → market` lookup that's pending (ROADMAP Phase 4.11).
- **Wallet rotation risk.** This wallet has already changed strategies once
  (Mar 25-27 → Mar 28+). A second rotation to a fresh wallet would make these
  findings historical overnight. Rotation detector is ROADMAP Phase 4.9.

---

## 14. Full-History Correction (April 18, 2026, evening)

After backfilling 2.56M Goldsky events across March 25 – April 18 (24 days),
the "zero sells" claim — repeated throughout §1, §5, §10, §11, §12, §13 —
is wrong. BR sells heavily as taker almost continuously.

### Daily Action Breakdown

| Date | Maker BUY | Taker BUY | **Taker SELL** | Maker SELL |
|---|---|---|---|---|
| 2026-03-25 | 41,355 | 6,882 | **76,668** | 0 |
| 2026-03-26 | 64,623 | 9,987 | **98,422** | 1 |
| 2026-03-27 | 71,765 | 10,682 | **95,853** | 0 |
| 2026-03-28 | 69,609 | 12,274 | **108,019** | 0 |
| 2026-03-29 | 51,035 | 6,578 | **58,699** | 0 |
| 2026-03-30 | 103,783 | 9,467 | **78,810** | 0 |
| **2026-03-31** | **86,491** | **0** | **0** | **2,835** |
| **2026-04-01** | **77,424** | **0** | **0** | **60** |
| **2026-04-02** | **74,338** | **0** | **0** | **0** |
| **2026-04-03** | **44,193** | **0** | **0** | **0** |
| 2026-04-04 | 27,439 | 2,196 | 19,441 | 0 |
| 2026-04-05 | 48,807 | 5,764 | **49,480** | 0 |
| 2026-04-06 | 72,633 | 7,972 | **61,223** | 0 |
| 2026-04-07 | 54,628 | 6,111 | **52,040** | 0 |
| 2026-04-08 | 58,936 | 3,188 | **26,718** | 0 |
| 2026-04-09 | 45,626 | 9,563 | **82,103** | 0 |
| 2026-04-10 | 48,739 | 789 | 4,698 | 0 |
| 2026-04-11 | 33,511 | 7,351 | **53,651** | 0 |
| 2026-04-12 | 61,999 | 6,111 | **59,722** | 0 |
| 2026-04-13 | 67,342 | 5,092 | **34,890** | 0 |
| 2026-04-14 | 77,784 | 12,013 | **98,648** | 0 |
| 2026-04-15 | 60,310 | 6,419 | **47,840** | 0 |
| 2026-04-16 | 60,659 | 9,084 | **61,428** | 0 |
| 2026-04-17 | 45,839 | 8,857 | **63,862** | 0 |
| 2026-04-18 | 6,087 | 6,792 | **49,314** | 0 |

**The only true "no-sells" window is Mar 31 – Apr 3 (4 days).** Everything
else has taker sells. The /activity API's "0 sells in 9800 trades" original
claim appears to reflect API filtering/categorization, not the underlying
on-chain truth.

### BR's Actual Playbook (April-15+ BTC 5m windows, per-elapsed-phase)

Joining `goldsky_trades` with `markets_cache` to attribute each fill to its
window and elapsed %:

| Phase | maker BUY | taker BUY | taker SELL |
|---|---|---|---|
| EARLY (0–30%) | 26,780 @ $0.51 | 4,457 @ $0.52 | **42,102 @ $0.49** |
| MID (30–70%) | 29,369 @ $0.48 | 8,275 @ $0.52 | **40,971 @ $0.52** |
| LATE (70–95%) | 18,114 @ $0.50 | 6,468 @ $0.61 | **23,158 @ $0.51** |
| CLOSE (95–100%+) | **5,322 @ $0.87** | 1,402 @ $0.89 | 3,703 @ $0.33 |

**Pattern reading:**

1. **Market-making behavior, not directional accumulation.** Maker BUYs
   at ~$0.50 + taker SELLs at ~$0.50 across EARLY/MID/LATE. 109K sells
   vs 19K taker buys overall. BR is posting maker bids, collecting fills,
   then crossing back out via taker sells — likely to capture maker rebates
   while staying near-neutral.

2. **Certainty loading ONLY in last 5%.** Maker BUYs at $0.87 with massive
   per-fill size (5,322 fills / 656K tokens = 123 tokens/fill). This is
   the "stack the winning side right before resolution" behavior. Previous
   §10 claim that late-window starts at 30% is wrong — it's the last 5%.

3. **Mid-phase taker SELL at $0.51 is neutral-exiting.** This is where
   BR trims positions to free capital. We don't do this — we use mid-window
   merging instead. Both are valid recycling strategies.

### Implications for Reaper

**Behaviors we're missing:**
- **Taker selling for neutral position management.** Our strategy never
  sells. BR's entire mid-phase is balanced maker-buy + taker-sell at
  near-fair prices. This costs us capital velocity and possibly some
  market-making edge (rebates).
- **Delayed certainty load.** Our `late_size_mult` fires at elapsed > 70%;
  BR fires at > 95%. We're loading winning side too early, risking
  reversals (P_true flips late-window in 5/7 windows per §1).

**Behaviors we have that BR doesn't:**
- **Mid-window merging** (§2.8 observation: BR only merges at resolution).
  Our `jit-merge-on-capital-squeeze` is a different strategy for capital
  recycling — both valid, ours saves a sell-side leg per round-trip.

### Prior Claims, Corrected

| Claim | Earlier Status | Correct Status |
|---|---|---|
| "Zero sells" | Confirmed → Refined (§13) | **OVERTURNED** — BR sells 25 of 28 days |
| "Merge + redeem exit only" | Confirmed → Partial (§13) | **Wrong** — BR's primary capital recycling is via taker sells, merges are a backstop |
| "Strategy flipped Mar 28" | Claimed | **Wrong** — Brief 4-day pause Mar 31–Apr 3, otherwise consistent |
| "93% taker post Apr 15" | Claimed | **Partial** — 93% of taker events are sells; taker role is ~40% of total, not 93% |
| "Late-window certainty loads start at 30%" (§10) | Claimed | **Wrong** — Starts at 95%+ |

### Data-Collection Meta-Lesson

The /activity API has been giving us filtered/biased data since the start.
All pre-Goldsky sections of this doc should be re-verified against on-chain
subgraph data. The Goldsky backfill pipeline (§13) is now the canonical
source; §1–§12 should be treated as historical speculation unless confirmed
from on-chain events.
