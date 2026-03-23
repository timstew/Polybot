/**
 * Certainty Tactic — late-window taker sweeps.
 *
 * Only acts when P_true > min_p_true (0.85 default). Sweeps the winning
 * side's asks with FAK orders. Single-sided, holds to resolution.
 * Designed for the final 30-60s of a window when outcome is near-certain.
 *
 * Uses the P_true calculation from price-feed (Black-Scholes style)
 * based on spot price, strike price, volatility, and time remaining.
 */

import type { WindowTactic, TacticContext } from "./tactic";
import { registerTactic, recordFill, getBestAsk } from "./tactic";
import { calcFeePerShare, CRYPTO_FEES, type FeeParams } from "../categories";
import {
  calculatePTrue, realtimeVolatility,
  parseStrikePrice, parseStrikeDirection,
} from "./price-feed";
import type { RegimeType } from "./regime";

interface CertaintyParams {
  min_p_true: number;
  max_price: number;
  min_ev_per_share: number;
  min_edge_pct: number;
  max_shares_per_sweep: number;
  min_time_remaining_ms: number;
  fee_params: FeeParams;
}

const DEFAULTS: CertaintyParams = {
  min_p_true: 0.85,
  max_price: 0.95,
  min_ev_per_share: 0.001,
  min_edge_pct: 0.01,
  max_shares_per_sweep: 50,
  min_time_remaining_ms: 10_000,
  fee_params: CRYPTO_FEES,
};

class CertaintyTactic implements WindowTactic {
  readonly id = "certainty";
  readonly displayName = "Certainty Taker";
  readonly description = "Late-window taker: sweeps asks when P_true > 85%. High confidence, single-sided.";
  readonly naturalRegimes: RegimeType[] = ["late-window", "near-strike"];
  readonly defaultParams: Record<string, unknown> = { ...DEFAULTS };

  onEnter(tc: TacticContext): void {
    tc.window.tacticState = {
      totalSweepCost: 0,
      totalSweepShares: 0,
      sweepSide: null as "UP" | "DOWN" | null,
      lastPTrue: 0,
    };
  }

  async onTick(tc: TacticContext): Promise<void> {
    const { ctx, window: w, signal, priceHistory } = tc;
    const p = { ...DEFAULTS, ...tc.params } as CertaintyParams;
    const ts = w.tacticState as { totalSweepCost: number; totalSweepShares: number; sweepSide: "UP" | "DOWN" | null; lastPTrue: number };
    const now = Date.now();
    const timeLeft = w.windowEndTime - now;

    // Don't sweep too close to expiry
    if (timeLeft < p.min_time_remaining_ms) {
      w.tickAction = `Too close to expiry (${Math.round(timeLeft / 1000)}s left)`;
      return;
    }

    // Calculate P_true
    const strikePrice = parseStrikePrice(w.market.title);
    const strikeDir = parseStrikeDirection(w.market.title);
    if (!strikePrice || strikePrice <= 0 || signal.currentPrice <= 0) {
      w.tickAction = "No strike price — cannot compute P_true";
      return;
    }

    const vol = Math.max(realtimeVolatility(priceHistory, 60), 0.001);
    const pTrue = calculatePTrue(signal.currentPrice, strikePrice, strikeDir ?? "above", timeLeft, vol);
    ts.lastPTrue = pTrue;

    // Determine winning side
    const winningSide: "UP" | "DOWN" = pTrue > 0.5 ? "UP" : "DOWN";
    const certainty = winningSide === "UP" ? pTrue : 1 - pTrue;

    if (certainty < p.min_p_true) {
      w.tickAction = `P_true=${(certainty * 100).toFixed(0)}% < ${(p.min_p_true * 100).toFixed(0)}% threshold`;
      return;
    }

    // Already swept the other side? Don't switch.
    if (ts.sweepSide && ts.sweepSide !== winningSide) {
      w.tickAction = `Holding ${ts.sweepSide} — P_true flipped, won't switch`;
      return;
    }
    ts.sweepSide = winningSide;

    // Get order book
    const tokenId = winningSide === "UP" ? w.market.upTokenId : w.market.downTokenId;
    const book = await ctx.api.getBook(tokenId);
    const bestAsk = getBestAsk(book);
    if (bestAsk === null || bestAsk > p.max_price) {
      w.tickAction = `${winningSide} P=${(certainty * 100).toFixed(0)}% — no asks below ${p.max_price}`;
      return;
    }

    // Check if already holding enough
    const currentInv = winningSide === "UP" ? w.upInventory : w.downInventory;
    if (currentInv >= p.max_shares_per_sweep) {
      w.tickAction = `Holding ${currentInv} ${winningSide} — max position`;
      return;
    }

    // EV filter
    const ev = certainty * 1.0 - bestAsk; // expect $1 payout on win
    const evPerShare = ev;
    const edgePct = bestAsk > 0 ? ev / bestAsk : 0;
    if (evPerShare < p.min_ev_per_share || edgePct < p.min_edge_pct) {
      w.tickAction = `${winningSide} P=${(certainty * 100).toFixed(0)}% ask=${bestAsk.toFixed(2)} EV too low`;
      return;
    }

    // Sweep
    const sweepSize = Math.min(p.max_shares_per_sweep - currentInv, 50);
    if (sweepSize <= 0) return;

    const result = await ctx.api.placeOrder({
      token_id: tokenId, side: "BUY", price: bestAsk, size: sweepSize,
      market: w.market.slug, title: `${w.market.title} [ORCH CERTAINTY ${winningSide}]`,
    });

    if (result.status === "filled" || result.status === "placed") {
      const fillSize = result.size || sweepSize;
      const fillPrice = result.price || bestAsk;
      recordFill(w, winningSide, fillSize, fillPrice);
      ts.totalSweepCost += fillSize * fillPrice;
      ts.totalSweepShares += fillSize;

      const fee = calcFeePerShare(fillPrice, p.fee_params) * fillSize;
      ctx.log(`SWEEP ${winningSide} [certainty]: ${w.market.title.slice(0, 25)} ${fillSize}@${fillPrice.toFixed(3)} P=${(certainty * 100).toFixed(0)}%`);
      await ctx.db.prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
      ).bind(
        `orch-cert-${crypto.randomUUID()}`, ctx.config.id,
        tokenId, w.market.slug, `${w.market.title} [ORCH CERT ${winningSide}]`,
        fillPrice, fillSize, fee
      ).run();
    }

    const inv = winningSide === "UP" ? w.upInventory : w.downInventory;
    w.tickAction = `${winningSide} P=${(certainty * 100).toFixed(0)}% swept ${inv} shares`;
  }

  async onWindDown(tc: TacticContext): Promise<void> {
    const { window: w } = tc;
    const inv = w.upInventory + w.downInventory;
    w.tickAction = inv > 0 ? `Holding ${inv} to resolution` : "No position";
  }

  async onExit(tc: TacticContext): Promise<void> {
    await this.onWindDown(tc);
  }

  async onCancel(tc: TacticContext): Promise<void> {
    // Taker-only: no resting orders to cancel
    const { window: w } = tc;
    if (w.upBidOrderId) { await tc.ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
    if (w.downBidOrderId) { await tc.ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
  }
}

registerTactic("certainty", () => new CertaintyTactic());
