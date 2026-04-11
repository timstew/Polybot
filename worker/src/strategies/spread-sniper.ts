/**
 * Spread Sniper Strategy
 *
 * Pure complementary token arbitrage on Polymarket "Up or Down" binary markets.
 * Buys equal amounts of both UP and DOWN tokens for a total cost below $1.00,
 * guaranteeing structural profit regardless of outcome.
 *
 * Key principles:
 * - Direction-agnostic: bids equally on both sides
 * - Pair cost obsessed: only enters when pair cost < max_pair_cost
 * - Inventory balanced: pauses heavy side, sells excess to stay balanced
 * - No losers: sells unmatched inventory rather than holding to resolution
 *
 * Uses signal-derived fair value for fill simulation only (not for directional bias).
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

interface SniperPosition {
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
  tickAction: string;

  // Track how many ticks an unmatched excess has been sitting
  unmatchedTicks: number;

  // Book-aware pricing: last observed best asks
  lastUpBestAsk: number;
  lastDnBestAsk: number;

  // Real fill tracking: avoid double-counting activity trades
  processedFillIds: string[];

  // After a rebalance sell, stop quoting — the market is too one-sided for spread sniping
  rebalanceSold: boolean;

  // Set when window is past end time but awaiting Polymarket resolution
  binancePrediction?: "UP" | "DOWN" | null;
}

interface CompletedSniperWindow {
  title: string;
  cryptoSymbol: string;
  outcome: "UP" | "DOWN" | "UNKNOWN";
  upInventory: number;
  downInventory: number;
  upAvgCost: number;
  downAvgCost: number;
  pairCost: number; // avg upCost + dnCost for matched pairs
  matchedPairs: number;
  totalBuyCost: number;
  realizedSellPnl: number;
  winningPayout: number;
  losingLoss: number;
  netPnl: number;
  fillCount: number;
  sellCount: number;
  completedAt: string;
  priceMovePct: number;
}

interface SniperCustomState {
  activeWindows: SniperPosition[];
  completedWindows: CompletedSniperWindow[];
  priceHistory: Record<string, PriceSnapshot[]>;
  windowRefPrices: Record<string, { price: number; recordedAt: number }>;
  totalPnl: number;
  windowsTraded: number;
  windowsProfitable: number;
  windowsUnprofitable: number;
  perAsset: Record<string, { profitable: number; unprofitable: number; pnl: number; fills: number }>;
  pendingRedeems: { conditionIds: string[]; addedAt: number; attempts: number; value: number }[];
  resolvingValue: number; // total $ value of winning tokens pending redemption
  scanStatus: string; // human-readable summary of current scanning activity
}

interface SniperParams {
  target_cryptos: string[];
  bid_size: number; // equal on both sides
  max_pair_cost: number; // UP bid + DN bid must be < this
  bid_offset: number; // bid = 0.50 - offset (symmetric)
  max_capital_per_window: number;
  max_concurrent_windows: number;
  observation_seconds: number;
  stop_quoting_before_end_ms: number;
  exit_inventory_before_end_ms: number;
  sell_unmatched_after_ticks: number; // sell excess inventory after N ticks
  max_unmatched_ratio: number; // sell down to this ratio (e.g. 1.3 = 30% excess max)
  min_pair_confidence: number; // 0-1: minimum confidence score to enter a window
  fee_params: FeeParams;
  discovery_interval_ms: number;
  enable_order_flow: boolean;
  grounded_fills: boolean; // use trade tape instead of probabilistic model (default true)
}

const DEFAULT_PARAMS: SniperParams = {
  target_cryptos: ["Bitcoin", "Ethereum", "Solana", "XRP"],
  bid_size: 30,
  max_pair_cost: 0.92, // aggressive: 8% structural profit per matched pair
  bid_offset: 0.04, // bid at 0.46 each side → pair cost 0.92
  max_capital_per_window: 50,
  max_concurrent_windows: 12, // run on all available timeframes (5min, 15min, 1hr)
  observation_seconds: 10,
  stop_quoting_before_end_ms: 45_000, // stop 45s before end (shorter for 5min windows)
  exit_inventory_before_end_ms: 15_000,
  sell_unmatched_after_ticks: 3, // sell excess after 3 ticks (~9s) — dump one-sided inventory fast
  max_unmatched_ratio: 1.3, // max 30% more on one side
  min_pair_confidence: 0.65, // require 65%+ confidence for paired fills (tighter to avoid lopsided entries)
  fee_params: CRYPTO_FEES,
  discovery_interval_ms: 15_000,
  enable_order_flow: false,
  grounded_fills: true, // use observed trade tape for paper fills (realistic)
};

// ── Volatility Analysis ──────────────────────────────────────────────

/**
 * Compute how favorable conditions are for spread sniping.
 *
 * Sniper wants: oscillating price (mean-reverting) with moderate volatility.
 * Sniper avoids: strong directional trends and dead-calm markets.
 *
 * Returns 0.0 (terrible) to 1.0 (ideal), plus component scores for logging.
 */
interface SniperFavorability {
  score: number;         // 0-1 composite score
  choppiness: number;    // 0-1: direction change ratio (high = good for sniper)
  trendStrength: number; // 0+: |mean return| / stddev (low = good for sniper)
  realizedVol: number;   // stddev of tick returns (moderate = good)
  regime: "oscillating" | "trending" | "calm" | "insufficient";
}

function computeSniperFavorability(
  history: PriceSnapshot[],
  windowOpenTime?: number
): SniperFavorability {
  // Use only samples within the relevant window (or last 60 samples)
  const relevant = windowOpenTime
    ? history.filter(s => s.timestamp >= windowOpenTime)
    : history.slice(-60);

  if (relevant.length < 8) {
    return { score: 0.5, choppiness: 0.5, trendStrength: 0, realizedVol: 0, regime: "insufficient" };
  }

  // Tick-to-tick returns (pct)
  const returns: number[] = [];
  for (let i = 1; i < relevant.length; i++) {
    returns.push(((relevant[i].price - relevant[i - 1].price) / relevant[i - 1].price) * 100);
  }

  // Direction changes (choppiness)
  let dirChanges = 0;
  for (let i = 1; i < returns.length; i++) {
    if ((returns[i] > 0 && returns[i - 1] < 0) || (returns[i] < 0 && returns[i - 1] > 0)) {
      dirChanges++;
    }
  }
  const choppiness = dirChanges / Math.max(1, returns.length - 1); // 0-1

  // Realized volatility (stddev of returns)
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / returns.length;
  const realizedVol = Math.sqrt(variance);

  // Trend strength: |mean return| / stddev (like inverse Sharpe)
  // Low = oscillating (good), high = trending (bad)
  const trendStrength = realizedVol > 0 ? Math.abs(meanReturn) / realizedVol : 0;

  // Score components:
  // 1. Choppiness bonus: 0.5+ is good, 0.7+ is great
  const chopScore = Math.min(1.0, choppiness / 0.6); // 0.6 choppiness → 1.0 score

  // 2. Trend penalty: trendStrength > 0.5 is dangerous
  const trendScore = Math.max(0, 1.0 - trendStrength * 1.5); // 0.67 trend → 0.0 score

  // 3. Volatility sweet spot: too low = no fills, too high = chaos
  //    Ideal realized vol ~0.01-0.05% per tick
  let volScore: number;
  if (realizedVol < 0.003) {
    volScore = realizedVol / 0.003; // linear ramp up to 0.003
  } else if (realizedVol < 0.05) {
    volScore = 1.0; // sweet spot
  } else {
    volScore = Math.max(0, 1.0 - (realizedVol - 0.05) / 0.10); // decay above 0.05
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

// ── Helpers ───────────────────────────────────────────────────────────

function findPriceAtTime(
  history: PriceSnapshot[],
  targetTime: number
): number | null {
  if (history.length === 0) return null;
  let closest: PriceSnapshot | null = null;
  let minDist = Infinity;
  for (const s of history) {
    const dist = Math.abs(s.timestamp - targetTime);
    if (dist < minDist) {
      minDist = dist;
      closest = s;
    }
  }
  return closest && minDist < 60_000 ? closest.price : null;
}

// ── Strategy ──────────────────────────────────────────────────────────

interface BookCacheEntry {
  book: OrderBook;
  fetchedAt: number;
}

class SpreadSniperStrategy implements Strategy {
  name = "spread-sniper";

  private custom: SniperCustomState = {
    activeWindows: [],
    completedWindows: [],
    priceHistory: {},
    windowRefPrices: {},
    totalPnl: 0,
    windowsTraded: 0,
    windowsProfitable: 0,
    windowsUnprofitable: 0,
    perAsset: {},
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
    if (cached && now - cached.fetchedAt < SpreadSniperStrategy.BOOK_CACHE_TTL) {
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
    const stored = ctx.state.custom as unknown as SniperCustomState | undefined;
    if (stored) {
      this.custom = {
        activeWindows: stored.activeWindows || [],
        completedWindows: stored.completedWindows || [],
        priceHistory: stored.priceHistory || {},
        windowRefPrices: stored.windowRefPrices || {},
        totalPnl: stored.totalPnl || 0,
        windowsTraded: stored.windowsTraded || 0,
        windowsProfitable: stored.windowsProfitable || 0,
        windowsUnprofitable: stored.windowsUnprofitable || 0,
        perAsset: stored.perAsset || {},
        pendingRedeems: stored.pendingRedeems || [],
        resolvingValue: stored.resolvingValue || 0,
        scanStatus: stored.scanStatus || "Resuming…",
      };
    }

    // Reconcile totalPnl from D1 (source of truth) to fix drift from unresolved windows
    try {
      const row = await ctx.db
        .prepare("SELECT COALESCE(SUM(pnl), 0) as total FROM strategy_trades WHERE strategy_id = ? AND side IN ('RESOLVE', 'MERGE', 'SELL')")
        .bind(ctx.config.id)
        .first<{ total: number }>();
      if (row && Math.abs((row.total || 0) - this.custom.totalPnl) > 0.01) {
        ctx.log(`P&L RECONCILE: DO state $${this.custom.totalPnl.toFixed(2)} → D1 $${(row.total || 0).toFixed(2)}`);
        this.custom.totalPnl = row.total || 0;
      }
    } catch { /* D1 query failed, keep stored value */ }

    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as SniperParams;
    if (params.enable_order_flow) {
      const symbols = params.target_cryptos
        .map((c) => CRYPTO_SYMBOL_MAP[c.toLowerCase()])
        .filter(Boolean) as string[];
      if (symbols.length > 0) {
        enableOrderFlow(symbols);
      }
    }

    ctx.log(
      `Spread Sniper started: pair_cost<=${params.max_pair_cost} bid_size=${params.bid_size} offset=${params.bid_offset}`
    );
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as SniperParams;
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
      const totalInv = this.custom.activeWindows.reduce(
        (sum, w) => sum + w.upInventory + w.downInventory, 0
      );
      this.custom.scanStatus = this.custom.activeWindows.length > 0
        ? `Winding down: ${this.custom.activeWindows.length} window${this.custom.activeWindows.length > 1 ? "s" : ""} remaining, ${totalInv} tokens`
        : "Wind-down complete, waiting for resolution…";
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
    ctx.state.total_pnl = this.custom.totalPnl;
  }

  async stop(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as SniperParams;
    for (const w of this.custom.activeWindows) {
      if (w.upBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; }
      }
      if (w.downBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; }
      }
    }
    if (params.enable_order_flow) disableOrderFlow();
    ctx.log(`Stopped. P&L=$${ctx.state.total_pnl.toFixed(2)}`);
  }

  /** Record a fill discovered during a failed cancel attempt */
  private recordFillFromCancel(
    ctx: StrategyContext,
    w: SniperPosition,
    side: "UP" | "DOWN",
    size: number,
    price: number
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
    ctx.log(
      `CANCEL-FILL ${side}: ${w.market.title.slice(0, 25)} ${size}@${price.toFixed(3)} (discovered during cancel)`,
      { level: "trade" as never, symbol: w.cryptoSymbol, phase: "cancel_fill" }
    );
  }

  // ── Enter windows ──────────────────────────────────────────────────

  private async enterWindows(
    ctx: StrategyContext,
    params: SniperParams
  ): Promise<void> {
    const now = Date.now();
    const activeConditions = new Set(
      this.custom.activeWindows.map((w) => w.market.conditionId)
    );

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

      // Get or record ref price
      const refKey = market.conditionId;
      const history = this.custom.priceHistory[sym] || [];
      const latestSnap = history.length > 0 ? history[history.length - 1] : null;

      if (!this.custom.windowRefPrices[refKey]) {
        if (!latestSnap) continue;
        this.custom.windowRefPrices[refKey] = {
          price: latestSnap.price,
          recordedAt: latestSnap.timestamp,
        };
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

      // ── Volatility favorability gate ─────────────────────────────
      // Sniper profits from oscillating markets, not trending ones.
      const favorability = computeSniperFavorability(history);

      if (favorability.regime === "trending") {
        ctx.log(
          `SKIP: ${market.title.slice(0, 35)} trending (fav=${favorability.score.toFixed(2)} chop=${favorability.choppiness.toFixed(2)} trend=${favorability.trendStrength.toFixed(2)} vol=${favorability.realizedVol.toFixed(4)})`,
          { level: "signal", symbol: sym, phase: "entry" }
        );
        skipCounts["trending"] = (skipCounts["trending"] || 0) + 1;
        continue;
      }

      // ── Pair confidence gate ──────────────────────────────────────
      // askBalance: how close both asks are to 0.50. At 0.50/0.50 = 1.0 (perfect).
      //   At 0.30/0.70 = 0.60. At 0.10/0.90 = 0.20 (terrible).
      // timeScore: penalty for late entry — below 50% remaining, score decays.
      //   Early entry gets full credit; entering at 25% remaining halves the score.
      // favorabilityBonus: oscillating regime boosts confidence, calm regime reduces it.
      // Combined: all factors gate entry. Lopsided asks, late entry, or trending → skip.
      const askImbalance = Math.abs(upBestAsk - dnBestAsk);
      const askBalance = 1.0 - askImbalance;
      const timeRatio = timeToEnd / windowDuration;
      const timeScore = Math.min(1.0, timeRatio / 0.5);
      const favorabilityBonus = favorability.regime === "oscillating" ? 0.10 : favorability.regime === "calm" ? -0.10 : 0;
      const pairConfidence = askBalance * timeScore + favorabilityBonus;

      if (pairConfidence < params.min_pair_confidence) {
        ctx.log(
          `SKIP: ${market.title.slice(0, 35)} low confidence=${pairConfidence.toFixed(2)} (askBal=${askBalance.toFixed(2)} time=${(timeRatio * 100).toFixed(0)}% fav=${favorability.score.toFixed(2)} ${favorability.regime} asks=${upBestAsk.toFixed(2)}/${dnBestAsk.toFixed(2)})`,
          { level: "signal", symbol: sym, phase: "entry" }
        );
        skipCounts["lopsided asks"] = (skipCounts["lopsided asks"] || 0) + 1;
        continue;
      }

      // Check if a profitable pair is achievable after bid_offset discount
      const projectedPairCost = (upBestAsk - params.bid_offset) + (dnBestAsk - params.bid_offset);
      if (projectedPairCost > params.max_pair_cost + 0.02) {
        ctx.log(
          `SKIP: ${market.title.slice(0, 35)} pair too expensive: asks=${upBestAsk.toFixed(2)}+${dnBestAsk.toFixed(2)}=${(upBestAsk + dnBestAsk).toFixed(2)} projected=${projectedPairCost.toFixed(2)}`,
          { level: "signal", symbol: sym, phase: "entry" }
        );
        skipCounts["too expensive"] = (skipCounts["too expensive"] || 0) + 1;
        continue;
      }

      // Total deployed capital = inventory cost + pending bid notional across all windows.
      // This prevents capital_deployed from exceeding max_capital_usd by counting pending bids.
      const capitalCommitted = this.custom.activeWindows.reduce(
        (sum, w) => {
          const inv = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
          const pending = (w.upBidOrderId ? w.upBidSize * w.upBidPrice : 0)
            + (w.downBidOrderId ? w.downBidSize * w.downBidPrice : 0);
          return sum + inv + pending;
        }, 0
      );
      const estNewWindowCost = params.max_pair_cost * 10; // 10 = effective bid size cap
      if (capitalCommitted + estNewWindowCost > ctx.config.max_capital_usd) {
        ctx.log(
          `SKIP: ${market.title.slice(0, 35)} capital limit (committed=$${capitalCommitted.toFixed(2)} + est=$${estNewWindowCost.toFixed(2)} > max=$${ctx.config.max_capital_usd})`,
          { level: "signal", symbol: sym, phase: "entry" }
        );
        skipCounts["capital limit"] = (skipCounts["capital limit"] || 0) + 1;
        continue;
      }

      const window: SniperPosition = {
        market,
        cryptoSymbol: sym,
        windowOpenTime,
        windowEndTime: endMs,
        priceAtWindowOpen: ref.price,
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
        fillCount: 0,
        sellCount: 0,
        realizedSellPnl: 0,
        totalBuyCost: 0,
        enteredAt: now,
        tickAction: "",
        unmatchedTicks: 0,
        lastUpBestAsk: 0,
        lastDnBestAsk: 0,
        processedFillIds: [],
        rebalanceSold: false,
      };

      this.custom.activeWindows.push(window);
      entered++;
      ctx.log(
        `ENTERED: ${market.title.slice(0, 40)} ${sym} pairTarget=${params.max_pair_cost} fav=${favorability.score.toFixed(2)} ${favorability.regime}`,
        { level: "signal", symbol: sym, phase: "entry" }
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

  // ── Manage windows (fills, quotes, rebalance) ─────────────────────

  private async manageWindows(
    ctx: StrategyContext,
    params: SniperParams
  ): Promise<void> {
    const now = Date.now();

    for (const w of this.custom.activeWindows) {
      const timeToEnd = w.windowEndTime - now;
      const windowDurationMs = w.windowEndTime - w.windowOpenTime;

      if (now > w.windowEndTime + 300_000) {
        w.tickAction = "Awaiting resolution";
        continue;
      }

      // Scale wind-down timings to window duration:
      // 5min window: stop quoting 15s before end, exit 5s before end
      // 15min window: stop quoting 45s, exit 15s
      // 60min window: stop quoting 180s (3min), exit 60s
      const stopQuotingMs = Math.min(params.stop_quoting_before_end_ms,
        windowDurationMs * 0.05); // 5% of window
      const exitMs = Math.min(params.exit_inventory_before_end_ms,
        windowDurationMs * 0.017); // ~1.7% of window

      // Wind-down mode: match light side, cancel heavy side, no new exposure
      if (ctx.windingDown && timeToEnd >= stopQuotingMs) {
        w.tickAction = "Wind-down: matching light side";
        await this.windDownWindow(ctx, w, params);
        continue;
      }

      // Exit phase: sell all excess inventory
      if (timeToEnd < exitMs) {
        w.tickAction = "Exiting: sell excess before close";
        if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; } }
        if (w.downBidOrderId) { const r = await safeCancelOrder(ctx.api, w.downBidOrderId); if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; } }
        await this.sellExcess(ctx, w, params, "EXIT");
        continue;
      }

      // Wind-down: stop quoting, merge pairs, sell excess
      if (timeToEnd < stopQuotingMs) {
        if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; } }
        if (w.downBidOrderId) { const r = await safeCancelOrder(ctx.api, w.downBidOrderId); if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; } }
        const up = w.upInventory, dn = w.downInventory;
        const pc = (up > 0 && dn > 0) ? (w.upAvgCost + w.downAvgCost).toFixed(2) : "\u2014";
        w.tickAction = `Stop: holding ${up}\u2191/${dn}\u2193 pc=${pc}`;
        await this.sellExcess(ctx, w, params, "WIND DOWN");
        continue;
      }

      // Compute signal (for fill simulation only)
      const currentSnap = await fetchSpotPrice(w.cryptoSymbol);
      if (!currentSnap) continue;

      const history = this.custom.priceHistory[w.cryptoSymbol] || [];
      const signal = computeSignal(
        w.cryptoSymbol,
        w.priceAtWindowOpen,
        currentSnap.price,
        now - w.windowOpenTime,
        history.filter((s) => s.timestamp >= w.windowOpenTime)
      );

      // Check fills (always — even when paused, fills on resting orders still need processing)
      await this.checkFills(ctx, w, params, signal);

      // Sell excess if imbalanced for too long
      await this.rebalanceInventory(ctx, w, params);

      // After a rebalance sell, the market proved too one-sided for spread sniping.
      // Stop all quoting to prevent buy→sell→buy→sell churn.
      if (w.rebalanceSold) {
        w.tickAction = "Poisoned: market too one-sided";
        if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; } }
        if (w.downBidOrderId) { const r = await safeCancelOrder(ctx.api, w.downBidOrderId); if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; } }
        continue;
      }

      // Mid-window volatility check: if market turns trending, pause quoting.
      // This prevents new fills in unfavorable conditions while keeping existing inventory.
      const windowHistory = history.filter((s) => s.timestamp >= w.windowOpenTime);
      const favorability = computeSniperFavorability(windowHistory, w.windowOpenTime);

      if (favorability.regime === "trending") {
        w.tickAction = `Paused: trending (chop=${favorability.choppiness.toFixed(2)})`;
        // Cancel all bids — don't build inventory in a trending market
        if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; } }
        if (w.downBidOrderId) { const r = await safeCancelOrder(ctx.api, w.downBidOrderId); if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; } }
        if (ctx.state.ticks % 10 === 0) {
          ctx.log(
            `PAUSED: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} trending (chop=${favorability.choppiness.toFixed(2)} trend=${favorability.trendStrength.toFixed(2)}) inv=${w.upInventory}/${w.downInventory}`,
            { level: "signal", symbol: w.cryptoSymbol, phase: "manage" }
          );
        }
      } else {
        // Place/update quotes — only in non-trending regimes
        await this.updateQuotes(ctx, w, params, signal);
      }

      // Per-tick safety: cancel the heavy side's bid immediately
      if (w.upBidOrderId && w.upInventory > w.downInventory) {
        const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; }
      }
      if (w.downBidOrderId && w.downInventory > w.upInventory) {
        const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; }
      }

      // Ask-based safety: cancel bid on the cheaper side (likely loser fills first).
      // If DOWN ask < UP ask by >10 cents, the market expects DOWN to lose → cancel DOWN bid.
      if (w.lastUpBestAsk > 0 && w.lastDnBestAsk > 0) {
        const askDiff = w.lastUpBestAsk - w.lastDnBestAsk;
        if (askDiff > 0.10 && w.downBidOrderId) {
          const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; }
        } else if (askDiff < -0.10 && w.upBidOrderId) {
          const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; }
        }
      }
    }
  }

  // ── Fill checking (neutral fair value for spread strategy) ──────

  /**
   * Wind-down a single window: match the light side to create profitable pairs.
   * Cancel heavy-side bids, bid on the light side capped at the gap.
   * If already balanced (gap < 5), cancel everything and hold to resolution.
   */
  private async windDownWindow(
    ctx: StrategyContext,
    w: SniperPosition,
    params: SniperParams
  ): Promise<void> {
    // Check fills on any existing bids first
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

    // Already balanced — cancel all bids, hold to resolution
    if (gap < 5) {
      if (w.upBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; }
      }
      if (w.downBidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
        if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; }
      }
      return;
    }

    const lightSide: "UP" | "DOWN" = w.upInventory < w.downInventory ? "UP" : "DOWN";
    const heavySide: "UP" | "DOWN" = lightSide === "UP" ? "DOWN" : "UP";

    // Cancel heavy-side bid
    const heavyBidId = heavySide === "UP" ? w.upBidOrderId : w.downBidOrderId;
    if (heavyBidId) {
      const r = await safeCancelOrder(ctx.api, heavyBidId);
      if (r.cleared) {
        if (r.fill) this.recordFillFromCancel(ctx, w, heavySide, r.fill.size, r.fill.price);
        if (heavySide === "UP") w.upBidOrderId = null;
        else w.downBidOrderId = null;
      }
    }

    // Bid on the light side, capped at the gap
    const lightBidId = lightSide === "UP" ? w.upBidOrderId : w.downBidOrderId;
    if (!lightBidId) {
      const bidSize = Math.min(gap, 10); // sniper uses capped 10-unit bids
      // Conservative pricing: respect max_pair_cost relative to the heavy side's avg cost
      const heavyAvgCost = heavySide === "UP" ? w.upAvgCost : w.downAvgCost;
      const maxBid = heavyAvgCost > 0 ? params.max_pair_cost - heavyAvgCost : params.bid_offset < 0.5 ? 0.5 - params.bid_offset : 0.46;
      const bidPrice = Math.max(0.01, Math.min(maxBid, 0.46));
      const roundedBid = Math.floor(bidPrice * 100) / 100;

      const tokenId = lightSide === "UP" ? w.market.upTokenId : w.market.downTokenId;
      const result = await ctx.api.placeOrder({
        token_id: tokenId,
        side: "BUY",
        size: bidSize,
        price: roundedBid,
      });

      if (result.status === "placed") {
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
      // Note: immediate fills handled by checkFills on next tick
    }

    if (ctx.state.ticks % 5 === 0) {
      ctx.log(
        `WIND-DOWN: ${w.market.title.slice(0, 25)} inv=${w.upInventory}/${w.downInventory} gap=${gap} bidding ${lightSide}`,
        { level: "info", symbol: w.cryptoSymbol, upInventory: w.upInventory, downInventory: w.downInventory, phase: "wind_down" }
      );
    }
  }

  private async checkFills(
    ctx: StrategyContext,
    w: SniperPosition,
    params: SniperParams,
    _signal: WindowSignal
  ): Promise<void> {
    if (ctx.config.mode === "real") {
      await this.checkFillsReal(ctx, w);
      return;
    }
    // Paper mode: unified fill detection via PaperStrategyAPI
    if (w.upBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.upBidOrderId);
      if (status.status === "MATCHED") {
        const costBasis = status.price;
        const filledSize = status.size_matched;
        if (w.upInventory > 0) {
          const totalCost = w.upAvgCost * w.upInventory + costBasis * filledSize;
          w.upInventory += filledSize; w.upAvgCost = totalCost / w.upInventory;
        } else { w.upInventory = filledSize; w.upAvgCost = costBasis; }
        w.fillCount++;
        w.totalBuyCost += costBasis * filledSize;
        ctx.log(
          `SNIPER FILL UP: ${w.market.title.slice(0, 25)} ${filledSize}@${costBasis.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`
        );
        await ctx.db
          .prepare(
            `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
             VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
          )
          .bind(
            `ss-up-${crypto.randomUUID()}`, ctx.config.id, w.market.upTokenId,
            w.market.slug, `${w.market.title} [SNIPER UP]`,
            costBasis, filledSize, 0
          )
          .run();
        w.upBidOrderId = null;
      } else if (status.status === "CANCELLED") { w.upBidOrderId = null; }
    }
    if (w.downBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.downBidOrderId);
      if (status.status === "MATCHED") {
        const costBasis = status.price;
        const filledSize = status.size_matched;
        if (w.downInventory > 0) {
          const totalCost = w.downAvgCost * w.downInventory + costBasis * filledSize;
          w.downInventory += filledSize; w.downAvgCost = totalCost / w.downInventory;
        } else { w.downInventory = filledSize; w.downAvgCost = costBasis; }
        w.fillCount++;
        w.totalBuyCost += costBasis * filledSize;
        ctx.log(
          `SNIPER FILL DN: ${w.market.title.slice(0, 25)} ${filledSize}@${costBasis.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`
        );
        await ctx.db
          .prepare(
            `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
             VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
          )
          .bind(
            `ss-dn-${crypto.randomUUID()}`, ctx.config.id, w.market.downTokenId,
            w.market.slug, `${w.market.title} [SNIPER DN]`,
            costBasis, filledSize, 0
          )
          .run();
        w.downBidOrderId = null;
      } else if (status.status === "CANCELLED") { w.downBidOrderId = null; }
    }
  }

  /**
   * Find matching activity trade for a filled order.
   * Matches by token_id + side + approximate size. Returns best match not already processed.
   */
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
      // Allow 20% size tolerance for partial fills
      if (Math.abs(trade.size - expectedSize) / expectedSize > 0.2) continue;
      return trade;
    }
    return null;
  }

  /** Real mode: poll CLOB for order fill status, cross-reference with activity for actual execution price */
  private async checkFillsReal(
    ctx: StrategyContext,
    w: SniperPosition
  ): Promise<void> {
    // Lazily fetch activity only if we have pending orders
    let activity: ActivityTrade[] | null = null;
    const fetchActivity = async (): Promise<ActivityTrade[]> => {
      if (activity === null) {
        activity = await ctx.api.getActivity(50);
      }
      return activity;
    };

    // Check UP bid
    if (w.upBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.upBidOrderId);
      if (status.status === "MATCHED") {
        const filledSize = status.size_matched || w.upBidSize;

        // REQUIRE activity confirmation — order status alone may report phantom fills.
        // If no activity match, wait for next tick (activity API may have lag).
        const trades = await fetchActivity();
        const match = this.findActivityMatch(trades, w.market.upTokenId, "BUY", filledSize, w.processedFillIds);

        if (match) {
          w.processedFillIds.push(match.id);
          const costBasis = match.price;
          const actualSize = match.size;

          if (w.upInventory > 0) {
            const totalCost = w.upAvgCost * w.upInventory + costBasis * actualSize;
            w.upInventory += actualSize;
            w.upAvgCost = totalCost / w.upInventory;
          } else {
            w.upInventory = actualSize;
            w.upAvgCost = costBasis;
          }
          w.fillCount++;
          w.totalBuyCost += costBasis * actualSize;

          ctx.log(
            `REAL FILL UP: ${w.market.title.slice(0, 25)} ${actualSize}@${costBasis.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`
          );

          await ctx.db
            .prepare(
              `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
               VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
            )
            .bind(
              `ss-up-${crypto.randomUUID()}`, ctx.config.id, w.market.upTokenId,
              w.market.slug, `${w.market.title} [SNIPER UP]`,
              costBasis, actualSize, 0
            )
            .run();
        }

        // Clear order: whether or not activity confirmed, the CLOB order is done
        if (status.size_matched > 0 && status.size_matched < status.original_size) {
          // Partial fill — keep order alive for remaining fill
        } else {
          w.upBidOrderId = null;
        }
      } else if (status.status === "CANCELLED") {
        w.upBidOrderId = null;
      }
      // "LIVE" = still resting, do nothing
    }

    // Check DOWN bid
    if (w.downBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.downBidOrderId);
      if (status.status === "MATCHED") {
        const filledSize = status.size_matched || w.downBidSize;

        // REQUIRE activity confirmation — same as UP
        const trades = await fetchActivity();
        const match = this.findActivityMatch(trades, w.market.downTokenId, "BUY", filledSize, w.processedFillIds);

        if (match) {
          w.processedFillIds.push(match.id);
          const costBasis = match.price;
          const actualSize = match.size;

          if (w.downInventory > 0) {
            const totalCost = w.downAvgCost * w.downInventory + costBasis * actualSize;
            w.downInventory += actualSize;
            w.downAvgCost = totalCost / w.downInventory;
          } else {
            w.downInventory = actualSize;
            w.downAvgCost = costBasis;
          }
          w.fillCount++;
          w.totalBuyCost += costBasis * actualSize;

          ctx.log(
            `REAL FILL DN: ${w.market.title.slice(0, 25)} ${actualSize}@${costBasis.toFixed(3)} inv=${w.upInventory}/${w.downInventory}`
          );

          await ctx.db
            .prepare(
              `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
               VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
            )
            .bind(
              `ss-dn-${crypto.randomUUID()}`, ctx.config.id, w.market.downTokenId,
              w.market.slug, `${w.market.title} [SNIPER DN]`,
              costBasis, actualSize, 0
            )
            .run();
        }

        // Clear order: whether or not activity confirmed, the CLOB order is done
        if (status.size_matched > 0 && status.size_matched < status.original_size) {
          // Partial fill — keep order alive for remaining fill
        } else {
          w.downBidOrderId = null;
        }
      } else if (status.status === "CANCELLED") {
        w.downBidOrderId = null;
      }
    }
  }

  // ── Rebalance: sell excess to stay balanced ────────────────────────

  private async rebalanceInventory(
    ctx: StrategyContext,
    w: SniperPosition,
    params: SniperParams
  ): Promise<void> {
    // Already poisoned from a previous sell — don't retry
    if (w.rebalanceSold) return;

    const { upInventory, downInventory } = w;
    if (upInventory === 0 && downInventory === 0) {
      w.unmatchedTicks = 0;
      return;
    }

    const maxRatio = params.max_unmatched_ratio;
    const minSide = Math.min(upInventory, downInventory);
    const maxSide = Math.max(upInventory, downInventory);

    // If balanced enough, reset counter
    if (minSide > 0 && maxSide / minSide <= maxRatio) {
      w.unmatchedTicks = 0;
      return;
    }

    // One-sided or imbalanced — increment counter
    w.unmatchedTicks++;

    if (w.unmatchedTicks < params.sell_unmatched_after_ticks) return;

    // Sell excess on the heavy side down to target ratio
    const heavySide = upInventory > downInventory ? "UP" : "DOWN";
    const targetHeavy = Math.max(
      minSide > 0 ? Math.ceil(minSide * maxRatio) : 0,
      0 // sell ALL excess when fully one-sided — don't keep "one bid's worth"
    );
    const excess = maxSide - targetHeavy;
    if (excess < 5) return; // CLOB minimum order size is 5

    // Sell at best bid from book (with 3% slippage), fallback to 0.48
    const tokenId = heavySide === "UP" ? w.market.upTokenId : w.market.downTokenId;
    const book = await this.getBookCached(ctx, tokenId);
    const bestBid = this.getBestBid(book);
    const sellPrice = bestBid !== null ? bestBid * 0.97 : 0.48;
    const avgCost = heavySide === "UP" ? w.upAvgCost : w.downAvgCost;

    if (ctx.config.mode === "real") {
      // Real mode: place CLOB sell order to exit one-sided inventory
      const result = await ctx.api.placeOrder({
        token_id: tokenId,
        side: "SELL",
        size: excess,
        price: sellPrice,
        market: w.market.slug,
        title: `${w.market.title} [SNIPER REBAL SELL ${heavySide}]`,
      });

      if (result.status === "filled" || result.status === "placed") {
        // "filled" = immediate match confirmed by Python API
        // "placed" = GTC order on CLOB — optimistic assumption it fills (window is poisoned anyway)
        const actualSize = result.status === "filled" ? result.size : excess;
        const actualPrice = result.status === "filled" ? result.price : sellPrice;
        const sellPnl = (actualPrice - avgCost) * actualSize;
        if (heavySide === "UP") { w.upInventory -= actualSize; } else { w.downInventory -= actualSize; }
        w.realizedSellPnl += sellPnl;
        w.sellCount++;
        w.unmatchedTicks = 0;
        w.rebalanceSold = true; // poison the window — stop quoting to prevent churn
        ctx.log(
          `REAL SELL ${heavySide}: ${w.market.title.slice(0, 25)} ${actualSize}@${actualPrice.toFixed(3)} cost=${avgCost.toFixed(3)} pnl=${sellPnl >= 0 ? "+" : ""}${sellPnl.toFixed(2)} inv=${w.upInventory}/${w.downInventory}${result.status === "filled" ? " (immediate)" : ` order=${result.order_id.slice(0, 12)}`}`,
          { level: "signal", symbol: w.cryptoSymbol, phase: "rebalance" }
        );

        const sellFee = calcFeePerShare(actualPrice, params.fee_params) * actualSize;
        await ctx.db
          .prepare(
            `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
             VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
          )
          .bind(
            `ss-sell-${crypto.randomUUID()}`, ctx.config.id, tokenId,
            w.market.slug, `${w.market.title} [SNIPER REBAL ${heavySide}]`,
            actualPrice, actualSize, sellFee, sellPnl
          )
          .run();
      } else {
        ctx.log(
          `SELL FAILED ${heavySide}: ${w.market.title.slice(0, 25)} ${excess}@${sellPrice.toFixed(3)} error=${result.error || "unknown"}`,
          { level: "signal", symbol: w.cryptoSymbol, phase: "rebalance" }
        );
        // Stop retrying — if balance/allowance is wrong, it won't fix itself
        w.rebalanceSold = true;
      }
    } else {
      // Paper mode: simulate sell instantly
      const sellPnl = (sellPrice - avgCost) * excess;
      if (heavySide === "UP") { w.upInventory -= excess; } else { w.downInventory -= excess; }
      w.realizedSellPnl += sellPnl;
      w.sellCount++;
      w.unmatchedTicks = 0;
      w.rebalanceSold = true; // poison the window — stop quoting to prevent churn

      ctx.log(
        `SNIPER SELL ${heavySide}: ${w.market.title.slice(0, 25)} ${excess}@${sellPrice.toFixed(3)} cost=${avgCost.toFixed(3)} pnl=${sellPnl >= 0 ? "+" : ""}${sellPnl.toFixed(2)} inv=${w.upInventory}/${w.downInventory}`,
        { level: "signal", symbol: w.cryptoSymbol, phase: "rebalance" }
      );

      const sellFee = calcFeePerShare(sellPrice, params.fee_params) * excess;
      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
        )
        .bind(
          `ss-sell-${crypto.randomUUID()}`, ctx.config.id, tokenId,
          w.market.slug, `${w.market.title} [SNIPER REBAL ${heavySide}]`,
          sellPrice, excess, sellFee, sellPnl
        )
        .run();
    }
  }

  // ── Sell excess (wind-down / exit) ─────────────────────────────────

  private async sellExcess(
    ctx: StrategyContext,
    w: SniperPosition,
    params: SniperParams,
    label: string
  ): Promise<void> {
    // Real mode: skip selling — hold all positions to resolution.
    // Matched pairs are profitable regardless. Unmatched positions resolve at $0 or $1.
    if (ctx.config.mode === "real") return;

    const { upInventory, downInventory } = w;
    if (upInventory === 0 && downInventory === 0) return;

    // Sell down to matched pairs only
    const matched = Math.min(upInventory, downInventory);
    const excessUp = upInventory - matched;
    const excessDn = downInventory - matched;

    // Sell excess at best bid from book (with 3% slippage), fallback to 0.48
    if (excessUp > 0) {
      const upBook = await this.getBookCached(ctx, w.market.upTokenId);
      const upBestBid = this.getBestBid(upBook);
      const sellPrice = upBestBid !== null ? upBestBid * 0.97 : 0.48;
      const sellPnl = (sellPrice - w.upAvgCost) * excessUp;
      w.upInventory -= excessUp;
      w.realizedSellPnl += sellPnl;
      w.sellCount++;

      ctx.log(
        `SNIPER ${label} UP: ${w.market.title.slice(0, 25)} ${excessUp}@${sellPrice.toFixed(3)} pnl=${sellPnl >= 0 ? "+" : ""}${sellPnl.toFixed(2)} inv=${w.upInventory}/${w.downInventory}`
      );

      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
        )
        .bind(
          `ss-sell-${crypto.randomUUID()}`, ctx.config.id, w.market.upTokenId,
          w.market.slug, `${w.market.title} [SNIPER ${label} UP]`,
          sellPrice, excessUp, 0, sellPnl
        )
        .run();
    }

    if (excessDn > 0) {
      const dnBook = await this.getBookCached(ctx, w.market.downTokenId);
      const dnBestBid = this.getBestBid(dnBook);
      const sellPrice = dnBestBid !== null ? dnBestBid * 0.97 : 0.48;
      const sellPnl = (sellPrice - w.downAvgCost) * excessDn;
      w.downInventory -= excessDn;
      w.realizedSellPnl += sellPnl;
      w.sellCount++;

      ctx.log(
        `SNIPER ${label} DN: ${w.market.title.slice(0, 25)} ${excessDn}@${sellPrice.toFixed(3)} pnl=${sellPnl >= 0 ? "+" : ""}${sellPnl.toFixed(2)} inv=${w.upInventory}/${w.downInventory}`
      );

      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
        )
        .bind(
          `ss-sell-${crypto.randomUUID()}`, ctx.config.id, w.market.downTokenId,
          w.market.slug, `${w.market.title} [SNIPER ${label} DN]`,
          sellPrice, excessDn, 0, sellPnl
        )
        .run();
    }
  }

  // ── Book-aware bid computation ───────────────────────────────────

  private async computeBookAwareBids(
    ctx: StrategyContext,
    w: SniperPosition,
    params: SniperParams
  ): Promise<{ upBid: number; dnBid: number }> {
    const upBook = await this.getBookCached(ctx, w.market.upTokenId);
    const dnBook = await this.getBookCached(ctx, w.market.downTokenId);
    const upBestAsk = this.getBestAsk(upBook);
    const dnBestAsk = this.getBestAsk(dnBook);

    // Store for logging/paper fills
    if (upBestAsk !== null) w.lastUpBestAsk = upBestAsk;
    if (dnBestAsk !== null) w.lastDnBestAsk = dnBestAsk;

    // Fallback: if no asks on a side, use 0.50 (old behavior)
    const upAsk = upBestAsk ?? 0.50;
    const dnAsk = dnBestAsk ?? 0.50;

    // Bid below best ask by offset
    let upBid = upAsk - params.bid_offset;
    let dnBid = dnAsk - params.bid_offset;

    // Cap by other side's existing cost to maintain pair budget
    if (w.downInventory > 0) {
      upBid = Math.min(upBid, params.max_pair_cost - w.downAvgCost);
    }
    if (w.upInventory > 0) {
      dnBid = Math.min(dnBid, params.max_pair_cost - w.upAvgCost);
    }

    // Enforce combined cap
    if (upBid + dnBid > params.max_pair_cost) {
      const scale = params.max_pair_cost / (upBid + dnBid);
      upBid *= scale;
      dnBid *= scale;
    }

    // Floor at 0.01
    upBid = Math.max(0.01, upBid);
    dnBid = Math.max(0.01, dnBid);

    return { upBid, dnBid };
  }

  // ── Quote updates ─────────────────────────────────────────────────

  private async updateQuotes(
    ctx: StrategyContext,
    w: SniperPosition,
    params: SniperParams,
    signal: WindowSignal
  ): Promise<void> {
    // Per-window capital check: total deployed capital (inventory cost), not just unmatched.
    const windowCapital = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
    if (windowCapital > params.max_capital_per_window) { w.tickAction = "Capital limit"; return; }

    // Cap bid size at 10 units regardless of window duration.
    // A single one-sided fill of 30 units = ~$19 loss. With 10 units, max loss = ~$5.
    // More fills build inventory gradually and the balance check catches up between fills.
    const effectiveBidSize = 10;

    let upBidSize = effectiveBidSize;
    let downBidSize = effectiveBidSize;

    // Strict inventory balance: never let either side get more than one bid ahead
    const excess = w.upInventory - w.downInventory;
    if (excess > 0) upBidSize = 0;   // UP is ahead — only bid DN
    if (excess < 0) downBidSize = 0;  // DN is ahead — only bid UP

    // Book-aware pricing: bid relative to actual best ask on each side
    const { upBid: computedUpBid, dnBid: computedDnBid } =
      await this.computeBookAwareBids(ctx, w, params);
    let upBid = computedUpBid;
    let dnBid = computedDnBid;

    // Per-tick ask balance check: if asks are lopsided, stop bidding on BOTH sides.
    // A lopsided market means one side fills easily while the other never fills,
    // creating catastrophic one-sided inventory. Threshold 0.15 = e.g. 0.425/0.575.
    const askImbalance = Math.abs(w.lastUpBestAsk - w.lastDnBestAsk);
    if (w.lastUpBestAsk > 0 && w.lastDnBestAsk > 0 && askImbalance > 0.15) {
      upBidSize = 0;
      downBidSize = 0;
    }

    // Skip bids too low to be meaningful
    if (upBid < 0.02) upBidSize = 0;
    if (dnBid < 0.02) downBidSize = 0;

    // Don't bid if it would cross the spread (taker fill = fees + unmatched risk)
    if (w.lastUpBestAsk > 0 && upBid >= w.lastUpBestAsk) upBidSize = 0;
    if (w.lastDnBestAsk > 0 && dnBid >= w.lastDnBestAsk) downBidSize = 0;

    // Total deployed capital check: inventory + pending bids across ALL windows.
    // Counts inventory cost + pending bids from other windows, plus bids about to be placed here.
    if (upBidSize > 0 || downBidSize > 0) {
      const otherCapital = this.custom.activeWindows.reduce(
        (sum, aw) => {
          const inv = aw.upInventory * aw.upAvgCost + aw.downInventory * aw.downAvgCost;
          if (aw === w) return sum + inv; // current window: inventory only, pending bids counted below
          const pending = (aw.upBidOrderId ? aw.upBidSize * aw.upBidPrice : 0)
            + (aw.downBidOrderId ? aw.downBidSize * aw.downBidPrice : 0);
          return sum + inv + pending;
        }, 0
      );
      const thisPending = (upBidSize > 0 ? upBidSize * upBid : 0)
        + (downBidSize > 0 ? downBidSize * dnBid : 0);
      const totalCommitted = otherCapital + thisPending;

      if (totalCommitted > ctx.config.max_capital_usd) {
        const remaining = Math.max(0, ctx.config.max_capital_usd - otherCapital);
        if (remaining < 0.50) {
          // Not enough room for any meaningful bids
          upBidSize = 0;
          downBidSize = 0;
          w.tickAction = "Capital limit";
        } else {
          // Scale down bid sizes proportionally to fit remaining capital
          const scale = remaining / thisPending;
          upBidSize = Math.max(upBidSize > 0 ? 3 : 0, Math.floor(upBidSize * scale));
          downBidSize = Math.max(downBidSize > 0 ? 3 : 0, Math.floor(downBidSize * scale));
          // Re-check: if scaled bids still exceed, cut to zero
          const scaledPending = (upBidSize > 0 ? upBidSize * upBid : 0)
            + (downBidSize > 0 ? downBidSize * dnBid : 0);
          if (otherCapital + scaledPending > ctx.config.max_capital_usd) {
            upBidSize = 0;
            downBidSize = 0;
            w.tickAction = "Capital limit";
          }
        }
      }
    }

    // Place UP bid
    if (upBidSize > 0) {
      if (w.upBidOrderId) {
        if (Math.abs(w.upBidPrice - upBid) > 0.005) {
          const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; }
        }
      }
      if (!w.upBidOrderId) {
        const result = await ctx.api.placeOrder({ token_id: w.market.upTokenId, side: "BUY", price: upBid, size: upBidSize });
        if (result.status === "placed") {
          w.upBidOrderId = result.order_id;
          w.upBidPrice = upBid;
          w.upBidSize = upBidSize;
        }
      }
    } else if (w.upBidOrderId) {
      const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
      if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "UP", r.fill.size, r.fill.price); w.upBidOrderId = null; }
    }

    // Place DN bid
    if (downBidSize > 0) {
      if (w.downBidOrderId) {
        if (Math.abs(w.downBidPrice - dnBid) > 0.005) {
          const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
          if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; }
        }
      }
      if (!w.downBidOrderId) {
        const result = await ctx.api.placeOrder({ token_id: w.market.downTokenId, side: "BUY", price: dnBid, size: downBidSize });
        if (result.status === "placed") {
          w.downBidOrderId = result.order_id;
          w.downBidPrice = dnBid;
          w.downBidSize = downBidSize;
        }
      }
    } else if (w.downBidOrderId) {
      const r = await safeCancelOrder(ctx.api, w.downBidOrderId);
      if (r.cleared) { if (r.fill) this.recordFillFromCancel(ctx, w, "DOWN", r.fill.size, r.fill.price); w.downBidOrderId = null; }
    }

    // Set tickAction after bid placement
    {
      const up = w.upInventory, dn = w.downInventory;
      const pc = (up > 0 && dn > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
      const upBidStr = w.upBidOrderId ? `\u25b2${w.upBidPrice.toFixed(2)}` : "";
      const dnBidStr = w.downBidOrderId ? `\u25bc${w.downBidPrice.toFixed(2)}` : "";
      w.tickAction = `bid ${upBidStr} ${dnBidStr}${pc} inv=${up}/${dn}`;
    }

    // Periodic log (every ~5th tick)
    if (ctx.state.ticks % 5 === 0 && (w.upInventory > 0 || w.downInventory > 0)) {
      const pairCost = w.upInventory > 0 && w.downInventory > 0
        ? w.upAvgCost + w.downAvgCost : 0;
      const matched = Math.min(w.upInventory, w.downInventory);
      const flowStr = signal.orderFlowAvailable
        ? ` flow=${signal.orderFlowImbalance >= 0 ? "+" : ""}${signal.orderFlowImbalance.toFixed(2)}`
        : "";
      ctx.log(
        `SNIPER: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} inv=${w.upInventory}/${w.downInventory} matched=${matched} pairCost=${pairCost.toFixed(3)} asks=${w.lastUpBestAsk.toFixed(2)}/${w.lastDnBestAsk.toFixed(2)} bids=${upBid.toFixed(3)}/${dnBid.toFixed(3)} str=${(signal.signalStrength * 100).toFixed(0)}% ${signal.direction}${flowStr}`,
        { level: "signal", symbol: w.cryptoSymbol, signalStrength: signal.signalStrength, upInventory: w.upInventory, downInventory: w.downInventory, phase: "manage" }
      );
    }
  }

  // ── Resolve ────────────────────────────────────────────────────────

  private async resolveWindows(
    ctx: StrategyContext,
    params: SniperParams
  ): Promise<void> {
    const now = Date.now();
    const toRemove: number[] = [];
    const windowRedeemValues = new Map<number, number>(); // index → USDC returned from redemption

    for (let i = 0; i < this.custom.activeWindows.length; i++) {
      const w = this.custom.activeWindows[i];
      if (now < w.windowEndTime + 60_000) continue;

      if (w.upInventory === 0 && w.downInventory === 0) {
        ctx.log(`EXPIRED (no fills): ${w.market.title.slice(0, 35)}`);
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

      // Compute Binance prediction for UI (never used for actual outcome)
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
        // Track total USDC returned from on-chain redemption (winning tokens pay $1 minus fees)
        windowRedeemValues.set(i, winInv - payoutFee);
      }

      const netPnl = winningPayout + losingLoss + w.realizedSellPnl;
      const matched = Math.min(w.upInventory, w.downInventory);
      const pairCost = w.upInventory > 0 && w.downInventory > 0
        ? w.upAvgCost + w.downAvgCost : 0;

      const priceMovePct = closePrice !== null && w.priceAtWindowOpen > 0
        ? ((closePrice - w.priceAtWindowOpen) / w.priceAtWindowOpen) * 100
        : 0;

      const completed: CompletedSniperWindow = {
        title: w.market.title,
        cryptoSymbol: w.cryptoSymbol,
        outcome,
        upInventory: w.upInventory,
        downInventory: w.downInventory,
        upAvgCost: w.upAvgCost,
        downAvgCost: w.downAvgCost,
        pairCost,
        matchedPairs: matched,
        totalBuyCost: w.totalBuyCost,
        realizedSellPnl: w.realizedSellPnl,
        winningPayout,
        losingLoss,
        netPnl,
        fillCount: w.fillCount,
        sellCount: w.sellCount,
        completedAt: new Date().toISOString(),
        priceMovePct,
      };

      this.custom.completedWindows.push(completed);
      if (this.custom.completedWindows.length > 20) {
        this.custom.completedWindows = this.custom.completedWindows.slice(-50);
      }

      this.custom.totalPnl += netPnl;
      this.custom.windowsTraded++;
      if (netPnl > 0) this.custom.windowsProfitable++;
      else this.custom.windowsUnprofitable++;

      if (!this.custom.perAsset[w.cryptoSymbol]) {
        this.custom.perAsset[w.cryptoSymbol] = { profitable: 0, unprofitable: 0, pnl: 0, fills: 0 };
      }
      const asset = this.custom.perAsset[w.cryptoSymbol];
      if (netPnl > 0) asset.profitable++;
      else asset.unprofitable++;
      asset.pnl += netPnl;
      asset.fills += w.fillCount;

      ctx.log(
        `RESOLVED: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} ${priceMovePct >= 0 ? "+" : ""}${priceMovePct.toFixed(3)}% → ${outcome} | inv=${w.upInventory}/${w.downInventory} matched=${matched} pairCost=${pairCost.toFixed(3)} | win=$${winningPayout.toFixed(2)} lose=$${losingLoss.toFixed(2)} sells=$${w.realizedSellPnl.toFixed(2)} net=$${netPnl.toFixed(2)} | P/U=${this.custom.windowsProfitable}/${this.custom.windowsUnprofitable}`,
        { level: "signal", symbol: w.cryptoSymbol, upInventory: w.upInventory, downInventory: w.downInventory, phase: "resolve" }
      );

      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'RESOLVE', 0, 0, 0, datetime('now'), ?)`
        )
        .bind(
          `ss-resolve-${crypto.randomUUID()}`, ctx.config.id, w.market.conditionId,
          w.market.slug, `${w.market.title} [SNIPER ${outcome} matched=${matched}]`,
          netPnl
        )
        .run();

      toRemove.push(i);
    }

    // Queue resolved conditions for deferred redemption (Polymarket needs ~2min to mark redeemable)
    if (ctx.config.mode === "real" && toRemove.length > 0) {
      const conditionIds = toRemove
        .map((i) => this.custom.activeWindows[i]?.market.conditionId)
        .filter((cid): cid is string => !!cid);
      if (conditionIds.length > 0) {
        // Track the value of winning tokens that will be redeemed back to USDC.
        // This bridges the gap between resolution (tokens held) and redemption (USDC returned).
        let redeemValue = 0;
        for (const idx of toRemove) {
          // windowRedeemValues was computed during P&L calc: winInv * $1 - fees
          // Falls back to totalBuyCost for UNKNOWN outcomes or no-fill windows
          redeemValue += windowRedeemValues.get(idx) ?? this.custom.activeWindows[idx]?.totalBuyCost ?? 0;
        }
        this.custom.resolvingValue += redeemValue;
        this.custom.pendingRedeems.push({
          conditionIds,
          addedAt: Date.now(),
          attempts: 0,
          value: redeemValue,
        });
        ctx.log(`REDEEM QUEUED: ${conditionIds.length} conditions, value=$${redeemValue.toFixed(2)} (will retry after 2min delay)`);
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
    const REDEEM_DELAY_MS = 120_000; // 2 min — Polymarket needs time to mark redeemable
    const MAX_ATTEMPTS = 10; // give up after ~5 minutes of retries
    const kept: typeof this.custom.pendingRedeems = [];

    for (const entry of this.custom.pendingRedeems) {
      if (now - entry.addedAt < REDEEM_DELAY_MS) {
        kept.push(entry); // not ready yet
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
            ctx.log(`AUTO-REDEEM GAVE UP after ${MAX_ATTEMPTS} attempts for ${entry.conditionIds.length} conditions`, { level: "error" } as never);
          }
        } else if (result.redeemed > 0) {
          this.custom.resolvingValue = Math.max(0, this.custom.resolvingValue - (entry.value || 0));
          ctx.log(`AUTO-REDEEM OK: ${result.redeemed}/${entry.conditionIds.length} redeemed (attempt ${entry.attempts}), resolving=$${this.custom.resolvingValue.toFixed(2)}`);
        } else {
          // redeemed=0 but no error — positions may not be redeemable yet
          if (entry.attempts < MAX_ATTEMPTS) {
            kept.push(entry);
          } else {
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

registerStrategy("spread-sniper", () => new SpreadSniperStrategy());
