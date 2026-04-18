# Reaper Fill System

> How paper-mode fills are simulated, how real fills are captured, and how the
> two are kept from double-counting. Covers the Phase 1.1–1.4 changes plus the
> reprice-regression fix shipped April 18, 2026.
>
> For strategy behavior and BR comparison, see [BONEREAPER-ANALYSIS.md](../BONEREAPER-ANALYSIS.md).
> For roadmap context, see [ROADMAP.md](./ROADMAP.md).

---

## Fill Sources

Every fill records a `source` column for diagnostic attribution. The set:

| Source | Mode | Path | Maker? |
|---|---|---|---|
| `user_ws` | real | CLOB User WebSocket — authoritative fill events | from event |
| `immediate` | real | `placeOrder` response crossed the spread at placement | taker |
| `rest_reconcile` | real | 30s safety-net REST check against CLOB | maker |
| `cancel_fill` | real | Fill raced a cancel | maker |
| `paper_grounded` | paper | Market WS trade event hit a resting bid (or taker cross) | usually maker |
| `paper_shadow` | paper | BR (`shadow_wallet`) filled — we'd have filled too | maker |
| `paper_book` | paper | Our bid crossed the real best ask at check time | taker |

The sources disagree on semantics: `paper_shadow` mirrors BR's actual fills
(optimistic — assumes we'd have won the same queue slot); `paper_grounded`
watches real tape (more honest about queue position); `paper_book` is
"I definitely would have filled" (taker cross).

---

## Paper Fill Pipeline

```
Market WebSocket (primary)
  │
  ├─▶ onMarketTrade(event)  ── engine.ts
  │     │
  │     ├─ Inventory-guard skip (heavy-side throttle)
  │     ├─ For each OPEN order where price ≥ event.price:
  │     │    ├─ Consume trade volume (regardless of fill outcome)
  │     │    ├─ Queue-sim roll:  queueFillProbability(bid, trade)
  │     │    │    ├─ ≥1¢ better → 0.90
  │     │    │    ├─ sub-tick    → 0.60
  │     │    │    └─ tied        → 0.25
  │     │    └─ On hit → processReconcileFill(..., source=paper_grounded)
  │     ├─ evaluateTaker() → opportunistic taker buy (paper_grounded, isMaker=false)
  │     └─ Reprice stale bids: shouldRepriceOrder(bid, trade) — gap-only test
  │
Tick loop (every 5s) — gap-filler paths only run when WS is unhealthy
  │
  ├─▶ processShadowFills()  ── BR trades from shadow_trades table
  │     └─ bid ≥ BR's fill price → grant fill at BR's price (paper_shadow)
  │
  ├─▶ checkGroundedFills()  ── gated on marketWs.isConnected() == false
  │     │
  │     ├─ Fresh fetch from data-api/trades (no caching between calls)
  │     ├─ Filter by token/side/price/timestamp
  │     ├─ Per-(order, trade) dedup via evaluatedPairs Map (10-min TTL)
  │     └─ Queue-sim roll → paper_grounded at trade price
  │
  └─▶ checkPaperRestingFills() — CLOB book cross check
        └─ order.price ≥ bestAsk → fill at ask (paper_book, taker)

Every fill → processReconcileFill()  ── orders/fill-processor.ts
  ├─ isAlreadyRecorded(tradeId)?  DB INSERT OR IGNORE on fills.id
  ├─ ledger.recordFill() — order ledger PARTIAL/FILLED transition, VWAP
  └─ recordFillInDb() — fills row + inventory update (up_inventory, avg_cost,
                        peak_up_inventory, fill_count, total_buy_cost)
```

---

## Queue-Position Simulation (Phase 1.1)

**Problem:** paper fills assumed we filled on every trade that matched our
bid. Reality: Polymarket uses price-time priority. A brand-new paper bid
at the best level is at the back of the queue and fills only a fraction
of the time. Pre-Phase 1, paper P&L was 2–3× inflated.

**Model:** `src/orders/queue-sim.ts`

```ts
queueFillProbability(ourBid, tradePrice):
  ourBid < tradePrice         → 0    (no match possible)
  gap ≥ 1¢ (price-improved)   → 0.90  (price priority wins)
  gap > 0 but sub-tick        → 0.60  (probable lead)
  ourBid == tradePrice        → 0.25  (back of queue, shared with ~3-5 bids)
```

Applied in both the WS path (`engine.ts` `onMarketTrade`) and the tape
gap-filler (`grounded-fills.ts`). **Volume is consumed regardless of the
roll outcome** — if we miss, a competitor at the same level got the fill
and the seller walks on.

**Config knobs:**
- `queue_fill_sim` (`true`/`false`) — kill-switch; when false, every eligible
  trade fills us (old behavior, useful for A/B).
- `queue_fill_mult` (float, default `1.0`) — multiplies all probabilities.
  Tune after a 24h run: if `bun src/analysis/fill-compare.ts` shows our
  fill count well below 5–15% of BR's, bump mult up.

**Calibration helper:** `src/analysis/fill-compare.ts` reports per-window
and aggregate ratios of our fills vs BR's. Pre-fix baseline was 106.9%
fill count and 25.9% token ratio — over-filling by count, under-sized by
volume. Post-fix numbers settle toward realistic 5–15% fill-count for
small capital.

---

## Conservative Tape Gap-Fill (Phase 1.2 + 1.3)

Before: the tape poller ran every tick alongside the Market WS, each path
minting different `tradeId` schemes for the same underlying trade. Same
trade could produce two fills — one per path.

**Phase 1.2 fix:** tape poller is now a gap-filler. It runs only when
`marketWs.isConnected() === false`. Override available via `tape_always=true`
config for debugging. When it falls back, it logs a `TAPE_GAPFILL` activity
entry.

**Phase 1.3 fix:** the old `accumulatedTrades` buffer retained trades
for 2 minutes, so a trade at T=0 was still in the buffer at T=120s and
could fill bids placed much later. Now:

1. Fresh fetch per call — no caching.
2. Per-(order, trade) dedup: `evaluatedPairs: Map<string, number>` keyed by
   `{orderId}|{asset}|{price}|{size}|{ts}` with 10-minute TTL.
3. Each unique (order, trade) pair gets exactly **one** queue-sim roll,
   regardless of how many gap-fill invocations see the trade.

Rationale: without per-pair dedup, a queue-miss on one tick would become a
queue-hit on the next (re-rolled). Pair dedup means one roll per trade per
order — the correct probabilistic semantics.

---

## Taker Fees (Phase 1.4)

**Polymarket taker-fee formula** (crypto markets):

```
fee = price * (1 - price) * 0.0625 * size
```

Zero at the 0/1 extremes, peaks at $0.50, symmetric around 0.5, linear in
size. Exposed as `takerFee(price, size)` in `orders/fill-processor.ts`.

**Where it applies:**
- `processImmediateFill` — always taker (crossed spread at placement)
- `paper_book` — taker (bid crossed real ask)
- `evaluateTaker` opportunistic buys — taker (aggressive fill at trade price)
- `processReconcileFill(..., isMaker=false)` — taker, generic entry point

**Where it doesn't:**
- Resting maker fills via WS grounded (`paper_grounded` with default `isMaker=true`)
- Shadow fills (BR's fills, mostly maker per §10 of analysis)
- `user_ws` events carry their own `isMaker` flag

**P&L impact:** `resolveWindow` now queries `SUM(fee)` from `fills` and
subtracts it from `net_pnl`. Log line shows the breakdown:

```
[RESOLVE] slug-name UP net=$48.44 (fees=$1.56)
```

Before this change, `bonereaper-taker` vs `bonereaper-mimic` A/B was
meaningless — both looked free. Now `bonereaper-taker` correctly pays
for its higher fill rate.

---

## Reprice Regression Fix (April 18, 2026)

**Symptom:** window `btc-updown-5m-1776501300` had 3 DOWN bids at
$0.645/$0.60/$0.50 covering BR's cheap DOWN buys ($0.35–$0.64). All three
were cancelled with zero matched despite ≥40 covering trades.

**Root cause:** `engine.ts` reprice loop cancelled orders on two conditions:

```ts
if (gap > REPRICE_THRESHOLD || order.price > event.price) {
  cancelOrder(...)
}
```

The second clause (`order.price > event.price`) fired whenever we were
price-improved above the trade — i.e., the exact scenario where we were
most likely to fill.

Before queue-sim, this was fine: we **always** filled in that scenario, so
the cancel ran after the fill. After queue-sim landed, 30–40% of those
rolls miss. The cancel now fires on the misses, stranding the bid before
the next trade can hit it.

**Fix:** extracted `shouldRepriceOrder(orderPrice, eventPrice, threshold)`
as a pure, testable helper. Cancels only on absolute gap > threshold.
Uses tick-rounded (0.001) comparison to avoid FP noise at the 2¢ boundary.

Regression tests in `tests/engine.test.ts` cover the exact bug scenario
plus threshold edge cases.

---

## Dedup Defense-in-Depth

Every fill has three dedup layers:

1. **DB primary key on `fills.id` (tradeId)** — `INSERT OR IGNORE`.
   Final backstop; same tradeId can never produce two rows.
2. **`ledger.size_matched >= size * 0.99`** — short-circuit at fill time;
   already-filled orders stop accepting more.
3. **Per-(order, trade) pair tracking** (tape gap-fill only) — prevents
   repeated queue rolls for the same trade across invocations.

TradeId schemes differ per source:

| Source | TradeId |
|---|---|
| `user_ws` | from event |
| `immediate` | `imm-{clobOrderId}-{timestamp}` |
| `paper_grounded` (WS) | `ws-grounded-{clobOrderId}-{ts}-{price}` |
| `paper_grounded` (tape) | `grounded-{clobOrderId}-{asset}-{price}-{timestamp}` |
| `paper_shadow` | `shadow-{brTradeId}-{clobOrderId}` |
| `paper_book` | `book-{clobOrderId}` |
| `rest_reconcile` | `reconcile-{clobOrderId}-{now}` |

WS and tape use different schemes for the same underlying trade. Since the
tape path is now gated on WS health, overlap is rare. If overlap occurs
(WS briefly drops during a tape poll), the fill-layer dedup still catches
any genuine duplicate at insert time.

---

## Inventory Recalc (Fill-Processor Semantics)

On every fill:

- `up_inventory += size` (or `down_inventory`)
- `up_avg_cost` recomputed as volume-weighted average (VWAP):
  `(old_cost * old_inv + price * size) / (old_inv + size)`
- `peak_up_inventory = MAX(peak, up_inventory + size)` — HWM, never decays
- `fill_count += 1`
- `total_buy_cost += price * size`

Fees are recorded separately (`fills.fee`) and do **not** adjust
`avg_cost`. This keeps pair-cost math (`up_avg_cost + down_avg_cost`)
comparable across maker/taker fills. Fees are applied at window
resolution via `resolveWindow` instead.

---

## Test Coverage

| File | Scope |
|---|---|
| `tests/queue-sim.test.ts` | Probability tiers, multiplier clamping, empirical rate convergence |
| `tests/grounded-fills.test.ts` | Per-pair dedup across calls, queue-miss stickiness, kill-switch, side/price filtering |
| `tests/fill-processor.test.ts` | Taker-fee formula, 3 entry points, dedup, VWAP, partial→FILLED transition, fee-aware P&L |
| `tests/engine.test.ts` | `shouldRepriceOrder` invariants + bug-repro scenario |

Total: 47 tests directly covering the fill system. Full reaper suite:
168 pass / 0 fail as of April 18, 2026.

---

## Known Limitations / Follow-Ups

1. **Live calibration pending.** `queue_fill_mult` starts at 1.0 based on
   intuition. After 24h of paper running with the new engine, re-run
   `bun src/analysis/fill-compare.ts --since=24h` and tune.
2. **Merge threshold doesn't account for fees.** `merge_threshold_pc`
   defaults to $1.00. With taker fees, a pair at pc=$0.98 may still be
   a net loss post-fees. Adjust to `$1.00 - expected_fee_per_pair` once
   taker strategies see live use.
3. **`evaluateTaker` ctx uses approximate P_true.** The engine passes
   a flat 0.50 to save compute; a hybrid-maker-taker that depends on
   accurate P_true will make worse taker decisions than necessary.
4. **Shadow fills don't get queue-simmed.** BR fills are granted to us
   at BR's execution price with no probability discount. This is
   intentional (shadow mode is "what would we have done if we were BR?"),
   but means shadow P&L remains optimistic. Toggle off shadow mode
   (`paper_fill_modes=grounded`) to rely on the queue-simmed path.
5. **`bun --watch` dev mode disruption.** Each file save cancels all
   orders on restart. During active windows, expect brief fill gaps.
