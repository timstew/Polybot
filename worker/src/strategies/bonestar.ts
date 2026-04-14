/**
 * BoneStar Strategy — Three-Phase Accumulation + Certainty Sweep
 *
 * Inspired by Bonereaper's 982-trade analysis across 11 active windows:
 *   Phase 1 (0–40%): Balanced accumulation — equal bids on both sides
 *   Phase 2 (40%+):  Directional conviction — skew sizing toward winning side
 *   Phase 3 (any):   Certainty sweep — massive sweep bid when P_true > threshold
 *
 * Key behavioral rules:
 *   - ZERO sells — every position held to resolution
 *   - Exit only via MERGE (pairs → $1.00) and REDEEM (winning excess → $1.00)
 *   - No stop-quoting — bids up to window end (late fills at $0.98 still profitable)
 *   - Phase transitions driven by oracle P_true, not market token prices
 */

import type { Strategy, StrategyContext, OrderBook } from "../strategy";
import { registerStrategy, safeCancelOrder } from "../strategy";
import { calcFeePerShare, CRYPTO_FEES, type FeeParams } from "../categories";
import {
  type CryptoMarket,
  type PriceSnapshot,
  type WindowSignal,
  type ComputeSignalOptions,
  fetchSpotPrice,
  computeSignal,
  extractCryptoSymbol,
  discoverCryptoMarkets,
  parseWindowDurationMs,
  checkMarketResolution,
  enableOrderFlow,
  disableOrderFlow,
  fetchOracleStrike,
  toOracleSymbol,
  toVariant,
  calculatePTrue,
  estimateVolatility5min,
  CRYPTO_SYMBOL_MAP,
} from "./price-feed";
// Merge is handled by the framework (autoMergeProfitablePairs in strategy.ts)
import { getOracleStrike as getOracleStrikeWs, isOracleConnected, getOracleSpot } from "./oracle-feed";
import { classifyRegime, computeRegimeFeatures } from "./regime";
import type { TickSnapshot, TapeBucket, TapeMeta } from "../optimizer/types";
import { fetchTradeTape } from "./price-feed";

// ── Types ────────────────────────────────────────────────────────────

export interface BoneStarParams {
  target_cryptos: string[];

  // Phase 1: Balanced accumulation
  base_bid_size: number;
  bid_offset: number;            // bid below fair value (unused when edge1/edge2 active)
  max_bid_per_side: number;      // hard cap on any single-side bid price
  min_bid_per_side: number;      // floor on bid price
  max_pair_cost: number;         // UP_bid + DN_bid must be <= this

  // Moving ladder: 2 levels per side, anchored to P_true
  edge1: number;                 // tight level: bid at P - edge1
  edge2: number;                 // deep level: bid at P - edge2
  quote_ttl_ms: number;          // cancel quotes older than this (0 = disabled)

  // Phase 2: Directional conviction
  conviction_start_pct: number;  // window progress to enter Phase 2
  conviction_size_mult: number;  // winning side gets N× base size
  conviction_p_true_min: number; // P_true > this to apply size skew
  losing_side_discount: number;  // bid this much below fair for losing side
  losing_side_min_bid: number;   // floor for losing-side bid price (ensures fills above fair value)

  // Phase 3: Certainty sweep
  sweep_threshold: number;       // P_true > this triggers sweep
  sweep_bid_price: number;       // sweep bid price (static, used when sweep_bid_dynamic=false)
  sweep_size: number;            // shares per sweep bid
  sweep_window_pct: number;      // min window progress for sweep
  sweep_losing_side: boolean;    // also buy losing side cheap during sweep
  sweep_cooldown_ms: number;     // min ms between sweep fills (prevent fill-every-tick)
  max_sweeps_per_window: number; // hard cap on sweep fills per window
  losing_side_max_bid: number;   // max bid for losing side in Phase 3 (replaces hardcoded 0.15)
  losing_side_premium: number;   // additive premium above complement for losing side
  sweep_use_oracle_edge: boolean; // require oracle P_true > market token ask to sweep
  sweep_bid_dynamic: boolean;    // compute sweep price from P_true instead of static
  sweep_margin: number;          // bid P_true - margin on sweeps (when dynamic)
  max_sweep_price: number;       // absolute cap on dynamic sweep bids

  // Sweep safety
  sweep_min_size: number;            // floor for graduated sizing (default: 25)
  sweep_confidence_scale: boolean;   // enable graduated sizing (default: true)
  sweep_max_pair_cost: number;       // pair cost gate on sweeps (default: 0.95)
  sweep_require_paired_base: number; // min paired inventory before full sweep (default: 20)
  sweep_allow_flip: boolean;         // allow sweep side to flip on reversal (default: true)
  sweep_flip_threshold: number;      // P_true reversal threshold to flip (default: 0.30)
  sweep_threshold_late: number;      // stricter threshold for late window (default: 0.92)

  // Phase 2 accumulation
  base_bid_size_phase2: number;      // winning side bid size in Phase 2 (default: 40)

  // Inventory guards
  max_inventory_per_side: number; // absolute max tokens on one side per window
  max_inventory_ratio: number;    // max heavy:light ratio before suppressing heavy side (default: 3.0)

  // General
  max_window_duration_ms: number; // only enter windows <= this duration (default 15min)
  fee_params: FeeParams;
  observation_seconds: number;
  max_concurrent_windows: number;
  discovery_interval_ms: number;
  min_requote_delta: number;     // min bid price change ($) to trigger requote
  requote_threshold_pct: number;
  enable_order_flow: boolean;
  record_snapshots: boolean;
}

export const DEFAULT_PARAMS: BoneStarParams = {
  target_cryptos: ["Bitcoin"],
  base_bid_size: 15,             // was 25 — Bonereaper does 5-24 tokens/fill
  bid_offset: 0.10,             // legacy: used as fallback when edge1/edge2 = 0
  max_bid_per_side: 0.85,           // Bonereaper buys winning side at $0.65-0.85 in Phase 2
  min_bid_per_side: 0.05,
  max_pair_cost: 0.95,            // pair cost cap for Phase 1/2 (was 0.98 — tighter target)

  edge1: 0.03,                  // tight level: P_true - 0.03
  edge2: 0.07,                  // deep level: P_true - 0.07
  quote_ttl_ms: 30_000,         // cancel quotes older than 30s (matches Bonereaper's ~2-3 prices per 30s bucket)

  conviction_start_pct: 0.25,   // Bonereaper shows conviction from ~25% onward
  conviction_size_mult: 1.5,    // was 2.0 — Bonereaper does 5-15 tokens, not 80
  conviction_p_true_min: 0.55,  // lower bar — Bonereaper follows market, not strict P_true
  losing_side_discount: 0.00,   // was 0.05 — removing discount: it suppressed losing-side fills
  losing_side_min_bid: 0.20,    // new — floor ensures losing-side bids above fair value → fills happen

  sweep_threshold: 0.90,        // Require strong conviction (was 0.85 — too many wrong-side sweeps)
  sweep_bid_price: 0.98,
  sweep_size: 200,
  sweep_window_pct: 0.50,       // Don't sweep in first 50% of window (was 0.40)
  sweep_losing_side: true,
  sweep_cooldown_ms: 10_000,    // 10s between sweep fills (was 30s — too conservative)
  max_sweeps_per_window: 10,    // was 3 — leaves money on the table
  losing_side_max_bid: 0.30,    // was hardcoded 0.15 — actual trading at $0.23-0.28
  losing_side_premium: 0.05,    // was hardcoded 0.02
  sweep_use_oracle_edge: false, // default off until validated
  sweep_bid_dynamic: false,     // conservative: use static sweep_bid_price by default
  sweep_margin: 0.02,
  max_sweep_price: 0.98,

  sweep_min_size: 25,
  sweep_confidence_scale: true,
  sweep_max_pair_cost: 0.95,
  sweep_require_paired_base: 20,
  sweep_allow_flip: true,
  sweep_flip_threshold: 0.30,
  sweep_threshold_late: 0.92,

  base_bid_size_phase2: 15,     // was 40 — Bonereaper accumulates gradually (5-15 tokens/fill)

  max_inventory_per_side: 500,  // Raised from 200 — Bonereaper accumulates 30k-90k tokens/window
  max_inventory_ratio: 6.0,    // Raised from 3.0 — Bonereaper shows 14/86 (6:1) skew

  max_window_duration_ms: 15 * 60_000, // 15 minutes — Bonereaper plays 5m and 15m only
  fee_params: CRYPTO_FEES,
  observation_seconds: 5,            // Bonereaper starts 5s after window open
  max_concurrent_windows: 12,
  discovery_interval_ms: 15_000,
  min_requote_delta: 0.01,
  requote_threshold_pct: 0.05,
  enable_order_flow: false,
  record_snapshots: true,
};

// ── Window State ─────────────────────────────────────────────────────

interface BoneStarWindow {
  market: CryptoMarket;
  cryptoSymbol: string;
  windowOpenTime: number;
  windowEndTime: number;
  priceAtWindowOpen: number;
  oracleStrike: number | null;

  // Maker bids — level 1 (tight) and level 2 (deep)
  upBidOrderId: string | null;
  upBidPrice: number;
  upBidSize: number;
  upBid2OrderId: string | null;
  upBid2Price: number;
  upBid2Size: number;
  upBid2PlacedAt: number;
  downBidOrderId: string | null;
  downBidPrice: number;
  downBidSize: number;
  downBid2OrderId: string | null;
  downBid2Price: number;
  downBid2Size: number;
  downBid2PlacedAt: number;
  // TTL tracking for level 1
  upBidPlacedAt: number;
  downBidPlacedAt: number;

  // Sweep bid (one side, Phase 3 only)
  sweepOrderId: string | null;
  sweepSide: "UP" | "DOWN" | null;
  sweepPrice: number;
  sweepSize: number;

  // Inventory (never sell)
  upInventory: number;
  upAvgCost: number;
  downInventory: number;
  downAvgCost: number;

  // Tracking
  phase: 1 | 2 | 3;
  fillCount: number;
  sweepFillCount: number;
  totalBuyCost: number;
  realizedSellPnl: number; // merge P&L tracked here by framework auto-merge
  enteredAt: number;
  tickAction: string;

  // Signal tracking
  lastQuotedAt: number;
  lastQuotedPriceChangePct: number;
  confirmedDirection: "UP" | "DOWN" | null;

  // Sweep state
  lastSweepFillAt: number;
  lockedSweepSide: "UP" | "DOWN" | null; // locked when Phase 3 starts, can flip if sweep_allow_flip=true

  // Set when past end, awaiting resolution
  binancePrediction?: "UP" | "DOWN" | null;

  // Snapshot recording (populated when record_snapshots=true)
  tickSnapshots?: TickSnapshot[];
  snapshotId?: string;
  pendingFills?: Array<{ side: "UP" | "DOWN"; price: number; size: number }>;
  cumulativeTapeBuckets?: Map<string, number>;
  cumulativeTapeWallets?: Set<string>;
  cumulativeTapeVolume?: number;
  cumulativeTapeCount?: number;
  lastTapeTimestamp?: number;
}

interface CompletedBoneStarWindow {
  title: string;
  cryptoSymbol: string;
  outcome: "UP" | "DOWN" | "UNKNOWN";
  upInventory: number;
  downInventory: number;
  totalBuyCost: number;
  winningPayout: number;
  losingLoss: number;
  netPnl: number;
  fillCount: number;
  sweepFillCount: number;
  completedAt: string;
  priceMovePct: number;
  upAvgCost: number;
  downAvgCost: number;
  maxPhase: 1 | 2 | 3;
  gammaConfirmed: boolean; // true when Polymarket/Gamma API confirms the outcome
  slug?: string;           // for background Gamma confirmation checks
  upTokenId?: string;
  downTokenId?: string;
}

interface BoneStarCustomState {
  activeWindows: BoneStarWindow[];
  completedWindows: CompletedBoneStarWindow[];
  priceHistory: Record<string, PriceSnapshot[]>;
  windowRefPrices: Record<string, { price: number; recordedAt: number }>;
  totalPnl: number;
  totalFills: number;
  totalSweepFills: number;
  windowsTraded: number;
  windowsWon: number;
  windowsLost: number;
  perAsset: Record<string, { won: number; lost: number; pnl: number; fills: number }>;
  scanStatus: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function emptyCustom(): BoneStarCustomState {
  return {
    activeWindows: [],
    completedWindows: [],
    priceHistory: {},
    windowRefPrices: {},
    totalPnl: 0,
    totalFills: 0,
    totalSweepFills: 0,
    windowsTraded: 0,
    windowsWon: 0,
    windowsLost: 0,
    perAsset: {},
    scanStatus: "Starting up…",
  };
}

function findPriceAtTime(history: PriceSnapshot[], targetTime: number): number | null {
  if (history.length === 0) return null;
  let closest: PriceSnapshot | null = null;
  let minDiff = Infinity;
  for (const snap of history) {
    const diff = Math.abs(snap.timestamp - targetTime);
    if (diff < minDiff) { minDiff = diff; closest = snap; }
  }
  if (closest && minDiff < 30_000) return closest.price;
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ── Strategy ─────────────────────────────────────────────────────────

class BoneStarStrategy implements Strategy {
  name = "bonestar";
  private custom: BoneStarCustomState = emptyCustom();
  private marketCache: CryptoMarket[] = [];
  private lastDiscovery = 0;

  // Book cache
  private bookCache: Map<string, { book: OrderBook; fetchedAt: number }> = new Map();
  private static BOOK_CACHE_TTL = 5_000;

  private async getBookCached(ctx: StrategyContext, tokenId: string): Promise<OrderBook> {
    const now = Date.now();
    const cached = this.bookCache.get(tokenId);
    if (cached && now - cached.fetchedAt < BoneStarStrategy.BOOK_CACHE_TTL) return cached.book;
    const book = await ctx.api.getBook(tokenId);
    this.bookCache.set(tokenId, { book, fetchedAt: now });
    return book;
  }

  private getBestAsk(book: OrderBook): number | null {
    if (book.asks.length === 0) return null;
    let best = book.asks[0].price;
    for (const level of book.asks) {
      if (level.price < best) best = level.price;
    }
    return best;
  }

  async init(ctx: StrategyContext): Promise<void> {
    const stored = ctx.state.custom as Partial<BoneStarCustomState>;
    this.custom = {
      ...emptyCustom(),
      ...stored,
      activeWindows: stored.activeWindows || [],
      completedWindows: stored.completedWindows || [],
      priceHistory: stored.priceHistory || {},
      windowRefPrices: stored.windowRefPrices || {},
    };

    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as BoneStarParams;
    if (params.enable_order_flow) {
      const symbols = params.target_cryptos
        .map((c) => CRYPTO_SYMBOL_MAP[c.toLowerCase()])
        .filter(Boolean) as string[];
      enableOrderFlow(symbols);
    }

    ctx.log(
      `BoneStar initialized: ${this.custom.activeWindows.length} active, ${this.custom.totalFills} fills, ${this.custom.totalSweepFills} sweeps`
    );
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as BoneStarParams;
    const now = Date.now();

    // 1. Discover markets
    if (now - this.lastDiscovery > params.discovery_interval_ms) {
      this.marketCache = await discoverCryptoMarkets(params.target_cryptos, 30_000);
      this.lastDiscovery = now;
      if (this.marketCache.length > 0) {
        ctx.log(`Discovered ${this.marketCache.length} markets`);
      }
    }

    // 2. Fetch prices for active symbols
    const activeSymbols = new Set<string>();
    for (const m of this.marketCache) {
      const sym = extractCryptoSymbol(m.title);
      if (sym) activeSymbols.add(sym);
    }
    for (const w of this.custom.activeWindows) {
      activeSymbols.add(w.cryptoSymbol);
    }

    for (const sym of activeSymbols) {
      const snap = await fetchSpotPrice(sym);
      if (snap) {
        if (!this.custom.priceHistory[sym]) this.custom.priceHistory[sym] = [];
        this.custom.priceHistory[sym].push(snap);
        if (this.custom.priceHistory[sym].length > 60) {
          this.custom.priceHistory[sym] = this.custom.priceHistory[sym].slice(-60);
        }
      }
    }

    // Prune stale symbols
    for (const sym of Object.keys(this.custom.priceHistory)) {
      if (!activeSymbols.has(sym)) delete this.custom.priceHistory[sym];
    }

    // 3. Manage active windows
    await this.manageWindows(ctx, params);

    // 4. Enter new windows (skip when winding down)
    let entered = 0;
    let marketsScanned = 0;
    if (!ctx.windingDown && this.custom.activeWindows.length < params.max_concurrent_windows) {
      const result = await this.enterWindows(ctx, params);
      entered = result.entered;
      marketsScanned = result.marketsScanned;
    }

    // 5. Resolve completed windows
    await this.resolveWindows(ctx, params);

    // 6. Wind-down: drop empty windows
    if (ctx.windingDown) {
      const before = this.custom.activeWindows.length;
      this.custom.activeWindows = this.custom.activeWindows.filter(
        w => w.upInventory + w.downInventory > 0 || w.totalBuyCost > 0
      );
      if (this.custom.activeWindows.length < before) {
        ctx.log(`Wind-down: dropped ${before - this.custom.activeWindows.length} empty window(s)`);
      }
    }

    // 7. Update scan status
    const totalInv = this.custom.activeWindows.reduce(
      (s, w) => s + w.upInventory + w.downInventory, 0
    );
    if (ctx.windingDown) {
      this.custom.scanStatus = this.custom.activeWindows.length > 0
        ? `Winding down: ${this.custom.activeWindows.length} window(s), ${totalInv} tokens`
        : "Wind-down complete";
    } else if (this.custom.activeWindows.length > 0) {
      this.custom.scanStatus = totalInv > 0
        ? `${this.custom.activeWindows.length} active, ${totalInv} tokens held`
        : `${this.custom.activeWindows.length} active, waiting for fills…`;
    } else {
      this.custom.scanStatus = this.marketCache.length > 0 ? "No open windows" : "Scanning…";
    }

    // 8. Persist
    ctx.state.custom = this.custom as unknown as Record<string, unknown>;
    ctx.state.capital_deployed = this.custom.activeWindows.reduce(
      (sum, w) => sum + w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost, 0
    );
    ctx.state.total_pnl = this.custom.totalPnl;
  }

  async stop(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as BoneStarParams;
    for (const w of this.custom.activeWindows) {
      await this.cancelAllBids(ctx, w, params);
    }
    if (params.enable_order_flow) disableOrderFlow();
    ctx.log(`BoneStar stopped: ${this.custom.totalFills} fills, ${this.custom.totalSweepFills} sweeps, P&L=$${ctx.state.total_pnl.toFixed(2)}`);
  }

  // ── Fill recording (buy only — no sells) ───────────────────────────

  private recordFill(
    ctx: StrategyContext,
    w: BoneStarWindow,
    side: "UP" | "DOWN",
    size: number,
    price: number,
    params: BoneStarParams,
    label: string,
  ): void {
    const costBasis = price; // Maker fills = zero fee
    if (side === "UP") {
      if (w.upInventory > 0) {
        const totalCost = w.upAvgCost * w.upInventory + costBasis * size;
        w.upInventory += size;
        w.upAvgCost = totalCost / w.upInventory;
      } else {
        w.upInventory = size;
        w.upAvgCost = costBasis;
      }
    } else {
      if (w.downInventory > 0) {
        const totalCost = w.downAvgCost * w.downInventory + costBasis * size;
        w.downInventory += size;
        w.downAvgCost = totalCost / w.downInventory;
      } else {
        w.downInventory = size;
        w.downAvgCost = costBasis;
      }
    }
    w.fillCount++;
    w.totalBuyCost += costBasis * size;
    this.custom.totalFills++;
    if (w.pendingFills) {
      w.pendingFills.push({ side, price: costBasis, size });
    }
    ctx.log(
      `FILL ${side} [${label}]: ${w.market.title.slice(0, 25)} ${size}@${price.toFixed(3)} inv=${w.upInventory}↑/${w.downInventory}↓`,
      { level: "trade", symbol: w.cryptoSymbol, direction: side, phase: label }
    );
  }

  private async persistFillToD1(
    ctx: StrategyContext,
    w: BoneStarWindow,
    side: "UP" | "DOWN",
    price: number,
    size: number,
    params: BoneStarParams,
    label: string,
  ): Promise<void> {
    const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
    const feeEquivalent = calcFeePerShare(price, params.fee_params) * size;
    await ctx.db
      .prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
      )
      .bind(
        `bs-${label}-${crypto.randomUUID()}`,
        ctx.config.id,
        tokenId,
        w.market.slug,
        `${w.market.title} [BS ${label} ${side}]`,
        price, size, feeEquivalent
      )
      .run();
  }

  // ── Enter new windows ──────────────────────────────────────────────

  private async enterWindows(
    ctx: StrategyContext,
    params: BoneStarParams
  ): Promise<{ entered: number; marketsScanned: number }> {
    const now = Date.now();
    const activeConditions = new Set(this.custom.activeWindows.map((w) => w.market.conditionId));
    let marketsScanned = 0;
    const windowsBefore = this.custom.activeWindows.length;

    // Capital check
    const capitalCommitted = this.custom.activeWindows.reduce(
      (sum, w) => sum + w.totalBuyCost, 0
    );

    for (const market of this.marketCache) {
      if (this.custom.activeWindows.length >= params.max_concurrent_windows) break;
      if (activeConditions.has(market.conditionId)) continue;

      const sym = extractCryptoSymbol(market.title);
      if (!sym) continue;
      marketsScanned++;

      const endMs = new Date(market.endDate).getTime();
      const windowDuration = parseWindowDurationMs(market.title);
      const windowOpenTime = endMs - windowDuration;

      // Skip windows longer than max (Bonereaper plays 5m and 15m only)
      if (windowDuration > params.max_window_duration_ms) continue;

      if (now < windowOpenTime) continue;
      if (endMs - now < 30_000) continue; // don't enter in last 30s

      // Get or record reference price
      const refKey = market.conditionId;
      const history = this.custom.priceHistory[sym] || [];
      const latestSnap = history.length > 0 ? history[history.length - 1] : null;

      if (!this.custom.windowRefPrices[refKey]) {
        if (!latestSnap) continue;
        this.custom.windowRefPrices[refKey] = { price: latestSnap.price, recordedAt: latestSnap.timestamp };
        continue;
      }

      const ref = this.custom.windowRefPrices[refKey];
      if (now - ref.recordedAt < params.observation_seconds * 1000) continue;

      // Oracle strike
      let oracleStrike: number | null = null;
      try {
        oracleStrike = getOracleStrikeWs(sym, windowOpenTime);
        if (oracleStrike == null) {
          const eventStart = new Date(windowOpenTime).toISOString();
          const oracleSymbol = toOracleSymbol(sym);
          const variant = toVariant(windowDuration);
          oracleStrike = await fetchOracleStrike(oracleSymbol, variant, eventStart);
        }
        if (oracleStrike != null) {
          ctx.log(`Oracle strike: $${oracleStrike.toFixed(2)} (Binance: $${ref.price.toFixed(2)})`);
        }
      } catch { /* best-effort */ }

      const window: BoneStarWindow = {
        market,
        cryptoSymbol: sym,
        windowOpenTime,
        windowEndTime: endMs,
        priceAtWindowOpen: ref.price,
        oracleStrike,

        upBidOrderId: null,
        upBidPrice: 0,
        upBidSize: 0,
        upBid2OrderId: null,
        upBid2Price: 0,
        upBid2Size: 0,
        upBid2PlacedAt: 0,
        downBidOrderId: null,
        downBidPrice: 0,
        downBidSize: 0,
        downBid2OrderId: null,
        downBid2Price: 0,
        downBid2Size: 0,
        downBid2PlacedAt: 0,
        upBidPlacedAt: 0,
        downBidPlacedAt: 0,

        sweepOrderId: null,
        sweepSide: null,
        sweepPrice: 0,
        sweepSize: 0,

        upInventory: 0,
        upAvgCost: 0,
        downInventory: 0,
        downAvgCost: 0,

        phase: 1,
        fillCount: 0,
        sweepFillCount: 0,
        totalBuyCost: 0,
        realizedSellPnl: 0,
        enteredAt: now,
        tickAction: "",

        lastQuotedAt: 0,
        lastQuotedPriceChangePct: 0,
        confirmedDirection: null,
        lastSweepFillAt: 0,
        lockedSweepSide: null,
      };

      if (params.record_snapshots) {
        window.tickSnapshots = [];
        window.snapshotId = `snap-${market.conditionId}-${now}`;
        window.pendingFills = [];
      }

      this.custom.activeWindows.push(window);
      ctx.log(
        `ENTERED: ${market.title.slice(0, 40)} ${sym} oracle=${oracleStrike?.toFixed(0) ?? "none"}`,
        { level: "signal", symbol: sym, phase: "entry" }
      );
    }

    return { entered: this.custom.activeWindows.length - windowsBefore, marketsScanned };
  }

  // ── Manage active windows ──────────────────────────────────────────

  private async manageWindows(ctx: StrategyContext, params: BoneStarParams): Promise<void> {
    const now = Date.now();

    for (const w of this.custom.activeWindows) {
      // Past resolution — handled by resolveWindows
      if (now > w.windowEndTime + 300_000) {
        w.tickAction = "Awaiting resolution";
        continue;
      }

      // Wind-down: cancel all bids, hold to resolution
      if (ctx.windingDown) {
        await this.cancelAllBids(ctx, w, params);
        w.tickAction = `Wind-down: holding ${w.upInventory}↑/${w.downInventory}↓`;
        continue;
      }

      // Re-init tickSnapshots after DO re-hydration (stripped by persistState)
      if (params.record_snapshots && !w.tickSnapshots) {
        if (w.snapshotId) {
          try {
            const row = await ctx.db.prepare(
              "SELECT ticks FROM strategy_snapshots WHERE id = ?"
            ).bind(w.snapshotId).first<{ ticks: string }>();
            w.tickSnapshots = row?.ticks ? JSON.parse(row.ticks) : [];
          } catch {
            w.tickSnapshots = [];
          }
        } else {
          w.tickSnapshots = [];
        }
        w.pendingFills = [];
        // Rebuild cumulative tape state from restored ticks
        if (w.tickSnapshots!.length > 0 && !w.cumulativeTapeBuckets) {
          w.cumulativeTapeBuckets = new Map();
          w.cumulativeTapeWallets = new Set();
          const lastTick = w.tickSnapshots![w.tickSnapshots!.length - 1];
          for (const b of lastTick.tapeBuckets) {
            const key = `${b.tokenId}:${b.price.toFixed(2)}`;
            w.cumulativeTapeBuckets.set(key, b.size);
          }
          w.cumulativeTapeCount = lastTick.tapeMeta.totalTrades;
          w.cumulativeTapeVolume = lastTick.tapeMeta.totalVolume;
          w.lastTapeTimestamp = lastTick.t;
        }
      }

      // Retry oracle strike if not yet captured
      if (w.oracleStrike == null) {
        try {
          w.oracleStrike = getOracleStrikeWs(w.cryptoSymbol, w.windowOpenTime);
          if (w.oracleStrike == null) {
            const eventStart = new Date(w.windowOpenTime).toISOString();
            const oracleSymbol = toOracleSymbol(w.cryptoSymbol);
            const wDurMs = w.windowEndTime - w.windowOpenTime;
            const variant = toVariant(wDurMs);
            w.oracleStrike = await fetchOracleStrike(oracleSymbol, variant, eventStart);
          }
          if (w.oracleStrike != null) {
            ctx.log(`Oracle strike locked: $${w.oracleStrike.toFixed(2)}`);
          }
        } catch { /* best-effort */ }
      }

      // Compute P_true from oracle
      const effectiveStrike = w.oracleStrike ?? w.priceAtWindowOpen;
      const currentSnap = await fetchSpotPrice(w.cryptoSymbol);
      if (!currentSnap) continue;

      const history = this.custom.priceHistory[w.cryptoSymbol] || [];
      const vol = estimateVolatility5min(history);
      const timeRemaining = w.windowEndTime - now;
      const windowProgress = (now - w.windowOpenTime) / (w.windowEndTime - w.windowOpenTime);

      // Use oracle spot if available, else Binance
      const oracleTick = getOracleSpot(w.cryptoSymbol);
      const spotForPTrue = (oracleTick && isOracleConnected()) ? oracleTick.price : currentSnap.price;
      const pTrue = calculatePTrue(spotForPTrue, effectiveStrike, "above", timeRemaining, vol);

      // Check fills on all bids, then cancel stale quotes
      await this.checkFills(ctx, w, params);
      await this.cancelStaleBids(ctx, w, params);

      // Determine phase — monotonic: once promoted, never demoted (1→2→3)
      const prevPhase = w.phase;

      const sweepTriggered = (pTrue > params.sweep_threshold || pTrue < (1 - params.sweep_threshold))
          && windowProgress >= params.sweep_window_pct;

      if (w.phase === 3 || sweepTriggered) {
        // Phase 3 is sticky — once in sweep mode, stay there
        if (w.phase !== 3) {
          // Lock sweep side on first Phase 3 entry
          w.lockedSweepSide = pTrue > 0.5 ? "UP" : "DOWN";
        } else if (params.sweep_allow_flip && w.lockedSweepSide) {
          // Allow sweep side to flip if P_true reversed hard
          const currentSweepPTrue = w.lockedSweepSide === "UP" ? pTrue : (1 - pTrue);
          if (currentSweepPTrue < params.sweep_flip_threshold) {
            const oldSide = w.lockedSweepSide;
            w.lockedSweepSide = w.lockedSweepSide === "UP" ? "DOWN" : "UP";
            ctx.log(`Sweep side FLIPPED ${oldSide}→${w.lockedSweepSide}, pTrue=${pTrue.toFixed(3)}`, { level: "warning", symbol: w.cryptoSymbol });
          }
        }
        w.phase = 3;
        await this.updateSweepQuotes(ctx, w, params, pTrue, spotForPTrue);
      } else if (w.phase >= 2 || windowProgress >= params.conviction_start_pct) {
        w.phase = 2;
        await this.updateConvictionQuotes(ctx, w, params, pTrue, spotForPTrue);
      } else {
        await this.updateBalancedQuotes(ctx, w, params, pTrue, spotForPTrue);
      }

      if (w.phase !== prevPhase) {
        ctx.log(
          `PHASE ${prevPhase}→${w.phase}: ${w.market.title.slice(0, 25)} P_true=${pTrue.toFixed(3)} progress=${(windowProgress * 100).toFixed(0)}%`,
          { level: "signal", symbol: w.cryptoSymbol, phase: `phase_${w.phase}` }
        );
      }

      // Periodic log
      if (ctx.state.ticks % 5 === 0) {
        const pc = (w.upInventory > 0 && w.downInventory > 0) ? (w.upAvgCost + w.downAvgCost).toFixed(2) : "—";
        ctx.log(
          `TICK: ${w.market.title.slice(0, 25)} P${w.phase} P_true=${pTrue.toFixed(3)} spot=$${spotForPTrue.toFixed(0)} strike=$${effectiveStrike.toFixed(0)} inv=${w.upInventory}↑/${w.downInventory}↓ pc=${pc} fills=${w.fillCount} sweeps=${w.sweepFillCount}`,
          { level: "signal", symbol: w.cryptoSymbol, signalStrength: pTrue, phase: `phase_${w.phase}` }
        );
      }

      // ── Snapshot recording ──
      if (params.record_snapshots && w.tickSnapshots) {
       try {
        // Re-hydrate Map/Set if serialized (from DO storage)
        if (!w.cumulativeTapeBuckets || !((w.cumulativeTapeBuckets as unknown) instanceof Map)) {
          const prev = w.cumulativeTapeBuckets as unknown;
          w.cumulativeTapeBuckets = new Map(prev && typeof prev === "object" && !(prev instanceof Map) ? Object.entries(prev as Record<string, number>) : undefined);
          const prevWallets = w.cumulativeTapeWallets as unknown;
          w.cumulativeTapeWallets = new Set(prevWallets instanceof Set ? prevWallets : Array.isArray(prevWallets) ? prevWallets : undefined);
          w.cumulativeTapeVolume = w.cumulativeTapeVolume ?? 0;
          w.cumulativeTapeCount = w.cumulativeTapeCount ?? 0;
          w.lastTapeTimestamp = w.lastTapeTimestamp ?? 0;
        }

        // Accumulate trade tape
        const tapeNow = await fetchTradeTape();
        const relevantTokens = new Set([w.market.upTokenId, w.market.downTokenId]);
        for (const t of tapeNow) {
          if (!relevantTokens.has(t.asset)) continue;
          if (t.timestamp <= w.lastTapeTimestamp!) continue;
          if (t.taker) w.cumulativeTapeWallets!.add(t.taker);
          w.cumulativeTapeVolume! += t.size * t.price;
          w.cumulativeTapeCount!++;
          const roundedPrice = Math.round(t.price * 100) / 100;
          const key = `${t.asset}:${roundedPrice}`;
          w.cumulativeTapeBuckets!.set(key, (w.cumulativeTapeBuckets!.get(key) ?? 0) + t.size);
        }
        for (const t of tapeNow) {
          if (relevantTokens.has(t.asset) && t.timestamp > w.lastTapeTimestamp!) {
            w.lastTapeTimestamp = t.timestamp;
          }
        }

        // Build tapeBuckets from cumulative data
        const tapeBuckets: TapeBucket[] = [];
        for (const [key, size] of w.cumulativeTapeBuckets!) {
          const sep = key.lastIndexOf(":");
          tapeBuckets.push({
            tokenId: key.slice(0, sep),
            price: parseFloat(key.slice(sep + 1)),
            size,
          });
        }
        const tapeMeta: TapeMeta = {
          totalTrades: w.cumulativeTapeCount!,
          totalVolume: w.cumulativeTapeVolume!,
          uniqueWallets: w.cumulativeTapeWallets!.size,
        };

        // Compute regime
        const regimeSignal: import("./price-feed").WindowSignal = {
          symbol: w.cryptoSymbol,
          windowOpenPrice: w.priceAtWindowOpen,
          currentPrice: currentSnap.price,
          priceChangePct: ((currentSnap.price - w.priceAtWindowOpen) / w.priceAtWindowOpen) * 100,
          direction: pTrue > 0.5 ? "UP" : "DOWN",
          signalStrength: Math.abs(pTrue - 0.5) * 2,
          velocity: 0,
          sampleCount: history.length,
          momentum: 0,
          acceleration: 0,
          volatilityRegime: "normal",
          confidenceMultiplier: 1.0,
          orderFlowImbalance: 0,
          orderFlowAvailable: false,
          oracleSpot: oracleTick?.price,
          oracleAvailable: isOracleConnected(),
          rawDirection: pTrue > 0.5 ? "UP" : "DOWN",
          inDeadZone: false,
        };
        const regimeFeatures = computeRegimeFeatures(
          history, regimeSignal, effectiveStrike, w.windowOpenTime, w.windowEndTime,
        );
        const { regime, scores: regimeScores } = classifyRegime(regimeFeatures);

        // Get book state for snapshot
        let bookBids: { price: number; size: number }[] = [];
        let upBookAsks: { price: number; size: number }[] = [];
        let downBookAsks: { price: number; size: number }[] = [];
        try {
          const upBook = await this.getBookCached(ctx, w.market.upTokenId);
          const dnBook = await this.getBookCached(ctx, w.market.downTokenId);
          upBookAsks = upBook.asks.slice(0, 5).map(l => ({ price: l.price, size: l.size }));
          downBookAsks = dnBook.asks.slice(0, 5).map(l => ({ price: l.price, size: l.size }));
          bookBids = upBook.bids.slice(0, 5).map(l => ({ price: l.price, size: l.size }));
        } catch { /* best-effort */ }

        const snapshot: TickSnapshot = {
          t: now,
          price: currentSnap.price,
          signal: regimeSignal,
          regime,
          regimeFeatures,
          regimeScores,
          fairUp: pTrue,
          fairDown: 1 - pTrue,
          bookConviction: { upMid: null, downMid: null, bookDirection: "NEUTRAL", bookStrength: 0, bidDepthRatio: 0.5, midDelta: 0, agreement: 0 },
          tapeBuckets,
          tapeMeta,
          bookBids,
          upBookAsks,
          downBookAsks,
          fills: w.pendingFills && w.pendingFills.length > 0 ? [...w.pendingFills] : undefined,
          upBidOrderId: w.upBidOrderId, upBidPrice: w.upBidPrice, upBidSize: w.upBidSize,
          upBid2OrderId: w.upBid2OrderId, upBid2Price: w.upBid2Price, upBid2Size: w.upBid2Size,
          downBidOrderId: w.downBidOrderId, downBidPrice: w.downBidPrice, downBidSize: w.downBidSize,
          downBid2OrderId: w.downBid2OrderId, downBid2Price: w.downBid2Price, downBid2Size: w.downBid2Size,
          upInventory: w.upInventory, downInventory: w.downInventory,
          upAvgCost: w.upAvgCost, downAvgCost: w.downAvgCost,
          oracleSpot: oracleTick?.price,
          phase: w.phase,
          pTrue,
          sweepSide: w.lockedSweepSide,
          sweepPrice: w.sweepPrice,
          sweepSize: w.sweepSize,
        };

        w.tickSnapshots.push(snapshot);
        if (w.pendingFills) w.pendingFills = [];

        // Flush to D1
        if (w.snapshotId) {
          try {
            const openDate = new Date(w.windowOpenTime);
            await ctx.db.prepare(
              `INSERT OR REPLACE INTO strategy_snapshots (id, strategy_id, window_title, crypto_symbol, window_open_time, window_end_time, window_duration_ms, oracle_strike, price_at_open, hour_utc, day_of_week, up_token_id, down_token_id, outcome, ticks)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              w.snapshotId, ctx.config.id, w.market.title, w.cryptoSymbol,
              w.windowOpenTime, w.windowEndTime, w.windowEndTime - w.windowOpenTime,
              w.oracleStrike ?? null, w.priceAtWindowOpen,
              openDate.getUTCHours(), openDate.getUTCDay(),
              w.market.upTokenId, w.market.downTokenId,
              null, JSON.stringify(w.tickSnapshots)
            ).run();
          } catch (e) { ctx.log(`SNAPSHOT FLUSH ERROR: ${e}`, { level: "error" }); }
        }
       } catch (e) { ctx.log(`SNAPSHOT RECORD ERROR: ${e}`, { level: "error" }); }
      }

      // Merge is handled by the framework (autoMergeProfitablePairs) after tick()
    }
  }

  // ── Check fills ────────────────────────────────────────────────────

  private async checkFills(ctx: StrategyContext, w: BoneStarWindow, params: BoneStarParams): Promise<void> {
    // Check UP bid (level 1)
    if (w.upBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.upBidOrderId);
      if (status.status === "MATCHED" && status.size_matched > 0) {
        const price = status.price || w.upBidPrice;
        const size = status.size_matched;
        this.recordFill(ctx, w, "UP", size, price, params, "maker_L1");
        await this.persistFillToD1(ctx, w, "UP", price, size, params, "maker_L1");
        w.upBidOrderId = null;
      }
    }
    // Check UP bid (level 2)
    if (w.upBid2OrderId) {
      const status = await ctx.api.getOrderStatus(w.upBid2OrderId);
      if (status.status === "MATCHED" && status.size_matched > 0) {
        const price = status.price || w.upBid2Price;
        const size = status.size_matched;
        this.recordFill(ctx, w, "UP", size, price, params, "maker_L2");
        await this.persistFillToD1(ctx, w, "UP", price, size, params, "maker_L2");
        w.upBid2OrderId = null;
      }
    }

    // Check DOWN bid (level 1)
    if (w.downBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.downBidOrderId);
      if (status.status === "MATCHED" && status.size_matched > 0) {
        const price = status.price || w.downBidPrice;
        const size = status.size_matched;
        this.recordFill(ctx, w, "DOWN", size, price, params, "maker_L1");
        await this.persistFillToD1(ctx, w, "DOWN", price, size, params, "maker_L1");
        w.downBidOrderId = null;
      }
    }
    // Check DOWN bid (level 2)
    if (w.downBid2OrderId) {
      const status = await ctx.api.getOrderStatus(w.downBid2OrderId);
      if (status.status === "MATCHED" && status.size_matched > 0) {
        const price = status.price || w.downBid2Price;
        const size = status.size_matched;
        this.recordFill(ctx, w, "DOWN", size, price, params, "maker_L2");
        await this.persistFillToD1(ctx, w, "DOWN", price, size, params, "maker_L2");
        w.downBid2OrderId = null;
      }
    }

    // Check sweep bid
    if (w.sweepOrderId && w.sweepSide) {
      const status = await ctx.api.getOrderStatus(w.sweepOrderId);
      if (status.status === "MATCHED" && status.size_matched > 0) {
        const price = status.price || w.sweepPrice;
        const size = status.size_matched;
        this.recordFill(ctx, w, w.sweepSide, size, price, params, "sweep");
        await this.persistFillToD1(ctx, w, w.sweepSide, price, size, params, "sweep");
        w.sweepFillCount++;
        this.custom.totalSweepFills++;
        w.lastSweepFillAt = Date.now();
        w.sweepOrderId = null;
      }
    }
  }

  // ── Ladder price computation (shared across phases) ────────────────

  private computeLadderPrices(
    pTrue: number,
    w: BoneStarWindow,
    params: BoneStarParams,
  ): { upL1: number; upL2: number; dnL1: number; dnL2: number } {
    const fairUp = pTrue;
    const fairDown = 1 - pTrue;

    // Two levels per side: tight (edge1) and deep (edge2)
    let upL1 = clamp(fairUp - params.edge1, params.min_bid_per_side, params.max_bid_per_side);
    let upL2 = clamp(fairUp - params.edge2, params.min_bid_per_side, params.max_bid_per_side);
    let dnL1 = clamp(fairDown - params.edge1, params.min_bid_per_side, params.max_bid_per_side);
    let dnL2 = clamp(fairDown - params.edge2, params.min_bid_per_side, params.max_bid_per_side);

    // Pair cost cap: each level's bid + opposite avg cost must stay under max_pair_cost
    if (w.downInventory > 0) {
      const cap = params.max_pair_cost - w.downAvgCost;
      upL1 = Math.min(upL1, cap);
      upL2 = Math.min(upL2, cap);
    }
    if (w.upInventory > 0) {
      const cap = params.max_pair_cost - w.upAvgCost;
      dnL1 = Math.min(dnL1, cap);
      dnL2 = Math.min(dnL2, cap);
    }

    // Floor at $0.01
    upL1 = Math.max(0.01, upL1);
    upL2 = Math.max(0.01, upL2);
    dnL1 = Math.max(0.01, dnL1);
    dnL2 = Math.max(0.01, dnL2);

    return { upL1, upL2, dnL1, dnL2 };
  }

  // ── Phase 1: Balanced quotes ───────────────────────────────────────

  private async updateBalancedQuotes(
    ctx: StrategyContext,
    w: BoneStarWindow,
    params: BoneStarParams,
    pTrue: number,
    _spot: number,
  ): Promise<void> {
    // Moving 2-level ladder anchored to P_true
    const { upL1, upL2, dnL1, dnL2 } = this.computeLadderPrices(pTrue, w, params);

    // Equal sizing with inventory guards
    let upSize = params.base_bid_size;
    let dnSize = params.base_bid_size;

    // One-sided guard: if one side has base_bid_size and other has 0, pause heavy side
    if (w.upInventory >= params.base_bid_size && w.downInventory === 0) upSize = 0;
    if (w.downInventory >= params.base_bid_size && w.upInventory === 0) dnSize = 0;
    // Absolute cap
    if (w.upInventory >= params.max_inventory_per_side) upSize = 0;
    if (w.downInventory >= params.max_inventory_per_side) dnSize = 0;

    // Inventory ratio guard: suppress heavy side when too imbalanced
    const heavy1 = Math.max(w.upInventory, w.downInventory);
    const light1 = Math.min(w.upInventory, w.downInventory);
    if (light1 > 0 && heavy1 / light1 > params.max_inventory_ratio) {
      if (w.upInventory > w.downInventory) upSize = 0;
      else dnSize = 0;
    }

    await this.placeOrUpdateBid(ctx, w, "UP", upL1, upSize, params, 1);
    await this.placeOrUpdateBid(ctx, w, "UP", upL2, upSize, params, 2);
    await this.placeOrUpdateBid(ctx, w, "DOWN", dnL1, dnSize, params, 1);
    await this.placeOrUpdateBid(ctx, w, "DOWN", dnL2, dnSize, params, 2);

    const pc = (w.upInventory > 0 && w.downInventory > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
    w.tickAction = `P1 ladder: ▲${upL1.toFixed(2)}/${upL2.toFixed(2)}×${upSize} ▼${dnL1.toFixed(2)}/${dnL2.toFixed(2)}×${dnSize}${pc}`;
  }

  // ── Phase 2: Conviction quotes ─────────────────────────────────────

  private async updateConvictionQuotes(
    ctx: StrategyContext,
    w: BoneStarWindow,
    params: BoneStarParams,
    pTrue: number,
    _spot: number,
  ): Promise<void> {
    const upWinning = pTrue > 0.5;
    const { upL1, upL2, dnL1, dnL2 } = this.computeLadderPrices(pTrue, w, params);

    // Size skew based on conviction
    const sizeMultiplier = pTrue > params.conviction_p_true_min || (1 - pTrue) > params.conviction_p_true_min
      ? params.conviction_size_mult
      : 1.0;

    let upSize = params.base_bid_size;
    let dnSize = params.base_bid_size;

    if (upWinning) {
      upSize = Math.round(params.base_bid_size_phase2 * sizeMultiplier);
    } else {
      dnSize = Math.round(params.base_bid_size_phase2 * sizeMultiplier);
    }

    // Inventory guards
    if (w.upInventory >= params.max_inventory_per_side) upSize = 0;
    if (w.downInventory >= params.max_inventory_per_side) dnSize = 0;

    // One-sided guard: if heavy side has base_bid_size_phase2 and other has 0, pause heavy side
    if (w.upInventory >= params.base_bid_size_phase2 && w.downInventory === 0) upSize = 0;
    if (w.downInventory >= params.base_bid_size_phase2 && w.upInventory === 0) dnSize = 0;

    // Inventory ratio guard: suppress heavy side when too imbalanced
    const heavy2 = Math.max(w.upInventory, w.downInventory);
    const light2 = Math.min(w.upInventory, w.downInventory);
    if (light2 > 0 && heavy2 / light2 > params.max_inventory_ratio) {
      if (w.upInventory > w.downInventory) upSize = 0;
      else dnSize = 0;
    }

    await this.placeOrUpdateBid(ctx, w, "UP", upL1, upSize, params, 1);
    await this.placeOrUpdateBid(ctx, w, "UP", upL2, upSize, params, 2);
    await this.placeOrUpdateBid(ctx, w, "DOWN", dnL1, dnSize, params, 1);
    await this.placeOrUpdateBid(ctx, w, "DOWN", dnL2, dnSize, params, 2);

    const winningSide = upWinning ? "UP" : "DOWN";
    const pc = (w.upInventory > 0 && w.downInventory > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
    w.tickAction = `P2 ${winningSide}×${sizeMultiplier.toFixed(1)}: ▲${upL1.toFixed(2)}/${upL2.toFixed(2)}×${upSize} ▼${dnL1.toFixed(2)}/${dnL2.toFixed(2)}×${dnSize}${pc}`;
  }

  // ── Phase 3: Sweep + bargain hunt ──────────────────────────────────

  private async updateSweepQuotes(
    ctx: StrategyContext,
    w: BoneStarWindow,
    params: BoneStarParams,
    pTrue: number,
    _spot: number,
  ): Promise<void> {
    // Sweep side is locked on Phase 3 entry — prevents catastrophic flip.
    // But we only CONTINUE sweeping if P_true still supports the locked side.
    const sweepSide: "UP" | "DOWN" = w.lockedSweepSide ?? (pTrue > 0.5 ? "UP" : "DOWN");
    const pTrueForSweepSide = sweepSide === "UP" ? pTrue : (1 - pTrue);
    // Oracle edge check: only sweep when oracle P_true > market ask (real edge exists)
    let oracleEdgeOk = true;
    if (params.sweep_use_oracle_edge) {
      const sweepTokenId = sweepSide === "UP" ? w.market.upTokenId : w.market.downTokenId;
      const sweepBook = await this.getBookCached(ctx, sweepTokenId);
      const marketAsk = this.getBestAsk(sweepBook);
      if (marketAsk !== null) {
        const oracleEdge = pTrueForSweepSide - marketAsk;
        oracleEdgeOk = oracleEdge > 0;
        if (ctx.state.ticks % 5 === 0) {
          ctx.log(`Oracle edge: P_true=${pTrueForSweepSide.toFixed(3)} ask=${marketAsk.toFixed(2)} edge=${oracleEdge.toFixed(3)} ok=${oracleEdgeOk}`);
        }
      }
    }

    // Dynamic sweep pricing: compute from P_true instead of static price
    let effectiveSweepPrice = params.sweep_bid_price;
    if (params.sweep_bid_dynamic) {
      effectiveSweepPrice = Math.min(
        Math.max(0.50, pTrueForSweepSide - params.sweep_margin),
        params.max_sweep_price,
      );
    }

    // Late window uses stricter threshold
    const windowProgress = (Date.now() - w.windowOpenTime) / (w.windowEndTime - w.windowOpenTime);
    const effectiveThreshold = windowProgress > 0.75 ? params.sweep_threshold_late : params.sweep_threshold;
    const sweepStillValidLate = pTrueForSweepSide > effectiveThreshold;

    // Sweep bid — only when P_true still supports locked side
    const sweepInv = sweepSide === "UP" ? w.upInventory : w.downInventory;
    const now = Date.now();
    const cooldownOk = now - (w.lastSweepFillAt || 0) >= params.sweep_cooldown_ms;
    const sweepCapOk = sweepInv < params.max_inventory_per_side;
    const sweepCountOk = w.sweepFillCount < params.max_sweeps_per_window;
    const remainingCapacity = Math.max(0, params.max_inventory_per_side - sweepInv);

    // Graduated sweep sizing: scale with confidence margin above threshold
    let sweepSize: number;
    if (!(sweepStillValidLate && oracleEdgeOk && cooldownOk && sweepCapOk && sweepCountOk)) {
      sweepSize = 0;
    } else if (params.sweep_confidence_scale) {
      const margin = pTrueForSweepSide - effectiveThreshold;
      const maxMargin = 1.0 - effectiveThreshold;
      const scale = Math.min(1.0, margin / maxMargin);
      sweepSize = Math.round(params.sweep_min_size + scale * (params.sweep_size - params.sweep_min_size));
      sweepSize = Math.min(sweepSize, remainingCapacity);
    } else {
      sweepSize = Math.min(params.sweep_size, remainingCapacity);
    }

    // Pair cost gate: don't add sweep tokens if pair cost already too high
    if (sweepSize > 0 && params.sweep_max_pair_cost > 0) {
      const pairedCount = Math.min(w.upInventory, w.downInventory);
      const upAvg = w.upInventory > 0 ? w.upAvgCost : 0;
      const dnAvg = w.downInventory > 0 ? w.downAvgCost : 0;
      if (pairedCount > 0 && (upAvg + dnAvg) > params.sweep_max_pair_cost) {
        sweepSize = 0;
      }
    }

    // Paired base check: limit or stop sweep when insufficient paired inventory
    if (sweepSize > 0) {
      const pairedCount = Math.min(w.upInventory, w.downInventory);
      const sweepSideInv = sweepSide === "UP" ? w.upInventory : w.downInventory;
      if (pairedCount === 0 && sweepSideInv >= params.base_bid_size) {
        // Already one-sided — don't pile on more via sweep
        sweepSize = 0;
      } else if (pairedCount < params.sweep_require_paired_base) {
        sweepSize = Math.min(sweepSize, params.sweep_min_size);
      }
    }

    if (sweepSize > 0) {
      await this.placeOrUpdateSweep(ctx, w, sweepSide, effectiveSweepPrice, sweepSize, params);
    } else if (w.sweepOrderId) {
      const r = await safeCancelOrder(ctx.api, w.sweepOrderId);
      if (r.cleared) {
        if (r.fill && w.sweepSide) this.recordFill(ctx, w, w.sweepSide, r.fill.size, r.fill.price, params, "sweep_cancel");
        w.sweepOrderId = null;
      }
    }

    // Maker bids follow ACTUAL P_true direction (not locked side).
    const { upL1, upL2, dnL1, dnL2 } = this.computeLadderPrices(pTrue, w, params);
    const actualUpWinning = pTrue > 0.5;

    let upSize = params.base_bid_size;
    let dnSize = params.base_bid_size;

    if (actualUpWinning) {
      upSize = Math.round(params.base_bid_size * params.conviction_size_mult);
    } else {
      dnSize = Math.round(params.base_bid_size * params.conviction_size_mult);
    }

    // Inventory guards — use actual P_true direction for "winning" side
    const actualWinningInv = actualUpWinning ? w.upInventory : w.downInventory;
    const actualLosingInv = actualUpWinning ? w.downInventory : w.upInventory;
    // Losing side: only buy enough to pair with winning side inventory
    const unpaired = Math.max(0, actualWinningInv - actualLosingInv);
    if (!actualUpWinning && unpaired === 0) upSize = 0; // UP is losing, fully paired
    if (actualUpWinning && unpaired === 0) dnSize = 0;  // DOWN is losing, fully paired
    // One-sided guard: pause winning-side bids when no paired inventory
    if (w.upInventory >= params.base_bid_size && w.downInventory === 0) upSize = 0;
    if (w.downInventory >= params.base_bid_size && w.upInventory === 0) dnSize = 0;
    // Cap both sides at absolute max
    if (w.upInventory >= params.max_inventory_per_side) upSize = 0;
    if (w.downInventory >= params.max_inventory_per_side) dnSize = 0;

    // Inventory ratio guard: suppress heavy side when too imbalanced
    const heavy3 = Math.max(w.upInventory, w.downInventory);
    const light3 = Math.min(w.upInventory, w.downInventory);
    if (light3 > 0 && heavy3 / light3 > params.max_inventory_ratio) {
      if (w.upInventory > w.downInventory) upSize = 0;
      else dnSize = 0;
    }

    await this.placeOrUpdateBid(ctx, w, "UP", upL1, upSize, params, 1);
    await this.placeOrUpdateBid(ctx, w, "UP", upL2, upSize, params, 2);
    await this.placeOrUpdateBid(ctx, w, "DOWN", dnL1, dnSize, params, 1);
    await this.placeOrUpdateBid(ctx, w, "DOWN", dnL2, dnSize, params, 2);

    const pc = (w.upInventory > 0 && w.downInventory > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
    w.tickAction = `P3 SWEEP ${sweepSide}@${effectiveSweepPrice.toFixed(2)}×${sweepSize}: ▲${upL1.toFixed(2)}/${upL2.toFixed(2)}×${upSize} ▼${dnL1.toFixed(2)}/${dnL2.toFixed(2)}×${dnSize}${pc}`;
  }

  // ── Bid placement helpers ──────────────────────────────────────────

  private async placeOrUpdateBid(
    ctx: StrategyContext,
    w: BoneStarWindow,
    side: "UP" | "DOWN",
    bidPrice: number,
    bidSize: number,
    params: BoneStarParams,
    level: 1 | 2 = 1,
  ): Promise<void> {
    // Select order slot based on level
    const isL2 = level === 2;
    const existingOrderId = side === "UP"
      ? (isL2 ? w.upBid2OrderId : w.upBidOrderId)
      : (isL2 ? w.downBid2OrderId : w.downBidOrderId);
    const existingPrice = side === "UP"
      ? (isL2 ? w.upBid2Price : w.upBidPrice)
      : (isL2 ? w.downBid2Price : w.downBidPrice);
    const roundedBid = Math.floor(bidPrice * 100) / 100;
    const labelSuffix = isL2 ? "_L2" : "_L1";

    // Size=0 means inventory guard is active — cancel any existing bid
    if (roundedBid < 0.01 || bidSize <= 0) {
      if (existingOrderId) {
        const r = await safeCancelOrder(ctx.api, existingOrderId);
        if (r.cleared) {
          if (r.fill) {
            this.recordFill(ctx, w, side, r.fill.size, r.fill.price, params, `cancel${labelSuffix}`);
            await this.persistFillToD1(ctx, w, side, r.fill.price, r.fill.size, params, `cancel${labelSuffix}`);
          }
          this.clearOrderSlot(w, side, level);
        }
      }
      return;
    }

    // Skip if existing bid is close enough
    if (existingOrderId && Math.abs(roundedBid - existingPrice) < params.min_requote_delta) return;

    // Cancel existing bid if requote needed
    if (existingOrderId) {
      const r = await safeCancelOrder(ctx.api, existingOrderId);
      if (r.cleared) {
        if (r.fill) {
          this.recordFill(ctx, w, side, r.fill.size, r.fill.price, params, `cancel${labelSuffix}`);
          await this.persistFillToD1(ctx, w, side, r.fill.price, r.fill.size, params, `cancel${labelSuffix}`);
        }
        this.clearOrderSlot(w, side, level);
      } else {
        return; // Cancel failed — don't place new bid while old one exists
      }
    }

    // Spread guard
    const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
    const book = await this.getBookCached(ctx, tokenId);
    const bestAsk = this.getBestAsk(book);
    let finalBid = roundedBid;
    if (bestAsk !== null && finalBid >= bestAsk) {
      finalBid = Math.max(0.01, bestAsk - 0.01);
    }

    const result = await ctx.api.placeOrder({
      token_id: tokenId,
      side: "BUY",
      size: bidSize,
      price: finalBid,
      market: w.market.slug,
      title: `${w.market.title} [BS P${w.phase} ${side} L${level}]`,
    });

    if (result.status === "filled") {
      const fillPrice = result.price;
      const fillSize = result.size;
      this.recordFill(ctx, w, side, fillSize, fillPrice, params, `P${w.phase}_imm${labelSuffix}`);
      await this.persistFillToD1(ctx, w, side, fillPrice, fillSize, params, `P${w.phase}_imm${labelSuffix}`);
    } else if (result.status === "placed") {
      this.setOrderSlot(w, side, level, result.order_id, finalBid, bidSize);
    }
  }

  private clearOrderSlot(w: BoneStarWindow, side: "UP" | "DOWN", level: 1 | 2): void {
    if (side === "UP") {
      if (level === 2) { w.upBid2OrderId = null; w.upBid2Price = 0; w.upBid2Size = 0; }
      else { w.upBidOrderId = null; w.upBidPrice = 0; w.upBidSize = 0; }
    } else {
      if (level === 2) { w.downBid2OrderId = null; w.downBid2Price = 0; w.downBid2Size = 0; }
      else { w.downBidOrderId = null; w.downBidPrice = 0; w.downBidSize = 0; }
    }
  }

  private setOrderSlot(w: BoneStarWindow, side: "UP" | "DOWN", level: 1 | 2, orderId: string, price: number, size: number): void {
    const now = Date.now();
    if (side === "UP") {
      if (level === 2) { w.upBid2OrderId = orderId; w.upBid2Price = price; w.upBid2Size = size; w.upBid2PlacedAt = now; }
      else { w.upBidOrderId = orderId; w.upBidPrice = price; w.upBidSize = size; w.upBidPlacedAt = now; }
    } else {
      if (level === 2) { w.downBid2OrderId = orderId; w.downBid2Price = price; w.downBid2Size = size; w.downBid2PlacedAt = now; }
      else { w.downBidOrderId = orderId; w.downBidPrice = price; w.downBidSize = size; w.downBidPlacedAt = now; }
    }
  }

  /** Cancel quotes older than quote_ttl_ms */
  private async cancelStaleBids(ctx: StrategyContext, w: BoneStarWindow, params: BoneStarParams): Promise<void> {
    if (params.quote_ttl_ms <= 0) return;
    const now = Date.now();
    const ttl = params.quote_ttl_ms;

    for (const [side, level] of [["UP", 1], ["UP", 2], ["DOWN", 1], ["DOWN", 2]] as Array<["UP" | "DOWN", 1 | 2]>) {
      const isL2 = level === 2;
      const orderId = side === "UP"
        ? (isL2 ? w.upBid2OrderId : w.upBidOrderId)
        : (isL2 ? w.downBid2OrderId : w.downBidOrderId);
      const placedAt = side === "UP"
        ? (isL2 ? w.upBid2PlacedAt : w.upBidPlacedAt)
        : (isL2 ? w.downBid2PlacedAt : w.downBidPlacedAt);

      if (orderId && placedAt > 0 && (now - placedAt) > ttl) {
        const r = await safeCancelOrder(ctx.api, orderId);
        if (r.cleared) {
          if (r.fill) {
            this.recordFill(ctx, w, side, r.fill.size, r.fill.price, params, `stale_L${level}`);
            await this.persistFillToD1(ctx, w, side, r.fill.price, r.fill.size, params, `stale_L${level}`);
          }
          this.clearOrderSlot(w, side, level);
        }
      }
    }
  }

  private async placeOrUpdateSweep(
    ctx: StrategyContext,
    w: BoneStarWindow,
    side: "UP" | "DOWN",
    price: number,
    size: number,
    params: BoneStarParams,
  ): Promise<void> {
    // If sweep is already on the correct side, keep it
    if (w.sweepOrderId && w.sweepSide === side) return;

    // Cancel existing sweep if side changed
    if (w.sweepOrderId) {
      const r = await safeCancelOrder(ctx.api, w.sweepOrderId);
      if (r.cleared) {
        if (r.fill && w.sweepSide) {
          this.recordFill(ctx, w, w.sweepSide, r.fill.size, r.fill.price, params, "sweep_cancel");
          await this.persistFillToD1(ctx, w, w.sweepSide, r.fill.price, r.fill.size, params, "sweep_cancel");
          w.sweepFillCount++;
          this.custom.totalSweepFills++;
        }
        w.sweepOrderId = null;
      } else {
        return;
      }
    }

    const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
    const roundedPrice = Math.floor(price * 100) / 100;

    const result = await ctx.api.placeOrder({
      token_id: tokenId,
      side: "BUY",
      size: size,
      price: roundedPrice,
      market: w.market.slug,
      title: `${w.market.title} [BS SWEEP ${side}]`,
    });

    if (result.status === "filled") {
      const fillPrice = result.price;
      const fillSize = result.size;
      this.recordFill(ctx, w, side, fillSize, fillPrice, params, "sweep");
      await this.persistFillToD1(ctx, w, side, fillPrice, fillSize, params, "sweep");
      w.sweepFillCount++;
      this.custom.totalSweepFills++;
      ctx.log(
        `SWEEP FILLED: ${w.market.title.slice(0, 25)} ${side} ${fillSize}@${fillPrice.toFixed(3)}`,
        { level: "trade", symbol: w.cryptoSymbol, direction: side, phase: "sweep_fill" }
      );
    } else if (result.status === "placed") {
      w.sweepOrderId = result.order_id;
      w.sweepSide = side;
      w.sweepPrice = roundedPrice;
      w.sweepSize = size;
    }
  }

  // ── Cancel all bids on a window ────────────────────────────────────

  private async cancelAllBids(ctx: StrategyContext, w: BoneStarWindow, params: BoneStarParams): Promise<void> {
    // Cancel all 4 maker bids (L1 + L2 for UP + DOWN)
    for (const [side, level] of [["UP", 1], ["UP", 2], ["DOWN", 1], ["DOWN", 2]] as Array<["UP" | "DOWN", 1 | 2]>) {
      const isL2 = level === 2;
      const orderId = side === "UP"
        ? (isL2 ? w.upBid2OrderId : w.upBidOrderId)
        : (isL2 ? w.downBid2OrderId : w.downBidOrderId);
      if (orderId) {
        const r = await safeCancelOrder(ctx.api, orderId);
        if (r.cleared) {
          if (r.fill) {
            this.recordFill(ctx, w, side, r.fill.size, r.fill.price, params, `cancel_L${level}`);
            await this.persistFillToD1(ctx, w, side, r.fill.price, r.fill.size, params, `cancel_L${level}`);
          }
          this.clearOrderSlot(w, side, level);
        }
      }
    }
    // Cancel sweep
    if (w.sweepOrderId && w.sweepSide) {
      const r = await safeCancelOrder(ctx.api, w.sweepOrderId);
      if (r.cleared) {
        if (r.fill) {
          this.recordFill(ctx, w, w.sweepSide, r.fill.size, r.fill.price, params, "sweep_cancel");
          await this.persistFillToD1(ctx, w, w.sweepSide, r.fill.price, r.fill.size, params, "sweep_cancel");
          w.sweepFillCount++;
          this.custom.totalSweepFills++;
        }
        w.sweepOrderId = null;
      }
    }
  }

  // ── Resolve windows ────────────────────────────────────────────────

  // Background: confirm oracle-resolved windows via Gamma API
  private async confirmCompletedWindows(ctx: StrategyContext): Promise<void> {
    const unconfirmed = this.custom.completedWindows.filter(
      w => !w.gammaConfirmed && w.slug && w.upTokenId && w.downTokenId
    );
    // Check at most 1 per tick to avoid API spam
    if (unconfirmed.length === 0) return;
    const w = unconfirmed[0];
    try {
      const resolution = await checkMarketResolution(w.slug!, w.upTokenId!, w.downTokenId!);
      if (resolution.closed && resolution.outcome) {
        w.gammaConfirmed = true;
        if (resolution.outcome !== w.outcome && w.outcome !== "UNKNOWN") {
          ctx.log(
            `GAMMA MISMATCH: ${w.title.slice(0, 25)} oracle=${w.outcome} gamma=${resolution.outcome} — using Gamma`,
            { level: "warning" }
          );
          // Gamma is authoritative — recalculate P&L if it disagrees
          w.outcome = resolution.outcome;
        } else {
          ctx.log(`CONFIRMED ✓: ${w.title.slice(0, 25)} ${w.outcome}`, { level: "info" });
        }
      }
    } catch { /* Gamma not ready yet, will retry next tick */ }
  }

  private async resolveWindows(ctx: StrategyContext, params: BoneStarParams): Promise<void> {
    const now = Date.now();
    const toRemove: number[] = [];

    // Background: confirm any unconfirmed completed windows via Gamma
    await this.confirmCompletedWindows(ctx);

    for (let i = 0; i < this.custom.activeWindows.length; i++) {
      const w = this.custom.activeWindows[i];

      // With oracle: resolve 5s after window end. Without: wait 60s for Gamma.
      const hasOracle = w.oracleStrike != null && isOracleConnected();
      const waitMs = hasOracle ? 5_000 : 60_000;
      if (now < w.windowEndTime + waitMs) continue;

      // No inventory — nothing to resolve
      if (w.upInventory === 0 && w.downInventory === 0) {
        ctx.log(`EXPIRED (no fills): ${w.market.title.slice(0, 35)}`);
        toRemove.push(i);
        continue;
      }

      let outcome: "UP" | "DOWN" | "UNKNOWN" = "UNKNOWN";
      let gammaConfirmed = false;

      // 1. Check Polymarket resolution (authoritative)
      try {
        const resolution = await checkMarketResolution(
          w.market.slug, w.market.upTokenId, w.market.downTokenId
        );
        if (resolution.closed && resolution.outcome) {
          outcome = resolution.outcome;
          gammaConfirmed = true;
        }
      } catch { /* Gamma API failure */ }

      // 2. If Gamma hasn't confirmed, use oracle (Chainlink IS the settlement reference)
      const oracleTick = getOracleSpot(w.cryptoSymbol);
      const effectiveStrike = w.oracleStrike ?? w.priceAtWindowOpen;
      if (outcome === "UNKNOWN" && hasOracle && oracleTick) {
        outcome = oracleTick.price >= effectiveStrike ? "UP" : "DOWN";
        // Oracle-determined, not yet Gamma-confirmed
        gammaConfirmed = false;
      }

      if (outcome === "UNKNOWN") {
        // Fallback: Binance as last resort
        const history = this.custom.priceHistory[w.cryptoSymbol] || [];
        const closePrice = findPriceAtTime(history, w.windowEndTime)
          ?? (await fetchSpotPrice(w.cryptoSymbol))?.price ?? null;
        if (closePrice !== null) {
          outcome = closePrice >= effectiveStrike ? "UP" : "DOWN";
          gammaConfirmed = false;
        }
      }

      if (outcome === "UNKNOWN") {
        if (now < w.windowEndTime + 1800_000) continue; // wait up to 30min
        ctx.log(`RESOLUTION TIMEOUT: ${w.market.title.slice(0, 25)}`);
      }

      // P&L: winning side = $1.00 payout, losing side = $0
      let winningPayout = 0;
      let losingLoss = 0;

      if (outcome !== "UNKNOWN") {
        const winInv = outcome === "UP" ? w.upInventory : w.downInventory;
        const winCost = outcome === "UP" ? w.upAvgCost : w.downAvgCost;
        const loseInv = outcome === "UP" ? w.downInventory : w.upInventory;
        const loseCost = outcome === "UP" ? w.downAvgCost : w.upAvgCost;

        const payoutFee = calcFeePerShare(1.0, params.fee_params) * winInv;
        winningPayout = winInv * (1.0 - winCost) - payoutFee;
        losingLoss = -(loseInv * loseCost);
      }

      const netPnl = winningPayout + losingLoss + (w.realizedSellPnl || 0);
      // Price move: use oracle spot if available, else Binance
      const spotPrice = (oracleTick && isOracleConnected()) ? oracleTick.price
        : (this.custom.priceHistory[w.cryptoSymbol]?.length
          ? this.custom.priceHistory[w.cryptoSymbol][this.custom.priceHistory[w.cryptoSymbol].length - 1].price
          : null);
      const priceMovePct = spotPrice !== null && effectiveStrike > 0
        ? ((spotPrice - effectiveStrike) / effectiveStrike) * 100
        : 0;

      const completed: CompletedBoneStarWindow = {
        title: w.market.title,
        cryptoSymbol: w.cryptoSymbol,
        outcome,
        upInventory: w.upInventory,
        downInventory: w.downInventory,
        totalBuyCost: w.totalBuyCost,
        winningPayout,
        losingLoss,
        netPnl,
        fillCount: w.fillCount,
        sweepFillCount: w.sweepFillCount,
        completedAt: new Date().toISOString(),
        priceMovePct,
        upAvgCost: w.upAvgCost,
        downAvgCost: w.downAvgCost,
        maxPhase: w.phase,
        gammaConfirmed,
        slug: w.market.slug,
        upTokenId: w.market.upTokenId,
        downTokenId: w.market.downTokenId,
      };

      this.custom.completedWindows.push(completed);
      if (this.custom.completedWindows.length > 50) {
        this.custom.completedWindows = this.custom.completedWindows.slice(-50);
      }

      this.custom.totalPnl += netPnl;
      this.custom.windowsTraded++;
      if (outcome !== "UNKNOWN") {
        // "Won" = net positive P&L (from pairs + winning excess)
        if (netPnl > 0) this.custom.windowsWon++;
        else this.custom.windowsLost++;
      }

      if (!this.custom.perAsset[w.cryptoSymbol]) {
        this.custom.perAsset[w.cryptoSymbol] = { won: 0, lost: 0, pnl: 0, fills: 0 };
      }
      const asset = this.custom.perAsset[w.cryptoSymbol];
      if (netPnl > 0) asset.won++; else if (outcome !== "UNKNOWN") asset.lost++;
      asset.pnl += netPnl;
      asset.fills += w.fillCount;

      const confirmTag = gammaConfirmed ? "✓" : "○";
      ctx.log(
        `RESOLVED ${confirmTag}: ${w.market.title.slice(0, 25)} ${outcome} | inv ${w.upInventory}↑/${w.downInventory}↓ fills=${w.fillCount} sweeps=${w.sweepFillCount} | win=$${winningPayout.toFixed(2)} lose=$${losingLoss.toFixed(2)} net=$${netPnl.toFixed(2)} | W/L=${this.custom.windowsWon}/${this.custom.windowsLost}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: outcome === "UNKNOWN" ? undefined : outcome, phase: "resolve" }
      );

      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'RESOLVE', 0, 0, 0, datetime('now'), ?)`
        )
        .bind(
          `bs-resolve-${crypto.randomUUID()}`,
          ctx.config.id,
          w.market.conditionId,
          w.market.slug,
          `${w.market.title} [BS ${outcome} fills=${w.fillCount} sweeps=${w.sweepFillCount}]`,
          netPnl
        )
        .run();

      // Update snapshot outcome in D1
      if (params.record_snapshots && w.snapshotId) {
        try {
          await ctx.db.prepare(
            `UPDATE strategy_snapshots SET outcome = ? WHERE id = ?`
          ).bind(outcome, w.snapshotId).run();
          // Purge snapshots older than 7 days
          await ctx.db.prepare(
            `DELETE FROM strategy_snapshots WHERE window_end_time < ?`
          ).bind(Date.now() - 7 * 24 * 60 * 60 * 1000).run();
        } catch { /* best-effort */ }
      }

      toRemove.push(i);
    }

    // Auto-redeem resolved conditions
    if (toRemove.length > 0) {
      const conditionIds = toRemove
        .map((i) => this.custom.activeWindows[i]?.market.conditionId)
        .filter((cid): cid is string => !!cid);
      if (conditionIds.length > 0) {
        try {
          const result = await ctx.api.redeemConditions(conditionIds);
          if (result.error) {
            ctx.log(`AUTO-REDEEM ERROR: ${result.error}`, { level: "error", phase: "redeem" } as never);
          } else {
            ctx.log(`AUTO-REDEEM OK: ${conditionIds.length} conditions`, { level: "info", phase: "redeem" } as never);
          }
        } catch (e) {
          ctx.log(`AUTO-REDEEM EXCEPTION: ${e}`, { level: "error", phase: "redeem" } as never);
        }
      }
    }

    for (const idx of toRemove.reverse()) {
      const removed = this.custom.activeWindows.splice(idx, 1)[0];
      delete this.custom.windowRefPrices[removed.market.conditionId];
    }
  }
}

// ── Register ─────────────────────────────────────────────────────────

registerStrategy("bonestar", () => new BoneStarStrategy());
