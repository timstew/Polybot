/**
 * Enhanced Maker Tactic — Safe Maker + Avellaneda-style improvements.
 *
 * Three surgical enhancements over Safe Maker:
 * 1. Volatility-adaptive spread (EMA of realized vol)
 * 2. P_true-blended fair value (oracle + signal weighted)
 * 3. Delta-based regime gates (widen spread or pause entirely)
 *
 * All Safe Maker protections preserved: paired-inventory safety,
 * cross-fill guards, per-tick heavy-side cancellation.
 */

import type { WindowTactic, TacticContext, WindowState } from "./tactic";
import { registerTactic, recordFill, safeCancelAndRecord, getBestBid } from "./tactic";
import { calcFeePerShare, CRYPTO_FEES, type FeeParams } from "../categories";
import {
  calculatePTrue, calculateDelta, realtimeVolatility,
  parseStrikePrice, parseStrikeDirection,
} from "./price-feed";
import type { RegimeType } from "./regime";

interface EnhancedParams {
  bid_offset: number;
  max_pair_cost: number;
  min_bid_size: number;
  default_bid_size: number;
  conviction_bias: number;
  min_signal_strength: number;
  max_flips_per_window: number;
  max_inventory_ratio: number;
  requote_threshold_pct: number;
  // Enhanced features
  vol_spread_weight: number;
  vol_spread_floor: number;
  ptrue_blend_weight: number;
  delta_widen_threshold: number;
  delta_pause_threshold: number;
  delta_widen_multiplier: number;
  fee_params: FeeParams;
}

const DEFAULTS: EnhancedParams = {
  bid_offset: 0.02,
  max_pair_cost: 0.93,
  min_bid_size: 10,
  default_bid_size: 30,
  conviction_bias: 2.0,
  min_signal_strength: 0.45,
  max_flips_per_window: 3,
  max_inventory_ratio: 2,
  requote_threshold_pct: 0.05,
  vol_spread_weight: 0.5,
  vol_spread_floor: 0.01,
  ptrue_blend_weight: 0.3,
  delta_widen_threshold: 3.0,
  delta_pause_threshold: 5.0,
  delta_widen_multiplier: 2.0,
  fee_params: CRYPTO_FEES,
};

class EnhancedMakerTactic implements WindowTactic {
  readonly id = "enhanced";
  readonly displayName = "Enhanced Maker";
  readonly description = "Safe Maker + vol-adaptive spread, P_true blending, delta gates. Best all-rounder.";
  readonly naturalRegimes: RegimeType[] = ["volatile", "near-strike", "oscillating"];
  readonly defaultParams: Record<string, unknown> = { ...DEFAULTS };

  onEnter(tc: TacticContext): void {
    const { signal } = tc;
    const p = { ...DEFAULTS, ...tc.params } as EnhancedParams;
    const convictionSide = signal.signalStrength >= p.min_signal_strength ? signal.direction : null;
    tc.window.confirmedDirection = convictionSide;
    tc.window.tacticState = {
      bidSize: (tc.params.default_bid_size as number) ?? DEFAULTS.default_bid_size,
      lastQuotedPriceChangePct: signal.priceChangePct,
      convictionSide,
      deltaRegime: "quoting" as "quoting" | "delta_wide" | "delta_paused",
    };
  }

  async onTick(tc: TacticContext): Promise<void> {
    const { ctx, window: w, signal, priceHistory } = tc;
    const p = { ...DEFAULTS, ...tc.params } as EnhancedParams;
    const ts = w.tacticState as {
      bidSize: number; lastQuotedPriceChangePct: number;
      convictionSide: "UP" | "DOWN" | null; deltaRegime: string;
    };

    // Check fills
    await this.checkFills(tc, p);

    // Delta-based regime gates
    const strikePrice = parseStrikePrice(w.market.title);
    const strikeDir = parseStrikeDirection(w.market.title);
    let deltaRegime = "quoting";
    if (strikePrice && strikePrice > 0 && signal.currentPrice > 0) {
      const vol5m = realtimeVolatility(priceHistory, 60);
      const vol = Math.max(vol5m, 0.001);
      const timeLeftMs = Math.max(1, w.windowEndTime - Date.now());
      const delta = calculateDelta(signal.currentPrice, strikePrice, strikeDir ?? "above", timeLeftMs, vol);
      const normalizedDelta = Math.abs(delta) * signal.currentPrice * 0.01;
      if (normalizedDelta > p.delta_pause_threshold) deltaRegime = "delta_paused";
      else if (normalizedDelta > p.delta_widen_threshold) deltaRegime = "delta_wide";
    }
    ts.deltaRegime = deltaRegime;

    if (deltaRegime === "delta_paused") {
      if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
      if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
      w.tickAction = `Delta paused: too sensitive for quoting`;
      return;
    }

    // Update quotes with enhanced pricing
    await this.updateQuotes(tc, p, deltaRegime === "delta_wide");

    // Per-tick heavy-side cancellation
    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const effBidSize = Math.max(p.min_bid_size, Math.round(ts.bidSize * Math.min(1.0, (wDurMs / 60_000) / 15)));
    if (w.upBidOrderId) {
      if ((w.upInventory >= effBidSize && w.downInventory === 0) ||
        (w.downInventory > 0 && w.upInventory / w.downInventory > p.max_inventory_ratio)) {
        await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null;
      }
    }
    if (w.downBidOrderId) {
      if ((w.downInventory >= effBidSize && w.upInventory === 0) ||
        (w.upInventory > 0 && w.downInventory / w.upInventory > p.max_inventory_ratio)) {
        await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null;
      }
    }
  }

  async onWindDown(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    const p = { ...DEFAULTS, ...tc.params } as EnhancedParams;
    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");
    if (ctx.config.mode !== "real") await this.sellExcess(tc, p, "WIND DOWN");
    w.tickAction = `Stop: ${w.upInventory}↑/${w.downInventory}↓ (pairs safe)`;
  }

  async onExit(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    const p = { ...DEFAULTS, ...tc.params } as EnhancedParams;
    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");
    if (ctx.config.mode !== "real") await this.sellExcess(tc, p, "EXIT");
    w.tickAction = "Exiting (pairs safe)";
  }

  async onCancel(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
    if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
  }

  private async checkFills(tc: TacticContext, p: EnhancedParams): Promise<void> {
    const { ctx, window: w } = tc;
    for (const side of ["UP", "DOWN"] as const) {
      const orderId = side === "UP" ? w.upBidOrderId : w.downBidOrderId;
      if (!orderId) continue;
      const status = await ctx.api.getOrderStatus(orderId);
      if (status.status === "MATCHED") {
        recordFill(w, side, status.size_matched, status.price);
        const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
        ctx.log(`FILL ${side} [enhanced]: ${w.market.title.slice(0, 25)} ${status.size_matched}@${status.price.toFixed(3)}`);
        const fee = calcFeePerShare(status.price, p.fee_params) * status.size_matched;
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        ).bind(
          `orch-enh${side.toLowerCase()}-${crypto.randomUUID()}`, ctx.config.id,
          tokenId, w.market.slug, `${w.market.title} [ORCH ENH ${side}]`,
          status.price, status.size_matched, fee
        ).run();
        if (side === "UP") w.upBidOrderId = null; else w.downBidOrderId = null;
      } else if (status.status === "CANCELLED") {
        if (side === "UP") w.upBidOrderId = null; else w.downBidOrderId = null;
      }
    }
  }

  private async updateQuotes(tc: TacticContext, p: EnhancedParams, deltaWide: boolean): Promise<void> {
    const { ctx, window: w, signal, priceHistory } = tc;
    const ts = w.tacticState as { bidSize: number; lastQuotedPriceChangePct: number; convictionSide: "UP" | "DOWN" | null };
    const now = Date.now();

    // Direction flip
    const confirmedFlip = w.confirmedDirection !== null && signal.direction !== w.confirmedDirection && !signal.inDeadZone;
    if (confirmedFlip) {
      w.flipCount++;
      w.confirmedDirection = signal.direction;
      w.lastDirectionChangeAt = now;
    } else if (w.confirmedDirection === null) {
      w.confirmedDirection = signal.direction;
    }

    if (w.flipCount > p.max_flips_per_window) {
      await safeCancelAndRecord(ctx.api, w, "UP");
      await safeCancelAndRecord(ctx.api, w, "DOWN");
      w.tickAction = `Sat out: choppy (${w.flipCount} flips)`;
      return;
    }

    if (confirmedFlip && signal.signalStrength >= p.min_signal_strength) {
      await safeCancelAndRecord(ctx.api, w, "UP");
      await safeCancelAndRecord(ctx.api, w, "DOWN");
      await this.sellExcess(tc, p, "FLIP");
    }

    const priceMoved = Math.abs(signal.priceChangePct - ts.lastQuotedPriceChangePct) > p.requote_threshold_pct;
    if (!confirmedFlip && !priceMoved && w.lastQuotedAt !== 0) {
      const deltaTag = deltaWide ? " [wide]" : "";
      w.tickAction = `${signal.direction} ${(signal.signalStrength * 100).toFixed(0)}% → hold${deltaTag}`;
      return;
    }

    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");

    // Enhanced: volatility-adaptive offset
    const volRt = realtimeVolatility(priceHistory, 60);
    const volSpread = Math.max(p.vol_spread_floor, volRt * 100); // vol as %
    const effectiveOffset = (1 - p.vol_spread_weight) * p.bid_offset + p.vol_spread_weight * volSpread / 100;
    const offset = deltaWide ? effectiveOffset * p.delta_widen_multiplier : effectiveOffset;

    // Enhanced: P_true-blended fair value
    const dirSign = signal.direction === "UP" ? 1 : -1;
    const signalFair = 0.50 + signal.signalStrength * 0.20 * dirSign;
    const strikePrice = parseStrikePrice(w.market.title);
    const strikeDir = parseStrikeDirection(w.market.title);
    let fairUp = signalFair;
    if (strikePrice && strikePrice > 0 && signal.currentPrice > 0) {
      const vol5m = realtimeVolatility(priceHistory, 60);
      const vol = Math.max(vol5m, 0.001);
      const timeLeftMs2 = Math.max(1, w.windowEndTime - now);
      const pTrue = calculatePTrue(signal.currentPrice, strikePrice, strikeDir ?? "above", timeLeftMs2, vol);
      fairUp = (1 - p.ptrue_blend_weight) * signalFair + p.ptrue_blend_weight * pTrue;
    }
    fairUp = Math.max(0.05, Math.min(0.95, fairUp));
    const fairDown = 1.0 - fairUp;

    // Sizing
    const convictionSide = signal.signalStrength >= p.min_signal_strength ? signal.direction : null;
    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);
    const effectiveBaseSize = Math.max(p.min_bid_size, Math.round(ts.bidSize * durationScale));
    let upBidSize = deltaWide ? Math.round(effectiveBaseSize / p.delta_widen_multiplier) : effectiveBaseSize;
    let downBidSize = upBidSize;

    const strengthFraction = p.min_signal_strength < 1
      ? Math.min(1.0, (signal.signalStrength - p.min_signal_strength) / (1 - p.min_signal_strength)) : 0;
    const bias = 1.0 + (p.conviction_bias - 1.0) * Math.max(0, strengthFraction);
    if (convictionSide === "UP") { upBidSize = Math.round(upBidSize * bias); downBidSize = Math.round(downBidSize / bias); }
    else if (convictionSide === "DOWN") { downBidSize = Math.round(downBidSize * bias); upBidSize = Math.round(upBidSize / bias); }

    if (w.downInventory === 0) upBidSize = Math.min(upBidSize, Math.max(0, effectiveBaseSize - w.upInventory));
    if (w.upInventory === 0) downBidSize = Math.min(downBidSize, Math.max(0, effectiveBaseSize - w.downInventory));

    // Pricing
    let upBid = Math.max(0.01, fairUp - offset);
    let dnBid = Math.max(0.01, fairDown - offset);
    if (w.downInventory > 0) upBid = Math.min(upBid, p.max_pair_cost - w.downAvgCost);
    if (w.upInventory > 0) dnBid = Math.min(dnBid, p.max_pair_cost - w.upAvgCost);
    if (upBid + dnBid > p.max_pair_cost) { const sc = p.max_pair_cost / (upBid + dnBid); upBid *= sc; dnBid *= sc; }
    upBid = Math.max(0.01, upBid); dnBid = Math.max(0.01, dnBid);

    // Place bids
    if (upBidSize > 0) {
      const r = await ctx.api.placeOrder({ token_id: w.market.upTokenId, side: "BUY", price: Math.floor(upBid * 100) / 100, size: upBidSize });
      if (r.status === "placed") { w.upBidOrderId = r.order_id; w.upBidPrice = Math.floor(upBid * 100) / 100; w.upBidSize = upBidSize; }
      else if (r.status === "filled") { recordFill(w, "UP", r.size, r.price); }
    }
    if (downBidSize > 0) {
      const r = await ctx.api.placeOrder({ token_id: w.market.downTokenId, side: "BUY", price: Math.floor(dnBid * 100) / 100, size: downBidSize });
      if (r.status === "placed") { w.downBidOrderId = r.order_id; w.downBidPrice = Math.floor(dnBid * 100) / 100; w.downBidSize = downBidSize; }
      else if (r.status === "filled") { recordFill(w, "DOWN", r.size, r.price); }
    }

    w.lastQuotedAt = now;
    ts.lastQuotedPriceChangePct = signal.priceChangePct;
    ts.convictionSide = convictionSide;
    const pc = (w.upInventory > 0 && w.downInventory > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
    const deltaTag = deltaWide ? " [wide]" : "";
    w.tickAction = `${signal.direction} ${(signal.signalStrength * 100).toFixed(0)}%${deltaTag}${pc}`;
  }

  private async sellExcess(tc: TacticContext, p: EnhancedParams, label: string): Promise<void> {
    const { ctx, window: w } = tc;
    const matched = Math.min(w.upInventory, w.downInventory);
    for (const side of ["UP", "DOWN"] as const) {
      const inv = side === "UP" ? w.upInventory : w.downInventory;
      const excess = inv - matched;
      if (excess <= 0) continue;
      const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
      const book = await ctx.api.getBook(tokenId);
      const bestBid = getBestBid(book);
      const sellPrice = bestBid ?? 0.48;
      const avgCost = side === "UP" ? w.upAvgCost : w.downAvgCost;
      const pnl = (sellPrice - avgCost) * excess;
      if (side === "UP") w.upInventory -= excess; else w.downInventory -= excess;
      w.realizedSellPnl += pnl; w.sellCount++;
      ctx.log(`${label} ${side} [enhanced]: ${excess}@${sellPrice.toFixed(3)} pnl=$${pnl.toFixed(2)}`);
      await ctx.db.prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, 0, datetime('now'), ?)`
      ).bind(
        `orch-enhsell-${crypto.randomUUID()}`, ctx.config.id, tokenId, w.market.slug,
        `${w.market.title} [ORCH ${label} ${side}]`, sellPrice, excess, pnl
      ).run();
    }
  }
}

registerTactic("enhanced", () => new EnhancedMakerTactic());
