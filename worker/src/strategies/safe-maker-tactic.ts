/**
 * Safe Maker Tactic — paired-inventory protection.
 *
 * Like directional-maker but NEVER sells matched pairs. Only sells excess
 * beyond the matched amount. Balanced UP/DOWN pairs are structurally profitable
 * when pair cost < $1.00 — this tactic preserves that guarantee.
 */

import type { WindowTactic, TacticContext, WindowState } from "./tactic";
import { registerTactic, recordFill, safeCancelAndRecord, getBestBid } from "./tactic";
import { calcFeePerShare, CRYPTO_FEES, type FeeParams } from "../categories";
import type { RegimeType } from "./regime";

interface SafeMakerParams {
  bid_offset: number;
  max_pair_cost: number;
  min_bid_size: number;
  default_bid_size: number;
  conviction_bias: number;
  min_signal_strength: number;
  max_flips_per_window: number;
  max_inventory_ratio: number;
  requote_threshold_pct: number;
  fee_params: FeeParams;
}

const DEFAULTS: SafeMakerParams = {
  bid_offset: 0.02,
  max_pair_cost: 0.93,
  min_bid_size: 10,
  default_bid_size: 30,
  conviction_bias: 2.0,
  min_signal_strength: 0.45,
  max_flips_per_window: 3,
  max_inventory_ratio: 2,
  requote_threshold_pct: 0.05,
  fee_params: CRYPTO_FEES,
};

class SafeMakerTactic implements WindowTactic {
  readonly id = "safe-maker";
  readonly displayName = "Safe Maker";
  readonly description = "Signal-biased maker with paired-inventory protection — never sells matched pairs";
  readonly naturalRegimes: RegimeType[] = ["oscillating", "calm"];
  readonly defaultParams: Record<string, unknown> = { ...DEFAULTS };

  onEnter(tc: TacticContext): void {
    const p = { ...DEFAULTS, ...tc.params } as SafeMakerParams;
    const { signal } = tc;
    const convictionSide = signal.signalStrength >= p.min_signal_strength ? signal.direction : null;
    tc.window.confirmedDirection = convictionSide;
    tc.window.tacticState = {
      bidSize: (tc.params.default_bid_size as number) ?? DEFAULTS.default_bid_size,
      lastQuotedPriceChangePct: signal.priceChangePct,
      convictionSide,
    };
  }

  async onTick(tc: TacticContext): Promise<void> {
    const { ctx, window: w, signal } = tc;
    const p = { ...DEFAULTS, ...tc.params } as SafeMakerParams;

    // Check fills
    await this.checkFills(tc, p);

    // Update quotes
    await this.updateQuotes(tc, p);

    // Per-tick heavy-side cancellation
    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const effBidSize = Math.max(p.min_bid_size, Math.round(
      ((w.tacticState as { bidSize: number }).bidSize) * Math.min(1.0, (wDurMs / 60_000) / 15)
    ));
    if (w.upBidOrderId) {
      const cancel = (w.upInventory >= effBidSize && w.downInventory === 0) ||
        (w.downInventory > 0 && w.upInventory / w.downInventory > p.max_inventory_ratio);
      if (cancel) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
    }
    if (w.downBidOrderId) {
      const cancel = (w.downInventory >= effBidSize && w.upInventory === 0) ||
        (w.upInventory > 0 && w.downInventory / w.upInventory > p.max_inventory_ratio);
      if (cancel) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
    }
  }

  async onWindDown(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    const p = { ...DEFAULTS, ...tc.params } as SafeMakerParams;
    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");
    // Safe: only sell EXCESS beyond matched pairs
    if (ctx.config.mode !== "real") await this.sellExcess(tc, p, "WIND DOWN");
    w.tickAction = `Stop: ${w.upInventory}↑/${w.downInventory}↓ (pairs safe)`;
  }

  async onExit(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    const p = { ...DEFAULTS, ...tc.params } as SafeMakerParams;
    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");
    if (ctx.config.mode !== "real") await this.sellExcess(tc, p, "EXIT");
    w.tickAction = "Exiting: sell excess only (pairs safe)";
  }

  async onCancel(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
    if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
  }

  // ── Internal ──

  private async checkFills(tc: TacticContext, p: SafeMakerParams): Promise<void> {
    const { ctx, window: w } = tc;
    for (const side of ["UP", "DOWN"] as const) {
      const orderId = side === "UP" ? w.upBidOrderId : w.downBidOrderId;
      if (!orderId) continue;
      const status = await ctx.api.getOrderStatus(orderId);
      if (status.status === "MATCHED") {
        recordFill(w, side, status.size_matched, status.price);
        const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
        ctx.log(`FILL ${side} [safe]: ${w.market.title.slice(0, 25)} ${status.size_matched}@${status.price.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`);
        const fee = calcFeePerShare(status.price, p.fee_params) * status.size_matched;
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        ).bind(
          `orch-safe${side.toLowerCase()}-${crypto.randomUUID()}`, ctx.config.id,
          tokenId, w.market.slug, `${w.market.title} [ORCH SAFE ${side}]`,
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

  private async updateQuotes(tc: TacticContext, p: SafeMakerParams): Promise<void> {
    const { ctx, window: w, signal } = tc;
    const ts = w.tacticState as { bidSize: number; lastQuotedPriceChangePct: number; convictionSide: "UP" | "DOWN" | null };
    const now = Date.now();

    // Detect direction flip
    const confirmedFlip = w.confirmedDirection !== null
      && signal.direction !== w.confirmedDirection
      && !signal.inDeadZone;
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

    // On flip: sell only EXCESS (safe: never sell matched pairs)
    if (confirmedFlip && signal.signalStrength >= p.min_signal_strength) {
      await safeCancelAndRecord(ctx.api, w, "UP");
      await safeCancelAndRecord(ctx.api, w, "DOWN");
      await this.sellExcess(tc, p, "FLIP");
    }

    // Check requote
    const priceMoved = Math.abs(signal.priceChangePct - ts.lastQuotedPriceChangePct) > p.requote_threshold_pct;
    if (!confirmedFlip && !priceMoved && w.lastQuotedAt !== 0) {
      const pc = (w.upInventory > 0 && w.downInventory > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
      w.tickAction = `${signal.direction} ${(signal.signalStrength * 100).toFixed(0)}% → hold${pc}`;
      return;
    }

    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");

    // Conviction-biased sizes
    const convictionSide = signal.signalStrength >= p.min_signal_strength ? signal.direction : null;
    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);
    const effectiveBaseSize = Math.max(p.min_bid_size, Math.round(ts.bidSize * durationScale));
    let upBidSize = effectiveBaseSize;
    let downBidSize = effectiveBaseSize;

    const strengthFraction = p.min_signal_strength < 1
      ? Math.min(1.0, (signal.signalStrength - p.min_signal_strength) / (1 - p.min_signal_strength)) : 0;
    const bias = 1.0 + (p.conviction_bias - 1.0) * Math.max(0, strengthFraction);
    if (convictionSide === "UP") { upBidSize = Math.round(effectiveBaseSize * bias); downBidSize = Math.round(effectiveBaseSize / bias); }
    else if (convictionSide === "DOWN") { downBidSize = Math.round(effectiveBaseSize * bias); upBidSize = Math.round(effectiveBaseSize / bias); }

    // One-sided cap
    if (w.downInventory === 0) upBidSize = Math.min(upBidSize, Math.max(0, effectiveBaseSize - w.upInventory));
    if (w.upInventory === 0) downBidSize = Math.min(downBidSize, Math.max(0, effectiveBaseSize - w.downInventory));
    if (w.upInventory > 0 && w.downInventory > 0) {
      if (w.upInventory / w.downInventory > p.max_inventory_ratio) upBidSize = 0;
      if (w.downInventory / w.upInventory > p.max_inventory_ratio) downBidSize = 0;
    }

    // Signal-derived pricing
    const dirSign = signal.direction === "UP" ? 1 : -1;
    const fairUp = Math.max(0.05, Math.min(0.95, 0.50 + signal.signalStrength * 0.20 * dirSign));
    const fairDown = 1.0 - fairUp;
    let upBid = Math.max(0.01, fairUp - p.bid_offset);
    let dnBid = Math.max(0.01, fairDown - p.bid_offset);
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
    const bids = [w.upBidOrderId ? `▲${w.upBidPrice.toFixed(2)}` : "", w.downBidOrderId ? `▼${w.downBidPrice.toFixed(2)}` : ""].filter(Boolean).join(" ");
    w.tickAction = `${signal.direction} ${(signal.signalStrength * 100).toFixed(0)}% → ${bids}${pc}`;
  }

  /** Safe: only sell excess beyond matched pairs. Never touch the matched amount. */
  private async sellExcess(tc: TacticContext, p: SafeMakerParams, label: string): Promise<void> {
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
      w.realizedSellPnl += pnl;
      w.sellCount++;
      ctx.log(`${label} ${side} [safe]: ${excess}@${sellPrice.toFixed(3)} pnl=$${pnl.toFixed(2)}`);
      await ctx.db.prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, 0, datetime('now'), ?)`
      ).bind(
        `orch-safesell-${crypto.randomUUID()}`, ctx.config.id, tokenId, w.market.slug,
        `${w.market.title} [ORCH ${label} ${side}]`, sellPrice, excess, pnl
      ).run();
    }
  }
}

registerTactic("safe-maker", () => new SafeMakerTactic());
