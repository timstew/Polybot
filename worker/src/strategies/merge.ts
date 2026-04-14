/**
 * CTF Merge — convert matched UP+DOWN pairs back to USDC.
 *
 * When upAvgCost + downAvgCost < 1.00, each matched pair pays $1 at resolution.
 * Merging realizes that profit immediately, freeing capital for new windows.
 *
 * Timing strategy:
 * - Default: merge once during wind-down (near window close)
 * - Early: merge mid-window only when capital is low (can't fund new windows)
 * - Fallback: any unmerged pairs get redeemed via cron sweep after resolution
 *
 * Paper mode: instant accounting.
 * Real mode: calls Cloud Run /api/merge/positions → on-chain CTF mergePositions.
 */

import type { StrategyContext } from "../strategy";

// ── Interfaces ──────────────────────────────────────────────────────

export interface MergeableWindow {
  upInventory: number;
  downInventory: number;
  upAvgCost: number;
  downAvgCost: number;
  market: { upTokenId: string; conditionId: string; title: string; slug?: string };
  cryptoSymbol: string;
}

export interface MergeResult {
  merged: number;
  pnl: number;
  pairCost: number;
}

// ── Core merge function ─────────────────────────────────────────────

/**
 * Merge all matched UP+DOWN pairs in a window.
 *
 * Mutates the window's inventory fields. Returns null if skipped
 * (no pairs, unprofitable).
 */
export async function tryMerge(
  ctx: StrategyContext,
  w: MergeableWindow,
  minPairs: number = 1,
): Promise<MergeResult | null> {
  // 1. Check matched pairs (floor to integer — CTF contract operates on whole tokens)
  const matched = Math.floor(Math.min(w.upInventory, w.downInventory));
  if (matched < minPairs) return null;

  // 2. Profitability check
  const pairCost = w.upAvgCost + w.downAvgCost;
  if (pairCost >= 1.0) return null;

  const pnl = matched * (1.0 - pairCost);

  // 3. Real mode: call on-chain merge
  if (ctx.config.mode === "real") {
    try {
      const result = await ctx.api.mergePositions(w.market.conditionId, matched);
      if (result.status !== "merged") {
        ctx.log(
          `MERGE FAILED: ${w.market.title.slice(0, 25)} ${matched} pairs — ${result.error || "unknown"}`,
          { level: "warning", symbol: w.cryptoSymbol }
        );
        return null;
      }
      ctx.log(
        `MERGE (on-chain): ${matched} pairs @ pc=${pairCost.toFixed(4)} → +$${pnl.toFixed(2)} tx=${result.tx_hash?.slice(0, 12) || "?"} ${result.duration_ms}ms`,
        { level: "trade", symbol: w.cryptoSymbol }
      );
    } catch (e) {
      ctx.log(
        `MERGE ERROR: ${w.market.title.slice(0, 25)} ${e}`,
        { level: "error", symbol: w.cryptoSymbol }
      );
      return null;
    }
  } else {
    ctx.log(
      `MERGE: ${matched} pairs @ pc=${pairCost.toFixed(4)} → +$${pnl.toFixed(2)}`,
      { level: "trade", symbol: w.cryptoSymbol }
    );
  }

  // 4. Mutate inventory
  w.upInventory = roundShares(w.upInventory - matched);
  w.downInventory = roundShares(w.downInventory - matched);

  // 5. Update global P&L
  ctx.state.total_pnl += pnl;

  // 6. D1 trade record
  try {
    await ctx.db.prepare(
      `INSERT INTO strategy_trades (id, strategy_id, token_id, side, price, size, fee_amount, pnl, timestamp)
       VALUES (?, ?, ?, 'MERGE', ?, ?, 0, ?, datetime('now'))`
    ).bind(
      `mrg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ctx.config.id, w.market.upTokenId, pairCost, matched, pnl,
    ).run();
  } catch { /* non-critical */ }

  return { merged: matched, pnl, pairCost };
}

/**
 * Check if capital pressure warrants an early merge across all windows.
 *
 * Returns true when available capital is too low to enter a new window.
 * Caller should then tryMerge() on windows with matched pairs.
 */
export function isCapitalPressured(
  ctx: StrategyContext,
  activeWindows: readonly MergeableWindow[],
  minBidCost: number,
): boolean {
  const maxCapital = ctx.config.max_capital_usd;
  const deployed = activeWindows.reduce(
    (sum, w) => sum + w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost, 0
  );
  const available = maxCapital - deployed;
  // Can't afford even one new window's pair of bids
  return available < minBidCost;
}

function roundShares(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
