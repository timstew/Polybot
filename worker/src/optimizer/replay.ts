/**
 * Pure replay engine for strategy parameter optimization.
 *
 * Takes a recorded WindowSnapshot + DirectionalMakerParams → ReplayResult.
 * Deterministic: no API calls, no randomness. Uses recorded data as-is.
 */

import type { WindowSnapshot, ReplayResult, TickSnapshot, TapeBucket } from "./types";
import type { DirectionalMakerParams } from "../strategies/safe-maker";
import { calcFeePerShare, CRYPTO_FEES } from "../categories";

/** Check fill against volume buckets instead of raw tape */
function checkBucketFill(
  buckets: TapeBucket[],
  tokenId: string,
  bidPrice: number,
  bidSize: number,
  queueAhead: number,
): { filled: boolean; fillPrice: number } {
  const totalNeeded = bidSize + queueAhead;
  let volumeAtOrBelow = 0;
  for (const b of buckets) {
    if (b.tokenId === tokenId && b.price <= bidPrice) {
      volumeAtOrBelow += b.size;
      if (volumeAtOrBelow >= totalNeeded) {
        return { filled: true, fillPrice: bidPrice };
      }
    }
  }
  return { filled: false, fillPrice: 0 };
}

export function replayWindow(
  snap: WindowSnapshot,
  params: DirectionalMakerParams,
): ReplayResult {
  // Window state
  let upInventory = 0;
  let downInventory = 0;
  let upAvgCost = 0;
  let downAvgCost = 0;
  let totalBuyCost = 0;
  let realizedSellPnl = 0;
  let fillCount = 0;
  let sellCount = 0;
  let flipCount = 0;

  // Bid tracking
  let upBidPrice = 0;
  let upBidSize = 0;
  let upBidPlacedAt = 0;
  let downBidPrice = 0;
  let downBidSize = 0;
  let downBidPlacedAt = 0;

  let confirmedDirection: "UP" | "DOWN" | null = null;
  let lastFlipSellAt = 0;

  const wDurMs = snap.windowEndTime - snap.windowOpenTime;
  const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);

  for (const tick of snap.ticks) {
    const now = tick.t;
    const signal = tick.signal;
    const timeToEnd = snap.windowEndTime - now;

    // Stop quoting near end
    if (timeToEnd < params.stop_quoting_before_end_ms) {
      upBidPrice = 0; upBidSize = 0;
      downBidPrice = 0; downBidSize = 0;
      continue;
    }

    // Check fills on existing bids
    if (upBidSize > 0) {
      const queueAhead = computeQueueAhead(tick, upBidPrice, true);
      const result = checkBucketFill(tick.tapeBuckets, snap.upTokenId, upBidPrice, upBidSize, queueAhead);
      if (result.filled) {
        const costBasis = upBidPrice;
        if (upInventory > 0) {
          const totalCost = upAvgCost * upInventory + costBasis * upBidSize;
          upInventory += upBidSize;
          upAvgCost = totalCost / upInventory;
        } else {
          upInventory = upBidSize;
          upAvgCost = costBasis;
        }
        totalBuyCost += costBasis * upBidSize;
        fillCount++;
        upBidPrice = 0; upBidSize = 0;
      }
    }

    if (downBidSize > 0) {
      const queueAhead = computeQueueAhead(tick, downBidPrice, false);
      const result = checkBucketFill(tick.tapeBuckets, snap.downTokenId, downBidPrice, downBidSize, queueAhead);
      if (result.filled) {
        const costBasis = downBidPrice;
        if (downInventory > 0) {
          const totalCost = downAvgCost * downInventory + costBasis * downBidSize;
          downInventory += downBidSize;
          downAvgCost = totalCost / downInventory;
        } else {
          downInventory = downBidSize;
          downAvgCost = costBasis;
        }
        totalBuyCost += costBasis * downBidSize;
        fillCount++;
        downBidPrice = 0; downBidSize = 0;
      }
    }

    // Direction tracking with hysteresis
    const confirmedFlip =
      confirmedDirection !== null &&
      signal.direction !== confirmedDirection &&
      !signal.inDeadZone;

    if (confirmedFlip) {
      flipCount++;
      confirmedDirection = signal.direction;

      // Sell excess inventory on flip (mirrors safe-maker)
      if (signal.signalStrength >= params.min_signal_strength && params.sell_excess) {
        const cooldownOk = now - lastFlipSellAt >= params.flip_sell_cooldown_ms;
        if (cooldownOk && signal.signalStrength >= params.min_flip_sell_strength) {
          const sellResult = sellExcess(
            signal.direction, upInventory, downInventory, upAvgCost, downAvgCost, params
          );
          realizedSellPnl += sellResult.pnl;
          sellCount += sellResult.soldCount;
          upInventory = sellResult.upInv;
          downInventory = sellResult.downInv;
          lastFlipSellAt = now;
        }
      }

      // Cancel existing bids on flip
      upBidPrice = 0; upBidSize = 0;
      downBidPrice = 0; downBidSize = 0;
    } else if (confirmedDirection === null) {
      confirmedDirection = signal.direction;
    }

    // Max flips exceeded: stop quoting
    if (flipCount > params.max_flips_per_window) {
      upBidPrice = 0; upBidSize = 0;
      downBidPrice = 0; downBidSize = 0;
      continue;
    }

    // Compute fair values from snapshot (already recorded)
    const regime = tick.regime;
    const regimeDiscount =
      regime === "oscillating" ? 0.20 :
      regime === "trending"    ? 0.08 :
      regime === "volatile"    ? 0.18 :
      regime === "calm"        ? 0.12 :
      0.12;

    const fairUp = tick.fairUp;
    const fairDown = tick.fairDown;

    // Apply regime discount
    const discountedFairUp = Math.max(0.01, fairUp * (1 - regimeDiscount));
    const discountedFairDown = Math.max(0.01, fairDown * (1 - regimeDiscount));

    // Compute bid sizes
    const convictionSide =
      signal.signalStrength >= params.min_signal_strength
        ? signal.direction
        : null;

    const strengthRange = 1.0 - params.min_signal_strength;
    const strengthFraction = strengthRange > 0
      ? Math.min(1.0, (signal.signalStrength - params.min_signal_strength) / strengthRange)
      : 0;
    const scaledBias = 1.0 + (params.conviction_bias - 1.0) * strengthFraction;
    const adjustedBias = scaledBias * signal.confidenceMultiplier;
    let effectiveBaseSize = Math.max(3, Math.round(params.base_bid_size * durationScale));

    let upSize = effectiveBaseSize;
    let downSize = effectiveBaseSize;
    const clampedBias = Math.min(adjustedBias, 2.0);
    if (convictionSide === "UP") {
      upSize = Math.round(effectiveBaseSize * clampedBias);
      downSize = Math.max(
        Math.round(effectiveBaseSize * 0.5),
        Math.round(effectiveBaseSize / clampedBias)
      );
    } else if (convictionSide === "DOWN") {
      downSize = Math.round(effectiveBaseSize * clampedBias);
      upSize = Math.max(
        Math.round(effectiveBaseSize * 0.5),
        Math.round(effectiveBaseSize / clampedBias)
      );
    }

    // One-sided cap
    if (downInventory === 0) upSize = Math.min(upSize, Math.max(0, effectiveBaseSize - upInventory));
    if (upInventory === 0) downSize = Math.min(downSize, Math.max(0, effectiveBaseSize - downInventory));

    // Inventory ratio check
    const maxInvRatio = params.max_inventory_ratio;
    if (upInventory > 0 && downInventory > 0) {
      if (upInventory / downInventory > maxInvRatio) upSize = 0;
      if (downInventory / upInventory > maxInvRatio) downSize = 0;
    } else if (upInventory >= effectiveBaseSize && downInventory === 0) {
      upSize = 0;
    } else if (downInventory >= effectiveBaseSize && upInventory === 0) {
      downSize = 0;
    }

    // Bid prices with time decay
    const windowProgress = (now - snap.windowOpenTime) / wDurMs;
    const tightenStart = params.tighten_start_pct;
    const timeDecay = windowProgress > tightenStart
      ? 1.0 - (windowProgress - tightenStart) / (1.0 - tightenStart)
      : 1.0;

    const upBidFair = upInventory > 0 ? discountedFairUp : fairUp * (1 - regimeDiscount * timeDecay);
    const dnBidFair = downInventory > 0 ? discountedFairDown : fairDown * (1 - regimeDiscount * timeDecay);

    let rawUpBid = Math.min(Math.max(0.01, upBidFair), params.max_bid_per_side);
    let rawDnBid = Math.min(Math.max(0.01, dnBidFair), params.max_bid_per_side);

    // Cross-fill guard: cap bid based on other side's avg cost
    let newUpBid = downInventory > 0
      ? Math.min(rawUpBid, params.max_pair_cost - downAvgCost)
      : rawUpBid;
    let newDnBid = upInventory > 0
      ? Math.min(rawDnBid, params.max_pair_cost - upAvgCost)
      : rawDnBid;

    if (newUpBid + newDnBid > params.max_pair_cost) {
      const scale = params.max_pair_cost / (newUpBid + newDnBid);
      newUpBid *= scale;
      newDnBid *= scale;
    }
    newUpBid = Math.max(0.01, Math.floor(newUpBid * 100) / 100);
    newDnBid = Math.max(0.01, Math.floor(newDnBid * 100) / 100);

    // Place bids
    if (upSize > 0) {
      upBidPrice = newUpBid;
      upBidSize = upSize;
      upBidPlacedAt = now;
    } else {
      upBidPrice = 0; upBidSize = 0;
    }
    if (downSize > 0) {
      downBidPrice = newDnBid;
      downBidSize = downSize;
      downBidPlacedAt = now;
    } else {
      downBidPrice = 0; downBidSize = 0;
    }

    // Per-tick safety: cancel heavy side
    if (upBidSize > 0) {
      const shouldCancelUp =
        (upInventory >= effectiveBaseSize && downInventory === 0) ||
        (downInventory > 0 && upInventory / downInventory > maxInvRatio);
      if (shouldCancelUp) { upBidPrice = 0; upBidSize = 0; }
    }
    if (downBidSize > 0) {
      const shouldCancelDn =
        (downInventory >= effectiveBaseSize && upInventory === 0) ||
        (upInventory > 0 && downInventory / upInventory > maxInvRatio);
      if (shouldCancelDn) { downBidPrice = 0; downBidSize = 0; }
    }
  }

  // Compute P&L from final inventory + outcome
  let netPnl = realizedSellPnl;
  const feeParams = params.fee_params ?? CRYPTO_FEES;

  if (snap.outcome !== "UNKNOWN") {
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
  };
}

/** Estimate queue depth ahead of our bid from recorded book bids */
function computeQueueAhead(
  tick: TickSnapshot,
  bidPrice: number,
  _isUp: boolean,
): number {
  let ahead = 0;
  for (const level of tick.bookBids) {
    if (level.price >= bidPrice) {
      ahead += level.size;
    }
  }
  return ahead;
}

/** Sell excess (unpaired) inventory on the losing side — mirrors safe-maker logic */
function sellExcess(
  signalDirection: "UP" | "DOWN",
  upInv: number,
  downInv: number,
  upAvgCost: number,
  downAvgCost: number,
  params: DirectionalMakerParams,
): { pnl: number; soldCount: number; upInv: number; downInv: number } {
  const losingSide = signalDirection === "UP" ? "DOWN" : "UP";
  const paired = Math.min(upInv, downInv);
  const feeParams = params.fee_params ?? CRYPTO_FEES;

  if (losingSide === "UP") {
    const excess = upInv - paired;
    if (excess <= 0) return { pnl: 0, soldCount: 0, upInv, downInv };
    // Sell at estimated mid (~0.50 minus some slippage)
    const sellPrice = 0.01; // worst case: losing side token goes to 0.01
    const fee = calcFeePerShare(sellPrice, feeParams) * excess;
    const pnl = excess * sellPrice - excess * upAvgCost - fee;
    return { pnl, soldCount: 1, upInv: upInv - excess, downInv };
  } else {
    const excess = downInv - paired;
    if (excess <= 0) return { pnl: 0, soldCount: 0, upInv, downInv };
    const sellPrice = 0.01;
    const fee = calcFeePerShare(sellPrice, feeParams) * excess;
    const pnl = excess * sellPrice - excess * downAvgCost - fee;
    return { pnl, soldCount: 1, upInv, downInv: downInv - excess };
  }
}
