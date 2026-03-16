# Strategy Improvements

> Last updated: March 16, 2026. Reflects adaptive repricing (volatility offset, time-decay, reluctant requoting), tape fill protection, and maker rebate tracking.

---

## Top 10 Most Impactful Remaining Improvements

Ranked by expected impact. Focus on safe-maker + directional-maker since they run real+paper side-by-side.

| # | Improvement | Expected Impact | Status |
|---|------------|-----------------|--------|
| 1 | **Inventory-aware asymmetric offsets** — widen heavy-side offset, tighten light-side offset instead of binary cancel | +$2.50/window | TODO |
| 2 | **Fill rate feedback loop** — auto-tune offset to target ~60% fill rate per symbol/regime | +$2.00/window | TODO |
| 3 | **Cross-asset momentum cascade** — use BTC lead-lag to pre-adjust ALT offsets before price catches up | +$1.50/window ALTs | TODO |
| 4 | **Per-crypto bid sizing** — BTC=50, ETH=40, SOL=30, XRP=20 based on liquidity depth | +$2.00/window | TODO |
| 5 | **Multi-tier bids** — 2-3 price levels per side for smoother fills and better average price | +$1.25/window | TODO |
| 6 | **Conditional entry timing** — wait 15-30s after window open for volume/spread confirmation | +$1.50/window | TODO |
| 7 | **Polymarket tape order flow signal** — analyze buy/sell imbalance in existing tape data | +$1.00/window | TODO |
| 8 | **Per-crypto conviction bias** — tune per asset from realized directional accuracy | +$1.50/window (XRP) | TODO |
| 9 | **Adaptive pair cost by duration** — 5min=0.90, 15min=0.93, 60min=0.96 | +$1.50/window on 5min | TODO |
| 10 | **Window overlap exploitation** — use 5min resolution as signal for overlapping 15min window | +$0.80/window | TODO |

### Recently completed (March 15-16)

| Improvement | Impact | Strategies |
|------------|--------|------------|
| **Dynamic bid offset by volatility** — `vol_offset_scale_high/low` scales offset by `signal.volatilityRegime` | Wider in choppy (protection), tighter in calm (fills) | safe-maker, directional-maker |
| **Window-end time-decay** — `tighten_start_pct` linearly reduces offset for unfilled sides in last 30% of window | More fills near window end | safe-maker, directional-maker |
| **Reluctant requoting** — `min_requote_delta` (2c) skips cancel+replace when new bid is barely different | Preserves queue priority | safe-maker, directional-maker |
| **Tape fill protection** — check trade tape before paper cancel to catch fills between ticks | No more lost paper fills on requote | safe-maker, directional-maker, conviction-maker |
| **Maker rebate tracking** — fee_equivalent stored in D1 for all BUY fills | Accurate rebate pool weighting | all strategies |
| **D1 records for immediate fills** — placeOrder returning "filled" now writes to strategy_trades | Complete trade audit trail | all strategies |

---

## New Improvement Ideas (Deep Analysis)

### 1. Inventory-Aware Asymmetric Offsets

**Problem**: Current per-tick inventory safety is binary — cancel the heavy-side bid entirely or keep it. This loses queue position and stops price discovery on that side.

**Proposal**: Replace the binary cancel with continuous offset scaling based on inventory ratio.

```
Example: UP=30, DN=10 (need more DN)
  Current behavior: cancel UP bid entirely
  Proposed behavior:
    UP offset = bid_offset * 2.0  (wider → less likely to fill, still quoted)
    DN offset = bid_offset * 0.5  (tighter → more likely to fill)

Inventory ratio = max(UP,DN) / max(min(UP,DN), 1)
  ratio < 1.3:  symmetric offsets (balanced enough)
  ratio 1.3-2:  light-side offset * 0.7, heavy-side offset * 1.5
  ratio > 2:    light-side offset * 0.5, heavy-side offset * 2.0 (or cancel)
```

**Why it's better**: Smoothly steers toward balance instead of all-or-nothing. Heavy side still gets quoted (at a wide offset) so if the market reverses, we can still fill. Light side gets aggressive pricing to attract the fills we need.

**Estimated complexity**: Low. Modify the inventory check in `updateQuotes` to adjust offset instead of cancelling. No new params needed (can reuse the ratio threshold).

### 2. Fill Rate Feedback Loop

**Problem**: Fixed offsets don't account for realized fill probability. offset=0.02 fills 95% of the time in volatile markets (adverse selection — we fill when the market moves against us) but only 10% in calm markets (capital sitting idle).

**Proposal**: Track per-symbol, per-volatility-regime fill rates. Auto-tune offset to target ~60% fill rate.

```
After each window resolves:
  fill_rate = fills_received / ticks_with_resting_bid
  Store in EMA bucket keyed by (symbol, volatilityRegime)

Next window, compute target offset:
  if fill_rate > 0.75: widen offset by 10% (too many fills = adverse selection)
  if fill_rate < 0.40: tighten offset by 10% (too few fills = missing opportunities)
  Bounded by [0.01, 0.08]
```

**Why it matters**: This is the missing feedback loop. Currently we guess offsets; this learns them. Unified-adaptive already has fill bucket EMA for bid sizing — this would be the analogous system for offset tuning.

**Interaction with volatility-adaptive offset**: The vol multiplier handles regime shifts within a window. The fill rate loop handles cross-window learning. They stack: `base_offset * vol_multiplier * fill_rate_adjustment`.

### 3. Cross-Asset Momentum Cascade

**Problem**: BTC moves first, ALTs follow 5-30 seconds later. conviction-maker has `computeLeadLagBonus()` but safe-maker and directional-maker don't use it. When BTC spikes UP, our ALT DN bids fill (adverse selection) before the ALT price catches up.

**Proposal**: Share the lead-lag module across all maker strategies. When BTC makes a sharp move (>0.1% in 30s):

```
For each ALT (ETH, SOL, XRP):
  if BTC direction confirms ALT signal: tighten conviction-side offset
  if BTC direction contradicts ALT signal: widen both offsets (danger)
  if BTC move is very strong + ALT hasn't moved yet: cancel ALT bids entirely for 2 ticks
```

**Expected impact**: Prevents the most common adverse selection pattern — BTC moves, ALT bids fill on the wrong side before the ALT signal updates.

### 4. Polymarket Tape Order Flow Signal

**Problem**: We fetch the trade tape every tick for fill validation but throw away the flow information.

**Proposal**: Analyze the tape for order flow imbalance as a 6th signal layer (in addition to the existing 5-layer signal from Binance prices).

```
Recent tape (last 60s):
  up_buy_volume = sum of BUY trades on UP token
  dn_buy_volume = sum of BUY trades on DN token
  imbalance = (up_buy_volume - dn_buy_volume) / (up_buy_volume + dn_buy_volume + 1)

imbalance > +0.3: strong UP buying pressure → boost UP signal
imbalance < -0.3: strong DN buying pressure → boost DN signal
|imbalance| < 0.1: balanced → no adjustment
```

**Key insight**: This is a Polymarket-native signal. The Binance price signal tells us where the crypto price is going. The tape signal tells us what Polymarket participants believe the resolution will be. When they agree, conviction is high. When they diverge, caution.

**No extra API calls needed** — tape is already fetched for fill validation.

### 5. Conditional Entry Timing

**Problem**: All strategies enter as soon as they discover a market at window open. But the first 30 seconds often have no fill activity (market hasn't warmed up) and the opening price move can be misleading.

**Proposal**: Delay entry by 15-30 seconds with specific entry gates:

```
Wait to enter until ALL of:
  1. Tape shows >= 3 trades in last 30s (minimum liquidity)
  2. |upAsk - dnAsk| < 0.15 (spread isn't already lopsided)
  3. No price move > 0.3% in last 15s (not entering into a spike)
  4. At least 2 signal ticks available (enough data for momentum layer)
```

**Trade-off**: We miss the first 15-30s of fill opportunities. But we avoid the most dangerous entries (one-sided fills on opening momentum). Net positive for maker strategies, less important for sniper (which doesn't care about direction).

### 6. Window Overlap Exploitation

**Problem**: When 5min and 15min windows overlap on the same crypto, they share the same underlying price but resolve at different times. The 5min resolution provides free information for the remaining 15min window, but we currently ignore it.

**Proposal**: When a 5min window resolves while a 15min window is still open on the same symbol:

```
5min resolves UP → BTC was trending up in recent 5min
  - Boost UP conviction on 15min window
  - Tighten UP offset (more aggressive entry)
  - If 15min has one-sided DN inventory, consider selling (signal says UP)

5min resolves DOWN → opposite adjustments
```

**Subtlety**: The 5min resolution tells us about the last 5 minutes, not the next 10. A reversal is possible. Weight this signal at ~30% strength, not a hard override.

### 7. Resolution Front-Running (New Strategy Concept)

**Concept**: A new strategy type that only operates in the last 60-120 seconds before resolution, when the outcome is often deterministic.

```
120s before resolution:
  Fetch Binance price → compare to market threshold
  If price is >0.5% above threshold → outcome almost certainly UP
  If UP token ask < $0.92 → buy UP as taker (pay fee, but high expected value)

Expected value:
  If BTC is $84,500 and threshold is $84,000:
    P(UP) ≈ 0.95 (price needs to drop 0.6% in 2 minutes — unlikely)
    EV = 0.95 * ($1.00 - $0.92 - fee) = 0.95 * $0.02 = $0.019/share
    At 100 shares: ~$1.90 per window, ~$0.50 fee = ~$1.40 net

Risk: Sudden reversal in last 60s wipes the position.
Mitigation: Only enter when margin > 0.5%, stop-loss if margin drops < 0.2%.
```

**Key difference from existing strategies**: This is a taker strategy (pays fees) but only enters with very high confidence. It works because the wide ask spread ($0.99) isn't the entry point — we're buying at $0.85-$0.92 from sellers who don't realize the outcome is almost locked.

---

## Safe Maker

**File**: `worker/src/strategies/safe-maker.ts`

Conservative signal-biased maker that protects paired inventory. Clone of directional-maker with one key difference: never sells inventory that's part of a balanced pair.

### Recent Changes (March 15-16)

| Change | Details |
|--------|---------|
| **Volatility-adaptive offset** | `vol_offset_scale_high=1.5`, `vol_offset_scale_low=0.5` scales `bid_offset` by `signal.volatilityRegime` |
| **Time-decay tightening** | `tighten_start_pct=0.70` — offset decays linearly to 0 in last 30% of window for unfilled sides only |
| **Reluctant requoting** | `min_requote_delta=0.02` — won't cancel+replace unless new bid is at least 2c different |
| **Tape fill protection** | Checks trade tape before paper cancel in both flip and non-flip requote paths |
| **D1 immediate fill records** | All three immediate fill paths (UP, DN, wind-down) now write to `strategy_trades` |
| **Fee equivalent tracking** | `fee_amount` in D1 stores `calcFeePerShare * size` for rebate pool weighting |

### Adaptive Offset Flow

```
baseOffset (param: bid_offset = 0.02)
  → * volMultiplier (0.5 in low vol / 1.0 normal / 1.5 in high vol)
  → * timeDecay (1.0 → 0.0 in last 30% of window, unfilled sides only)
  → finalOffset
  → rawBid = fairValue - finalOffset
  → complementary cap: min(rawBid, max_pair_cost - otherSideAvgCost)
  → round to cents
  → skip requote if |newBid - currentBid| < min_requote_delta (0.02)
```

### Remaining Improvements

| # | Improvement | Status | Notes |
|---|------------|--------|-------|
| 1 | Inventory-aware asymmetric offsets | TODO | Currently binary cancel; should use continuous offset scaling |
| 2 | Fill rate feedback loop | TODO | Auto-tune offset from realized fill rates |
| 3 | Cross-asset momentum cascade | TODO | Use BTC lead-lag to pre-adjust ALT offsets |
| 4 | Multi-tier bids (2-3 levels) | TODO | Single bid per side currently |
| 5 | Per-crypto bid sizing | TODO | Uniform sizing; BTC has more liquidity |
| 6 | Conditional entry timing | TODO | Enters immediately on market discovery |

---

## Unified Adaptive Strategy

**File**: `worker/src/strategies/unified-adaptive.ts`

### How It Works (Execution Flow)

```
Every 5 seconds (tick):
  |
  1. DISCOVER MARKETS
  |   Poll Data API /trades for active "Up or Down" crypto markets
  |   Extract symbol, window timing, token IDs from titles
  |   Filter to target_cryptos (BTC, ETH, SOL, XRP)
  |
  2. UPDATE PRICE HISTORY
  |   Fetch spot prices (Binance REST, Coinbase fallback)
  |   Maintain 200-tick price history per symbol
  |
  3. MANAGE ACTIVE WINDOWS
  |   For each open window:
  |     a. Fetch spot price + compute 5-layer signal
  |     b. Check for fills (grounded: trade-tape matching, or legacy: probabilistic)
  |     c. Inventory safety: cancel bids on heavy side EVERY tick
  |     d. Rebalance: sell excess if ratio > max_unmatched_ratio (1.3x)
  |     e. If rebalance sold → poison window (stop all quoting)
  |     f. Update quotes if signal moved > requote_threshold (5%)
  |     g. Deferred upgrade: after 3+ ticks, if signal > 0.55, upgrade sniper → maker
  |     h. Wind-down: stop quoting 45s before end, sell unmatched 15s before end
  |
  4. ENTER NEW WINDOWS (if not winding down)
  |   For each market not already tracked:
  |     a. Compute signal + volatility regime
  |     b. Check ask imbalance gate (|upAsk - dnAsk| < 0.15)
  |     c. Check volatility favorability (skip trending markets)
  |     d. Check pair confidence gate (min_pair_confidence = 0.65)
  |     e. SELECT MODE:
  |        - Per-asset maker WR < 40% (5+ samples) → sniper
  |        - High volatility OR signal < 0.25 → sniper
  |        - 5-min window + strong signal → maker
  |        - 15-min+ window → sniper
  |        - Otherwise: signal >= 0.6 → maker, else sniper
  |     f. Compute bid size from fill bucket EMA (liquidity-based adaptive sizing)
  |     g. Check capital available (at-risk capital only; matched pairs don't count)
  |     h. Place initial bids on both UP and DOWN tokens
  |
  5. RESOLVE COMPLETED WINDOWS
  |   For windows past their end time:
  |     a. Cancel any remaining open orders
  |     b. Check market resolution (Gamma API, Binance fallback)
  |     c. Compute P&L: matched pairs (guaranteed profit) + unmatched (directional)
  |     d. Update fill bucket EMA for adaptive sizing
  |     e. Track per-asset win rate (sniper vs maker separately)
  |     f. Queue auto-redemption (2-min delay for Polymarket to mark redeemable)
  |
  6. PROCESS PENDING REDEEMS
  |   Retry queued redemptions (up to 10 attempts with backoff)
  |
  7. PERSIST STATE
     Sync capital_deployed and total_pnl to base framework
```

### Mode Selection Deep Dive

| Condition | Mode | Rationale |
|-----------|------|-----------|
| Asset maker WR < 40% (5+ samples) | sniper | Asset doesn't respond to signal well enough |
| High volatility regime | sniper | Volatile markets → spread capture safer than direction |
| Signal < 0.25 (weak) | sniper | No directional edge → capture spread both sides |
| 5-min + strong signal | maker | Short windows + signal → higher $/win ($5.77 vs $2.85) |
| 15-min+ | sniper | Longer = 100% win rate, safer |
| Otherwise, signal >= 0.6 | maker | Strong signal on medium duration |
| Otherwise, signal < 0.6 | sniper | Not enough conviction for directional bet |

### Adaptive Bid Sizing (Fill Bucket EMA)

Instead of fixed bid sizes, UA learns optimal sizing from observed fills:
1. Each (symbol, duration, mode) gets a "fill bucket" tracking avg match rate and fill count
2. After each window resolves, bucket is updated via EMA (alpha=0.3)
3. Next bid size = `lastBidSize * dampened(matchRate / targetRate)` with damping=0.5
4. Duration scaling: `min(1.0, windowDurationMin / 15)` — 5min=0.33x, 15min=1.0x
5. Bounded by [min_bid_size=10, max_bid_size=200]

### Key Safety Features (all implemented)

- **Ask imbalance gate**: Skip entry when |upAsk - dnAsk| > 0.15 (prevents one-sided fills)
- **Volatility favorability**: `computeSniperFavorability()` blocks trending markets, prefers oscillating
- **Per-tick inventory safety**: Cancel heavy-side bids every tick (not just on requote)
- **Max flip protection**: Stop quoting after 3+ direction flips per window (choppy = dangerous)
- **Rebalance poisoning**: After selling excess, stop all quoting to prevent buy→sell→buy churn
- **Pair confidence gate**: min_pair_confidence=0.65 — higher bar for window entry
- **Grounded fills**: Trade-tape matching from Data API (not probabilistic) — real price/size validation

### Balance & Drawdown (Base Framework)

All handled by `strategy.ts` — UA no longer has its own wallet system:
- **Ratchet lock**: Locks profits in tiers (`lock_increment_usd`). HWM/increment - 1 tiers locked.
- **Excess lock**: Profits above `max_capital_usd` are locked (strategy can't use more than it needs)
- **Proportional drawdown**: When balance drops below HWM, `max_capital_usd` scales proportionally. Floor at 25% capacity. Configured via `max_drawdown_pct` param.

### Recent Changes (March 16)

- **D1 immediate fill records**: UP and DN immediate fills in `makerUpdateQuotes` now write to `strategy_trades`
- **Fee equivalent tracking**: All 8 BUY D1 inserts (sniper real/paper UP/DN, maker paper UP/DN, maker immediate UP/DN) now store `calcFeePerShare * size` as `fee_amount`

### Remaining Improvements

| # | Improvement | Status | Notes |
|---|------------|--------|-------|
| 1 | Port adaptive repricing from safe-maker | TODO | UA has its own requoting system; could benefit from vol-adaptive offset, time-decay, reluctant requoting |
| 2 | Per-crypto bid sizing | TODO | Currently uniform; BTC has more liquidity than XRP |
| 3 | Multi-tier bids (2-3 price levels) | TODO | Currently single bid per side |
| 4 | Tape order flow signal | TODO | Tape already fetched; not analyzing buy/sell imbalance |
| 5 | Per-crypto conviction bias | TODO | Currently uniform 2.0x bias |
| 6 | Window overlap exploitation | TODO | 5min resolution could inform overlapping 15min window |

Previously proposed items that are now implemented:
- ~~Mode switching mid-window~~ → implemented as "deferred upgrade" (sniper→maker after 3 ticks if signal strengthens)
- ~~Hybrid timeframe strategy~~ → UA does this automatically via mode selection
- ~~Volatility regime switcher~~ → built into mode selection + favorability gate
- ~~Adaptive market maker~~ → deferred upgrade from sniper→maker is this concept
- ~~Cross-window capital optimization~~ → matched pairs excluded from capital-at-risk calculation

---

## Spread Sniper

**File**: `worker/src/strategies/spread-sniper.ts`

### How It Works (Execution Flow)

```
Every 5 seconds (tick):
  |
  1. DISCOVER MARKETS
  |   Same as UA: poll Data API for active crypto "Up or Down" markets
  |
  2. UPDATE PRICE HISTORY
  |   Fetch Binance/Coinbase spot prices, maintain 200-tick history
  |
  3. MANAGE ACTIVE WINDOWS
  |   For each open window:
  |     a. Fetch price + compute 5-layer signal (used for fill sim only, NOT direction)
  |     b. Check fills:
  |        - Paper: grounded (trade-tape) or probabilistic fair value model
  |        - Real: match against CLOB activity API trades
  |     c. INVENTORY SAFETY (every tick):
  |        - If UP excess > max_unmatched_ratio (1.3x) → cancel UP bid
  |        - If DN excess > max_unmatched_ratio → cancel DN bid
  |     d. REBALANCE:
  |        - If unmatched excess sits > 3 ticks → sell at best bid or limit
  |        - After rebalance sell → POISON window (stop all quoting)
  |     e. UPDATE QUOTES (if not poisoned):
  |        - Both sides get EQUAL bids at (0.50 - bid_offset) = 0.46
  |        - No directional bias — pure spread capture
  |        - Requote on signal/price move > threshold
  |     f. WIND-DOWN:
  |        - 5% of window duration before end: stop quoting
  |        - 1.7% before end: sell any unmatched inventory
  |
  4. ENTER NEW WINDOWS
  |   For each market not tracked:
  |     a. Check ask imbalance gate
  |     b. Check volatility favorability (computeSniperFavorability)
  |     c. Compute bid size: base_bid_size * min(1.0, durationMin/15)
  |     d. Place symmetric bids: both UP and DN at 0.46
  |
  5. RESOLVE COMPLETED WINDOWS
  |   Check resolution, compute P&L, record to D1
  |   matchedPairs * (1.00 - pairCost) = guaranteed profit per pair
```

### Core Principle: Pair Cost < 1.00 = Guaranteed Profit

```
Buy UP  at $0.46  (bid_offset = 0.04 from 0.50 midpoint)
Buy DN  at $0.46
──────────────────
Total pair cost:  $0.92
Payout at resolution: $1.00 (one side always wins)
Profit per pair:  $0.08 (8.7% return)
```

Direction doesn't matter. As long as both sides fill equally, every window is profitable.

### Improvements Status

| # | Original Suggestion | Status | Notes |
|---|---------------------|--------|-------|
| 1 | Fix maker fee calculation | DONE | Zero fee on resting bid fills |
| 2 | Timeframe-adaptive bid sizing | DONE | 5min=10, 15min=30 (scales with duration) |
| 3 | Increase bid size on 15-min | DONE | Configurable, tested at 15/30/60 |
| 4 | Dynamic bid offset by volatility | TODO | Not yet ported from safe-maker (sniper uses fixed neutral offset) |
| 5 | Per-crypto bid sizing | TODO | Uniform sizing currently |
| 6 | Smarter rebalance selling | DONE | Book-based sell pricing (best bid or limit), not fixed 0.48 |
| 7 | Multi-tier bid placement | TODO | Single bid per side |
| 8 | Window-end acceleration | TODO | Not yet ported from safe-maker (sniper uses fixed wind-down timing) |
| 9 | Skip low-liquidity time slots | TODO | No time-of-day awareness |
| 10 | Maker rebate tracking | DONE | fee_equivalent stored in D1 for all strategies |

Additional features implemented since original list:
- **Ask imbalance gate** (0.15 threshold) — prevents one-sided entry
- **Volatility favorability** — blocks trending markets, favors oscillating
- **Rebalance poisoning** — stops quoting after rebalance sell
- **Grounded fills** (trade-tape matching) — paper fills validated against real market data
- **Per-tick inventory safety** — cancels heavy-side bids every tick

---

## Directional Maker

**File**: `worker/src/strategies/directional-maker.ts`

### How It Works (Execution Flow)

```
Every 5 seconds (tick):
  |
  1. DISCOVER MARKETS + UPDATE PRICES
  |   Same as sniper/UA
  |
  2. MANAGE ACTIVE WINDOWS
  |   For each open window:
  |     a. Compute 5-layer signal → derive direction (UP or DOWN)
  |     b. Signal-derived fair value:
  |        fairUp  = 0.50 + signalStrength * amplitude * dirSign
  |        fairDn  = 1.00 - fairUp
  |        (amplitude = signal_amplitude param, default 0.20)
  |     c. Check fills against fair value (paper) or activity API (real)
  |     d. SET BID PRICES (conviction-biased):
  |        - BOTH sides always get bids (this is key!)
  |        - Conviction side: bid at fairValue - bid_offset
  |        - Non-conviction side: bid at fairValue - bid_offset
  |        - Conviction side: bid SIZE = base * conviction_bias (2x)
  |        - Non-conviction side: bid SIZE = base / conviction_bias (0.5x)
  |     e. ADAPTIVE REPRICING (new):
  |        - Volatility scaling: bid_offset * volMultiplier (0.5x/1.0x/1.5x)
  |        - Time-decay: offset → 0 in last 30% for unfilled sides
  |        - Reluctant requoting: skip if |newBid - oldBid| < 2c
  |        - Tape fill check before paper cancel
  |     f. INVENTORY SAFETY (every tick):
  |        - Cancel heavy-side bids if ratio > max_inventory_ratio
  |     g. DIRECTION CHANGE (hysteresis):
  |        - Dead zone prevents flips on < 0.02% moves
  |        - Track confirmedDirection, flipCount, lastDirectionChangeAt
  |        - After 3+ flips → stop quoting (market too choppy)
  |     h. WIND-DOWN: stop quoting 45s before end, exit 15s before end
  |
  3. ENTER NEW WINDOWS
  |   For each market not tracked:
  |     a. Compute signal → require signal strength > threshold
  |     b. Compute bid size: base_bid_size * min(1.0, durationMin/15)
  |     c. Set direction based on signal
  |     d. Place conviction-biased bids on both sides
  |
  4. RESOLVE COMPLETED WINDOWS
  |   Same as sniper: resolution check, P&L, D1 recording
```

### Why Both Sides Get Bids

The maker always bids both UP and DN. The "directional" part is in the *size bias*, not which side to bid:

```
Signal says UP:
  UP bid:   30 shares at $0.52  (conviction side: 2x size, higher fair value)
  DN bid:   8 shares at $0.44   (non-conviction: 0.5x size, lower fair value)

Matched pairs (min of both fills):
  8 matched pairs at ($0.52 + $0.44) = $0.96 → profit $0.04 * 8 = $0.32
  22 excess UP at $0.52 → directional bet on UP
```

So the maker gets:
1. **Guaranteed spread profit** from matched pairs (like sniper but smaller margin)
2. **Directional upside** from excess inventory (if signal is right, the excess pays $1.00 - cost)
3. **Directional risk** from excess inventory (if signal is wrong, excess → loss)

### Improvements Status

| # | Original Suggestion | Status | Notes |
|---|---------------------|--------|-------|
| 1 | Fix maker fee calculation | DONE | Zero fee on resting bid fills |
| 2 | Reduce signal amplitude for 5-min | PARTIAL | Uses configurable `signal_amplitude` (default 0.20); could auto-reduce for short windows |
| 3 | Increase bid size | DONE | Configurable, duration-scaled, tested at 15/30/60 |
| 4 | Dynamic bid offset by volatility | DONE | `vol_offset_scale_high=1.5`, `vol_offset_scale_low=0.5` |
| 5 | Window-end acceleration | DONE | `tighten_start_pct=0.70` — linear offset decay in last 30% for unfilled sides |
| 6 | Direction-aware rebalancing | DONE | Sells wrong-side excess, window poisoning on rebalance |
| 7 | Reluctant requoting | DONE | `min_requote_delta=0.02` — preserves queue priority |
| 8 | Hybrid timeframe strategy | DONE (via UA) | UA does this automatically via mode selection |
| 9 | Inventory-aware stop-quoting | PARTIAL | Per-tick inventory safety cancels heavy-side bids; stop-quoting is time-based |
| 10 | Flip-count-based sizing | DONE | `max_flips_per_window=3` stops quoting on choppy windows |

Additional features implemented since original list:
- **Grounded fills** (trade-tape matching) — real price/size validation for paper mode
- **Per-tick inventory safety** — cancel heavy-side bids every tick
- **Dead zone hysteresis** — prevents false direction flips on noise
- **Tape fill protection** — checks tape before paper cancel on requote
- **D1 immediate fill records** — all three immediate fill paths write to strategy_trades
- **Fee equivalent tracking** — fee_amount in D1 for rebate pool weighting

---

## Conviction Maker

**File**: `worker/src/strategies/conviction-maker.ts`

### How It Works

One-sided conviction bets. Only bids when signal > 0.60. No hedging, holds to resolution.

Key differences from directional-maker:
- Bids ONLY on conviction side (no hedge bids on the other side)
- Sits out when signal < min_signal_strength (0.60 default)
- No sell logic — holds to resolution
- Cross-asset lead-lag (BTC leads ALTs) via `computeLeadLagBonus()`
- Conviction scaling: stronger signal → larger position (0.60→36 units, 0.80→48, 1.00→60)

### Recent Changes (March 16)

- Tape fill check before paper cancel in requote path
- D1 records for immediate fills
- Fee equivalent tracking in all D1 inserts

### Remaining Improvements

| # | Improvement | Status | Notes |
|---|------------|--------|-------|
| 1 | Port adaptive repricing | TODO | No vol-adaptive offset or time-decay yet (simpler single-side requoting) |
| 2 | Dynamic conviction threshold by asset | TODO | Fixed 0.60 threshold; some assets need higher |
| 3 | Partial exit on signal weakening | TODO | Currently all-or-nothing hold to resolution |

---

## Directional Taker

**File**: `worker/src/strategies/directional-taker.ts`

### Status: NOT VIABLE

The taker strategy is fundamentally broken for Polymarket's "Up or Down" crypto markets because both sides have asks at $0.99, making any taker entry cost $0.99+ for a $1.00 payout — no edge.

This strategy remains in the codebase for reference but is not recommended for use.

---

## Split-Arb

**File**: `worker/src/strategies/split-arb.ts`

### Status: NOT VIABLE

No arbitrage opportunities exist in these markets. Combined asks never sum below $1.00 (typical: $1.78). The split-arb concept converges to the sniper strategy when using maker bids instead of sweeping asks.

---

## Bid Size Testing (March 11, 2026)

### A/B Test Configuration
| Config | Type | Bid Size | ID |
|--------|------|----------|----|
| Sniper 30 | spread-sniper | 30 (default) | strat-1773183830968 |
| Sniper 15 | spread-sniper | 15 | strat-1773197674394 |
| Sniper 60 | spread-sniper | 60 | strat-1773197671741 |
| Maker 30 | directional-maker | 30 (default) | strat-1773183830989 |
| Maker 15 | directional-maker | 15 | strat-1773197675815 |
| Maker 60 | directional-maker | 60 | strat-1773197673103 |

### Results (30 min of data, March 11 03:00-03:35 UTC)

| Strategy | PnL | Windows | $/window | Capital | ROC |
|----------|-----|---------|----------|---------|-----|
| Sniper 15 | $85.60 | 30 | $2.85 | $71 | 120% |
| Sniper 60 | $126.80 | 34 | $3.73 | $92 | 138% |
| Maker 15 | $58.57 | 33 | $1.77 | $66 | 89% |
| Maker 60 | $150.11 | 34 | $4.41 | $202 | 74% |

### Key Findings

1. **PnL per matched pair is deterministic**: `matched_shares * (1.00 - pair_cost)` = `matched * $0.08`
   - 15 shares: $1.20/window, 30: $2.40, 60: $4.80, 100: $8.00
   - Direction doesn't matter for matched pairs — all earn the spread

2. **The only way to lose is inventory imbalance**: Excess on the losing side = loss
   - Example: BTC UP=40/DN=20, DOWN wins -> 20 matched pairs profit ($1.60), 20 excess UP loses (-$10.40) = net -$8.80

3. **Sniper is more capital efficient**: 55% ROC vs 15% at small vs large bids
   - Sniper has 100% win rate (all windows balanced, zero sells needed)

4. **Maker earns more absolute PnL with larger bids**: 60s earns 2.5x more than 15s
   - But carries more directional risk from conviction bias
   - Conviction bias creates extreme asymmetry at small sizes: 7@$0.11 vs 26@$0.42

5. **Conviction bias is proportionally more destructive at smaller bid sizes**
   - Maker-15: reduced side gets 5-8 shares at $0.07-$0.22 (almost never fills)
   - Maker-60: reduced side gets 30 shares at $0.40 (still fills)

6. **Fee fix confirmed working**: pair cost dropped 0.927 -> 0.920 (zero fee on maker fills)

### Recommended Configuration
- **Sniper**: bid_size=60 for maximum PnL, or bid_size=15 for maximum capital efficiency
- **Maker**: base_bid_size=60 for best results. Avoid base_bid_size < 30 (conviction bias issues)
- **Best overall**: Unified-adaptive with default_bid_size=30 (liquidity EMA scales up automatically)

---

## Unified Adaptive — First Paper Run (March 11, 2026)

**First run: 7/7 windows profitable, $26.88 PnL from $500 initial (+5.4% in ~15 min)**

| Window | Asset | Mode | Matched | Net PnL | Bid Size |
|--------|-------|------|---------|---------|----------|
| 15min | BTC | sniper | 60 | $5.40 | 30 |
| 15min | ETH | sniper | 60 | $6.00 | 30 |
| 15min | SOL | sniper | 60 | $4.80 | 30 |
| 15min | XRP | sniper | 60 | $4.80 | 30 |
| 5min | BTC | sniper | 17 | $1.88 | 10 |
| 5min | SOL | sniper | 20 | $1.80 | 10 |
| 5min | ETH | sniper | 20 | $2.20 | 10 |

**Extended run (25 min)**: $500 -> $540.52 (+8.1%), 13/13 windows profitable, all sniper mode.
Key insight: Ramp-up lag from starting at bid_size=30 is the main drag vs standalone strategies.

---

## Real Trading Session (March 12, 2026) — Live Observations

### Problem: One-Sided Inventory is the #1 Loss Source

From ~60 resolved real-mode windows:
- **Balanced windows** (matched > 0): almost all profitable (+$0.80 to +$9.10 per window)
- **One-sided windows** (0/N or N/0): always lose $4-$6 each

Root cause: when the market moves directionally, one side's ask becomes cheap (the likely loser) and fills our bid, while the other side becomes expensive and never fills.

### Fixes Applied (March 12)

| Fix | Impact | Status |
|-----|--------|--------|
| **Tighter ask imbalance gate (0.30 -> 0.15)** | Prevents most one-sided fills | DONE |
| **Real-mode rebalance sells** — actual CLOB SELL orders | Exits one-sided inventory within 9 seconds | DONE |
| **Window poisoning after rebalance** | Prevents buy->sell->buy churn | DONE |
| **Sell failure handling** — poison on CLOB failure | Prevents infinite retry loops | DONE |
| **Entry confidence raised (0.50 -> 0.65)** | Fewer bad entries | DONE |
| **Bid size capped at 10** for real mode | Max single-fill loss ~$5 | DONE |
| **Sell unmatched timeout (5 -> 3 ticks)** | Limits one-sided exposure to ~9 seconds | DONE |
| **resolvingValue tracking** | UI "disappearing money" fix | DONE |
| **redeemValue formula fix** | Accurate "Redeeming" UI value | DONE |
| **Volatility scoring** | Blocks trending markets from entry | DONE |

### Results After Fixes

Before: 4 one-sided losses totaling -$20.30, 1 balanced win +$2.32
After: 6 wins totaling +$17.88, 1 loss -$4.80 — net +$13.08

---

## Known Bugs

| # | Bug | Observed | Severity |
|---|-----|----------|----------|
| 1 | **capital_deployed exceeds max_capital_usd** — multiple concurrent windows can exceed aggregate cap. UA fixes this by computing capital-at-risk (excluding matched pairs), but standalone strategies still have the issue. | 2026-03-11 | Medium |
| 2 | **P&L not recorded for open windows at stop** — open windows with inventory skip P&L computation on stop. Money is recoverable via manual redemption but P&L counter misses it. | 2026-03-11 | High |
| 3 | **Auto-redeem too early** — Polymarket needs ~2 min to mark redeemable. Fixed: deferred queue with 2-min delay and retry. | 2026-03-11 | Fixed |
| 4 | **CLOB sell fails with "not enough balance"** — mismatch between tracked fills and actual wallet holdings. Workaround: poison window on sell failure. | 2026-03-12 | Medium |
| 5 | **Nonce errors during batch redemption** — stale nonces after timeout-but-confirmed txns. Fixed: re-fetch nonce from chain after errors. | 2026-03-12 | Fixed |
