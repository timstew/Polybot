/**
 * Backtest engine — simulates a bid strategy against recorded historical data.
 *
 * Method:
 *   - For each tick in window_ticks: ask the strategy for bids given that tick's state.
 *   - For each BR trade in shadow_trades between this tick and the next: if our bid
 *     on the same side is ≥ BR's price, we "would have gotten" that fill.
 *   - Track simulated inventory, pair cost, spend, and final P&L given window outcome.
 *
 * Assumptions / limitations:
 *   - Shadow-fill model: assumes BR's fill price is a valid market-clearing price.
 *     If BR paid $0.55 for UP, any bid ≥ $0.55 on UP in that tick would have filled too.
 *   - Does NOT model queue priority — real CLOB execution has queue effects that
 *     reduce fill rates, especially at small scale. Results are upper-bound.
 *   - Ignores capital constraints (simulates with effectively unlimited capital so
 *     the strategy's behavior is isolated from our live capital gate).
 *   - One fill per order per tick (approximates resting behavior).
 */

import { getDb } from "../db.js";
import type { BidContext, BidLevel, BidStrategy } from "../strategies/index.js";
import { getStrategy } from "../strategies/index.js";

export interface BacktestResult {
  strategy: string;
  window_slug: string;
  title: string | null;
  duration_min: number;
  outcome: "UP" | "DOWN" | "UNKNOWN" | null;
  // Simulated fills
  fill_count: number;
  skipped_fills_capital: number; // fills skipped due to capital constraint
  up_fills: number;
  dn_fills: number;
  up_tokens: number;              // after all merges
  dn_tokens: number;
  up_avg_cost: number | null;
  dn_avg_cost: number | null;
  pair_cost: number | null;
  total_spend: number;             // cumulative $ bought (gross)
  total_bought_tokens: number;    // cumulative tokens bought across both sides
  // P&L
  merge_pairs: number;             // total pairs merged (mid-window + end)
  merge_profit: number;
  redeem_tokens: number;
  redeem_profit: number;
  net_pnl: number;
  // Capital flow
  starting_capital: number;
  peak_capital_used: number;      // max (starting_capital - available_capital) over window
  min_available_capital: number;  // floor of available capital
  ending_capital: number;          // after all payouts
  mid_window_merges: number;      // count of mid-window merge events
  mid_window_merge_usd: number;   // $ recycled via mid-window merges
  // Timing
  first_fill_sec: number | null;
  last_fill_sec: number | null;
}

interface TickRow {
  timestamp: number;
  p_true: number | null;
  spot_price: number | null;
  up_best_bid: number | null;
  up_best_ask: number | null;
  up_ask_size: number | null;
  up_last_trade: number | null;
  dn_best_bid: number | null;
  dn_best_ask: number | null;
  dn_ask_size: number | null;
  dn_last_trade: number | null;
}

interface ShadowRow {
  timestamp: number;
  side: string;       // UP/DOWN/YES/NO/OTHER
  buy_sell: string;   // BUY/SELL
  price: number;
  size: number;
}

interface WindowRow {
  slug: string;
  title: string | null;
  open_time: number;
  end_time: number;
  status: string;
  outcome: string | null;
}

export interface BacktestOptions {
  starting_capital?: number;       // default unlimited (1e9)
  merge_threshold_pc?: number;     // merge when pair_cost <= this (default 1.00 — break even)
  merge_min_pairs?: number;        // min paired tokens to trigger merge (default 10)
  min_capital_for_fill?: number;   // skip fills when available < this (default 5)
}

/** Run a backtest for one strategy against one window. */
export function backtestWindow(
  strategyName: string,
  window: WindowRow,
  ticks: TickRow[],
  shadowTrades: ShadowRow[],
  opts: BacktestOptions = {},
): BacktestResult {
  const strategy = getStrategy(strategyName);
  strategy.clearWindowState?.(window.slug);

  const startingCapital = opts.starting_capital ?? 1e9;
  const mergeThresholdPC = opts.merge_threshold_pc ?? 1.00;
  const mergeMinPairs = opts.merge_min_pairs ?? 10;
  const minCapFill = opts.min_capital_for_fill ?? 5;

  const durationSec = (window.end_time - window.open_time) / 1000;

  // Simulated inventory + capital
  let upTokens = 0, dnTokens = 0;
  let upCostSum = 0, dnCostSum = 0; // token-weighted cost sums
  let totalSpend = 0;
  let totalBoughtTokens = 0;
  let availableCapital = startingCapital;
  let peakCapUsed = 0;
  let minAvailableCap = startingCapital;
  let midMergeCount = 0, midMergeUsd = 0;
  let midMergeProfit = 0;
  let totalMergePairs = 0;
  let skippedFillsCapital = 0;

  const fills: Array<{ ts: number; side: "UP" | "DOWN"; price: number; size: number }> = [];
  const consumed = new Set<number>();

  // Walk ticks in order
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i];
    if (tick.p_true == null) continue;

    const ctx: BidContext = {
      window_slug: window.slug,
      window_duration_sec: durationSec,
      elapsed_sec: (tick.timestamp - window.open_time) / 1000,
      elapsed_pct: (tick.timestamp - window.open_time) / (window.end_time - window.open_time),
      remaining_sec: Math.max(0, (window.end_time - tick.timestamp) / 1000),
      p_true: tick.p_true,
      spot_price: tick.spot_price || 0,
      up_best_bid: tick.up_best_bid, up_best_ask: tick.up_best_ask, up_ask_size: tick.up_ask_size as number | null ?? null, up_last_trade: tick.up_last_trade,
      dn_best_bid: tick.dn_best_bid, dn_best_ask: tick.dn_best_ask, dn_ask_size: tick.dn_ask_size as number | null ?? null, dn_last_trade: tick.dn_last_trade,
      up_inventory: upTokens,
      up_avg_cost: upTokens > 0 ? upCostSum / upTokens : 0,
      dn_inventory: dnTokens,
      dn_avg_cost: dnTokens > 0 ? dnCostSum / dnTokens : 0,
      base_bid_size: 25,
      committed_capital: 0,
      effective_capital: availableCapital,
    };

    const bids: BidLevel[] = strategy.compute(ctx);
    const tickEnd = i + 1 < ticks.length ? ticks[i + 1].timestamp : window.end_time;

    for (const bid of bids) {
      if (bid.price <= 0 || bid.size < 5) continue;
      for (let j = 0; j < shadowTrades.length; j++) {
        if (consumed.has(j)) continue;
        const tr = shadowTrades[j];
        if (tr.buy_sell !== "BUY") continue;
        if (tr.side !== bid.side) continue;
        if (tr.timestamp < tick.timestamp || tr.timestamp >= tickEnd) continue;
        if (tr.price > bid.price) continue;

        const fillSize = Math.min(bid.size, tr.size);
        const fillPrice = tr.price;
        const cost = fillPrice * fillSize;

        // Capital check — skip if insufficient
        if (availableCapital < cost + minCapFill) {
          skippedFillsCapital++;
          continue;
        }

        consumed.add(j);
        availableCapital -= cost;
        peakCapUsed = Math.max(peakCapUsed, startingCapital - availableCapital);
        minAvailableCap = Math.min(minAvailableCap, availableCapital);

        if (bid.side === "UP") { upTokens += fillSize; upCostSum += fillPrice * fillSize; }
        else { dnTokens += fillSize; dnCostSum += fillPrice * fillSize; }
        totalSpend += cost;
        totalBoughtTokens += fillSize;
        fills.push({ ts: tr.timestamp, side: bid.side, price: fillPrice, size: fillSize });
      }
    }

    // Mid-window merge: after each tick's fills, check if we can profitably merge
    if (upTokens >= mergeMinPairs && dnTokens >= mergeMinPairs) {
      const upAvg = upCostSum / upTokens;
      const dnAvg = dnCostSum / dnTokens;
      const pc = upAvg + dnAvg;
      if (pc <= mergeThresholdPC) {
        const pairs = Math.min(upTokens, dnTokens);
        // Remove pairs from both sides proportionally (keep avg cost for remaining)
        upTokens -= pairs; upCostSum -= upAvg * pairs;
        dnTokens -= pairs; dnCostSum -= dnAvg * pairs;
        // Merge returns $1.00 per pair
        const cashBack = pairs * 1.0;
        availableCapital += cashBack;
        const profit = pairs * (1.0 - pc);
        midMergeProfit += profit;
        midMergeCount++;
        midMergeUsd += cashBack;
        totalMergePairs += pairs;
      }
    }
  }

  strategy.clearWindowState?.(window.slug);

  // Residual inventory — redeem at window resolution
  const upAvgCost = upTokens > 0 ? upCostSum / upTokens : null;
  const dnAvgCost = dnTokens > 0 ? dnCostSum / dnTokens : null;
  // Residual still-paired tokens (in case threshold prevented final merge)
  const residualPairs = Math.min(upTokens, dnTokens);
  let endMergeProfit = 0;
  let endMergeCashBack = 0;
  if (residualPairs > 0 && upAvgCost != null && dnAvgCost != null) {
    endMergeProfit = residualPairs * (1.0 - (upAvgCost + dnAvgCost));
    endMergeCashBack = residualPairs * 1.0;
    availableCapital += endMergeCashBack;
    upTokens -= residualPairs; dnTokens -= residualPairs;
    totalMergePairs += residualPairs;
  }

  // Redeem remaining unpaired winning-side
  const outcome = window.outcome as "UP" | "DOWN" | null;
  let redeemTokens = 0;
  let redeemProfit = 0;
  if (outcome === "UP") {
    redeemTokens = upTokens;
    if (upAvgCost != null) redeemProfit = redeemTokens * (1.0 - upAvgCost);
    availableCapital += redeemTokens * 1.0;
  } else if (outcome === "DOWN") {
    redeemTokens = dnTokens;
    if (dnAvgCost != null) redeemProfit = redeemTokens * (1.0 - dnAvgCost);
    availableCapital += redeemTokens * 1.0;
  }

  let residualLoss = 0;
  if (outcome == null) {
    const upCost = upTokens * (upAvgCost || 0);
    const dnCost = dnTokens * (dnAvgCost || 0);
    residualLoss = -(upCost + dnCost) * 0.5;
  }

  const totalMergeProfit = midMergeProfit + endMergeProfit;
  const netPnl = totalMergeProfit + redeemProfit + residualLoss;

  const firstFillSec = fills.length > 0 ? (fills[0].ts - window.open_time) / 1000 : null;
  const lastFillSec = fills.length > 0 ? (fills[fills.length - 1].ts - window.open_time) / 1000 : null;

  // Original pair_cost before mid-window merges (report the *weighted* pair cost of all fills)
  const origUpCost = fills.filter(f => f.side === "UP").reduce((a, f) => a + f.price * f.size, 0);
  const origUpTok = fills.filter(f => f.side === "UP").reduce((a, f) => a + f.size, 0);
  const origDnCost = fills.filter(f => f.side === "DOWN").reduce((a, f) => a + f.price * f.size, 0);
  const origDnTok = fills.filter(f => f.side === "DOWN").reduce((a, f) => a + f.size, 0);
  const weightedUpAvg = origUpTok > 0 ? origUpCost / origUpTok : null;
  const weightedDnAvg = origDnTok > 0 ? origDnCost / origDnTok : null;
  const reportedPairCost = (weightedUpAvg != null && weightedDnAvg != null)
    ? weightedUpAvg + weightedDnAvg : null;

  return {
    strategy: strategyName,
    window_slug: window.slug,
    title: window.title,
    duration_min: Math.round(durationSec / 60),
    outcome: outcome || (window.status === "RESOLVED" ? "UNKNOWN" : null),
    fill_count: fills.length,
    skipped_fills_capital: skippedFillsCapital,
    up_fills: fills.filter(f => f.side === "UP").length,
    dn_fills: fills.filter(f => f.side === "DOWN").length,
    up_tokens: upTokens, dn_tokens: dnTokens,
    up_avg_cost: weightedUpAvg, dn_avg_cost: weightedDnAvg,
    pair_cost: reportedPairCost,
    total_spend: totalSpend,
    total_bought_tokens: totalBoughtTokens,
    merge_pairs: totalMergePairs,
    merge_profit: totalMergeProfit,
    redeem_tokens: redeemTokens,
    redeem_profit: redeemProfit,
    net_pnl: netPnl,
    starting_capital: startingCapital,
    peak_capital_used: peakCapUsed,
    min_available_capital: minAvailableCap,
    ending_capital: availableCapital,
    mid_window_merges: midMergeCount,
    mid_window_merge_usd: midMergeUsd,
    first_fill_sec: firstFillSec,
    last_fill_sec: lastFillSec,
  };
}

/** Run backtest for a list of strategies across all eligible windows. */
export function backtestAll(strategyNames: string[], opts: {
  min_ticks?: number;
  min_br_fills?: number;
  only_resolved?: boolean;
  starting_capital?: number;
  merge_threshold_pc?: number;
  merge_min_pairs?: number;
} = {}): Array<BacktestResult> {
  const minTicks = opts.min_ticks ?? 5;
  const minBr = opts.min_br_fills ?? 5;
  const db = getDb();

  // Find eligible windows — ones with tick data AND BR trade data
  let sql = `
    SELECT w.slug, w.title, w.open_time, w.end_time, w.status, w.outcome
    FROM windows w
    WHERE EXISTS (SELECT 1 FROM window_ticks WHERE window_slug = w.slug)
      AND EXISTS (SELECT 1 FROM shadow_trades WHERE window_slug = w.slug)
  `;
  if (opts.only_resolved) sql += ` AND w.status = 'RESOLVED' AND w.outcome IS NOT NULL`;
  sql += ` ORDER BY w.open_time DESC`;

  const windows = db.prepare(sql).all() as WindowRow[];

  const tickStmt = db.prepare(
    "SELECT timestamp, p_true, spot_price, up_best_bid, up_best_ask, up_last_trade, dn_best_bid, dn_best_ask, dn_last_trade FROM window_ticks WHERE window_slug = ? ORDER BY timestamp"
  );
  const shadowStmt = db.prepare(
    "SELECT timestamp, side, buy_sell, price, size FROM shadow_trades WHERE window_slug = ? AND buy_sell = 'BUY' ORDER BY timestamp"
  );

  const out: BacktestResult[] = [];
  for (const w of windows) {
    const ticks = tickStmt.all(w.slug) as TickRow[];
    const shadow = shadowStmt.all(w.slug) as ShadowRow[];
    if (ticks.length < minTicks || shadow.length < minBr) continue;

    const btOpts: BacktestOptions = {
      starting_capital: opts.starting_capital,
      merge_threshold_pc: opts.merge_threshold_pc,
      merge_min_pairs: opts.merge_min_pairs,
    };
    for (const sname of strategyNames) {
      out.push(backtestWindow(sname, w, ticks, shadow, btOpts));
    }
  }

  return out;
}

export interface StrategySummary {
  strategy: string;
  windows: number;
  total_fills: number;
  total_skipped_fills: number;
  total_spend: number;
  total_pnl: number;
  avg_pnl_per_window: number;
  avg_fills_per_window: number;
  avg_first_fill_sec: number;
  avg_pair_cost: number | null;
  win_rate_pct: number;
  avg_peak_capital: number;    // avg of peak_capital_used
  max_peak_capital: number;    // worst-case single window peak
  avg_mid_merges: number;      // avg mid-window merges per window
  total_mid_merge_usd: number; // total $ recycled via mid-window merge
}

export function summarizeByStrategy(results: BacktestResult[]): StrategySummary[] {
  const byStrat = new Map<string, BacktestResult[]>();
  for (const r of results) {
    if (!byStrat.has(r.strategy)) byStrat.set(r.strategy, []);
    byStrat.get(r.strategy)!.push(r);
  }
  const out: StrategySummary[] = [];
  for (const [strategy, arr] of byStrat) {
    const totalFills = arr.reduce((a, r) => a + r.fill_count, 0);
    const totalSpend = arr.reduce((a, r) => a + r.total_spend, 0);
    const totalPnl = arr.reduce((a, r) => a + r.net_pnl, 0);
    const pcs = arr.map(r => r.pair_cost).filter((p): p is number => p != null);
    const firstFills = arr.map(r => r.first_fill_sec).filter((s): s is number => s != null);
    const skipped = arr.reduce((a, r) => a + r.skipped_fills_capital, 0);
    const peakCaps = arr.map(r => r.peak_capital_used);
    const midMerges = arr.map(r => r.mid_window_merges);
    const midMergeUsd = arr.reduce((a, r) => a + r.mid_window_merge_usd, 0);
    out.push({
      strategy,
      windows: arr.length,
      total_fills: totalFills,
      total_skipped_fills: skipped,
      total_spend: totalSpend,
      total_pnl: totalPnl,
      avg_pnl_per_window: totalPnl / arr.length,
      avg_fills_per_window: totalFills / arr.length,
      avg_first_fill_sec: firstFills.length > 0 ? firstFills.reduce((a, b) => a + b, 0) / firstFills.length : 0,
      avg_pair_cost: pcs.length > 0 ? pcs.reduce((a, b) => a + b, 0) / pcs.length : null,
      win_rate_pct: arr.length > 0
        ? arr.filter(r => r.net_pnl > 0).length / arr.length * 100 : 0,
      avg_peak_capital: peakCaps.reduce((a, b) => a + b, 0) / peakCaps.length,
      max_peak_capital: Math.max(...peakCaps),
      avg_mid_merges: midMerges.reduce((a, b) => a + b, 0) / midMerges.length,
      total_mid_merge_usd: midMergeUsd,
    });
  }
  return out;
}
