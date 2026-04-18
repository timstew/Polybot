/**
 * bonereaper-hybrid-maker-taker — resting maker ladder + opportunistic taker buys.
 *
 * MAKER COMPONENT (from bonereaper-mimic):
 *   - 3-level ladder anchored at last-trade price
 *   - Winning side: zero offset (AT market), losing side: small offset
 *   - Sweep catchers at $0.05/$0.01
 *   - Size scales 5× late window
 *
 * TAKER COMPONENT (new):
 *   - Monitors real-time trade events via market WS
 *   - When a trade happens at a price we LIKE, immediately buy at that price
 *   - "Like" = losing side below a value threshold, or winning side at a good spread
 *   - Taker bids use level 10+ (separate from maker ladder levels 1-6)
 *   - Sized to available depth (from the trade event itself)
 *
 * The taker component is evaluated via shouldTake() — called from the engine's
 * onMarketTrade handler, not from the tick loop.
 */

import type { BidContext, BidLevel, BidStrategy } from "./types.js";

interface WinState { activated: boolean; side: "UP" | "DOWN" }
const windowStates = new Map<string, WinState>();

const CERTAINTY_THRESHOLD = 0.65;

// Taker thresholds — when to opportunistically cross
const TAKER_CHEAP_THRESHOLD = 0.25;  // buy losing side if trade < $0.25 (deep value)
const TAKER_WINNING_SPREAD = 0.02;   // buy winning side if trade < anchor - $0.02 (dip)

export interface TakerSignal {
  shouldTake: boolean;
  side: "UP" | "DOWN";
  price: number;
  size: number;
  reason: string;
}

export const bonereaperHybridMakerTaker: BidStrategy & {
  /** Evaluate whether to opportunistically take a trade event. Called from onMarketTrade. */
  evaluateTaker(ctx: BidContext, tradePrice: number, tradeSize: number, tradeSide: string, tradeTokenId: string): TakerSignal;
} = {
  name: "bonereaper-hybrid-maker-taker",
  description: "Resting maker ladder (zero-offset winning side) + opportunistic taker buys on attractive prices. Best of both worlds.",

  compute(ctx: BidContext): BidLevel[] {
    const elapsed = Math.max(0, Math.min(1.2, ctx.elapsed_pct));
    const pCapped = Math.max(0.05, Math.min(0.95, ctx.p_true));
    const upIsWinning = pCapped > 0.50;

    let state = windowStates.get(ctx.window_slug);
    if (!state) state = { activated: false, side: "UP" };
    if (elapsed > 0.30 && (pCapped > CERTAINTY_THRESHOLD || pCapped < 1 - CERTAINTY_THRESHOLD)) {
      state.activated = true;
      state.side = upIsWinning ? "UP" : "DOWN";
    }
    if (state.activated) {
      if (state.side === "UP" && pCapped < 0.40) state.side = "DOWN";
      if (state.side === "DOWN" && pCapped > 0.60) state.side = "UP";
    }
    windowStates.set(ctx.window_slug, state);

    const baseSize = Math.max(5, ctx.base_bid_size);
    const bids: BidLevel[] = [];
    const isUpWin = state.activated ? state.side === "UP" : upIsWinning;

    // ── MAKER LADDER (same as bonereaper-mimic) ──────────────
    const upAnchor = ctx.up_last_trade ?? Math.max(0.50, pCapped);
    const dnAnchor = ctx.dn_last_trade ?? Math.max(0.50, 1 - pCapped);

    const LEVELS: Array<{ winOffset: number; loseOffset: number }> = [
      { winOffset: 0.000, loseOffset: 0.005 },
      { winOffset: 0.03,  loseOffset: 0.05 },
      { winOffset: 0.08,  loseOffset: 0.15 },
    ];

    for (let i = 0; i < LEVELS.length; i++) {
      const lvl = LEVELS.length - i;
      const { winOffset, loseOffset } = LEVELS[i];
      const upOffset = isUpWin ? winOffset : loseOffset;
      const dnOffset = isUpWin ? loseOffset : winOffset;
      const upPrice = Math.round(Math.max(0.01, upAnchor - upOffset) * 1000) / 1000;
      const dnPrice = Math.round(Math.max(0.01, dnAnchor - dnOffset) * 1000) / 1000;

      let upSize = baseSize;
      let dnSize = baseSize;
      if (elapsed > 0.70) {
        const mult = elapsed > 0.85 ? 5 : 3;
        if (state.activated) {
          if (state.side === "UP") upSize = Math.floor(baseSize * mult);
          else dnSize = Math.floor(baseSize * mult);
        }
      }

      const lightFirst = ctx.up_inventory <= ctx.dn_inventory;
      const addUp = () => { if (upPrice > 0.005) bids.push({ side: "UP", price: upPrice, size: upSize, level: lvl }); };
      const addDn = () => { if (dnPrice > 0.005) bids.push({ side: "DOWN", price: dnPrice, size: dnSize, level: lvl }); };
      if (lightFirst) { addUp(); addDn(); } else { addDn(); addUp(); }
    }

    // Certainty sweeps: buy the SHORT side to complete pairs
    if (elapsed > 0.10) {
      const upInv = ctx.up_inventory;
      const dnInv = ctx.dn_inventory;
      const shortSide: "UP" | "DOWN" = upInv <= dnInv ? "UP" : "DOWN";
      const heavyInv = Math.max(upInv, dnInv);
      const lightInv = Math.min(upInv, dnInv);
      const heavyAvg = shortSide === "UP"
        ? (ctx.dn_inventory > 0 ? ctx.dn_avg_cost : 0.50)
        : (ctx.up_inventory > 0 ? ctx.up_avg_cost : 0.50);
      const pairingGap = Math.max(0, Math.floor(heavyInv - lightInv));
      if (pairingGap >= 5) {
        const maxSweepPrice = Math.round(Math.min(0.50, Math.max(0.01, 1.00 - heavyAvg)) * 1000) / 1000;
        const gapSize = Math.min(pairingGap, baseSize * 5);
        bids.push({ side: shortSide, price: maxSweepPrice, size: gapSize, level: LEVELS.length + 1 });
        if (maxSweepPrice > 0.10) bids.push({ side: shortSide, price: 0.10, size: gapSize, level: LEVELS.length + 2 });
        bids.push({ side: shortSide, price: 0.01, size: gapSize, level: LEVELS.length + 3 });
      }
    } else if (elapsed > 0.50 && !state.activated) {
      const upGap = Math.max(0, Math.floor(ctx.dn_inventory - ctx.up_inventory));
      const dnGap = Math.max(0, Math.floor(ctx.up_inventory - ctx.dn_inventory));
      if (upGap >= 5) bids.push({ side: "UP", price: 0.10, size: Math.min(upGap, baseSize), level: LEVELS.length + 1 });
      if (dnGap >= 5) bids.push({ side: "DOWN", price: 0.10, size: Math.min(dnGap, baseSize), level: LEVELS.length + 1 });
    }

    // ── LATE-WINDOW TAKER SWEEPS ──────────────────────────────────
    // After 70% elapsed, actively cross the spread for two purposes:
    //
    // 1. PAIR COMPLETION: buy the SHORT side at the ask to complete pairs.
    //    Merged pairs free capital to buy more certainty. Even at $0.30 ask,
    //    if heavy avg is $0.60, pair cost = $0.90 → $0.10 profit per merge.
    //
    // 2. CERTAINTY LOADING: buy the WINNING side at the ask to accumulate
    //    directional tokens that pay $1 at resolution. Only when pair cost
    //    would still be reasonable (ask + other side avg < merge threshold).
    //
    // Both are sized to available ask depth (never walk the book).
    if (elapsed > 0.70 && state.activated) {
      const upInv = ctx.up_inventory;
      const dnInv = ctx.dn_inventory;
      const winningSide = state.side;
      const shortSide: "UP" | "DOWN" = upInv <= dnInv ? "UP" : "DOWN";
      const pairingGap = Math.max(0, Math.floor(Math.abs(upInv - dnInv)));
      const heavyAvg = shortSide === "UP"
        ? (dnInv > 0 ? ctx.dn_avg_cost : 0.50)
        : (upInv > 0 ? ctx.up_avg_cost : 0.50);

      // 1. Pair completion taker: cross the ask on the SHORT side
      if (pairingGap >= 5) {
        const shortAsk = shortSide === "UP" ? ctx.up_best_ask : ctx.dn_best_ask;
        const shortAskSize = shortSide === "UP" ? ctx.up_ask_size : ctx.dn_ask_size;
        if (shortAsk != null && shortAsk > 0) {
          // Only take if the resulting pair cost is profitable (< $1.00)
          const projectedPairCost = heavyAvg + shortAsk;
          if (projectedPairCost < 1.00) {
            const takeSize = Math.min(
              pairingGap,
              Math.floor(shortAskSize ?? baseSize),
              baseSize * 5,
            );
            if (takeSize >= 5) {
              bids.push({
                side: shortSide,
                price: Math.round(shortAsk * 1000) / 1000,
                size: takeSize,
                level: LEVELS.length + 4, // above sweep levels, exempt from guard
              });
            }
          }
        }
      }

      // 2. Certainty loading taker: cross the ask on the WINNING side
      //    Only when we can still form profitable pairs afterward.
      //    Scale aggressively: 3× after 85%, 5× after 90%.
      const winAsk = winningSide === "UP" ? ctx.up_best_ask : ctx.dn_best_ask;
      const winAskSize = winningSide === "UP" ? ctx.up_ask_size : ctx.dn_ask_size;
      if (winAsk != null && winAsk > 0 && winAsk < 0.95) {
        // Check: if we buy winning at ask, can we still pair profitably?
        // Losing side would need to cost < (1.05 - winAsk) for a good pair.
        const loseAvg = winningSide === "UP"
          ? (dnInv > 0 ? ctx.dn_avg_cost : 0.50)
          : (upInv > 0 ? ctx.up_avg_cost : 0.50);
        const projectedPairCost = winAsk + loseAvg;

        // Take if pair cost < $1.00 (still profitable to pair)
        // OR if we're in the final 15% (pure directional play — unpaired winners pay $1)
        if (projectedPairCost < 1.00 || elapsed > 0.85) {
          const sizeMult = elapsed > 0.90 ? 5 : elapsed > 0.85 ? 3 : 1;
          const takeSize = Math.min(
            Math.floor((winAskSize ?? baseSize) * sizeMult),
            baseSize * 5,
          );
          if (takeSize >= 5) {
            bids.push({
              side: winningSide,
              price: Math.round(winAsk * 1000) / 1000,
              size: takeSize,
              level: LEVELS.length + 5,
            });
          }
        }
      }
    }

    // ── INVENTORY GUARD: suppress heavy side ladder bids ──────────
    // Two triggers (whichever hits first):
    //   1. Absolute: excess > baseSize on either side
    //   2. Ratio: heavy side > 2× light side (once we have meaningful inventory)
    // Sweeps (level 4+) are never suppressed — they fix the imbalance.
    const upInv2 = ctx.up_inventory;
    const dnInv2 = ctx.dn_inventory;
    const paired = Math.min(upInv2, dnInv2);
    const upExcess = upInv2 - paired;
    const dnExcess = dnInv2 - paired;
    const totalInv = upInv2 + dnInv2;

    let suppressUp = upExcess > baseSize;
    let suppressDn = dnExcess > baseSize;

    // Ratio guard: if one side is >2× the other (and we have at least baseSize total)
    if (totalInv >= baseSize) {
      if (upInv2 > dnInv2 * 2 && dnInv2 > 0) suppressUp = true;
      if (dnInv2 > upInv2 * 2 && upInv2 > 0) suppressDn = true;
      // Fully one-sided (0 on light side): suppress as soon as we have a full bid's worth
      if (upInv2 >= baseSize / 2 && dnInv2 === 0) suppressUp = true;
      if (dnInv2 >= baseSize / 2 && upInv2 === 0) suppressDn = true;
    }

    if (suppressUp) {
      for (let i = bids.length - 1; i >= 0; i--) { if (bids[i].side === "UP" && bids[i].level <= 3) bids.splice(i, 1); }
    }
    if (suppressDn) {
      for (let i = bids.length - 1; i >= 0; i--) { if (bids[i].side === "DOWN" && bids[i].level <= 3) bids.splice(i, 1); }
    }

    return bids;
  },

  /**
   * Evaluate whether to take a trade opportunistically.
   * Called from onMarketTrade for each WS event.
   *
   * Returns { shouldTake: true, price, size } when we want to buy at the event price.
   */
  evaluateTaker(ctx: BidContext, tradePrice: number, tradeSize: number, _tradeSide: string, tradeTokenId: string): TakerSignal {
    const noTake: TakerSignal = { shouldTake: false, side: "UP", price: 0, size: 0, reason: "" };
    const elapsed = ctx.elapsed_pct;
    const pCapped = Math.max(0.05, Math.min(0.95, ctx.p_true));

    const state = windowStates.get(ctx.window_slug);
    const isUpWin = state?.activated ? state.side === "UP" : pCapped > 0.50;
    const isUpToken = tradeTokenId === ctx.window_slug; // determined by caller

    // Determine which side this trade is on
    // (caller should set this based on token_id mapping — we use a placeholder)
    let tradeSideLabel: "UP" | "DOWN" = "UP";
    // The caller will match token_id to UP/DOWN — we just evaluate the price

    const baseSize = Math.max(5, ctx.base_bid_size);

    // ── Opportunity 1: Cheap losing-side sweep ───────────────
    // If trade is on the losing side at a deep-value price, TAKE IT.
    // This is how BR picks up $0.05-$0.15 tokens for near-free pair cost reduction.
    if (tradePrice <= TAKER_CHEAP_THRESHOLD && elapsed > 0.30) {
      return {
        shouldTake: true,
        side: tradeSideLabel, // caller fills this
        price: tradePrice,
        size: Math.min(tradeSize, baseSize * 3),
        reason: `cheap_sweep@$${tradePrice.toFixed(3)}`,
      };
    }

    // ── Opportunity 2: Winning-side dip ──────────────────────
    // If winning side just dipped below our anchor, take the dip.
    const anchor = isUpWin
      ? (ctx.up_last_trade ?? pCapped)
      : (ctx.dn_last_trade ?? 1 - pCapped);

    if (tradePrice < anchor - TAKER_WINNING_SPREAD && tradePrice > 0.10 && elapsed > 0.15) {
      return {
        shouldTake: true,
        side: tradeSideLabel,
        price: tradePrice,
        size: Math.min(tradeSize, baseSize * 2),
        reason: `dip_buy@$${tradePrice.toFixed(3)}_vs_anchor$${anchor.toFixed(3)}`,
      };
    }

    return noTake;
  },

  getPhase(ctx: BidContext): string {
    const e = ctx.elapsed_pct;
    const state = windowStates.get(ctx.window_slug);
    if (state?.activated && e > 0.85) return `TAKE${state.side === "UP" ? "↑" : "↓"}`;
    if (state?.activated && e > 0.70) return `SWEEP${state.side === "UP" ? "↑" : "↓"}`;
    if (state?.activated && e > 0.30) return `HYB${state.side === "UP" ? "↑" : "↓"}`;
    if (e < 0.15) return "OPEN";
    if (e < 0.50) return "MID";
    return "LATE";
  },

  clearWindowState(slug: string): void { windowStates.delete(slug); },
};
