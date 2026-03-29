/**
 * Safe Maker Strategy
 *
 * Clone of directional-maker with paired-inventory protection.
 * Never sells paired inventory — only sells excess beyond the matched amount.
 * A balanced 30U/30D pair is structurally profitable; this strategy preserves that.
 *
 * Posts resting bids (maker orders) on both sides of Polymarket "Up or Down"
 * binary markets, biased toward a directional conviction from live crypto prices.
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
  fetchTradeTape,
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
import { classifyRegime, computeRegimeFeatures, type RegimeType, type RegimeFeatures } from "./regime";
import { tryMerge } from "./merge";
import type { TickSnapshot, BookConvictionSnapshot, TapeBucket, TapeMeta } from "../optimizer/types";

// ── Types ────────────────────────────────────────────────────────────

interface MakerWindowPosition {
  market: CryptoMarket;
  cryptoSymbol: string;
  windowOpenTime: number;
  windowEndTime: number;
  priceAtWindowOpen: number;

  // Active bids
  upBidOrderId: string | null;
  upBidPrice: number;
  upBidSize: number;
  downBidOrderId: string | null;
  downBidPrice: number;
  downBidSize: number;

  // Accumulated inventory from fills
  upInventory: number;
  upAvgCost: number;
  downInventory: number;
  downAvgCost: number;

  // Signal tracking
  lastSignalDirection: "UP" | "DOWN" | null;
  lastQuotedAt: number;
  lastQuotedPriceChangePct: number;

  // Hysteresis
  confirmedDirection: "UP" | "DOWN" | null;
  flipCount: number;
  lastDirectionChangeAt: number;

  // Pending sell tracking (real mode)
  pendingSellOrderId: string | null;
  pendingSellSide: "UP" | "DOWN" | null;
  pendingSellSize: number;
  pendingSellCostBasis: number;

  // Oracle + book tracking
  oracleStrike: number | null;
  lastUpMid: number | null;
  lastDownMid: number | null;
  lastFlipSellAt: number;

  // Stats
  fillCount: number;
  sellCount: number;
  realizedSellPnl: number;
  totalBuyCost: number;
  convictionSide: "UP" | "DOWN" | null;
  signalStrengthAtEntry: number;
  enteredAt: number;
  tickAction: string;

  // Set when window is past end time but awaiting Polymarket resolution
  binancePrediction?: "UP" | "DOWN" | null;

  // Transient — set by updateQuotes(), read by snapshot recorder
  lastRegime?: RegimeType;
  lastRegimeFeatures?: RegimeFeatures;
  lastRegimeScores?: Record<string, number>;
  lastFairUp?: number;
  lastFairDown?: number;
  lastBookConviction?: BookConvictionSnapshot;
  lastBookBids?: { price: number; size: number }[];

  // Snapshot recording (populated when record_snapshots=true)
  tickSnapshots?: TickSnapshot[];
  snapshotId?: string; // deterministic D1 row ID for incremental snapshot persistence

  // Cumulative tape: tracks token-specific trades seen since window open.
  // The global tape (200 trades) is too sparse per-token, so we accumulate
  // across ticks to build a complete picture of our token's trade activity.
  cumulativeTapeBuckets?: Map<string, number>; // "tokenId:price" → total size
  cumulativeTapeWallets?: Set<string>;
  cumulativeTapeVolume?: number;
  cumulativeTapeCount?: number;
  lastTapeTimestamp?: number; // highest timestamp seen, to deduplicate
}

interface BookConviction {
  upMid: number | null;
  downMid: number | null;
  bookDirection: "UP" | "DOWN" | "NEUTRAL";
  bookStrength: number;       // 0-1
  bookBidDepthRatio: number;  // UP depth / total depth
  midDelta: number;           // tick-over-tick UP mid change
  agreement: number;          // -1 to +1 with signal direction
}

interface CombinedConviction {
  combinedStrength: number;
  combinedDirection: "UP" | "DOWN";
  sellApproved: boolean;
  reason: string;
}

export interface CompletedMakerWindow {
  title: string;
  cryptoSymbol: string;
  convictionSide: "UP" | "DOWN" | null;
  outcome: "UP" | "DOWN" | "UNKNOWN";
  upInventory: number;
  downInventory: number;
  totalBuyCost: number;
  realizedSellPnl: number;
  winningPayout: number;
  losingLoss: number;
  netPnl: number;
  signalStrength: number;
  fillCount: number;
  sellCount: number;
  correct: boolean;
  completedAt: string;
  priceMovePct: number;
  upAvgCost: number;
  downAvgCost: number;
  flipCount: number;
}

export interface MakerCustomState {
  activeWindows: MakerWindowPosition[];
  completedWindows: CompletedMakerWindow[];
  priceHistory: Record<string, PriceSnapshot[]>;
  windowRefPrices: Record<string, { price: number; recordedAt: number }>;
  totalPnl: number;
  totalMakerFills: number;
  windowsTraded: number;
  windowsWon: number;
  windowsLost: number;
  directionalAccuracy: number;
  perAsset: Record<string, { won: number; lost: number; pnl: number; fills: number }>;
  scanStatus: string;
  currentBaseSize?: number;
}

export interface DirectionalMakerParams {
  target_cryptos: string[];
  base_bid_size: number;
  conviction_bias: number;
  bid_offset: number;
  min_spread: number;
  requote_threshold_pct: number;
  observation_seconds: number;
  stop_quoting_before_end_ms: number;
  exit_inventory_before_end_ms: number;
  max_capital_per_window: number;
  max_concurrent_windows: number;
  min_signal_strength: number;
  fee_params: FeeParams;
  discovery_interval_ms: number;
  enable_order_flow: boolean; // enable Binance WebSocket for order flow (local dev only)
  dead_zone_pct: number;
  max_flips_per_window: number;
  max_pair_cost: number; // UP_bid + DN_bid must be <= this (default 0.96)
  max_inventory_ratio: number; // stop bidding on heavy side when ratio exceeds this (default 3)
  grounded_fills: boolean; // use trade tape instead of probabilistic model (default true)
  max_bid_per_side: number; // hard cap on any single-side bid price (default 0.45)
  // Adaptive repricing
  min_requote_delta: number; // min bid price change ($) to trigger requote (default 0.02)
  vol_offset_scale_high: number; // multiply bid_offset in high volatility (default 1.5)
  vol_offset_scale_low: number; // multiply bid_offset in low volatility (default 0.5)
  tighten_start_pct: number; // window progress % to start tightening offset (default 0.70)
  merge_enabled?: boolean;
  // Multi-source conviction gates
  min_flip_sell_strength: number; // combined strength required for flip sell (default 0.55)
  flip_sell_cooldown_ms: number;  // min ms between flip sells on same window (default 15000)
  sell_excess: boolean; // sell excess (unpaired) inventory on flips/rebalance (default true)
  record_snapshots?: boolean; // record per-tick snapshots for offline replay (default false)
}

export const DEFAULT_PARAMS: DirectionalMakerParams = {
  target_cryptos: ["Bitcoin", "Ethereum", "Solana", "XRP"],
  base_bid_size: 30,
  conviction_bias: 2.0,
  bid_offset: 0.02,
  min_spread: 0.03,
  requote_threshold_pct: 0.05,
  observation_seconds: 20,
  stop_quoting_before_end_ms: 45_000,
  exit_inventory_before_end_ms: 15_000,
  max_capital_per_window: 50,
  max_concurrent_windows: 12, // run on all available timeframes
  min_signal_strength: 0.45,
  fee_params: CRYPTO_FEES,
  discovery_interval_ms: 15_000,
  enable_order_flow: false,
  dead_zone_pct: 0, // 0 = use per-asset defaults from price-feed
  max_flips_per_window: 3,
  max_pair_cost: 0.93, // UP_bid + DN_bid <= 0.93 ensures ~7% structural profit per pair
  max_inventory_ratio: 2, // stop bidding heavy side when UP/DN ratio > 2:1
  grounded_fills: true, // use observed trade tape for paper fills (realistic)
  max_bid_per_side: 0.45, // never bid above $0.45 per side (prevents costly taker fills at $0.85+)
  // Adaptive repricing
  min_requote_delta: 0.02, // won't requote unless new bid differs by >= 2¢
  vol_offset_scale_high: 1.5, // widen offset in high volatility
  vol_offset_scale_low: 0.5, // tighten offset in low volatility
  tighten_start_pct: 0.70, // start tightening at 70% through window
  merge_enabled: true,
  min_flip_sell_strength: 0.55,
  flip_sell_cooldown_ms: 15_000,
  sell_excess: true,
  record_snapshots: false,
};

// ── Helpers ──────────────────────────────────────────────────────────

function getMid(book: OrderBook): number | null {
  if (book.bids.length === 0 || book.asks.length === 0) return null;
  return (book.bids[0].price + book.asks[0].price) / 2;
}

function getSpread(book: OrderBook): number {
  if (book.bids.length === 0 || book.asks.length === 0) return 0;
  return book.asks[0].price - book.bids[0].price;
}

function findPriceAtTime(
  history: PriceSnapshot[],
  targetTime: number
): number | null {
  if (history.length === 0) return null;
  let closest: PriceSnapshot | null = null;
  let minDiff = Infinity;
  for (const snap of history) {
    const diff = Math.abs(snap.timestamp - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      closest = snap;
    }
  }
  if (closest && minDiff < 30_000) return closest.price;
  return null;
}

export function emptyCustom(): MakerCustomState {
  return {
    activeWindows: [],
    completedWindows: [],
    priceHistory: {},
    windowRefPrices: {},
    totalPnl: 0,
    totalMakerFills: 0,
    windowsTraded: 0,
    windowsWon: 0,
    windowsLost: 0,
    directionalAccuracy: 0,
    perAsset: {},
    scanStatus: "Starting up…",
  };
}

// ── Strategy ─────────────────────────────────────────────────────────

interface BookCacheEntry {
  book: OrderBook;
  fetchedAt: number;
}

export class SafeMakerStrategy implements Strategy {
  name = "safe-maker";
  protected custom: MakerCustomState = emptyCustom();
  protected marketCache: CryptoMarket[] = [];
  protected lastDiscovery = 0;

  // Book cache: 5s TTL, shared across windows to avoid redundant fetches
  protected bookCache: Map<string, BookCacheEntry> = new Map();
  private static BOOK_CACHE_TTL = 5_000;

  protected getBaseSize(params: DirectionalMakerParams): number {
    return params.base_bid_size;
  }

  protected onWindowResolved(_completed: CompletedMakerWindow, _params: DirectionalMakerParams, _ctx: StrategyContext): void {}

  private async getBookCached(ctx: StrategyContext, tokenId: string): Promise<OrderBook> {
    const now = Date.now();
    const cached = this.bookCache.get(tokenId);
    if (cached && now - cached.fetchedAt < SafeMakerStrategy.BOOK_CACHE_TTL) {
      return cached.book;
    }
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

  private async computeBookConviction(
    ctx: StrategyContext,
    w: MakerWindowPosition,
    signal: WindowSignal
  ): Promise<BookConviction> {
    const [upBook, downBook] = await Promise.all([
      this.getBookCached(ctx, w.market.upTokenId),
      this.getBookCached(ctx, w.market.downTokenId),
    ]);

    const upMid = getMid(upBook);
    const downMid = getMid(downBook);

    // Determine book direction from deviation
    let bookDirection: "UP" | "DOWN" | "NEUTRAL" = "NEUTRAL";
    let bookStrength = 0;

    if (upMid != null && downMid != null) {
      const deviation = upMid - downMid;
      if (Math.abs(deviation) > 0.04) {
        bookDirection = deviation > 0 ? "UP" : "DOWN";
      }
      bookStrength = Math.min(1.0, Math.abs(deviation) / 0.50);
    } else if (upMid != null) {
      // Single-book fallback
      if (upMid > 0.54) { bookDirection = "UP"; bookStrength = Math.min(1.0, (upMid - 0.50) / 0.50); }
      else if (upMid < 0.46) { bookDirection = "DOWN"; bookStrength = Math.min(1.0, (0.50 - upMid) / 0.50); }
    } else if (downMid != null) {
      if (downMid > 0.54) { bookDirection = "DOWN"; bookStrength = Math.min(1.0, (downMid - 0.50) / 0.50); }
      else if (downMid < 0.46) { bookDirection = "UP"; bookStrength = Math.min(1.0, (0.50 - downMid) / 0.50); }
    }

    // Bid depth ratio: UP bid depth / total bid depth
    const upBidDepth = upBook.bids.reduce((s, l) => s + l.size, 0);
    const dnBidDepth = downBook.bids.reduce((s, l) => s + l.size, 0);
    const totalBidDepth = upBidDepth + dnBidDepth;
    const bookBidDepthRatio = totalBidDepth > 0 ? upBidDepth / totalBidDepth : 0.5;

    // Mid delta (tick-over-tick change in UP mid)
    const midDelta = (upMid != null && w.lastUpMid != null) ? upMid - w.lastUpMid : 0;

    // Agreement with signal direction
    let agreement = 0;
    const signalScale = Math.min(1, signal.signalStrength / 0.5);
    if (bookDirection !== "NEUTRAL") {
      const matches = bookDirection === signal.direction;
      agreement = matches
        ? bookStrength * signalScale
        : -bookStrength * signalScale;
    }

    // Update last mids for next tick
    w.lastUpMid = upMid;
    w.lastDownMid = downMid;

    // Save book bids for snapshot recording (top 5 levels)
    w.lastBookBids = upBook.bids.slice(0, 5).map(l => ({ price: l.price, size: l.size }));

    return { upMid, downMid, bookDirection, bookStrength, bookBidDepthRatio, midDelta, agreement };
  }

  private computeCombinedConviction(
    signal: WindowSignal,
    book: BookConviction,
    params: DirectionalMakerParams,
    w: MakerWindowPosition
  ): CombinedConviction {
    const now = Date.now();

    // Oracle already baked into signalStrength via the corrected strike price
    // Book modulates confidence
    const bookContribution = book.agreement >= 0
      ? book.bookStrength * 0.30
      : -book.bookStrength * 0.30 * 0.5;

    // Choppiness penalty from existing volatilityRegime
    const chopPenalty = signal.volatilityRegime === "high" ? -0.10
      : signal.volatilityRegime === "low" ? 0.05
      : 0;

    const rawCombined = signal.signalStrength * 0.55 + bookContribution + chopPenalty;
    const combinedStrength = Math.max(0, Math.min(1, rawCombined));
    const combinedDirection = signal.direction;

    // Three gates for sell approval
    const cooldownOk = now - w.lastFlipSellAt >= params.flip_sell_cooldown_ms;
    const strengthOk = combinedStrength >= params.min_flip_sell_strength;
    const bookNonContradiction = book.agreement >= -0.2
      && (book.bookDirection === signal.direction || book.bookDirection === "NEUTRAL");

    let sellApproved = cooldownOk && strengthOk && bookNonContradiction;
    let reason = "approved";

    if (!cooldownOk) {
      const remaining = Math.ceil((params.flip_sell_cooldown_ms - (now - w.lastFlipSellAt)) / 1000);
      reason = `cooldown=${remaining}s remaining`;
      sellApproved = false;
    } else if (!strengthOk) {
      reason = `combined_weak: ${(combinedStrength * 100).toFixed(0)}% < ${(params.min_flip_sell_strength * 100).toFixed(0)}%`;
      sellApproved = false;
    } else if (!bookNonContradiction) {
      reason = `book_contradicts: agreement=${book.agreement.toFixed(2)} book=${book.bookDirection} vs signal=${signal.direction}`;
      sellApproved = false;
    }

    return { combinedStrength, combinedDirection, sellApproved, reason };
  }

  async init(ctx: StrategyContext): Promise<void> {
    const stored = ctx.state.custom as Partial<MakerCustomState>;
    this.custom = {
      ...emptyCustom(),
      ...stored,
      activeWindows: stored.activeWindows || [],
      completedWindows: stored.completedWindows || [],
      priceHistory: stored.priceHistory || {},
      windowRefPrices: stored.windowRefPrices || {},
    };
    // Enable order flow WebSocket if configured (local dev only)
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as DirectionalMakerParams;
    if (params.enable_order_flow) {
      const symbols = params.target_cryptos
        .map((c) => CRYPTO_SYMBOL_MAP[c.toLowerCase()])
        .filter(Boolean) as string[];
      enableOrderFlow(symbols);
      ctx.log(`Order flow enabled for: ${symbols.join(", ")}`);
    }

    ctx.log(
      `Initialized: ${this.custom.activeWindows.length} active, ${this.custom.totalMakerFills} total fills, accuracy=${(this.custom.directionalAccuracy * 100).toFixed(0)}%`
    );
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const params = {
      ...DEFAULT_PARAMS,
      ...ctx.config.params,
    } as DirectionalMakerParams;

    const now = Date.now();

    // 1. Discover markets
    if (now - this.lastDiscovery > params.discovery_interval_ms) {
      this.marketCache = await discoverCryptoMarkets(
        params.target_cryptos,
        params.stop_quoting_before_end_ms + 30_000
      );
      this.lastDiscovery = now;
      if (this.marketCache.length > 0) {
        ctx.log(`Discovered ${this.marketCache.length} markets`);
      }
    }

    // 2. Fetch prices
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
          this.custom.priceHistory[sym] =
            this.custom.priceHistory[sym].slice(-60);
        }
      }
    }

    // 2b. Prune price history for symbols no longer active
    for (const sym of Object.keys(this.custom.priceHistory)) {
      if (!activeSymbols.has(sym)) {
        delete this.custom.priceHistory[sym];
      }
    }

    // 3. Manage active windows (check fills, requote, exit)
    await this.manageWindows(ctx, params);

    // 4. Enter new windows (skip when winding down)
    let entered = 0;
    let marketsScanned = 0;
    let skipCounts: Record<string, number> = {};
    if (!ctx.windingDown && this.custom.activeWindows.length < params.max_concurrent_windows) {
      const result = await this.enterWindows(ctx, params);
      entered = result.entered;
      marketsScanned = result.marketsScanned;
      skipCounts = result.skipCounts;
    }

    // 5. Resolve completed windows
    await this.resolveWindows(ctx, params);

    // 5b. Wind-down: drop empty windows (no fills = nothing at stake)
    if (ctx.windingDown) {
      const before = this.custom.activeWindows.length;
      this.custom.activeWindows = this.custom.activeWindows.filter(
        w => w.upInventory + w.downInventory > 0 || w.totalBuyCost > 0
      );
      if (this.custom.activeWindows.length < before) {
        ctx.log(`Wind-down: dropped ${before - this.custom.activeWindows.length} empty window(s)`);
      }
    }

    // 6. Update scan status for UI
    const totalInv = this.custom.activeWindows.reduce(
      (s, w) => s + w.upInventory + w.downInventory, 0
    );
    if (ctx.windingDown) {
      this.custom.scanStatus = this.custom.activeWindows.length > 0
        ? `Winding down: ${this.custom.activeWindows.length} window${this.custom.activeWindows.length > 1 ? "s" : ""} remaining, ${totalInv} tokens`
        : "Wind-down complete, waiting for resolution…";
    } else if (this.custom.activeWindows.length > 0) {
      this.custom.scanStatus = totalInv > 0
        ? `${this.custom.activeWindows.length} active, ${totalInv} tokens held`
        : `${this.custom.activeWindows.length} active, waiting for fills…`;
    } else if (marketsScanned > 0) {
      const reasons = Object.entries(skipCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${count} ${reason}`)
        .join(", ");
      // Descriptive message when capital is the main blocker
      if (skipCounts["capital limit"] && skipCounts["capital limit"] >= marketsScanned * 0.5) {
        const deployed = this.custom.activeWindows.reduce(
          (sum, w) => sum + w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost, 0
        );
        this.custom.scanStatus = `Capital exhausted: $${ctx.config.max_capital_usd.toFixed(2)} available, $${deployed.toFixed(2)} deployed`;
      } else {
        this.custom.scanStatus = `Scanned ${marketsScanned} markets: ${reasons || "all entered"}`;
      }
    } else if (this.marketCache.length > 0) {
      this.custom.scanStatus = "No open windows";
    } else {
      this.custom.scanStatus = "Scanning for markets…";
    }

    // 7. Persist state
    ctx.state.custom = this.custom as unknown as Record<string, unknown>;
    ctx.state.capital_deployed = this.custom.activeWindows.reduce(
      (sum, w) => sum + w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost, 0
    );
    ctx.state.total_pnl = this.custom.totalPnl;
  }

  async stop(ctx: StrategyContext): Promise<void> {
    // Cancel all resting bids
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as DirectionalMakerParams;
    for (const w of this.custom.activeWindows) {
      if (w.upBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
        if (r.cleared) {
          if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price, params);
          w.upBidOrderId = null;
        }
      }
      if (w.downBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
        if (r.cleared) {
          if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price, params);
          w.downBidOrderId = null;
        }
      }
    }
    if (params.enable_order_flow) {
      disableOrderFlow();
    }
    ctx.log(
      `Stopped: cancelled all bids. ${this.custom.totalMakerFills} total fills, P&L=$${ctx.state.total_pnl.toFixed(2)}`
    );
  }

  /** Record a fill discovered during a failed cancel attempt */
  private recordFillFromCancel(
    ctx: StrategyContext,
    w: MakerWindowPosition,
    side: "UP" | "DOWN",
    size: number,
    price: number,
    params: DirectionalMakerParams
  ): void {
    // Maker fills (resting limit orders) have ZERO fee on Polymarket.
    // This path is only hit for resting orders that were matched before cancel.
    const costBasis = price;
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
    this.custom.totalMakerFills++;
    ctx.log(
      `CANCEL-FILL ${side}: ${w.market.title.slice(0, 25)} ${size}@${price.toFixed(3)} (discovered during cancel)`,
      { level: "trade", symbol: w.cryptoSymbol, direction: side, phase: "cancel_fill" }
    );
  }

  // ── Enter new market windows ────────────────────────────────────

  private async enterWindows(
    ctx: StrategyContext,
    params: DirectionalMakerParams
  ): Promise<{ entered: number; marketsScanned: number; skipCounts: Record<string, number> }> {
    const now = Date.now();
    const activeConditions = new Set(
      this.custom.activeWindows.map((w) => w.market.conditionId)
    );
    const skipCounts: Record<string, number> = {};
    let marketsScanned = 0;

    // Total deployed capital: inventory + pending bids (worst case if all fill)
    const capitalCommitted = this.custom.activeWindows.reduce(
      (sum, w) => {
        const inv = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
        const pending = (w.upBidOrderId ? w.upBidSize * w.upBidPrice : 0)
          + (w.downBidOrderId ? w.downBidSize * w.downBidPrice : 0);
        return sum + inv + pending;
      }, 0
    );
    const totalSpent = this.custom.activeWindows.reduce((sum, w) => sum + w.totalBuyCost, 0);

    const windowsBefore = this.custom.activeWindows.length;
    for (const market of this.marketCache) {
      if (this.custom.activeWindows.length >= params.max_concurrent_windows)
        break;
      if (activeConditions.has(market.conditionId)) continue;

      const sym = extractCryptoSymbol(market.title);
      if (!sym) continue;
      marketsScanned++;

      // Check capital limit before entering new window
      const estNewWindowCost = params.max_pair_cost * this.getBaseSize(params);
      if (capitalCommitted + estNewWindowCost > ctx.config.max_capital_usd) {
        skipCounts["capital limit"] = (skipCounts["capital limit"] || 0) + 1;
        break;
      }

      const endMs = new Date(market.endDate).getTime();
      const windowDuration = parseWindowDurationMs(market.title);
      const windowOpenTime = endMs - windowDuration;
      const timeToEnd = endMs - now;

      if (now < windowOpenTime) {
        skipCounts["not yet open"] = (skipCounts["not yet open"] || 0) + 1;
        continue;
      }
      if (timeToEnd < params.stop_quoting_before_end_ms) {
        skipCounts["ending soon"] = (skipCounts["ending soon"] || 0) + 1;
        continue;
      }

      // Get or record reference price for this window
      const refKey = market.conditionId;
      const history = this.custom.priceHistory[sym] || [];
      const latestSnap = history.length > 0 ? history[history.length - 1] : null;

      if (!this.custom.windowRefPrices[refKey]) {
        if (!latestSnap) {
          skipCounts["no price data"] = (skipCounts["no price data"] || 0) + 1;
          continue;
        }
        this.custom.windowRefPrices[refKey] = {
          price: latestSnap.price,
          recordedAt: latestSnap.timestamp,
        };
        ctx.log(
          `${market.title.slice(0, 40)}: ref price recorded ${latestSnap.price.toFixed(2)}, observing...`
        );
        skipCounts["observing"] = (skipCounts["observing"] || 0) + 1;
        continue;
      }

      const ref = this.custom.windowRefPrices[refKey];
      const openPrice = ref.price;
      const timeSinceRef = now - ref.recordedAt;
      if (timeSinceRef < params.observation_seconds * 1000) {
        skipCounts["observing"] = (skipCounts["observing"] || 0) + 1;
        continue;
      }

      // Check spreads
      const [upBook, downBook] = await Promise.all([
        ctx.api.getBook(market.upTokenId),
        ctx.api.getBook(market.downTokenId),
      ]);

      const upSpread = getSpread(upBook);
      const downSpread = getSpread(downBook);
      if (upSpread < params.min_spread && downSpread < params.min_spread) {
        skipCounts["spread too tight"] = (skipCounts["spread too tight"] || 0) + 1;
        continue;
      }

      // Compute initial signal
      const currentSnap = await fetchSpotPrice(sym);
      if (!currentSnap) {
        skipCounts["no price data"] = (skipCounts["no price data"] || 0) + 1;
        continue;
      }
      const signal = computeSignal(
        sym,
        openPrice,
        currentSnap.price,
        timeSinceRef,
        history.filter((s) => s.timestamp >= ref.recordedAt)
      );

      const convictionSide =
        signal.signalStrength >= params.min_signal_strength
          ? signal.direction
          : null;

      // Fetch oracle strike for settlement-referenced signal
      let oracleStrike: number | null = null;
      try {
        const eventStart = new Date(windowOpenTime).toISOString();
        const oracleSymbol = toOracleSymbol(sym);
        const variant = toVariant(windowDuration);
        oracleStrike = await fetchOracleStrike(oracleSymbol, variant, eventStart);
        if (oracleStrike != null) {
          const drift = Math.abs(oracleStrike - openPrice).toFixed(2);
          ctx.log(`Oracle strike: $${oracleStrike.toFixed(2)} (Binance: $${openPrice.toFixed(2)}, drift: $${drift})`);
        }
      } catch { /* oracle fetch is best-effort */ }

      const window: MakerWindowPosition = {
        market,
        cryptoSymbol: sym,
        windowOpenTime,
        windowEndTime: endMs,
        priceAtWindowOpen: openPrice,
        upBidOrderId: null,
        upBidPrice: 0,
        upBidSize: 0,
        downBidOrderId: null,
        downBidPrice: 0,
        downBidSize: 0,
        upInventory: 0,
        upAvgCost: 0,
        downInventory: 0,
        downAvgCost: 0,
        lastSignalDirection: convictionSide,
        lastQuotedAt: 0,
        lastQuotedPriceChangePct: signal.priceChangePct,
        confirmedDirection: convictionSide,
        flipCount: 0,
        lastDirectionChangeAt: now,
        oracleStrike,
        lastUpMid: null,
        lastDownMid: null,
        lastFlipSellAt: 0,
        pendingSellOrderId: null,
        pendingSellSide: null,
        pendingSellSize: 0,
        pendingSellCostBasis: 0,
        fillCount: 0,
        sellCount: 0,
        realizedSellPnl: 0,
        totalBuyCost: 0,
        convictionSide,
        signalStrengthAtEntry: signal.signalStrength,
        enteredAt: now,
        tickAction: "",
      };
      if (params.record_snapshots) {
        window.tickSnapshots = [];
        window.snapshotId = `snap-${market.conditionId}-${now}`;
      }

      this.custom.activeWindows.push(window);

      const convLabel = convictionSide
        ? `${convictionSide}@${(signal.signalStrength * 100).toFixed(0)}%`
        : "NEUTRAL";
      const upMid = getMid(upBook);
      const downMid = getMid(downBook);
      const upDepth = upBook.asks.reduce((s, l) => s + l.size, 0);
      const downDepth = downBook.asks.reduce((s, l) => s + l.size, 0);
      const flowStr = signal.orderFlowAvailable
        ? ` flow=${signal.orderFlowImbalance.toFixed(2)}`
        : "";
      ctx.log(
        `ENTERED: ${market.title.slice(0, 35)} ${sym} ${signal.priceChangePct >= 0 ? "+" : ""}${signal.priceChangePct.toFixed(3)}% vel=${signal.velocity.toFixed(4)}/s mom=${signal.momentum.toFixed(2)} vol=${signal.volatilityRegime} confX=${signal.confidenceMultiplier.toFixed(1)}${flowStr} | conv=${convLabel} UP_mid=${upMid?.toFixed(2) ?? "?"} DN_mid=${downMid?.toFixed(2) ?? "?"} | spread UP=${upSpread.toFixed(3)} DN=${downSpread.toFixed(3)} depth UP=${upDepth.toFixed(0)} DN=${downDepth.toFixed(0)}`,
        { level: "signal", symbol: sym, direction: convictionSide ?? signal.direction, signalStrength: signal.signalStrength, priceChangePct: signal.priceChangePct, momentum: signal.momentum, volatilityRegime: signal.volatilityRegime, inDeadZone: false, flipCount: 0, phase: "entry" }
      );
    }
    return { entered: this.custom.activeWindows.length - windowsBefore, marketsScanned, skipCounts };
  }

  // ── Manage active windows ───────────────────────────────────────

  private async manageWindows(
    ctx: StrategyContext,
    params: DirectionalMakerParams
  ): Promise<void> {
    const now = Date.now();

    for (const w of this.custom.activeWindows) {
      // Re-init tickSnapshots after DO re-hydration (stripped by persistState)
      // Load previously flushed ticks from D1 so we don't lose data on eviction
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
      }

      const timeToEnd = w.windowEndTime - now;

      // Past resolution — handled by resolveWindows
      if (now > w.windowEndTime + 300_000) {
        w.tickAction = "Awaiting resolution";
        continue;
      }

      // Wind-down mode: match light side, cancel heavy side, no new exposure
      if (ctx.windingDown && timeToEnd >= params.stop_quoting_before_end_ms) {
        await this.windDownWindow(ctx, w, params);
        // tickAction is set inside windDownWindow — don't overwrite it here
        continue;
      }

      // Exit inventory phase: dump losing side at market before resolution
      if (timeToEnd < params.exit_inventory_before_end_ms) {
        if (w.upBidOrderId) {
          const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price, params); w.upBidOrderId = null; }
        }
        if (w.downBidOrderId) {
          const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price, params); w.downBidOrderId = null; }
        }
        // Sell losing side inventory if any
        await this.sellLosingInventory(ctx, w, params, "DUMP");
        w.tickAction = `Exiting: sell excess ${w.upInventory}↑/${w.downInventory}↓`;
        continue;
      }

      // Stop quoting phase: cancel bids, sell losing side
      if (timeToEnd < params.stop_quoting_before_end_ms) {
        if (w.upBidOrderId) {
          const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price, params); w.upBidOrderId = null; }
        }
        if (w.downBidOrderId) {
          const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price, params); w.downBidOrderId = null; }
        }
        // Merge matched pairs during wind-down — free capital before resolution
        if (params.merge_enabled !== false) {
          const mergeResult = await tryMerge(ctx, w);
          if (mergeResult) {
            w.realizedSellPnl += mergeResult.pnl;
            this.custom.totalPnl = (this.custom.totalPnl as number || 0) + mergeResult.pnl;
          }
        }
        await this.sellLosingInventory(ctx, w, params, "WIND DOWN");
        {
          const up = w.upInventory, dn = w.downInventory;
          const pc = (up > 0 && dn > 0) ? (w.upAvgCost + w.downAvgCost).toFixed(2) : "—";
          w.tickAction = `Stop: holding ${up}↑/${dn}↓ pc=${pc}`;
        }
        continue;
      }

      // Retry oracle strike if not yet captured (1min cache makes this cheap)
      if (w.oracleStrike == null) {
        try {
          const eventStart = new Date(w.windowOpenTime).toISOString();
          const oracleSymbol = toOracleSymbol(w.cryptoSymbol);
          const wDurMs2 = w.windowEndTime - w.windowOpenTime;
          const variant = toVariant(wDurMs2);
          w.oracleStrike = await fetchOracleStrike(oracleSymbol, variant, eventStart);
          if (w.oracleStrike != null) {
            const drift = Math.abs(w.oracleStrike - w.priceAtWindowOpen).toFixed(2);
            ctx.log(`Oracle strike (retry): $${w.oracleStrike.toFixed(2)} (Binance: $${w.priceAtWindowOpen.toFixed(2)}, drift: $${drift})`);
          }
        } catch { /* best-effort */ }
      }

      // Compute signal once for this tick (used by both checkFills and updateQuotes)
      // Use oracle strike if available — measures direction against actual settlement reference
      const effectiveOpenPrice = w.oracleStrike ?? w.priceAtWindowOpen;
      const currentSnap = await fetchSpotPrice(w.cryptoSymbol);
      if (!currentSnap) continue;

      const history = this.custom.priceHistory[w.cryptoSymbol] || [];
      const signalOpts: ComputeSignalOptions = {
        prevDirection: w.confirmedDirection,
      };
      if (params.dead_zone_pct > 0) signalOpts.deadZonePct = params.dead_zone_pct;
      const signal = computeSignal(
        w.cryptoSymbol,
        effectiveOpenPrice,
        currentSnap.price,
        now - w.windowOpenTime,
        history.filter((s) => s.timestamp >= w.windowOpenTime),
        signalOpts
      );

      // Check fills on pending bids (using signal-derived fair value)
      await this.checkFills(ctx, w, params, signal);

      // Update signal and requote if needed
      await this.updateQuotes(ctx, w, params, signal);

      // Record tick snapshot for offline replay
      if (params.record_snapshots && w.tickSnapshots) {
        const tapeNow = await fetchTradeTape();

        // Initialize cumulative tape tracker on first tick
        if (!w.cumulativeTapeBuckets) {
          w.cumulativeTapeBuckets = new Map();
          w.cumulativeTapeWallets = new Set();
          w.cumulativeTapeVolume = 0;
          w.cumulativeTapeCount = 0;
          w.lastTapeTimestamp = 0;
        }

        // Accumulate NEW token-specific trades since last tick.
        // The global tape has 200 trades across all markets; we extract only
        // trades for our UP/DOWN tokens with timestamps > lastTapeTimestamp
        // to build a cumulative view of our token's trade activity.
        const relevantTokens = new Set([w.market.upTokenId, w.market.downTokenId]);
        for (const t of tapeNow) {
          if (!relevantTokens.has(t.asset)) continue;
          // Deduplicate: only count trades newer than what we've seen
          const ts = t.timestamp;
          if (ts <= w.lastTapeTimestamp!) continue;
          if (t.taker) w.cumulativeTapeWallets!.add(t.taker);
          w.cumulativeTapeVolume! += t.size * t.price;
          w.cumulativeTapeCount!++;
          const roundedPrice = Math.round(t.price * 100) / 100;
          const key = `${t.asset}:${roundedPrice}`;
          w.cumulativeTapeBuckets!.set(key, (w.cumulativeTapeBuckets!.get(key) ?? 0) + t.size);
        }
        // Update high-water timestamp from all relevant trades (not just new ones)
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

        w.tickSnapshots.push({
          t: now,
          price: currentSnap.price,
          signal,
          regime: w.lastRegime ?? "calm",
          regimeFeatures: w.lastRegimeFeatures ?? { choppiness: 0, trendStrength: 0, realizedVol: 0, momentum: 0, signalStrength: 0, distanceToStrike: 1, timeRemainingPct: 1, flipCount: 0, orderFlowImbalance: 0 },
          regimeScores: w.lastRegimeScores ?? {},
          fairUp: w.lastFairUp ?? 0.50,
          fairDown: w.lastFairDown ?? 0.50,
          bookConviction: w.lastBookConviction ?? { upMid: null, downMid: null, bookDirection: "NEUTRAL", bookStrength: 0, bidDepthRatio: 0.5, midDelta: 0, agreement: 0 },
          tapeBuckets,
          tapeMeta,
          bookBids: w.lastBookBids ?? [],
          upBidOrderId: w.upBidOrderId, upBidPrice: w.upBidPrice, upBidSize: w.upBidSize,
          downBidOrderId: w.downBidOrderId, downBidPrice: w.downBidPrice, downBidSize: w.downBidSize,
          upInventory: w.upInventory, downInventory: w.downInventory,
          upAvgCost: w.upAvgCost, downAvgCost: w.downAvgCost,
        });

        // Incrementally flush snapshots to D1 every tick to survive DO evictions
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
          } catch { /* best-effort flush */ }
        }
      }

      // Per-tick safety: cancel bids on the heavy side regardless of requote state
      // Covers both one-sided (other side = 0) and ratio-exceeded cases
      const maxInvR = params.max_inventory_ratio;
      const wDur = w.windowEndTime - w.windowOpenTime;
      const effBase = Math.max(3, Math.round(this.getBaseSize(params) * Math.min(1.0, (wDur / 60_000) / 15)));
      if (w.upBidOrderId) {
        const shouldCancelUp =
          (w.upInventory >= effBase && w.downInventory === 0) ||
          (w.downInventory > 0 && w.upInventory / w.downInventory > maxInvR);
        if (shouldCancelUp) {
          const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price, params); w.upBidOrderId = null; }
        }
      }
      if (w.downBidOrderId) {
        const shouldCancelDn =
          (w.downInventory >= effBase && w.upInventory === 0) ||
          (w.upInventory > 0 && w.downInventory / w.upInventory > maxInvR);
        if (shouldCancelDn) {
          const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price, params); w.downBidOrderId = null; }
        }
      }
    }
  }

  /**
   * Wind-down a single window: match the light side to create profitable pairs.
   * Cancel heavy-side bids, bid on the light side capped at the gap.
   * If already balanced (gap < 5), cancel everything and hold to resolution.
   */
  private async windDownWindow(
    ctx: StrategyContext,
    w: MakerWindowPosition,
    params: DirectionalMakerParams
  ): Promise<void> {
    // First: check fills on any existing bids (still need to process fills)
    const currentSnap = await fetchSpotPrice(w.cryptoSymbol);
    if (currentSnap) {
      const history = this.custom.priceHistory[w.cryptoSymbol] || [];
      const signal = computeSignal(
        w.cryptoSymbol,
        w.oracleStrike ?? w.priceAtWindowOpen,
        currentSnap.price,
        Date.now() - w.windowOpenTime,
        history.filter((s) => s.timestamp >= w.windowOpenTime)
      );
      await this.checkFills(ctx, w, params, signal);
    }

    const gap = Math.abs(w.upInventory - w.downInventory);

    // Already balanced — cancel all bids, hold to resolution
    if (gap < 5) {
      if (w.upBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price, params); w.upBidOrderId = null; }
      }
      if (w.downBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price, params); w.downBidOrderId = null; }
      }
      w.tickAction = `Wind-down: balanced (${w.upInventory}↑/${w.downInventory}↓), holding`;
      return;
    }

    // Determine which side is light and needs buying
    const lightSide: "UP" | "DOWN" = w.upInventory < w.downInventory ? "UP" : "DOWN";
    const heavySide: "UP" | "DOWN" = lightSide === "UP" ? "DOWN" : "UP";

    // Cancel heavy-side bid
    const heavyBidId = heavySide === "UP" ? w.upBidOrderId : w.downBidOrderId;
    if (heavyBidId) {
      const r = await safeCancelOrder(ctx.api, heavyBidId);
      if (r.cleared) {
        if (r.fill) this.recordFillFromCancel(ctx, w, heavySide, r.fill.size, r.fill.price, params);
        if (heavySide === "UP") w.upBidOrderId = null;
        else w.downBidOrderId = null;
      }
    }

    // Bid on the light side, capped at the gap
    const lightBidId = lightSide === "UP" ? w.upBidOrderId : w.downBidOrderId;
    if (!lightBidId) {
      const bidSize = Math.min(gap, this.getBaseSize(params));
      // Conservative pricing: respect max_pair_cost relative to the heavy side's avg cost
      const heavyAvgCost = heavySide === "UP" ? w.upAvgCost : w.downAvgCost;
      const maxBid = heavyAvgCost > 0 ? params.max_pair_cost - heavyAvgCost : 0.46;
      const bidPrice = Math.max(0.01, Math.min(maxBid, 0.46));
      const roundedBid = Math.floor(bidPrice * 100) / 100;

      const tokenId = lightSide === "UP" ? w.market.upTokenId : w.market.downTokenId;
      const result = await ctx.api.placeOrder({
        token_id: tokenId,
        side: "BUY",
        size: bidSize,
        price: roundedBid,
        market: w.market.slug,
        title: `${w.market.title} [WIND-DOWN ${lightSide}]`,
      });

      if (result.status === "filled") {
        const fillPrice = result.price;
        const fillSize = result.size;
        const feeEquivalent = calcFeePerShare(fillPrice, params.fee_params) * fillSize;
        const costBasis = fillPrice; // Maker fills have zero fee
        if (lightSide === "UP") {
          if (w.upInventory > 0) {
            const totalCost = w.upAvgCost * w.upInventory + costBasis * fillSize;
            w.upInventory += fillSize;
            w.upAvgCost = totalCost / w.upInventory;
          } else {
            w.upInventory = fillSize;
            w.upAvgCost = costBasis;
          }
        } else {
          if (w.downInventory > 0) {
            const totalCost = w.downAvgCost * w.downInventory + costBasis * fillSize;
            w.downInventory += fillSize;
            w.downAvgCost = totalCost / w.downInventory;
          } else {
            w.downInventory = fillSize;
            w.downAvgCost = costBasis;
          }
        }
        w.fillCount++;
        w.totalBuyCost += costBasis * fillSize;
        this.custom.totalMakerFills++;
        ctx.log(
          `WIND-DOWN FILL ${lightSide}: ${w.market.title.slice(0, 25)} ${fillSize}@${fillPrice.toFixed(3)} gap=${gap}->${Math.abs(w.upInventory - w.downInventory)}`,
          { level: "trade", symbol: w.cryptoSymbol, direction: lightSide, upInventory: w.upInventory, downInventory: w.downInventory, phase: "wind_down" }
        );
        const tokenId = lightSide === "UP" ? w.market.upTokenId : w.market.downTokenId;
        await ctx.db
          .prepare(
            `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
             VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
          )
          .bind(
            `sm-wd-${crypto.randomUUID()}`,
            ctx.config.id,
            tokenId,
            w.market.slug,
            `${w.market.title} [WIND-DOWN ${lightSide}]`,
            costBasis,
            fillSize,
            feeEquivalent
          )
          .run();
      } else if (result.status === "placed") {
        if (lightSide === "UP") {
          w.upBidOrderId = result.order_id;
          w.upBidPrice = roundedBid;
          w.upBidSize = bidSize;
        } else {
          w.downBidOrderId = result.order_id;
          w.downBidPrice = roundedBid;
          w.downBidSize = bidSize;
        }
      }
    }

    w.tickAction = `Wind-down: matching light side (gap=${gap})`;

    if (ctx.state.ticks % 5 === 0) {
      ctx.log(
        `WIND-DOWN: ${w.market.title.slice(0, 25)} inv=${w.upInventory}/${w.downInventory} gap=${gap} bidding ${lightSide}`,
        { level: "info", symbol: w.cryptoSymbol, upInventory: w.upInventory, downInventory: w.downInventory, phase: "wind_down" }
      );
    }
  }

  /**
   * Check if resting maker bids have been filled (paper mode).
   *
   * Uses real CLOB book data: if our bid is near or above the best ask,
   * it fills. This replaces the old signal-derived fair value model which
   * was overly optimistic — it used its own signal to simulate fills,
   * creating a self-fulfilling cycle where both sides always filled.
   */
  private async checkFills(
    ctx: StrategyContext,
    w: MakerWindowPosition,
    params: DirectionalMakerParams,
    _signal: WindowSignal
  ): Promise<void> {
    // Check pending sell order first (real mode sell tracking)
    if (w.pendingSellOrderId) {
      try {
        const sellStatus = await ctx.api.getOrderStatus(w.pendingSellOrderId);
        if (sellStatus.status === "MATCHED" && sellStatus.size_matched > 0) {
          const soldSize = sellStatus.size_matched;
          const soldPrice = sellStatus.price || 0;
          const sellRevenue = soldSize * soldPrice;
          const sellCostBasis = soldSize * w.pendingSellCostBasis;
          const sellFee = calcFeePerShare(soldPrice, params.fee_params) * soldSize;
          const sellPnl = sellRevenue - sellCostBasis - sellFee;

          w.realizedSellPnl += sellPnl;
          w.sellCount++;
          if (w.pendingSellSide === "UP") {
            w.upInventory = Math.max(0, w.upInventory - soldSize);
          } else {
            w.downInventory = Math.max(0, w.downInventory - soldSize);
          }

          ctx.log(
            `SELL FILLED: ${w.market.title.slice(0, 25)} ${w.pendingSellSide} ${soldSize}@${soldPrice.toFixed(3)} pnl=$${sellPnl.toFixed(2)}`,
            { level: "trade", symbol: w.cryptoSymbol, direction: w.pendingSellSide ?? undefined, phase: "sell_fill" }
          );

          await ctx.db
            .prepare(
              `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
               VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
            )
            .bind(
              `sm-sell-${crypto.randomUUID()}`,
              ctx.config.id,
              w.pendingSellSide === "UP" ? w.market.upTokenId : w.market.downTokenId,
              w.market.slug,
              `${w.market.title} [SELL ${w.pendingSellSide}]`,
              soldPrice, soldSize, sellFee, sellPnl
            )
            .run();

          w.pendingSellOrderId = null;
          w.pendingSellSide = null;
          w.pendingSellSize = 0;
          w.pendingSellCostBasis = 0;
        } else if (sellStatus.status === "CANCELLED") {
          w.pendingSellOrderId = null;
          w.pendingSellSide = null;
          w.pendingSellSize = 0;
          w.pendingSellCostBasis = 0;
        }
        // LIVE = still resting, check next tick
      } catch {
        // Status check failed — retry next tick
      }
    }

    // Check UP bid fill (mode-agnostic: PaperStrategyAPI.getOrderStatus simulates fills)
    if (w.upBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.upBidOrderId);
      if (status.status === "MATCHED" && status.size_matched > 0) {
        const filledSize = status.size_matched;
        const costBasis = status.price || w.upBidPrice;

        if (w.upInventory > 0) {
          const totalCost = w.upAvgCost * w.upInventory + costBasis * filledSize;
          w.upInventory += filledSize;
          w.upAvgCost = totalCost / w.upInventory;
        } else {
          w.upInventory = filledSize;
          w.upAvgCost = costBasis;
        }
        w.fillCount++;
        w.totalBuyCost += costBasis * filledSize;
        this.custom.totalMakerFills++;

        const upBook = await this.getBookCached(ctx, w.market.upTokenId);
        const bestAsk = this.getBestAsk(upBook);
        ctx.log(
          `MAKER FILL UP: ${w.market.title.slice(0, 30)} ${filledSize}@${costBasis.toFixed(3)} inv=${w.upInventory.toFixed(0)} ask=${bestAsk?.toFixed(3) ?? "?"}`
        );

        const feeEquivalent = calcFeePerShare(costBasis, params.fee_params) * filledSize;
        await ctx.db
          .prepare(
            `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
             VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
          )
          .bind(
            `sm-up-${crypto.randomUUID()}`,
            ctx.config.id,
            w.market.upTokenId,
            w.market.slug,
            `${w.market.title} [MAKER UP]`,
            costBasis,
            filledSize,
            feeEquivalent
          )
          .run();

        w.upBidOrderId = null;
      }
    }

    // Check DOWN bid fill (mode-agnostic)
    if (w.downBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.downBidOrderId);
      if (status.status === "MATCHED" && status.size_matched > 0) {
        const filledSize = status.size_matched;
        const costBasis = status.price || w.downBidPrice;

        if (w.downInventory > 0) {
          const totalCost = w.downAvgCost * w.downInventory + costBasis * filledSize;
          w.downInventory += filledSize;
          w.downAvgCost = totalCost / w.downInventory;
        } else {
          w.downInventory = filledSize;
          w.downAvgCost = costBasis;
        }
        w.fillCount++;
        w.totalBuyCost += costBasis * filledSize;
        this.custom.totalMakerFills++;

        const dnBookForLog = await this.getBookCached(ctx, w.market.downTokenId);
        const bestAsk = this.getBestAsk(dnBookForLog);
        ctx.log(
          `MAKER FILL DN: ${w.market.title.slice(0, 30)} ${filledSize}@${costBasis.toFixed(3)} inv=${w.downInventory.toFixed(0)} ask=${bestAsk?.toFixed(3) ?? "?"}`
        );

        const dnFeeEquivalent = calcFeePerShare(costBasis, params.fee_params) * filledSize;
        await ctx.db
          .prepare(
            `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
             VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
          )
          .bind(
            `sm-dn-${crypto.randomUUID()}`,
            ctx.config.id,
            w.market.downTokenId,
            w.market.slug,
            `${w.market.title} [MAKER DN]`,
            costBasis,
            filledSize,
            dnFeeEquivalent
          )
          .run();

        w.downBidOrderId = null;
      }
    }
  }

  private async updateQuotes(
    ctx: StrategyContext,
    w: MakerWindowPosition,
    params: DirectionalMakerParams,
    signal: WindowSignal
  ): Promise<void> {
    const now = Date.now();

    // Detect confirmed direction flip (hysteresis-filtered)
    const confirmedFlip =
      w.confirmedDirection !== null &&
      signal.direction !== w.confirmedDirection &&
      !signal.inDeadZone;

    if (confirmedFlip) {
      w.flipCount++;
      ctx.log(
        `FLIP #${w.flipCount}: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} ${w.confirmedDirection} -> ${signal.direction} raw=${signal.rawDirection} dz=${signal.inDeadZone}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: signal.direction, signalStrength: signal.signalStrength, priceChangePct: signal.priceChangePct, momentum: signal.momentum, volatilityRegime: signal.volatilityRegime, inDeadZone: signal.inDeadZone, flipCount: w.flipCount, upInventory: w.upInventory, downInventory: w.downInventory, phase: "flip" }
      );
      w.confirmedDirection = signal.direction;
      w.lastDirectionChangeAt = now;
    } else if (w.confirmedDirection === null) {
      w.confirmedDirection = signal.direction;
    }

    // Compute book conviction (reuses cached books, no extra API calls)
    const book = await this.computeBookConviction(ctx, w, signal);
    const combined = this.computeCombinedConviction(signal, book, params, w);
    const bkStr = `bk=${book.upMid?.toFixed(2) ?? "?"}/${book.downMid?.toFixed(2) ?? "?"}`;

    // ── Book-anchored fair values with regime discount ──
    // Classify market regime for discount selection
    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const effectiveStrike = w.oracleStrike ?? w.priceAtWindowOpen;
    const priceHistory = this.custom.priceHistory[w.cryptoSymbol] || [];
    const regimeFeatures = computeRegimeFeatures(
      priceHistory, signal, effectiveStrike, w.windowOpenTime, w.windowEndTime
    );
    const { regime, scores: regimeScores } = classifyRegime(regimeFeatures);

    // Regime-dependent discount: how far below fair value we bid
    const regimeDiscount =
      regime === "oscillating" ? 0.20 :  // patient — price bounces, our bids will get hit
      regime === "trending"    ? 0.08 :  // aggressive — price runs, can't be too greedy
      regime === "volatile"    ? 0.18 :  // wide spreads, seek value
      regime === "calm"        ? 0.12 :  // standard
      0.12; // near-strike, late-window, etc.

    // Primary: book mids (market consensus). Fallback: P_true (binary option CDF).
    // Last resort: old signal model.
    let fairUp: number;
    let fairDown: number;
    if (book.upMid != null && book.downMid != null) {
      fairUp = book.upMid;
      fairDown = book.downMid;
    } else {
      // P_true fallback: uses vol estimate + time remaining for proper binary pricing
      const vol = estimateVolatility5min(priceHistory);
      const timeRemaining = w.windowEndTime - now;
      const pTrue = calculatePTrue(signal.currentPrice, effectiveStrike, "above", timeRemaining, vol);
      fairUp = pTrue;
      fairDown = 1.0 - pTrue;
    }
    // Apply regime discount: bid below fair value
    const discountedFairUp = Math.max(0.01, fairUp * (1 - regimeDiscount));
    const discountedFairDown = Math.max(0.01, fairDown * (1 - regimeDiscount));

    // Save transient values for snapshot recording
    w.lastRegime = regime;
    w.lastRegimeFeatures = regimeFeatures;
    w.lastRegimeScores = regimeScores;
    w.lastFairUp = fairUp;
    w.lastFairDown = fairDown;
    w.lastBookConviction = {
      upMid: book.upMid, downMid: book.downMid,
      bookDirection: book.bookDirection, bookStrength: book.bookStrength,
      bidDepthRatio: book.bookBidDepthRatio, midDelta: book.midDelta,
      agreement: book.agreement,
    };

    // Periodic signal log (every ~5th tick)
    if (ctx.state.ticks % 5 === 0) {
      const flowStr = signal.orderFlowAvailable
        ? ` flow=${signal.orderFlowImbalance >= 0 ? "+" : ""}${signal.orderFlowImbalance.toFixed(2)} confX=${signal.confidenceMultiplier.toFixed(1)}`
        : "";
      const oracleStr = w.oracleStrike != null ? ` oracle=$${w.oracleStrike.toFixed(0)}` : "";
      ctx.log(
        `SIGNAL: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} ${signal.direction} str=${(signal.signalStrength * 100).toFixed(0)}% combined=${(combined.combinedStrength * 100).toFixed(0)}% bk=${book.bookDirection}@${(book.bookStrength * 100).toFixed(0)}% agree=${book.agreement.toFixed(2)} mid=${book.upMid?.toFixed(2) ?? "?"}/${book.downMid?.toFixed(2) ?? "?"} fv=${fairUp.toFixed(2)}/${fairDown.toFixed(2)} disc=${(regimeDiscount * 100).toFixed(0)}%@${regime} UP=${w.upInventory} DN=${w.downInventory} flips=${w.flipCount}${flowStr}${oracleStr}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: signal.direction, signalStrength: signal.signalStrength, priceChangePct: signal.priceChangePct, momentum: signal.momentum, volatilityRegime: signal.volatilityRegime, inDeadZone: signal.inDeadZone, flipCount: w.flipCount, upInventory: w.upInventory, downInventory: w.downInventory, phase: "manage" }
      );
    }

    // Max flips exceeded: cancel all bids and stop quoting
    if (w.flipCount > params.max_flips_per_window) {
      if (w.upBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price, params); w.upBidOrderId = null; }
      }
      if (w.downBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price, params); w.downBidOrderId = null; }
      }
      if (confirmedFlip) {
        ctx.log(
          `MAX FLIPS (${w.flipCount}): ${w.market.title.slice(0, 25)} stopping quotes, holding to resolution`,
          { level: "signal", symbol: w.cryptoSymbol, flipCount: w.flipCount, phase: "max_flips" }
        );
      }
      w.tickAction = `Sat out: choppy (${w.flipCount} flips)`;
      return;
    }

    // Check if we need to requote
    const directionChanged = confirmedFlip;
    const priceMoved =
      Math.abs(signal.priceChangePct - w.lastQuotedPriceChangePct) >
      params.requote_threshold_pct;
    const needsQuote =
      directionChanged || priceMoved || w.lastQuotedAt === 0;

    if (!needsQuote) {
      const up = w.upInventory, dn = w.downInventory;
      const pc = (up > 0 && dn > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
      const dir = signal.direction;
      const str = (signal.signalStrength * 100).toFixed(0);
      const discStr = `${(regimeDiscount * 100).toFixed(0)}%@${regime.slice(0, 4)}`;
      w.tickAction = `${dir} ${str}% ${bkStr} disc=${discStr} → no requote${pc}`;
      return;
    }

    // On direction flip, cancel bids and gate sell behind multi-source conviction
    if (directionChanged) {
      if (w.upBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price, params); w.upBidOrderId = null; }
      }
      if (w.downBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price, params); w.downBidOrderId = null; }
      }

      if (signal.signalStrength >= params.min_signal_strength) {
        if (combined.sellApproved && params.sell_excess) {
          await this.sellLosingInventory(ctx, w, params, "FLIP SELL");
          w.lastFlipSellAt = now;
          ctx.log(
            `FLIP SELL APPROVED: ${w.cryptoSymbol} combined=${combined.combinedStrength.toFixed(2)} book=${book.bookDirection}@${(book.bookStrength * 100).toFixed(0)}% agree=${book.agreement.toFixed(2)}`,
            { level: "signal", symbol: w.cryptoSymbol, direction: signal.direction, flipCount: w.flipCount, phase: "flip_sell" }
          );
        } else {
          ctx.log(
            `FLIP SELL BLOCKED: ${w.cryptoSymbol} ${combined.reason} ${bkStr}`,
            { level: "signal", symbol: w.cryptoSymbol, direction: signal.direction, flipCount: w.flipCount, phase: "flip_sell_blocked" }
          );
        }
      }
    }

    // Periodically sell losing-side inventory when signal is strong
    // (prevents one-sided accumulation between flips) — also gated
    if (!directionChanged && signal.signalStrength >= 0.5) {
      const losingSide = signal.direction === "UP" ? "DOWN" : "UP";
      const losingInv = losingSide === "UP" ? w.upInventory : w.downInventory;
      if (losingInv > 0 && combined.sellApproved && params.sell_excess) {
        await this.sellLosingInventory(ctx, w, params, "REBALANCE");
        w.lastFlipSellAt = now;
      }
    }

    // Determine conviction-biased sizes with volatility adjustment
    const convictionSide =
      signal.signalStrength >= params.min_signal_strength
        ? signal.direction
        : null;

    // Scale conviction bias by signal strength:
    // At min_signal_strength → bias = 1.0 (equal sizing, symmetric risk)
    // At strength = 1.0 → full configured bias
    const strengthRange = 1.0 - params.min_signal_strength;
    const strengthFraction = strengthRange > 0
      ? Math.min(1.0, (signal.signalStrength - params.min_signal_strength) / strengthRange)
      : 0;
    const scaledBias = 1.0 + (params.conviction_bias - 1.0) * strengthFraction;
    const adjustedBias = scaledBias * signal.confidenceMultiplier;
    // Adaptive bid sizing: scale down for shorter windows (same as sniper)
    // 5min → base * 0.33, 15min → base * 1.0, 60min → base * 1.0
    const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);
    let effectiveBaseSize = Math.max(3, Math.round(this.getBaseSize(params) * durationScale));
    // Capital-aware position sizing: divide available capital across windows × sides
    const activeCount = this.custom.activeWindows.length;
    const slots = Math.max(2, activeCount + 1);
    const maxPerSide = Math.floor(ctx.config.max_capital_usd / (slots * 2 * params.max_bid_per_side));
    effectiveBaseSize = Math.min(effectiveBaseSize, Math.max(5, maxPerSide));
    let upBidSize = effectiveBaseSize;
    let downBidSize = effectiveBaseSize;
    // Cap asymmetry at 2:1 — never fully stop losing side
    const maxRatio = 2.0;
    const clampedBias = Math.min(adjustedBias, maxRatio);
    if (convictionSide === "UP") {
      upBidSize = Math.round(effectiveBaseSize * clampedBias);
      downBidSize = Math.max(
        Math.round(effectiveBaseSize * 0.5),
        Math.round(effectiveBaseSize / clampedBias)
      );
    } else if (convictionSide === "DOWN") {
      downBidSize = Math.round(effectiveBaseSize * clampedBias);
      upBidSize = Math.max(
        Math.round(effectiveBaseSize * 0.5),
        Math.round(effectiveBaseSize / clampedBias)
      );
    }

    // Cap bid size so a single fill can't exceed the one-sided cap
    const maxOneSide = effectiveBaseSize;
    if (w.downInventory === 0) upBidSize = Math.min(upBidSize, Math.max(0, maxOneSide - w.upInventory));
    if (w.upInventory === 0) downBidSize = Math.min(downBidSize, Math.max(0, maxOneSide - w.downInventory));

    // Inventory ratio check: suppress bidding on the heavy side
    const maxInvRatio = params.max_inventory_ratio;
    if (w.upInventory > 0 && w.downInventory > 0) {
      if (w.upInventory / w.downInventory > maxInvRatio) upBidSize = 0;
      if (w.downInventory / w.upInventory > maxInvRatio) downBidSize = 0;
    } else if (w.upInventory >= effectiveBaseSize && w.downInventory === 0) {
      upBidSize = 0; // one-sided UP — pause until DN fills
    } else if (w.downInventory >= effectiveBaseSize && w.upInventory === 0) {
      downBidSize = 0; // one-sided DN — pause until UP fills
    }

    // Per-window capital check (total deployed in this window)
    const windowCapital = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
    if (windowCapital > params.max_capital_per_window) {
      w.tickAction = `Window capital limit`;
      return;
    }

    // Global capital check: total deployed + pending bids (worst case if everything fills)
    const fmt$ = (n: number) => "$" + n.toFixed(0);
    const capitalCommitted = this.custom.activeWindows.reduce(
      (sum, aw) => {
        const inv = aw.upInventory * aw.upAvgCost + aw.downInventory * aw.downAvgCost;
        const pending = aw !== w
          ? (aw.upBidOrderId ? aw.upBidSize * aw.upBidPrice : 0)
            + (aw.downBidOrderId ? aw.downBidSize * aw.downBidPrice : 0)
          : 0;
        return sum + inv + pending;
      }, 0
    );
    // Estimate cost of bids we're about to place (use 0.50 estimate since exact prices computed later)
    const estBidPrice = 0.50;
    const estUpBidCost = upBidSize > 0 ? upBidSize * estBidPrice : 0;
    const estDnBidCost = downBidSize > 0 ? downBidSize * estBidPrice : 0;
    const capitalIfFilled = capitalCommitted + estUpBidCost + estDnBidCost;
    if (capitalIfFilled > ctx.config.max_capital_usd) {
      const remaining = Math.max(0, ctx.config.max_capital_usd - capitalCommitted);
      if (remaining < 5 * 0.40) {
        w.tickAction = `Capital limit: ${fmt$(capitalCommitted)}/${fmt$(ctx.config.max_capital_usd)}`;
        return;
      }
      // Scale both bid sizes proportionally to fit
      const scale = remaining / (estUpBidCost + estDnBidCost);
      upBidSize = Math.floor(upBidSize * scale);
      downBidSize = Math.floor(downBidSize * scale);
      if (upBidSize < 3 && downBidSize < 3) {
        w.tickAction = `Capital limit: ${fmt$(capitalCommitted)}/${fmt$(ctx.config.max_capital_usd)}`;
        return;
      }
    }

    // ── Book-anchored bid prices ──
    // Regime discount already provides the offset from fair value.
    // Time-decay: tighten discount in last portion of window (unfilled sides bid more aggressively)
    const windowProgress = (now - w.windowOpenTime) / wDurMs;
    const tightenStart = params.tighten_start_pct;
    const timeDecay = windowProgress > tightenStart
      ? 1.0 - (windowProgress - tightenStart) / (1.0 - tightenStart)
      : 1.0;

    // For unfilled sides, reduce the discount over time (bid closer to fair value)
    const upBidFair = w.upInventory > 0 ? discountedFairUp : fairUp * (1 - regimeDiscount * timeDecay);
    const dnBidFair = w.downInventory > 0 ? discountedFairDown : fairDown * (1 - regimeDiscount * timeDecay);

    const rawUpBid = Math.min(Math.max(0.01, upBidFair), params.max_bid_per_side);
    const rawDnBid = Math.min(Math.max(0.01, dnBidFair), params.max_bid_per_side);

    // Cap each bid based on what the OTHER side already cost us
    let upBid = w.downInventory > 0
      ? Math.min(rawUpBid, params.max_pair_cost - w.downAvgCost)
      : rawUpBid;
    let dnBid = w.upInventory > 0
      ? Math.min(rawDnBid, params.max_pair_cost - w.upAvgCost)
      : rawDnBid;

    // Also cap so new bids together don't exceed max_pair_cost
    if (upBid + dnBid > params.max_pair_cost) {
      const scale = params.max_pair_cost / (upBid + dnBid);
      upBid = upBid * scale;
      dnBid = dnBid * scale;
    }
    upBid = Math.max(0.01, upBid);
    dnBid = Math.max(0.01, dnBid);

    // ── Reluctant requoting (Fix 3b) ──
    // For non-flip requotes, only cancel + replace if the new bid differs enough.
    // Direction flips already cancelled above.
    if (!directionChanged) {
      const roundedUpBid = Math.floor(upBid * 100) / 100;
      const roundedDnBid = Math.floor(dnBid * 100) / 100;
      const needsUpRequote = !w.upBidOrderId || Math.abs(roundedUpBid - w.upBidPrice) >= params.min_requote_delta;
      const needsDnRequote = !w.downBidOrderId || Math.abs(roundedDnBid - w.downBidPrice) >= params.min_requote_delta;

      // Cancel UP bid if requote needed (cancelOrder checks fills before cancelling)
      if (needsUpRequote && w.upBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price, params); w.upBidOrderId = null; }
      }

      // Cancel DN bid if requote needed
      if (needsDnRequote && w.downBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price, params); w.downBidOrderId = null; }
      }
    }

    // Place UP bid
    if (!w.upBidOrderId && upBidSize > 0) {
      let roundedBid = Math.floor(upBid * 100) / 100;
      // Spread guard: never cross the spread (prevents expensive taker fills)
      const upBook = await this.getBookCached(ctx, w.market.upTokenId);
      const upBestAsk = this.getBestAsk(upBook);
      if (upBestAsk !== null && roundedBid >= upBestAsk) {
        const clamped = Math.max(0.01, upBestAsk - 0.01);
        ctx.log(`SPREAD GUARD UP: clamped bid ${roundedBid.toFixed(2)} -> ${clamped.toFixed(2)} (ask=${upBestAsk.toFixed(2)})`);
        roundedBid = clamped;
      }
      const result = await ctx.api.placeOrder({
        token_id: w.market.upTokenId,
        side: "BUY",
        size: upBidSize,
        price: roundedBid,
        market: w.market.slug,
        title: `${w.market.title} [MAKER UP bid]`,
      });

      if (result.status === "filled") {
        const fillPrice = result.price;
        const fillSize = result.size;
        const feeEquivalent = calcFeePerShare(fillPrice, params.fee_params) * fillSize;
        const costBasis = fillPrice; // Maker fills have zero fee; track fee_equivalent separately for rebate pool
        if (w.upInventory > 0) {
          const totalCost =
            w.upAvgCost * w.upInventory + costBasis * fillSize;
          w.upInventory += fillSize;
          w.upAvgCost = totalCost / w.upInventory;
        } else {
          w.upInventory = fillSize;
          w.upAvgCost = costBasis;
        }
        w.fillCount++;
        w.totalBuyCost += costBasis * fillSize;
        this.custom.totalMakerFills++;
        ctx.log(
          `MAKER FILL UP (immediate): ${w.market.title.slice(0, 30)} ${fillSize}@${fillPrice.toFixed(3)}${fillSize < upBidSize ? ` (partial ${fillSize}/${upBidSize})` : ""}`
        );
        await ctx.db
          .prepare(
            `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
             VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
          )
          .bind(
            `sm-up-imm-${crypto.randomUUID()}`,
            ctx.config.id,
            w.market.upTokenId,
            w.market.slug,
            `${w.market.title} [MAKER UP imm]`,
            costBasis,
            fillSize,
            feeEquivalent
          )
          .run();
      } else if (result.status === "placed") {
        w.upBidOrderId = result.order_id;
        w.upBidPrice = roundedBid;
        w.upBidSize = upBidSize;
      }
    }

    // Place DOWN bid
    if (!w.downBidOrderId && downBidSize > 0) {
      let roundedBid = Math.floor(dnBid * 100) / 100;
      // Spread guard: never cross the spread
      const dnBook = await this.getBookCached(ctx, w.market.downTokenId);
      const dnBestAsk = this.getBestAsk(dnBook);
      if (dnBestAsk !== null && roundedBid >= dnBestAsk) {
        const clamped = Math.max(0.01, dnBestAsk - 0.01);
        ctx.log(`SPREAD GUARD DN: clamped bid ${roundedBid.toFixed(2)} -> ${clamped.toFixed(2)} (ask=${dnBestAsk.toFixed(2)})`);
        roundedBid = clamped;
      }
      const result = await ctx.api.placeOrder({
        token_id: w.market.downTokenId,
        side: "BUY",
        size: downBidSize,
        price: roundedBid,
        market: w.market.slug,
        title: `${w.market.title} [MAKER DN bid]`,
      });

      if (result.status === "filled") {
        const fillPrice = result.price;
        const fillSize = result.size;
        const feeEquivalent = calcFeePerShare(fillPrice, params.fee_params) * fillSize;
        const costBasis = fillPrice; // Maker fills have zero fee; track fee_equivalent separately for rebate pool
        if (w.downInventory > 0) {
          const totalCost =
            w.downAvgCost * w.downInventory + costBasis * fillSize;
          w.downInventory += fillSize;
          w.downAvgCost = totalCost / w.downInventory;
        } else {
          w.downInventory = fillSize;
          w.downAvgCost = costBasis;
        }
        w.fillCount++;
        w.totalBuyCost += costBasis * fillSize;
        this.custom.totalMakerFills++;
        ctx.log(
          `MAKER FILL DN (immediate): ${w.market.title.slice(0, 30)} ${fillSize}@${fillPrice.toFixed(3)}${fillSize < downBidSize ? ` (partial ${fillSize}/${downBidSize})` : ""}`
        );
        await ctx.db
          .prepare(
            `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
             VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
          )
          .bind(
            `sm-dn-imm-${crypto.randomUUID()}`,
            ctx.config.id,
            w.market.downTokenId,
            w.market.slug,
            `${w.market.title} [MAKER DN imm]`,
            costBasis,
            fillSize,
            feeEquivalent
          )
          .run();
      } else if (result.status === "placed") {
        w.downBidOrderId = result.order_id;
        w.downBidPrice = roundedBid;
        w.downBidSize = downBidSize;
      }
    }

    // Set tickAction based on current quoting state
    {
      const up = w.upInventory, dn = w.downInventory;
      const pc = (up > 0 && dn > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
      const str = (signal.signalStrength * 100).toFixed(0);
      const decay = (timeDecay * 100).toFixed(0);
      const upBidStr = w.upBidOrderId ? `▲${w.upBidPrice.toFixed(2)}` : "";
      const dnBidStr = w.downBidOrderId ? `▼${w.downBidPrice.toFixed(2)}` : "";
      const bids = [upBidStr, dnBidStr].filter(Boolean).join(" ");
      const flipSellStatus = directionChanged && !combined.sellApproved ? " sell blocked" : "";
      const discStr = `${(regimeDiscount * 100).toFixed(0)}%@${regime.slice(0, 4)}`;
      w.tickAction = directionChanged
        ? `FLIP→${signal.direction} ${str}% ${bkStr} disc=${discStr} → ${bids} decay=${decay}%${pc}${flipSellStatus}`
        : `${signal.direction} ${str}% ${bkStr} disc=${discStr} → ${bids} decay=${decay}%${pc}`;
    }

    // Update quote tracking
    w.lastSignalDirection = signal.direction;
    w.lastQuotedAt = now;
    w.lastQuotedPriceChangePct = signal.priceChangePct;
    w.convictionSide = convictionSide;

    if (directionChanged) {
      ctx.log(
        `REQUOTE: ${w.market.title.slice(0, 30)} direction flipped to ${signal.direction} strength=${(signal.signalStrength * 100).toFixed(0)}% mom=${signal.momentum.toFixed(2)} vol=${signal.volatilityRegime} UP_bid=${upBidSize} DN_bid=${downBidSize}`
      );
    }
  }

  // ── Sell losing side inventory ──────────────────────────────────

  private async sellLosingInventory(
    ctx: StrategyContext,
    w: MakerWindowPosition,
    params: DirectionalMakerParams,
    label: string
  ): Promise<void> {
    // Determine losing side from current signal
    const history = this.custom.priceHistory[w.cryptoSymbol] || [];
    const currentSnap = await fetchSpotPrice(w.cryptoSymbol);
    if (!currentSnap) return;

    const signal = computeSignal(
      w.cryptoSymbol,
      w.oracleStrike ?? w.priceAtWindowOpen,
      currentSnap.price,
      Date.now() - w.enteredAt,
      history.filter((s) => s.timestamp >= w.enteredAt)
    );

    const losingSide = signal.direction === "UP" ? "DOWN" : "UP";
    const rawLosingInventory =
      losingSide === "UP" ? w.upInventory : w.downInventory;
    const losingAvgCost =
      losingSide === "UP" ? w.upAvgCost : w.downAvgCost;
    const losingTokenId =
      losingSide === "UP" ? w.market.upTokenId : w.market.downTokenId;

    // Never sell paired inventory — only sell excess beyond the matched amount.
    // A balanced 30U/30D pair is structurally profitable; selling one side destroys that.
    const paired = Math.min(w.upInventory, w.downInventory);
    const losingInventory = rawLosingInventory - paired;

    if (losingInventory <= 0) return;

    // Use real CLOB book for sell price — best bid is where we'd actually sell
    const book = await this.getBookCached(ctx, losingTokenId);
    const bestBid = book.bids.length > 0
      ? Math.max(...book.bids.map(l => l.price))
      : null;
    // Fall back to P_true if book is empty
    const sellHistory = this.custom.priceHistory[w.cryptoSymbol] || [];
    const sellVol = estimateVolatility5min(sellHistory);
    const sellTimeRemaining = w.windowEndTime - Date.now();
    const sellEffectiveStrike = w.oracleStrike ?? w.priceAtWindowOpen;
    const pTrueUp = calculatePTrue(currentSnap.price, sellEffectiveStrike, "above", sellTimeRemaining, sellVol);
    const signalPrice = losingSide === "UP" ? pTrueUp : (1.0 - pTrueUp);
    const sellPrice = Math.max(0.01, bestBid ?? signalPrice);

    // Don't place a new sell if one is already pending
    if (w.pendingSellOrderId) return;

    const result = await ctx.api.placeOrder({
      token_id: losingTokenId,
      side: "SELL",
      size: losingInventory,
      price: sellPrice,
      market: w.market.slug,
      title: `${w.market.title} [${label} ${losingSide}]`,
    });

    if (result.status === "filled" && result.size > 0) {
      const soldSize = result.size;
      const soldPrice = result.price;
      const sellRevenue = soldSize * soldPrice;
      const sellCostBasis = soldSize * losingAvgCost;
      const sellFee =
        calcFeePerShare(soldPrice, params.fee_params) * soldSize;
      const sellPnl = sellRevenue - sellCostBasis - sellFee;

      w.realizedSellPnl += sellPnl;
      w.sellCount++;

      if (losingSide === "UP") {
        w.upInventory -= soldSize;
      } else {
        w.downInventory -= soldSize;
      }

      ctx.log(
        `${label}: ${w.market.title.slice(0, 25)} ${losingSide} ${soldSize}@${soldPrice.toFixed(3)} cost=${losingAvgCost.toFixed(3)} pnl=$${sellPnl.toFixed(2)} | sig=${(signal.signalStrength * 100).toFixed(0)}% ${signal.direction}`
      );

      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
        )
        .bind(
          `sm-sell-${crypto.randomUUID()}`,
          ctx.config.id,
          losingTokenId,
          w.market.slug,
          `${w.market.title} [${label} ${losingSide}]`,
          soldPrice,
          soldSize,
          sellFee,
          sellPnl
        )
        .run();
    } else if (result.status === "placed" && result.order_id) {
      // Real mode: sell went to CLOB as GTC — track it for status polling
      w.pendingSellOrderId = result.order_id;
      w.pendingSellSide = losingSide;
      w.pendingSellSize = losingInventory;
      w.pendingSellCostBasis = losingAvgCost;
      ctx.log(
        `SELL PLACED: ${w.market.title.slice(0, 25)} ${losingSide} ${losingInventory}@${sellPrice.toFixed(3)} order=${result.order_id.slice(0, 12)}`,
        { level: "trade", symbol: w.cryptoSymbol, direction: losingSide, phase: "sell_placed" }
      );
    }
  }

  // ── Resolve completed windows ───────────────────────────────────

  private async resolveWindows(
    ctx: StrategyContext,
    params: DirectionalMakerParams
  ): Promise<void> {
    const now = Date.now();
    const toRemove: number[] = [];

    for (let i = 0; i < this.custom.activeWindows.length; i++) {
      const w = this.custom.activeWindows[i];
      // Try resolution at +60s (Polymarket primary), Binance fallback at +5min
      if (now < w.windowEndTime + 60_000) continue;

      // No inventory accumulated — nothing to resolve
      if (w.upInventory === 0 && w.downInventory === 0) {
        ctx.log(
          `EXPIRED (no fills): ${w.market.title.slice(0, 35)}`
        );
        toRemove.push(i);
        continue;
      }

      let outcome: "UP" | "DOWN" | "UNKNOWN" = "UNKNOWN";

      // 1. Check Polymarket resolution first (authoritative)
      try {
        const resolution = await checkMarketResolution(
          w.market.slug, w.market.upTokenId, w.market.downTokenId
        );
        if (resolution.closed && resolution.outcome) {
          outcome = resolution.outcome;
        }
      } catch {
        // Gamma API failure
      }

      // 2. If Polymarket hasn't resolved yet, wait for +30s then use Binance
      // Compute Binance prediction for UI (never used for actual outcome)
      let closePrice: number | null = null;
      const history = this.custom.priceHistory[w.cryptoSymbol] || [];
      closePrice = findPriceAtTime(history, w.windowEndTime);
      if (!closePrice) {
        const snap = await fetchSpotPrice(w.cryptoSymbol);
        closePrice = snap?.price ?? null;
      }
      if (closePrice !== null && w.priceAtWindowOpen > 0) {
        w.binancePrediction = closePrice >= w.priceAtWindowOpen ? "UP" : "DOWN";
      }

      if (outcome === "UNKNOWN") {
        // Wait for Polymarket — never use Binance for actual resolution
        if (now < w.windowEndTime + 1800_000) continue; // give up after 30min
        ctx.log(
          `RESOLUTION TIMEOUT: ${w.market.title.slice(0, 25)} Polymarket not resolved after 30min, marking UNKNOWN`
        );
      }

      // P&L: winning side pays $1.00, losing side = $0, plus realized sells
      let winningPayout = 0;
      let losingLoss = 0;

      if (outcome !== "UNKNOWN") {
        const winInv = outcome === "UP" ? w.upInventory : w.downInventory;
        const winCost = outcome === "UP" ? w.upAvgCost : w.downAvgCost;
        const loseInv = outcome === "UP" ? w.downInventory : w.upInventory;
        const loseCost = outcome === "UP" ? w.downAvgCost : w.upAvgCost;

        const payoutFee =
          calcFeePerShare(1.0, params.fee_params) * winInv;
        winningPayout = winInv * (1.0 - winCost) - payoutFee;
        losingLoss = -(loseInv * loseCost);
      }

      const netPnl = winningPayout + losingLoss + w.realizedSellPnl;
      const correct =
        outcome !== "UNKNOWN" && w.convictionSide === outcome;

      const priceMovePct = closePrice !== null && w.priceAtWindowOpen > 0
        ? ((closePrice - w.priceAtWindowOpen) / w.priceAtWindowOpen) * 100
        : 0;

      const completed: CompletedMakerWindow = {
        title: w.market.title,
        cryptoSymbol: w.cryptoSymbol,
        convictionSide: w.convictionSide,
        outcome,
        upInventory: w.upInventory,
        downInventory: w.downInventory,
        totalBuyCost: w.totalBuyCost,
        realizedSellPnl: w.realizedSellPnl,
        winningPayout,
        losingLoss,
        netPnl,
        signalStrength: w.signalStrengthAtEntry,
        fillCount: w.fillCount,
        sellCount: w.sellCount,
        correct,
        completedAt: new Date().toISOString(),
        priceMovePct,
        upAvgCost: w.upAvgCost,
        downAvgCost: w.downAvgCost,
        flipCount: w.flipCount,
      };

      // Flush final tick snapshots to D1 with outcome
      if (params.record_snapshots && w.tickSnapshots?.length) {
        try {
          const openDate = new Date(w.windowOpenTime);
          const snapId = w.snapshotId || `snap-${crypto.randomUUID()}`;
          await ctx.db.prepare(
            `INSERT OR REPLACE INTO strategy_snapshots (id, strategy_id, window_title, crypto_symbol, window_open_time, window_end_time, window_duration_ms, oracle_strike, price_at_open, hour_utc, day_of_week, up_token_id, down_token_id, outcome, ticks)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            snapId, ctx.config.id, w.market.title, w.cryptoSymbol,
            w.windowOpenTime, w.windowEndTime, w.windowEndTime - w.windowOpenTime,
            w.oracleStrike ?? null, w.priceAtWindowOpen,
            openDate.getUTCHours(), openDate.getUTCDay(),
            w.market.upTokenId, w.market.downTokenId,
            outcome, JSON.stringify(w.tickSnapshots)
          ).run();
          // Purge snapshots older than 7 days to prevent unbounded growth
          const retentionMs = 7 * 24 * 60 * 60 * 1000;
          await ctx.db.prepare(
            `DELETE FROM strategy_snapshots WHERE window_end_time < ?`
          ).bind(Date.now() - retentionMs).run();
        } catch (e) {
          ctx.log(`SNAPSHOT SAVE ERROR: ${e}`, { level: "error", phase: "snapshot" } as never);
        }
      }

      this.custom.completedWindows.push(completed);
      this.onWindowResolved(completed, params, ctx);
      if (this.custom.completedWindows.length > 20) {
        this.custom.completedWindows =
          this.custom.completedWindows.slice(-50);
      }

      this.custom.totalPnl += netPnl;
      this.custom.windowsTraded++;
      if (correct) this.custom.windowsWon++;
      if (outcome !== "UNKNOWN" && !correct) this.custom.windowsLost++;

      const total = this.custom.windowsWon + this.custom.windowsLost;
      this.custom.directionalAccuracy =
        total > 0 ? this.custom.windowsWon / total : 0;

      // Per-asset tracking
      if (!this.custom.perAsset[w.cryptoSymbol]) {
        this.custom.perAsset[w.cryptoSymbol] = { won: 0, lost: 0, pnl: 0, fills: 0 };
      }
      const asset = this.custom.perAsset[w.cryptoSymbol];
      if (correct) asset.won++;
      else if (outcome !== "UNKNOWN") asset.lost++;
      asset.pnl += netPnl;
      asset.fills += w.fillCount;

      const outcomeLabel =
        outcome === "UNKNOWN"
          ? "UNKNOWN"
          : `${outcome} ${correct ? "CORRECT" : "WRONG"}`;

      ctx.log(
        `RESOLVED: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} ${priceMovePct >= 0 ? "+" : ""}${priceMovePct.toFixed(3)}% → ${outcomeLabel} | inv UP=${w.upInventory} DN=${w.downInventory} buys=${w.fillCount} sells=${w.sellCount} flips=${w.flipCount} | win=$${winningPayout.toFixed(2)} lose=$${losingLoss.toFixed(2)} sells=$${w.realizedSellPnl.toFixed(2)} net=$${netPnl.toFixed(2)} | W/L=${this.custom.windowsWon}/${this.custom.windowsLost}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: outcome === "UNKNOWN" ? undefined : outcome, signalStrength: w.signalStrengthAtEntry, flipCount: w.flipCount, upInventory: w.upInventory, downInventory: w.downInventory, phase: "resolve" }
      );

      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'RESOLVE', 0, 0, 0, datetime('now'), ?)`
        )
        .bind(
          `sm-resolve-${crypto.randomUUID()}`,
          ctx.config.id,
          w.market.conditionId,
          w.market.slug,
          `${w.market.title} [MAKER ${outcomeLabel} fills=${w.fillCount}]`,
          netPnl
        )
        .run();

      toRemove.push(i);
    }

    // Auto-redeem resolved conditions (PaperStrategyAPI.redeemConditions is a no-op)
    if (toRemove.length > 0) {
      const conditionIds = toRemove
        .map((i) => this.custom.activeWindows[i]?.market.conditionId)
        .filter((cid): cid is string => !!cid);
      ctx.log(`AUTO-REDEEM: attempting ${conditionIds.length} conditions (toRemove=${toRemove.length})`, { level: "info", phase: "redeem" } as never);
      if (conditionIds.length > 0) {
        try {
          const result = await ctx.api.redeemConditions(conditionIds);
          if (result.error) {
            ctx.log(`AUTO-REDEEM ERROR: ${result.error}`, { level: "error", phase: "redeem" } as never);
          } else {
            ctx.log(`AUTO-REDEEM OK: ${conditionIds.length} conditions, redeemed=${result.redeemed}`, { level: "info", phase: "redeem" } as never);
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

registerStrategy("safe-maker", () => new SafeMakerStrategy());
