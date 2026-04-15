/**
 * Three-Phase Bonereaper Pricing — computes bid prices for each ladder level.
 *
 * Phase 1 (Deep Value): early window, P_true near 0.50
 *   Both sides bid at deep_value_price ($0.15) → catches panic sellers
 *
 * Phase 2 (P_true Following): mid window, directional signal
 *   Bid at max(deep_value, P_true) per side → follows the market
 *
 * Phase 3 (Certainty Loading): late window, strong signal
 *   Suppress losing side entirely, 2x size on winning side
 *   Sticky: once activated, doesn't flip back on wobbles (only on full reversal past 0.50)
 */

import type { WindowRow } from "./window-manager.js";

export interface PricingConfig {
  deepValuePrice: number;       // default 0.15
  certaintyThreshold: number;   // default 0.65
  suppressAfterPct: number;     // default 0.50
  uncertainRange: number;       // default 0.10
  ladderLevels: number;         // 2-4
  lateSizeMult: number;         // default 2.0
  baseBidSize: number;          // from dynamic scaling
}

export interface BidLevel {
  side: "UP" | "DOWN";
  price: number;
  size: number;
  level: number;
}

// Per-window sticky state for certainty loading
const loadState = new Map<string, { activated: boolean; side: "UP" | "DOWN" }>();

/** Compute all bid levels for a window. */
export function computeBids(
  window: WindowRow,
  pTrue: number,
  config: PricingConfig,
): BidLevel[] {
  const now = Date.now();
  const windowDuration = window.end_time - window.open_time;
  const elapsedPct = (now - window.open_time) / windowDuration;
  const isLateWindow = elapsedPct > config.suppressAfterPct;
  const pCapped = Math.max(0.01, Math.min(0.99, pTrue));

  // Check certainty
  const isStrongUp = pCapped > config.certaintyThreshold;
  const isStrongDn = pCapped < (1 - config.certaintyThreshold);
  const isUncertain = pCapped > (0.50 - config.uncertainRange) && pCapped < (0.50 + config.uncertainRange);
  const upIsWinning = pCapped > 0.50;

  // Sticky certainty state
  let state = loadState.get(window.slug);
  if (!state) state = { activated: false, side: "UP" };

  if (isLateWindow && (isStrongUp || isStrongDn)) {
    state.activated = true;
    state.side = upIsWinning ? "UP" : "DOWN";
  } else if (state.activated && isLateWindow) {
    // Check for full reversal past 0.50
    if ((state.side === "UP" && !upIsWinning) || (state.side === "DOWN" && upIsWinning)) {
      state.side = upIsWinning ? "UP" : "DOWN";
    }
  }
  loadState.set(window.slug, state);

  // Generate ladder
  const upFair = pCapped;
  const dnFair = 1 - pCapped;
  const deep = config.deepValuePrice;
  const nLevels = config.ladderLevels;

  const upPrices: number[] = [];
  const dnPrices: number[] = [];
  for (let i = 0; i < nLevels; i++) {
    const t = nLevels > 1 ? i / (nLevels - 1) : 1;
    upPrices.push(Math.min(0.95, deep + t * Math.max(0, upFair - deep)));
    dnPrices.push(Math.min(0.95, deep + t * Math.max(0, dnFair - deep)));
  }

  // Apply certainty suppression
  if (state.activated && isLateWindow) {
    if (state.side === "UP") dnPrices.fill(0);
    if (state.side === "DOWN") upPrices.fill(0);
  }

  // Apply inventory suppression
  const totalTokens = window.up_inventory + window.down_inventory;
  if (totalTokens >= 50) { // skew guard min
    const upRatio = window.up_inventory / totalTokens;
    const dnRatio = window.down_inventory / totalTokens;
    if (upRatio > 0.9) upPrices.fill(0);
    if (dnRatio > 0.9) dnPrices.fill(0);
  }

  // Build bid levels (highest price first for fill priority)
  const bids: BidLevel[] = [];
  const lightSideFirst = window.up_inventory <= window.down_inventory ? "UP" : "DOWN";

  for (let lvl = nLevels; lvl >= 1; lvl--) {
    const idx = lvl - 1;
    const upPrice = upPrices[idx];
    const dnPrice = dnPrices[idx];
    let size = config.baseBidSize;

    // Late window size boost on winning side
    if (state.activated && isLateWindow) {
      const isWinningSide = (upIsWinning && upPrice > 0) || (!upIsWinning && dnPrice > 0);
      if (isWinningSide) size = Math.floor(size * config.lateSizeMult);
    }

    // Add light side first for balance
    if (lightSideFirst === "UP") {
      if (upPrice > 0) bids.push({ side: "UP", price: Math.floor(upPrice * 100) / 100, size, level: lvl });
      if (dnPrice > 0) bids.push({ side: "DOWN", price: Math.floor(dnPrice * 100) / 100, size, level: lvl });
    } else {
      if (dnPrice > 0) bids.push({ side: "DOWN", price: Math.floor(dnPrice * 100) / 100, size, level: lvl });
      if (upPrice > 0) bids.push({ side: "UP", price: Math.floor(upPrice * 100) / 100, size, level: lvl });
    }
  }

  return bids;
}

/** Get the current phase label for display. */
export function getPhaseLabel(window: WindowRow, pTrue: number, config: PricingConfig): string {
  const now = Date.now();
  const windowDuration = window.end_time - window.open_time;
  const elapsedPct = (now - window.open_time) / windowDuration;
  const isLate = elapsedPct > config.suppressAfterPct;
  const isUncertain = pTrue > (0.50 - config.uncertainRange) && pTrue < (0.50 + config.uncertainRange);

  const state = loadState.get(window.slug);
  if (state?.activated && isLate) return `LOAD${state.side === "UP" ? "↑" : "↓"}`;
  if (!isLate && isUncertain) return "DVB";
  return "STD";
}

/** Clear state for a resolved window. */
export function clearWindowState(slug: string): void {
  loadState.delete(slug);
}
