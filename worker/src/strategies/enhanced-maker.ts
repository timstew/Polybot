/**
 * Enhanced Maker Strategy
 *
 * Based on Safe Maker (the most profitable strategy) with three surgical
 * improvements from Avellaneda: volatility-adaptive spread, P_true-blended
 * fair value, and delta-based regime gates. No taker mode.
 *
 * All Safe Maker structural protections preserved:
 * - Paired-inventory protection (never sells matched pairs)
 * - Cross-fill guard (max_pair_cost caps)
 * - Inventory ratio stop
 * - Per-tick heavy-side cancellation
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
  CRYPTO_SYMBOL_MAP,
  // Enhanced: P_true, Delta, volatility from price-feed
  calculatePTrue,
  calculateDelta,
  realtimeVolatility,
  estimateVolatility5min,
} from "./price-feed";
import { tryMerge } from "./merge";

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

  // Enhanced: per-window tracking
  lastVol: number;
  lastPTrue: number;
  lastDelta: number;
  lastNormalizedDelta: number;
  regime: "quoting" | "delta_wide" | "delta_paused";
  strikePrice: number | null;
  strikeDirection: "above" | "below" | null;
  windowDurationMs: number;
}

interface CompletedMakerWindow {
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

interface MakerCustomState {
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
}

interface EnhancedMakerParams {
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
  enable_order_flow: boolean;
  dead_zone_pct: number;
  max_flips_per_window: number;
  max_pair_cost: number;
  max_inventory_ratio: number;
  grounded_fills: boolean;
  max_bid_per_side: number;
  // Adaptive repricing (from Safe Maker)
  min_requote_delta: number;
  vol_offset_scale_high: number;
  vol_offset_scale_low: number;
  tighten_start_pct: number;
  // Enhanced: new params
  vol_ema_window_s: number;       // EMA window for realtimeVolatility()
  vol_spread_floor: number;       // min half-spread from vol model
  vol_spread_weight: number;      // blend: (1-w)*fixed_offset + w*vol_spread
  ptrue_blend_weight: number;     // blend: (1-w)*signal_fair + w*p_true
  delta_pause_threshold: number;  // normalized |d|*S*0.01 → cancel all bids
  delta_widen_threshold: number;  // normalized delta → double spread
  delta_widen_multiplier: number; // spread multiplier in delta_wide zone
  merge_enabled?: boolean;
}

const DEFAULT_PARAMS: EnhancedMakerParams = {
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
  max_concurrent_windows: 12,
  min_signal_strength: 0.45,
  fee_params: CRYPTO_FEES,
  discovery_interval_ms: 15_000,
  enable_order_flow: false,
  dead_zone_pct: 0,
  max_flips_per_window: 3,
  max_pair_cost: 0.93,
  max_inventory_ratio: 2,
  grounded_fills: true,
  max_bid_per_side: 0.45,
  min_requote_delta: 0.02,
  vol_offset_scale_high: 1.5,
  vol_offset_scale_low: 0.5,
  tighten_start_pct: 0.70,
  // Enhanced defaults
  vol_ema_window_s: 60,
  vol_spread_floor: 0.01,
  vol_spread_weight: 0.5,
  ptrue_blend_weight: 0.3,
  delta_pause_threshold: 5.0,
  delta_widen_threshold: 3.0,
  delta_widen_multiplier: 2.0,
  merge_enabled: true,
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

function emptyCustom(): MakerCustomState {
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

class EnhancedMakerStrategy implements Strategy {
  name = "enhanced-maker";
  private custom: MakerCustomState = emptyCustom();
  private marketCache: CryptoMarket[] = [];
  private lastDiscovery = 0;

  // Book cache: 5s TTL, shared across windows to avoid redundant fetches
  private bookCache: Map<string, BookCacheEntry> = new Map();
  private static BOOK_CACHE_TTL = 5_000;

  private async getBookCached(ctx: StrategyContext, tokenId: string): Promise<OrderBook> {
    const now = Date.now();
    const cached = this.bookCache.get(tokenId);
    if (cached && now - cached.fetchedAt < EnhancedMakerStrategy.BOOK_CACHE_TTL) {
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
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as EnhancedMakerParams;
    if (params.enable_order_flow) {
      const symbols = params.target_cryptos
        .map((c) => CRYPTO_SYMBOL_MAP[c.toLowerCase()])
        .filter(Boolean) as string[];
      enableOrderFlow(symbols);
      ctx.log(`Order flow enabled for: ${symbols.join(", ")}`);
    }

    ctx.log(
      `Enhanced Maker initialized: ${this.custom.activeWindows.length} active, ${this.custom.totalMakerFills} total fills, accuracy=${(this.custom.directionalAccuracy * 100).toFixed(0)}%`
    );
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const params = {
      ...DEFAULT_PARAMS,
      ...ctx.config.params,
    } as EnhancedMakerParams;

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
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as EnhancedMakerParams;
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

  private recordFillFromCancel(
    ctx: StrategyContext,
    w: MakerWindowPosition,
    side: "UP" | "DOWN",
    size: number,
    price: number,
    _params: EnhancedMakerParams
  ): void {
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
    params: EnhancedMakerParams
  ): Promise<{ entered: number; marketsScanned: number; skipCounts: Record<string, number> }> {
    const now = Date.now();
    const activeConditions = new Set(
      this.custom.activeWindows.map((w) => w.market.conditionId)
    );
    const skipCounts: Record<string, number> = {};
    let marketsScanned = 0;

    const capitalCommitted = this.custom.activeWindows.reduce(
      (sum, w) => {
        const inv = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
        const pending = (w.upBidOrderId ? w.upBidSize * w.upBidPrice : 0)
          + (w.downBidOrderId ? w.downBidSize * w.downBidPrice : 0);
        return sum + inv + pending;
      }, 0
    );

    const windowsBefore = this.custom.activeWindows.length;
    for (const market of this.marketCache) {
      if (this.custom.activeWindows.length >= params.max_concurrent_windows)
        break;
      if (activeConditions.has(market.conditionId)) continue;

      const sym = extractCryptoSymbol(market.title);
      if (!sym) continue;
      marketsScanned++;

      const estNewWindowCost = params.max_pair_cost * params.base_bid_size;
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
        binancePrediction: undefined,
        // Enhanced fields
        lastVol: 0,
        lastPTrue: 0.5,
        lastDelta: 0,
        lastNormalizedDelta: 0,
        regime: "quoting",
        strikePrice: market.strikePrice,
        strikeDirection: market.strikeDirection,
        windowDurationMs: windowDuration,
      };

      this.custom.activeWindows.push(window);

      const convLabel = convictionSide
        ? `${convictionSide}@${(signal.signalStrength * 100).toFixed(0)}%`
        : "NEUTRAL";
      const upMid = getMid(upBook);
      const downMid = getMid(downBook);
      const strikeStr = market.strikePrice
        ? ` strike=$${market.strikePrice} ${market.strikeDirection}`
        : "";
      ctx.log(
        `ENTERED: ${market.title.slice(0, 35)} ${sym} ${signal.priceChangePct >= 0 ? "+" : ""}${signal.priceChangePct.toFixed(3)}% conv=${convLabel} UP_mid=${upMid?.toFixed(2) ?? "?"} DN_mid=${downMid?.toFixed(2) ?? "?"}${strikeStr}`,
        { level: "signal", symbol: sym, direction: convictionSide ?? signal.direction, signalStrength: signal.signalStrength, priceChangePct: signal.priceChangePct, momentum: signal.momentum, volatilityRegime: signal.volatilityRegime, inDeadZone: false, flipCount: 0, phase: "entry" }
      );
    }
    return { entered: this.custom.activeWindows.length - windowsBefore, marketsScanned, skipCounts };
  }

  // ── Manage active windows ───────────────────────────────────────

  private async manageWindows(
    ctx: StrategyContext,
    params: EnhancedMakerParams
  ): Promise<void> {
    const now = Date.now();

    for (const w of this.custom.activeWindows) {
      const timeToEnd = w.windowEndTime - now;

      if (now > w.windowEndTime + 300_000) {
        w.tickAction = "Awaiting resolution";
        continue;
      }

      if (ctx.windingDown && timeToEnd >= params.stop_quoting_before_end_ms) {
        await this.windDownWindow(ctx, w, params);
        continue;
      }

      if (timeToEnd < params.exit_inventory_before_end_ms) {
        if (w.upBidOrderId) {
          const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price, params); w.upBidOrderId = null; }
        }
        if (w.downBidOrderId) {
          const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price, params); w.downBidOrderId = null; }
        }
        await this.sellLosingInventory(ctx, w, params, "DUMP");
        w.tickAction = `Exiting: sell excess ${w.upInventory}↑/${w.downInventory}↓`;
        continue;
      }

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

      // Compute signal once for this tick
      const currentSnap = await fetchSpotPrice(w.cryptoSymbol);
      if (!currentSnap) continue;

      const history = this.custom.priceHistory[w.cryptoSymbol] || [];
      const signalOpts: ComputeSignalOptions = {
        prevDirection: w.confirmedDirection,
      };
      if (params.dead_zone_pct > 0) signalOpts.deadZonePct = params.dead_zone_pct;
      const signal = computeSignal(
        w.cryptoSymbol,
        w.priceAtWindowOpen,
        currentSnap.price,
        now - w.windowOpenTime,
        history.filter((s) => s.timestamp >= w.windowOpenTime),
        signalOpts
      );

      // ── Enhancement A: Delta regime gate ──────────────────────────
      // Compute vol, P_true, delta if strike available
      const windowHistory = history.filter((s) => s.timestamp >= w.windowOpenTime);
      const vol = realtimeVolatility(windowHistory, params.vol_ema_window_s);
      w.lastVol = vol;

      const timeRemainingMs = w.windowEndTime - now;
      const strike = w.strikePrice ?? w.priceAtWindowOpen; // fallback to window open
      const dir = w.strikeDirection ?? "above"; // fallback

      const pTrue = calculatePTrue(currentSnap.price, strike, dir, timeRemainingMs, vol);
      const delta = calculateDelta(currentSnap.price, strike, dir, timeRemainingMs, vol);
      w.lastPTrue = pTrue;
      w.lastDelta = delta;

      // Normalized delta: |delta| * spot * 0.01 (asset-agnostic)
      const normalizedDelta = Math.abs(delta) * currentSnap.price * 0.01;
      w.lastNormalizedDelta = normalizedDelta;

      // Apply delta regime gates
      if (normalizedDelta > params.delta_pause_threshold) {
        // Cancel all bids, skip this window — too dangerous
        w.regime = "delta_paused";
        if (w.upBidOrderId) {
          const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price, params); w.upBidOrderId = null; }
        }
        if (w.downBidOrderId) {
          const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price, params); w.downBidOrderId = null; }
        }
        if (ctx.state.ticks % 5 === 0) {
          ctx.log(
            `DELTA PAUSE: ${w.market.title.slice(0, 25)} nDelta=${normalizedDelta.toFixed(1)} > ${params.delta_pause_threshold} | spot=${currentSnap.price.toFixed(2)} strike=${strike.toFixed(2)} pTrue=${pTrue.toFixed(3)}`,
            { level: "signal", symbol: w.cryptoSymbol, direction: signal.direction, signalStrength: signal.signalStrength, phase: "delta_pause" }
          );
        }
        w.tickAction = `Delta paused: nD=${normalizedDelta.toFixed(1)}`;
        continue;
      } else if (normalizedDelta > params.delta_widen_threshold) {
        w.regime = "delta_wide";
      } else {
        w.regime = "quoting";
      }

      // Check fills on pending bids
      await this.checkFills(ctx, w, params, signal);

      // Update signal and requote
      await this.updateQuotes(ctx, w, params, signal, currentSnap.price);

      // Per-tick safety: cancel bids on the heavy side
      const maxInvR = params.max_inventory_ratio;
      const wDur = w.windowEndTime - w.windowOpenTime;
      const effBase = Math.max(10, Math.round(params.base_bid_size * Math.min(1.0, (wDur / 60_000) / 15)));
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

  private async windDownWindow(
    ctx: StrategyContext,
    w: MakerWindowPosition,
    params: EnhancedMakerParams
  ): Promise<void> {
    const currentSnap = await fetchSpotPrice(w.cryptoSymbol);
    if (currentSnap) {
      const history = this.custom.priceHistory[w.cryptoSymbol] || [];
      const signal = computeSignal(
        w.cryptoSymbol,
        w.priceAtWindowOpen,
        currentSnap.price,
        Date.now() - w.windowOpenTime,
        history.filter((s) => s.timestamp >= w.windowOpenTime)
      );
      await this.checkFills(ctx, w, params, signal);
    }

    const gap = Math.abs(w.upInventory - w.downInventory);

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

    const lightSide: "UP" | "DOWN" = w.upInventory < w.downInventory ? "UP" : "DOWN";
    const heavySide: "UP" | "DOWN" = lightSide === "UP" ? "DOWN" : "UP";

    const heavyBidId = heavySide === "UP" ? w.upBidOrderId : w.downBidOrderId;
    if (heavyBidId) {
      const r = await safeCancelOrder(ctx.api, heavyBidId);
      if (r.cleared) {
        if (r.fill) this.recordFillFromCancel(ctx, w, heavySide, r.fill.size, r.fill.price, params);
        if (heavySide === "UP") w.upBidOrderId = null;
        else w.downBidOrderId = null;
      }
    }

    const lightBidId = lightSide === "UP" ? w.upBidOrderId : w.downBidOrderId;
    if (!lightBidId) {
      const bidSize = Math.min(gap, params.base_bid_size);
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
        const costBasis = fillPrice;
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
        await ctx.db
          .prepare(
            `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
             VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
          )
          .bind(
            `em-wd-${crypto.randomUUID()}`,
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

  private async checkFills(
    ctx: StrategyContext,
    w: MakerWindowPosition,
    params: EnhancedMakerParams,
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
              `em-sell-${crypto.randomUUID()}`,
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
      } catch {
        // Status check failed — retry next tick
      }
    }

    // Check UP bid fill
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
            `em-up-${crypto.randomUUID()}`,
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

    // Check DOWN bid fill
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
            `em-dn-${crypto.randomUUID()}`,
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
    params: EnhancedMakerParams,
    signal: WindowSignal,
    spotPrice: number
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

    // ── Enhancement B: P_true-blended fair value ──────────────────────
    const dirSign = signal.direction === "UP" ? 1 : -1;
    const signalFairUp = Math.max(0.05, Math.min(0.95,
      0.50 + signal.signalStrength * 0.20 * dirSign
    ));

    let fairUp: number;
    if (w.strikePrice !== null && w.strikeDirection !== null) {
      // Blend signal-derived fair value with P_true
      const pTrue = w.lastPTrue; // already computed in manageWindows
      // pTrue is probability of YES/UP; for "below" markets, it's already flipped
      const pTrueFairUp = pTrue;
      fairUp = (1 - params.ptrue_blend_weight) * signalFairUp + params.ptrue_blend_weight * pTrueFairUp;
      fairUp = Math.max(0.05, Math.min(0.95, fairUp));
    } else {
      fairUp = signalFairUp; // pure Safe Maker: no strike info
    }
    const fairDown = 1.0 - fairUp;

    // Periodic signal log (every ~5th tick)
    if (ctx.state.ticks % 5 === 0) {
      const regimeStr = w.regime !== "quoting" ? ` regime=${w.regime}` : "";
      const pTrueStr = w.strikePrice !== null ? ` pTrue=${w.lastPTrue.toFixed(3)}` : "";
      const deltaStr = w.lastNormalizedDelta > 0 ? ` nDelta=${w.lastNormalizedDelta.toFixed(1)}` : "";
      const volStr = ` vol=${w.lastVol.toFixed(3)}%`;
      ctx.log(
        `SIGNAL: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} ${signal.direction} str=${(signal.signalStrength * 100).toFixed(0)}% fv=${fairUp.toFixed(2)}/${fairDown.toFixed(2)} UP=${w.upInventory} DN=${w.downInventory} flips=${w.flipCount}${volStr}${pTrueStr}${deltaStr}${regimeStr}`,
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
      const pc = (up > 0 && dn > 0) ? `pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
      const dir = signal.direction;
      const str = (signal.signalStrength * 100).toFixed(0);
      w.tickAction = `${dir} ${str}% vol=${signal.volatilityRegime} ${w.regime} → no requote ${pc}`;
      return;
    }

    // On direction flip, cancel bids and sell the losing side inventory
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
        await this.sellLosingInventory(ctx, w, params, "FLIP SELL");
      }
    }

    // Periodically sell losing-side inventory when signal is strong
    if (!directionChanged && signal.signalStrength >= 0.5) {
      const losingSide = signal.direction === "UP" ? "DOWN" : "UP";
      const losingInv = losingSide === "UP" ? w.upInventory : w.downInventory;
      if (losingInv > 0) {
        await this.sellLosingInventory(ctx, w, params, "REBALANCE");
      }
    }

    // Determine conviction-biased sizes with volatility adjustment
    const convictionSide =
      signal.signalStrength >= params.min_signal_strength
        ? signal.direction
        : null;

    const strengthRange = 1.0 - params.min_signal_strength;
    const strengthFraction = strengthRange > 0
      ? Math.min(1.0, (signal.signalStrength - params.min_signal_strength) / strengthRange)
      : 0;
    const scaledBias = 1.0 + (params.conviction_bias - 1.0) * strengthFraction;
    const adjustedBias = scaledBias * signal.confidenceMultiplier;
    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);
    let effectiveBaseSize = Math.max(10, Math.round(params.base_bid_size * durationScale));
    const activeCount = this.custom.activeWindows.length;
    const slots = Math.max(2, activeCount + 1);
    const maxPerSide = Math.floor(ctx.config.max_capital_usd / (slots * 2 * params.max_bid_per_side));
    effectiveBaseSize = Math.min(effectiveBaseSize, Math.max(5, maxPerSide));
    let upBidSize = effectiveBaseSize;
    let downBidSize = effectiveBaseSize;
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

    const maxOneSide = effectiveBaseSize;
    if (w.downInventory === 0) upBidSize = Math.min(upBidSize, Math.max(0, maxOneSide - w.upInventory));
    if (w.upInventory === 0) downBidSize = Math.min(downBidSize, Math.max(0, maxOneSide - w.downInventory));

    const maxInvRatio = params.max_inventory_ratio;
    if (w.upInventory > 0 && w.downInventory > 0) {
      if (w.upInventory / w.downInventory > maxInvRatio) upBidSize = 0;
      if (w.downInventory / w.upInventory > maxInvRatio) downBidSize = 0;
    } else if (w.upInventory >= effectiveBaseSize && w.downInventory === 0) {
      upBidSize = 0;
    } else if (w.downInventory >= effectiveBaseSize && w.upInventory === 0) {
      downBidSize = 0;
    }

    const windowCapital = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
    if (windowCapital > params.max_capital_per_window) {
      w.tickAction = `Window capital limit`;
      return;
    }

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
      const scale = remaining / (estUpBidCost + estDnBidCost);
      upBidSize = Math.floor(upBidSize * scale);
      downBidSize = Math.floor(downBidSize * scale);
      if (upBidSize < 3 && downBidSize < 3) {
        w.tickAction = `Capital limit: ${fmt$(capitalCommitted)}/${fmt$(ctx.config.max_capital_usd)}`;
        return;
      }
    }

    // ── Enhancement C: Volatility-adaptive spread ─────────────────────
    // Compute vol half-spread from realtime volatility
    const history = this.custom.priceHistory[w.cryptoSymbol] || [];
    const windowHistory = history.filter((s) => s.timestamp >= w.windowOpenTime);
    const sigma = w.lastVol; // already computed in manageWindows (% units)

    // Expected move during one stale period (tick interval + buffer)
    const staleWindowMs = (ctx.config.tick_interval_ms || 5000) + 100;
    const eMoveAbs = spotPrice * (sigma / 100) * Math.sqrt(staleWindowMs / 300_000);

    let volHalfSpread: number;
    if (w.lastDelta !== 0) {
      // Delta-scaled: how much P_true moves per E_move
      volHalfSpread = Math.abs(w.lastDelta) * eMoveAbs;
    } else {
      // Rough scaling when no delta available
      volHalfSpread = eMoveAbs / spotPrice * 50;
    }
    volHalfSpread = Math.max(params.vol_spread_floor, volHalfSpread);

    // Blend vol spread with Safe Maker's fixed offset
    const volMultiplier =
      signal.volatilityRegime === "high" ? params.vol_offset_scale_high :
      signal.volatilityRegime === "low"  ? params.vol_offset_scale_low :
      1.0;
    const fixedOffset = params.bid_offset * volMultiplier;
    let effectiveOffset = (1 - params.vol_spread_weight) * fixedOffset + params.vol_spread_weight * volHalfSpread;

    // Delta-wide regime: widen spread
    if (w.regime === "delta_wide") {
      effectiveOffset *= params.delta_widen_multiplier;
    }

    // Time-decay: tighten offset in last portion of window (only for unfilled sides)
    const windowProgress = (now - w.windowOpenTime) / wDurMs;
    const tightenStart = params.tighten_start_pct;
    const timeDecay = windowProgress > tightenStart
      ? 1.0 - (windowProgress - tightenStart) / (1.0 - tightenStart)
      : 1.0;

    const upOffset = w.upInventory > 0 ? effectiveOffset : effectiveOffset * timeDecay;
    const dnOffset = w.downInventory > 0 ? effectiveOffset : effectiveOffset * timeDecay;

    // Complementary pricing: cumulative upAvgCost + dnBid (or vice versa) <= max_pair_cost
    const rawUpBid = Math.min(Math.max(0.01, fairUp - upOffset), params.max_bid_per_side);
    const rawDnBid = Math.min(Math.max(0.01, fairDown - dnOffset), params.max_bid_per_side);

    let upBid = w.downInventory > 0
      ? Math.min(rawUpBid, params.max_pair_cost - w.downAvgCost)
      : rawUpBid;
    let dnBid = w.upInventory > 0
      ? Math.min(rawDnBid, params.max_pair_cost - w.upAvgCost)
      : rawDnBid;

    if (upBid + dnBid > params.max_pair_cost) {
      const scale = params.max_pair_cost / (upBid + dnBid);
      upBid = upBid * scale;
      dnBid = dnBid * scale;
    }
    upBid = Math.max(0.01, upBid);
    dnBid = Math.max(0.01, dnBid);

    // Reluctant requoting
    if (!directionChanged) {
      const roundedUpBid = Math.floor(upBid * 100) / 100;
      const roundedDnBid = Math.floor(dnBid * 100) / 100;
      const needsUpRequote = !w.upBidOrderId || Math.abs(roundedUpBid - w.upBidPrice) >= params.min_requote_delta;
      const needsDnRequote = !w.downBidOrderId || Math.abs(roundedDnBid - w.downBidPrice) >= params.min_requote_delta;

      if (needsUpRequote && w.upBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price, params); w.upBidOrderId = null; }
      }

      if (needsDnRequote && w.downBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price, params); w.downBidOrderId = null; }
      }
    }

    // Place UP bid
    if (!w.upBidOrderId && upBidSize > 0) {
      let roundedBid = Math.floor(upBid * 100) / 100;
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
        const costBasis = fillPrice;
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
            `em-up-imm-${crypto.randomUUID()}`,
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
        const costBasis = fillPrice;
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
            `em-dn-imm-${crypto.randomUUID()}`,
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

    // Set tickAction
    {
      const up = w.upInventory, dn = w.downInventory;
      const pc = (up > 0 && dn > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
      const str = (signal.signalStrength * 100).toFixed(0);
      const vol = signal.volatilityRegime;
      const decay = (timeDecay * 100).toFixed(0);
      const upBidStr = w.upBidOrderId ? `▲${w.upBidPrice.toFixed(2)}` : "";
      const dnBidStr = w.downBidOrderId ? `▼${w.downBidPrice.toFixed(2)}` : "";
      const bids = [upBidStr, dnBidStr].filter(Boolean).join(" ");
      const regimeTag = w.regime !== "quoting" ? ` [${w.regime}]` : "";
      w.tickAction = directionChanged
        ? `FLIP→${signal.direction} ${str}% vol=${vol}${regimeTag} → ${bids} decay=${decay}%${pc}`
        : `${signal.direction} ${str}% vol=${vol}${regimeTag} → ${bids} decay=${decay}%${pc}`;
    }

    w.lastSignalDirection = signal.direction;
    w.lastQuotedAt = now;
    w.lastQuotedPriceChangePct = signal.priceChangePct;
    w.convictionSide = convictionSide;

    if (directionChanged) {
      ctx.log(
        `REQUOTE: ${w.market.title.slice(0, 30)} direction flipped to ${signal.direction} strength=${(signal.signalStrength * 100).toFixed(0)}% regime=${w.regime} vol=${w.lastVol.toFixed(3)}% offset=${effectiveOffset.toFixed(4)}`
      );
    }
  }

  // ── Sell losing side inventory ──────────────────────────────────

  private async sellLosingInventory(
    ctx: StrategyContext,
    w: MakerWindowPosition,
    params: EnhancedMakerParams,
    label: string
  ): Promise<void> {
    const history = this.custom.priceHistory[w.cryptoSymbol] || [];
    const currentSnap = await fetchSpotPrice(w.cryptoSymbol);
    if (!currentSnap) return;

    const signal = computeSignal(
      w.cryptoSymbol,
      w.priceAtWindowOpen,
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

    // Never sell paired inventory — only sell excess beyond the matched amount
    const paired = Math.min(w.upInventory, w.downInventory);
    const losingInventory = rawLosingInventory - paired;

    if (losingInventory <= 0) return;

    const book = await this.getBookCached(ctx, losingTokenId);
    const bestBid = book.bids.length > 0
      ? Math.max(...book.bids.map(l => l.price))
      : null;
    const dirSign = signal.direction === "UP" ? 1 : -1;
    const fairVal = Math.max(0.02, Math.min(0.98,
      0.50 + signal.signalStrength * 0.20 * dirSign
    ));
    const signalPrice = losingSide === "UP" ? fairVal : (1.0 - fairVal);
    const sellPrice = Math.max(0.01, bestBid ?? signalPrice);

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
          `em-sell-${crypto.randomUUID()}`,
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
    params: EnhancedMakerParams
  ): Promise<void> {
    const now = Date.now();
    const toRemove: number[] = [];

    for (let i = 0; i < this.custom.activeWindows.length; i++) {
      const w = this.custom.activeWindows[i];
      if (now < w.windowEndTime + 60_000) continue;

      if (w.upInventory === 0 && w.downInventory === 0) {
        ctx.log(
          `EXPIRED (no fills): ${w.market.title.slice(0, 35)}`
        );
        toRemove.push(i);
        continue;
      }

      let outcome: "UP" | "DOWN" | "UNKNOWN" = "UNKNOWN";

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
        if (now < w.windowEndTime + 1800_000) continue;
        ctx.log(
          `RESOLUTION TIMEOUT: ${w.market.title.slice(0, 25)} Polymarket not resolved after 30min, marking UNKNOWN`
        );
      }

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

      this.custom.completedWindows.push(completed);
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
          `em-resolve-${crypto.randomUUID()}`,
          ctx.config.id,
          w.market.conditionId,
          w.market.slug,
          `${w.market.title} [MAKER ${outcomeLabel} fills=${w.fillCount}]`,
          netPnl
        )
        .run();

      toRemove.push(i);
    }

    if (toRemove.length > 0) {
      const conditionIds = toRemove
        .map((i) => this.custom.activeWindows[i]?.market.conditionId)
        .filter((cid): cid is string => !!cid);
      ctx.log(`AUTO-REDEEM: attempting ${conditionIds.length} conditions`, { level: "info", phase: "redeem" } as never);
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

registerStrategy("enhanced-maker", () => new EnhancedMakerStrategy());
