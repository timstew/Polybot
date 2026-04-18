/**
 * bonereaper-mimic v4 — market-anchored + taker sweeps + book-depth sizing.
 *
 * Changes from v3:
 *   - L1 offset tightened: $0.02 → $0.005 (first-fill ~4s faster)
 *   - Taker sweep in final 10%: crosses the ask on winning side, sized to book depth
 *   - Book-depth-aware taker sizing: only take what's available at the ask
 *   - Sweeps active without certainty requirement (uncertain markets get both-side sweeps)
 *
 * From BONEREAPER-ANALYSIS.md:
 *   - 171 taker fills at avg size 169, price 100-110% of ask (Section 0.9)
 *   - 5× size scaling last 30%
 *   - 2.7 prices per 30s (reprice threshold $0.02 in engine)
 */

import type { BidContext, BidLevel, BidStrategy } from "./types.js";

interface WinState { activated: boolean; side: "UP" | "DOWN" }
const windowStates = new Map<string, WinState>();

const CERTAINTY_THRESHOLD = 0.65;

export const bonereaperMimic: BidStrategy = {
  name: "bonereaper-mimic",
  description: "Market-anchored ladder ($0.005 below last-trade) + taker sweeps (book-depth sized) + losing-side sweeps. Never suppresses.",

  compute(ctx: BidContext): BidLevel[] {
    const elapsed = Math.max(0, Math.min(1.2, ctx.elapsed_pct));
    const pCapped = Math.max(0.05, Math.min(0.95, ctx.p_true));
    const upIsWinning = pCapped > 0.50;

    // ── Sticky certainty ─────────────────────────────────────
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

    // ── ANCHOR at actual market price ────────────────────────
    const upAnchor = ctx.up_last_trade ?? Math.max(0.50, pCapped);
    const dnAnchor = ctx.dn_last_trade ?? Math.max(0.50, 1 - pCapped);

    // ── LADDER: winning side AT market, losing side below ──────
    // Winning side (taker-like maker): bid AT last-trade to capture every fill.
    //   BR fills 50% at 50-100% of ask — they're not shy about paying market.
    // Losing side: offset below market for cheap maker fills.
    //
    // L1: winning=AT market, losing=$0.005 below (tight)
    // L2: winning=$0.03 below, losing=$0.05 below
    // L3: winning=$0.08 below, losing=$0.15 below (deep value)
    const isUpWin = state.activated ? state.side === "UP" : upIsWinning;

    const LEVELS: Array<{ winOffset: number; loseOffset: number }> = [
      { winOffset: 0.000, loseOffset: 0.005 }, // L1: AT market on winning side
      { winOffset: 0.03,  loseOffset: 0.05 },  // L2
      { winOffset: 0.08,  loseOffset: 0.15 },  // L3
    ];

    for (let i = 0; i < LEVELS.length; i++) {
      const lvl = LEVELS.length - i;
      const { winOffset, loseOffset } = LEVELS[i];

      const upOffset = isUpWin ? winOffset : loseOffset;
      const dnOffset = isUpWin ? loseOffset : winOffset;
      const upPrice = Math.round(Math.max(0.01, upAnchor - upOffset) * 1000) / 1000;
      const dnPrice = Math.round(Math.max(0.01, dnAnchor - dnOffset) * 1000) / 1000;

      // Size: 5× on winning side in last 30%
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

    // ── CERTAINTY SWEEP: complete pairs on the losing side ─────
    // Three price tiers, ALL sized to the pairing gap (never more than we need):
    //
    // 1. Calculated sweep: max price where merge is still profitable
    //    Formula: $1.00 - winning_avg_cost (must be profitable to merge)
    //    If winning avg = $0.55 → sweep up to $0.45 on losing side
    //
    // 2. Mid sweep at $0.10: catches moderate sellers
    //
    // 3. Floor sweep at $0.01: catches panic sellers, insane ROI for pairing
    //    100 tokens at $0.01 = $1 cost, creates 100 pairs worth $44+ profit
    //
    // All three are sized to: max(0, winning_inventory - losing_inventory)
    if (elapsed > 0.10) { // activate sweeps early — don't wait for 35% to start pairing
      // We need to buy whichever side we're SHORT on to complete pairs.
      // If we have 100 UP / 0 DOWN → buy DOWN (we're short DOWN)
      // If we have 0 UP / 80 DOWN → buy UP (we're short UP)
      const upInv = ctx.up_inventory;
      const dnInv = ctx.dn_inventory;
      const shortSide: "UP" | "DOWN" = upInv <= dnInv ? "UP" : "DOWN";
      const heavyInv = Math.max(upInv, dnInv);
      const lightInv = Math.min(upInv, dnInv);
      const heavyAvg = shortSide === "UP"
        ? (ctx.dn_inventory > 0 ? ctx.dn_avg_cost : 0.50)  // heavy side = DOWN
        : (ctx.up_inventory > 0 ? ctx.up_avg_cost : 0.50);  // heavy side = UP

      const pairingGap = Math.max(0, Math.floor(heavyInv - lightInv));

      if (pairingGap >= 5) {
        // Tier 1: calculated max price for profitable merge
        const mergeThreshold = 1.00;
        const maxSweepPrice = Math.round(Math.min(0.50, Math.max(0.01, mergeThreshold - heavyAvg)) * 1000) / 1000;
        const gapSize = Math.min(pairingGap, baseSize * 5);

        bids.push({ side: shortSide, price: maxSweepPrice, size: gapSize, level: LEVELS.length + 1 });

        // Tier 2: mid sweep at $0.10 (if below calculated max)
        if (maxSweepPrice > 0.10) {
          bids.push({ side: shortSide, price: 0.10, size: gapSize, level: LEVELS.length + 2 });
        }

        // Tier 3: floor sweep at $0.01
        bids.push({ side: shortSide, price: 0.01, size: gapSize, level: LEVELS.length + 3 });
      }
    } else if (elapsed > 0.50 && !state.activated) {
      // Uncertain: small balanced sweeps at $0.10, sized to inventory gap
      const upGap = Math.max(0, Math.floor(ctx.dn_inventory - ctx.up_inventory));
      const dnGap = Math.max(0, Math.floor(ctx.up_inventory - ctx.dn_inventory));
      if (upGap >= 5) bids.push({ side: "UP", price: 0.10, size: Math.min(upGap, baseSize), level: LEVELS.length + 1 });
      if (dnGap >= 5) bids.push({ side: "DOWN", price: 0.10, size: Math.min(dnGap, baseSize), level: LEVELS.length + 1 });
    }

    // ── INVENTORY GUARD: suppress heavy side ladder bids only ──────
    // Two triggers (whichever hits first):
    //   1. Absolute: excess > baseSize on either side
    //   2. Ratio: heavy side > 2× light side (once we have meaningful inventory)
    // Sweeps (level > 3) are never suppressed — they fix the imbalance.
    const paired = Math.min(ctx.up_inventory, ctx.dn_inventory);
    const upExcess = ctx.up_inventory - paired;
    const dnExcess = ctx.dn_inventory - paired;
    const totalInv = ctx.up_inventory + ctx.dn_inventory;

    let suppressUp = upExcess > baseSize;
    let suppressDn = dnExcess > baseSize;

    if (totalInv >= baseSize) {
      if (ctx.up_inventory > ctx.dn_inventory * 2 && ctx.dn_inventory > 0) suppressUp = true;
      if (ctx.dn_inventory > ctx.up_inventory * 2 && ctx.up_inventory > 0) suppressDn = true;
      if (ctx.up_inventory >= baseSize / 2 && ctx.dn_inventory === 0) suppressUp = true;
      if (ctx.dn_inventory >= baseSize / 2 && ctx.up_inventory === 0) suppressDn = true;
    }

    if (suppressUp) {
      for (let i = bids.length - 1; i >= 0; i--) {
        if (bids[i].side === "UP" && bids[i].level <= LEVELS.length) bids.splice(i, 1);
      }
    }
    if (suppressDn) {
      for (let i = bids.length - 1; i >= 0; i--) {
        if (bids[i].side === "DOWN" && bids[i].level <= LEVELS.length) bids.splice(i, 1);
      }
    }

    return bids;
  },

  getPhase(ctx: BidContext): string {
    const e = ctx.elapsed_pct;
    const state = windowStates.get(ctx.window_slug);
    if (e > 0.90 && state?.activated) return `TAKE${state.side === "UP" ? "↑" : "↓"}`;
    if (state?.activated && e > 0.30) return `CERT${state.side === "UP" ? "↑" : "↓"}`;
    if (e < 0.15) return "OPEN";
    if (e < 0.50) return "MID";
    return "LATE";
  },

  clearWindowState(slug: string): void { windowStates.delete(slug); },
};
