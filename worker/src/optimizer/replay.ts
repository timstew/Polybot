/**
 * Pure replay engine for strategy parameter optimization.
 *
 * Takes a recorded WindowSnapshot + DirectionalMakerParams → ReplayResult.
 * Deterministic: no API calls, no randomness. Uses recorded data as-is.
 */

import type { WindowSnapshot, ReplayResult, TickSnapshot, TapeBucket } from "./types";
import type { DirectionalMakerParams } from "../strategies/safe-maker";
import { calcFeePerShare, CRYPTO_FEES } from "../categories";

/** Sum volume at or below bidPrice for a given token in the tape buckets */
function volumeAtOrBelow(
  buckets: TapeBucket[],
  tokenId: string,
  bidPrice: number,
): number {
  let total = 0;
  for (const b of buckets) {
    if (b.tokenId === tokenId && b.price <= bidPrice) {
      total += b.size;
    }
  }
  return total;
}

/**
 * Check fill against cumulative volume buckets.
 * The tape is cumulative (grows each tick), so we compare current volume
 * against volume at bid placement time. Only NEW volume since placement
 * counts toward fills — mirrors live checkTapeFill's placedAtMs filter.
 */
function checkBucketFill(
  buckets: TapeBucket[],
  tokenId: string,
  bidPrice: number,
  bidSize: number,
  queueAhead: number,
  volumeAtPlacement: number,
): { filled: boolean; fillPrice: number } {
  const currentVolume = volumeAtOrBelow(buckets, tokenId, bidPrice);
  const newVolume = currentVolume - volumeAtPlacement;
  const totalNeeded = bidSize + queueAhead;
  if (newVolume >= totalNeeded) {
    return { filled: true, fillPrice: bidPrice };
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
  let mergePnl = 0;
  let fillCount = 0;
  let sellCount = 0;
  let flipCount = 0;

  // Merge helper: realize profit from paired inventory with pairCost < 1.00
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

  // Replay bid tracking (for parameter optimization — NOT used for fill acceptance)
  let upBidPrice = 0;
  let upBidSize = 0;
  let downBidPrice = 0;
  let downBidSize = 0;

  let confirmedDirection: "UP" | "DOWN" | null = null;
  let lastFlipSellAt = 0;

  const wDurMs = snap.windowEndTime - snap.windowOpenTime;
  const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);

  for (let tickIdx = 0; tickIdx < snap.ticks.length; tickIdx++) {
    const tick = snap.ticks[tickIdx];
    const prevTick = tickIdx > 0 ? snap.ticks[tickIdx - 1] : null;
    const now = tick.t;
    const signal = tick.signal;
    const timeToEnd = snap.windowEndTime - now;

    // Stop quoting near end
    if (timeToEnd < params.stop_quoting_before_end_ms) {
      upBidPrice = 0; upBidSize = 0;
      downBidPrice = 0; downBidSize = 0;
      continue;
    }

    // Accept fills using the PREVIOUS tick's recorded bid state.
    // The live strategy records fills in pendingFills during checkFills(),
    // then flushes them into the tick snapshot AFTER updating bids.
    // So the bid that was active when the fill happened is on the previous tick.
    // This gives 98%+ acceptance vs 71% when using the replay's own bid state.
    //
    // Only accept ONE fill per side per tick — the live strategy cancels the
    // filled order, so a second fill on the same side requires a new bid
    // (which happens on the next tick via updateQuotes).
    const recordedFills = tick.fills ?? [];
    let upFilledThisTick = false;
    let downFilledThisTick = false;
    for (const fill of recordedFills) {
      if (fill.side === "UP" && upFilledThisTick) continue;
      if (fill.side === "DOWN" && downFilledThisTick) continue;

      const liveBidPrice = prevTick
        ? (fill.side === "UP" ? prevTick.upBidPrice : prevTick.downBidPrice)
        : 0;
      const liveBidSize = prevTick
        ? (fill.side === "UP" ? prevTick.upBidSize : prevTick.downBidSize)
        : 0;

      if (liveBidSize > 0 && liveBidPrice >= fill.price) {
        const costBasis = fill.price;
        const fillSize = Math.min(fill.size, liveBidSize);
        if (fill.side === "UP") {
          if (upInventory > 0) {
            const totalCost = upAvgCost * upInventory + costBasis * fillSize;
            upInventory += fillSize;
            upAvgCost = totalCost / upInventory;
          } else {
            upInventory = fillSize;
            upAvgCost = costBasis;
          }
          upFilledThisTick = true;
        } else {
          if (downInventory > 0) {
            const totalCost = downAvgCost * downInventory + costBasis * fillSize;
            downInventory += fillSize;
            downAvgCost = totalCost / downInventory;
          } else {
            downInventory = fillSize;
            downAvgCost = costBasis;
          }
          downFilledThisTick = true;
        }
        totalBuyCost += costBasis * fillSize;
        fillCount++;
      }
    }

    // Merge paired inventory for instant profit (mirrors live strategy)
    if (upInventory > 0 && downInventory > 0) tryMerge();

    // Apply recorded sell events (from live strategy's exit/wind-down/flip sells)
    const recordedSells = tick.sells ?? [];
    for (const sell of recordedSells) {
      if (sell.side === "UP" && upInventory > 0) {
        const soldSize = Math.min(sell.size, upInventory);
        upInventory = Math.round((upInventory - soldSize) * 1e6) / 1e6;
        realizedSellPnl += sell.pnl * (soldSize / sell.size); // pro-rate if capped
        sellCount++;
      } else if (sell.side === "DOWN" && downInventory > 0) {
        const soldSize = Math.min(sell.size, downInventory);
        downInventory = Math.round((downInventory - soldSize) * 1e6) / 1e6;
        realizedSellPnl += sell.pnl * (soldSize / sell.size);
        sellCount++;
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

      // Sell excess inventory on flip — only if no recorded sells (old snapshots)
      if (recordedSells.length === 0 && signal.signalStrength >= params.min_signal_strength && params.sell_excess) {
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

    // Place bids (tracked for potential future use, not used for fill acceptance)
    if (upSize > 0) {
      upBidPrice = newUpBid;
      upBidSize = upSize;
    } else {
      upBidPrice = 0; upBidSize = 0;
    }
    if (downSize > 0) {
      downBidPrice = newDnBid;
      downBidSize = downSize;
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

  // Compute P&L: merge profit + resolution of remaining (unmerged) inventory
  let netPnl = mergePnl + realizedSellPnl;
  const feeParams = params.fee_params ?? CRYPTO_FEES;

  // Resolve any remaining unmerged inventory at window outcome
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
  };
}

/** Estimate queue depth ahead of our bid from recorded book bids.
 *  Assume ~25% queue position (we're a fast requoter, not last in line).
 *  Only count bids at strictly better prices as fully ahead;
 *  bids at our price level are partially ahead. */
function computeQueueAhead(
  tick: TickSnapshot,
  bidPrice: number,
  _isUp: boolean,
): number {
  let ahead = 0;
  for (const level of tick.bookBids) {
    if (level.price > bidPrice) {
      ahead += level.size;  // better price = always ahead
    } else if (level.price === bidPrice) {
      ahead += level.size * 0.25;  // same price = partial queue
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
