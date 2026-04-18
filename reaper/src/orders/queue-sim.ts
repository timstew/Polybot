/**
 * Queue-position fill probability for paper fills.
 *
 * When a real trade clears at `tradePrice`, a paper resting bid at
 * `ourBid >= tradePrice` may or may not have been "our" fill in the real
 * market. Price-time priority determines queue position:
 *
 *   - ourBid strictly better (≥1¢) than tradePrice → we'd lead the queue
 *     (seller would have hit us first) → high fill prob
 *   - ourBid sub-tick better than tradePrice → still probable lead
 *   - ourBid == tradePrice → shared with N competitors at the level, new
 *     paper order is back-of-queue → low prob
 *
 * Constants are calibrated so paper fill counts roughly match what BR
 * achieves at similar pricing. Live tuning via `queue_fill_mult` config.
 * Bypass entirely with `queue_fill_sim=false`.
 */

const PRICE_STEP = 0.01;

export const PROB_PRICE_IMPROVEMENT = 0.90;
export const PROB_SUBTICK_IMPROVEMENT = 0.60;
export const PROB_TIED_AT_LEVEL = 0.25;

export function queueFillProbability(ourBid: number, tradePrice: number): number {
  if (ourBid < tradePrice - 1e-9) return 0;
  const gap = ourBid - tradePrice;
  if (gap >= PRICE_STEP - 1e-9) return PROB_PRICE_IMPROVEMENT;
  if (gap > 1e-9) return PROB_SUBTICK_IMPROVEMENT;
  return PROB_TIED_AT_LEVEL;
}

let randomFn: () => number = Math.random;

export function setRandom(fn: () => number): void {
  randomFn = fn;
}

export function resetRandom(): void {
  randomFn = Math.random;
}

export function rollForFill(probability: number, multiplier = 1.0): boolean {
  const p = Math.max(0, Math.min(1, probability * multiplier));
  return randomFn() < p;
}
