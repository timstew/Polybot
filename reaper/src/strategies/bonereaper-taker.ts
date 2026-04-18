/**
 * bonereaper-taker — crosses the spread on winning side for maximum fill rate.
 *
 * Same as bonereaper-mimic v4 except:
 *   - Winning side L1 bids AT the best ask (taker cross) instead of AT last-trade
 *   - Accepts ~6.25% taker fee in exchange for filling on EVERY trade
 *   - Matches BR's "aggressive maker / taker" bucket (50% of their fills)
 *
 * Use this alongside bonereaper-mimic to A/B test:
 *   Does higher fill rate × taker fees > lower fill rate × zero maker fees?
 */

import type { BidContext, BidLevel, BidStrategy } from "./types.js";

interface WinState { activated: boolean; side: "UP" | "DOWN" }
const windowStates = new Map<string, WinState>();

const CERTAINTY_THRESHOLD = 0.65;

export const bonereaperTaker: BidStrategy = {
  name: "bonereaper-taker",
  description: "Winning side bids AT the ask (taker cross, ~6% fee) for max fill rate. Losing side stays maker. A/B test vs bonereaper-mimic.",

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

    // Anchors: winning side uses BEST ASK (taker cross), losing side uses last-trade
    const upAnchor = isUpWin
      ? (ctx.up_best_ask ?? ctx.up_last_trade ?? Math.max(0.50, pCapped))    // taker: AT the ask
      : (ctx.up_last_trade ?? Math.max(0.50, pCapped));                       // maker: at last trade
    const dnAnchor = isUpWin
      ? (ctx.dn_last_trade ?? Math.max(0.50, 1 - pCapped))                   // maker
      : (ctx.dn_best_ask ?? ctx.dn_last_trade ?? Math.max(0.50, 1 - pCapped)); // taker

    // L1: winning=AT anchor (ask for taker), losing=$0.005 below
    // L2: winning=$0.03 below, losing=$0.05 below
    // L3: winning=$0.08 below, losing=$0.15 below
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

      // For L1 (most aggressive = i===0): cap taker-side size to available ask depth.
      // Don't bid for more than what's offered at the ask — that would walk the book.
      if (i === 0) {
        if (isUpWin && ctx.up_ask_size != null) upSize = Math.min(upSize, Math.floor(ctx.up_ask_size));
        if (!isUpWin && ctx.dn_ask_size != null) dnSize = Math.min(dnSize, Math.floor(ctx.dn_ask_size));
      }

      if (elapsed > 0.70) {
        const mult = elapsed > 0.85 ? 5 : 3;
        if (state.activated) {
          if (state.side === "UP") {
            upSize = Math.floor(baseSize * mult);
            // Late taker: also cap at depth
            if (ctx.up_ask_size != null) upSize = Math.min(upSize, Math.floor(ctx.up_ask_size));
          } else {
            dnSize = Math.floor(baseSize * mult);
            if (ctx.dn_ask_size != null) dnSize = Math.min(dnSize, Math.floor(ctx.dn_ask_size));
          }
        }
      }

      const lightFirst = ctx.up_inventory <= ctx.dn_inventory;
      const addUp = () => { if (upPrice > 0.005) bids.push({ side: "UP", price: upPrice, size: upSize, level: lvl }); };
      const addDn = () => { if (dnPrice > 0.005) bids.push({ side: "DOWN", price: dnPrice, size: dnSize, level: lvl }); };
      if (lightFirst) { addUp(); addDn(); } else { addDn(); addUp(); }
    }

    // Taker sweep in final 10% (same as mimic — bid at ask, sized to depth)
    if (elapsed > 0.90 && state.activated) {
      const winningSide = state.side;
      const askPrice = winningSide === "UP" ? ctx.up_best_ask : ctx.dn_best_ask;
      const askDepth = winningSide === "UP" ? ctx.up_ask_size : ctx.dn_ask_size;
      if (askPrice != null && askPrice < 0.95) {
        const takerSize = Math.min(askDepth ?? baseSize * 5, baseSize * 5);
        if (takerSize >= 5) {
          bids.push({
            side: winningSide,
            price: Math.round(askPrice * 1000) / 1000,
            size: Math.floor(takerSize),
            level: LEVELS.length + 1,
          });
        }
      }
    }

    // Sweep catchers on losing side
    if (elapsed > 0.35) {
      if (state.activated) {
        const losingSide: "UP" | "DOWN" = state.side === "UP" ? "DOWN" : "UP";
        bids.push({ side: losingSide, price: 0.05, size: baseSize, level: LEVELS.length + 2 });
        bids.push({ side: losingSide, price: 0.01, size: baseSize, level: LEVELS.length + 3 });
      } else {
        bids.push({ side: "UP", price: 0.05, size: baseSize, level: LEVELS.length + 2 });
        bids.push({ side: "DOWN", price: 0.05, size: baseSize, level: LEVELS.length + 2 });
        bids.push({ side: "UP", price: 0.01, size: baseSize, level: LEVELS.length + 3 });
        bids.push({ side: "DOWN", price: 0.01, size: baseSize, level: LEVELS.length + 3 });
      }
    }

    // Inventory guard
    const totalTokens = ctx.up_inventory + ctx.dn_inventory;
    if (totalTokens >= 50) {
      const upRatio = ctx.up_inventory / totalTokens;
      const dnRatio = ctx.dn_inventory / totalTokens;
      if (upRatio > 0.90) {
        for (let i = bids.length - 1; i >= 0; i--) {
          if (bids[i].side === "UP" && bids[i].price > 0.10) bids.splice(i, 1);
        }
      }
      if (dnRatio > 0.90) {
        for (let i = bids.length - 1; i >= 0; i--) {
          if (bids[i].side === "DOWN" && bids[i].price > 0.10) bids.splice(i, 1);
        }
      }
    }

    return bids;
  },

  getPhase(ctx: BidContext): string {
    const e = ctx.elapsed_pct;
    const state = windowStates.get(ctx.window_slug);
    if (e > 0.90 && state?.activated) return `TAKE${state.side === "UP" ? "↑" : "↓"}`;
    if (state?.activated && e > 0.30) return `CROSS${state.side === "UP" ? "↑" : "↓"}`;
    if (e < 0.15) return "OPEN";
    if (e < 0.50) return "MID";
    return "LATE";
  },

  clearWindowState(slug: string): void { windowStates.delete(slug); },
};
