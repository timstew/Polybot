/**
 * Conviction Maker Strategy — Sequential Conviction-First Pairing
 *
 * Two-phase approach to binary "Up or Down" crypto markets:
 *
 * Phase 1: Buy conviction side at a discount below the CLOB book mid.
 *   Signal says DOWN → rest a bid on DOWN at 20-25% below book mid.
 *   Be patient — in oscillating markets, the price bounces to our level.
 *
 * Phase 2: After conviction fill, pair it with the other side.
 *   DOWN filled at $0.65 → bid UP at max $0.93 - $0.65 = $0.28.
 *   UP is cheap in a DOWN market, so this usually fills quickly.
 *
 * Result: pair cost < $1.00 → structurally profitable regardless of outcome.
 *
 * Key features retained from old conviction-maker:
 * - Cross-asset lead-lag (BTC leads ALTs)
 * - Window timing awareness (early/mid/late phases)
 * - Signal-strength gating (sits out when weak)
 */

import type { Strategy, StrategyContext, OrderBook } from "../strategy";
import { registerStrategy, safeCancelOrder } from "../strategy";
import { calcFeePerShare, CRYPTO_FEES, type FeeParams } from "../categories";
import {
  type CryptoMarket,
  type PriceSnapshot,
  type WindowSignal,
  type ComputeSignalOptions,
  SIGNAL_THRESHOLDS,
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
  CRYPTO_SYMBOL_MAP,
} from "./price-feed";
import { classifyRegime, computeRegimeFeatures } from "./regime";

// ── Types ────────────────────────────────────────────────────────────

/** Phase of the two-step fill sequence */
type FillPhase = "seeking_conviction" | "seeking_pair" | "paired" | "one_sided";

interface ConvictionWindowPosition {
  market: CryptoMarket;
  cryptoSymbol: string;
  windowOpenTime: number;
  windowEndTime: number;
  priceAtWindowOpen: number;
  oracleStrike: number | null;

  // Current bid (either conviction or pair side)
  bidOrderId: string | null;
  bidSide: "UP" | "DOWN" | null;
  bidPrice: number;
  bidSize: number;

  // Two-sided inventory tracking
  upInventory: number;
  upAvgCost: number;
  downInventory: number;
  downAvgCost: number;

  // Sequential fill phase
  fillPhase: FillPhase;
  convictionDirection: "UP" | "DOWN";

  // Signal tracking
  lastSignalDirection: "UP" | "DOWN" | null;
  lastQuotedAt: number;
  lastQuotedPriceChangePct: number;

  // Hysteresis
  confirmedDirection: "UP" | "DOWN" | null;
  flipCount: number;
  lastDirectionChangeAt: number;

  // Stats
  fillCount: number;
  totalBuyCost: number;
  signalStrengthAtEntry: number;
  enteredAt: number;
  tickAction: string;

  // Set when window is past end time but awaiting Polymarket resolution
  binancePrediction?: "UP" | "DOWN" | null;
}

interface CompletedConvictionWindow {
  title: string;
  cryptoSymbol: string;
  convictionSide: "UP" | "DOWN";
  outcome: "UP" | "DOWN" | "UNKNOWN";
  upInventory: number;
  downInventory: number;
  totalBuyCost: number;
  netPnl: number;
  signalStrength: number;
  fillCount: number;
  correct: boolean;
  completedAt: string;
  priceMovePct: number;
  upAvgCost: number;
  downAvgCost: number;
  flipCount: number;
  fillPhase: FillPhase;
  leadLagBonus: number;
  phase: "early" | "mid" | "late";
}

interface ConvictionCustomState {
  activeWindows: ConvictionWindowPosition[];
  completedWindows: CompletedConvictionWindow[];
  priceHistory: Record<string, PriceSnapshot[]>;
  windowRefPrices: Record<string, { price: number; recordedAt: number }>;
  totalPnl: number;
  totalFills: number;
  windowsTraded: number;
  windowsWon: number;
  windowsLost: number;
  directionalAccuracy: number;
  perAsset: Record<string, { won: number; lost: number; pnl: number; fills: number }>;
  scanStatus: string;
}

interface ConvictionMakerParams {
  target_cryptos: string[];
  base_bid_size: number;
  min_spread: number;
  requote_threshold_pct: number;
  observation_seconds: number;
  stop_quoting_before_end_ms: number;
  max_capital_per_window: number;
  max_concurrent_windows: number;
  min_signal_strength: number;
  fee_params: FeeParams;
  discovery_interval_ms: number;
  enable_order_flow: boolean;
  dead_zone_pct: number;
  max_flips_before_sit_out: number;
  grounded_fills: boolean;
  max_pair_cost: number;
  // Conviction discount: how far below book mid to bid on conviction side
  conviction_discount: number; // default 0.20 (20% below book mid)
  pair_discount: number;       // default 0.10 (10% below book mid for pairing side)
  // Lead-lag params
  enable_lead_lag: boolean;
  lead_lag_lookback_ms: number;
  lead_lag_min_move_pct: number;
  lead_lag_bonus: number;
  // Timing params
  late_phase_penalty: number;
}

const DEFAULT_PARAMS: ConvictionMakerParams = {
  target_cryptos: ["Bitcoin", "Ethereum", "Solana", "XRP"],
  base_bid_size: 30,
  min_spread: 0.03,
  requote_threshold_pct: 0.05,
  observation_seconds: 20,
  stop_quoting_before_end_ms: 45_000,
  max_capital_per_window: 50,
  max_concurrent_windows: 12,
  min_signal_strength: 0.55,
  fee_params: CRYPTO_FEES,
  discovery_interval_ms: 15_000,
  enable_order_flow: false,
  dead_zone_pct: 0,
  max_flips_before_sit_out: 2,
  grounded_fills: true,
  max_pair_cost: 0.93,
  conviction_discount: 0.15,
  pair_discount: 0.08,
  // Lead-lag
  enable_lead_lag: true,
  lead_lag_lookback_ms: 60_000,
  lead_lag_min_move_pct: 0.05,
  lead_lag_bonus: 0.15,
  // Timing
  late_phase_penalty: 0.5,
};

// ── Helpers ──────────────────────────────────────────────────────────

function getMid(book: OrderBook): number | null {
  if (book.bids.length === 0 || book.asks.length === 0) return null;
  return (book.bids[0].price + book.asks[0].price) / 2;
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

function emptyCustom(): ConvictionCustomState {
  return {
    activeWindows: [],
    completedWindows: [],
    priceHistory: {},
    windowRefPrices: {},
    totalPnl: 0,
    totalFills: 0,
    windowsTraded: 0,
    windowsWon: 0,
    windowsLost: 0,
    directionalAccuracy: 0,
    perAsset: {},
    scanStatus: "Starting up…",
  };
}

function getWindowPhase(
  now: number,
  windowOpenTime: number,
  windowEndTime: number
): "early" | "mid" | "late" {
  const duration = windowEndTime - windowOpenTime;
  const elapsed = now - windowOpenTime;
  const fraction = elapsed / duration;
  if (fraction < 0.3) return "early";
  if (fraction < 0.7) return "mid";
  return "late";
}

// ── Strategy ─────────────────────────────────────────────────────────

interface BookCacheEntry {
  book: OrderBook;
  fetchedAt: number;
}

class ConvictionMakerStrategy implements Strategy {
  name = "conviction-maker";
  private custom: ConvictionCustomState = emptyCustom();
  private marketCache: CryptoMarket[] = [];
  private lastDiscovery = 0;

  private bookCache: Map<string, BookCacheEntry> = new Map();
  private static BOOK_CACHE_TTL = 5_000;

  private async getBookCached(ctx: StrategyContext, tokenId: string): Promise<OrderBook> {
    const now = Date.now();
    const cached = this.bookCache.get(tokenId);
    if (cached && now - cached.fetchedAt < ConvictionMakerStrategy.BOOK_CACHE_TTL) {
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

  /**
   * BTC lead-lag: if BTC confirms ALT direction → boost, contradicts → penalize.
   */
  private computeLeadLagBonus(
    targetSymbol: string,
    signalDirection: "UP" | "DOWN",
    signalStrength: number,
    params: ConvictionMakerParams
  ): { bonus: number; overrideDirection: "UP" | "DOWN" | null } {
    if (!params.enable_lead_lag) return { bonus: 0, overrideDirection: null };
    if (targetSymbol === "BTCUSDT") return { bonus: 0, overrideDirection: null };

    const btcHistory = this.custom.priceHistory["BTCUSDT"];
    if (!btcHistory || btcHistory.length < 3) return { bonus: 0, overrideDirection: null };

    const now = btcHistory[btcHistory.length - 1].timestamp;
    const lookbackCutoff = now - params.lead_lag_lookback_ms;
    const olderSnap = btcHistory.find(s => s.timestamp >= lookbackCutoff);
    if (!olderSnap) return { bonus: 0, overrideDirection: null };

    const currentBtc = btcHistory[btcHistory.length - 1].price;
    const btcMovePct = ((currentBtc - olderSnap.price) / olderSnap.price) * 100;

    if (Math.abs(btcMovePct) < params.lead_lag_min_move_pct) {
      return { bonus: 0, overrideDirection: null };
    }

    const btcDirection: "UP" | "DOWN" = btcMovePct >= 0 ? "UP" : "DOWN";
    const moveMagnitude = Math.min(1.0, Math.abs(btcMovePct) / (SIGNAL_THRESHOLDS["BTCUSDT"] ?? 0.15));

    if (btcDirection === signalDirection) {
      return { bonus: params.lead_lag_bonus * moveMagnitude, overrideDirection: null };
    } else {
      const penalty = -params.lead_lag_bonus * 0.5 * moveMagnitude;
      if (moveMagnitude > 0.7 && signalStrength < 0.5) {
        return { bonus: params.lead_lag_bonus * moveMagnitude * 0.5, overrideDirection: btcDirection };
      }
      return { bonus: penalty, overrideDirection: null };
    }
  }

  async init(ctx: StrategyContext): Promise<void> {
    const stored = ctx.state.custom as Partial<ConvictionCustomState>;
    this.custom = {
      ...emptyCustom(),
      ...stored,
      activeWindows: stored.activeWindows || [],
      completedWindows: stored.completedWindows || [],
      priceHistory: stored.priceHistory || {},
      windowRefPrices: stored.windowRefPrices || {},
    };

    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as ConvictionMakerParams;
    if (params.enable_order_flow) {
      const symbols = params.target_cryptos
        .map((c) => CRYPTO_SYMBOL_MAP[c.toLowerCase()])
        .filter(Boolean) as string[];
      enableOrderFlow(symbols);
      ctx.log(`Order flow enabled for: ${symbols.join(", ")}`);
    }

    ctx.log(
      `Initialized: ${this.custom.activeWindows.length} active, ${this.custom.totalFills} fills, accuracy=${(this.custom.directionalAccuracy * 100).toFixed(0)}%`
    );
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as ConvictionMakerParams;
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

    // 2. Fetch prices — always include BTCUSDT for lead-lag
    const activeSymbols = new Set<string>();
    if (params.enable_lead_lag) activeSymbols.add("BTCUSDT");
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

    for (const sym of Object.keys(this.custom.priceHistory)) {
      if (!activeSymbols.has(sym)) delete this.custom.priceHistory[sym];
    }

    // 3. Manage active windows
    await this.manageWindows(ctx, params);

    // 4. Enter new windows
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

    // 5b. Wind-down: drop empty windows
    if (ctx.windingDown) {
      const before = this.custom.activeWindows.length;
      this.custom.activeWindows = this.custom.activeWindows.filter(
        w => w.upInventory + w.downInventory > 0 || w.totalBuyCost > 0
      );
      if (this.custom.activeWindows.length < before) {
        ctx.log(`Wind-down: dropped ${before - this.custom.activeWindows.length} empty window(s)`);
      }
    }

    // 6. Status
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
      this.custom.scanStatus = `Scanned ${marketsScanned} markets: ${reasons || "all entered"}`;
    } else if (this.marketCache.length > 0) {
      this.custom.scanStatus = "No open windows";
    } else {
      this.custom.scanStatus = "Scanning for markets…";
    }

    // 7. Persist
    ctx.state.custom = this.custom as unknown as Record<string, unknown>;
    ctx.state.capital_deployed = this.custom.activeWindows.reduce(
      (sum, w) => sum + w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost, 0
    );
    ctx.state.total_pnl = this.custom.totalPnl;
  }

  async stop(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as ConvictionMakerParams;
    for (const w of this.custom.activeWindows) {
      if (w.bidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.bidOrderId);
        if (r.cleared) {
          if (r.fill && w.bidSide) this.recordFill(ctx, w, w.bidSide, r.fill.size, r.fill.price);
          w.bidOrderId = null;
        }
      }
    }
    if (params.enable_order_flow) disableOrderFlow();
    ctx.log(`Stopped: cancelled all bids. ${this.custom.totalFills} fills, P&L=$${ctx.state.total_pnl.toFixed(2)}`);
  }

  /** Record a fill on either side (maker fills = zero fee) */
  private recordFill(
    ctx: StrategyContext,
    w: ConvictionWindowPosition,
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
    this.custom.totalFills++;

    // Update fill phase
    const hasConv = w.convictionDirection === "UP" ? w.upInventory > 0 : w.downInventory > 0;
    const hasPair = w.convictionDirection === "UP" ? w.downInventory > 0 : w.upInventory > 0;
    if (hasConv && hasPair) w.fillPhase = "paired";
    else if (hasConv) w.fillPhase = "seeking_pair";
    else if (hasPair) w.fillPhase = "one_sided"; // shouldn't happen, but defensive
    else w.fillPhase = "seeking_conviction";
  }

  // ── Enter new windows ─────────────────────────────────────────────

  private async enterWindows(
    ctx: StrategyContext,
    params: ConvictionMakerParams
  ): Promise<{ entered: number; marketsScanned: number; skipCounts: Record<string, number> }> {
    const now = Date.now();
    const activeConditions = new Set(
      this.custom.activeWindows.map((w) => w.market.conditionId)
    );
    const skipCounts: Record<string, number> = {};
    let marketsScanned = 0;

    const capitalCommitted = this.custom.activeWindows.reduce(
      (sum, w) => sum + w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost
        + (w.bidOrderId ? w.bidSize * w.bidPrice : 0), 0
    );

    const windowsBefore = this.custom.activeWindows.length;
    for (const market of this.marketCache) {
      if (this.custom.activeWindows.length >= params.max_concurrent_windows) break;
      if (activeConditions.has(market.conditionId)) continue;

      const sym = extractCryptoSymbol(market.title);
      if (!sym) continue;
      marketsScanned++;

      const estCost = params.max_pair_cost * params.base_bid_size;
      if (capitalCommitted + estCost > ctx.config.max_capital_usd) {
        skipCounts["capital limit"] = (skipCounts["capital limit"] || 0) + 1;
        break;
      }

      const endMs = new Date(market.endDate).getTime();
      const windowDuration = parseWindowDurationMs(market.title);
      const windowOpenTime = endMs - windowDuration;
      const timeToEnd = endMs - now;

      if (now < windowOpenTime) { skipCounts["not yet open"] = (skipCounts["not yet open"] || 0) + 1; continue; }
      if (timeToEnd < params.stop_quoting_before_end_ms) { skipCounts["ending soon"] = (skipCounts["ending soon"] || 0) + 1; continue; }

      // Observation period
      const refKey = market.conditionId;
      const history = this.custom.priceHistory[sym] || [];
      const latestSnap = history.length > 0 ? history[history.length - 1] : null;

      if (!this.custom.windowRefPrices[refKey]) {
        if (!latestSnap) { skipCounts["no price data"] = (skipCounts["no price data"] || 0) + 1; continue; }
        this.custom.windowRefPrices[refKey] = { price: latestSnap.price, recordedAt: latestSnap.timestamp };
        skipCounts["observing"] = (skipCounts["observing"] || 0) + 1;
        continue;
      }

      const ref = this.custom.windowRefPrices[refKey];
      const openPrice = ref.price;
      const timeSinceRef = now - ref.recordedAt;
      if (timeSinceRef < params.observation_seconds * 1000) { skipCounts["observing"] = (skipCounts["observing"] || 0) + 1; continue; }

      // Compute signal
      const currentSnap = await fetchSpotPrice(sym);
      if (!currentSnap) { skipCounts["no price data"] = (skipCounts["no price data"] || 0) + 1; continue; }
      const signal = computeSignal(sym, openPrice, currentSnap.price, timeSinceRef,
        history.filter((s) => s.timestamp >= ref.recordedAt));

      // Lead-lag bonus
      const { bonus: leadLagBonus, overrideDirection } = this.computeLeadLagBonus(
        sym, signal.direction, signal.signalStrength, params);
      let adjustedStrength = Math.max(0, Math.min(1.0, signal.signalStrength + leadLagBonus));
      const adjustedDirection = overrideDirection ?? signal.direction;

      // Late-phase penalty
      const phase = getWindowPhase(now, windowOpenTime, endMs);
      if (phase === "late") adjustedStrength *= params.late_phase_penalty;

      if (adjustedStrength < params.min_signal_strength) {
        skipCounts["weak signal"] = (skipCounts["weak signal"] || 0) + 1;
        continue;
      }

      // Fetch oracle strike
      let oracleStrike: number | null = null;
      try {
        const eventStart = new Date(windowOpenTime).toISOString();
        oracleStrike = await fetchOracleStrike(toOracleSymbol(sym), toVariant(windowDuration), eventStart);
      } catch { /* best-effort */ }

      const window: ConvictionWindowPosition = {
        market, cryptoSymbol: sym, windowOpenTime, windowEndTime: endMs,
        priceAtWindowOpen: openPrice, oracleStrike,
        bidOrderId: null, bidSide: null, bidPrice: 0, bidSize: 0,
        upInventory: 0, upAvgCost: 0, downInventory: 0, downAvgCost: 0,
        fillPhase: "seeking_conviction", convictionDirection: adjustedDirection,
        lastSignalDirection: adjustedDirection, lastQuotedAt: 0, lastQuotedPriceChangePct: signal.priceChangePct,
        confirmedDirection: adjustedDirection, flipCount: 0, lastDirectionChangeAt: now,
        fillCount: 0, totalBuyCost: 0, signalStrengthAtEntry: adjustedStrength,
        enteredAt: now, tickAction: "",
      };

      this.custom.activeWindows.push(window);

      const llStr = leadLagBonus !== 0 ? ` ll=${leadLagBonus >= 0 ? "+" : ""}${leadLagBonus.toFixed(2)}` : "";
      const oStr = oracleStrike != null ? ` oracle=$${oracleStrike.toFixed(0)}` : "";
      ctx.log(
        `ENTERED: ${market.title.slice(0, 35)} ${sym} conv=${adjustedDirection}@${(adjustedStrength * 100).toFixed(0)}% phase=${phase}${llStr}${oStr}`,
        { level: "signal", symbol: sym, direction: adjustedDirection, signalStrength: adjustedStrength, phase: "entry" }
      );
    }
    return { entered: this.custom.activeWindows.length - windowsBefore, marketsScanned, skipCounts };
  }

  // ── Manage active windows ─────────────────────────────────────────

  private async manageWindows(
    ctx: StrategyContext,
    params: ConvictionMakerParams
  ): Promise<void> {
    const now = Date.now();

    for (const w of this.custom.activeWindows) {
      const timeToEnd = w.windowEndTime - now;

      if (now > w.windowEndTime + 300_000) { w.tickAction = "Awaiting resolution"; continue; }

      // Wind-down: cancel bids, hold to resolution
      if (ctx.windingDown) {
        if (w.bidOrderId && w.bidSide) {
          const r = await safeCancelOrder(ctx.api, w.bidOrderId);
          if (r.cleared) {
            if (r.fill) this.recordFill(ctx, w, w.bidSide, r.fill.size, r.fill.price);
            w.bidOrderId = null;
          }
        }
        const pc = (w.upInventory > 0 && w.downInventory > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
        w.tickAction = `Wind-down: ${w.upInventory}↑/${w.downInventory}↓${pc}`;
        continue;
      }

      // Stop quoting phase
      if (timeToEnd < params.stop_quoting_before_end_ms) {
        if (w.bidOrderId && w.bidSide) {
          const r = await safeCancelOrder(ctx.api, w.bidOrderId);
          if (r.cleared) {
            if (r.fill) this.recordFill(ctx, w, w.bidSide, r.fill.size, r.fill.price);
            w.bidOrderId = null;
          }
        }
        const pc = (w.upInventory > 0 && w.downInventory > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
        w.tickAction = `Stop: ${w.fillPhase} ${w.upInventory}↑/${w.downInventory}↓${pc}`;
        continue;
      }

      // Retry oracle strike
      if (w.oracleStrike == null) {
        try {
          const eventStart = new Date(w.windowOpenTime).toISOString();
          const wDurMs = w.windowEndTime - w.windowOpenTime;
          w.oracleStrike = await fetchOracleStrike(toOracleSymbol(w.cryptoSymbol), toVariant(wDurMs), eventStart);
        } catch { /* best-effort */ }
      }

      // Compute signal
      const effectiveStrike = w.oracleStrike ?? w.priceAtWindowOpen;
      const currentSnap = await fetchSpotPrice(w.cryptoSymbol);
      if (!currentSnap) continue;
      const history = this.custom.priceHistory[w.cryptoSymbol] || [];
      const signalOpts: ComputeSignalOptions = { prevDirection: w.confirmedDirection };
      if (params.dead_zone_pct > 0) signalOpts.deadZonePct = params.dead_zone_pct;
      const signal = computeSignal(w.cryptoSymbol, effectiveStrike, currentSnap.price,
        now - w.windowOpenTime, history.filter(s => s.timestamp >= w.windowOpenTime), signalOpts);

      // Check fills on pending bid
      await this.checkFills(ctx, w, params);

      // Update quotes (sequential logic)
      await this.updateQuotes(ctx, w, params, signal);
    }
  }

  private async checkFills(
    ctx: StrategyContext,
    w: ConvictionWindowPosition,
    params: ConvictionMakerParams
  ): Promise<void> {
    if (!w.bidOrderId || !w.bidSide) return;

    const status = await ctx.api.getOrderStatus(w.bidOrderId);
    if (status.status === "MATCHED" && status.size_matched > 0) {
      const costBasis = status.price || w.bidPrice;
      const filledSize = status.size_matched;
      const side = w.bidSide;
      const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;

      this.recordFill(ctx, w, side, filledSize, costBasis);

      const book = await this.getBookCached(ctx, tokenId);
      const bestAsk = this.getBestAsk(book);
      const phaseLabel = side === w.convictionDirection ? "CONVICTION" : "PAIR";
      ctx.log(
        `${phaseLabel} FILL ${side}: ${w.market.title.slice(0, 30)} ${filledSize}@${costBasis.toFixed(3)} ask=${bestAsk?.toFixed(3) ?? "?"} → ${w.fillPhase}`,
        { level: "trade", symbol: w.cryptoSymbol, direction: side, phase: "fill" }
      );

      const feeEquivalent = calcFeePerShare(costBasis, params.fee_params) * filledSize;
      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`)
        .bind(
          `cv-${side.toLowerCase()}-${crypto.randomUUID()}`, ctx.config.id, tokenId,
          w.market.slug, `${w.market.title} [CONV ${phaseLabel} ${side}]`,
          costBasis, filledSize, feeEquivalent)
        .run();

      w.bidOrderId = null;
      w.bidSide = null;
    }
  }

  private async updateQuotes(
    ctx: StrategyContext,
    w: ConvictionWindowPosition,
    params: ConvictionMakerParams,
    signal: WindowSignal
  ): Promise<void> {
    const now = Date.now();

    // Track direction flips
    const confirmedFlip = w.confirmedDirection !== null
      && signal.direction !== w.confirmedDirection && !signal.inDeadZone;
    if (confirmedFlip) {
      w.flipCount++;
      ctx.log(
        `FLIP #${w.flipCount}: ${w.market.title.slice(0, 25)} ${w.confirmedDirection} → ${signal.direction}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: signal.direction, flipCount: w.flipCount, phase: "flip" }
      );
      w.confirmedDirection = signal.direction;
      w.lastDirectionChangeAt = now;

      // On flip, update conviction direction IF we haven't filled conviction yet
      if (w.fillPhase === "seeking_conviction") {
        w.convictionDirection = signal.direction;
        // Cancel stale bid (wrong side now)
        if (w.bidOrderId && w.bidSide) {
          const r = await safeCancelOrder(ctx.api, w.bidOrderId);
          if (r.cleared) {
            if (r.fill) this.recordFill(ctx, w, w.bidSide, r.fill.size, r.fill.price);
            w.bidOrderId = null; w.bidSide = null;
          }
        }
      }
    } else if (w.confirmedDirection === null) {
      w.confirmedDirection = signal.direction;
    }

    // Lead-lag
    const { bonus: leadLagBonus, overrideDirection } = this.computeLeadLagBonus(
      w.cryptoSymbol, signal.direction, signal.signalStrength, params);
    let adjustedStrength = Math.max(0, Math.min(1.0, signal.signalStrength + leadLagBonus));
    const adjustedDirection = overrideDirection ?? signal.direction;

    const phase = getWindowPhase(now, w.windowOpenTime, w.windowEndTime);
    if (phase === "late") adjustedStrength *= params.late_phase_penalty;

    // Fetch book mids
    const [upBook, downBook] = await Promise.all([
      this.getBookCached(ctx, w.market.upTokenId),
      this.getBookCached(ctx, w.market.downTokenId),
    ]);
    const upMid = getMid(upBook);
    const downMid = getMid(downBook);
    const bkStr = `bk=${upMid?.toFixed(2) ?? "?"}/${downMid?.toFixed(2) ?? "?"}`;

    // Regime classification for adaptive discounts
    const history = this.custom.priceHistory[w.cryptoSymbol] || [];
    const effectiveStrike = w.oracleStrike ?? w.priceAtWindowOpen;
    const regimeFeatures = computeRegimeFeatures(history, signal, effectiveStrike, w.windowOpenTime, w.windowEndTime);
    const { regime } = classifyRegime(regimeFeatures);

    // Continuous vol-based discount scaling
    // realizedVol = stddev of tick returns (% terms). Typical: calm <0.005, normal 0.005-0.03, volatile >0.03
    // Scale: calm → 0.3x (shallower, fill more), normal → 1.0x, volatile → 1.5x (deeper, catch bounces)
    const volScale = Math.max(0.3, Math.min(1.5, (regimeFeatures.realizedVol ?? 0.015) / 0.015));
    // Regime bonus for non-vol factors
    const regimeBonus =
      regime === "oscillating" ? 0.15 :   // oscillating → slightly deeper (price bounces)
      regime === "trending"    ? -0.20 :  // trending → shallower (don't miss the move)
      0;

    /** Compute effective discount clamped to [0.03, 0.30] */
    const computeEffectiveDiscount = (baseDiscount: number): number =>
      Math.max(0.03, Math.min(0.30, baseDiscount * volScale + regimeBonus * baseDiscount));

    // Periodic signal log
    if (ctx.state.ticks % 5 === 0) {
      const llStr = leadLagBonus !== 0 ? ` ll=${leadLagBonus >= 0 ? "+" : ""}${leadLagBonus.toFixed(2)}` : "";
      ctx.log(
        `SIGNAL: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} ${adjustedDirection} str=${(adjustedStrength * 100).toFixed(0)}% ${bkStr} regime=${regime} phase=${w.fillPhase} inv=${w.upInventory}↑/${w.downInventory}↓${llStr}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: adjustedDirection, signalStrength: adjustedStrength, flipCount: w.flipCount, phase: "manage" }
      );
    }

    // Max flips: sit out if still seeking conviction
    if (w.flipCount > params.max_flips_before_sit_out && w.fillPhase === "seeking_conviction") {
      if (w.bidOrderId && w.bidSide) {
        const r = await safeCancelOrder(ctx.api, w.bidOrderId);
        if (r.cleared) {
          if (r.fill) this.recordFill(ctx, w, w.bidSide, r.fill.size, r.fill.price);
          w.bidOrderId = null; w.bidSide = null;
        }
      }
      w.tickAction = `Sat out: choppy (${w.flipCount} flips)`;
      return;
    }

    // Below strength threshold (only gate conviction phase — always try to pair)
    if (adjustedStrength < params.min_signal_strength && w.fillPhase === "seeking_conviction") {
      if (w.bidOrderId && w.bidSide) {
        const r = await safeCancelOrder(ctx.api, w.bidOrderId);
        if (r.cleared) {
          if (r.fill) this.recordFill(ctx, w, w.bidSide, r.fill.size, r.fill.price);
          w.bidOrderId = null; w.bidSide = null;
        }
      }
      w.tickAction = `Weak: ${(adjustedStrength * 100).toFixed(0)}% ${bkStr}`;
      return;
    }

    // Already paired — hold to resolution, no more bidding
    if (w.fillPhase === "paired") {
      const pc = (w.upAvgCost + w.downAvgCost).toFixed(2);
      w.tickAction = `Paired: ${w.upInventory}↑/${w.downInventory}↓ pc=${pc} ${bkStr}`;
      return;
    }

    // Already have a bid resting — let it work (no aggressive requoting)
    if (w.bidOrderId) {
      const bidLabel = w.bidSide === "UP" ? "▲" : "▼";
      w.tickAction = `${w.fillPhase}: resting ${bidLabel}${w.bidPrice.toFixed(2)} sz=${w.bidSize} ${bkStr}`;
      return;
    }

    // ── Place new bid based on fill phase ──

    const convSide = w.convictionDirection;
    const pairSide: "UP" | "DOWN" = convSide === "UP" ? "DOWN" : "UP";

    if (w.fillPhase === "seeking_conviction") {
      // Phase 1: bid on conviction side at discount below book mid
      const convBookMid = convSide === "UP" ? upMid : downMid;
      if (convBookMid == null) {
        w.tickAction = `Waiting: no book for ${convSide}`;
        return;
      }

      const discount = computeEffectiveDiscount(params.conviction_discount);
      const bidPrice = Math.max(0.01, convBookMid * (1 - discount));
      const roundedBid = Math.floor(bidPrice * 100) / 100;

      // Conviction scaling: stronger signal → larger position
      const wDurMs = w.windowEndTime - w.windowOpenTime;
      const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);
      const effectiveBase = Math.max(10, Math.round(params.base_bid_size * durationScale));
      let bidSize = Math.round(effectiveBase * (adjustedStrength / 0.5));

      // Capital check
      const capUsed = this.custom.activeWindows.reduce(
        (s, aw) => s + aw.upInventory * aw.upAvgCost + aw.downInventory * aw.downAvgCost
          + (aw.bidOrderId && aw !== w ? aw.bidSize * aw.bidPrice : 0), 0);
      const remaining = ctx.config.max_capital_usd - capUsed;
      if (bidSize * roundedBid > remaining) bidSize = Math.floor(remaining / roundedBid);
      if (bidSize < 5) { w.tickAction = `Capital limit ${bkStr}`; return; }

      const tokenId = convSide === "UP" ? w.market.upTokenId : w.market.downTokenId;
      const result = await ctx.api.placeOrder({
        token_id: tokenId, side: "BUY", size: bidSize, price: roundedBid,
        market: w.market.slug, title: `${w.market.title} [CONV ${convSide} bid]`,
      });

      if (result.status === "filled") {
        this.recordFill(ctx, w, convSide, result.size, result.price);
        ctx.log(
          `CONVICTION FILL ${convSide} (imm): ${w.market.title.slice(0, 30)} ${result.size}@${result.price.toFixed(3)} disc=${(discount * 100).toFixed(0)}%`,
          { level: "trade", symbol: w.cryptoSymbol, direction: convSide, phase: "fill" }
        );
        const feeEq = calcFeePerShare(result.price, params.fee_params) * result.size;
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`)
          .bind(`cv-${convSide.toLowerCase()}-imm-${crypto.randomUUID()}`, ctx.config.id, tokenId,
            w.market.slug, `${w.market.title} [CONV ${convSide} imm]`, result.price, result.size, feeEq).run();
      } else if (result.status === "placed") {
        w.bidOrderId = result.order_id;
        w.bidSide = convSide;
        w.bidPrice = roundedBid;
        w.bidSize = bidSize;
      }

      const bidLabel = convSide === "UP" ? "▲" : "▼";
      w.tickAction = `Seek ${convSide}: ${bidLabel}${roundedBid.toFixed(2)} disc=${(discount * 100).toFixed(0)}%@${regime.slice(0, 4)} ${bkStr}`;

    } else if (w.fillPhase === "seeking_pair") {
      // Phase 2: conviction filled, now pair with the other side
      const convCost = convSide === "UP" ? w.upAvgCost : w.downAvgCost;
      const maxPairBid = params.max_pair_cost - convCost;

      const pairBookMid = pairSide === "UP" ? upMid : downMid;
      const discount = computeEffectiveDiscount(params.pair_discount);
      // Use book mid with discount, but cap at max_pair_cost
      let bidPrice: number;
      if (pairBookMid != null) {
        bidPrice = Math.min(maxPairBid, pairBookMid * (1 - discount));
      } else {
        bidPrice = maxPairBid * 0.9; // conservative fallback
      }
      bidPrice = Math.max(0.01, bidPrice);
      const roundedBid = Math.floor(bidPrice * 100) / 100;

      // Match conviction-side inventory for full pairing
      const convInv = convSide === "UP" ? w.upInventory : w.downInventory;
      const pairInv = pairSide === "UP" ? w.upInventory : w.downInventory;
      let bidSize = Math.max(5, convInv - pairInv); // fill the gap

      // Capital check
      const capUsed = this.custom.activeWindows.reduce(
        (s, aw) => s + aw.upInventory * aw.upAvgCost + aw.downInventory * aw.downAvgCost
          + (aw.bidOrderId && aw !== w ? aw.bidSize * aw.bidPrice : 0), 0);
      const remaining = ctx.config.max_capital_usd - capUsed;
      if (bidSize * roundedBid > remaining) bidSize = Math.floor(remaining / roundedBid);
      if (bidSize < 5) { w.tickAction = `Capital limit (pair) ${bkStr}`; return; }

      const tokenId = pairSide === "UP" ? w.market.upTokenId : w.market.downTokenId;
      const result = await ctx.api.placeOrder({
        token_id: tokenId, side: "BUY", size: bidSize, price: roundedBid,
        market: w.market.slug, title: `${w.market.title} [CONV PAIR ${pairSide} bid]`,
      });

      if (result.status === "filled") {
        this.recordFill(ctx, w, pairSide, result.size, result.price);
        const pc = (w.upAvgCost + w.downAvgCost).toFixed(2);
        ctx.log(
          `PAIR FILL ${pairSide} (imm): ${w.market.title.slice(0, 30)} ${result.size}@${result.price.toFixed(3)} pc=${pc}`,
          { level: "trade", symbol: w.cryptoSymbol, direction: pairSide, phase: "fill" }
        );
        const feeEq = calcFeePerShare(result.price, params.fee_params) * result.size;
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`)
          .bind(`cv-${pairSide.toLowerCase()}-pair-${crypto.randomUUID()}`, ctx.config.id, tokenId,
            w.market.slug, `${w.market.title} [CONV PAIR ${pairSide}]`, result.price, result.size, feeEq).run();
      } else if (result.status === "placed") {
        w.bidOrderId = result.order_id;
        w.bidSide = pairSide;
        w.bidPrice = roundedBid;
        w.bidSize = bidSize;
      }

      const bidLabel = pairSide === "UP" ? "▲" : "▼";
      const projPC = (convCost + roundedBid).toFixed(2);
      w.tickAction = `Pair ${pairSide}: ${bidLabel}${roundedBid.toFixed(2)} disc=${(discount * 100).toFixed(0)}%@${regime.slice(0, 4)} max=${maxPairBid.toFixed(2)} projPC=${projPC} ${bkStr}`;
    }

    // Update tracking
    w.lastSignalDirection = adjustedDirection;
    w.lastQuotedAt = now;
    w.lastQuotedPriceChangePct = signal.priceChangePct;
  }

  // ── Resolve completed windows ─────────────────────────────────────

  private async resolveWindows(
    ctx: StrategyContext,
    params: ConvictionMakerParams
  ): Promise<void> {
    const now = Date.now();
    const toRemove: number[] = [];

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
        const resolution = await checkMarketResolution(w.market.slug, w.market.upTokenId, w.market.downTokenId);
        if (resolution.closed && resolution.outcome) outcome = resolution.outcome;
      } catch { /* Gamma API failure */ }

      let closePrice: number | null = null;
      const history = this.custom.priceHistory[w.cryptoSymbol] || [];
      closePrice = findPriceAtTime(history, w.windowEndTime);
      if (!closePrice) { const snap = await fetchSpotPrice(w.cryptoSymbol); closePrice = snap?.price ?? null; }
      if (closePrice !== null && w.priceAtWindowOpen > 0) {
        w.binancePrediction = closePrice >= w.priceAtWindowOpen ? "UP" : "DOWN";
      }

      if (outcome === "UNKNOWN") {
        if (now < w.windowEndTime + 1800_000) continue;
        ctx.log(`RESOLUTION TIMEOUT: ${w.market.title.slice(0, 25)} after 30min`);
      }

      // P&L: paired → winning side pays $1, losing = $0. One-sided → win all or lose all.
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
      const netPnl = winningPayout + losingLoss;
      const correct = outcome !== "UNKNOWN" && w.convictionDirection === outcome;

      const priceMovePct = closePrice !== null && w.priceAtWindowOpen > 0
        ? ((closePrice - w.priceAtWindowOpen) / w.priceAtWindowOpen) * 100 : 0;
      const entryPhase = getWindowPhase(w.enteredAt, w.windowOpenTime, w.windowEndTime);

      const completed: CompletedConvictionWindow = {
        title: w.market.title, cryptoSymbol: w.cryptoSymbol, convictionSide: w.convictionDirection,
        outcome, upInventory: w.upInventory, downInventory: w.downInventory, totalBuyCost: w.totalBuyCost,
        netPnl, signalStrength: w.signalStrengthAtEntry, fillCount: w.fillCount, correct,
        completedAt: new Date().toISOString(), priceMovePct, upAvgCost: w.upAvgCost, downAvgCost: w.downAvgCost,
        flipCount: w.flipCount, fillPhase: w.fillPhase, leadLagBonus: 0, phase: entryPhase,
      };

      this.custom.completedWindows.push(completed);
      if (this.custom.completedWindows.length > 50) this.custom.completedWindows = this.custom.completedWindows.slice(-50);

      this.custom.totalPnl += netPnl;
      this.custom.windowsTraded++;
      if (correct) this.custom.windowsWon++;
      if (outcome !== "UNKNOWN" && !correct) this.custom.windowsLost++;

      const total = this.custom.windowsWon + this.custom.windowsLost;
      this.custom.directionalAccuracy = total > 0 ? this.custom.windowsWon / total : 0;

      if (!this.custom.perAsset[w.cryptoSymbol]) {
        this.custom.perAsset[w.cryptoSymbol] = { won: 0, lost: 0, pnl: 0, fills: 0 };
      }
      const asset = this.custom.perAsset[w.cryptoSymbol];
      if (correct) asset.won++;
      else if (outcome !== "UNKNOWN") asset.lost++;
      asset.pnl += netPnl;
      asset.fills += w.fillCount;

      const outcomeLabel = outcome === "UNKNOWN" ? "UNKNOWN" : `${outcome} ${correct ? "CORRECT" : "WRONG"}`;
      const pc = (w.upInventory > 0 && w.downInventory > 0) ? ` pc=${(w.upAvgCost + w.downAvgCost).toFixed(2)}` : "";
      ctx.log(
        `RESOLVED: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} ${priceMovePct >= 0 ? "+" : ""}${priceMovePct.toFixed(3)}% → ${outcomeLabel} | ${w.fillPhase} ${w.upInventory}↑/${w.downInventory}↓${pc} fills=${w.fillCount} flips=${w.flipCount} | win=$${winningPayout.toFixed(2)} lose=$${losingLoss.toFixed(2)} net=$${netPnl.toFixed(2)} | W/L=${this.custom.windowsWon}/${this.custom.windowsLost}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: outcome === "UNKNOWN" ? undefined : outcome, signalStrength: w.signalStrengthAtEntry, flipCount: w.flipCount, phase: "resolve" }
      );

      await ctx.db.prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'RESOLVE', 0, 0, 0, datetime('now'), ?)`)
        .bind(`cv-resolve-${crypto.randomUUID()}`, ctx.config.id, w.market.conditionId, w.market.slug,
          `${w.market.title} [CONV ${outcomeLabel} ${w.fillPhase} fills=${w.fillCount}]`, netPnl).run();

      toRemove.push(i);
    }

    // Auto-redeem
    if (toRemove.length > 0) {
      const conditionIds = toRemove
        .map((i) => this.custom.activeWindows[i]?.market.conditionId)
        .filter((cid): cid is string => !!cid);
      if (conditionIds.length > 0) {
        try {
          const result = await ctx.api.redeemConditions(conditionIds);
          if (result.error) ctx.log(`AUTO-REDEEM ERROR: ${result.error}`, { level: "error", phase: "redeem" } as never);
          else ctx.log(`AUTO-REDEEM OK: ${conditionIds.length} conditions, redeemed=${result.redeemed}`, { level: "info", phase: "redeem" } as never);
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

registerStrategy("conviction-maker", () => new ConvictionMakerStrategy());
