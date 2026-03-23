/**
 * Conviction Tactic — one-sided high-confidence bets.
 *
 * Only bids when signal strength exceeds a high threshold (0.60).
 * Bids on ONE side only (conviction direction). Holds to resolution.
 * No hedge bids, no inventory management, no selling.
 * High risk/reward: wins big when right, loses full cost when wrong.
 */

import type { WindowTactic, TacticContext } from "./tactic";
import { registerTactic, recordFill, safeCancelAndRecord } from "./tactic";
import { calcFeePerShare, CRYPTO_FEES, type FeeParams } from "../categories";
import type { RegimeType } from "./regime";

interface ConvictionParams {
  bid_offset: number;
  min_bid_size: number;
  default_bid_size: number;
  min_signal_strength: number;
  max_flips_before_sit_out: number;
  fee_params: FeeParams;
}

const DEFAULTS: ConvictionParams = {
  bid_offset: 0.02,
  min_bid_size: 10,
  default_bid_size: 30,
  min_signal_strength: 0.60,
  max_flips_before_sit_out: 2,
  fee_params: CRYPTO_FEES,
};

class ConvictionTactic implements WindowTactic {
  readonly id = "conviction";
  readonly displayName = "Conviction";
  readonly description = "One-sided high-confidence bets: only bids when signal > 60%, holds to resolution";
  readonly naturalRegimes: RegimeType[] = ["trending", "near-strike"];
  readonly defaultParams: Record<string, unknown> = { ...DEFAULTS };

  onEnter(tc: TacticContext): void {
    const { signal } = tc;
    const p = { ...DEFAULTS, ...tc.params } as ConvictionParams;
    const convictionSide = signal.signalStrength >= p.min_signal_strength ? signal.direction : null;
    tc.window.confirmedDirection = convictionSide;
    tc.window.tacticState = {
      bidSize: (tc.params.default_bid_size as number) ?? DEFAULTS.default_bid_size,
      convictionSide,
    };
  }

  async onTick(tc: TacticContext): Promise<void> {
    const { ctx, window: w, signal } = tc;
    const p = { ...DEFAULTS, ...tc.params } as ConvictionParams;

    // Check fills
    await this.checkFills(tc, p);

    // Detect flip
    const confirmedFlip = w.confirmedDirection !== null
      && signal.direction !== w.confirmedDirection
      && !signal.inDeadZone;
    if (confirmedFlip) {
      w.flipCount++;
      w.confirmedDirection = signal.direction;
      w.lastDirectionChangeAt = Date.now();
    } else if (w.confirmedDirection === null && signal.signalStrength >= p.min_signal_strength) {
      w.confirmedDirection = signal.direction;
    }

    // Max flips: sit out
    if (w.flipCount > p.max_flips_before_sit_out) {
      if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
      if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
      w.tickAction = `Sat out: ${w.flipCount} flips > ${p.max_flips_before_sit_out} max`;
      return;
    }

    // Only bid when confident
    if (signal.signalStrength < p.min_signal_strength) {
      if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
      if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
      w.tickAction = `Waiting: sig=${(signal.signalStrength * 100).toFixed(0)}% < ${(p.min_signal_strength * 100).toFixed(0)}%`;
      return;
    }

    // Conviction sizing: scale with signal strength
    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);
    const ts = w.tacticState as { bidSize: number };
    const baseBidSize = Math.max(p.min_bid_size, Math.round(ts.bidSize * durationScale));
    const strengthScale = 0.5 + signal.signalStrength * 0.5;
    const bidSize = Math.round(baseBidSize * strengthScale);

    // Only bid on conviction side
    const side = signal.direction;
    const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
    const otherSide = side === "UP" ? "DOWN" : "UP";

    // Cancel bid on wrong side
    if (side === "UP" && w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
    if (side === "DOWN" && w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }

    // Don't bid more if already holding
    const currentInv = side === "UP" ? w.upInventory : w.downInventory;
    if (currentInv >= baseBidSize) {
      const existingId = side === "UP" ? w.upBidOrderId : w.downBidOrderId;
      if (existingId) {
        await ctx.api.cancelOrder(existingId);
        if (side === "UP") w.upBidOrderId = null; else w.downBidOrderId = null;
      }
      w.tickAction = `Holding ${currentInv} ${side} @ ${(side === "UP" ? w.upAvgCost : w.downAvgCost).toFixed(2)}`;
      return;
    }

    // Signal-derived bid price
    const dirSign = side === "UP" ? 1 : -1;
    const fairVal = Math.max(0.05, Math.min(0.95, 0.50 + signal.signalStrength * 0.20 * dirSign));
    const bidPrice = Math.max(0.01, (side === "UP" ? fairVal : 1 - fairVal) - p.bid_offset);

    // Place bid on conviction side
    const existingOrderId = side === "UP" ? w.upBidOrderId : w.downBidOrderId;
    if (existingOrderId) {
      const existingPrice = side === "UP" ? w.upBidPrice : w.downBidPrice;
      if (Math.abs(existingPrice - bidPrice) < 0.005) {
        w.tickAction = `${side} ${(signal.signalStrength * 100).toFixed(0)}% → hold bid`;
        return;
      }
      await safeCancelAndRecord(ctx.api, w, side);
    }

    const rounded = Math.floor(bidPrice * 100) / 100;
    const result = await ctx.api.placeOrder({ token_id: tokenId, side: "BUY", price: rounded, size: bidSize });
    if (result.status === "placed") {
      if (side === "UP") { w.upBidOrderId = result.order_id; w.upBidPrice = rounded; w.upBidSize = bidSize; }
      else { w.downBidOrderId = result.order_id; w.downBidPrice = rounded; w.downBidSize = bidSize; }
    } else if (result.status === "filled") {
      recordFill(w, side, result.size, result.price);
    }

    w.tickAction = `${side} ${(signal.signalStrength * 100).toFixed(0)}% → ▲${rounded.toFixed(2)} sz=${bidSize}`;
  }

  async onWindDown(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");
    const inv = w.upInventory + w.downInventory;
    w.tickAction = inv > 0 ? `Holding ${inv} to resolution` : "No position";
  }

  async onExit(tc: TacticContext): Promise<void> {
    await this.onWindDown(tc);
  }

  async onCancel(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
    if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
  }

  private async checkFills(tc: TacticContext, p: ConvictionParams): Promise<void> {
    const { ctx, window: w } = tc;
    for (const side of ["UP", "DOWN"] as const) {
      const orderId = side === "UP" ? w.upBidOrderId : w.downBidOrderId;
      if (!orderId) continue;
      const status = await ctx.api.getOrderStatus(orderId);
      if (status.status === "MATCHED") {
        recordFill(w, side, status.size_matched, status.price);
        const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
        ctx.log(`FILL ${side} [conv]: ${w.market.title.slice(0, 25)} ${status.size_matched}@${status.price.toFixed(3)}`);
        const fee = calcFeePerShare(status.price, p.fee_params) * status.size_matched;
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        ).bind(
          `orch-conv${side.toLowerCase()}-${crypto.randomUUID()}`, ctx.config.id,
          tokenId, w.market.slug, `${w.market.title} [ORCH CONV ${side}]`,
          status.price, status.size_matched, fee
        ).run();
        if (side === "UP") w.upBidOrderId = null; else w.downBidOrderId = null;
      } else if (status.status === "CANCELLED") {
        if (side === "UP") w.upBidOrderId = null; else w.downBidOrderId = null;
      }
    }
  }
}

registerTactic("conviction", () => new ConvictionTactic());
