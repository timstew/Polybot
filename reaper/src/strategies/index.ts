/**
 * Strategy registry — dispatches config.bid_strategy to the selected plugin.
 */

import { bonereaperMimic } from "./bonereaper-mimic.js";
import { bonereaperTaker } from "./bonereaper-taker.js";
import { bonereaperHybridMakerTaker } from "./bonereaper-hybrid-maker-taker.js";
import { bonereaperLadder } from "./bonereaper-ladder.js";
import { hybrid } from "./hybrid.js";
import type { BidStrategy } from "./types.js";

export type { BidStrategy, BidContext, BidLevel } from "./types.js";

const strategies: Record<string, BidStrategy> = {
  "hybrid": hybrid,
  "bonereaper": bonereaperLadder,
  "bonereaper-ladder": bonereaperLadder,
  "bonereaper-mimic": bonereaperMimic,
  "bonereaper-taker": bonereaperTaker,
  "bonereaper-hybrid": bonereaperHybridMakerTaker,
};

export function getStrategy(name: string): BidStrategy {
  const s = strategies[name];
  if (!s) throw new Error(`Unknown bid strategy: ${name}. Available: ${Object.keys(strategies).join(", ")}`);
  return s;
}

export function listStrategies(): Array<{ name: string; description: string }> {
  return Object.values(strategies).map(s => ({ name: s.name, description: s.description }));
}
