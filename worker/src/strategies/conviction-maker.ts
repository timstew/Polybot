/**
 * Conviction Maker Strategy
 *
 * Only bets when confident. Only bets one side. Holds to resolution.
 *
 * Key differences from directional-maker:
 * - Bids ONLY on conviction side (no hedge bids)
 * - Sits out when signal < min_signal_strength (0.60 default, higher threshold)
 * - No sell logic — holds to resolution
 * - Cross-asset lead-lag (BTC leads ALTs)
 * - Window timing awareness (early/mid/late phases)
 * - Conviction scaling (stronger signal → larger position)
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
  CRYPTO_SYMBOL_MAP,
  type TradeTapeEntry,
  fetchTradeTape,
  checkTapeFill,
} from "./price-feed";

// ── Types ────────────────────────────────────────────────────────────

interface ConvictionWindowPosition {
  market: CryptoMarket;
  cryptoSymbol: string;
  windowOpenTime: number;
  windowEndTime: number;
  priceAtWindowOpen: number;

  // Single active bid (one side only)
  bidOrderId: string | null;
  bidSide: "UP" | "DOWN" | null;
  bidPrice: number;
  bidSize: number;

  // Accumulated inventory (one side only)
  inventory: number;
  avgCost: number;
  inventorySide: "UP" | "DOWN" | null;

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
  convictionSide: "UP" | "DOWN" | null;
  signalStrengthAtEntry: number;
  enteredAt: number;

  // Set when window is past end time but awaiting Polymarket resolution
  binancePrediction?: "UP" | "DOWN" | null;
}

interface CompletedConvictionWindow {
  title: string;
  cryptoSymbol: string;
  convictionSide: "UP" | "DOWN" | null;
  outcome: "UP" | "DOWN" | "UNKNOWN";
  inventory: number;
  inventorySide: "UP" | "DOWN" | null;
  totalBuyCost: number;
  netPnl: number;
  signalStrength: number;
  fillCount: number;
  correct: boolean;
  completedAt: string;
  priceMovePct: number;
  avgCost: number;
  flipCount: number;
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
  bid_offset: number;
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
  bid_offset: 0.02,
  min_spread: 0.03,
  requote_threshold_pct: 0.05,
  observation_seconds: 20,
  stop_quoting_before_end_ms: 45_000,
  max_capital_per_window: 50,
  max_concurrent_windows: 12,
  min_signal_strength: 0.60,
  fee_params: CRYPTO_FEES,
  discovery_interval_ms: 15_000,
  enable_order_flow: false,
  dead_zone_pct: 0,
  max_flips_before_sit_out: 2,
  grounded_fills: true,
  // Lead-lag
  enable_lead_lag: true,
  lead_lag_lookback_ms: 60_000,
  lead_lag_min_move_pct: 0.05,
  lead_lag_bonus: 0.15,
  // Timing
  late_phase_penalty: 0.5,
};

// ── Helpers ──────────────────────────────────────────────────────────

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

/**
 * Get the current window phase based on elapsed time.
 * early (first 30%): full signal — momentum most reliable
 * mid (30-70%): full signal — best entry window
 * late (last 30%): signal penalized — mean reversion risk
 */
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

  private simulatePaperFill(
    bidPrice: number,
    bidSize: number,
    book: OrderBook,
    tokenId: string,
    tape: TradeTapeEntry[],
    grounded: boolean
  ): { filled: boolean; fillPrice: number } {
    const bestAsk = this.getBestAsk(book);

    if (bestAsk !== null && bidPrice >= bestAsk) {
      return { filled: true, fillPrice: bestAsk };
    }

    if (grounded) {
      return checkTapeFill(tape, tokenId, bidPrice, bidSize);
    }

    if (bestAsk === null) return { filled: false, fillPrice: 0 };
    const distance = bestAsk - bidPrice;

    let depthBonus = 0;
    const totalAskDepth = book.asks.reduce((s, l) => s + l.size, 0);
    if (totalAskDepth > 100) depthBonus = 0.05;
    if (totalAskDepth > 500) depthBonus = 0.10;

    const fillProb = Math.min(0.6, 0.30 * Math.exp(-distance * 20) + depthBonus);
    if (Math.random() <= fillProb) {
      return { filled: true, fillPrice: bidPrice };
    }
    return { filled: false, fillPrice: 0 };
  }

  /**
   * Compute lead-lag bonus for ALT coins based on BTC's recent move.
   * BTC tends to lead ALT moves by seconds to minutes.
   * If BTC confirms the ALT signal direction → boost.
   * If BTC contradicts → penalize.
   * If BTC move is very strong + ALT signal is weak → override direction to follow BTC.
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
      // BTC confirms ALT signal → boost scaled by BTC move size
      return {
        bonus: params.lead_lag_bonus * moveMagnitude,
        overrideDirection: null,
      };
    } else {
      // BTC contradicts ALT signal → penalize
      const penalty = -params.lead_lag_bonus * 0.5 * moveMagnitude;

      // If BTC move is very strong and ALT signal is weak → override direction
      if (moveMagnitude > 0.7 && signalStrength < 0.5) {
        return {
          bonus: params.lead_lag_bonus * moveMagnitude * 0.5,
          overrideDirection: btcDirection,
        };
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
    const params = {
      ...DEFAULT_PARAMS,
      ...ctx.config.params,
    } as ConvictionMakerParams;

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

    // 2. Fetch prices — ALWAYS include BTCUSDT for lead-lag
    const activeSymbols = new Set<string>();
    if (params.enable_lead_lag) {
      activeSymbols.add("BTCUSDT");
    }
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

    // Prune price history for symbols no longer active
    for (const sym of Object.keys(this.custom.priceHistory)) {
      if (!activeSymbols.has(sym)) {
        delete this.custom.priceHistory[sym];
      }
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
        w => w.inventory > 0 || w.totalBuyCost > 0
      );
      if (this.custom.activeWindows.length < before) {
        ctx.log(`Wind-down: dropped ${before - this.custom.activeWindows.length} empty window(s)`);
      }
    }

    // 6. Status
    const totalInv = this.custom.activeWindows.reduce(
      (s, w) => s + w.inventory, 0
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
      (sum, w) => sum + w.totalBuyCost, 0
    );
    ctx.state.total_pnl = this.custom.totalPnl;
  }

  async stop(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as ConvictionMakerParams;
    for (const w of this.custom.activeWindows) {
      if (w.bidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.bidOrderId, ctx.config.mode);
        if (r.cleared) {
          if (r.fill) this.recordFillFromCancel(ctx, w, r.fill.size, r.fill.price, params);
          w.bidOrderId = null;
        }
      }
    }
    if (params.enable_order_flow) {
      disableOrderFlow();
    }
    ctx.log(
      `Stopped: cancelled all bids. ${this.custom.totalFills} fills, P&L=$${ctx.state.total_pnl.toFixed(2)}`
    );
  }

  private recordFillFromCancel(
    ctx: StrategyContext,
    w: ConvictionWindowPosition,
    size: number,
    price: number,
    params: ConvictionMakerParams
  ): void {
    if (!w.bidSide) return;
    // Maker fills (resting limit orders) have ZERO fee on Polymarket.
    const costBasis = price;
    if (w.inventory > 0 && w.inventorySide === w.bidSide) {
      const totalCost = w.avgCost * w.inventory + costBasis * size;
      w.inventory += size;
      w.avgCost = totalCost / w.inventory;
    } else {
      w.inventory = size;
      w.avgCost = costBasis;
      w.inventorySide = w.bidSide;
    }
    w.fillCount++;
    w.totalBuyCost += costBasis * size;
    this.custom.totalFills++;
    ctx.log(
      `CANCEL-FILL ${w.bidSide}: ${w.market.title.slice(0, 25)} ${size}@${price.toFixed(3)} (discovered during cancel)`,
      { level: "trade", symbol: w.cryptoSymbol, direction: w.bidSide, phase: "cancel_fill" }
    );
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

    const capitalAtRisk = this.custom.activeWindows.reduce(
      (sum, w) => sum + w.inventory * w.avgCost, 0
    );
    const totalSpent = this.custom.activeWindows.reduce((sum, w) => sum + w.totalBuyCost, 0);

    const windowsBefore = this.custom.activeWindows.length;
    for (const market of this.marketCache) {
      if (this.custom.activeWindows.length >= params.max_concurrent_windows) break;
      if (activeConditions.has(market.conditionId)) continue;

      const sym = extractCryptoSymbol(market.title);
      if (!sym) continue;
      marketsScanned++;

      const estNewWindowCost = 0.50 * params.base_bid_size;
      if (capitalAtRisk + estNewWindowCost > ctx.config.max_capital_usd) {
        skipCounts["capital limit"] = (skipCounts["capital limit"] || 0) + 1;
        break;
      }
      if (ctx.config.mode === "real" && totalSpent + estNewWindowCost > ctx.config.max_capital_usd) {
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

      // Get or record reference price
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

      // Compute signal
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

      // Apply lead-lag bonus
      const { bonus: leadLagBonus, overrideDirection } = this.computeLeadLagBonus(
        sym, signal.direction, signal.signalStrength, params
      );
      let adjustedStrength = Math.max(0, Math.min(1.0, signal.signalStrength + leadLagBonus));
      let adjustedDirection = overrideDirection ?? signal.direction;

      // Apply late-phase penalty
      const phase = getWindowPhase(now, windowOpenTime, endMs);
      if (phase === "late") {
        adjustedStrength *= params.late_phase_penalty;
      }

      // Only enter if signal meets threshold
      if (adjustedStrength < params.min_signal_strength) {
        skipCounts[`weak signal (${adjustedStrength.toFixed(2)})`] = (skipCounts[`weak signal (${adjustedStrength.toFixed(2)})`] || 0) + 1;
        continue;
      }

      const window: ConvictionWindowPosition = {
        market,
        cryptoSymbol: sym,
        windowOpenTime,
        windowEndTime: endMs,
        priceAtWindowOpen: openPrice,
        bidOrderId: null,
        bidSide: null,
        bidPrice: 0,
        bidSize: 0,
        inventory: 0,
        avgCost: 0,
        inventorySide: null,
        lastSignalDirection: adjustedDirection,
        lastQuotedAt: 0,
        lastQuotedPriceChangePct: signal.priceChangePct,
        confirmedDirection: adjustedDirection,
        flipCount: 0,
        lastDirectionChangeAt: now,
        fillCount: 0,
        totalBuyCost: 0,
        convictionSide: adjustedDirection,
        signalStrengthAtEntry: adjustedStrength,
        enteredAt: now,
      };

      this.custom.activeWindows.push(window);

      const llStr = leadLagBonus !== 0 ? ` ll=${leadLagBonus >= 0 ? "+" : ""}${leadLagBonus.toFixed(2)}` : "";
      ctx.log(
        `ENTERED: ${market.title.slice(0, 35)} ${sym} ${adjustedDirection}@${(adjustedStrength * 100).toFixed(0)}% phase=${phase}${llStr}`,
        { level: "signal", symbol: sym, direction: adjustedDirection, signalStrength: adjustedStrength, priceChangePct: signal.priceChangePct, momentum: signal.momentum, volatilityRegime: signal.volatilityRegime, inDeadZone: false, flipCount: 0, phase: "entry" }
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

      if (now > w.windowEndTime + 300_000) continue;

      // Wind-down: cancel bids, hold inventory to resolution
      if (ctx.windingDown) {
        if (w.bidOrderId) {
          const r = await safeCancelOrder(ctx.api, w.bidOrderId, ctx.config.mode);
          if (r.cleared) {
            if (r.fill) this.recordFillFromCancel(ctx, w, r.fill.size, r.fill.price, params);
            w.bidOrderId = null;
          }
        }
        continue;
      }

      // Stop quoting phase: cancel bids (no sell logic, hold to resolution)
      if (timeToEnd < params.stop_quoting_before_end_ms) {
        if (w.bidOrderId) {
          const r = await safeCancelOrder(ctx.api, w.bidOrderId, ctx.config.mode);
          if (r.cleared) {
            if (r.fill) this.recordFillFromCancel(ctx, w, r.fill.size, r.fill.price, params);
            w.bidOrderId = null;
          }
        }
        continue;
      }

      // Compute signal
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

      // Check fills on pending bid
      await this.checkFills(ctx, w, params, signal);

      // Update signal and requote
      await this.updateQuotes(ctx, w, params, signal);
    }
  }

  private async checkFills(
    ctx: StrategyContext,
    w: ConvictionWindowPosition,
    params: ConvictionMakerParams,
    _signal: WindowSignal
  ): Promise<void> {
    if (!w.bidOrderId || !w.bidSide) return;

    const tape = ctx.config.mode !== "real" ? await fetchTradeTape() : [];
    const tokenId = w.bidSide === "UP" ? w.market.upTokenId : w.market.downTokenId;

    let filled = false;
    let costBasis = w.bidPrice;
    let filledSize = w.bidSize;

    if (ctx.config.mode === "real") {
      const status = await ctx.api.getOrderStatus(w.bidOrderId);
      if (status.status === "MATCHED" && status.size_matched > 0) {
        filled = true;
        filledSize = status.size_matched;
        costBasis = status.price || w.bidPrice;
      }
    } else {
      const book = await this.getBookCached(ctx, tokenId);
      const result = this.simulatePaperFill(w.bidPrice, w.bidSize, book, tokenId, tape, params.grounded_fills);
      if (result.filled) {
        filled = true;
        costBasis = result.fillPrice;
      }
    }

    if (filled) {
      // Maker fills (resting limit orders) have ZERO fee on Polymarket.
      // checkFills only detects fills on resting orders, so no fee applies.
      if (w.inventory > 0 && w.inventorySide === w.bidSide) {
        const totalCost = w.avgCost * w.inventory + costBasis * filledSize;
        w.inventory += filledSize;
        w.avgCost = totalCost / w.inventory;
      } else {
        w.inventory = filledSize;
        w.avgCost = costBasis;
        w.inventorySide = w.bidSide;
      }
      w.fillCount++;
      w.totalBuyCost += costBasis * filledSize;
      this.custom.totalFills++;

      const book = await this.getBookCached(ctx, tokenId);
      const bestAsk = this.getBestAsk(book);
      ctx.log(
        `CONVICTION FILL ${w.bidSide}: ${w.market.title.slice(0, 30)} ${filledSize}@${costBasis.toFixed(3)} inv=${w.inventory.toFixed(0)} ask=${bestAsk?.toFixed(3) ?? "?"}`,
        { level: "trade", symbol: w.cryptoSymbol, direction: w.bidSide, phase: "fill" }
      );

      const feeEquivalent = calcFeePerShare(costBasis, params.fee_params) * filledSize;
      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        )
        .bind(
          `cv-${w.bidSide.toLowerCase()}-${crypto.randomUUID()}`,
          ctx.config.id,
          tokenId,
          w.market.slug,
          `${w.market.title} [CONV ${w.bidSide}]`,
          costBasis,
          filledSize,
          feeEquivalent
        )
        .run();

      w.bidOrderId = null;
    }
  }

  private async updateQuotes(
    ctx: StrategyContext,
    w: ConvictionWindowPosition,
    params: ConvictionMakerParams,
    signal: WindowSignal
  ): Promise<void> {
    const now = Date.now();

    // Detect confirmed direction flip
    const confirmedFlip =
      w.confirmedDirection !== null &&
      signal.direction !== w.confirmedDirection &&
      !signal.inDeadZone;

    if (confirmedFlip) {
      w.flipCount++;
      ctx.log(
        `FLIP #${w.flipCount}: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} ${w.confirmedDirection} -> ${signal.direction}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: signal.direction, signalStrength: signal.signalStrength, priceChangePct: signal.priceChangePct, momentum: signal.momentum, volatilityRegime: signal.volatilityRegime, inDeadZone: signal.inDeadZone, flipCount: w.flipCount, phase: "flip" }
      );
      w.confirmedDirection = signal.direction;
      w.lastDirectionChangeAt = now;
    } else if (w.confirmedDirection === null) {
      w.confirmedDirection = signal.direction;
    }

    // Apply lead-lag bonus
    const { bonus: leadLagBonus, overrideDirection } = this.computeLeadLagBonus(
      w.cryptoSymbol, signal.direction, signal.signalStrength, params
    );
    let adjustedStrength = Math.max(0, Math.min(1.0, signal.signalStrength + leadLagBonus));
    const adjustedDirection = overrideDirection ?? signal.direction;

    // Apply late-phase penalty
    const phase = getWindowPhase(now, w.windowOpenTime, w.windowEndTime);
    if (phase === "late") {
      adjustedStrength *= params.late_phase_penalty;
    }

    // Signal-derived fair value for conviction side
    const dirSign = adjustedDirection === "UP" ? 1 : -1;
    const fairVal = Math.max(0.05, Math.min(0.95,
      0.50 + adjustedStrength * 0.40 * dirSign
    ));
    const bidFairVal = adjustedDirection === "UP" ? fairVal : (1.0 - fairVal);

    // Periodic signal log
    if (ctx.state.ticks % 5 === 0) {
      const llStr = leadLagBonus !== 0 ? ` ll=${leadLagBonus >= 0 ? "+" : ""}${leadLagBonus.toFixed(2)}` : "";
      ctx.log(
        `SIGNAL: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} ${adjustedDirection} str=${(adjustedStrength * 100).toFixed(0)}% fv=${bidFairVal.toFixed(2)} inv=${w.inventory} flips=${w.flipCount} phase=${phase}${llStr}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: adjustedDirection, signalStrength: adjustedStrength, priceChangePct: signal.priceChangePct, momentum: signal.momentum, volatilityRegime: signal.volatilityRegime, inDeadZone: signal.inDeadZone, flipCount: w.flipCount, phase: "manage" }
      );
    }

    // Max flips exceeded: sit out, cancel bid, hold to resolution
    if (w.flipCount > params.max_flips_before_sit_out) {
      if (w.bidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.bidOrderId, ctx.config.mode);
        if (r.cleared) {
          if (r.fill) this.recordFillFromCancel(ctx, w, r.fill.size, r.fill.price, params);
          w.bidOrderId = null;
        }
      }
      if (confirmedFlip) {
        ctx.log(
          `SIT OUT (${w.flipCount} flips): ${w.market.title.slice(0, 25)} holding to resolution`,
          { level: "signal", symbol: w.cryptoSymbol, flipCount: w.flipCount, phase: "sit_out" }
        );
      }
      return;
    }

    // Below conviction threshold: cancel bid, sit out
    if (adjustedStrength < params.min_signal_strength) {
      if (w.bidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.bidOrderId, ctx.config.mode);
        if (r.cleared) {
          if (r.fill) this.recordFillFromCancel(ctx, w, r.fill.size, r.fill.price, params);
          w.bidOrderId = null;
        }
      }
      return;
    }

    // Check if we need to requote
    const directionChanged = confirmedFlip;
    const priceMoved =
      Math.abs(signal.priceChangePct - w.lastQuotedPriceChangePct) >
      params.requote_threshold_pct;
    const needsQuote =
      directionChanged || priceMoved || w.lastQuotedAt === 0;

    if (!needsQuote) return;

    // Cancel existing bid before requoting — check tape first in paper mode
    if (w.bidOrderId) {
      if (ctx.config.mode !== "real" && w.bidSide) {
        const tape = await fetchTradeTape();
        const tokenId = w.bidSide === "UP" ? w.market.upTokenId : w.market.downTokenId;
        const tapeFill = checkTapeFill(tape, tokenId, w.bidPrice, w.bidSize);
        if (tapeFill.filled) {
          this.recordFillFromCancel(ctx, w, w.bidSize, tapeFill.fillPrice, params);
          w.bidOrderId = null;
        }
      }
      if (w.bidOrderId) {
        const r = await safeCancelOrder(ctx.api, w.bidOrderId, ctx.config.mode);
        if (r.cleared) {
          if (r.fill) this.recordFillFromCancel(ctx, w, r.fill.size, r.fill.price, params);
          w.bidOrderId = null;
        }
      }
    }

    // Conviction scaling: stronger signal → larger position
    // Signal 0.60 → 36 units, 0.80 → 48 units, 1.00 → 60 units
    const wDurMs = w.windowEndTime - w.windowOpenTime;
    const durationScale = Math.min(1.0, (wDurMs / 60_000) / 15);
    const effectiveBaseSize = Math.max(10, Math.round(params.base_bid_size * durationScale));
    const bidSize = Math.round(effectiveBaseSize * (adjustedStrength / 0.5));

    // Per-window capital check
    if (w.inventory * w.avgCost > params.max_capital_per_window) return;

    // Global capital check
    const capitalAtRisk = this.custom.activeWindows.reduce(
      (sum, aw) => sum + aw.inventory * aw.avgCost, 0
    );
    if (capitalAtRisk > ctx.config.max_capital_usd) return;
    if (ctx.config.mode === "real") {
      const totalSpent = this.custom.activeWindows.reduce((sum, aw) => sum + aw.totalBuyCost, 0);
      if (totalSpent > ctx.config.max_capital_usd) return;
    }

    // Bid price: fair value minus offset
    const bidPrice = Math.max(0.01, bidFairVal - params.bid_offset);
    const roundedBid = Math.floor(bidPrice * 100) / 100;

    // Determine which token
    const tokenId = adjustedDirection === "UP" ? w.market.upTokenId : w.market.downTokenId;

    // Place conviction bid
    const result = await ctx.api.placeOrder({
      token_id: tokenId,
      side: "BUY",
      size: bidSize,
      price: roundedBid,
      market: w.market.slug,
      title: `${w.market.title} [CONV ${adjustedDirection} bid]`,
    });

    if (result.status === "filled") {
      const fillPrice = result.price;
      const fillSize = result.size;
      const feeEquivalent = calcFeePerShare(fillPrice, params.fee_params) * fillSize;
      const costBasis = fillPrice; // Maker fills have zero fee; track fee_equivalent separately for rebate pool
      if (w.inventory > 0 && w.inventorySide === adjustedDirection) {
        const totalCost = w.avgCost * w.inventory + costBasis * fillSize;
        w.inventory += fillSize;
        w.avgCost = totalCost / w.inventory;
      } else {
        w.inventory = fillSize;
        w.avgCost = costBasis;
        w.inventorySide = adjustedDirection;
      }
      w.fillCount++;
      w.totalBuyCost += costBasis * fillSize;
      this.custom.totalFills++;
      ctx.log(
        `CONVICTION FILL ${adjustedDirection} (immediate): ${w.market.title.slice(0, 30)} ${fillSize}@${fillPrice.toFixed(3)} str=${(adjustedStrength * 100).toFixed(0)}%`,
        { level: "trade", symbol: w.cryptoSymbol, direction: adjustedDirection, signalStrength: adjustedStrength, phase: "fill" }
      );
      const tokenId = adjustedDirection === "UP" ? w.market.upTokenId : w.market.downTokenId;
      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
        )
        .bind(
          `cv-${adjustedDirection.toLowerCase()}-imm-${crypto.randomUUID()}`,
          ctx.config.id,
          tokenId,
          w.market.slug,
          `${w.market.title} [CONV ${adjustedDirection} imm]`,
          costBasis,
          fillSize,
          feeEquivalent
        )
        .run();
    } else if (result.status === "placed") {
      w.bidOrderId = result.order_id;
      w.bidSide = adjustedDirection;
      w.bidPrice = roundedBid;
      w.bidSize = bidSize;
    }

    // Update tracking
    w.lastSignalDirection = adjustedDirection;
    w.lastQuotedAt = now;
    w.lastQuotedPriceChangePct = signal.priceChangePct;
    w.convictionSide = adjustedDirection;

    if (directionChanged) {
      ctx.log(
        `REQUOTE: ${w.market.title.slice(0, 30)} conviction=${adjustedDirection} str=${(adjustedStrength * 100).toFixed(0)}% size=${bidSize} phase=${phase}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: adjustedDirection, signalStrength: adjustedStrength, phase: "requote" }
      );
    }
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

      // No inventory — nothing to resolve
      if (w.inventory === 0) {
        ctx.log(`EXPIRED (no fills): ${w.market.title.slice(0, 35)}`);
        toRemove.push(i);
        continue;
      }

      let outcome: "UP" | "DOWN" | "UNKNOWN" = "UNKNOWN";

      // 1. Check Polymarket resolution
      try {
        const resolution = await checkMarketResolution(
          w.market.slug, w.market.upTokenId, w.market.downTokenId
        );
        if (resolution.closed && resolution.outcome) {
          outcome = resolution.outcome;
        }
      } catch { /* Gamma API failure */ }

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

      // P&L: conviction side wins → inv * (1.0 - avgCost) - fees
      //       wrong → -inv * avgCost (total loss)
      let netPnl = 0;
      const correct = outcome !== "UNKNOWN" && w.inventorySide === outcome;

      if (outcome !== "UNKNOWN") {
        if (correct) {
          const payoutFee = calcFeePerShare(1.0, params.fee_params) * w.inventory;
          netPnl = w.inventory * (1.0 - w.avgCost) - payoutFee;
        } else {
          netPnl = -(w.inventory * w.avgCost);
        }
      }

      const priceMovePct = closePrice !== null && w.priceAtWindowOpen > 0
        ? ((closePrice - w.priceAtWindowOpen) / w.priceAtWindowOpen) * 100
        : 0;

      const phase = getWindowPhase(w.enteredAt, w.windowOpenTime, w.windowEndTime);

      const completed: CompletedConvictionWindow = {
        title: w.market.title,
        cryptoSymbol: w.cryptoSymbol,
        convictionSide: w.convictionSide,
        outcome,
        inventory: w.inventory,
        inventorySide: w.inventorySide,
        totalBuyCost: w.totalBuyCost,
        netPnl,
        signalStrength: w.signalStrengthAtEntry,
        fillCount: w.fillCount,
        correct,
        completedAt: new Date().toISOString(),
        priceMovePct,
        avgCost: w.avgCost,
        flipCount: w.flipCount,
        leadLagBonus: 0,
        phase,
      };

      this.custom.completedWindows.push(completed);
      if (this.custom.completedWindows.length > 50) {
        this.custom.completedWindows = this.custom.completedWindows.slice(-50);
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
        `RESOLVED: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} ${priceMovePct >= 0 ? "+" : ""}${priceMovePct.toFixed(3)}% → ${outcomeLabel} | inv=${w.inventory} ${w.inventorySide ?? "?"} cost=${w.avgCost.toFixed(3)} fills=${w.fillCount} flips=${w.flipCount} | net=$${netPnl.toFixed(2)} | W/L=${this.custom.windowsWon}/${this.custom.windowsLost}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: outcome === "UNKNOWN" ? undefined : outcome, signalStrength: w.signalStrengthAtEntry, flipCount: w.flipCount, phase: "resolve" }
      );

      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'RESOLVE', 0, 0, 0, datetime('now'), ?)`
        )
        .bind(
          `cv-resolve-${crypto.randomUUID()}`,
          ctx.config.id,
          w.market.conditionId,
          w.market.slug,
          `${w.market.title} [CONV ${outcomeLabel} fills=${w.fillCount}]`,
          netPnl
        )
        .run();

      toRemove.push(i);
    }

    // Auto-redeem in real mode
    if (ctx.config.mode === "real" && toRemove.length > 0) {
      const conditionIds = toRemove
        .map((i) => this.custom.activeWindows[i]?.market.conditionId)
        .filter((cid): cid is string => !!cid);
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

registerStrategy("conviction-maker", () => new ConvictionMakerStrategy());
