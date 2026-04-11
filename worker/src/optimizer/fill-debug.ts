#!/usr/bin/env npx tsx
/**
 * Debug why the replay engine rejects recorded fill events.
 * Traces each recorded fill and categorizes why it was accepted or rejected.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { WindowSnapshot, TickSnapshot } from "./types";
import { DEFAULT_PARAMS, type DirectionalMakerParams } from "../strategies/safe-maker";

// Auto-detect DB
let dbPath = process.argv[2] || "";
if (!dbPath) {
  const candidates = [
    path.join(__dirname, "../../.wrangler/state/v3/d1/miniflare-D1DatabaseObject"),
    path.join(__dirname, "../../wrangler-data/d1/miniflare-D1DatabaseObject"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".sqlite"));
      if (files.length > 0) { dbPath = path.join(dir, files[0]); break; }
    }
  }
}

const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(
  `SELECT id, crypto_symbol, window_open_time, window_end_time, window_duration_ms,
          oracle_strike, price_at_open, hour_utc, day_of_week,
          up_token_id, down_token_id, outcome, ticks
   FROM strategy_snapshots
   WHERE outcome IS NOT NULL AND outcome != 'UNKNOWN'
   ORDER BY window_open_time`
).all() as Array<Record<string, unknown>>;
db.close();

const params: DirectionalMakerParams = { ...DEFAULT_PARAMS };

let totalRecorded = 0;
let accepted = 0;
let rejectedNoBid = 0;
let rejectedPriceTooLow = 0;
let rejectedStopQuoting = 0;
let rejectedMaxFlips = 0;

// Also track: what was the live bid state at fill time?
const noBidExamples: Array<{ snap: string; side: string; fillPrice: number; liveBid: number; liveSize: number }> = [];

for (const r of rows) {
  const ticks = JSON.parse(r.ticks as string) as TickSnapshot[];
  const windowOpenTime = r.window_open_time as number;
  const windowEndTime = r.window_end_time as number;
  const wDurMs = windowEndTime - windowOpenTime;
  const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);
  const snapId = (r.id as string).slice(0, 25);

  // Replay state
  let upBidPrice = 0, upBidSize = 0, downBidPrice = 0, downBidSize = 0;
  let upInv = 0, downInv = 0, upAvgCost = 0, downAvgCost = 0;
  let confirmedDir: string | null = null;
  let flipCount = 0;

  for (const tick of ticks) {
    const now = tick.t;
    const signal = tick.signal;
    const timeToEnd = windowEndTime - now;
    const effectiveBaseSize = Math.max(3, Math.round(params.base_bid_size * durationScale));

    // Check fills first (same order as replay.ts)
    for (const fill of (tick.fills ?? [])) {
      totalRecorded++;

      if (timeToEnd < params.stop_quoting_before_end_ms) {
        rejectedStopQuoting++;
        continue;
      }
      if (flipCount > params.max_flips_per_window) {
        rejectedMaxFlips++;
        continue;
      }

      const isUp = fill.side === "UP";
      const bidPrice = isUp ? upBidPrice : downBidPrice;
      const bidSize = isUp ? upBidSize : downBidSize;

      if (bidSize <= 0) {
        rejectedNoBid++;
        // Record live bid state from the tick for debugging
        const liveBid = isUp ? tick.upBidPrice : tick.downBidPrice;
        const liveSize = isUp ? tick.upBidSize : tick.downBidSize;
        if (noBidExamples.length < 20) {
          noBidExamples.push({ snap: snapId, side: fill.side, fillPrice: fill.price, liveBid, liveSize });
        }
        continue;
      }
      if (bidPrice < fill.price) {
        rejectedPriceTooLow++;
        continue;
      }

      accepted++;
      const costBasis = fill.price;
      const fillSize = Math.min(fill.size, bidSize);
      if (isUp) {
        if (upInv > 0) { upInv += fillSize; upAvgCost = (upAvgCost * (upInv - fillSize) + costBasis * fillSize) / upInv; }
        else { upInv = fillSize; upAvgCost = costBasis; }
        upBidPrice = 0; upBidSize = 0;
      } else {
        if (downInv > 0) { downInv += fillSize; downAvgCost = (downAvgCost * (downInv - fillSize) + costBasis * fillSize) / downInv; }
        else { downInv = fillSize; downAvgCost = costBasis; }
        downBidPrice = 0; downBidSize = 0;
      }
    }

    // Fallback book-based fills (same as replay.ts)
    if (upBidSize > 0) {
      const upAsks = tick.upBookAsks ?? [];
      if (upAsks.length > 0) {
        const bestAsk = Math.min(...upAsks.map(a => a.price));
        if (upBidPrice >= bestAsk) {
          const costBasis = bestAsk;
          if (upInv > 0) { upInv += upBidSize; upAvgCost = (upAvgCost * (upInv - upBidSize) + costBasis * upBidSize) / upInv; }
          else { upInv = upBidSize; upAvgCost = costBasis; }
          accepted++;
          upBidPrice = 0; upBidSize = 0;
        }
      }
    }
    if (downBidSize > 0) {
      const downAsks = tick.downBookAsks ?? [];
      if (downAsks.length > 0) {
        const bestAsk = Math.min(...downAsks.map(a => a.price));
        if (downBidPrice >= bestAsk) {
          const costBasis = bestAsk;
          if (downInv > 0) { downInv += downBidSize; downAvgCost = (downAvgCost * (downInv - downBidSize) + costBasis * downBidSize) / downInv; }
          else { downInv = downBidSize; downAvgCost = costBasis; }
          accepted++;
          downBidPrice = 0; downBidSize = 0;
        }
      }
    }

    // Merge
    if (upInv > 0 && downInv > 0) {
      const matched = Math.min(upInv, downInv);
      upInv = Math.round((upInv - matched) * 1e6) / 1e6;
      downInv = Math.round((downInv - matched) * 1e6) / 1e6;
    }

    // Stop quoting
    if (timeToEnd < params.stop_quoting_before_end_ms) {
      upBidPrice = 0; upBidSize = 0;
      downBidPrice = 0; downBidSize = 0;
      continue;
    }

    // Direction tracking
    const confirmedFlip = confirmedDir !== null && signal.direction !== confirmedDir && !signal.inDeadZone;
    if (confirmedFlip) {
      flipCount++;
      confirmedDir = signal.direction;
      // Sell excess if enabled
      if (params.sell_excess && signal.signalStrength >= params.min_signal_strength) {
        // simplified sell
      }
      upBidPrice = 0; upBidSize = 0;
      downBidPrice = 0; downBidSize = 0;
    } else if (confirmedDir === null) {
      confirmedDir = signal.direction;
    }

    if (flipCount > params.max_flips_per_window) {
      upBidPrice = 0; upBidSize = 0;
      downBidPrice = 0; downBidSize = 0;
      continue;
    }

    // Compute bids
    const regime = tick.regime;
    const regimeDiscount = regime === "oscillating" ? 0.20 : regime === "trending" ? 0.08 : regime === "volatile" ? 0.18 : regime === "calm" ? 0.12 : 0.12;
    const discFairUp = Math.max(0.01, tick.fairUp * (1 - regimeDiscount));
    const discFairDown = Math.max(0.01, tick.fairDown * (1 - regimeDiscount));

    const convSide = signal.signalStrength >= params.min_signal_strength ? signal.direction : null;
    const strRange = 1.0 - params.min_signal_strength;
    const strFrac = strRange > 0 ? Math.min(1.0, (signal.signalStrength - params.min_signal_strength) / strRange) : 0;
    const scaledBias = 1.0 + (params.conviction_bias - 1.0) * strFrac;
    const adjBias = scaledBias * signal.confidenceMultiplier;
    const clBias = Math.min(adjBias, 2.0);

    let upSize = effectiveBaseSize;
    let downSize = effectiveBaseSize;
    if (convSide === "UP") {
      upSize = Math.round(effectiveBaseSize * clBias);
      downSize = Math.max(Math.round(effectiveBaseSize * 0.5), Math.round(effectiveBaseSize / clBias));
    } else if (convSide === "DOWN") {
      downSize = Math.round(effectiveBaseSize * clBias);
      upSize = Math.max(Math.round(effectiveBaseSize * 0.5), Math.round(effectiveBaseSize / clBias));
    }

    // One-sided cap
    if (downInv === 0) upSize = Math.min(upSize, Math.max(0, effectiveBaseSize - upInv));
    if (upInv === 0) downSize = Math.min(downSize, Math.max(0, effectiveBaseSize - downInv));

    // Inventory ratio
    const maxR = params.max_inventory_ratio;
    if (upInv > 0 && downInv > 0) {
      if (upInv / downInv > maxR) upSize = 0;
      if (downInv / upInv > maxR) downSize = 0;
    } else if (upInv >= effectiveBaseSize && downInv === 0) { upSize = 0; }
    else if (downInv >= effectiveBaseSize && upInv === 0) { downSize = 0; }

    // Bid prices
    let newUpBid = Math.min(discFairUp, params.max_bid_per_side);
    let newDnBid = Math.min(discFairDown, params.max_bid_per_side);
    if (downInv > 0) newUpBid = Math.min(newUpBid, params.max_pair_cost - downAvgCost);
    if (upInv > 0) newDnBid = Math.min(newDnBid, params.max_pair_cost - upAvgCost);
    newUpBid = Math.max(0.01, Math.floor(newUpBid * 100) / 100);
    newDnBid = Math.max(0.01, Math.floor(newDnBid * 100) / 100);

    if (upSize > 0) { upBidPrice = newUpBid; upBidSize = upSize; }
    else { upBidPrice = 0; upBidSize = 0; }
    if (downSize > 0) { downBidPrice = newDnBid; downBidSize = downSize; }
    else { downBidPrice = 0; downBidSize = 0; }

    // Per-tick safety cancel
    if (upBidSize > 0 && ((upInv >= effectiveBaseSize && downInv === 0) || (downInv > 0 && upInv / downInv > maxR))) {
      upBidPrice = 0; upBidSize = 0;
    }
    if (downBidSize > 0 && ((downInv >= effectiveBaseSize && upInv === 0) || (upInv > 0 && downInv / upInv > maxR))) {
      downBidPrice = 0; downBidSize = 0;
    }
  }
}

console.log("=== Fill rejection analysis ===");
console.log(`Total recorded fills:  ${totalRecorded}`);
console.log(`Accepted by replay:    ${accepted} (${(accepted / totalRecorded * 100).toFixed(1)}%)`);
console.log(`Rejected - no bid:     ${rejectedNoBid} (${(rejectedNoBid / totalRecorded * 100).toFixed(1)}%)`);
console.log(`Rejected - price low:  ${rejectedPriceTooLow} (${(rejectedPriceTooLow / totalRecorded * 100).toFixed(1)}%)`);
console.log(`Rejected - stop quot:  ${rejectedStopQuoting} (${(rejectedStopQuoting / totalRecorded * 100).toFixed(1)}%)`);
console.log(`Rejected - max flips:  ${rejectedMaxFlips} (${(rejectedMaxFlips / totalRecorded * 100).toFixed(1)}%)`);

if (noBidExamples.length > 0) {
  console.log(`\n--- "No bid" examples (replay had no bid, but live did) ---`);
  for (const ex of noBidExamples) {
    console.log(`  ${ex.snap} ${ex.side} fillPrice=$${ex.fillPrice.toFixed(3)} liveBid=$${ex.liveBid.toFixed(3)} liveSize=${ex.liveSize}`);
  }
}
