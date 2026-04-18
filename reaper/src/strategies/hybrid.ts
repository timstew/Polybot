/**
 * hybrid — current default strategy (since April 12 findings).
 * max($0.50, P_true) both sides. Single-level, symmetric-at-open.
 */

import type { BidContext, BidLevel, BidStrategy } from "./types.js";

const HYBRID_FLOOR = 0.50;

export const hybrid: BidStrategy = {
  name: "hybrid",
  description: "max($0.50, P_true) both sides — current default; symmetric at open, follows market on winning side",

  compute(ctx: BidContext): BidLevel[] {
    const pCapped = Math.max(0.01, Math.min(0.99, ctx.p_true));
    const upFair = pCapped;
    const dnFair = 1 - pCapped;
    const upBid = Math.min(0.95, Math.max(HYBRID_FLOOR, upFair));
    const dnBid = Math.min(0.95, Math.max(HYBRID_FLOOR, dnFair));
    const size = Math.max(5, ctx.base_bid_size);

    return [
      { side: "UP", price: Math.floor(upBid * 100) / 100, size, level: 1 },
      { side: "DOWN", price: Math.floor(dnBid * 100) / 100, size, level: 1 },
    ];
  },

  getPhase(): string { return "HYBRID"; },
};
