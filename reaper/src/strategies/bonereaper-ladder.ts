/**
 * bonereaper-ladder — the original multi-level DVB/P_true-following ladder.
 * Three-phase: deep value (P_true ≈ 0.5) → fair following → certainty loading.
 * Uses sticky certainty state and suppresses losing side late-window.
 */

import type { BidContext, BidLevel, BidStrategy } from "./types.js";

interface LadderState { activated: boolean; side: "UP" | "DOWN" }
const windowStates = new Map<string, LadderState>();

// Defaults borrowed from old PricingConfig
const DEEP_VALUE_PRICE = 0.15;
const CERTAINTY_THRESHOLD = 0.65;
const SUPPRESS_AFTER_PCT = 0.50;
const UNCERTAIN_RANGE = 0.10;
const LATE_SIZE_MULT = 2.0;
const DEFAULT_LADDER_LEVELS = 3;

export const bonereaperLadder: BidStrategy = {
  name: "bonereaper-ladder",
  description: "Multi-level ladder: deep-value → P_true-following → certainty-loading. Suppresses losing side late-window.",

  compute(ctx: BidContext): BidLevel[] {
    const elapsed = ctx.elapsed_pct;
    const isLateWindow = elapsed > SUPPRESS_AFTER_PCT;
    const pCapped = Math.max(0.01, Math.min(0.99, ctx.p_true));
    const isStrongUp = pCapped > CERTAINTY_THRESHOLD;
    const isStrongDn = pCapped < (1 - CERTAINTY_THRESHOLD);
    const upIsWinning = pCapped > 0.50;

    let state = windowStates.get(ctx.window_slug);
    if (!state) state = { activated: false, side: "UP" };

    if (isLateWindow && (isStrongUp || isStrongDn)) {
      state.activated = true;
      state.side = upIsWinning ? "UP" : "DOWN";
    } else if (state.activated && isLateWindow) {
      if ((state.side === "UP" && !upIsWinning) || (state.side === "DOWN" && upIsWinning)) {
        state.side = upIsWinning ? "UP" : "DOWN";
      }
    }
    windowStates.set(ctx.window_slug, state);

    const upFair = pCapped;
    const dnFair = 1 - pCapped;
    const deep = DEEP_VALUE_PRICE;
    const nLevels = DEFAULT_LADDER_LEVELS;

    const upPrices: number[] = [];
    const dnPrices: number[] = [];
    for (let i = 0; i < nLevels; i++) {
      const t = nLevels > 1 ? i / (nLevels - 1) : 1;
      upPrices.push(Math.min(0.95, deep + t * Math.max(0, upFair - deep)));
      dnPrices.push(Math.min(0.95, deep + t * Math.max(0, dnFair - deep)));
    }

    // Suppress losing side when certainty is on
    if (state.activated && isLateWindow) {
      if (state.side === "UP") dnPrices.fill(0);
      if (state.side === "DOWN") upPrices.fill(0);
    }

    // Heavy-side inventory suppression
    const totalTokens = ctx.up_inventory + ctx.dn_inventory;
    if (totalTokens >= 50) {
      const upRatio = ctx.up_inventory / totalTokens;
      const dnRatio = ctx.dn_inventory / totalTokens;
      if (upRatio > 0.9) upPrices.fill(0);
      if (dnRatio > 0.9) dnPrices.fill(0);
    }

    const bids: BidLevel[] = [];
    const lightSideFirst = ctx.up_inventory <= ctx.dn_inventory ? "UP" : "DOWN";

    for (let lvl = nLevels; lvl >= 1; lvl--) {
      const idx = lvl - 1;
      const upPrice = upPrices[idx];
      const dnPrice = dnPrices[idx];
      let size = Math.max(5, ctx.base_bid_size);

      if (state.activated && isLateWindow) {
        const isWinningSide = (upIsWinning && upPrice > 0) || (!upIsWinning && dnPrice > 0);
        if (isWinningSide) size = Math.floor(size * LATE_SIZE_MULT);
      }

      const addUp = () => { if (upPrice > 0) bids.push({ side: "UP", price: Math.floor(upPrice * 100) / 100, size, level: lvl }); };
      const addDn = () => { if (dnPrice > 0) bids.push({ side: "DOWN", price: Math.floor(dnPrice * 100) / 100, size, level: lvl }); };
      if (lightSideFirst === "UP") { addUp(); addDn(); } else { addDn(); addUp(); }
    }

    return bids;
  },

  getPhase(ctx: BidContext): string {
    const e = ctx.elapsed_pct;
    const isLate = e > SUPPRESS_AFTER_PCT;
    const isUncertain = ctx.p_true > (0.50 - UNCERTAIN_RANGE) && ctx.p_true < (0.50 + UNCERTAIN_RANGE);
    const state = windowStates.get(ctx.window_slug);
    if (state?.activated && isLate) return `LOAD${state.side === "UP" ? "↑" : "↓"}`;
    if (!isLate && isUncertain) return "DVB";
    return "STD";
  },

  clearWindowState(slug: string): void { windowStates.delete(slug); },
};
