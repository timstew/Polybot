# Strategy Improvements

> Last updated: March 13, 2026. Reflects current codebase state after unified balance protection, proportional drawdown, and grounded fills.

---

## Top 10 Most Impactful Remaining Improvements

These are the highest-leverage changes still TODO, ranked by expected impact.
Focus on unified-adaptive since it supersedes running sniper+maker in parallel.

| # | Improvement | Expected Impact | Status |
|---|------------|-----------------|--------|
| 1 | **Per-crypto bid sizing** — BTC=50, ETH=40, SOL=30, XRP=20 based on liquidity | +$2.00/window | TODO |
| 2 | **Dynamic bid offset by volatility** — widen in choppy, tighten in trending | +$1.50/window | TODO |
| 3 | **Multi-tier bids** — place 2-3 bids at different offsets (0.44, 0.46, 0.48) | +$1.25/window | TODO |
| 4 | **Per-crypto conviction bias** — XRP=2.5x, BTC=1.5x (tuned per asset alpha) | +$1.50/window (XRP) | TODO |
| 5 | **Window-end acceleration** — tighten offset in last 30% if still unmatched | +$0.80/window | TODO |
| 6 | **Momentum-based position sizing** — increase bias in strong trends, reduce in chop | +$2.00/window trending | TODO |
| 7 | **Adaptive pair cost by duration** — 5min=0.90, 15min=0.93, 60min=0.96 | +$1.50/window on 5min | TODO |
| 8 | **Higher default_bid_size (60)** — ramp-up lag is #1 drag on unified-adaptive | +$1.50/window avg | EVAL (liquidity EMA addresses this adaptively) |
| 9 | **Skip low-liquidity time slots** — track fill rates by hour | +5% win rate | TODO |
| 10 | **Maker rebate tracking** — 20% of taker fees as rebates, not modeled | +3% profit | TODO |

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

### Remaining Improvements

| # | Improvement | Status | Notes |
|---|------------|--------|-------|
| 1 | Per-crypto bid sizing | TODO | Currently uniform; BTC has more liquidity than XRP |
| 2 | Dynamic bid offset by volatility | TODO | Fixed offset (sniper=0.04, maker=0.02) |
| 3 | Multi-tier bids (2-3 price levels) | TODO | Currently single bid per side |
| 4 | Window-end acceleration | TODO | Could tighten offset in last 30% |
| 5 | Per-crypto conviction bias | TODO | Currently uniform 2.0x bias |
| 6 | Adaptive pair cost targets | TODO | Could start tight, loosen if fills slow |

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
| 4 | Dynamic bid offset by volatility | TODO | Still uses fixed 0.04 offset |
| 5 | Per-crypto bid sizing | TODO | Uniform sizing currently |
| 6 | Smarter rebalance selling | DONE | Book-based sell pricing (best bid or limit), not fixed 0.48 |
| 7 | Multi-tier bid placement | TODO | Single bid per side |
| 8 | Window-end acceleration | TODO | Could tighten offset in last 30% |
| 9 | Skip low-liquidity time slots | TODO | No time-of-day awareness |
| 10 | Maker rebate tracking | TODO | Not modeled in paper P&L |

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
  |     e. INVENTORY SAFETY (every tick):
  |        - Cancel heavy-side bids if ratio > max_inventory_ratio
  |     f. DIRECTION CHANGE (hysteresis):
  |        - Dead zone prevents flips on < 0.02% moves
  |        - Track confirmedDirection, flipCount, lastDirectionChangeAt
  |        - After 3+ flips → stop quoting (market too choppy)
  |     g. WIND-DOWN: stop quoting 45s before end, exit 15s before end
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

If both fill (paired):
  Cost: 30 * $0.52 + 30 * $0.44 = $28.80    → pair cost $0.96
  Wait... that's too expensive. Let's be precise:

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
| 4 | Per-crypto conviction strength | TODO | Uniform conviction_bias currently |
| 5 | Adaptive pair cost by duration | TODO | Fixed max_pair_cost |
| 6 | Direction-aware rebalancing | DONE | Sells wrong-side excess, window poisoning on rebalance |
| 7 | Momentum-based position sizing | TODO | Conviction bias is static, not momentum-reactive |
| 8 | Hybrid timeframe strategy | DONE (via UA) | UA does this automatically via mode selection |
| 9 | Inventory-aware stop-quoting | PARTIAL | Per-tick inventory safety cancels heavy-side bids; stop-quoting is time-based |
| 10 | Flip-count-based sizing | DONE | `max_flips_per_window=3` stops quoting on choppy windows |

Additional features implemented since original list:
- **Grounded fills** (trade-tape matching) — real price/size validation for paper mode
- **Per-tick inventory safety** — cancel heavy-side bids every tick
- **Dead zone hysteresis** — prevents false direction flips on noise

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
