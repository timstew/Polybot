/**
 * Unified Adaptive Strategy
 *
 * Combines spread-sniper (direction-agnostic) and directional-maker (conviction-biased)
 * into a single strategy that selects mode per market+timeframe based on conditions.
 *
 * Key features:
 * - One strategy per market — picks sniper or maker per window (no self-competition)
 * - Liquidity-based bid sizing — sizes bids from observed fill rates, targeting ~90% match rate
 * - Fill bucket EMA — learns per-symbol, per-duration, per-mode fill characteristics
 * - Balance/drawdown protection delegated to base framework (strategy.ts)
 */

import type { Strategy, StrategyContext, OrderBook, ActivityTrade } from "../strategy";
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
} from "./price-feed";


// ── Interfaces ────────────────────────────────────────────────────────

interface FillBucket {
  avgMatchRate: number;
  avgFillCount: number;
  avgUpFills: number;
  avgDownFills: number;
  sampleCount: number;
  lastBidSize: number;
  lastUpdated: number;
}

interface LiquidityState {
  buckets: Record<string, FillBucket>;
  globalAvgMatchRate: number;
  globalSampleCount: number;
}

interface UnifiedParams {
  target_cryptos: string[];
  min_bid_size: number;
  max_bid_size: number;
  default_bid_size: number;
  max_pair_cost: number;
  maker_max_pair_cost: number;
  bid_offset: number;
  maker_bid_offset: number;
  conviction_bias: number;
  min_signal_strength: number;
  max_concurrent_windows: number;
  // Liquidity-based sizing
  target_match_rate: number;
  liquidity_damping: number;
  liquidity_ema_alpha: number;
  min_bucket_samples: number;
  // Risk management
  max_drawdown_pct: number;
  // Inherited params
  fee_params: FeeParams;
  discovery_interval_ms: number;
  enable_order_flow: boolean;
  dead_zone_pct: number;
  max_flips_per_window: number;
  max_inventory_ratio: number;
  observation_seconds: number;
  stop_quoting_before_end_ms: number;
  exit_inventory_before_end_ms: number;
  sell_unmatched_after_ticks: number;
  max_unmatched_ratio: number;
  min_pair_confidence: number;
  requote_threshold_pct: number;
  // Deferred mode upgrade: sniper → maker
  upgrade_after_ticks: number;       // min ticks before considering upgrade
  upgrade_signal_threshold: number;  // signal strength needed to upgrade
  grounded_fills: boolean; // use trade tape instead of probabilistic model (default true)
}

const DEFAULT_PARAMS: UnifiedParams = {
  target_cryptos: ["Bitcoin", "Ethereum", "Solana", "XRP"],
  min_bid_size: 10,
  max_bid_size: 200,
  default_bid_size: 30,
  max_pair_cost: 0.92,
  maker_max_pair_cost: 0.93,
  bid_offset: 0.04,
  maker_bid_offset: 0.02,
  conviction_bias: 2.0,
  min_signal_strength: 0.25,
  max_concurrent_windows: 12,
  target_match_rate: 0.90,
  liquidity_damping: 0.5,
  liquidity_ema_alpha: 0.3,
  min_bucket_samples: 3,
  max_drawdown_pct: 0.25,
  fee_params: CRYPTO_FEES,
  discovery_interval_ms: 15_000,
  enable_order_flow: false,
  dead_zone_pct: 0,
  max_flips_per_window: 3,
  max_inventory_ratio: 2,
  observation_seconds: 10,
  stop_quoting_before_end_ms: 45_000,
  exit_inventory_before_end_ms: 15_000,
  sell_unmatched_after_ticks: 3,
  max_unmatched_ratio: 1.3,
  min_pair_confidence: 0.65,
  requote_threshold_pct: 0.05,
  upgrade_after_ticks: 3,
  upgrade_signal_threshold: 0.55,
  grounded_fills: true,
};

interface AdaptiveState {
  pnlHistory: number[];
  perAssetWinRate: Record<string, {
    sniper: { wins: number; total: number };
    maker: { wins: number; total: number };
  }>;
}

interface UnifiedWindowPosition {
  // Common
  market: CryptoMarket;
  cryptoSymbol: string;
  windowOpenTime: number;
  windowEndTime: number;
  priceAtWindowOpen: number;
  upBidOrderId: string | null;
  upBidPrice: number;
  upBidSize: number;
  downBidOrderId: string | null;
  downBidPrice: number;
  downBidSize: number;
  upInventory: number;
  upAvgCost: number;
  downInventory: number;
  downAvgCost: number;
  fillCount: number;
  sellCount: number;
  realizedSellPnl: number;
  totalBuyCost: number;
  enteredAt: number;

  // Mode
  mode: "sniper" | "maker";
  bidSize: number;
  lockedCapital: number;

  // Maker-specific
  lastSignalDirection: "UP" | "DOWN" | null;
  lastQuotedAt: number;
  lastQuotedPriceChangePct: number;
  confirmedDirection: "UP" | "DOWN" | null;
  flipCount: number;
  lastDirectionChangeAt: number;
  convictionSide: "UP" | "DOWN" | null;
  signalStrengthAtEntry: number;

  // Sniper-specific
  unmatchedTicks: number;

  // Book-aware pricing: last observed best asks
  lastUpBestAsk: number;
  lastDnBestAsk: number;

  // Real fill tracking: avoid double-counting activity trades
  processedFillIds: string[];

  // After a rebalance sell, stop quoting — the market is too one-sided for spread sniping
  rebalanceSold: boolean;

  // Deferred upgrade tracking
  ticksInWindow: number;
  upgradedFromSniper: boolean;

  // Human-readable tick action for UI
  tickAction: string;
}

interface CompletedUnifiedWindow {
  title: string;
  cryptoSymbol: string;
  mode: "sniper" | "maker";
  outcome: "UP" | "DOWN" | "UNKNOWN";
  upInventory: number;
  downInventory: number;
  upAvgCost: number;
  downAvgCost: number;
  matchedPairs: number;
  netPnl: number;
  fillCount: number;
  sellCount: number;
  completedAt: string;
  priceMovePct: number;
  bidSize: number;
  windowDurationMs: number;
}

interface UnifiedCustomState {
  activeWindows: UnifiedWindowPosition[];
  completedWindows: CompletedUnifiedWindow[];
  priceHistory: Record<string, PriceSnapshot[]>;
  windowRefPrices: Record<string, { price: number; recordedAt: number }>;
  adaptive: AdaptiveState;
  liquidity: LiquidityState;
  stats: {
    totalPnl: number;
    windowsTraded: number;
    sniperWindows: number;
    makerWindows: number;
    sniperPnl: number;
    makerPnl: number;
    sniperWins: number;
    makerWins: number;
  };
  pendingRedeems: { conditionIds: string[]; addedAt: number; attempts: number; value: number }[];
  resolvingValue: number;
  scanStatus: string;
}

// ── Volatility Analysis ──────────────────────────────────────────────

interface SniperFavorability {
  score: number;
  choppiness: number;
  trendStrength: number;
  realizedVol: number;
  regime: "oscillating" | "trending" | "calm" | "insufficient";
}

function computeSniperFavorability(
  history: PriceSnapshot[],
  windowOpenTime?: number
): SniperFavorability {
  const relevant = windowOpenTime
    ? history.filter(s => s.timestamp >= windowOpenTime)
    : history.slice(-60);

  if (relevant.length < 8) {
    return { score: 0.5, choppiness: 0.5, trendStrength: 0, realizedVol: 0, regime: "insufficient" };
  }

  const returns: number[] = [];
  for (let i = 1; i < relevant.length; i++) {
    returns.push(((relevant[i].price - relevant[i - 1].price) / relevant[i - 1].price) * 100);
  }

  let dirChanges = 0;
  for (let i = 1; i < returns.length; i++) {
    if ((returns[i] > 0 && returns[i - 1] < 0) || (returns[i] < 0 && returns[i - 1] > 0)) {
      dirChanges++;
    }
  }
  const choppiness = dirChanges / Math.max(1, returns.length - 1);

  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / returns.length;
  const realizedVol = Math.sqrt(variance);

  const trendStrength = realizedVol > 0 ? Math.abs(meanReturn) / realizedVol : 0;

  const chopScore = Math.min(1.0, choppiness / 0.6);
  const trendScore = Math.max(0, 1.0 - trendStrength * 1.5);
  let volScore: number;
  if (realizedVol < 0.003) {
    volScore = realizedVol / 0.003;
  } else if (realizedVol < 0.05) {
    volScore = 1.0;
  } else {
    volScore = Math.max(0, 1.0 - (realizedVol - 0.05) / 0.10);
  }

  const score = chopScore * 0.4 + trendScore * 0.4 + volScore * 0.2;

  let regime: SniperFavorability["regime"];
  if (trendStrength > 0.4 && choppiness < 0.35) {
    regime = "trending";
  } else if (realizedVol < 0.003) {
    regime = "calm";
  } else {
    regime = "oscillating";
  }

  return { score, choppiness, trendStrength, realizedVol, regime };
}

// ── Helpers ────────────────────────────────────────────────────────────

function findPriceAtTime(history: PriceSnapshot[], targetTime: number): number | null {
  if (history.length === 0) return null;
  let closest: PriceSnapshot | null = null;
  let minDist = Infinity;
  for (const s of history) {
    const dist = Math.abs(s.timestamp - targetTime);
    if (dist < minDist) { minDist = dist; closest = s; }
  }
  return closest && minDist < 60_000 ? closest.price : null;
}

function emptyAdaptive(): AdaptiveState {
  return {
    pnlHistory: [],
    perAssetWinRate: {},
  };
}

function emptyLiquidity(): LiquidityState {
  return { buckets: {}, globalAvgMatchRate: 0, globalSampleCount: 0 };
}

function emptyStats() {
  return {
    totalPnl: 0, windowsTraded: 0,
    sniperWindows: 0, makerWindows: 0,
    sniperPnl: 0, makerPnl: 0,
    sniperWins: 0, makerWins: 0,
  };
}

function durationBucket(title: string): "5m" | "15m" | "other" {
  const ms = parseWindowDurationMs(title);
  if (ms <= 6 * 60_000) return "5m";
  if (ms <= 20 * 60_000) return "15m";
  return "other";
}

function updateFillBucket(
  buckets: Record<string, FillBucket>,
  key: string,
  observation: { matchRate: number; fillCount: number; upFills: number; downFills: number; bidSize: number },
  alpha: number,
): void {
  const existing = buckets[key];
  if (!existing) {
    buckets[key] = {
      avgMatchRate: observation.matchRate,
      avgFillCount: observation.fillCount,
      avgUpFills: observation.upFills,
      avgDownFills: observation.downFills,
      sampleCount: 1,
      lastBidSize: observation.bidSize,
      lastUpdated: Date.now(),
    };
    return;
  }
  existing.avgMatchRate = existing.avgMatchRate * (1 - alpha) + observation.matchRate * alpha;
  existing.avgFillCount = existing.avgFillCount * (1 - alpha) + observation.fillCount * alpha;
  existing.avgUpFills = existing.avgUpFills * (1 - alpha) + observation.upFills * alpha;
  existing.avgDownFills = existing.avgDownFills * (1 - alpha) + observation.downFills * alpha;
  existing.sampleCount++;
  existing.lastBidSize = observation.bidSize;
  existing.lastUpdated = Date.now();
}

function resolveFillBucket(
  liquidity: LiquidityState,
  symbol: string,
  durBucket: string,
  mode: string,
  minSamples: number,
): FillBucket | null {
  const { buckets } = liquidity;

  // 1. Exact key
  const exactKey = `${symbol}:${durBucket}:${mode}`;
  if (buckets[exactKey] && buckets[exactKey].sampleCount >= minSamples) return buckets[exactKey];

  // 2. Any mode for this symbol+duration
  const anyModeKey = `${symbol}:${durBucket}:*`;
  if (buckets[anyModeKey] && buckets[anyModeKey].sampleCount >= minSamples + 2) return buckets[anyModeKey];

  // 3. Any asset for this duration+mode
  const anyAssetKey = `*:${durBucket}:${mode}`;
  if (buckets[anyAssetKey] && buckets[anyAssetKey].sampleCount >= minSamples + 2) return buckets[anyAssetKey];

  // 4. Global average
  if (liquidity.globalSampleCount >= minSamples) {
    return {
      avgMatchRate: liquidity.globalAvgMatchRate,
      avgFillCount: 0,
      avgUpFills: 0,
      avgDownFills: 0,
      sampleCount: liquidity.globalSampleCount,
      lastBidSize: 0,
      lastUpdated: 0,
    };
  }

  // 5. Cold start
  return null;
}

function computeOptimalBidSize(
  bucket: FillBucket | null,
  params: UnifiedParams,
  windowDurationMin: number,
  _mode: string,
): number {
  const durationScale = Math.min(1.0, windowDurationMin / 15);

  if (!bucket || bucket.lastBidSize === 0) {
    return Math.max(params.min_bid_size, Math.round(params.default_bid_size * durationScale));
  }

  const ratio = bucket.avgMatchRate / params.target_match_rate;
  const dampened = 1.0 + (ratio - 1.0) * params.liquidity_damping;
  const rawSize = bucket.lastBidSize * dampened;
  const scaled = rawSize * durationScale;
  return Math.max(params.min_bid_size, Math.min(params.max_bid_size, Math.round(scaled)));
}

function selectMode(
  signal: WindowSignal,
  windowDurationMs: number,
  params: UnifiedParams,
  assetWinRate: { sniper: { wins: number; total: number }; maker: { wins: number; total: number } } | undefined,
): "sniper" | "maker" {
  // Per-asset maker win rate check
  if (assetWinRate && assetWinRate.maker.total >= 5) {
    const makerWR = assetWinRate.maker.wins / assetWinRate.maker.total;
    if (makerWR < 0.4) return "sniper";
  }

  if (signal.volatilityRegime === "high" || signal.signalStrength < params.min_signal_strength) {
    return "sniper";
  }

  if (windowDurationMs <= 300_000) return "maker";      // 5min: maker higher $/win
  if (windowDurationMs >= 900_000) return "sniper";      // 15min+: sniper 100% win rate

  return signal.signalStrength >= 0.6 ? "maker" : "sniper";
}

// ── Strategy ──────────────────────────────────────────────────────────

interface BookCacheEntry {
  book: OrderBook;
  fetchedAt: number;
}

class UnifiedAdaptiveStrategy implements Strategy {
  name = "unified-adaptive";

  private custom: UnifiedCustomState = {
    activeWindows: [],
    completedWindows: [],
    priceHistory: {},
    windowRefPrices: {},
    adaptive: emptyAdaptive(),
    liquidity: emptyLiquidity(),
    stats: emptyStats(),
    pendingRedeems: [],
    resolvingValue: 0,
    scanStatus: "Starting up…",
  };

  private marketCache: CryptoMarket[] = [];
  private lastDiscovery = 0;

  // Book cache: 5s TTL, shared across windows to avoid redundant fetches
  private bookCache: Map<string, BookCacheEntry> = new Map();
  private static BOOK_CACHE_TTL = 5_000;

  private async getBookCached(ctx: StrategyContext, tokenId: string): Promise<OrderBook> {
    const now = Date.now();
    const cached = this.bookCache.get(tokenId);
    if (cached && now - cached.fetchedAt < UnifiedAdaptiveStrategy.BOOK_CACHE_TTL) {
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

  private getBestBid(book: OrderBook): number | null {
    if (book.bids.length === 0) return null;
    let best = book.bids[0].price;
    for (const level of book.bids) {
      if (level.price > best) best = level.price;
    }
    return best;
  }

  async init(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as UnifiedParams;
    const stored = ctx.state.custom as unknown as Partial<UnifiedCustomState> | undefined;
    if (stored) {
      this.custom = {
        activeWindows: stored.activeWindows || [],
        completedWindows: stored.completedWindows || [],
        priceHistory: stored.priceHistory || {},
        windowRefPrices: stored.windowRefPrices || {},
        adaptive: stored.adaptive || emptyAdaptive(),
        liquidity: stored.liquidity || emptyLiquidity(),
        stats: stored.stats || emptyStats(),
        pendingRedeems: stored.pendingRedeems || [],
        resolvingValue: stored.resolvingValue || 0,
        scanStatus: stored.scanStatus || "Resuming…",
      };
      // Ensure new fields exist on restored windows
      for (const w of this.custom.activeWindows) {
        if (w.lastUpBestAsk === undefined) w.lastUpBestAsk = 0;
        if (w.lastDnBestAsk === undefined) w.lastDnBestAsk = 0;
        if (!w.processedFillIds) w.processedFillIds = [];
        if (w.rebalanceSold === undefined) w.rebalanceSold = false;
      }
    } else {
      this.custom.adaptive = emptyAdaptive();
      this.custom.liquidity = emptyLiquidity();
      this.custom.pendingRedeems = [];
      this.custom.resolvingValue = 0;
      this.custom.scanStatus = "Starting up…";
    }

    // Reconcile totalPnl from D1 (source of truth) to fix drift
    try {
      const row = await ctx.db
        .prepare("SELECT COALESCE(SUM(pnl), 0) as total FROM strategy_trades WHERE strategy_id = ? AND side IN ('RESOLVE', 'MERGE', 'SELL')")
        .bind(ctx.config.id)
        .first<{ total: number }>();
      if (row && Math.abs((row.total || 0) - this.custom.stats.totalPnl) > 0.01) {
        ctx.log(`P&L RECONCILE: DO state $${this.custom.stats.totalPnl.toFixed(2)} → D1 $${(row.total || 0).toFixed(2)}`);
        this.custom.stats.totalPnl = row.total || 0;
      }
    } catch { /* D1 query failed, keep stored value */ }

    if (params.enable_order_flow) {
      const symbols = params.target_cryptos
        .map((c) => CRYPTO_SYMBOL_MAP[c.toLowerCase()])
        .filter(Boolean) as string[];
      if (symbols.length > 0) enableOrderFlow(symbols);
    }

    const currentBalance = (ctx.config.balance_usd ?? 0) + ctx.state.total_pnl;
    const bucketCount = Object.keys(this.custom.liquidity.buckets).length;
    ctx.log(
      `Unified Adaptive started: bal=$${currentBalance.toFixed(2)} hwm=$${(ctx.state.high_water_balance || 0).toFixed(2)} maxCap=$${ctx.config.max_capital_usd.toFixed(2)} defaultBid=${params.default_bid_size} buckets=${bucketCount} windows=${this.custom.stats.windowsTraded}`
    );
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as UnifiedParams;
    const now = Date.now();

    // 1. Market discovery
    if (now - this.lastDiscovery > params.discovery_interval_ms) {
      this.marketCache = await discoverCryptoMarkets(params.target_cryptos);
      this.lastDiscovery = now;
    }

    // 2. Price history
    const activeSymbols = new Set<string>();
    for (const m of this.marketCache) {
      const sym = extractCryptoSymbol(m.title);
      if (!sym) continue;
      activeSymbols.add(sym);
      const snap = await fetchSpotPrice(sym);
      if (!snap) continue;
      if (!this.custom.priceHistory[sym]) this.custom.priceHistory[sym] = [];
      const hist = this.custom.priceHistory[sym];
      if (hist.length === 0 || snap.timestamp !== hist[hist.length - 1].timestamp) {
        hist.push(snap);
        if (hist.length > 60) hist.splice(0, hist.length - 60);
      }
    }
    for (const sym of Object.keys(this.custom.priceHistory)) {
      if (!activeSymbols.has(sym)) delete this.custom.priceHistory[sym];
    }

    // 3. Manage active windows
    await this.manageWindows(ctx, params);

    // 4. Enter new windows (skip when winding down)
    if (!ctx.windingDown && this.custom.activeWindows.length < params.max_concurrent_windows) {
      await this.enterWindows(ctx, params);
    }

    // 4b. Wind-down: drop empty windows (no fills = nothing at stake)
    if (ctx.windingDown) {
      const before = this.custom.activeWindows.length;
      this.custom.activeWindows = this.custom.activeWindows.filter(
        w => w.upInventory + w.downInventory > 0 || w.totalBuyCost > 0
      );
      if (this.custom.activeWindows.length < before) {
        ctx.log(`Wind-down: dropped ${before - this.custom.activeWindows.length} empty window(s)`);
      }
    }

    // 5. Resolve completed windows
    await this.resolveWindows(ctx, params);

    // 6. Process pending redemptions (delayed ~2min for Polymarket to mark redeemable)
    await this.processPendingRedeems(ctx);

    // 7. Persist
    ctx.state.custom = this.custom as unknown as Record<string, unknown>;
    ctx.state.capital_deployed = this.custom.activeWindows.reduce(
      (sum, w) => sum + w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost, 0
    );
    ctx.state.total_pnl = this.custom.stats.totalPnl;
  }

  async stop(ctx: StrategyContext): Promise<void> {
    for (const w of this.custom.activeWindows) {
      if (w.upBidOrderId) await ctx.api.cancelOrder(w.upBidOrderId);
      if (w.downBidOrderId) await ctx.api.cancelOrder(w.downBidOrderId);
    }
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as UnifiedParams;
    if (params.enable_order_flow) disableOrderFlow();
    const currentBalance = (ctx.config.balance_usd ?? 0) + ctx.state.total_pnl;
    ctx.log(
      `Stopped. bal=$${currentBalance.toFixed(2)} P&L=$${this.custom.stats.totalPnl.toFixed(2)} windows=${this.custom.stats.windowsTraded} sniper=${this.custom.stats.sniperWindows} maker=${this.custom.stats.makerWindows}`
    );
  }

  // ── Enter windows ──────────────────────────────────────────────────

  private async enterWindows(ctx: StrategyContext, params: UnifiedParams): Promise<void> {
    const now = Date.now();
    const activeConditions = new Set(this.custom.activeWindows.map((w) => w.market.conditionId));

    // Total deployed capital: inventory + pending bids (worst case if all fill)
    const capitalCommitted = this.custom.activeWindows.reduce(
      (sum, w) => {
        const inv = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
        const pending = (w.upBidOrderId ? w.upBidSize * w.upBidPrice : 0)
          + (w.downBidOrderId ? w.downBidSize * w.downBidPrice : 0);
        return sum + inv + pending;
      }, 0
    );
    const maxCapital = ctx.config.max_capital_usd;
    const available = maxCapital - capitalCommitted;

    // Minimum capital to enter a window: bid_size * 0.46 * 2 sides
    const minCost = params.min_bid_size * 0.46 * 2;
    if (available < minCost) {
      this.custom.scanStatus = `Capital limit reached ($${capitalCommitted.toFixed(0)}/$${maxCapital} deployed)`;
      return;
    }

    // Track skip reasons for scan status
    const skipCounts: Record<string, number> = {};
    let marketsScanned = 0;
    let entered = 0;

    for (const market of this.marketCache) {
      if (this.custom.activeWindows.length >= params.max_concurrent_windows) break;
      if (activeConditions.has(market.conditionId)) continue;

      const sym = extractCryptoSymbol(market.title);
      if (!sym) continue;

      const endMs = new Date(market.endDate).getTime();
      const windowDuration = parseWindowDurationMs(market.title);
      const windowOpenTime = endMs - windowDuration;
      const timeToEnd = endMs - now;

      if (now < windowOpenTime) continue;
      if (timeToEnd < params.stop_quoting_before_end_ms) continue;
      marketsScanned++;

      // Reference price observation
      const refKey = market.conditionId;
      const history = this.custom.priceHistory[sym] || [];
      const latestSnap = history.length > 0 ? history[history.length - 1] : null;

      if (!this.custom.windowRefPrices[refKey]) {
        if (!latestSnap) continue;
        this.custom.windowRefPrices[refKey] = { price: latestSnap.price, recordedAt: latestSnap.timestamp };
        skipCounts["observing"] = (skipCounts["observing"] || 0) + 1;
        continue;
      }

      const ref = this.custom.windowRefPrices[refKey];
      if (now - ref.recordedAt < params.observation_seconds * 1000) {
        skipCounts["observing"] = (skipCounts["observing"] || 0) + 1;
        continue;
      }

      // Book-aware entry gate: check both sides have liquidity and pair is viable
      const upBook = await this.getBookCached(ctx, market.upTokenId);
      const dnBook = await this.getBookCached(ctx, market.downTokenId);
      const upBestAsk = this.getBestAsk(upBook);
      const dnBestAsk = this.getBestAsk(dnBook);

      if (upBestAsk === null || dnBestAsk === null) {
        ctx.log(
          `SKIP: ${market.title.slice(0, 35)} no asks (up=${upBestAsk} dn=${dnBestAsk})`,
          { level: "signal", symbol: sym, phase: "entry" }
        );
        skipCounts["no liquidity"] = (skipCounts["no liquidity"] || 0) + 1;
        continue;
      }

      // Compute signal for mode selection
      const currentSnap = await fetchSpotPrice(sym);
      if (!currentSnap) continue;
      const signal = computeSignal(
        sym, ref.price, currentSnap.price, now - ref.recordedAt,
        history.filter((s) => s.timestamp >= ref.recordedAt)
      );

      const assetWR = this.custom.adaptive.perAssetWinRate[sym];
      const mode = selectMode(signal, windowDuration, params, assetWR);

      // Sniper-specific entry gates
      if (mode === "sniper") {
        // Volatility favorability gate
        const favorability = computeSniperFavorability(history);
        if (favorability.regime === "trending") {
          ctx.log(
            `SKIP: ${market.title.slice(0, 35)} trending (fav=${favorability.score.toFixed(2)} chop=${favorability.choppiness.toFixed(2)})`,
            { level: "signal", symbol: sym, phase: "entry" }
          );
          skipCounts["trending"] = (skipCounts["trending"] || 0) + 1;
          continue;
        }

        // Pair confidence gate
        const askImbalance = Math.abs(upBestAsk - dnBestAsk);
        const askBalance = 1.0 - askImbalance;
        const timeRatio = timeToEnd / windowDuration;
        const timeScore = Math.min(1.0, timeRatio / 0.5);
        const favorabilityBonus = favorability.regime === "oscillating" ? 0.10 : favorability.regime === "calm" ? -0.10 : 0;
        const pairConfidence = askBalance * timeScore + favorabilityBonus;

        if (pairConfidence < params.min_pair_confidence) {
          ctx.log(
            `SKIP: ${market.title.slice(0, 35)} low confidence=${pairConfidence.toFixed(2)} (askBal=${askBalance.toFixed(2)} asks=${upBestAsk.toFixed(2)}/${dnBestAsk.toFixed(2)})`,
            { level: "signal", symbol: sym, phase: "entry" }
          );
          skipCounts["lopsided asks"] = (skipCounts["lopsided asks"] || 0) + 1;
          continue;
        }

        // Projected pair cost check
        const projectedPairCost = (upBestAsk - params.bid_offset) + (dnBestAsk - params.bid_offset);
        if (projectedPairCost > params.max_pair_cost + 0.02) {
          ctx.log(
            `SKIP: ${market.title.slice(0, 35)} pair too expensive: projected=${projectedPairCost.toFixed(2)}`,
            { level: "signal", symbol: sym, phase: "entry" }
          );
          skipCounts["too expensive"] = (skipCounts["too expensive"] || 0) + 1;
          continue;
        }
      }

      // Liquidity-based bid sizing
      const windowDurationMin = windowDuration / 60_000;
      const durBucket = durationBucket(market.title);
      const fillBucket = resolveFillBucket(this.custom.liquidity, sym, durBucket, mode, params.min_bucket_samples);
      let bidSize = computeOptimalBidSize(fillBucket, params, windowDurationMin, mode);

      // Capital lock: estimate cost for both sides, hard-capped by config.max_capital_usd
      const entryPairCost = mode === "sniper" ? params.max_pair_cost : params.maker_max_pair_cost;

      // Cap bid size to fit within remaining capital (max_capital_usd minus capital at risk)
      const currentAtRisk = this.custom.activeWindows.reduce(
        (sum, w) => sum + Math.max(0, w.upInventory - w.downInventory) * w.upAvgCost + Math.max(0, w.downInventory - w.upInventory) * w.downAvgCost, 0
      );
      const currentAvailable = maxCapital - currentAtRisk;
      const maxBidByCapital = Math.floor(currentAvailable / entryPairCost);
      if (maxBidByCapital < params.min_bid_size) continue;
      bidSize = Math.min(bidSize, maxBidByCapital);

      const estCostPerSide = (entryPairCost / 2) * bidSize;
      const lockedCapital = estCostPerSide * 2;

      const convictionSide = mode === "maker" && signal.signalStrength >= params.min_signal_strength
        ? signal.direction : null;

      const window: UnifiedWindowPosition = {
        market, cryptoSymbol: sym,
        windowOpenTime, windowEndTime: endMs,
        priceAtWindowOpen: ref.price,
        upBidOrderId: null, upBidPrice: 0, upBidSize: 0,
        downBidOrderId: null, downBidPrice: 0, downBidSize: 0,
        upInventory: 0, upAvgCost: 0,
        downInventory: 0, downAvgCost: 0,
        fillCount: 0, sellCount: 0,
        realizedSellPnl: 0, totalBuyCost: 0,
        enteredAt: now,
        mode, bidSize, lockedCapital,
        // Maker fields
        lastSignalDirection: convictionSide,
        lastQuotedAt: 0,
        lastQuotedPriceChangePct: signal.priceChangePct,
        confirmedDirection: convictionSide,
        flipCount: 0, lastDirectionChangeAt: now,
        convictionSide,
        signalStrengthAtEntry: signal.signalStrength,
        // Sniper fields
        unmatchedTicks: 0,
        lastUpBestAsk: 0, lastDnBestAsk: 0,
        processedFillIds: [],
        rebalanceSold: false,
        // Deferred upgrade
        ticksInWindow: 0,
        upgradedFromSniper: false,
        tickAction: `${mode} → entered`,
      };

      this.custom.activeWindows.push(window);
      activeConditions.add(market.conditionId);
      entered++;

      ctx.log(
        `ENTERED [${mode.toUpperCase()}]: ${market.title.slice(0, 35)} ${sym} bidSize=${bidSize} locked=$${lockedCapital.toFixed(2)} str=${(signal.signalStrength * 100).toFixed(0)}%`,
        { level: "signal", symbol: sym, phase: "entry", signalStrength: signal.signalStrength }
      );
    }

    // Update scan status for UI
    if (this.custom.activeWindows.length > 0) {
      const matched = this.custom.activeWindows.reduce(
        (sum, w) => sum + Math.min(w.upInventory, w.downInventory), 0
      );
      const totalInv = this.custom.activeWindows.reduce(
        (sum, w) => sum + w.upInventory + w.downInventory, 0
      );
      this.custom.scanStatus = totalInv > 0
        ? `${this.custom.activeWindows.length} windows active, ${matched} pairs matched`
        : `${this.custom.activeWindows.length} windows active, waiting for fills`;
    } else if (marketsScanned === 0) {
      this.custom.scanStatus = this.marketCache.length > 0
        ? "No open windows in available markets"
        : "Discovering markets…";
    } else if (entered > 0) {
      this.custom.scanStatus = `Entered ${entered} window${entered > 1 ? "s" : ""}`;
    } else {
      const reasons = Object.entries(skipCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${count} ${reason}`)
        .join(", ");
      this.custom.scanStatus = `Scanned ${marketsScanned} markets: ${reasons}`;
    }
  }

  // ── Manage windows ─────────────────────────────────────────────────

  private async manageWindows(ctx: StrategyContext, params: UnifiedParams): Promise<void> {
    const now = Date.now();

    for (const w of this.custom.activeWindows) {
      const timeToEnd = w.windowEndTime - now;
      const windowDurationMs = w.windowEndTime - w.windowOpenTime;

      if (now > w.windowEndTime + 30_000) {
        w.tickAction = "Awaiting resolution";
        continue;
      }

      const stopQuotingMs = Math.min(params.stop_quoting_before_end_ms, windowDurationMs * 0.05);
      const exitMs = Math.min(params.exit_inventory_before_end_ms, windowDurationMs * 0.017);

      // Exit phase
      if (timeToEnd < exitMs) {
        if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) await this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; } }
        if (w.downBidOrderId) { const r = await safeCancelOrder(ctx.api, w.downBidOrderId); if (r.cleared) { if (r.fill) await this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; } }
        if (w.mode === "sniper") {
          // Real mode: hold to resolution. Paper mode: sell excess.
          if (ctx.config.mode !== "real") await this.sniperSellExcess(ctx, w, params, "EXIT");
        } else {
          await this.makerSellLosing(ctx, w, params, "DUMP");
        }
        w.tickAction = `Exiting: sell excess before close`;
        continue;
      }

      // Wind-down phase
      if (timeToEnd < stopQuotingMs) {
        if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) await this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; } }
        if (w.downBidOrderId) { const r = await safeCancelOrder(ctx.api, w.downBidOrderId); if (r.cleared) { if (r.fill) await this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; } }
        if (w.mode === "sniper") {
          if (ctx.config.mode !== "real") await this.sniperSellExcess(ctx, w, params, "WIND DOWN");
        } else {
          await this.makerSellLosing(ctx, w, params, "WIND DOWN");
        }
        {
          const up = w.upInventory, dn = w.downInventory;
          const pc = (up > 0 && dn > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
          w.tickAction = `Stop: holding ${up}↑/${dn}↓${pc}`;
        }
        continue;
      }

      // Compute signal
      const currentSnap = await fetchSpotPrice(w.cryptoSymbol);
      if (!currentSnap) continue;

      const history = this.custom.priceHistory[w.cryptoSymbol] || [];
      const signalOpts: ComputeSignalOptions = { prevDirection: w.confirmedDirection };
      if (params.dead_zone_pct > 0) signalOpts.deadZonePct = params.dead_zone_pct;
      const signal = computeSignal(
        w.cryptoSymbol, w.priceAtWindowOpen, currentSnap.price,
        now - w.windowOpenTime,
        history.filter((s) => s.timestamp >= w.windowOpenTime),
        signalOpts
      );

      w.ticksInWindow++;

      // Check fills (always — even when paused, fills on resting orders need processing)
      if (w.mode === "sniper") {
        await this.sniperCheckFills(ctx, w, params, signal);
        await this.sniperRebalance(ctx, w, params);
      } else {
        await this.makerCheckFills(ctx, w, params, signal);
      }

      // Sniper poison check: after rebalance sell, stop all quoting
      if (w.mode === "sniper" && w.rebalanceSold) {
        if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
        if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
        w.tickAction = "Poisoned: market too one-sided";
        continue;
      }

      // Deferred upgrade: sniper → maker when signal is strong enough
      const assetWR = this.custom.adaptive.perAssetWinRate[w.cryptoSymbol];
      const makerWRPoor = assetWR && assetWR.maker.total >= 5
        && (assetWR.maker.wins / assetWR.maker.total) < 0.4;
      if (w.mode === "sniper" && !w.upgradedFromSniper
          && w.ticksInWindow >= params.upgrade_after_ticks
          && signal.signalStrength >= params.upgrade_signal_threshold
          && signal.direction
          && windowDurationMs < 900_000
          && !makerWRPoor) {
        w.mode = "maker";
        w.upgradedFromSniper = true;
        w.confirmedDirection = signal.direction;
        w.convictionSide = signal.direction;
        w.lastSignalDirection = signal.direction;
        w.lastQuotedAt = 0;
        const newPairCost = params.maker_max_pair_cost;
        w.lockedCapital = (newPairCost / 2) * w.bidSize * 2;
        ctx.log(
          `UPGRADE sniper→maker: ${w.market.title.slice(0, 35)} ${w.cryptoSymbol} str=${(signal.signalStrength * 100).toFixed(0)}% dir=${signal.direction} tick=${w.ticksInWindow}`,
          { level: "signal", symbol: w.cryptoSymbol, phase: "upgrade", signalStrength: signal.signalStrength, direction: signal.direction }
        );
      }

      // Sniper: mid-window favorability check
      if (w.mode === "sniper") {
        const windowHistory = history.filter((s) => s.timestamp >= w.windowOpenTime);
        const favorability = computeSniperFavorability(windowHistory, w.windowOpenTime);

        if (favorability.regime === "trending") {
          if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }
          if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }
          w.tickAction = `Paused: trending (chop=${favorability.choppiness.toFixed(2)})`;
          if (ctx.state.ticks % 10 === 0) {
            ctx.log(
              `PAUSED: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} trending (chop=${favorability.choppiness.toFixed(2)}) inv=${w.upInventory}/${w.downInventory}`,
              { level: "signal", symbol: w.cryptoSymbol, phase: "manage" }
            );
          }
        } else {
          await this.sniperUpdateQuotes(ctx, w, params, signal);
        }

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
      } else {
        // Maker mode
        await this.makerUpdateQuotes(ctx, w, params, signal);

        // Per-tick heavy-side cancellation (maker)
        const effBidSize = Math.max(params.min_bid_size, Math.round(w.bidSize * Math.min(1.0, (windowDurationMs / 60_000) / 15)));
        const maxInvR = params.max_inventory_ratio;
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
    }
  }

  // ── Sniper fill checking ───────────────────────────────────────────

  private async sniperCheckFills(
    ctx: StrategyContext, w: UnifiedWindowPosition, params: UnifiedParams, _signal: WindowSignal
  ): Promise<void> {
    if (ctx.config.mode === "real") {
      await this.sniperCheckFillsReal(ctx, w);
      return;
    }
    // Paper mode: unified fill detection via PaperStrategyAPI
    if (w.upBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.upBidOrderId);
      if (status.status === "MATCHED") {
        const costBasis = status.price;
        const filledSize = status.size_matched;
        if (w.upInventory > 0) {
          const tc = w.upAvgCost * w.upInventory + costBasis * filledSize;
          w.upInventory += filledSize; w.upAvgCost = tc / w.upInventory;
        } else { w.upInventory = filledSize; w.upAvgCost = costBasis; }
        w.fillCount++;
        w.totalBuyCost += costBasis * filledSize;
        ctx.log(`FILL UP [sniper]: ${w.market.title.slice(0, 25)} ${filledSize}@${costBasis.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`);
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        ).bind(`ua-sup-${crypto.randomUUID()}`, ctx.config.id, w.market.upTokenId, w.market.slug, `${w.market.title} [UA SNIPER UP]`, costBasis, filledSize, calcFeePerShare(costBasis, params.fee_params) * filledSize).run();
        w.upBidOrderId = null;
      } else if (status.status === "CANCELLED") { w.upBidOrderId = null; }
    }
    if (w.downBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.downBidOrderId);
      if (status.status === "MATCHED") {
        const costBasis = status.price;
        const filledSize = status.size_matched;
        if (w.downInventory > 0) {
          const tc = w.downAvgCost * w.downInventory + costBasis * filledSize;
          w.downInventory += filledSize; w.downAvgCost = tc / w.downInventory;
        } else { w.downInventory = filledSize; w.downAvgCost = costBasis; }
        w.fillCount++;
        w.totalBuyCost += costBasis * filledSize;
        ctx.log(`FILL DN [sniper]: ${w.market.title.slice(0, 25)} ${filledSize}@${costBasis.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`);
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        ).bind(`ua-sdn-${crypto.randomUUID()}`, ctx.config.id, w.market.downTokenId, w.market.slug, `${w.market.title} [UA SNIPER DN]`, costBasis, filledSize, calcFeePerShare(costBasis, params.fee_params) * filledSize).run();
        w.downBidOrderId = null;
      } else if (status.status === "CANCELLED") { w.downBidOrderId = null; }
    }
  }

  private findActivityMatch(
    activity: ActivityTrade[],
    tokenId: string,
    side: "BUY" | "SELL",
    expectedSize: number,
    processedIds: string[]
  ): ActivityTrade | null {
    for (const trade of activity) {
      if (trade.asset !== tokenId) continue;
      if (trade.side !== side) continue;
      if (processedIds.includes(trade.id)) continue;
      if (Math.abs(trade.size - expectedSize) / expectedSize > 0.2) continue;
      return trade;
    }
    return null;
  }

  private async sniperCheckFillsReal(
    ctx: StrategyContext, w: UnifiedWindowPosition
  ): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as UnifiedParams;
    let activity: ActivityTrade[] | null = null;
    const fetchActivity = async (): Promise<ActivityTrade[]> => {
      if (activity === null) activity = await ctx.api.getActivity(50);
      return activity;
    };

    // Check UP bid
    if (w.upBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.upBidOrderId);
      if (status.status === "MATCHED") {
        const filledSize = status.size_matched || w.upBidSize;
        const trades = await fetchActivity();
        const match = this.findActivityMatch(trades, w.market.upTokenId, "BUY", filledSize, w.processedFillIds);

        if (match) {
          w.processedFillIds.push(match.id);
          const costBasis = match.price;
          const actualSize = match.size;
          if (w.upInventory > 0) {
            const tc = w.upAvgCost * w.upInventory + costBasis * actualSize;
            w.upInventory += actualSize;
            w.upAvgCost = tc / w.upInventory;
          } else { w.upInventory = actualSize; w.upAvgCost = costBasis; }
          w.fillCount++;
          w.totalBuyCost += costBasis * actualSize;
          ctx.log(`REAL FILL UP [sniper]: ${w.market.title.slice(0, 25)} ${actualSize}@${costBasis.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`);
          await ctx.db.prepare(
            `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
             VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
          ).bind(`ua-sup-${crypto.randomUUID()}`, ctx.config.id, w.market.upTokenId, w.market.slug, `${w.market.title} [UA SNIPER UP]`, costBasis, actualSize, calcFeePerShare(costBasis, params.fee_params) * actualSize).run();
        }
        if (!(status.size_matched > 0 && status.size_matched < status.original_size)) {
          w.upBidOrderId = null;
        }
      } else if (status.status === "CANCELLED") {
        w.upBidOrderId = null;
      }
    }

    // Check DOWN bid
    if (w.downBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.downBidOrderId);
      if (status.status === "MATCHED") {
        const filledSize = status.size_matched || w.downBidSize;
        const trades = await fetchActivity();
        const match = this.findActivityMatch(trades, w.market.downTokenId, "BUY", filledSize, w.processedFillIds);

        if (match) {
          w.processedFillIds.push(match.id);
          const costBasis = match.price;
          const actualSize = match.size;
          if (w.downInventory > 0) {
            const tc = w.downAvgCost * w.downInventory + costBasis * actualSize;
            w.downInventory += actualSize;
            w.downAvgCost = tc / w.downInventory;
          } else { w.downInventory = actualSize; w.downAvgCost = costBasis; }
          w.fillCount++;
          w.totalBuyCost += costBasis * actualSize;
          ctx.log(`REAL FILL DN [sniper]: ${w.market.title.slice(0, 25)} ${actualSize}@${costBasis.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`);
          await ctx.db.prepare(
            `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
             VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
          ).bind(`ua-sdn-${crypto.randomUUID()}`, ctx.config.id, w.market.downTokenId, w.market.slug, `${w.market.title} [UA SNIPER DN]`, costBasis, actualSize, calcFeePerShare(costBasis, params.fee_params) * actualSize).run();
        }
        if (!(status.size_matched > 0 && status.size_matched < status.original_size)) {
          w.downBidOrderId = null;
        }
      } else if (status.status === "CANCELLED") {
        w.downBidOrderId = null;
      }
    }
  }

  /** Record a fill detected during safeCancelOrder (mode-agnostic) */
  private async recordFillFromCancel(
    ctx: StrategyContext, w: UnifiedWindowPosition,
    side: "UP" | "DOWN", size: number, price: number
  ): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as UnifiedParams;
    if (side === "UP") {
      if (w.upInventory > 0) {
        const tc = w.upAvgCost * w.upInventory + price * size;
        w.upInventory += size; w.upAvgCost = tc / w.upInventory;
      } else { w.upInventory = size; w.upAvgCost = price; }
    } else {
      if (w.downInventory > 0) {
        const tc = w.downAvgCost * w.downInventory + price * size;
        w.downInventory += size; w.downAvgCost = tc / w.downInventory;
      } else { w.downInventory = size; w.downAvgCost = price; }
    }
    w.fillCount++;
    w.totalBuyCost += price * size;
    const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
    const tag = w.mode === "sniper" ? "SNIPER" : "MAKER";
    ctx.log(`FILL ${side} [${w.mode} cancel]: ${w.market.title.slice(0, 25)} ${size}@${price.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`);
    await ctx.db.prepare(
      `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
       VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
    ).bind(`ua-cancel-${crypto.randomUUID()}`, ctx.config.id, tokenId, w.market.slug, `${w.market.title} [UA ${tag} ${side}]`, price, size, calcFeePerShare(price, params.fee_params) * size).run();
  }

  // ── Sniper rebalance ───────────────────────────────────────────────

  private async sniperRebalance(
    ctx: StrategyContext, w: UnifiedWindowPosition, params: UnifiedParams
  ): Promise<void> {
    if (w.rebalanceSold) return; // Already poisoned — don't retry

    const { upInventory, downInventory } = w;
    if (upInventory === 0 && downInventory === 0) { w.unmatchedTicks = 0; return; }

    const maxRatio = params.max_unmatched_ratio;
    const minSide = Math.min(upInventory, downInventory);
    const maxSide = Math.max(upInventory, downInventory);

    if (minSide > 0 && maxSide / minSide <= maxRatio) { w.unmatchedTicks = 0; return; }
    w.unmatchedTicks++;
    if (w.unmatchedTicks < params.sell_unmatched_after_ticks) return;

    const heavySide = upInventory > downInventory ? "UP" : "DOWN";
    const targetHeavy = Math.max(
      minSide > 0 ? Math.ceil(minSide * maxRatio) : 0,
      0 // sell ALL excess when fully one-sided
    );
    const excess = maxSide - targetHeavy;
    if (excess < 5) return; // CLOB minimum order size is 5

    const tokenId = heavySide === "UP" ? w.market.upTokenId : w.market.downTokenId;
    const book = await this.getBookCached(ctx, tokenId);
    const bestBid = this.getBestBid(book);
    const sellPrice = bestBid !== null ? bestBid * 0.97 : 0.48;
    const avgCost = heavySide === "UP" ? w.upAvgCost : w.downAvgCost;

    if (ctx.config.mode === "real") {
      const result = await ctx.api.placeOrder({
        token_id: tokenId,
        side: "SELL",
        size: excess,
        price: sellPrice,
        market: w.market.slug,
        title: `${w.market.title} [UA REBAL SELL ${heavySide}]`,
      });

      if (result.status === "placed") {
        const sellPnl = (sellPrice - avgCost) * excess;
        if (heavySide === "UP") w.upInventory -= excess;
        else w.downInventory -= excess;
        w.realizedSellPnl += sellPnl;
        w.sellCount++;
        w.unmatchedTicks = 0;
        w.rebalanceSold = true;
        ctx.log(
          `REAL SELL ${heavySide} [sniper]: ${w.market.title.slice(0, 25)} ${excess}@${sellPrice.toFixed(3)} pnl=${sellPnl >= 0 ? "+" : ""}${sellPnl.toFixed(2)} inv=${w.upInventory}/${w.downInventory}`,
          { level: "signal", symbol: w.cryptoSymbol, phase: "rebalance" }
        );
        const sellFee = calcFeePerShare(sellPrice, params.fee_params) * excess;
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
        ).bind(`ua-srebal-${crypto.randomUUID()}`, ctx.config.id, tokenId, w.market.slug, `${w.market.title} [UA REBAL ${heavySide}]`, sellPrice, excess, sellFee, sellPnl).run();
      } else {
        ctx.log(
          `SELL FAILED ${heavySide} [sniper]: ${w.market.title.slice(0, 25)} ${excess}@${sellPrice.toFixed(3)} error=${result.error || "unknown"}`,
          { level: "signal", symbol: w.cryptoSymbol, phase: "rebalance" }
        );
        w.rebalanceSold = true; // Stop retrying
      }
    } else {
      // Paper mode
      const sellPnl = (sellPrice - avgCost) * excess;
      if (heavySide === "UP") w.upInventory -= excess;
      else w.downInventory -= excess;
      w.realizedSellPnl += sellPnl;
      w.sellCount++;
      w.unmatchedTicks = 0;
      w.rebalanceSold = true;

      ctx.log(
        `REBAL ${heavySide} [sniper]: ${w.market.title.slice(0, 25)} ${excess}@${sellPrice.toFixed(3)} cost=${avgCost.toFixed(3)} pnl=${sellPnl >= 0 ? "+" : ""}${sellPnl.toFixed(2)} inv=${w.upInventory}/${w.downInventory}`,
        { level: "signal", symbol: w.cryptoSymbol, phase: "rebalance" }
      );
      const sellFee = calcFeePerShare(sellPrice, params.fee_params) * excess;
      await ctx.db.prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
      ).bind(`ua-srebal-${crypto.randomUUID()}`, ctx.config.id, tokenId, w.market.slug, `${w.market.title} [UA REBAL ${heavySide}]`, sellPrice, excess, sellFee, sellPnl).run();
    }
  }

  // ── Sniper sell excess (wind-down/exit — paper mode only) ────────────

  private async sniperSellExcess(
    ctx: StrategyContext, w: UnifiedWindowPosition, params: UnifiedParams, label: string
  ): Promise<void> {
    const { upInventory, downInventory } = w;
    if (upInventory === 0 && downInventory === 0) return;
    const matched = Math.min(upInventory, downInventory);
    const excessUp = upInventory - matched;
    const excessDn = downInventory - matched;

    if (excessUp > 0) {
      const upBook = await this.getBookCached(ctx, w.market.upTokenId);
      const upBestBid = this.getBestBid(upBook);
      const sellPrice = upBestBid !== null ? upBestBid * 0.97 : 0.48;
      const pnl = (sellPrice - w.upAvgCost) * excessUp;
      w.upInventory -= excessUp;
      w.realizedSellPnl += pnl;
      w.sellCount++;
      ctx.log(`${label} UP [sniper]: ${w.market.title.slice(0, 25)} ${excessUp}@${sellPrice.toFixed(3)} pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
      await ctx.db.prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, 0, datetime('now'), ?)`
      ).bind(`ua-ssell-${crypto.randomUUID()}`, ctx.config.id, w.market.upTokenId, w.market.slug, `${w.market.title} [UA ${label} UP]`, sellPrice, excessUp, pnl).run();
    }

    if (excessDn > 0) {
      const dnBook = await this.getBookCached(ctx, w.market.downTokenId);
      const dnBestBid = this.getBestBid(dnBook);
      const sellPrice = dnBestBid !== null ? dnBestBid * 0.97 : 0.48;
      const pnl = (sellPrice - w.downAvgCost) * excessDn;
      w.downInventory -= excessDn;
      w.realizedSellPnl += pnl;
      w.sellCount++;
      ctx.log(`${label} DN [sniper]: ${w.market.title.slice(0, 25)} ${excessDn}@${sellPrice.toFixed(3)} pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
      await ctx.db.prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, 0, datetime('now'), ?)`
      ).bind(`ua-ssell-${crypto.randomUUID()}`, ctx.config.id, w.market.downTokenId, w.market.slug, `${w.market.title} [UA ${label} DN]`, sellPrice, excessDn, pnl).run();
    }
  }

  // ── Sniper quote updates ───────────────────────────────────────────

  private async computeBookAwareBids(
    ctx: StrategyContext, w: UnifiedWindowPosition, params: UnifiedParams
  ): Promise<{ upBid: number; dnBid: number }> {
    const upBook = await this.getBookCached(ctx, w.market.upTokenId);
    const dnBook = await this.getBookCached(ctx, w.market.downTokenId);
    const upBestAsk = this.getBestAsk(upBook);
    const dnBestAsk = this.getBestAsk(dnBook);

    if (upBestAsk !== null) w.lastUpBestAsk = upBestAsk;
    if (dnBestAsk !== null) w.lastDnBestAsk = dnBestAsk;

    const upAsk = upBestAsk ?? 0.50;
    const dnAsk = dnBestAsk ?? 0.50;

    let upBid = upAsk - params.bid_offset;
    let dnBid = dnAsk - params.bid_offset;

    if (w.downInventory > 0) upBid = Math.min(upBid, params.max_pair_cost - w.downAvgCost);
    if (w.upInventory > 0) dnBid = Math.min(dnBid, params.max_pair_cost - w.upAvgCost);

    if (upBid + dnBid > params.max_pair_cost) {
      const scale = params.max_pair_cost / (upBid + dnBid);
      upBid *= scale; dnBid *= scale;
    }

    upBid = Math.max(0.01, upBid);
    dnBid = Math.max(0.01, dnBid);

    return { upBid, dnBid };
  }

  private async sniperUpdateQuotes(
    ctx: StrategyContext, w: UnifiedWindowPosition, params: UnifiedParams, signal: WindowSignal
  ): Promise<void> {
    // Per-window capital check: total deployed in this window
    const windowCapital = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
    if (windowCapital > w.lockedCapital * 1.5) {
      w.tickAction = `Window capital limit`;
      return;
    }

    // Total deployed capital + pending bids (worst case if all fill)
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
    if (capitalCommitted > ctx.config.max_capital_usd) {
      w.tickAction = `Capital limit: $${capitalCommitted.toFixed(0)}/$${ctx.config.max_capital_usd}`;
      return;
    }

    // Duration-scaled bid size (same formula as maker path)
    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const sniperDurationScale = Math.min(1.0, (wDurMs / 60_000) / 15);
    const effectiveBidSize = Math.max(params.min_bid_size, Math.round(w.bidSize * sniperDurationScale));

    let upBidSize = effectiveBidSize;
    let downBidSize = effectiveBidSize;

    // Strict inventory balance: never let either side get more than one bid ahead
    const excess = w.upInventory - w.downInventory;
    if (excess > 0) upBidSize = 0;
    if (excess < 0) downBidSize = 0;

    // Book-aware pricing
    const { upBid: computedUpBid, dnBid: computedDnBid } =
      await this.computeBookAwareBids(ctx, w, params);
    let upBid = computedUpBid;
    let dnBid = computedDnBid;

    // Ask imbalance gate: stop the expensive (likely loser) side, keep bidding the cheap side
    if (w.lastUpBestAsk > 0 && w.lastDnBestAsk > 0) {
      const askImbalance = Math.abs(w.lastUpBestAsk - w.lastDnBestAsk);
      if (askImbalance > 0.15) {
        // Higher ask = more expensive = likely loser → stop that side
        if (w.lastUpBestAsk > w.lastDnBestAsk) upBidSize = 0;
        else downBidSize = 0;
      }
    }

    // Skip bids too low or that would cross the spread
    if (upBid < 0.02) upBidSize = 0;
    if (dnBid < 0.02) downBidSize = 0;
    if (w.lastUpBestAsk > 0 && upBid >= w.lastUpBestAsk) upBidSize = 0;
    if (w.lastDnBestAsk > 0 && dnBid >= w.lastDnBestAsk) downBidSize = 0;

    // Place UP bid
    if (upBidSize > 0) {
      if (w.upBidOrderId && Math.abs(w.upBidPrice - upBid) > 0.005) {
        const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
        if (r.cleared) { if (r.fill) await this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; }
      }
      if (!w.upBidOrderId) {
        const result = await ctx.api.placeOrder({ token_id: w.market.upTokenId, side: "BUY", price: upBid, size: upBidSize });
        if (result.status === "placed") { w.upBidOrderId = result.order_id; w.upBidPrice = upBid; w.upBidSize = upBidSize; }
      }
    } else if (w.upBidOrderId) { await ctx.api.cancelOrder(w.upBidOrderId); w.upBidOrderId = null; }

    // Place DN bid
    if (downBidSize > 0) {
      if (w.downBidOrderId && Math.abs(w.downBidPrice - dnBid) > 0.005) {
        const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
        if (r.cleared) { if (r.fill) await this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; }
      }
      if (!w.downBidOrderId) {
        const result = await ctx.api.placeOrder({ token_id: w.market.downTokenId, side: "BUY", price: dnBid, size: downBidSize });
        if (result.status === "placed") { w.downBidOrderId = result.order_id; w.downBidPrice = dnBid; w.downBidSize = downBidSize; }
      }
    } else if (w.downBidOrderId) { await ctx.api.cancelOrder(w.downBidOrderId); w.downBidOrderId = null; }

    // Periodic log
    if (ctx.state.ticks % 5 === 0 && (w.upInventory > 0 || w.downInventory > 0)) {
      const pairCost = w.upInventory > 0 && w.downInventory > 0 ? w.upAvgCost + w.downAvgCost : 0;
      const matched = Math.min(w.upInventory, w.downInventory);
      ctx.log(
        `SNIPER: ${w.market.title.slice(0, 25)} inv=${w.upInventory}/${w.downInventory} matched=${matched} pairCost=${pairCost.toFixed(3)} asks=${w.lastUpBestAsk.toFixed(2)}/${w.lastDnBestAsk.toFixed(2)} bids=${upBid.toFixed(3)}/${dnBid.toFixed(3)}`,
        { level: "signal", symbol: w.cryptoSymbol, signalStrength: signal.signalStrength, upInventory: w.upInventory, downInventory: w.downInventory, phase: "manage" }
      );
    }

    // Set tickAction
    {
      const up = w.upInventory, dn = w.downInventory;
      const pc = (up > 0 && dn > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
      const upB = w.upBidOrderId ? `▲${w.upBidPrice.toFixed(2)}` : "";
      const dnB = w.downBidOrderId ? `▼${w.downBidPrice.toFixed(2)}` : "";
      const bids = [upB, dnB].filter(Boolean).join(" ");
      w.tickAction = bids ? `bid ${bids}${pc} inv=${up}/${dn}` : `no bids${pc} inv=${up}/${dn}`;
    }
  }

  // ── Maker fill checking ────────────────────────────────────────────

  /** Maker fill checking — unified via StrategyAPI (works paper + real). */
  private async makerCheckFills(
    ctx: StrategyContext, w: UnifiedWindowPosition, params: UnifiedParams, _signal: WindowSignal
  ): Promise<void> {
    // UP fill
    if (w.upBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.upBidOrderId);
      if (status.status === "MATCHED") {
        const costBasis = status.price;
        const filledSize = status.size_matched;
        if (w.upInventory > 0) {
          const tc = w.upAvgCost * w.upInventory + costBasis * filledSize;
          w.upInventory += filledSize; w.upAvgCost = tc / w.upInventory;
        } else { w.upInventory = filledSize; w.upAvgCost = costBasis; }
        w.fillCount++;
        w.totalBuyCost += costBasis * filledSize;
        ctx.log(`FILL UP [maker]: ${w.market.title.slice(0, 25)} ${filledSize}@${costBasis.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`);
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        ).bind(`ua-mup-${crypto.randomUUID()}`, ctx.config.id, w.market.upTokenId, w.market.slug, `${w.market.title} [UA MAKER UP]`, costBasis, filledSize, calcFeePerShare(costBasis, params.fee_params) * filledSize).run();
        w.upBidOrderId = null;
      } else if (status.status === "CANCELLED") { w.upBidOrderId = null; }
    }
    // DN fill
    if (w.downBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.downBidOrderId);
      if (status.status === "MATCHED") {
        const costBasis = status.price;
        const filledSize = status.size_matched;
        if (w.downInventory > 0) {
          const tc = w.downAvgCost * w.downInventory + costBasis * filledSize;
          w.downInventory += filledSize; w.downAvgCost = tc / w.downInventory;
        } else { w.downInventory = filledSize; w.downAvgCost = costBasis; }
        w.fillCount++;
        w.totalBuyCost += costBasis * filledSize;
        ctx.log(`FILL DN [maker]: ${w.market.title.slice(0, 25)} ${filledSize}@${costBasis.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`);
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        ).bind(`ua-mdn-${crypto.randomUUID()}`, ctx.config.id, w.market.downTokenId, w.market.slug, `${w.market.title} [UA MAKER DN]`, costBasis, filledSize, calcFeePerShare(costBasis, params.fee_params) * filledSize).run();
        w.downBidOrderId = null;
      } else if (status.status === "CANCELLED") { w.downBidOrderId = null; }
    }
  }

  // ── Maker quote updates ────────────────────────────────────────────

  private async makerUpdateQuotes(
    ctx: StrategyContext, w: UnifiedWindowPosition, params: UnifiedParams, signal: WindowSignal
  ): Promise<void> {
    // Total deployed capital + pending bids (worst case if all fill)
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
    if (capitalCommitted > ctx.config.max_capital_usd) {
      w.tickAction = `Capital limit: $${capitalCommitted.toFixed(0)}/$${ctx.config.max_capital_usd}`;
      return;
    }

    const now = Date.now();
    const pairCost = params.maker_max_pair_cost;

    // Detect confirmed direction flip
    const confirmedFlip = w.confirmedDirection !== null && signal.direction !== w.confirmedDirection && !signal.inDeadZone;
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

    // Periodic signal log
    if (ctx.state.ticks % 5 === 0) {
      const dirSign = signal.direction === "UP" ? 1 : -1;
      const fairUp = 0.50 + signal.signalStrength * 0.20 * dirSign;
      const fairDown = 1.0 - fairUp;
      ctx.log(
        `MAKER: ${w.market.title.slice(0, 25)} ${signal.direction} str=${(signal.signalStrength * 100).toFixed(0)}% fv=${fairUp.toFixed(2)}/${fairDown.toFixed(2)} UP=${w.upInventory} DN=${w.downInventory} flips=${w.flipCount} bidSize=${w.bidSize}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: signal.direction, signalStrength: signal.signalStrength, flipCount: w.flipCount, upInventory: w.upInventory, downInventory: w.downInventory, phase: "manage" }
      );
    }

    // Max flips: stop quoting
    if (w.flipCount > params.max_flips_per_window) {
      if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) await this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; } }
      if (w.downBidOrderId) { const r = await safeCancelOrder(ctx.api, w.downBidOrderId); if (r.cleared) { if (r.fill) await this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; } }
      w.tickAction = `Sat out: choppy (${w.flipCount} flips)`;
      return;
    }

    // Check if requote needed
    const directionChanged = confirmedFlip;
    const priceMoved = Math.abs(signal.priceChangePct - w.lastQuotedPriceChangePct) > params.requote_threshold_pct;
    if (!directionChanged && !priceMoved && w.lastQuotedAt !== 0) {
      const up = w.upInventory, dn = w.downInventory;
      const pc = (up > 0 && dn > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
      w.tickAction = `${signal.direction} ${(signal.signalStrength * 100).toFixed(0)}% → no requote${pc}`;
      return;
    }

    // Cancel existing bids (safe cancel to catch fills)
    if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) await this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; } }
    if (w.downBidOrderId) { const r = await safeCancelOrder(ctx.api, w.downBidOrderId); if (r.cleared) { if (r.fill) await this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; } }

    // On flip, sell losing side
    if (directionChanged && signal.signalStrength >= params.min_signal_strength) {
      await this.makerSellLosing(ctx, w, params, "FLIP SELL");
    }

    // Periodic rebalance
    if (!directionChanged && signal.signalStrength >= 0.5) {
      const losingSide = signal.direction === "UP" ? "DOWN" : "UP";
      const losingInv = losingSide === "UP" ? w.upInventory : w.downInventory;
      if (losingInv > 0) await this.makerSellLosing(ctx, w, params, "REBALANCE");
    }

    // Conviction-biased sizes
    const convictionSide = signal.signalStrength >= params.min_signal_strength ? signal.direction : null;
    const strengthRange = 1.0 - params.min_signal_strength;
    const strengthFraction = strengthRange > 0
      ? Math.min(1.0, (signal.signalStrength - params.min_signal_strength) / strengthRange) : 0;
    const scaledBias = 1.0 + (params.conviction_bias - 1.0) * strengthFraction;
    const adjustedBias = scaledBias * signal.confidenceMultiplier;

    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);
    const effectiveBaseSize = Math.max(params.min_bid_size, Math.round(w.bidSize * durationScale));
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
    const maxInvRatio = params.max_inventory_ratio;
    if (w.upInventory > 0 && w.downInventory > 0) {
      if (w.upInventory / w.downInventory > maxInvRatio) upBidSize = 0;
      if (w.downInventory / w.upInventory > maxInvRatio) downBidSize = 0;
    } else if (w.upInventory >= effectiveBaseSize && w.downInventory === 0) {
      upBidSize = 0;
    } else if (w.downInventory >= effectiveBaseSize && w.upInventory === 0) {
      downBidSize = 0;
    }

    // Capital-at-risk check: matched pairs are locked-in profit, only limit unmatched
    const makerMatched = Math.min(w.upInventory, w.downInventory);
    const makerUnmatchedCost = w.totalBuyCost - makerMatched;
    if (makerUnmatchedCost > w.lockedCapital * 1.5) {
      w.tickAction = `Window capital limit`;
      return;
    }

    // Signal-derived pricing
    const dirSign = signal.direction === "UP" ? 1 : -1;
    const fairUp = Math.max(0.05, Math.min(0.95, 0.50 + signal.signalStrength * 0.20 * dirSign));
    const fairDown = 1.0 - fairUp;

    const rawUpBid = Math.max(0.01, fairUp - params.maker_bid_offset);
    const rawDnBid = Math.max(0.01, fairDown - params.maker_bid_offset);

    let upBid = w.downInventory > 0 ? Math.min(rawUpBid, pairCost - w.downAvgCost) : rawUpBid;
    let dnBid = w.upInventory > 0 ? Math.min(rawDnBid, pairCost - w.upAvgCost) : rawDnBid;

    if (upBid + dnBid > pairCost) {
      const sc = pairCost / (upBid + dnBid);
      upBid *= sc; dnBid *= sc;
    }
    upBid = Math.max(0.01, upBid);
    dnBid = Math.max(0.01, dnBid);

    // Place UP bid
    if (upBidSize > 0) {
      const roundedBid = Math.floor(upBid * 100) / 100;
      const result = await ctx.api.placeOrder({
        token_id: w.market.upTokenId, side: "BUY", size: upBidSize, price: roundedBid,
        market: w.market.slug, title: `${w.market.title} [UA MAKER UP bid]`,
      });
      if (result.status === "placed") { w.upBidOrderId = result.order_id; w.upBidPrice = roundedBid; w.upBidSize = upBidSize; }
      else if (result.status === "filled") {
        const feeEquivalent = calcFeePerShare(result.price, params.fee_params) * result.size;
        const costBasis = result.price; // Maker fills have zero fee; track fee_equivalent separately for rebate pool
        if (w.upInventory > 0) {
          const tc = w.upAvgCost * w.upInventory + costBasis * result.size;
          w.upInventory += result.size; w.upAvgCost = tc / w.upInventory;
        } else { w.upInventory = result.size; w.upAvgCost = costBasis; }
        w.fillCount++; w.totalBuyCost += costBasis * result.size;
        ctx.log(
          `UA MAKER FILL UP (immediate): ${w.market.title.slice(0, 30)} ${result.size}@${result.price.toFixed(3)}`,
          { level: "trade", symbol: w.cryptoSymbol, direction: "UP", phase: "fill" }
        );
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        ).bind(
          `ua-up-imm-${crypto.randomUUID()}`, ctx.config.id, w.market.upTokenId, w.market.slug,
          `${w.market.title} [UA MAKER UP imm]`, costBasis, result.size, feeEquivalent
        ).run();
      }
    }

    // Place DN bid
    if (downBidSize > 0) {
      const roundedBid = Math.floor(dnBid * 100) / 100;
      const result = await ctx.api.placeOrder({
        token_id: w.market.downTokenId, side: "BUY", size: downBidSize, price: roundedBid,
        market: w.market.slug, title: `${w.market.title} [UA MAKER DN bid]`,
      });
      if (result.status === "placed") { w.downBidOrderId = result.order_id; w.downBidPrice = roundedBid; w.downBidSize = downBidSize; }
      else if (result.status === "filled") {
        const feeEquivalent = calcFeePerShare(result.price, params.fee_params) * result.size;
        const costBasis = result.price; // Maker fills have zero fee; track fee_equivalent separately for rebate pool
        if (w.downInventory > 0) {
          const tc = w.downAvgCost * w.downInventory + costBasis * result.size;
          w.downInventory += result.size; w.downAvgCost = tc / w.downInventory;
        } else { w.downInventory = result.size; w.downAvgCost = costBasis; }
        w.fillCount++; w.totalBuyCost += costBasis * result.size;
        ctx.log(
          `UA MAKER FILL DN (immediate): ${w.market.title.slice(0, 30)} ${result.size}@${result.price.toFixed(3)}`,
          { level: "trade", symbol: w.cryptoSymbol, direction: "DOWN", phase: "fill" }
        );
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        ).bind(
          `ua-dn-imm-${crypto.randomUUID()}`, ctx.config.id, w.market.downTokenId, w.market.slug,
          `${w.market.title} [UA MAKER DN imm]`, costBasis, result.size, feeEquivalent
        ).run();
      }
    }

    w.lastSignalDirection = signal.direction;
    w.lastQuotedAt = now;
    w.lastQuotedPriceChangePct = signal.priceChangePct;
    w.convictionSide = convictionSide;

    // Set tickAction
    {
      const up = w.upInventory, dn = w.downInventory;
      const pc = (up > 0 && dn > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
      const str = (signal.signalStrength * 100).toFixed(0);
      const upB = w.upBidOrderId ? `▲${w.upBidPrice.toFixed(2)}` : "";
      const dnB = w.downBidOrderId ? `▼${w.downBidPrice.toFixed(2)}` : "";
      const bids = [upB, dnB].filter(Boolean).join(" ");
      w.tickAction = `${directionChanged ? "FLIP→" : ""}${signal.direction} ${str}% → ${bids}${pc}`;
    }
  }

  // ── Maker sell losing inventory ────────────────────────────────────

  private async makerSellLosing(
    ctx: StrategyContext, w: UnifiedWindowPosition, params: UnifiedParams, label: string
  ): Promise<void> {
    const history = this.custom.priceHistory[w.cryptoSymbol] || [];
    const currentSnap = await fetchSpotPrice(w.cryptoSymbol);
    if (!currentSnap) return;

    const signal = computeSignal(
      w.cryptoSymbol, w.priceAtWindowOpen, currentSnap.price,
      Date.now() - w.enteredAt,
      history.filter((s) => s.timestamp >= w.enteredAt)
    );

    const losingSide = signal.direction === "UP" ? "DOWN" : "UP";
    const losingInv = losingSide === "UP" ? w.upInventory : w.downInventory;
    const losingAvgCost = losingSide === "UP" ? w.upAvgCost : w.downAvgCost;
    const losingTokenId = losingSide === "UP" ? w.market.upTokenId : w.market.downTokenId;
    if (losingInv <= 0) return;

    // Use real CLOB book for sell price — best bid is where we'd actually sell
    const book = await this.getBookCached(ctx, losingTokenId);
    const bestBid = book.bids.length > 0
      ? Math.max(...book.bids.map(l => l.price))
      : null;
    // Fall back to signal-derived price if book is empty
    const dirSign = signal.direction === "UP" ? 1 : -1;
    const fairVal = Math.max(0.02, Math.min(0.98, 0.50 + signal.signalStrength * 0.20 * dirSign));
    const signalPrice = losingSide === "UP" ? fairVal : (1.0 - fairVal);
    const sellPrice = Math.max(0.01, bestBid ?? signalPrice);

    const result = await ctx.api.placeOrder({
      token_id: losingTokenId, side: "SELL", size: losingInv, price: sellPrice,
      market: w.market.slug, title: `${w.market.title} [UA ${label} ${losingSide}]`,
    });

    if (result.status === "filled" && result.size > 0) {
      const soldSize = result.size;
      const soldPrice = result.price;
      const sellFee = calcFeePerShare(soldPrice, params.fee_params) * soldSize;
      const sellPnl = soldSize * soldPrice - soldSize * losingAvgCost - sellFee;
      w.realizedSellPnl += sellPnl;
      w.sellCount++;
      if (losingSide === "UP") w.upInventory -= soldSize;
      else w.downInventory -= soldSize;
      ctx.log(`${label} ${losingSide} [maker]: ${w.market.title.slice(0, 25)} ${soldSize}@${soldPrice.toFixed(3)} pnl=$${sellPnl.toFixed(2)}`);
      await ctx.db.prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
      ).bind(`ua-msell-${crypto.randomUUID()}`, ctx.config.id, losingTokenId, w.market.slug, `${w.market.title} [UA ${label} ${losingSide}]`, soldPrice, soldSize, sellFee, sellPnl).run();
    }
  }

  // ── Resolve windows ────────────────────────────────────────────────

  private async resolveWindows(ctx: StrategyContext, params: UnifiedParams): Promise<void> {
    const now = Date.now();
    const toRemove: number[] = [];
    const windowRedeemValues = new Map<number, number>();
    const adaptive = this.custom.adaptive;

    for (let i = 0; i < this.custom.activeWindows.length; i++) {
      const w = this.custom.activeWindows[i];
      if (now < w.windowEndTime + 10_000) continue;

      if (w.upInventory === 0 && w.downInventory === 0) {
        ctx.log(`EXPIRED (no fills): ${w.market.title.slice(0, 35)} [${w.mode}]`);
        toRemove.push(i);
        continue;
      }

      let outcome: "UP" | "DOWN" | "UNKNOWN" = "UNKNOWN";
      try {
        const resolution = await Promise.race([
          checkMarketResolution(w.market.slug, w.market.upTokenId, w.market.downTokenId),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
        ]);
        if (resolution.closed && resolution.outcome) outcome = resolution.outcome;
      } catch { /* Gamma API failure or timeout */ }

      let closePrice: number | null = null;
      const history = this.custom.priceHistory[w.cryptoSymbol] || [];
      closePrice = findPriceAtTime(history, w.windowEndTime);
      if (!closePrice) {
        try {
          const snap = await Promise.race([
            fetchSpotPrice(w.cryptoSymbol),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
          ]);
          closePrice = snap?.price ?? null;
        } catch { /* price fetch timeout */ }
      }

      if (outcome === "UNKNOWN") {
        if (now < w.windowEndTime + 30_000) continue;
        if (closePrice !== null && w.priceAtWindowOpen > 0) {
          outcome = closePrice >= w.priceAtWindowOpen ? "UP" : "DOWN";
        }
      }

      // P&L calculation
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
        windowRedeemValues.set(i, winInv - payoutFee);
      }

      const netPnl = winningPayout + losingLoss + w.realizedSellPnl;
      const matched = Math.min(w.upInventory, w.downInventory);
      const priceMovePct = closePrice !== null && w.priceAtWindowOpen > 0
        ? ((closePrice - w.priceAtWindowOpen) / w.priceAtWindowOpen) * 100 : 0;

      // Update stats
      this.custom.stats.totalPnl += netPnl;
      this.custom.stats.windowsTraded++;
      if (w.mode === "sniper") {
        this.custom.stats.sniperWindows++;
        this.custom.stats.sniperPnl += netPnl;
        if (netPnl > 0) this.custom.stats.sniperWins++;
      } else {
        this.custom.stats.makerWindows++;
        this.custom.stats.makerPnl += netPnl;
        if (netPnl > 0) this.custom.stats.makerWins++;
      }

      // Update per-asset win rate
      if (!adaptive.perAssetWinRate[w.cryptoSymbol]) {
        adaptive.perAssetWinRate[w.cryptoSymbol] = {
          sniper: { wins: 0, total: 0 }, maker: { wins: 0, total: 0 },
        };
      }
      const assetWR = adaptive.perAssetWinRate[w.cryptoSymbol];
      const modeWR = w.mode === "sniper" ? assetWR.sniper : assetWR.maker;
      modeWR.total++;
      if (netPnl > 0) modeWR.wins++;

      // Liquidity-based bid sizing update
      adaptive.pnlHistory.push(netPnl);
      if (adaptive.pnlHistory.length > 20) adaptive.pnlHistory.splice(0, adaptive.pnlHistory.length - 20);

      const matchRate = w.bidSize > 0 ? matched / w.bidSize : 0;
      const windowDurMs = w.windowEndTime - w.windowOpenTime;
      const durBkt = durationBucket(w.market.title);
      const alpha = params.liquidity_ema_alpha;
      const obs = {
        matchRate, fillCount: w.fillCount,
        upFills: w.bidSize > 0 ? w.upInventory / w.bidSize : 0,
        downFills: w.bidSize > 0 ? w.downInventory / w.bidSize : 0,
        bidSize: w.bidSize,
      };

      const exactKey = `${w.cryptoSymbol}:${durBkt}:${w.mode}`;
      const anyModeKey = `${w.cryptoSymbol}:${durBkt}:*`;
      const anyAssetKey = `*:${durBkt}:${w.mode}`;
      updateFillBucket(this.custom.liquidity.buckets, exactKey, obs, alpha);
      updateFillBucket(this.custom.liquidity.buckets, anyModeKey, obs, alpha);
      updateFillBucket(this.custom.liquidity.buckets, anyAssetKey, obs, alpha);

      const liq = this.custom.liquidity;
      liq.globalAvgMatchRate = liq.globalAvgMatchRate * (1 - alpha) + matchRate * alpha;
      liq.globalSampleCount++;

      const bucket = this.custom.liquidity.buckets[exactKey];
      const nextBid = computeOptimalBidSize(bucket, params, windowDurMs / 60_000, w.mode);

      ctx.log(
        `LIQUIDITY: ${exactKey} matchRate=${matchRate.toFixed(2)} avg=${bucket.avgMatchRate.toFixed(2)} bidSize=${w.bidSize} → next=${nextBid}`,
        { level: "signal", symbol: w.cryptoSymbol, phase: "liquidity" }
      );

      this.custom.completedWindows.push({
        title: w.market.title, cryptoSymbol: w.cryptoSymbol, mode: w.mode,
        outcome, upInventory: w.upInventory, downInventory: w.downInventory,
        upAvgCost: w.upAvgCost, downAvgCost: w.downAvgCost,
        matchedPairs: matched, netPnl, fillCount: w.fillCount, sellCount: w.sellCount,
        completedAt: new Date().toISOString(), priceMovePct,
        bidSize: w.bidSize, windowDurationMs: windowDurMs,
      });
      if (this.custom.completedWindows.length > 20) {
        this.custom.completedWindows = this.custom.completedWindows.slice(-50);
      }

      ctx.log(
        `RESOLVED [${w.mode}]: ${w.market.title.slice(0, 25)} ${outcome} inv=${w.upInventory}/${w.downInventory} matched=${matched} net=$${netPnl.toFixed(2)} totalPnl=$${this.custom.stats.totalPnl.toFixed(2)} nextBid=${nextBid}`,
        { level: "signal", symbol: w.cryptoSymbol, upInventory: w.upInventory, downInventory: w.downInventory, phase: "resolve" }
      );

      await ctx.db.prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'RESOLVE', 0, 0, 0, datetime('now'), ?)`
      ).bind(
        `ua-resolve-${crypto.randomUUID()}`, ctx.config.id, w.market.conditionId,
        w.market.slug, `${w.market.title} [UA ${w.mode.toUpperCase()} ${outcome} matched=${matched}]`,
        netPnl
      ).run();

      toRemove.push(i);
    }

    // Queue resolved conditions for deferred redemption
    if (ctx.config.mode === "real" && toRemove.length > 0) {
      const conditionIds = toRemove
        .map((i) => this.custom.activeWindows[i]?.market.conditionId)
        .filter((cid): cid is string => !!cid);
      if (conditionIds.length > 0) {
        let redeemValue = 0;
        for (const idx of toRemove) {
          redeemValue += windowRedeemValues.get(idx) ?? this.custom.activeWindows[idx]?.totalBuyCost ?? 0;
        }
        this.custom.resolvingValue += redeemValue;
        this.custom.pendingRedeems.push({
          conditionIds, addedAt: Date.now(), attempts: 0, value: redeemValue,
        });
        ctx.log(`REDEEM QUEUED: ${conditionIds.length} conditions, value=$${redeemValue.toFixed(2)}`);
      }
    }

    for (const idx of toRemove.reverse()) {
      const removed = this.custom.activeWindows.splice(idx, 1)[0];
      delete this.custom.windowRefPrices[removed.market.conditionId];
    }
  }

  // ── Deferred redemption ──────────────────────────────────────────────

  private async processPendingRedeems(ctx: StrategyContext): Promise<void> {
    if (this.custom.pendingRedeems.length === 0) return;

    const now = Date.now();
    const REDEEM_DELAY_MS = 120_000;
    const MAX_ATTEMPTS = 10;
    const kept: typeof this.custom.pendingRedeems = [];

    for (const entry of this.custom.pendingRedeems) {
      if (now - entry.addedAt < REDEEM_DELAY_MS) {
        kept.push(entry);
        continue;
      }

      entry.attempts++;
      try {
        const result = await ctx.api.redeemConditions(entry.conditionIds);
        if (result.error) {
          ctx.log(`AUTO-REDEEM ERROR (attempt ${entry.attempts}): ${result.error}`, { level: "error" } as never);
          if (entry.attempts < MAX_ATTEMPTS) kept.push(entry);
          else {
            this.custom.resolvingValue = Math.max(0, this.custom.resolvingValue - (entry.value || 0));
            ctx.log(`AUTO-REDEEM GAVE UP after ${MAX_ATTEMPTS} attempts`, { level: "error" } as never);
          }
        } else if (result.redeemed > 0) {
          this.custom.resolvingValue = Math.max(0, this.custom.resolvingValue - (entry.value || 0));
          ctx.log(`AUTO-REDEEM OK: ${result.redeemed}/${entry.conditionIds.length} redeemed (attempt ${entry.attempts}), resolving=$${this.custom.resolvingValue.toFixed(2)}`);
        } else {
          if (entry.attempts < MAX_ATTEMPTS) kept.push(entry);
          else {
            this.custom.resolvingValue = Math.max(0, this.custom.resolvingValue - (entry.value || 0));
            ctx.log(`AUTO-REDEEM: 0 redeemed after ${MAX_ATTEMPTS} attempts, giving up`, { level: "error" } as never);
          }
        }
      } catch (e) {
        ctx.log(`AUTO-REDEEM EXCEPTION (attempt ${entry.attempts}): ${e}`, { level: "error" } as never);
        if (entry.attempts < MAX_ATTEMPTS) kept.push(entry);
      }
    }

    this.custom.pendingRedeems = kept;
  }
}

// ── Register ──────────────────────────────────────────────────────────

registerStrategy("unified-adaptive", () => new UnifiedAdaptiveStrategy());
