/**
 * Backtest v2 — replays strategies against recorded tape_buckets (real market WS data).
 *
 * Unlike v1 (which matched against BR's shadow_trades), this uses the SAME
 * data source as the live system: per-token per-second trade buckets from
 * the market WebSocket.
 *
 * Fill logic matches the live system:
 *   - For each second of a window, check each strategy bid against the bucket
 *   - If bucket.min_price <= bid.price → fill at bid.price (maker semantics)
 *   - Fill volume = min(bid.size, bucket.total_volume) — can't fill more than traded
 *   - After fill, immediately "replenish" (next bucket can fill the same level again)
 *   - Taker buys: if strategy has evaluateTaker(), check cheap sweeps / dip buys
 *   - Serialized per-second (same as live queue)
 */

import { getDb } from "../db.js";
import type { BidContext, BidLevel, BidStrategy } from "../strategies/index.js";
import { getStrategy } from "../strategies/index.js";

export interface BacktestV2Result {
  strategy: string;
  window_slug: string;
  outcome: string | null;
  duration_sec: number;
  // Fills
  maker_fills: number;
  taker_fills: number;
  total_fills: number;
  up_tokens: number;
  dn_tokens: number;
  up_avg_cost: number | null;
  dn_avg_cost: number | null;
  pair_cost: number | null;
  total_spend: number;
  // P&L
  merge_pairs: number;
  merge_pnl: number;
  redeem_pnl: number;
  net_pnl: number;
  // Capital
  starting_capital: number;
  peak_capital_used: number;
  mid_merges: number;
  mid_merge_usd: number;
  skipped_capital: number;
}

interface TapeBucket {
  token_id: string;
  bucket_ts: number;
  trade_count: number;
  total_volume: number;
  min_price: number;
  max_price: number;
  vwap: number;
  side_buy_volume: number;
  side_sell_volume: number;
}

interface WindowRow {
  slug: string;
  title: string | null;
  open_time: number;
  end_time: number;
  up_token_id: string;
  down_token_id: string;
  status: string;
  outcome: string | null;
}

export function backtestV2Window(
  strategyName: string,
  window: WindowRow,
  buckets: TapeBucket[],
  opts: { starting_capital?: number; merge_threshold?: number } = {},
): BacktestV2Result {
  const strategy = getStrategy(strategyName);
  strategy.clearWindowState?.(window.slug);

  const startCap = opts.starting_capital ?? 1e9;
  const mergeThreshold = opts.merge_threshold ?? 1.05;
  const durationSec = (window.end_time - window.open_time) / 1000;

  // Simulated state
  let upTokens = 0, dnTokens = 0;
  let upCostSum = 0, dnCostSum = 0;
  let totalSpend = 0;
  let availCap = startCap;
  let peakCap = 0;
  let midMerges = 0, midMergeUsd = 0, midMergePnl = 0;
  let makerFills = 0, takerFills = 0;
  let skippedCap = 0;
  let totalMergePairs = 0;

  // Build per-second timeline: group buckets by timestamp
  const tokenToSide = new Map<string, "UP" | "DOWN">();
  tokenToSide.set(window.up_token_id, "UP");
  tokenToSide.set(window.down_token_id, "DOWN");

  const bySecond = new Map<number, TapeBucket[]>();
  for (const b of buckets) {
    if (!bySecond.has(b.bucket_ts)) bySecond.set(b.bucket_ts, []);
    bySecond.get(b.bucket_ts)!.push(b);
  }
  const seconds = [...bySecond.keys()].sort((a, b) => a - b);

  // Track last-trade per token for strategy context
  const lastTrade = new Map<string, number>();

  for (const ts of seconds) {
    const secBuckets = bySecond.get(ts)!;
    const now = ts * 1000;
    const elapsed = (now - window.open_time) / (window.end_time - window.open_time);
    if (elapsed > 1.1) continue; // past window end

    // Update last-trade from this second's buckets
    for (const b of secBuckets) lastTrade.set(b.token_id, b.vwap);

    // Build strategy context
    const ctx: BidContext = {
      window_slug: window.slug,
      window_duration_sec: durationSec,
      elapsed_sec: (now - window.open_time) / 1000,
      elapsed_pct: elapsed,
      remaining_sec: Math.max(0, (window.end_time - now) / 1000),
      p_true: 0.50, // simplified — real replay would need spot+strike
      spot_price: 0,
      up_best_bid: null, up_best_ask: null, up_ask_size: null,
      up_last_trade: lastTrade.get(window.up_token_id) ?? null,
      dn_best_bid: null, dn_best_ask: null, dn_ask_size: null,
      dn_last_trade: lastTrade.get(window.down_token_id) ?? null,
      up_inventory: upTokens,
      up_avg_cost: upTokens > 0 ? upCostSum / upTokens : 0,
      dn_inventory: dnTokens,
      dn_avg_cost: dnTokens > 0 ? dnCostSum / dnTokens : 0,
      base_bid_size: 20,
      committed_capital: 0,
      effective_capital: availCap,
    };

    // Get maker bids from strategy
    const bids = strategy.compute(ctx);

    // Match bids against this second's buckets
    for (const bucket of secBuckets) {
      const side = tokenToSide.get(bucket.token_id);
      if (!side) continue;

      let remainingVol = bucket.total_volume;

      // Maker fills: check each bid level (sorted by price descending = best bid first)
      const matchingBids = bids
        .filter(b => b.side === side && bucket.min_price <= b.price && b.price > 0.005)
        .sort((a, b) => b.price - a.price);

      for (const bid of matchingBids) {
        if (remainingVol <= 0) break;
        const fillSize = Math.min(bid.size, remainingVol);
        const cost = bid.price * fillSize;

        if (availCap < cost + 1) { skippedCap++; continue; }

        remainingVol -= fillSize;
        availCap -= cost;
        totalSpend += cost;
        peakCap = Math.max(peakCap, startCap - availCap);
        makerFills++;

        if (side === "UP") { upTokens += fillSize; upCostSum += bid.price * fillSize; }
        else { dnTokens += fillSize; dnCostSum += bid.price * fillSize; }
      }

      // Taker evaluation (if strategy supports it)
      const strat = strategy as any;
      if (typeof strat.evaluateTaker === "function" && remainingVol > 0) {
        const signal = strat.evaluateTaker(ctx, bucket.vwap, remainingVol, "", bucket.token_id);
        if (signal?.shouldTake && signal.size >= 5) {
          const fillSize = Math.min(signal.size, remainingVol);
          const cost = bucket.vwap * fillSize;
          if (availCap >= cost + 1) {
            availCap -= cost;
            totalSpend += cost;
            peakCap = Math.max(peakCap, startCap - availCap);
            takerFills++;
            if (side === "UP") { upTokens += fillSize; upCostSum += bucket.vwap * fillSize; }
            else { dnTokens += fillSize; dnCostSum += bucket.vwap * fillSize; }
          }
        }
      }
    }

    // Mid-window merge
    if (upTokens >= 5 && dnTokens >= 5) {
      const upAvg = upCostSum / upTokens;
      const dnAvg = dnCostSum / dnTokens;
      const pc = upAvg + dnAvg;
      if (pc <= mergeThreshold) {
        const pairs = Math.min(upTokens, dnTokens);
        upTokens -= pairs; upCostSum -= upAvg * pairs;
        dnTokens -= pairs; dnCostSum -= dnAvg * pairs;
        availCap += pairs * 1.0;
        midMergePnl += pairs * (1.0 - pc);
        midMerges++;
        midMergeUsd += pairs;
        totalMergePairs += pairs;
      }
    }
  }

  strategy.clearWindowState?.(window.slug);

  // End-of-window: merge remaining + redeem
  const upAvg = upTokens > 0 ? upCostSum / upTokens : null;
  const dnAvg = dnTokens > 0 ? dnCostSum / dnTokens : null;
  const residualPairs = Math.min(upTokens, dnTokens);
  let endMergePnl = 0;
  if (residualPairs > 0 && upAvg != null && dnAvg != null) {
    endMergePnl = residualPairs * (1.0 - (upAvg + dnAvg));
    availCap += residualPairs;
    upTokens -= residualPairs;
    dnTokens -= residualPairs;
    totalMergePairs += residualPairs;
  }

  let redeemPnl = 0;
  const outcome = window.outcome as "UP" | "DOWN" | null;
  if (outcome === "UP" && upTokens > 0 && upAvg != null) {
    redeemPnl = upTokens * (1.0 - upAvg);
  } else if (outcome === "DOWN" && dnTokens > 0 && dnAvg != null) {
    redeemPnl = dnTokens * (1.0 - dnAvg);
  }

  // Weighted pair cost across all fills
  const totalUpTokens = makerFills > 0 || takerFills > 0 ? (upCostSum > 0 ? upTokens + totalMergePairs : 0) : 0;
  const allUpCost = upAvg; // simplified
  const allDnCost = dnAvg;
  const pairCost = (allUpCost != null && allDnCost != null) ? allUpCost + allDnCost : null;

  return {
    strategy: strategyName,
    window_slug: window.slug,
    outcome: outcome || (window.status === "RESOLVED" ? "UNKNOWN" : null),
    duration_sec: durationSec,
    maker_fills: makerFills,
    taker_fills: takerFills,
    total_fills: makerFills + takerFills,
    up_tokens: upTokens,
    dn_tokens: dnTokens,
    up_avg_cost: upAvg,
    dn_avg_cost: dnAvg,
    pair_cost: pairCost,
    total_spend: totalSpend,
    merge_pairs: totalMergePairs,
    merge_pnl: midMergePnl + endMergePnl,
    redeem_pnl: redeemPnl,
    net_pnl: midMergePnl + endMergePnl + redeemPnl,
    starting_capital: startCap,
    peak_capital_used: peakCap,
    mid_merges: midMerges,
    mid_merge_usd: midMergeUsd,
    skipped_capital: skippedCap,
  };
}

/** Run backtest v2 across all eligible windows with tape data. */
export function backtestV2All(
  strategyNames: string[],
  opts: { starting_capital?: number; merge_threshold?: number; only_resolved?: boolean } = {},
): BacktestV2Result[] {
  const db = getDb();

  let sql = `
    SELECT w.slug, w.title, w.open_time, w.end_time, w.up_token_id, w.down_token_id, w.status, w.outcome
    FROM windows w
    WHERE EXISTS (SELECT 1 FROM tape_buckets WHERE window_slug = w.slug)
  `;
  if (opts.only_resolved) sql += ` AND w.status = 'RESOLVED' AND w.outcome IS NOT NULL`;
  sql += ` ORDER BY w.open_time DESC`;

  const windows = db.prepare(sql).all() as WindowRow[];
  const bucketStmt = db.prepare(
    "SELECT token_id, bucket_ts, trade_count, total_volume, min_price, max_price, vwap, side_buy_volume, side_sell_volume FROM tape_buckets WHERE window_slug = ? ORDER BY bucket_ts"
  );

  const results: BacktestV2Result[] = [];
  for (const w of windows) {
    const buckets = bucketStmt.all(w.slug) as TapeBucket[];
    if (buckets.length < 5) continue; // not enough data

    for (const sname of strategyNames) {
      results.push(backtestV2Window(sname, w, buckets, opts));
    }
  }

  return results;
}

/** Summarize results by strategy. */
export function summarizeV2(results: BacktestV2Result[]): Array<{
  strategy: string; windows: number; total_fills: number; maker_fills: number; taker_fills: number;
  total_pnl: number; avg_pnl: number; win_rate: number; avg_pair_cost: number | null;
  avg_peak_cap: number; total_mid_merge: number;
}> {
  const byStrat = new Map<string, BacktestV2Result[]>();
  for (const r of results) {
    if (!byStrat.has(r.strategy)) byStrat.set(r.strategy, []);
    byStrat.get(r.strategy)!.push(r);
  }

  return [...byStrat.entries()].map(([strategy, arr]) => {
    const pcs = arr.map(r => r.pair_cost).filter((p): p is number => p != null);
    return {
      strategy,
      windows: arr.length,
      total_fills: arr.reduce((a, r) => a + r.total_fills, 0),
      maker_fills: arr.reduce((a, r) => a + r.maker_fills, 0),
      taker_fills: arr.reduce((a, r) => a + r.taker_fills, 0),
      total_pnl: arr.reduce((a, r) => a + r.net_pnl, 0),
      avg_pnl: arr.reduce((a, r) => a + r.net_pnl, 0) / arr.length,
      win_rate: arr.filter(r => r.net_pnl > 0).length / arr.length * 100,
      avg_pair_cost: pcs.length > 0 ? pcs.reduce((a, b) => a + b, 0) / pcs.length : null,
      avg_peak_cap: arr.reduce((a, r) => a + r.peak_capital_used, 0) / arr.length,
      total_mid_merge: arr.reduce((a, r) => a + r.mid_merge_usd, 0),
    };
  });
}
