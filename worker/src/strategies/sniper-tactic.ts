/**
 * Sniper Tactic — direction-agnostic spread capture.
 *
 * Extracted from unified-adaptive sniper path. Places symmetric bids on both
 * sides, aiming for balanced UP/DOWN inventory where pair cost < max_pair_cost.
 * Sells excess when one side gets ahead. Pure spread profit.
 */

import type { WindowTactic, TacticContext, WindowState } from "./tactic";
import { registerTactic, recordFill, safeCancelAndRecord, getBestAsk, getBestBid } from "./tactic";
import { safeCancelOrder } from "../strategy";
import { calcFeePerShare, CRYPTO_FEES, type FeeParams } from "../categories";
import type { RegimeType } from "./regime";

interface SniperParams {
  bid_offset: number;
  max_pair_cost: number;
  min_bid_size: number;
  max_bid_size: number;
  default_bid_size: number;
  max_unmatched_ratio: number;
  sell_unmatched_after_ticks: number;
  max_inventory_ratio: number;
  fee_params: FeeParams;
}

const SNIPER_DEFAULTS: SniperParams = {
  bid_offset: 0.04,
  max_pair_cost: 0.92,
  min_bid_size: 10,
  max_bid_size: 200,
  default_bid_size: 30,
  max_unmatched_ratio: 1.3,
  sell_unmatched_after_ticks: 3,
  max_inventory_ratio: 2,
  fee_params: CRYPTO_FEES,
};

class SniperTactic implements WindowTactic {
  readonly id = "sniper";
  readonly displayName = "Spread Sniper";
  readonly description = "Direction-agnostic spread capture: symmetric bids, pair cost optimization";
  readonly naturalRegimes: RegimeType[] = ["oscillating", "calm", "late-window"];
  readonly defaultParams: Record<string, unknown> = { ...SNIPER_DEFAULTS };

  onEnter(tc: TacticContext): void {
    tc.window.tacticState = {
      unmatchedTicks: 0,
      rebalanceSold: false,
      bidSize: (tc.params.default_bid_size as number) ?? SNIPER_DEFAULTS.default_bid_size,
    };
  }

  async onTick(tc: TacticContext): Promise<void> {
    const { ctx, window: w, signal } = tc;
    const p = { ...SNIPER_DEFAULTS, ...tc.params } as SniperParams;
    const ts = w.tacticState as { unmatchedTicks: number; rebalanceSold: boolean; bidSize: number };

    // Check fills
    await this.checkFills(tc, p);

    // Rebalance check
    await this.rebalance(tc, p, ts);

    // If rebalance sold, stop quoting (market too one-sided)
    if (ts.rebalanceSold) {
      if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
      if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
      w.tickAction = "Poisoned: market too one-sided";
      return;
    }

    // Update quotes
    await this.updateQuotes(tc, p, ts);

    // Per-tick safety: cancel the heavy side's bid immediately
    if (w.upBidOrderId && w.upInventory > w.downInventory) {
      await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null;
    }
    if (w.downBidOrderId && w.downInventory > w.upInventory) {
      await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null;
    }

    // Ask-based safety: cancel bid on the cheaper side (likely loser)
    if (w.lastUpBestAsk > 0 && w.lastDnBestAsk > 0) {
      const askDiff = w.lastUpBestAsk - w.lastDnBestAsk;
      if (askDiff > 0.10 && w.downBidOrderId) {
        await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null;
      } else if (askDiff < -0.10 && w.upBidOrderId) {
        await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null;
      }
    }
  }

  async onWindDown(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    const p = { ...SNIPER_DEFAULTS, ...tc.params } as SniperParams;
    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");
    if (ctx.config.mode !== "real") await this.sellExcess(tc, p, "WIND DOWN");
    const pc = (w.upInventory > 0 && w.downInventory > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
    w.tickAction = `Stop: holding ${w.upInventory}↑/${w.downInventory}↓${pc}`;
  }

  async onExit(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    const p = { ...SNIPER_DEFAULTS, ...tc.params } as SniperParams;
    await safeCancelAndRecord(ctx.api, w, "UP");
    await safeCancelAndRecord(ctx.api, w, "DOWN");
    if (ctx.config.mode !== "real") await this.sellExcess(tc, p, "EXIT");
    w.tickAction = "Exiting: sell excess before close";
  }

  async onCancel(tc: TacticContext): Promise<void> {
    const { ctx, window: w } = tc;
    if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
    if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
  }

  // ── Internal ──

  private async checkFills(tc: TacticContext, p: SniperParams): Promise<void> {
    const { ctx, window: w } = tc;
    // Paper mode: unified fill detection via PaperStrategyAPI
    if (w.upBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.upBidOrderId);
      if (status.status === "MATCHED") {
        recordFill(w, "UP", status.size_matched, status.price);
        ctx.log(`FILL UP [sniper]: ${w.market.title.slice(0, 25)} ${status.size_matched}@${status.price.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`);
        await this.persistFill(ctx, w, "UP", w.market.upTokenId, status.size_matched, status.price, p);
        w.upBidOrderId = null;
      } else if (status.status === "CANCELLED") { w.upBidOrderId = null; }
    }
    if (w.downBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.downBidOrderId);
      if (status.status === "MATCHED") {
        recordFill(w, "DOWN", status.size_matched, status.price);
        ctx.log(`FILL DN [sniper]: ${w.market.title.slice(0, 25)} ${status.size_matched}@${status.price.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`);
        await this.persistFill(ctx, w, "DOWN", w.market.downTokenId, status.size_matched, status.price, p);
        w.downBidOrderId = null;
      } else if (status.status === "CANCELLED") { w.downBidOrderId = null; }
    }
  }

  private async persistFill(
    ctx: TacticContext["ctx"], w: WindowState, side: string, tokenId: string,
    size: number, price: number, p: SniperParams,
  ): Promise<void> {
    const fee = calcFeePerShare(price, p.fee_params) * size;
    await ctx.db.prepare(
      `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
       VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
    ).bind(
      `orch-s${side.toLowerCase()}-${crypto.randomUUID()}`, ctx.config.id,
      tokenId, w.market.slug, `${w.market.title} [ORCH SNIPER ${side}]`, price, size, fee
    ).run();
  }

  private async rebalance(
    tc: TacticContext, p: SniperParams,
    ts: { unmatchedTicks: number; rebalanceSold: boolean; bidSize: number },
  ): Promise<void> {
    const { ctx, window: w } = tc;
    if (ts.rebalanceSold) return;

    const { upInventory, downInventory } = w;
    if (upInventory === 0 && downInventory === 0) { ts.unmatchedTicks = 0; return; }

    const minSide = Math.min(upInventory, downInventory);
    const maxSide = Math.max(upInventory, downInventory);
    if (minSide > 0 && maxSide / minSide <= p.max_unmatched_ratio) { ts.unmatchedTicks = 0; return; }
    ts.unmatchedTicks++;
    if (ts.unmatchedTicks < p.sell_unmatched_after_ticks) return;

    const heavySide = upInventory > downInventory ? "UP" : "DOWN";
    const targetHeavy = minSide > 0 ? Math.ceil(minSide * p.max_unmatched_ratio) : 0;
    const excess = maxSide - targetHeavy;
    if (excess < 5) return;

    const tokenId = heavySide === "UP" ? w.market.upTokenId : w.market.downTokenId;
    const book = await ctx.api.getBook(tokenId);
    const bestBid = getBestBid(book);
    const sellPrice = bestBid !== null ? bestBid * 0.97 : 0.48;
    const avgCost = heavySide === "UP" ? w.upAvgCost : w.downAvgCost;
    const sellPnl = (sellPrice - avgCost) * excess;

    if (heavySide === "UP") w.upInventory -= excess;
    else w.downInventory -= excess;
    w.realizedSellPnl += sellPnl;
    w.sellCount++;
    ts.unmatchedTicks = 0;
    ts.rebalanceSold = true;

    ctx.log(
      `REBAL ${heavySide} [sniper]: ${w.market.title.slice(0, 25)} ${excess}@${sellPrice.toFixed(3)} pnl=${sellPnl >= 0 ? "+" : ""}${sellPnl.toFixed(2)} inv=${w.upInventory}/${w.downInventory}`,
      { level: "signal", symbol: w.cryptoSymbol, phase: "rebalance" }
    );
    const sellFee = calcFeePerShare(sellPrice, p.fee_params) * excess;
    await ctx.db.prepare(
      `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
       VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
    ).bind(
      `orch-srebal-${crypto.randomUUID()}`, ctx.config.id, tokenId, w.market.slug,
      `${w.market.title} [ORCH REBAL ${heavySide}]`, sellPrice, excess, sellFee, sellPnl
    ).run();
  }

  private async updateQuotes(tc: TacticContext, p: SniperParams, ts: { bidSize: number }): Promise<void> {
    const { ctx, window: w, signal } = tc;

    // Duration-scaled bid size
    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);
    const effectiveBidSize = Math.max(p.min_bid_size, Math.round(ts.bidSize * durationScale));

    let upBidSize = effectiveBidSize;
    let downBidSize = effectiveBidSize;

    // Strict inventory balance: never let either side get more than one bid ahead
    const excess = w.upInventory - w.downInventory;
    if (excess > 0) upBidSize = 0;
    if (excess < 0) downBidSize = 0;

    // Book-aware pricing
    const upBook = await ctx.api.getBook(w.market.upTokenId);
    const dnBook = await ctx.api.getBook(w.market.downTokenId);
    const upBestAsk = getBestAsk(upBook);
    const dnBestAsk = getBestAsk(dnBook);

    if (upBestAsk !== null) w.lastUpBestAsk = upBestAsk;
    if (dnBestAsk !== null) w.lastDnBestAsk = dnBestAsk;

    let upBid = (upBestAsk ?? 0.50) - p.bid_offset;
    let dnBid = (dnBestAsk ?? 0.50) - p.bid_offset;

    // Cross-fill guard: cap bids to maintain pair cost
    if (w.downInventory > 0) upBid = Math.min(upBid, p.max_pair_cost - w.downAvgCost);
    if (w.upInventory > 0) dnBid = Math.min(dnBid, p.max_pair_cost - w.upAvgCost);

    if (upBid + dnBid > p.max_pair_cost) {
      const scale = p.max_pair_cost / (upBid + dnBid);
      upBid *= scale;
      dnBid *= scale;
    }
    upBid = Math.max(0.01, upBid);
    dnBid = Math.max(0.01, dnBid);

    // Ask imbalance gate
    if (w.lastUpBestAsk > 0 && w.lastDnBestAsk > 0) {
      const askImbalance = Math.abs(w.lastUpBestAsk - w.lastDnBestAsk);
      if (askImbalance > 0.15) {
        if (w.lastUpBestAsk > w.lastDnBestAsk) upBidSize = 0;
        else downBidSize = 0;
      }
    }

    // Skip bids too low or crossing spread
    if (upBid < 0.02) upBidSize = 0;
    if (dnBid < 0.02) downBidSize = 0;
    if (w.lastUpBestAsk > 0 && upBid >= w.lastUpBestAsk) upBidSize = 0;
    if (w.lastDnBestAsk > 0 && dnBid >= w.lastDnBestAsk) downBidSize = 0;

    // Place UP bid
    if (upBidSize > 0) {
      if (w.upBidOrderId && Math.abs(w.upBidPrice - upBid) > 0.005) {
        await safeCancelAndRecord(ctx.api, w, "UP");
      }
      if (!w.upBidOrderId) {
        const result = await ctx.api.placeOrder({ token_id: w.market.upTokenId, side: "BUY", price: upBid, size: upBidSize });
        if (result.status === "placed") { w.upBidOrderId = result.order_id; w.upBidPrice = upBid; w.upBidSize = upBidSize; }
      }
    } else if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }

    // Place DN bid
    if (downBidSize > 0) {
      if (w.downBidOrderId && Math.abs(w.downBidPrice - dnBid) > 0.005) {
        await safeCancelAndRecord(ctx.api, w, "DOWN");
      }
      if (!w.downBidOrderId) {
        const result = await ctx.api.placeOrder({ token_id: w.market.downTokenId, side: "BUY", price: dnBid, size: downBidSize });
        if (result.status === "placed") { w.downBidOrderId = result.order_id; w.downBidPrice = dnBid; w.downBidSize = downBidSize; }
      }
    } else if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }

    // Set tickAction
    const up = w.upInventory, dn = w.downInventory;
    const pc = (up > 0 && dn > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
    const upB = w.upBidOrderId ? `▲${w.upBidPrice.toFixed(2)}` : "";
    const dnB = w.downBidOrderId ? `▼${w.downBidPrice.toFixed(2)}` : "";
    const bids = [upB, dnB].filter(Boolean).join(" ");
    w.tickAction = bids ? `bid ${bids}${pc} inv=${up}/${dn}` : `no bids${pc} inv=${up}/${dn}`;
  }

  private async sellExcess(tc: TacticContext, p: SniperParams, label: string): Promise<void> {
    const { ctx, window: w } = tc;
    const { upInventory, downInventory } = w;
    if (upInventory === 0 && downInventory === 0) return;
    const matched = Math.min(upInventory, downInventory);

    for (const side of ["UP", "DOWN"] as const) {
      const inv = side === "UP" ? upInventory : downInventory;
      const excessAmt = inv - matched;
      if (excessAmt <= 0) continue;

      const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
      const book = await ctx.api.getBook(tokenId);
      const bestBid = getBestBid(book);
      const sellPrice = bestBid !== null ? bestBid * 0.97 : 0.48;
      const avgCost = side === "UP" ? w.upAvgCost : w.downAvgCost;
      const pnl = (sellPrice - avgCost) * excessAmt;

      if (side === "UP") w.upInventory -= excessAmt;
      else w.downInventory -= excessAmt;
      w.realizedSellPnl += pnl;
      w.sellCount++;

      ctx.log(`${label} ${side} [sniper]: ${w.market.title.slice(0, 25)} ${excessAmt}@${sellPrice.toFixed(3)} pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
      await ctx.db.prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, 0, datetime('now'), ?)`
      ).bind(
        `orch-ssell-${crypto.randomUUID()}`, ctx.config.id, tokenId, w.market.slug,
        `${w.market.title} [ORCH ${label} ${side}]`, sellPrice, excessAmt, pnl
      ).run();
    }
  }
}

registerTactic("sniper", () => new SniperTactic());
