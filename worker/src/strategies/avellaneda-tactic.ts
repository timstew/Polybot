/**
 * Avellaneda Tactic — Avellaneda-Stoikov style market making.
 *
 * Uses P_true + Delta for inventory-shaded reservation pricing.
 * Maker mode by default, switches to taker when P_true > threshold.
 * Delta kill gate: cancels all when delta sensitivity too high.
 *
 * Most sophisticated tactic, highest potential but needs tuning.
 */

import type { WindowTactic, TacticContext, WindowState } from "./tactic";
import { registerTactic, recordFill, safeCancelAndRecord, getBestAsk, getBestBid } from "./tactic";
import { calcFeePerShare, CRYPTO_FEES, type FeeParams } from "../categories";
import {
  calculatePTrue, calculateDelta, realtimeVolatility,
  parseStrikePrice, parseStrikeDirection,
} from "./price-feed";
import type { RegimeType } from "./regime";

interface AvellanedaParams {
  gamma: number;
  base_spread: number;
  max_pair_cost: number;
  min_bid_size: number;
  default_bid_size: number;
  max_inventory_per_side: number;
  // Taker mode
  maker_to_taker_threshold: number;
  taker_to_maker_threshold: number;
  max_taker_price: number;
  min_taker_ev: number;
  max_taker_shares: number;
  // Delta gates
  delta_kill_threshold: number;
  // Timing
  exit_buffer_ms: number;
  fee_params: FeeParams;
}

const DEFAULTS: AvellanedaParams = {
  gamma: 0.005,
  base_spread: 0.04,
  max_pair_cost: 0.96,
  min_bid_size: 10,
  default_bid_size: 30,
  max_inventory_per_side: 200,
  maker_to_taker_threshold: 0.86,
  taker_to_maker_threshold: 0.83,
  max_taker_price: 0.95,
  min_taker_ev: 0.001,
  max_taker_shares: 50,
  delta_kill_threshold: 5.0,
  exit_buffer_ms: 60_000,
  fee_params: CRYPTO_FEES,
};

class AvellanedaTactic implements WindowTactic {
  readonly id = "avellaneda";
  readonly displayName = "Avellaneda MM";
  readonly description = "Avellaneda-Stoikov: P_true reservation price, inventory shading, taker mode at high certainty";
  readonly naturalRegimes: RegimeType[] = ["volatile", "near-strike", "trending"];
  readonly defaultParams: Record<string, unknown> = { ...DEFAULTS };

  onEnter(tc: TacticContext): void {
    tc.window.tacticState = {
      regime: "maker" as "maker" | "taker" | "delta_kill",
      lastPTrue: 0.5,
      lastDelta: 0,
      takerShares: 0,
    };
  }

  async onTick(tc: TacticContext): Promise<void> {
    const { ctx, window: w, signal, priceHistory } = tc;
    const p = { ...DEFAULTS, ...tc.params } as AvellanedaParams;
    const ts = w.tacticState as { regime: string; lastPTrue: number; lastDelta: number; takerShares: number };
    const now = Date.now();
    const timeLeft = w.windowEndTime - now;

    // Check fills
    await this.checkFills(tc, p);

    // Calculate P_true and Delta
    const strikePrice = parseStrikePrice(w.market.title);
    const strikeDir = parseStrikeDirection(w.market.title);
    let pTrue = 0.5;
    let delta = 0;
    let normalizedDelta = 0;

    if (strikePrice && strikePrice > 0 && signal.currentPrice > 0) {
      const vol = Math.max(realtimeVolatility(priceHistory, 60), 0.001);
      const timeLeftMs = Math.max(1, timeLeft);
      pTrue = calculatePTrue(signal.currentPrice, strikePrice, strikeDir ?? "above", timeLeftMs, vol);
      delta = calculateDelta(signal.currentPrice, strikePrice, strikeDir ?? "above", timeLeftMs, vol);
      normalizedDelta = Math.abs(delta) * signal.currentPrice * 0.01;
    }
    ts.lastPTrue = pTrue;
    ts.lastDelta = normalizedDelta;

    // Delta kill gate
    if (normalizedDelta > p.delta_kill_threshold) {
      ts.regime = "delta_kill";
      if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
      if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
      w.tickAction = `Delta kill: |d|=${normalizedDelta.toFixed(1)} > ${p.delta_kill_threshold}`;
      return;
    }

    // Regime transitions
    const certainty = Math.max(pTrue, 1 - pTrue);
    if (ts.regime === "maker" && certainty > p.maker_to_taker_threshold) {
      // Time guard: don't switch to taker if too close to end
      if (timeLeft > p.exit_buffer_ms + 10_000) {
        ts.regime = "taker";
        if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
        if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
        ctx.log(`MODE→TAKER [avel]: P=${(certainty * 100).toFixed(0)}%`, { level: "signal", symbol: w.cryptoSymbol, phase: "taker" });
      }
    } else if ((ts.regime === "taker" || ts.regime === "delta_kill") && certainty < p.taker_to_maker_threshold) {
      ts.regime = "maker";
      ctx.log(`MODE→MAKER [avel]: P=${(certainty * 100).toFixed(0)}%`, { level: "signal", symbol: w.cryptoSymbol, phase: "maker" });
    }

    if (ts.regime === "taker") {
      await this.takerMode(tc, p, pTrue);
    } else {
      await this.makerMode(tc, p, pTrue, normalizedDelta);
    }
  }

  private async makerMode(tc: TacticContext, p: AvellanedaParams, pTrue: number, normDelta: number): Promise<void> {
    const { ctx, window: w, signal } = tc;

    // Inventory shading: q = upInventory - downInventory (net position)
    const q = w.upInventory - w.downInventory;
    // Reservation price = P_true - q * gamma
    const reservationUp = Math.max(0.02, Math.min(0.98, pTrue - q * p.gamma));
    const reservationDn = 1.0 - reservationUp;

    // Spread
    const spread = Math.max(p.base_spread, normDelta * 0.01);
    let upBid = Math.max(0.01, reservationUp - spread / 2);
    let dnBid = Math.max(0.01, reservationDn - spread / 2);

    // Cross-fill guard
    if (w.downInventory > 0) upBid = Math.min(upBid, p.max_pair_cost - w.downAvgCost);
    if (w.upInventory > 0) dnBid = Math.min(dnBid, p.max_pair_cost - w.upAvgCost);
    if (upBid + dnBid > p.max_pair_cost) {
      const sc = p.max_pair_cost / (upBid + dnBid);
      upBid *= sc; dnBid *= sc;
    }
    upBid = Math.max(0.01, upBid); dnBid = Math.max(0.01, dnBid);

    // Sizing (duration-scaled)
    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);
    const bidSize = Math.max(p.min_bid_size, Math.round(p.default_bid_size * durationScale));
    let upBidSize = w.upInventory < p.max_inventory_per_side ? bidSize : 0;
    let dnBidSize = w.downInventory < p.max_inventory_per_side ? bidSize : 0;

    // Inventory ratio control
    if (w.upInventory > 0 && w.downInventory > 0) {
      if (w.upInventory / w.downInventory > 2) upBidSize = 0;
      if (w.downInventory / w.upInventory > 2) dnBidSize = 0;
    }

    // Cancel and requote
    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");

    if (upBidSize > 0) {
      const r = await ctx.api.placeOrder({ token_id: w.market.upTokenId, side: "BUY", price: Math.floor(upBid * 100) / 100, size: upBidSize });
      if (r.status === "placed") { w.upBidOrderId = r.order_id; w.upBidPrice = Math.floor(upBid * 100) / 100; w.upBidSize = upBidSize; }
      else if (r.status === "filled") { recordFill(w, "UP", r.size, r.price); }
    }
    if (dnBidSize > 0) {
      const r = await ctx.api.placeOrder({ token_id: w.market.downTokenId, side: "BUY", price: Math.floor(dnBid * 100) / 100, size: dnBidSize });
      if (r.status === "placed") { w.downBidOrderId = r.order_id; w.downBidPrice = Math.floor(dnBid * 100) / 100; w.downBidSize = dnBidSize; }
      else if (r.status === "filled") { recordFill(w, "DOWN", r.size, r.price); }
    }

    w.lastQuotedAt = Date.now();
    const pc = (w.upInventory > 0 && w.downInventory > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
    const bids = [w.upBidOrderId ? `▲${w.upBidPrice.toFixed(2)}` : "", w.downBidOrderId ? `▼${w.downBidPrice.toFixed(2)}` : ""].filter(Boolean).join(" ");
    w.tickAction = `MAKER P=${(pTrue * 100).toFixed(0)}% q=${q} ${bids}${pc}`;
  }

  private async takerMode(tc: TacticContext, p: AvellanedaParams, pTrue: number): Promise<void> {
    const { ctx, window: w } = tc;
    const ts = w.tacticState as { takerShares: number };

    const winningSide: "UP" | "DOWN" = pTrue > 0.5 ? "UP" : "DOWN";
    const certainty = winningSide === "UP" ? pTrue : 1 - pTrue;
    const tokenId = winningSide === "UP" ? w.market.upTokenId : w.market.downTokenId;

    const currentInv = winningSide === "UP" ? w.upInventory : w.downInventory;
    if (currentInv >= p.max_taker_shares || ts.takerShares >= p.max_taker_shares) {
      w.tickAction = `TAKER ${winningSide} P=${(certainty * 100).toFixed(0)}% — max position`;
      return;
    }

    const book = await ctx.api.getBook(tokenId);
    const bestAsk = getBestAsk(book);
    if (bestAsk === null || bestAsk > p.max_taker_price) {
      w.tickAction = `TAKER ${winningSide} P=${(certainty * 100).toFixed(0)}% — no asks`;
      return;
    }

    const ev = certainty - bestAsk;
    if (ev < p.min_taker_ev) {
      w.tickAction = `TAKER ${winningSide} ask=${bestAsk.toFixed(2)} EV=${ev.toFixed(3)} too low`;
      return;
    }

    const sweepSize = Math.min(p.max_taker_shares - ts.takerShares, 30);
    const result = await ctx.api.placeOrder({ token_id: tokenId, side: "BUY", price: bestAsk, size: sweepSize });
    if (result.status === "filled" || result.status === "placed") {
      const fillSize = result.size || sweepSize;
      const fillPrice = result.price || bestAsk;
      recordFill(w, winningSide, fillSize, fillPrice);
      ts.takerShares += fillSize;

      const fee = calcFeePerShare(fillPrice, p.fee_params) * fillSize;
      ctx.log(`TAKER ${winningSide} [avel]: ${fillSize}@${fillPrice.toFixed(3)} P=${(certainty * 100).toFixed(0)}%`);
      await ctx.db.prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
      ).bind(
        `orch-avel-${crypto.randomUUID()}`, ctx.config.id, tokenId, w.market.slug,
        `${w.market.title} [ORCH AVEL TAKER ${winningSide}]`, fillPrice, fillSize, fee
      ).run();
    }

    w.tickAction = `TAKER ${winningSide} P=${(certainty * 100).toFixed(0)}% inv=${currentInv + (result.size || 0)}`;
  }

  async onWindDown(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");
    w.tickAction = `Wind-down: ${w.upInventory}↑/${w.downInventory}↓`;
  }

  async onExit(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");
    // Sell unmatched inventory in exit phase
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
    }
    w.tickAction = "Exit: dumped excess";
  }

  async onCancel(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
    if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
  }

  private async checkFills(tc: TacticContext, p: AvellanedaParams): Promise<void> {
    const { ctx, window: w } = tc;
    for (const side of ["UP", "DOWN"] as const) {
      const orderId = side === "UP" ? w.upBidOrderId : w.downBidOrderId;
      if (!orderId) continue;
      const status = await ctx.api.getOrderStatus(orderId);
      if (status.status === "MATCHED") {
        recordFill(w, side, status.size_matched, status.price);
        const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
        ctx.log(`FILL ${side} [avel]: ${status.size_matched}@${status.price.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`);
        const fee = calcFeePerShare(status.price, p.fee_params) * status.size_matched;
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        ).bind(
          `orch-avel${side.toLowerCase()}-${crypto.randomUUID()}`, ctx.config.id,
          tokenId, w.market.slug, `${w.market.title} [ORCH AVEL ${side}]`,
          status.price, status.size_matched, fee
        ).run();
        if (side === "UP") w.upBidOrderId = null; else w.downBidOrderId = null;
      } else if (status.status === "CANCELLED") {
        if (side === "UP") w.upBidOrderId = null; else w.downBidOrderId = null;
      }
    }
  }
}

registerTactic("avellaneda", () => new AvellanedaTactic());
