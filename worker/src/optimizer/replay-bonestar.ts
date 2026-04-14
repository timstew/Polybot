/**
 * BoneStar replay engine for parameter optimization.
 *
 * Takes a recorded WindowSnapshot + BoneStarParams → ReplayResult.
 * Simulates BoneStar's three-phase system: balanced accumulation,
 * directional conviction, and certainty sweeps. No sells (held to resolution).
 *
 * Uses checkBucketFill for fill simulation against recorded tape volume.
 */

import type { WindowSnapshot, ReplayResult, TickSnapshot, TapeBucket } from "./types";
import type { BoneStarParams } from "../strategies/bonestar";
import { DEFAULT_PARAMS } from "../strategies/bonestar";
import { calcFeePerShare, CRYPTO_FEES } from "../categories";
import { volumeAtOrBelow, checkBucketFill, computeQueueAhead } from "./replay";

// ── Search space for optimizer ──

export interface ParamSpec {
  name: string;
  type: "continuous" | "integer" | "boolean" | "categorical";
  min?: number;
  max?: number;
  choices?: string[];
}

export const BONESTAR_SEARCH_SPACE: ParamSpec[] = [
  { name: "bid_offset", type: "continuous", min: 0.02, max: 0.20 },
  { name: "max_bid_per_side", type: "continuous", min: 0.50, max: 0.95 },
  { name: "max_pair_cost", type: "continuous", min: 0.90, max: 0.99 },
  { name: "base_bid_size", type: "integer", min: 5, max: 50 },
  { name: "conviction_start_pct", type: "continuous", min: 0.15, max: 0.50 },
  { name: "conviction_size_mult", type: "continuous", min: 1.0, max: 4.0 },
  { name: "conviction_p_true_min", type: "continuous", min: 0.50, max: 0.70 },
  { name: "losing_side_discount", type: "continuous", min: 0.00, max: 0.15 },
  { name: "losing_side_min_bid", type: "continuous", min: 0.10, max: 0.35 },
  { name: "sweep_threshold", type: "continuous", min: 0.70, max: 0.95 },
  { name: "sweep_size", type: "integer", min: 50, max: 500 },
  { name: "sweep_window_pct", type: "continuous", min: 0.20, max: 0.60 },
  { name: "sweep_losing_side", type: "boolean" },
  { name: "losing_side_max_bid", type: "continuous", min: 0.10, max: 0.40 },
  { name: "losing_side_premium", type: "continuous", min: 0.01, max: 0.10 },
  { name: "max_inventory_per_side", type: "integer", min: 100, max: 500 },
  // Sweep safety params
  { name: "sweep_min_size", type: "integer", min: 10, max: 100 },
  { name: "sweep_confidence_scale", type: "boolean" },
  { name: "sweep_max_pair_cost", type: "continuous", min: 0.85, max: 0.99 },
  { name: "sweep_require_paired_base", type: "integer", min: 0, max: 50 },
  { name: "sweep_allow_flip", type: "boolean" },
  { name: "sweep_flip_threshold", type: "continuous", min: 0.15, max: 0.45 },
  { name: "sweep_threshold_late", type: "continuous", min: 0.85, max: 0.98 },
  { name: "base_bid_size_phase2", type: "integer", min: 20, max: 100 },
  { name: "max_inventory_ratio", type: "continuous", min: 1.5, max: 10.0 },
];

export const BONESTAR_DEFAULT_PARAMS = DEFAULT_PARAMS;

// ── Helpers ──

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ── Replay engine ──

export function replayBoneStarWindow(
  snap: WindowSnapshot,
  params: Record<string, unknown>,
): ReplayResult {
  const p = { ...DEFAULT_PARAMS, ...params } as BoneStarParams;

  let upInventory = 0;
  let downInventory = 0;
  let upAvgCost = 0;
  let downAvgCost = 0;
  let totalBuyCost = 0;
  let mergePnl = 0;
  let fillCount = 0;
  let bidPlacementCount = 0;

  // BoneStar never sells — sellCount and realizedSellPnl always 0
  const realizedSellPnl = 0;
  const sellCount = 0;
  const flipCount = 0;

  // Phase state — monotonic: 1→2→3
  let phase: 1 | 2 | 3 = 1;
  let lockedSweepSide: "UP" | "DOWN" | null = null;
  let sweepFillCount = 0;
  let lastSweepFillAt = 0;

  // Active bid tracking
  let upBidPrice = 0;
  let upBidSize = 0;
  let downBidPrice = 0;
  let downBidSize = 0;
  let sweepBidPrice = 0;
  let sweepBidSize = 0;
  let sweepBidSide: "UP" | "DOWN" | null = null;

  // Volume at placement for tape fill detection
  let upVolumeAtPlacement = 0;
  let downVolumeAtPlacement = 0;
  let sweepVolumeAtPlacement = 0;

  const tryMerge = () => {
    const matched = Math.min(upInventory, downInventory);
    if (matched <= 0) return;
    const pairCost = upAvgCost + downAvgCost;
    if (pairCost >= 1.0) return;
    const pnl = matched * (1.0 - pairCost);
    mergePnl += pnl;
    upInventory = Math.round((upInventory - matched) * 1e6) / 1e6;
    downInventory = Math.round((downInventory - matched) * 1e6) / 1e6;
  };

  const recordBuyFill = (side: "UP" | "DOWN", fillPrice: number, fillSize: number) => {
    if (side === "UP") {
      if (upInventory > 0) {
        const totalCost = upAvgCost * upInventory + fillPrice * fillSize;
        upInventory += fillSize;
        upAvgCost = totalCost / upInventory;
      } else {
        upInventory = fillSize;
        upAvgCost = fillPrice;
      }
    } else {
      if (downInventory > 0) {
        const totalCost = downAvgCost * downInventory + fillPrice * fillSize;
        downInventory += fillSize;
        downAvgCost = totalCost / downInventory;
      } else {
        downInventory = fillSize;
        downAvgCost = fillPrice;
      }
    }
    totalBuyCost += fillPrice * fillSize;
    fillCount++;
  };

  const wDurMs = snap.windowEndTime - snap.windowOpenTime;

  for (let tickIdx = 0; tickIdx < snap.ticks.length; tickIdx++) {
    const tick = snap.ticks[tickIdx];
    const now = tick.t;
    const windowProgress = (now - snap.windowOpenTime) / wDurMs;

    // P_true from snapshot (BoneStar-specific field)
    const pTrue = tick.pTrue ?? 0.5;

    // ── Check simulated fills on active bids ──

    // UP maker bid
    if (upBidPrice > 0 && upBidSize > 0) {
      const bestUpAsk = tick.upBookAsks?.length
        ? Math.min(...tick.upBookAsks.map(a => a.price))
        : null;
      let filled = false;
      let fillPrice = upBidPrice;

      if (bestUpAsk !== null && upBidPrice >= bestUpAsk) {
        filled = true;
        fillPrice = bestUpAsk;
      } else if (tick.tapeBuckets.length > 0) {
        const queueAhead = computeQueueAhead(tick, upBidPrice, true);
        const result = checkBucketFill(
          tick.tapeBuckets, snap.upTokenId, upBidPrice, upBidSize,
          queueAhead, upVolumeAtPlacement,
        );
        filled = result.filled;
        fillPrice = result.fillPrice;
      }

      if (filled) {
        recordBuyFill("UP", fillPrice, upBidSize);
        upBidPrice = 0; upBidSize = 0;
      }
    }

    // DOWN maker bid
    if (downBidPrice > 0 && downBidSize > 0) {
      const bestDnAsk = tick.downBookAsks?.length
        ? Math.min(...tick.downBookAsks.map(a => a.price))
        : null;
      let filled = false;
      let fillPrice = downBidPrice;

      if (bestDnAsk !== null && downBidPrice >= bestDnAsk) {
        filled = true;
        fillPrice = bestDnAsk;
      } else if (tick.tapeBuckets.length > 0) {
        const queueAhead = computeQueueAhead(tick, downBidPrice, false);
        const result = checkBucketFill(
          tick.tapeBuckets, snap.downTokenId, downBidPrice, downBidSize,
          queueAhead, downVolumeAtPlacement,
        );
        filled = result.filled;
        fillPrice = result.fillPrice;
      }

      if (filled) {
        recordBuyFill("DOWN", fillPrice, downBidSize);
        downBidPrice = 0; downBidSize = 0;
      }
    }

    // Sweep bid
    if (sweepBidPrice > 0 && sweepBidSize > 0 && sweepBidSide) {
      const tokenId = sweepBidSide === "UP" ? snap.upTokenId : snap.downTokenId;
      const bookAsks = sweepBidSide === "UP" ? tick.upBookAsks : tick.downBookAsks;
      const bestAsk = bookAsks?.length
        ? Math.min(...bookAsks.map(a => a.price))
        : null;
      let filled = false;
      let fillPrice = sweepBidPrice;

      if (bestAsk !== null && sweepBidPrice >= bestAsk) {
        filled = true;
        fillPrice = bestAsk;
      } else if (tick.tapeBuckets.length > 0) {
        const queueAhead = computeQueueAhead(tick, sweepBidPrice, sweepBidSide === "UP");
        const result = checkBucketFill(
          tick.tapeBuckets, tokenId, sweepBidPrice, sweepBidSize,
          queueAhead, sweepVolumeAtPlacement,
        );
        filled = result.filled;
        fillPrice = result.fillPrice;
      }

      if (filled) {
        recordBuyFill(sweepBidSide, fillPrice, sweepBidSize);
        sweepFillCount++;
        lastSweepFillAt = now;
        sweepBidPrice = 0; sweepBidSize = 0;
      }
    }

    // Merge paired inventory
    if (upInventory > 0 && downInventory > 0) tryMerge();

    // ── Phase promotion (monotonic) ──
    const sweepTriggered = (pTrue > p.sweep_threshold || pTrue < (1 - p.sweep_threshold))
      && windowProgress >= p.sweep_window_pct;

    if (phase === 3 || sweepTriggered) {
      if (phase !== 3) {
        lockedSweepSide = pTrue > 0.5 ? "UP" : "DOWN";
      } else if (p.sweep_allow_flip && lockedSweepSide) {
        // Allow sweep side to flip if P_true reversed hard
        const currentSweepPTrue = lockedSweepSide === "UP" ? pTrue : (1 - pTrue);
        if (currentSweepPTrue < p.sweep_flip_threshold) {
          lockedSweepSide = lockedSweepSide === "UP" ? "DOWN" : "UP";
        }
      }
      phase = 3;
    } else if (phase >= 2 || windowProgress >= p.conviction_start_pct) {
      phase = 2;
    }

    // ── Compute bid prices and sizes based on phase ──

    const fairUp = pTrue;
    const fairDown = 1 - pTrue;

    if (phase === 1) {
      // Phase 1: Balanced accumulation
      let upBid = clamp(fairUp - p.bid_offset, p.min_bid_per_side, p.max_bid_per_side);
      let dnBid = clamp(fairDown - p.bid_offset, p.min_bid_per_side, p.max_bid_per_side);

      // Pair cost cap
      if (downInventory > 0) upBid = Math.min(upBid, p.max_pair_cost - downAvgCost);
      if (upInventory > 0) dnBid = Math.min(dnBid, p.max_pair_cost - upAvgCost);
      if (upBid + dnBid > p.max_pair_cost) {
        const scale = p.max_pair_cost / (upBid + dnBid);
        upBid *= scale;
        dnBid *= scale;
      }
      upBid = Math.max(0.01, upBid);
      dnBid = Math.max(0.01, dnBid);

      let upSize = p.base_bid_size;
      let dnSize = p.base_bid_size;
      if (upInventory >= p.base_bid_size && downInventory === 0) upSize = 0;
      if (downInventory >= p.base_bid_size && upInventory === 0) dnSize = 0;
      if (upInventory >= p.max_inventory_per_side) upSize = 0;
      if (downInventory >= p.max_inventory_per_side) dnSize = 0;

      // Inventory ratio guard: suppress heavy side when too imbalanced
      const heavy1 = Math.max(upInventory, downInventory);
      const light1 = Math.min(upInventory, downInventory);
      if (light1 > 0 && heavy1 / light1 > p.max_inventory_ratio) {
        if (upInventory > downInventory) upSize = 0;
        else dnSize = 0;
      }

      // Place bids
      if (upSize > 0) {
        const newBid = Math.max(0.01, Math.floor(upBid * 100) / 100);
        if (upBidPrice !== newBid || upBidSize !== upSize) {
          upVolumeAtPlacement = volumeAtOrBelow(tick.tapeBuckets, snap.upTokenId, newBid);
        }
        upBidPrice = newBid; upBidSize = upSize;
        bidPlacementCount++;
      } else {
        upBidPrice = 0; upBidSize = 0;
      }
      if (dnSize > 0) {
        const newBid = Math.max(0.01, Math.floor(dnBid * 100) / 100);
        if (downBidPrice !== newBid || downBidSize !== dnSize) {
          downVolumeAtPlacement = volumeAtOrBelow(tick.tapeBuckets, snap.downTokenId, newBid);
        }
        downBidPrice = newBid; downBidSize = dnSize;
        bidPlacementCount++;
      } else {
        downBidPrice = 0; downBidSize = 0;
      }
      // No sweep in Phase 1
      sweepBidPrice = 0; sweepBidSize = 0;

    } else if (phase === 2) {
      // Phase 2: Conviction
      const upWinning = pTrue > 0.5;
      let upBid = clamp(fairUp - p.bid_offset, p.min_bid_per_side, p.max_bid_per_side);
      let dnBid = clamp(fairDown - p.bid_offset, p.min_bid_per_side, p.max_bid_per_side);

      const sizeMultiplier = pTrue > p.conviction_p_true_min || (1 - pTrue) > p.conviction_p_true_min
        ? p.conviction_size_mult : 1.0;

      let upSize = p.base_bid_size;
      let dnSize = p.base_bid_size;

      if (upWinning) {
        upSize = Math.round(p.base_bid_size_phase2 * sizeMultiplier);
        // Losing-side bid: floor at min_bid, cap at max_bid
        dnBid = Math.max(dnBid, p.losing_side_min_bid);
        dnBid = Math.min(dnBid, p.losing_side_max_bid);
        dnBid = Math.max(p.min_bid_per_side, dnBid - p.losing_side_discount);
      } else {
        dnSize = Math.round(p.base_bid_size_phase2 * sizeMultiplier);
        // Losing-side bid: floor at min_bid, cap at max_bid
        upBid = Math.max(upBid, p.losing_side_min_bid);
        upBid = Math.min(upBid, p.losing_side_max_bid);
        upBid = Math.max(p.min_bid_per_side, upBid - p.losing_side_discount);
      }

      // Pair cost cap
      if (downInventory > 0) upBid = Math.min(upBid, p.max_pair_cost - downAvgCost);
      if (upInventory > 0) dnBid = Math.min(dnBid, p.max_pair_cost - upAvgCost);
      upBid = Math.max(0.01, upBid);
      dnBid = Math.max(0.01, dnBid);

      // Inventory guards
      if (upInventory >= p.max_inventory_per_side) upSize = 0;
      if (downInventory >= p.max_inventory_per_side) dnSize = 0;

      // One-sided guard: pause heavy side when other has 0
      if (upInventory >= p.base_bid_size_phase2 && downInventory === 0) upSize = 0;
      if (downInventory >= p.base_bid_size_phase2 && upInventory === 0) dnSize = 0;

      // Inventory ratio guard: suppress heavy side when too imbalanced
      const heavy2 = Math.max(upInventory, downInventory);
      const light2 = Math.min(upInventory, downInventory);
      if (light2 > 0 && heavy2 / light2 > p.max_inventory_ratio) {
        if (upInventory > downInventory) upSize = 0;
        else dnSize = 0;
      }

      if (upSize > 0) {
        const newBid = Math.max(0.01, Math.floor(upBid * 100) / 100);
        if (upBidPrice !== newBid || upBidSize !== upSize) {
          upVolumeAtPlacement = volumeAtOrBelow(tick.tapeBuckets, snap.upTokenId, newBid);
        }
        upBidPrice = newBid; upBidSize = upSize;
        bidPlacementCount++;
      } else {
        upBidPrice = 0; upBidSize = 0;
      }
      if (dnSize > 0) {
        const newBid = Math.max(0.01, Math.floor(dnBid * 100) / 100);
        if (downBidPrice !== newBid || downBidSize !== dnSize) {
          downVolumeAtPlacement = volumeAtOrBelow(tick.tapeBuckets, snap.downTokenId, newBid);
        }
        downBidPrice = newBid; downBidSize = dnSize;
        bidPlacementCount++;
      } else {
        downBidPrice = 0; downBidSize = 0;
      }
      // No sweep in Phase 2
      sweepBidPrice = 0; sweepBidSize = 0;

    } else {
      // Phase 3: Sweep + maker bids
      const sweepSide = lockedSweepSide ?? (pTrue > 0.5 ? "UP" : "DOWN");
      const pTrueForSweepSide = sweepSide === "UP" ? pTrue : (1 - pTrue);

      // Late window uses stricter threshold
      const effectiveThreshold = windowProgress > 0.75 ? p.sweep_threshold_late : p.sweep_threshold;
      const sweepStillValid = pTrueForSweepSide > effectiveThreshold;

      // Sweep bid
      const sweepInv = sweepSide === "UP" ? upInventory : downInventory;
      const cooldownOk = now - lastSweepFillAt >= p.sweep_cooldown_ms;
      const sweepCapOk = sweepInv < p.max_inventory_per_side;
      const sweepCountOk = sweepFillCount < p.max_sweeps_per_window;
      const remainingCapacity = Math.max(0, p.max_inventory_per_side - sweepInv);

      let effectiveSweepPrice = p.sweep_bid_price;
      if (p.sweep_bid_dynamic) {
        effectiveSweepPrice = Math.min(
          Math.max(0.50, pTrueForSweepSide - p.sweep_margin),
          p.max_sweep_price,
        );
      }

      // Graduated sweep sizing: scale with confidence margin above threshold
      let newSweepSize: number;
      if (!(sweepStillValid && cooldownOk && sweepCapOk && sweepCountOk)) {
        newSweepSize = 0;
      } else if (p.sweep_confidence_scale) {
        const margin = pTrueForSweepSide - effectiveThreshold;
        const maxMargin = 1.0 - effectiveThreshold;
        const scale = Math.min(1.0, margin / maxMargin);
        newSweepSize = Math.round(p.sweep_min_size + scale * (p.sweep_size - p.sweep_min_size));
        newSweepSize = Math.min(newSweepSize, remainingCapacity);
      } else {
        newSweepSize = Math.min(p.sweep_size, remainingCapacity);
      }

      // Pair cost gate: don't add sweep tokens if pair cost already too high
      if (newSweepSize > 0 && p.sweep_max_pair_cost > 0) {
        const pairedCount = Math.min(upInventory, downInventory);
        const upAvg = upInventory > 0 ? upAvgCost : 0;
        const dnAvg = downInventory > 0 ? downAvgCost : 0;
        if (pairedCount > 0 && (upAvg + dnAvg) > p.sweep_max_pair_cost) {
          newSweepSize = 0;
        }
      }

      // Paired base check: limit or stop sweep when insufficient paired inventory
      if (newSweepSize > 0) {
        const pairedCount = Math.min(upInventory, downInventory);
        const sweepSideInv = sweepSide === "UP" ? upInventory : downInventory;
        if (pairedCount === 0 && sweepSideInv >= p.base_bid_size) {
          newSweepSize = 0;
        } else if (pairedCount < p.sweep_require_paired_base) {
          newSweepSize = Math.min(newSweepSize, p.sweep_min_size);
        }
      }

      if (newSweepSize > 0) {
        const roundedSweep = Math.floor(effectiveSweepPrice * 100) / 100;
        if (sweepBidPrice !== roundedSweep || sweepBidSize !== newSweepSize || sweepBidSide !== sweepSide) {
          const tokenId = sweepSide === "UP" ? snap.upTokenId : snap.downTokenId;
          sweepVolumeAtPlacement = volumeAtOrBelow(tick.tapeBuckets, tokenId, roundedSweep);
        }
        sweepBidPrice = Math.floor(effectiveSweepPrice * 100) / 100;
        sweepBidSize = newSweepSize;
        sweepBidSide = sweepSide;
        bidPlacementCount++;
      } else {
        sweepBidPrice = 0; sweepBidSize = 0;
      }

      // Phase 3 maker bids (same as live strategy)
      const actualUpWinning = pTrue > 0.5;
      let upBid = clamp(fairUp - p.bid_offset, p.min_bid_per_side, p.max_bid_per_side);
      let dnBid = clamp(fairDown - p.bid_offset, p.min_bid_per_side, p.max_bid_per_side);

      let upSize = p.base_bid_size;
      let dnSize = p.base_bid_size;

      if (actualUpWinning) {
        upSize = Math.round(p.base_bid_size * p.conviction_size_mult);
        if (p.sweep_losing_side) {
          const losingBid = Math.min(1 - pTrue + p.losing_side_premium, p.losing_side_max_bid);
          dnBid = Math.max(p.losing_side_min_bid, losingBid);
        }
      } else {
        dnSize = Math.round(p.base_bid_size * p.conviction_size_mult);
        if (p.sweep_losing_side) {
          const losingBid = Math.min(pTrue + p.losing_side_premium, p.losing_side_max_bid);
          upBid = Math.max(p.losing_side_min_bid, losingBid);
        }
      }

      upBid = Math.max(0.01, upBid);
      dnBid = Math.max(0.01, dnBid);

      // Inventory guards — losing side: only buy enough to pair
      const actualWinningInv = actualUpWinning ? upInventory : downInventory;
      const actualLosingInv = actualUpWinning ? downInventory : upInventory;
      const unpaired = Math.max(0, actualWinningInv - actualLosingInv);
      if (!actualUpWinning && unpaired === 0) upSize = 0;
      if (actualUpWinning && unpaired === 0) dnSize = 0;
      // One-sided guard: pause winning-side bids when no paired inventory
      if (upInventory >= p.base_bid_size && downInventory === 0) upSize = 0;
      if (downInventory >= p.base_bid_size && upInventory === 0) dnSize = 0;
      if (upInventory >= p.max_inventory_per_side) upSize = 0;
      if (downInventory >= p.max_inventory_per_side) dnSize = 0;

      // Inventory ratio guard: suppress heavy side when too imbalanced
      const heavy3 = Math.max(upInventory, downInventory);
      const light3 = Math.min(upInventory, downInventory);
      if (light3 > 0 && heavy3 / light3 > p.max_inventory_ratio) {
        if (upInventory > downInventory) upSize = 0;
        else dnSize = 0;
      }

      if (upSize > 0) {
        const newBid = Math.max(0.01, Math.floor(upBid * 100) / 100);
        if (upBidPrice !== newBid || upBidSize !== upSize) {
          upVolumeAtPlacement = volumeAtOrBelow(tick.tapeBuckets, snap.upTokenId, newBid);
        }
        upBidPrice = newBid; upBidSize = upSize;
        bidPlacementCount++;
      } else {
        upBidPrice = 0; upBidSize = 0;
      }
      if (dnSize > 0) {
        const newBid = Math.max(0.01, Math.floor(dnBid * 100) / 100);
        if (downBidPrice !== newBid || downBidSize !== dnSize) {
          downVolumeAtPlacement = volumeAtOrBelow(tick.tapeBuckets, snap.downTokenId, newBid);
        }
        downBidPrice = newBid; downBidSize = dnSize;
        bidPlacementCount++;
      } else {
        downBidPrice = 0; downBidSize = 0;
      }
    }
  }

  // ── Resolve: merge profit + remaining inventory at window outcome ──

  let netPnl = mergePnl + realizedSellPnl;
  const feeParams = p.fee_params ?? CRYPTO_FEES;

  if (snap.outcome !== "UNKNOWN" && (upInventory > 0 || downInventory > 0)) {
    const winInv = snap.outcome === "UP" ? upInventory : downInventory;
    const winCost = snap.outcome === "UP" ? upAvgCost : downAvgCost;
    const loseInv = snap.outcome === "UP" ? downInventory : upInventory;
    const loseCost = snap.outcome === "UP" ? downAvgCost : upAvgCost;

    const payoutFee = calcFeePerShare(1.0, feeParams) * winInv;
    const winPayout = winInv * (1.0 - winCost) - payoutFee;
    const loseLoss = -(loseInv * loseCost);
    netPnl += winPayout + loseLoss;
  }

  return {
    upInventory, downInventory,
    upAvgCost, downAvgCost,
    totalBuyCost, realizedSellPnl,
    fillCount, sellCount, flipCount,
    netPnl,
    simulatedFillCount: fillCount,
    simulatedSellCount: sellCount,
    bidPlacementCount,
  };
}
