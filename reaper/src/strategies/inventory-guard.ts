/**
 * Sliding-ratchet inventory guard — tiered suppression of the heavy side
 * as skew grows, replacing the binary 90% cutoff.
 *
 * Tiers (based on heavy-side share of total matched inventory):
 *   0–50%:  none          — balanced, full ladder both sides
 *   50–75%: halve-top     — top-of-ladder bid on heavy side gets half size
 *   75–90%: deepest-only  — drop top/mid levels on heavy; keep deepest (cheap) bid
 *   90%+:   full          — suppress heavy side entirely
 *
 * Price index convention (matches ladder/pricing.ts): `prices[0]` is the
 * deepest (cheapest) level; `prices[length-1]` is the top (closest to fair).
 *
 * Ported from polybot `babyboner.ts` HWM inventory logic.
 */

export type SuppressionLevel = "none" | "halve-top" | "deepest-only" | "full";

export interface GuardResult {
  up: SuppressionLevel;
  dn: SuppressionLevel;
  heavyPct: number;
  reason: string;
}

export function computeSkewGuard(
  upInv: number,
  dnInv: number,
  minTriggerInv: number,
): GuardResult {
  const total = upInv + dnInv;
  if (total < minTriggerInv) return { up: "none", dn: "none", heavyPct: 0, reason: "below-trigger" };

  const upPct = upInv / total;
  const dnPct = dnInv / total;
  const heavyPct = Math.max(upPct, dnPct);
  const heavyIsUp = upPct >= dnPct;

  let level: SuppressionLevel;
  let reason: string;
  if (heavyPct < 0.50) { level = "none"; reason = "balanced"; }
  else if (heavyPct < 0.75) { level = "halve-top"; reason = "skew-50-75"; }
  else if (heavyPct < 0.90) { level = "deepest-only"; reason = "skew-75-90"; }
  else { level = "full"; reason = "skew-90+"; }

  return heavyIsUp
    ? { up: level, dn: "none", heavyPct, reason }
    : { up: "none", dn: level, heavyPct, reason };
}

/**
 * Apply a suppression level to a price/size ladder in place.
 * `prices[0]` must be the deepest level; `prices[last]` the top.
 */
export function applyGuardToLadder(
  prices: number[],
  sizes: number[],
  level: SuppressionLevel,
  minSize = 5,
): void {
  if (prices.length === 0) return;
  const topIdx = prices.length - 1;
  switch (level) {
    case "none":
      return;
    case "halve-top":
      sizes[topIdx] = Math.max(minSize, Math.floor(sizes[topIdx] / 2));
      return;
    case "deepest-only":
      for (let i = 1; i < prices.length; i++) prices[i] = 0;
      return;
    case "full":
      prices.fill(0);
      return;
  }
}
