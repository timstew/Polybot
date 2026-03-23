/**
 * Certainty Taker Strategy
 *
 * Replicates BoneReader's approach: waits until a binary outcome is ~99% certain,
 * then sweeps the book with FAK orders to capture the remaining penny spread.
 *
 * Key differences from maker strategies:
 * - 100% taker: FAK orders only, never rests quotes
 * - Probability-gated: only acts when P_true > min_p_true (0.95)
 * - EV-filtered: only sweeps levels where EV > target margin after fees
 * - Single-sided: buys the winning side only, holds to resolution
 * - Uses CLOB WebSocket for book (falls back to REST)
 */

import type { Strategy, StrategyContext, OrderBook, PlaceOrderResult } from "../strategy";
import { registerStrategy } from "../strategy";
import { calcFeePerShare, CRYPTO_FEES, type FeeParams } from "../categories";
import {
  type CryptoMarket,
  type PriceSnapshot,
  fetchSpotPrice,
  extractCryptoSymbol,
  discoverCryptoMarkets,
  parseWindowDurationMs,
  checkMarketResolution,
  calculatePTrue,
  calculateDelta,
  estimateVolatility5min,
  parseStrikePrice,
  parseStrikeDirection,
  roundShares,
  enableOrderFlow,
  disableOrderFlow,
  fetchOracleStrike,
  toOracleSymbol,
  toVariant,
  CRYPTO_SYMBOL_MAP,
} from "./price-feed";
import {
  enableOracleFeed,
  disableOracleFeed,
  getOracleSpot,
  getOracleStrike,
  isOracleConnected,
} from "./oracle-feed";
import {
  enableClobFeed,
  disableClobFeed,
  subscribeClobTokens,
  getClobBook,
  isClobConnected,
} from "./clob-feed";

// ── Types ────────────────────────────────────────────────────────────

interface CertaintyWindow {
  market: CryptoMarket;
  cryptoSymbol: string;
  strikePrice: number | null;       // null until oracle confirms
  strikeDirection: "above" | "below";
  windowEndTime: number;
  windowOpenTime: number;
  windowDurationMs: number;
  lastPTrue: number;
  lastDelta: number;
  lastSpotPrice: number;
  winningSide: "UP" | "DOWN" | null;
  inventory: number;
  avgCost: number;
  inventorySide: "UP" | "DOWN" | null;
  fillCount: number;
  totalCost: number;
  totalFees: number;
  tickAction: string;
  binancePrediction?: "UP" | "DOWN" | null;
}

interface CompletedCertaintyWindow {
  title: string;
  cryptoSymbol: string;
  outcome: "UP" | "DOWN" | "UNKNOWN";
  winningSide: "UP" | "DOWN" | null;
  inventory: number;
  avgCost: number;
  totalCost: number;
  totalFees: number;
  netPnl: number;
  fillCount: number;
  correct: boolean;
  completedAt: string;
  lastPTrue: number;
}

interface CertaintyCustomState {
  activeWindows: CertaintyWindow[];
  completedWindows: CompletedCertaintyWindow[];
  priceHistory: Record<string, PriceSnapshot[]>;
  totalPnl: number;
  totalFills: number;
  windowsTraded: number;
  windowsWon: number;
  windowsLost: number;
  scanStatus: string;
}

interface CertaintyTakerParams {
  target_cryptos: string[];
  min_p_true: number;
  target_margin_usd: number;
  min_ev_per_share: number;
  max_capital_per_window: number;
  max_concurrent_windows: number;
  fee_params: FeeParams;
  discovery_interval_ms: number;
  use_clob_websocket: boolean;
  enable_order_flow: boolean;
  min_level_size: number;
  // Risk controls
  max_price: number;          // never buy above this (e.g. 0.95 = risk $0.95 to win $0.05)
  max_shares_per_sweep: number; // cap total shares per tick to limit blast radius
  min_edge_pct: number;       // minimum edge as % of cost — e.g. 0.01 = 1%
  min_time_remaining_ms: number; // don't sweep with less than this remaining
}

const DEFAULT_PARAMS: CertaintyTakerParams = {
  target_cryptos: ["Bitcoin", "Ethereum", "Solana", "XRP"],
  min_p_true: 0.85,
  target_margin_usd: 0.50,
  min_ev_per_share: 0.001,
  max_capital_per_window: 500,
  max_concurrent_windows: 8,
  fee_params: CRYPTO_FEES,
  discovery_interval_ms: 15_000,
  use_clob_websocket: true,
  enable_order_flow: true,
  min_level_size: 5,
  // Risk controls: at $0.95, risk $0.95 to win $0.05 = 19:1 against.
  // Model must be right 95%+ to break even — much safer than $0.99 (99:1).
  max_price: 0.95,
  max_shares_per_sweep: 50,
  min_edge_pct: 0.01,          // need 1% edge as % of cost
  min_time_remaining_ms: 10_000, // sweep in the last 10-60s when P_true is highest
};

function emptyCustom(): CertaintyCustomState {
  return {
    activeWindows: [],
    completedWindows: [],
    priceHistory: {},
    totalPnl: 0,
    totalFills: 0,
    windowsTraded: 0,
    windowsWon: 0,
    windowsLost: 0,
    scanStatus: "Starting up…",
  };
}

// ── Strategy ─────────────────────────────────────────────────────────

class CertaintyTakerStrategy implements Strategy {
  name = "certainty-taker";
  private wsAvailable = true;
  private custom: CertaintyCustomState = emptyCustom();
  private marketCache: CryptoMarket[] = [];
  private lastDiscovery = 0;

  async init(ctx: StrategyContext): Promise<void> {
    const existing = ctx.state.custom as unknown as CertaintyCustomState | undefined;
    if (existing?.activeWindows) {
      this.custom = existing;
      if (!this.custom.completedWindows) this.custom.completedWindows = [];
    }
    const params = this.getParams(ctx);

    // Enable WebSocket feeds for local dev (may fail with cross-DO isolation)
    try {
      // Oracle feed: Chainlink prices via Polymarket RTDS — zero basis risk
      enableOracleFeed(params.target_cryptos);
      if (params.enable_order_flow) {
        const symbols = params.target_cryptos
          .map((c) => CRYPTO_SYMBOL_MAP[c.toLowerCase()] || c)
          .filter(Boolean);
        enableOrderFlow(symbols);
      }
      if (params.use_clob_websocket) {
        enableClobFeed();
      }
    } catch {
      this.wsAvailable = false;
      ctx.log("WebSocket features unavailable (cross-DO isolation), using REST fallback");
    }
    ctx.log(`Certainty Taker initialized: ${params.target_cryptos.join(", ")}, min_p_true=${params.min_p_true}`);
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const params = this.getParams(ctx);
    const now = Date.now();

    // ── Price updates ──
    for (const crypto of params.target_cryptos) {
      const symbol = CRYPTO_SYMBOL_MAP[crypto.toLowerCase()] || crypto;
      const snap = await fetchSpotPrice(symbol);
      if (snap) {
        if (!this.custom.priceHistory[symbol]) this.custom.priceHistory[symbol] = [];
        this.custom.priceHistory[symbol].push(snap);
        // Keep 5 minutes of history
        const cutoff = now - 300_000;
        this.custom.priceHistory[symbol] = this.custom.priceHistory[symbol].filter(
          (s) => s.timestamp >= cutoff
        );
      }
    }

    // ── Market discovery ──
    if (now - this.lastDiscovery > params.discovery_interval_ms) {
      this.lastDiscovery = now;
      const discovered = await discoverCryptoMarkets(params.target_cryptos);
      this.marketCache = discovered;

      // Subscribe new tokens to CLOB WebSocket
      if (params.use_clob_websocket && this.wsAvailable) {
        try {
          const allTokens = discovered.flatMap((m) => [m.upTokenId, m.downTokenId]);
          if (allTokens.length > 0) subscribeClobTokens(allTokens);
        } catch { this.wsAvailable = false; }
      }

      // Add new windows (only currently-open short-duration crypto windows)
      for (const market of discovered) {
        const symbol = extractCryptoSymbol(market.title);
        if (!symbol) continue;
        if (this.custom.activeWindows.some((w) => w.market.conditionId === market.conditionId)) continue;
        if (this.custom.activeWindows.length >= params.max_concurrent_windows) break;

        const windowEndTime = new Date(market.endDate).getTime();
        const durationMs = parseWindowDurationMs(market.title);
        const windowOpenTime = windowEndTime - durationMs;
        const timeToEnd = windowEndTime - now;

        // Only enter currently-open windows (not future ones)
        if (now < windowOpenTime) continue;
        // Skip windows too close to resolution
        if (timeToEnd < 60_000) continue;
        // Only enter short-duration windows (5-60 min) — skip daily/hourly markets
        if (durationMs < 120_000 || durationMs > 3_600_000) continue;

        // For explicit "above $X" markets: use parsed strike
        // For "Up or Down" markets: start with null strike, fetch oracle price later
        const strike = market.strikePrice;
        const direction = market.strikeDirection ?? "above";

        this.custom.activeWindows.push({
          market,
          cryptoSymbol: symbol,
          strikePrice: strike,  // null for "Up or Down" — oracle fetched per-tick
          strikeDirection: direction,
          windowEndTime,
          windowOpenTime: windowEndTime - durationMs,
          windowDurationMs: durationMs,
          lastPTrue: 0.5,
          lastDelta: 0,
          lastSpotPrice: 0,
          winningSide: null,
          inventory: 0,
          avgCost: 0,
          inventorySide: null,
          fillCount: 0,
          totalCost: 0,
          totalFees: 0,
          tickAction: "awaiting oracle strike",
        });
      }
      this.custom.scanStatus = `${this.marketCache.length} markets, ${this.custom.activeWindows.length} windows`;
    }

    // ── Process each window ──
    const resolvedWindows: CertaintyWindow[] = [];

    for (const w of this.custom.activeWindows) {
      const timeRemaining = w.windowEndTime - now;

      // Check resolution
      if (timeRemaining <= 0) {
        const resolution = await checkMarketResolution(
          w.market.slug, w.market.upTokenId, w.market.downTokenId
        );
        if (resolution.closed && resolution.outcome) {
          this.resolveWindow(ctx, w, resolution.outcome);
          resolvedWindows.push(w);
          continue;
        }
        // Timeout: 30 minutes after end
        if (timeRemaining < -1800_000) {
          w.tickAction = "timeout";
          const snap = this.custom.priceHistory[w.cryptoSymbol];
          const lastPrice = snap?.[snap.length - 1]?.price;
          if (lastPrice && w.strikePrice != null) {
            const predicted = w.strikeDirection === "above"
              ? (lastPrice > w.strikePrice ? "UP" : "DOWN")
              : (lastPrice > w.strikePrice ? "DOWN" : "UP");
            this.resolveWindow(ctx, w, predicted);
          } else {
            this.resolveWindow(ctx, w, "UNKNOWN");
          }
          resolvedWindows.push(w);
          continue;
        }
        w.tickAction = "awaiting resolution";
        continue;
      }

      // Wind-down: don't enter new windows
      if (ctx.windingDown && w.inventory === 0) {
        w.tickAction = "winding down (skipping)";
        continue;
      }

      // ── Dual-feed price architecture ──
      // Oracle (Chainlink via RTDS): spot price for P_true — matches the referee
      // Binance: volatility estimation only (raw exchange data is better for σ)
      const history = this.custom.priceHistory[w.cryptoSymbol];
      if (!history || history.length === 0) {
        w.tickAction = "no price data";
        continue;
      }

      // Primary: oracle spot from Chainlink via RTDS (zero basis risk)
      // Fallback: Binance spot (when oracle feed unavailable)
      const oracleTick = getOracleSpot(w.cryptoSymbol);
      const spot = oracleTick?.price ?? history[history.length - 1].price;
      w.lastSpotPrice = spot;

      // ── Oracle strike capture ──
      // For "Up or Down" markets: capture strike from RTDS stream at eventStartTime
      // Fallback: past-results API if RTDS wasn't connected at window open
      if (w.strikePrice == null) {
        // Try RTDS capture first (first tick >= eventStartTime)
        const rtdsStrike = getOracleStrike(w.cryptoSymbol, w.windowOpenTime);
        if (rtdsStrike != null) {
          w.strikePrice = rtdsStrike;
          const binancePrice = history[history.length - 1].price;
          ctx.log(
            `Oracle strike locked (RTDS): ${w.market.title.slice(0, 50)} → $${rtdsStrike.toFixed(2)} (Binance: $${binancePrice.toFixed(2)}, drift: $${Math.abs(binancePrice - rtdsStrike).toFixed(2)})`,
            { level: "signal", symbol: w.cryptoSymbol }
          );
        } else {
          // Fallback: past-results API
          const eventStart = new Date(w.windowOpenTime).toISOString();
          const oracleSymbol = toOracleSymbol(w.cryptoSymbol);
          const variant = toVariant(w.windowDurationMs);
          const apiStrike = await fetchOracleStrike(oracleSymbol, variant, eventStart);
          if (apiStrike != null) {
            w.strikePrice = apiStrike;
            const binancePrice = history[history.length - 1].price;
            ctx.log(
              `Oracle strike locked (API): ${w.market.title.slice(0, 50)} → $${apiStrike.toFixed(2)} (Binance: $${binancePrice.toFixed(2)}, drift: $${Math.abs(binancePrice - apiStrike).toFixed(2)})`,
              { level: "signal", symbol: w.cryptoSymbol }
            );
          } else {
            // Last resort for non-BTC markets: use Binance spot as strike
            // RTDS Chainlink and past-results API only support BTC
            const elapsed = now - w.windowOpenTime;
            if (elapsed > 10_000) {
              // Window started >10s ago — Binance spot is our only option
              w.strikePrice = history[history.length - 1].price;
              ctx.log(
                `Strike fallback (Binance): ${w.market.title.slice(0, 50)} → $${w.strikePrice.toFixed(2)} (no oracle for ${w.cryptoSymbol})`,
                { level: "warning", symbol: w.cryptoSymbol }
              );
            } else {
              w.tickAction = "awaiting oracle strike";
              continue;
            }
          }
        }
      }

      // Calculate P_true (using oracle spot) and Delta
      // Volatility comes from Binance history — exchange-level vol is fine for σ
      const vol = estimateVolatility5min(history);
      const pTrueUp = calculatePTrue(spot, w.strikePrice, w.strikeDirection, timeRemaining, vol);
      const delta = calculateDelta(spot, w.strikePrice, w.strikeDirection, timeRemaining, vol);

      // Determine winning side and the certainty level for that side
      // pTrueUp = P(UP wins). If UP is losing, the DOWN certainty is (1 - pTrueUp).
      const isAbove = spot > w.strikePrice;
      if (w.strikeDirection === "above") {
        w.winningSide = isAbove ? "UP" : "DOWN";
      } else {
        w.winningSide = isAbove ? "DOWN" : "UP";
      }
      // Certainty for the winning side: max(pTrueUp, 1-pTrueUp)
      const pWinning = w.winningSide === "UP" ? pTrueUp : 1 - pTrueUp;
      w.lastPTrue = pWinning;
      w.lastDelta = delta;

      // Gate: winning-side certainty must exceed threshold
      if (pWinning < params.min_p_true) {
        w.tickAction = `waiting (P=${pWinning.toFixed(3)}, need ${params.min_p_true})`;
        continue;
      }

      // Gate: time remaining — don't sweep too close to resolution
      if (timeRemaining < params.min_time_remaining_ms) {
        w.tickAction = `too close to end (${(timeRemaining / 1000).toFixed(0)}s left, need ${(params.min_time_remaining_ms / 1000).toFixed(0)}s)`;
        continue;
      }

      // Gate: capital limit
      if (w.totalCost >= params.max_capital_per_window) {
        w.tickAction = `capital full ($${w.totalCost.toFixed(2)}/${params.max_capital_per_window})`;
        continue;
      }

      // Gate: global capital
      if (this.custom.totalPnl + ctx.state.total_pnl < -ctx.config.max_capital_usd) {
        w.tickAction = "global capital limit";
        continue;
      }

      // Get the order book (CLOB WS preferred, REST fallback)
      const winningTokenId = w.winningSide === "UP" ? w.market.upTokenId : w.market.downTokenId;
      let book: OrderBook | null = null;
      if (params.use_clob_websocket && this.wsAvailable && isClobConnected()) {
        try { book = getClobBook(winningTokenId); } catch { this.wsAvailable = false; }
      }
      if (!book) {
        book = await ctx.api.getBook(winningTokenId);
      }

      if (!book || book.asks.length === 0) {
        w.tickAction = "no asks";
        continue;
      }

      // Sweep profitable ask levels with FAK orders
      const profitableLevels: Array<{ price: number; size: number; ev: number }> = [];
      const remainingCapital = params.max_capital_per_window - w.totalCost;
      let sharesQueued = 0;

      for (const level of book.asks) {
        if (level.size < params.min_level_size) continue;
        // Price cap: never buy above max_price — limits worst-case loss per share
        if (level.price > params.max_price) continue;
        const fee = calcFeePerShare(level.price, params.fee_params) * level.size;
        const cost = level.price * level.size + fee;
        const ev = pWinning * level.size - cost;
        const evPerShare = ev / level.size;
        // Edge % check: ev/cost must exceed min_edge_pct
        const edgePct = cost > 0 ? ev / cost : 0;

        if (ev > 0 && evPerShare > params.min_ev_per_share && edgePct > params.min_edge_pct && cost <= remainingCapital) {
          // Share cap: limit total shares per sweep
          const cappedSize = Math.min(level.size, params.max_shares_per_sweep - sharesQueued);
          if (cappedSize <= 0) break;
          profitableLevels.push({ price: level.price, size: cappedSize, ev: evPerShare * cappedSize });
          sharesQueued += cappedSize;
        }
      }

      if (profitableLevels.length === 0) {
        w.tickAction = `P=${pWinning.toFixed(3)} — no profitable levels`;
        continue;
      }

      // Fire FAK orders concurrently (micro-friction #3: avoid sequential rate limiting)
      const sweepPromises: Promise<PlaceOrderResult>[] = [];
      let capitalUsed = 0;

      for (const level of profitableLevels) {
        const fee = calcFeePerShare(level.price, params.fee_params) * level.size;
        const cost = level.price * level.size + fee;
        if (capitalUsed + cost > remainingCapital) break;

        sweepPromises.push(
          ctx.api.placeOrder({
            token_id: winningTokenId,
            side: "BUY",
            size: level.size,
            price: level.price,
            market: w.market.conditionId,
            title: w.market.title,
            order_type: "FAK",
          })
        );
        capitalUsed += cost;
      }

      // Execute concurrently
      const results = await Promise.all(sweepPromises);

      let totalSwept = 0;
      let totalSweptCost = 0;
      for (const result of results) {
        if (result.status === "filled" && result.size > 0) {
          const filledSize = roundShares(result.size);
          const fee = calcFeePerShare(result.price, params.fee_params) * filledSize;
          totalSwept += filledSize;
          totalSweptCost += result.price * filledSize + fee;
          w.totalFees += fee;

          // Record trade to D1
          try {
            await ctx.db.prepare(
              `INSERT INTO strategy_trades (id, strategy_id, token_id, side, price, size, fee_amount, pnl, created_at)
               VALUES (?, ?, ?, 'BUY', ?, ?, ?, 0, datetime('now'))`
            ).bind(
              `ct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              ctx.config.id, winningTokenId, result.price, filledSize, fee,
            ).run();
          } catch { /* D1 write failure non-critical */ }
        }
      }

      if (totalSwept > 0) {
        // Update window inventory (micro-friction #1: round immediately)
        const prevTotal = w.inventory * w.avgCost;
        w.inventory = roundShares(w.inventory + totalSwept);
        w.avgCost = w.inventory > 0 ? (prevTotal + totalSweptCost) / w.inventory : 0;
        w.inventorySide = w.winningSide;
        w.totalCost += totalSweptCost;
        w.fillCount += results.filter((r) => r.status === "filled" && r.size > 0).length;
        this.custom.totalFills += results.filter((r) => r.status === "filled" && r.size > 0).length;

        w.tickAction = `SWEPT ${totalSwept.toFixed(0)} @ avg $${(totalSweptCost / totalSwept).toFixed(4)} (P=${pWinning.toFixed(3)})`;
        ctx.log(w.tickAction, {
          level: "trade",
          symbol: w.cryptoSymbol,
          direction: w.winningSide || undefined,
          signalStrength: pWinning,
        });
      } else {
        w.tickAction = `P=${pWinning.toFixed(3)} — sweep attempted, 0 filled`;
      }
    }

    // Remove resolved windows
    this.custom.activeWindows = this.custom.activeWindows.filter(
      (w) => !resolvedWindows.includes(w)
    );

    // Persist
    ctx.state.custom = this.custom as unknown as Record<string, unknown>;
  }

  async stop(ctx: StrategyContext): Promise<void> {
    const params = this.getParams(ctx);
    if (params.enable_order_flow) disableOrderFlow();
    if (params.use_clob_websocket) disableClobFeed();
    ctx.log("Certainty Taker stopped");
  }

  private resolveWindow(
    ctx: StrategyContext,
    w: CertaintyWindow,
    outcome: "UP" | "DOWN" | "UNKNOWN",
  ): void {
    let netPnl = 0;
    const correct = w.inventorySide === outcome;

    if (w.inventory > 0 && w.inventorySide) {
      if (correct) {
        // Won: inventory resolves to $1 each
        netPnl = w.inventory * (1 - w.avgCost) - w.totalFees;
      } else {
        // Lost: inventory resolves to $0
        netPnl = -w.totalCost;
      }
    }

    this.custom.totalPnl += netPnl;
    ctx.state.total_pnl += netPnl;
    this.custom.windowsTraded++;
    if (correct) this.custom.windowsWon++;
    else if (w.inventory > 0) this.custom.windowsLost++;

    this.custom.completedWindows.push({
      title: w.market.title,
      cryptoSymbol: w.cryptoSymbol,
      outcome,
      winningSide: w.winningSide,
      inventory: w.inventory,
      avgCost: w.avgCost,
      totalCost: w.totalCost,
      totalFees: w.totalFees,
      netPnl,
      fillCount: w.fillCount,
      correct,
      completedAt: new Date().toISOString(),
      lastPTrue: w.lastPTrue,
    });

    // Keep last 50 completed
    if (this.custom.completedWindows.length > 50) {
      this.custom.completedWindows = this.custom.completedWindows.slice(-50);
    }

    // D1 trade record for P&L
    if (w.inventory > 0) {
      try {
        ctx.db.prepare(
          `INSERT INTO strategy_trades (id, strategy_id, token_id, side, price, size, fee_amount, pnl, created_at)
           VALUES (?, ?, ?, 'RESOLVE', ?, ?, ?, ?, datetime('now'))`
        ).bind(
          `ct-res-${Date.now()}`,
          ctx.config.id,
          w.inventorySide === "UP" ? w.market.upTokenId : w.market.downTokenId,
          correct ? 1.0 : 0,
          w.inventory,
          w.totalFees,
          netPnl,
        ).run();
      } catch { /* non-critical */ }
    }

    const emoji = correct ? "✓" : "✗";
    ctx.log(
      `${emoji} ${w.market.title.slice(0, 60)} → ${outcome} | inv=${w.inventory.toFixed(0)} @ $${w.avgCost.toFixed(4)} | P&L=$${netPnl.toFixed(2)}`,
      { level: "trade", symbol: w.cryptoSymbol, direction: outcome === "UNKNOWN" ? undefined : outcome }
    );
  }

  private getParams(ctx: StrategyContext): CertaintyTakerParams {
    return { ...DEFAULT_PARAMS, ...ctx.config.params } as CertaintyTakerParams;
  }
}

// ── Register ─────────────────────────────────────────────────────────

registerStrategy("certainty-taker", () => new CertaintyTakerStrategy());
