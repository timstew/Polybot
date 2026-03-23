/**
 * Directional Maker Tactic — signal-biased market making.
 *
 * Extracted from unified-adaptive maker path. Uses signal-derived fair value
 * for pricing, conviction-biased bid sizing, sells losing-side inventory on
 * direction flips.
 */

import type { WindowTactic, TacticContext, WindowState } from "./tactic";
import { registerTactic, recordFill, safeCancelAndRecord, getBestBid } from "./tactic";
import { safeCancelOrder } from "../strategy";
import { calcFeePerShare, CRYPTO_FEES, type FeeParams } from "../categories";
import { computeSignal, fetchSpotPrice } from "./price-feed";
import type { RegimeType } from "./regime";

interface MakerParams {
  maker_bid_offset: number;
  maker_max_pair_cost: number;
  min_bid_size: number;
  max_bid_size: number;
  default_bid_size: number;
  conviction_bias: number;
  min_signal_strength: number;
  max_flips_per_window: number;
  max_inventory_ratio: number;
  requote_threshold_pct: number;
  fee_params: FeeParams;
}

const MAKER_DEFAULTS: MakerParams = {
  maker_bid_offset: 0.02,
  maker_max_pair_cost: 0.93,
  min_bid_size: 10,
  max_bid_size: 200,
  default_bid_size: 30,
  conviction_bias: 2.0,
  min_signal_strength: 0.25,
  max_flips_per_window: 3,
  max_inventory_ratio: 2,
  requote_threshold_pct: 0.05,
  fee_params: CRYPTO_FEES,
};

class DirectionalMakerTactic implements WindowTactic {
  readonly id = "directional-maker";
  readonly displayName = "Directional Maker";
  readonly description = "Signal-biased market making: conviction-sized bids, sells losing side on flips";
  readonly naturalRegimes: RegimeType[] = ["trending"];
  readonly defaultParams: Record<string, unknown> = { ...MAKER_DEFAULTS };

  onEnter(tc: TacticContext): void {
    const { signal } = tc;
    const p = { ...MAKER_DEFAULTS, ...tc.params } as MakerParams;
    const convictionSide = signal.signalStrength >= p.min_signal_strength ? signal.direction : null;
    tc.window.confirmedDirection = convictionSide;
    tc.window.tacticState = {
      bidSize: (tc.params.default_bid_size as number) ?? MAKER_DEFAULTS.default_bid_size,
      lastSignalDirection: convictionSide,
      lastQuotedPriceChangePct: signal.priceChangePct,
      convictionSide,
      signalStrengthAtEntry: signal.signalStrength,
    };
  }

  async onTick(tc: TacticContext): Promise<void> {
    const { ctx, window: w, signal } = tc;
    const p = { ...MAKER_DEFAULTS, ...tc.params } as MakerParams;

    // Check fills
    await this.checkFills(tc, p);

    // Update quotes
    await this.updateQuotes(tc, p);

    // Per-tick heavy-side cancellation
    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const effBidSize = Math.max(p.min_bid_size, Math.round(
      ((tc.window.tacticState as { bidSize: number }).bidSize) * Math.min(1.0, (wDurMs / 60_000) / 15)
    ));
    const maxInvR = p.max_inventory_ratio;
    if (w.upBidOrderId) {
      const cancel = (w.upInventory >= effBidSize && w.downInventory === 0) ||
        (w.downInventory > 0 && w.upInventory / w.downInventory > maxInvR);
      if (cancel) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
    }
    if (w.downBidOrderId) {
      const cancel = (w.downInventory >= effBidSize && w.upInventory === 0) ||
        (w.upInventory > 0 && w.downInventory / w.upInventory > maxInvR);
      if (cancel) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
    }
  }

  async onWindDown(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    const p = { ...MAKER_DEFAULTS, ...tc.params } as MakerParams;
    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");
    await this.sellLosing(tc, p, "WIND DOWN");
    const up = w.upInventory, dn = w.downInventory;
    const pc = (up > 0 && dn > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
    w.tickAction = `Stop: holding ${up}↑/${dn}↓${pc}`;
  }

  async onExit(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    const p = { ...MAKER_DEFAULTS, ...tc.params } as MakerParams;
    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");
    await this.sellLosing(tc, p, "DUMP");
    w.tickAction = "Exiting: sell losing side";
  }

  async onCancel(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
    if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
  }

  // ── Internal ──

  private async checkFills(tc: TacticContext, p: MakerParams): Promise<void> {
    const { ctx, window: w } = tc;
    for (const side of ["UP", "DOWN"] as const) {
      const orderId = side === "UP" ? w.upBidOrderId : w.downBidOrderId;
      if (!orderId) continue;
      const status = await ctx.api.getOrderStatus(orderId);
      if (status.status === "MATCHED") {
        recordFill(w, side, status.size_matched, status.price);
        const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
        ctx.log(`FILL ${side} [maker]: ${w.market.title.slice(0, 25)} ${status.size_matched}@${status.price.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`);
        const fee = calcFeePerShare(status.price, p.fee_params) * status.size_matched;
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        ).bind(
          `orch-m${side.toLowerCase()}-${crypto.randomUUID()}`, ctx.config.id,
          tokenId, w.market.slug, `${w.market.title} [ORCH MAKER ${side}]`,
          status.price, status.size_matched, fee
        ).run();
        if (side === "UP") w.upBidOrderId = null;
        else w.downBidOrderId = null;
      } else if (status.status === "CANCELLED") {
        if (side === "UP") w.upBidOrderId = null;
        else w.downBidOrderId = null;
      }
    }
  }

  private async updateQuotes(tc: TacticContext, p: MakerParams): Promise<void> {
    const { ctx, window: w, signal } = tc;
    const ts = w.tacticState as {
      bidSize: number;
      lastSignalDirection: "UP" | "DOWN" | null;
      lastQuotedPriceChangePct: number;
      convictionSide: "UP" | "DOWN" | null;
    };
    const now = Date.now();
    const pairCost = p.maker_max_pair_cost;

    // Detect confirmed direction flip
    const confirmedFlip = w.confirmedDirection !== null
      && signal.direction !== w.confirmedDirection
      && !signal.inDeadZone;
    if (confirmedFlip) {
      w.flipCount++;
      ctx.log(
        `FLIP #${w.flipCount} [maker]: ${w.market.title.slice(0, 25)} ${w.confirmedDirection} -> ${signal.direction}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: signal.direction, signalStrength: signal.signalStrength, flipCount: w.flipCount, phase: "flip" }
      );
      w.confirmedDirection = signal.direction;
      w.lastDirectionChangeAt = now;
    } else if (w.confirmedDirection === null) {
      w.confirmedDirection = signal.direction;
    }

    // Max flips: stop quoting
    if (w.flipCount > p.max_flips_per_window) {
      await safeCancelAndRecord(ctx.api, w, "UP");
      await safeCancelAndRecord(ctx.api, w, "DOWN");
      w.tickAction = `Sat out: choppy (${w.flipCount} flips)`;
      return;
    }

    // Check if requote needed
    const directionChanged = confirmedFlip;
    const priceMoved = Math.abs(signal.priceChangePct - ts.lastQuotedPriceChangePct) > p.requote_threshold_pct;
    if (!directionChanged && !priceMoved && w.lastQuotedAt !== 0) {
      const up = w.upInventory, dn = w.downInventory;
      const pc = (up > 0 && dn > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
      w.tickAction = `${signal.direction} ${(signal.signalStrength * 100).toFixed(0)}% → no requote${pc}`;
      return;
    }

    // Cancel existing bids
    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");

    // On flip, sell losing side
    if (directionChanged && signal.signalStrength >= p.min_signal_strength) {
      await this.sellLosing(tc, p, "FLIP SELL");
    }

    // Periodic rebalance
    if (!directionChanged && signal.signalStrength >= 0.5) {
      const losingSide = signal.direction === "UP" ? "DOWN" : "UP";
      const losingInv = losingSide === "UP" ? w.upInventory : w.downInventory;
      if (losingInv > 0) await this.sellLosing(tc, p, "REBALANCE");
    }

    // Conviction-biased sizes
    const convictionSide = signal.signalStrength >= p.min_signal_strength ? signal.direction : null;
    const strengthRange = 1.0 - p.min_signal_strength;
    const strengthFraction = strengthRange > 0
      ? Math.min(1.0, (signal.signalStrength - p.min_signal_strength) / strengthRange) : 0;
    const scaledBias = 1.0 + (p.conviction_bias - 1.0) * strengthFraction;
    const adjustedBias = scaledBias * signal.confidenceMultiplier;

    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);
    const effectiveBaseSize = Math.max(p.min_bid_size, Math.round(ts.bidSize * durationScale));
    let upBidSize = effectiveBaseSize;
    let downBidSize = effectiveBaseSize;

    const clampedBias = Math.min(adjustedBias, 2.0);
    if (convictionSide === "UP") {
      upBidSize = Math.round(effectiveBaseSize * clampedBias);
      downBidSize = Math.max(Math.round(effectiveBaseSize * 0.5), Math.round(effectiveBaseSize / clampedBias));
    } else if (convictionSide === "DOWN") {
      downBidSize = Math.round(effectiveBaseSize * clampedBias);
      upBidSize = Math.max(Math.round(effectiveBaseSize * 0.5), Math.round(effectiveBaseSize / clampedBias));
    }

    // One-sided cap
    const maxOneSide = effectiveBaseSize;
    if (w.downInventory === 0) upBidSize = Math.min(upBidSize, Math.max(0, maxOneSide - w.upInventory));
    if (w.upInventory === 0) downBidSize = Math.min(downBidSize, Math.max(0, maxOneSide - w.downInventory));

    // Inventory ratio check
    if (w.upInventory > 0 && w.downInventory > 0) {
      if (w.upInventory / w.downInventory > p.max_inventory_ratio) upBidSize = 0;
      if (w.downInventory / w.upInventory > p.max_inventory_ratio) downBidSize = 0;
    } else if (w.upInventory >= effectiveBaseSize && w.downInventory === 0) {
      upBidSize = 0;
    } else if (w.downInventory >= effectiveBaseSize && w.upInventory === 0) {
      downBidSize = 0;
    }

    // Signal-derived pricing
    const dirSign = signal.direction === "UP" ? 1 : -1;
    const fairUp = Math.max(0.05, Math.min(0.95, 0.50 + signal.signalStrength * 0.20 * dirSign));
    const fairDown = 1.0 - fairUp;

    const rawUpBid = Math.max(0.01, fairUp - p.maker_bid_offset);
    const rawDnBid = Math.max(0.01, fairDown - p.maker_bid_offset);

    let upBid = w.downInventory > 0 ? Math.min(rawUpBid, pairCost - w.downAvgCost) : rawUpBid;
    let dnBid = w.upInventory > 0 ? Math.min(rawDnBid, pairCost - w.upAvgCost) : rawDnBid;

    if (upBid + dnBid > pairCost) {
      const sc = pairCost / (upBid + dnBid);
      upBid *= sc;
      dnBid *= sc;
    }
    upBid = Math.max(0.01, upBid);
    dnBid = Math.max(0.01, dnBid);

    // Place bids
    if (upBidSize > 0) {
      const roundedBid = Math.floor(upBid * 100) / 100;
      const result = await ctx.api.placeOrder({
        token_id: w.market.upTokenId, side: "BUY", size: upBidSize, price: roundedBid,
        market: w.market.slug, title: `${w.market.title} [ORCH MAKER UP bid]`,
      });
      if (result.status === "placed") { w.upBidOrderId = result.order_id; w.upBidPrice = roundedBid; w.upBidSize = upBidSize; }
      else if (result.status === "filled") {
        recordFill(w, "UP", result.size, result.price);
        const fee = calcFeePerShare(result.price, p.fee_params) * result.size;
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        ).bind(
          `orch-mup-imm-${crypto.randomUUID()}`, ctx.config.id, w.market.upTokenId, w.market.slug,
          `${w.market.title} [ORCH MAKER UP imm]`, result.price, result.size, fee
        ).run();
      }
    }

    if (downBidSize > 0) {
      const roundedBid = Math.floor(dnBid * 100) / 100;
      const result = await ctx.api.placeOrder({
        token_id: w.market.downTokenId, side: "BUY", size: downBidSize, price: roundedBid,
        market: w.market.slug, title: `${w.market.title} [ORCH MAKER DN bid]`,
      });
      if (result.status === "placed") { w.downBidOrderId = result.order_id; w.downBidPrice = roundedBid; w.downBidSize = downBidSize; }
      else if (result.status === "filled") {
        recordFill(w, "DOWN", result.size, result.price);
        const fee = calcFeePerShare(result.price, p.fee_params) * result.size;
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        ).bind(
          `orch-mdn-imm-${crypto.randomUUID()}`, ctx.config.id, w.market.downTokenId, w.market.slug,
          `${w.market.title} [ORCH MAKER DN imm]`, result.price, result.size, fee
        ).run();
      }
    }

    ts.lastSignalDirection = signal.direction;
    w.lastQuotedAt = now;
    ts.lastQuotedPriceChangePct = signal.priceChangePct;
    ts.convictionSide = convictionSide;

    // Set tickAction
    const up = w.upInventory, dn = w.downInventory;
    const pc = (up > 0 && dn > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
    const str = (signal.signalStrength * 100).toFixed(0);
    const upB = w.upBidOrderId ? `▲${w.upBidPrice.toFixed(2)}` : "";
    const dnB = w.downBidOrderId ? `▼${w.downBidPrice.toFixed(2)}` : "";
    const bids = [upB, dnB].filter(Boolean).join(" ");
    w.tickAction = `${directionChanged ? "FLIP→" : ""}${signal.direction} ${str}% → ${bids}${pc}`;
  }

  private async sellLosing(tc: TacticContext, p: MakerParams, label: string): Promise<void> {
    const { ctx, window: w, signal, priceHistory } = tc;

    const losingSide = signal.direction === "UP" ? "DOWN" : "UP";
    const losingInv = losingSide === "UP" ? w.upInventory : w.downInventory;
    const losingAvgCost = losingSide === "UP" ? w.upAvgCost : w.downAvgCost;
    const losingTokenId = losingSide === "UP" ? w.market.upTokenId : w.market.downTokenId;
    if (losingInv <= 0) return;

    // Use real CLOB book for sell price
    const book = await ctx.api.getBook(losingTokenId);
    const bestBid = getBestBid(book);
    const dirSign = signal.direction === "UP" ? 1 : -1;
    const fairVal = Math.max(0.02, Math.min(0.98, 0.50 + signal.signalStrength * 0.20 * dirSign));
    const signalPrice = losingSide === "UP" ? fairVal : (1.0 - fairVal);
    const sellPrice = Math.max(0.01, bestBid ?? signalPrice);

    const result = await ctx.api.placeOrder({
      token_id: losingTokenId, side: "SELL", size: losingInv, price: sellPrice,
      market: w.market.slug, title: `${w.market.title} [ORCH ${label} ${losingSide}]`,
    });

    if (result.status === "filled" && result.size > 0) {
      const soldSize = result.size;
      const soldPrice = result.price;
      const sellFee = calcFeePerShare(soldPrice, p.fee_params) * soldSize;
      const sellPnl = soldSize * soldPrice - soldSize * losingAvgCost - sellFee;
      w.realizedSellPnl += sellPnl;
      w.sellCount++;
      if (losingSide === "UP") w.upInventory -= soldSize;
      else w.downInventory -= soldSize;

      ctx.log(`${label} ${losingSide} [maker]: ${w.market.title.slice(0, 25)} ${soldSize}@${soldPrice.toFixed(3)} pnl=$${sellPnl.toFixed(2)}`);
      await ctx.db.prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
      ).bind(
        `orch-msell-${crypto.randomUUID()}`, ctx.config.id, losingTokenId, w.market.slug,
        `${w.market.title} [ORCH ${label} ${losingSide}]`, soldPrice, soldSize, sellFee, sellPnl
      ).run();
    }
  }
}

registerTactic("directional-maker", () => new DirectionalMakerTactic());
