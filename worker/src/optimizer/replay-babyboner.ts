/**
 * BabyBoneR replay engine — offline parameter optimization.
 *
 * Reuses BoneStar's recorded snapshots (same markets, same tick data).
 * Different replay logic: fixed-offset pricing, sell logic, wind-down.
 *
 * Usage:
 *   import { replayBabyBoneRWindow, BABYBONER_SEARCH_SPACE } from "./replay-babyboner";
 *   const result = replayBabyBoneRWindow(snapshot, params);
 */

import type { WindowSnapshot, ReplayResult, TickSnapshot, TapeBucket } from "./types";
import { volumeAtOrBelow, checkBucketFill } from "./replay";
import { calcFeePerShare, CRYPTO_FEES, type FeeParams } from "../categories";

// ── Search Space ────────────────────────────────────────────────────

export interface BabyBoneRReplayParams {
  target_pair_cost: number;
  winning_share: number;
  maker_bid_size: number;
  taker_bid_size: number;
  taker_ask_discount: number;
  sell_profit_threshold: number;
  sell_size: number;
  sell_min_price: number;
  wind_down_seconds: number;
  fire_sale_seconds: number;
  fire_sale_min_price: number;
  max_inventory_per_side: number;
  max_total_cost: number;
  p_true_min_conviction: number;
  fee_params: FeeParams;
}

export const DEFAULT_REPLAY_PARAMS: BabyBoneRReplayParams = {
  target_pair_cost: 0.99,
  winning_share: 0.72,
  maker_bid_size: 10,
  taker_bid_size: 5,
  taker_ask_discount: 0.05,
  sell_profit_threshold: 0.05,
  sell_size: 10,
  sell_min_price: 0.10,
  wind_down_seconds: 180,
  fire_sale_seconds: 30,
  fire_sale_min_price: 0.03,
  max_inventory_per_side: 500,
  max_total_cost: 200,
  p_true_min_conviction: 0.55,
  fee_params: CRYPTO_FEES,
};

export interface SearchParam {
  name: string;
  type: "continuous" | "integer";
  min: number;
  max: number;
}

export const BABYBONER_SEARCH_SPACE: SearchParam[] = [
  { name: "target_pair_cost", type: "continuous", min: 0.90, max: 0.99 },
  { name: "winning_share", type: "continuous", min: 0.60, max: 0.80 },
  { name: "maker_bid_size", type: "integer", min: 3, max: 30 },
  { name: "taker_bid_size", type: "integer", min: 3, max: 20 },
  { name: "taker_ask_discount", type: "continuous", min: 0.01, max: 0.15 },
  { name: "sell_profit_threshold", type: "continuous", min: 0.02, max: 0.20 },
  { name: "sell_size", type: "integer", min: 3, max: 30 },
  { name: "wind_down_seconds", type: "integer", min: 60, max: 300 },
  { name: "fire_sale_seconds", type: "integer", min: 10, max: 60 },
  { name: "max_inventory_per_side", type: "integer", min: 100, max: 1000 },
  { name: "max_total_cost", type: "integer", min: 50, max: 500 },
  { name: "p_true_min_conviction", type: "continuous", min: 0.52, max: 0.65 },
];

// ── Replay Result (extended) ────────────────────────────────────────

export interface BabyBoneRReplayResult extends ReplayResult {
  takerBuys: number;
  makerBuys: number;
  sellRevenue: number;
  resolutionPnl: number;
  windDownSells: number;
}

// ── Replay Function ─────────────────────────────────────────────────

export function replayBabyBoneRWindow(
  snap: WindowSnapshot,
  params: BabyBoneRReplayParams,
): BabyBoneRReplayResult {
  let upInventory = 0;
  let downInventory = 0;
  let upAvgCost = 0;
  let downAvgCost = 0;
  let totalBuyCost = 0;
  let realizedSellPnl = 0;
  let mergePnl = 0;
  let fillCount = 0;
  let sellCount = 0;
  let takerBuys = 0;
  let makerBuys = 0;
  let windDownSells = 0;
  let bidPlacementCount = 0;

  // Bid tracking for fill simulation
  let upBidPrice = 0;
  let upBidSize = 0;
  let upBidPlacedAt = 0; // tick index when placed
  let upVolumeAtPlacement = 0;
  let downBidPrice = 0;
  let downBidSize = 0;
  let downBidPlacedAt = 0;
  let downVolumeAtPlacement = 0;

  const wDurMs = snap.windowEndTime - snap.windowOpenTime;

  // Helper: record buy fill
  function recordBuy(side: "UP" | "DOWN", size: number, price: number, isTaker: boolean) {
    const fee = isTaker ? calcFeePerShare(price, params.fee_params) * size : 0;
    const costBasis = price + (isTaker ? fee / size : 0);

    if (side === "UP") {
      if (upInventory > 0) {
        const total = upAvgCost * upInventory + costBasis * size;
        upInventory += size;
        upAvgCost = total / upInventory;
      } else {
        upInventory = size;
        upAvgCost = costBasis;
      }
    } else {
      if (downInventory > 0) {
        const total = downAvgCost * downInventory + costBasis * size;
        downInventory += size;
        downAvgCost = total / downInventory;
      } else {
        downInventory = size;
        downAvgCost = costBasis;
      }
    }
    totalBuyCost += costBasis * size;
    fillCount++;
    if (isTaker) takerBuys++; else makerBuys++;
  }

  // Helper: record sell fill
  function recordSell(side: "UP" | "DOWN", size: number, price: number) {
    const fee = calcFeePerShare(price, params.fee_params) * size;
    const revenue = price * size - fee;
    const avgCost = side === "UP" ? upAvgCost : downAvgCost;
    const pnl = revenue - avgCost * size;

    if (side === "UP") {
      upInventory = Math.max(0, Math.round((upInventory - size) * 1e6) / 1e6);
    } else {
      downInventory = Math.max(0, Math.round((downInventory - size) * 1e6) / 1e6);
    }
    realizedSellPnl += pnl;
    sellCount++;
  }

  // Helper: merge profitable pairs
  function tryMerge() {
    const matched = Math.min(upInventory, downInventory);
    if (matched <= 0) return;
    const pairCost = upAvgCost + downAvgCost;
    if (pairCost >= 1.0) return;
    mergePnl += matched * (1.0 - pairCost);
    upInventory = Math.round((upInventory - matched) * 1e6) / 1e6;
    downInventory = Math.round((downInventory - matched) * 1e6) / 1e6;
  }

  for (let tickIdx = 0; tickIdx < snap.ticks.length; tickIdx++) {
    const tick = snap.ticks[tickIdx];
    const now = tick.t;
    const timeRemaining = snap.windowEndTime - now;
    const timeLeftSec = Math.max(0, timeRemaining / 1000);

    // Use recorded P_true if available, else approximate from fair values
    const pTrue = tick.pTrue ?? tick.fairUp;
    const upWinning = pTrue > 0.50;

    // ── Wind-down: sell inventory, no buying ────────────────────
    if (timeLeftSec < params.wind_down_seconds) {
      // Cancel all bids
      upBidPrice = 0; upBidSize = 0;
      downBidPrice = 0; downBidSize = 0;

      // Sell each side
      for (const side of ["UP", "DOWN"] as const) {
        const tokens = side === "UP" ? upInventory : downInventory;
        if (tokens <= 0) continue;
        const marketPrice = side === "UP" ? pTrue : (1 - pTrue);

        if (timeLeftSec < params.fire_sale_seconds) {
          // Fire sale: check if bids exist in book above our floor
          const sellPrice = Math.max(params.fire_sale_min_price, marketPrice * 0.50);
          const bookBids = side === "UP" ? tick.upBookAsks : tick.downBookAsks;
          // In fire sale, we'll try to sell all — simulate as best-effort
          // Check book bids (we sell into bids)
          const bidBook = tick.bookBids;
          if (sellPrice > 0.01) {
            recordSell(side, tokens, sellPrice);
            windDownSells++;
          }
        } else {
          // Progressive unwind
          const sellPrice = Math.max(params.sell_min_price, marketPrice * 0.90);
          const sellSize = Math.min(params.sell_size * 2, tokens);
          if (sellPrice > 0.01) {
            recordSell(side, sellSize, sellPrice);
            windDownSells++;
          }
        }
      }

      tryMerge();
      continue;
    }

    // ── Skip uncertain ──────────────────────────────────────────
    if (Math.abs(pTrue - 0.50) < (1 - params.p_true_min_conviction)) {
      upBidPrice = 0; upBidSize = 0;
      downBidPrice = 0; downBidSize = 0;
      tryMerge();
      continue;
    }

    // ── Fixed-offset pricing ────────────────────────────────────
    const winBid = Math.round(params.target_pair_cost * params.winning_share * 100) / 100;
    const loseBid = Math.round(params.target_pair_cost * (1 - params.winning_share) * 100) / 100;
    let targetUpBid = upWinning ? winBid : loseBid;
    let targetDnBid = upWinning ? loseBid : winBid;

    // Pair cost guard
    if (downInventory > 0 && downAvgCost > 0) targetUpBid = Math.min(targetUpBid, params.target_pair_cost - downAvgCost);
    if (upInventory > 0 && upAvgCost > 0) targetDnBid = Math.min(targetDnBid, params.target_pair_cost - upAvgCost);

    // Inventory suppression
    if (upInventory >= params.max_inventory_per_side) targetUpBid = 0;
    if (downInventory >= params.max_inventory_per_side) targetDnBid = 0;
    if (totalBuyCost >= params.max_total_cost) { targetUpBid = 0; targetDnBid = 0; }

    targetUpBid = targetUpBid > 0 ? Math.max(0.01, targetUpBid) : 0;
    targetDnBid = targetDnBid > 0 ? Math.max(0.01, targetDnBid) : 0;

    // ── Check maker fills from recorded tape ────────────────────
    // UP bid
    if (upBidPrice > 0 && upBidSize > 0) {
      const upTokenId = snap.upTokenId;
      const fill = checkBucketFill(
        tick.tapeBuckets, upTokenId, upBidPrice, upBidSize, 0, upVolumeAtPlacement,
      );
      if (fill.filled) {
        recordBuy("UP", upBidSize, upBidPrice, false);
        upBidPrice = 0; upBidSize = 0;
      }
    }
    // DOWN bid
    if (downBidPrice > 0 && downBidSize > 0) {
      const dnTokenId = snap.downTokenId;
      const fill = checkBucketFill(
        tick.tapeBuckets, dnTokenId, downBidPrice, downBidSize, 0, downVolumeAtPlacement,
      );
      if (fill.filled) {
        recordBuy("DOWN", downBidSize, downBidPrice, false);
        downBidPrice = 0; downBidSize = 0;
      }
    }

    // ── Update/place bids ───────────────────────────────────────
    if (Math.abs(targetUpBid - upBidPrice) > 0.005 || upBidSize === 0) {
      upBidPrice = targetUpBid;
      upBidSize = targetUpBid > 0 ? params.maker_bid_size : 0;
      upVolumeAtPlacement = targetUpBid > 0 ? volumeAtOrBelow(tick.tapeBuckets, snap.upTokenId, targetUpBid) : 0;
      if (targetUpBid > 0) bidPlacementCount++;
    }
    if (Math.abs(targetDnBid - downBidPrice) > 0.005 || downBidSize === 0) {
      downBidPrice = targetDnBid;
      downBidSize = targetDnBid > 0 ? params.maker_bid_size : 0;
      downVolumeAtPlacement = targetDnBid > 0 ? volumeAtOrBelow(tick.tapeBuckets, snap.downTokenId, targetDnBid) : 0;
      if (targetDnBid > 0) bidPlacementCount++;
    }

    // ── Taker fills: check book asks ────────────────────────────
    if (targetUpBid > 0 && tick.upBookAsks.length > 0) {
      const bestAsk = Math.min(...tick.upBookAsks.map(a => a.price));
      if (bestAsk <= targetUpBid - params.taker_ask_discount &&
          upInventory < params.max_inventory_per_side &&
          totalBuyCost < params.max_total_cost) {
        recordBuy("UP", params.taker_bid_size, bestAsk, true);
      }
    }
    if (targetDnBid > 0 && tick.downBookAsks.length > 0) {
      const bestAsk = Math.min(...tick.downBookAsks.map(a => a.price));
      if (bestAsk <= targetDnBid - params.taker_ask_discount &&
          downInventory < params.max_inventory_per_side &&
          totalBuyCost < params.max_total_cost) {
        recordBuy("DOWN", params.taker_bid_size, bestAsk, true);
      }
    }

    // ── Mean-reversion sells ────────────────────────────────────
    for (const side of ["UP", "DOWN"] as const) {
      const tokens = side === "UP" ? upInventory : downInventory;
      const avgCost = side === "UP" ? upAvgCost : downAvgCost;
      if (tokens <= 0 || avgCost <= 0) continue;

      const marketPrice = side === "UP" ? pTrue : (1 - pTrue);
      if (marketPrice >= avgCost + params.sell_profit_threshold && avgCost > params.sell_min_price) {
        const sellPrice = Math.max(params.sell_min_price, Math.round((marketPrice - 0.02) * 100) / 100);
        const sellSize = Math.min(params.sell_size, tokens);
        recordSell(side, sellSize, sellPrice);
      }
    }

    // Auto-merge profitable pairs
    tryMerge();
  }

  // ── Resolution P&L for remaining inventory ────────────────────
  let resolutionPnl = 0;
  if (snap.outcome !== "UNKNOWN") {
    const winInv = snap.outcome === "UP" ? upInventory : downInventory;
    const winCost = snap.outcome === "UP" ? upAvgCost : downAvgCost;
    const loseInv = snap.outcome === "UP" ? downInventory : upInventory;
    const loseCost = snap.outcome === "UP" ? downAvgCost : upAvgCost;

    const payoutFee = calcFeePerShare(1.0, params.fee_params) * winInv;
    const winPayout = winInv * (1.0 - winCost) - payoutFee;
    const loseLoss = -(loseInv * loseCost);
    resolutionPnl = winPayout + loseLoss;
  }

  const netPnl = realizedSellPnl + mergePnl + resolutionPnl;

  return {
    upInventory,
    downInventory,
    upAvgCost,
    downAvgCost,
    totalBuyCost,
    realizedSellPnl: realizedSellPnl + mergePnl,
    fillCount,
    sellCount,
    flipCount: 0,
    netPnl,
    simulatedFillCount: fillCount,
    simulatedSellCount: sellCount,
    bidPlacementCount,
    takerBuys,
    makerBuys,
    sellRevenue: realizedSellPnl,
    resolutionPnl,
    windDownSells,
  };
}
