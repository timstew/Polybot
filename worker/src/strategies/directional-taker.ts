/**
 * Directional Taker Strategy — Laddering
 *
 * Active position management for Polymarket "Up or Down" 5-min crypto binary markets.
 * Uses live Binance prices to determine direction, then ladders in/out:
 *
 * Phase 1 (Entry): Buy both sides after observation, conviction side gets more size
 * Phase 2 (Active): Per-tick management — sell losing side while it has value,
 *                    scale into winning side if signal strengthens
 * Phase 3 (Wind-down): Dump remaining losing side, hold winners to resolution
 * Phase 4 (Resolution): Winners pay $1.00, losers = $0, account for mid-window sells
 */

import type { Strategy, StrategyContext } from "../strategy";
import { registerStrategy } from "../strategy";
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

// ── Types ────────────────────────────────────────────────────────────

interface WindowPosition {
  market: CryptoMarket;
  cryptoSymbol: string;
  windowOpenTime: number;
  windowEndTime: number;
  priceAtWindowOpen: number; // Binance ref price
  enteredAt: number;
  convictionSide: "UP" | "DOWN" | null;
  signalStrengthAtEntry: number;
  // Hysteresis
  confirmedDirection: "UP" | "DOWN" | null; // direction after dead zone filtering
  flipCount: number;
  lastDirectionChangeAt: number;
  // Inventory tracking (ladder positions)
  upInventory: number;
  upAvgCost: number; // weighted avg cost basis
  downInventory: number;
  downAvgCost: number;
  // Realized P&L from mid-window sells
  realizedSellPnl: number;
  totalBuyCost: number; // all money spent buying (both sides)
  // Tracking
  buyCount: number;
  sellCount: number;
  lastManagedAt: number;
  phase: "observing" | "active" | "winding_down" | "resolved";
}

interface CompletedWindow {
  title: string;
  cryptoSymbol: string;
  convictionSide: "UP" | "DOWN" | null;
  outcome: "UP" | "DOWN" | "UNKNOWN";
  totalBuyCost: number;
  realizedSellPnl: number;
  winningPayout: number;
  losingLoss: number;
  netPnl: number;
  signalStrength: number;
  correct: boolean;
  completedAt: string;
  priceMovePct: number;
  upInventory: number;
  downInventory: number;
  upAvgCost: number;
  downAvgCost: number;
  buyCount: number;
  sellCount: number;
  flipCount: number;
}

interface TakerCustomState {
  activeWindows: WindowPosition[];
  completedWindows: CompletedWindow[];
  priceHistory: Record<string, PriceSnapshot[]>;
  windowRefPrices: Record<string, { price: number; recordedAt: number }>;
  totalPnl: number;
  windowsTraded: number;
  windowsWon: number;
  windowsLost: number;
  directionalAccuracy: number;
  perAsset: Record<string, { won: number; lost: number; pnl: number }>;
}

interface DirectionalTakerParams {
  target_cryptos: string[];
  initial_order_size: number; // size for initial entry per side
  conviction_multiplier: number; // multiplier for conviction side
  observation_seconds: number;
  min_signal_strength: number;
  max_capital_per_window: number;
  max_concurrent_windows: number;
  // Laddering params
  add_size: number; // size for additional buys mid-window
  min_exit_price: number; // don't sell losing side below this bid
  max_conviction_price: number; // don't buy winning side above this ask
  max_entry_sum: number; // skip market if bestUpAsk + bestDownAsk > this (prevents overpaying)
  sell_signal_threshold: number; // signal strength to trigger losing-side sell
  wind_down_before_end_ms: number; // start dumping losing side
  stop_entry_before_end_ms: number; // no more buys
  manage_interval_ms: number; // minimum ms between management actions per window
  fee_params: FeeParams;
  discovery_interval_ms: number;
  enable_order_flow: boolean;
  dead_zone_pct: number; // dead zone for hysteresis (overrides per-asset default)
  max_flips_per_window: number; // force wind-down after this many direction flips
}

const DEFAULT_PARAMS: DirectionalTakerParams = {
  target_cryptos: ["Bitcoin", "Ethereum", "Solana", "XRP"],
  initial_order_size: 40,
  conviction_multiplier: 1.7,
  observation_seconds: 20,
  min_signal_strength: 0.45,
  max_capital_per_window: 60,
  max_concurrent_windows: 4,
  add_size: 20,
  min_exit_price: 0.08,
  max_conviction_price: 0.65,
  max_entry_sum: 1.05, // UP ask + DOWN ask must be <= 1.05 to enter
  sell_signal_threshold: 0.4,
  wind_down_before_end_ms: 45_000,
  stop_entry_before_end_ms: 30_000,
  manage_interval_ms: 4_000, // manage every 4s (every other tick)
  fee_params: CRYPTO_FEES,
  discovery_interval_ms: 15_000,
  enable_order_flow: false,
  dead_zone_pct: 0, // 0 = use per-asset defaults from price-feed
  max_flips_per_window: 3,
};

// ── Strategy ─────────────────────────────────────────────────────────

class DirectionalTakerStrategy implements Strategy {
  name = "directional-taker";
  private custom: TakerCustomState = emptyCustom();
  private marketCache: CryptoMarket[] = [];
  private lastDiscovery = 0;

  async init(ctx: StrategyContext): Promise<void> {
    const stored = ctx.state.custom as Partial<TakerCustomState>;
    this.custom = {
      ...emptyCustom(),
      ...stored,
      activeWindows: stored.activeWindows || [],
      completedWindows: stored.completedWindows || [],
      priceHistory: stored.priceHistory || {},
      windowRefPrices: stored.windowRefPrices || {},
    };
    const params = {
      ...DEFAULT_PARAMS,
      ...ctx.config.params,
    } as DirectionalTakerParams;
    if (params.enable_order_flow) {
      const symbols = params.target_cryptos
        .map((c) => CRYPTO_SYMBOL_MAP[c.toLowerCase()])
        .filter(Boolean) as string[];
      enableOrderFlow(symbols);
      ctx.log(`Order flow enabled for: ${symbols.join(", ")}`);
    }
    ctx.log(
      `Initialized: ${this.custom.activeWindows.length} active, ${this.custom.windowsTraded} traded, acc=${(this.custom.directionalAccuracy * 100).toFixed(0)}%`
    );
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const params = {
      ...DEFAULT_PARAMS,
      ...ctx.config.params,
    } as DirectionalTakerParams;
    const now = Date.now();

    // 1. Discover markets
    if (now - this.lastDiscovery > params.discovery_interval_ms) {
      this.marketCache = await discoverCryptoMarkets(
        params.target_cryptos,
        params.stop_entry_before_end_ms + 30_000
      );
      this.lastDiscovery = now;
      if (this.marketCache.length > 0) {
        ctx.log(`Discovered ${this.marketCache.length} markets`);
      }
    }

    // 2. Fetch prices for all active symbols
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
        if (!this.custom.priceHistory[sym])
          this.custom.priceHistory[sym] = [];
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

    // 3. Manage active windows (laddering)
    await this.manageWindows(ctx, params);

    // 4. Enter new windows
    if (this.custom.activeWindows.length < params.max_concurrent_windows) {
      await this.enterWindows(ctx, params);
    }

    // 5. Resolve completed windows
    await this.resolveWindows(ctx, params);

    // 6. Persist state
    ctx.state.custom = this.custom as unknown as Record<string, unknown>;
    ctx.state.capital_deployed = this.custom.activeWindows.reduce(
      (sum, w) => sum + w.totalBuyCost - w.realizedSellPnl,
      0
    );
    ctx.state.total_pnl = this.custom.totalPnl;
  }

  async stop(ctx: StrategyContext): Promise<void> {
    const params = {
      ...DEFAULT_PARAMS,
      ...ctx.config.params,
    } as DirectionalTakerParams;
    if (params.enable_order_flow) {
      disableOrderFlow();
    }
    ctx.log(
      `Stopped: ${this.custom.activeWindows.length} active, ${this.custom.windowsTraded} traded, P&L=$${this.custom.totalPnl.toFixed(2)}`
    );
  }

  // ── Phase 2: Active Management (laddering) ────────────────────────

  private async manageWindows(
    ctx: StrategyContext,
    params: DirectionalTakerParams
  ): Promise<void> {
    const now = Date.now();

    for (const w of this.custom.activeWindows) {
      if (w.phase !== "active" && w.phase !== "winding_down") continue;
      if (now - w.lastManagedAt < params.manage_interval_ms) continue;

      const timeToEnd = w.windowEndTime - now;
      const history = this.custom.priceHistory[w.cryptoSymbol] || [];

      // Transition to wind-down phase
      if (
        timeToEnd < params.wind_down_before_end_ms &&
        w.phase === "active"
      ) {
        w.phase = "winding_down";
        ctx.log(
          `WIND DOWN: ${w.market.title.slice(0, 30)} ${timeToEnd / 1000 | 0}s left`
        );
      }

      // Get current signal with hysteresis
      const currentSnap = await fetchSpotPrice(w.cryptoSymbol);
      if (!currentSnap) continue;

      const timeSinceOpen = now - w.enteredAt;
      const signalOpts: ComputeSignalOptions = {
        prevDirection: w.confirmedDirection,
      };
      if (params.dead_zone_pct > 0) signalOpts.deadZonePct = params.dead_zone_pct;
      const signal = computeSignal(
        w.cryptoSymbol,
        w.priceAtWindowOpen,
        currentSnap.price,
        timeSinceOpen,
        history.filter((s) => s.timestamp >= w.enteredAt),
        signalOpts
      );

      // Periodic signal log (every ~5th tick per window)
      if (ctx.state.ticks % 5 === 0) {
        ctx.log(
          `SIGNAL: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} ${signal.direction} str=${(signal.signalStrength * 100).toFixed(0)}% chg=${signal.priceChangePct.toFixed(3)}% mom=${signal.momentum.toFixed(2)} vol=${signal.volatilityRegime} dz=${signal.inDeadZone} flips=${w.flipCount}`,
          { level: "signal", symbol: w.cryptoSymbol, direction: signal.direction, signalStrength: signal.signalStrength, priceChangePct: signal.priceChangePct, momentum: signal.momentum, volatilityRegime: signal.volatilityRegime, inDeadZone: signal.inDeadZone, flipCount: w.flipCount, upInventory: w.upInventory, downInventory: w.downInventory, phase: "manage" }
        );
      }

      // Detect confirmed direction flip (only when NOT in dead zone)
      if (
        w.confirmedDirection !== null &&
        signal.direction !== w.confirmedDirection &&
        !signal.inDeadZone
      ) {
        w.flipCount++;
        ctx.log(
          `FLIP #${w.flipCount}: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} ${w.confirmedDirection} -> ${signal.direction} raw=${signal.rawDirection} dz=${signal.inDeadZone}`,
          { level: "signal", symbol: w.cryptoSymbol, direction: signal.direction, signalStrength: signal.signalStrength, priceChangePct: signal.priceChangePct, momentum: signal.momentum, volatilityRegime: signal.volatilityRegime, inDeadZone: signal.inDeadZone, flipCount: w.flipCount, upInventory: w.upInventory, downInventory: w.downInventory, phase: "flip" }
        );
        w.confirmedDirection = signal.direction;
        w.convictionSide = signal.direction;
        w.lastDirectionChangeAt = now;

        // Max flips exceeded: force wind-down
        if (w.flipCount > params.max_flips_per_window && w.phase === "active") {
          w.phase = "winding_down";
          ctx.log(
            `MAX FLIPS (${w.flipCount}): ${w.market.title.slice(0, 25)} holding to resolution`,
            { level: "signal", symbol: w.cryptoSymbol, flipCount: w.flipCount, phase: "max_flips" }
          );
        }
      } else if (w.confirmedDirection === null) {
        // First direction assignment
        w.confirmedDirection = signal.direction;
      }

      // Determine current winning/losing sides based on confirmed direction
      const winningSide = w.confirmedDirection ?? signal.direction;
      const losingSide = winningSide === "UP" ? "DOWN" : "UP";
      const losingInventory =
        losingSide === "UP" ? w.upInventory : w.downInventory;
      const losingTokenId =
        losingSide === "UP" ? w.market.upTokenId : w.market.downTokenId;
      const winningTokenId =
        winningSide === "UP" ? w.market.upTokenId : w.market.downTokenId;

      // === SELL LOSING SIDE ===
      if (losingInventory > 0) {
        const shouldSell =
          w.phase === "winding_down" || // always sell in wind-down
          signal.signalStrength >= params.sell_signal_threshold; // strong enough signal

        if (shouldSell) {
          const losingBook = await ctx.api.getBook(losingTokenId);
          const bestBid =
            losingBook.bids.length > 0 ? losingBook.bids[0].price : 0;

          if (bestBid >= params.min_exit_price || w.phase === "winding_down") {
            const sellPrice = Math.max(bestBid, 0.01); // sell at any price in wind-down
            const sellSize =
              w.phase === "winding_down"
                ? losingInventory // dump everything
                : Math.min(losingInventory, params.add_size); // partial exit

            const result = await ctx.api.placeOrder({
              token_id: losingTokenId,
              side: "SELL",
              size: sellSize,
              price: sellPrice,
              market: w.market.slug,
              title: `${w.market.title} [SELL ${losingSide}]`,
            });

            if (result.status === "filled" && result.size > 0) {
              const soldSize = result.size;
              const soldPrice = result.price;
              const avgCost =
                losingSide === "UP" ? w.upAvgCost : w.downAvgCost;
              const sellRevenue = soldSize * soldPrice;
              const sellCostBasis = soldSize * avgCost;
              const sellFee =
                calcFeePerShare(soldPrice, params.fee_params) * soldSize;
              const sellPnl = sellRevenue - sellCostBasis - sellFee;

              w.realizedSellPnl += sellPnl;
              w.sellCount++;

              // Reduce inventory
              if (losingSide === "UP") {
                w.upInventory -= soldSize;
              } else {
                w.downInventory -= soldSize;
              }

              const phaseLabel =
                w.phase === "winding_down" ? "DUMP" : "SELL LOSING";
              ctx.log(
                `${phaseLabel}: ${w.market.title.slice(0, 25)} ${losingSide} ${soldSize}@${soldPrice.toFixed(3)} cost=${avgCost.toFixed(3)} pnl=$${sellPnl.toFixed(2)} | sig=${(signal.signalStrength * 100).toFixed(0)}% ${signal.direction}`
              );

              // Record sell trade in D1
              await ctx.db
                .prepare(
                  `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
                   VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
                )
                .bind(
                  `dt-sell-${crypto.randomUUID()}`,
                  ctx.config.id,
                  losingTokenId,
                  w.market.slug,
                  `${w.market.title} [${phaseLabel} ${losingSide}]`,
                  soldPrice,
                  soldSize,
                  sellFee,
                  sellPnl
                )
                .run();
            }
          }
        }
      }

      // === SCALE INTO WINNING SIDE (active phase only) ===
      if (
        w.phase === "active" &&
        signal.signalStrength >= params.sell_signal_threshold &&
        w.totalBuyCost < params.max_capital_per_window
      ) {
        const winningBook = await ctx.api.getBook(winningTokenId);
        const bestAsk =
          winningBook.asks.length > 0 ? winningBook.asks[0].price : 1;

        if (bestAsk <= params.max_conviction_price) {
          const addSize = Math.min(
            params.add_size,
            Math.floor(
              (params.max_capital_per_window - w.totalBuyCost) / bestAsk
            )
          );

          if (addSize >= 5) {
            const result = await ctx.api.placeOrder({
              token_id: winningTokenId,
              side: "BUY",
              size: addSize,
              price: bestAsk,
              market: w.market.slug,
              title: `${w.market.title} [ADD ${winningSide}]`,
            });

            if (result.status === "filled" && result.size > 0) {
              const boughtSize = result.size;
              const boughtPrice = result.price;
              const cost = boughtSize * boughtPrice;
              const fee =
                calcFeePerShare(boughtPrice, params.fee_params) * boughtSize;

              // Update inventory with weighted avg
              if (winningSide === "UP") {
                const oldCost = w.upInventory * w.upAvgCost;
                w.upInventory += boughtSize;
                w.upAvgCost =
                  w.upInventory > 0
                    ? (oldCost + cost) / w.upInventory
                    : boughtPrice;
              } else {
                const oldCost = w.downInventory * w.downAvgCost;
                w.downInventory += boughtSize;
                w.downAvgCost =
                  w.downInventory > 0
                    ? (oldCost + cost) / w.downInventory
                    : boughtPrice;
              }
              w.totalBuyCost += cost + fee;
              w.buyCount++;

              ctx.log(
                `ADD WINNING: ${w.market.title.slice(0, 25)} ${winningSide} +${boughtSize}@${boughtPrice.toFixed(3)} | total ${winningSide === "UP" ? w.upInventory : w.downInventory} | sig=${(signal.signalStrength * 100).toFixed(0)}%`
              );

              await ctx.db
                .prepare(
                  `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
                   VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
                )
                .bind(
                  `dt-add-${crypto.randomUUID()}`,
                  ctx.config.id,
                  winningTokenId,
                  w.market.slug,
                  `${w.market.title} [ADD ${winningSide}]`,
                  boughtPrice,
                  boughtSize,
                  fee
                )
                .run();
            }
          }
        }
      }

      w.lastManagedAt = now;
    }
  }

  // ── Phase 1: Enter new market windows ─────────────────────────────

  private async enterWindows(
    ctx: StrategyContext,
    params: DirectionalTakerParams
  ): Promise<void> {
    const now = Date.now();
    const activeConditions = new Set(
      this.custom.activeWindows.map((w) => w.market.conditionId)
    );
    const totalDeployed = this.custom.activeWindows.reduce(
      (s, w) => s + w.totalBuyCost,
      0
    );

    for (const market of this.marketCache) {
      if (this.custom.activeWindows.length >= params.max_concurrent_windows)
        break;
      if (activeConditions.has(market.conditionId)) continue;

      const sym = extractCryptoSymbol(market.title);
      if (!sym) continue;

      const endMs = new Date(market.endDate).getTime();
      const windowDuration = parseWindowDurationMs(market.title);
      const windowOpenTime = endMs - windowDuration;
      const timeToEnd = endMs - now;

      if (now < windowOpenTime) continue;
      if (timeToEnd < params.stop_entry_before_end_ms) continue;

      // Record reference price on first sight of this window
      const refKey = market.conditionId;
      const history = this.custom.priceHistory[sym] || [];
      const latestSnap =
        history.length > 0 ? history[history.length - 1] : null;

      if (!this.custom.windowRefPrices[refKey]) {
        if (!latestSnap) continue;
        this.custom.windowRefPrices[refKey] = {
          price: latestSnap.price,
          recordedAt: latestSnap.timestamp,
        };
        ctx.log(
          `REF: ${market.title.slice(0, 35)} ${sym}=$${latestSnap.price.toFixed(2)}, observing...`
        );
        continue;
      }

      const ref = this.custom.windowRefPrices[refKey];
      const openPrice = ref.price;
      const timeSinceRef = now - ref.recordedAt;
      if (timeSinceRef < params.observation_seconds * 1000) continue;

      // Compute signal
      const currentSnap = await fetchSpotPrice(sym);
      if (!currentSnap) continue;

      const signal = computeSignal(
        sym,
        openPrice,
        currentSnap.price,
        timeSinceRef,
        history.filter((s) => s.timestamp >= ref.recordedAt)
      );

      // Need minimum signal strength to enter
      if (signal.signalStrength < params.min_signal_strength) continue;

      const convictionSide = signal.direction;
      // Scale conviction multiplier by signal strength:
      // At min_signal_strength → multiplier = 1.0 (equal sizing, symmetric risk)
      // At strength = 1.0 → full configured multiplier
      const strengthRange = 1.0 - params.min_signal_strength;
      const strengthFraction = strengthRange > 0
        ? Math.min(1.0, (signal.signalStrength - params.min_signal_strength) / strengthRange)
        : 0;
      const scaledMultiplier = 1.0 + (params.conviction_multiplier - 1.0) * strengthFraction;
      const adjustedMultiplier = scaledMultiplier * signal.confidenceMultiplier;

      // Size: conviction side gets more (scaled by signal strength)
      let convictionSize = Math.round(
        params.initial_order_size * adjustedMultiplier
      );
      let hedgeSize = params.initial_order_size;

      // Fetch orderbooks
      const upTokenId = market.upTokenId;
      const downTokenId = market.downTokenId;
      const [upBook, downBook] = await Promise.all([
        ctx.api.getBook(upTokenId),
        ctx.api.getBook(downTokenId),
      ]);

      if (upBook.asks.length === 0 || downBook.asks.length === 0) continue;

      const bestUpAsk = upBook.asks[0].price;
      const bestDownAsk = downBook.asks[0].price;

      // Spread check: combined ask price must be reasonable for binary market
      if (bestUpAsk + bestDownAsk > params.max_entry_sum) {
        ctx.log(
          `SKIP SPREAD: ${market.title.slice(0, 30)} UP_ask=${bestUpAsk.toFixed(3)} DN_ask=${bestDownAsk.toFixed(3)} sum=${(bestUpAsk + bestDownAsk).toFixed(3)} > ${params.max_entry_sum}`
        );
        continue;
      }

      // Capital check
      const upSize = convictionSide === "UP" ? convictionSize : hedgeSize;
      const downSize = convictionSide === "DOWN" ? convictionSize : hedgeSize;
      const estimatedCost = bestUpAsk * upSize + bestDownAsk * downSize;
      if (estimatedCost > params.max_capital_per_window) {
        // Scale down to fit
        const scale = params.max_capital_per_window / estimatedCost;
        convictionSize = Math.max(5, Math.round(convictionSize * scale));
        hedgeSize = Math.max(5, Math.round(hedgeSize * scale));
      }
      if (totalDeployed + estimatedCost > ctx.config.max_capital_usd) continue;

      const finalUpSize =
        convictionSide === "UP" ? convictionSize : hedgeSize;
      const finalDownSize =
        convictionSide === "DOWN" ? convictionSize : hedgeSize;

      // SWEEP: buy both sides
      const [upResult, downResult] = await Promise.all([
        ctx.api.placeOrder({
          token_id: upTokenId,
          side: "BUY",
          size: finalUpSize,
          price: bestUpAsk,
          market: market.slug,
          title: `${market.title} [ENTRY UP]`,
        }),
        ctx.api.placeOrder({
          token_id: downTokenId,
          side: "BUY",
          size: finalDownSize,
          price: bestDownAsk,
          market: market.slug,
          title: `${market.title} [ENTRY DN]`,
        }),
      ]);

      const upFilled = upResult.status === "filled";
      const downFilled = downResult.status === "filled";

      if (!upFilled && !downFilled) {
        ctx.log(
          `${market.title.slice(0, 35)}: neither side filled, skipping`
        );
        continue;
      }

      const actUpSize = upFilled ? upResult.size : 0;
      const actDownSize = downFilled ? downResult.size : 0;
      const actUpPrice = upFilled ? upResult.price : bestUpAsk;
      const actDownPrice = downFilled ? downResult.price : bestDownAsk;
      const upCost = actUpSize * actUpPrice;
      const downCost = actDownSize * actDownPrice;
      const upFee =
        calcFeePerShare(actUpPrice, params.fee_params) * actUpSize;
      const downFee =
        calcFeePerShare(actDownPrice, params.fee_params) * actDownSize;

      const window: WindowPosition = {
        market,
        cryptoSymbol: sym,
        windowOpenTime,
        windowEndTime: endMs,
        priceAtWindowOpen: openPrice,
        enteredAt: now,
        convictionSide,
        signalStrengthAtEntry: signal.signalStrength,
        confirmedDirection: convictionSide,
        flipCount: 0,
        lastDirectionChangeAt: now,
        upInventory: actUpSize,
        upAvgCost: actUpPrice,
        downInventory: actDownSize,
        downAvgCost: actDownPrice,
        realizedSellPnl: 0,
        totalBuyCost: upCost + downCost + upFee + downFee,
        buyCount: (upFilled ? 1 : 0) + (downFilled ? 1 : 0),
        sellCount: 0,
        lastManagedAt: now,
        phase: "active",
      };

      this.custom.activeWindows.push(window);

      const convLabel = `${convictionSide}@${(signal.signalStrength * 100).toFixed(0)}%`;
      const upDepth = upBook.asks.reduce((s, l) => s + l.size, 0);
      const downDepth = downBook.asks.reduce((s, l) => s + l.size, 0);
      const flowStr = signal.orderFlowAvailable
        ? ` flow=${signal.orderFlowImbalance.toFixed(2)}`
        : "";

      ctx.log(
        `ENTERED: ${market.title.slice(0, 30)} ${sym} ${signal.priceChangePct >= 0 ? "+" : ""}${signal.priceChangePct.toFixed(3)}% mom=${signal.momentum.toFixed(2)} vol=${signal.volatilityRegime} confX=${signal.confidenceMultiplier.toFixed(1)}${flowStr} | UP=${actUpSize}@${actUpPrice.toFixed(3)} DN=${actDownSize}@${actDownPrice.toFixed(3)} | depth UP=${upDepth.toFixed(0)} DN=${downDepth.toFixed(0)} | conv=${convLabel} cost=$${window.totalBuyCost.toFixed(2)}`,
        { level: "signal", symbol: sym, direction: convictionSide, signalStrength: signal.signalStrength, priceChangePct: signal.priceChangePct, momentum: signal.momentum, volatilityRegime: signal.volatilityRegime, inDeadZone: false, flipCount: 0, upInventory: actUpSize, downInventory: actDownSize, phase: "entry" }
      );

      // Record entry trades in D1
      if (upFilled) {
        await ctx.db
          .prepare(
            `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
             VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
          )
          .bind(
            `dt-up-${crypto.randomUUID()}`,
            ctx.config.id,
            upTokenId,
            market.slug,
            `${market.title} [ENTRY UP ${convLabel}]`,
            actUpPrice,
            actUpSize,
            upFee
          )
          .run();
      }
      if (downFilled) {
        await ctx.db
          .prepare(
            `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
             VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), 0)`
          )
          .bind(
            `dt-dn-${crypto.randomUUID()}`,
            ctx.config.id,
            downTokenId,
            market.slug,
            `${market.title} [ENTRY DN ${convLabel}]`,
            actDownPrice,
            actDownSize,
            downFee
          )
          .run();
      }
    }
  }

  // ── Phase 4: Resolve completed windows ────────────────────────────

  private async resolveWindows(
    ctx: StrategyContext,
    params: DirectionalTakerParams
  ): Promise<void> {
    const now = Date.now();
    const toRemove: number[] = [];

    for (let i = 0; i < this.custom.activeWindows.length; i++) {
      const w = this.custom.activeWindows[i];
      // Try resolution at +10s (Polymarket primary), Binance fallback at +30s
      if (now < w.windowEndTime + 10_000) continue;

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
      // Also capture final price for priceMovePct logging
      let finalPrice: number | null = null;
      const history = this.custom.priceHistory[w.cryptoSymbol] || [];
      finalPrice = findPriceAtTime(history, w.windowEndTime);
      if (!finalPrice) {
        const snap = await fetchSpotPrice(w.cryptoSymbol);
        finalPrice = snap?.price ?? null;
      }

      if (outcome === "UNKNOWN") {
        if (now < w.windowEndTime + 30_000) continue; // wait longer for Polymarket
        // Binance fallback
        if (finalPrice !== null && w.priceAtWindowOpen > 0) {
          outcome = finalPrice >= w.priceAtWindowOpen ? "UP" : "DOWN";
          ctx.log(
            `RESOLUTION FALLBACK: ${w.market.title.slice(0, 25)} Polymarket not resolved, using Binance=${outcome}`
          );
        }
      }

      // P&L calculation:
      // Winning side: remaining inventory pays $1.00 each
      // Losing side: remaining inventory = $0
      // Plus realized sells already booked
      let winningPayout = 0;
      let losingLoss = 0;

      if (outcome !== "UNKNOWN") {
        const winInv = outcome === "UP" ? w.upInventory : w.downInventory;
        const winCost = outcome === "UP" ? w.upAvgCost : w.downAvgCost;
        const loseInv = outcome === "UP" ? w.downInventory : w.upInventory;
        const loseCost = outcome === "UP" ? w.downAvgCost : w.upAvgCost;

        // Winning shares pay $1.00 minus exit fee
        const payoutFee =
          calcFeePerShare(1.0, params.fee_params) * winInv;
        winningPayout = winInv * (1.0 - winCost) - payoutFee;

        // Losing shares still held = total loss
        losingLoss = -(loseInv * loseCost);
      }

      const netPnl = winningPayout + losingLoss + w.realizedSellPnl;
      const correct =
        outcome !== "UNKNOWN" && w.convictionSide === outcome;

      const priceMovePct =
        finalPrice !== null && w.priceAtWindowOpen > 0
          ? ((finalPrice - w.priceAtWindowOpen) / w.priceAtWindowOpen) * 100
          : 0;

      const completed: CompletedWindow = {
        title: w.market.title,
        cryptoSymbol: w.cryptoSymbol,
        convictionSide: w.convictionSide,
        outcome,
        totalBuyCost: w.totalBuyCost,
        realizedSellPnl: w.realizedSellPnl,
        winningPayout,
        losingLoss,
        netPnl,
        signalStrength: w.signalStrengthAtEntry,
        correct,
        completedAt: new Date().toISOString(),
        priceMovePct,
        upInventory: w.upInventory,
        downInventory: w.downInventory,
        upAvgCost: w.upAvgCost,
        downAvgCost: w.downAvgCost,
        buyCount: w.buyCount,
        sellCount: w.sellCount,
        flipCount: w.flipCount,
      };

      this.custom.completedWindows.push(completed);
      if (this.custom.completedWindows.length > 50) {
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
        this.custom.perAsset[w.cryptoSymbol] = { won: 0, lost: 0, pnl: 0 };
      }
      const asset = this.custom.perAsset[w.cryptoSymbol];
      if (correct) asset.won++;
      else if (outcome !== "UNKNOWN") asset.lost++;
      asset.pnl += netPnl;

      const outcomeLabel =
        outcome === "UNKNOWN"
          ? "UNKNOWN"
          : `${outcome} ${correct ? "CORRECT" : "WRONG"}`;

      ctx.log(
        `RESOLVED: ${w.market.title.slice(0, 25)} ${w.cryptoSymbol} ${priceMovePct >= 0 ? "+" : ""}${priceMovePct.toFixed(3)}% → ${outcomeLabel} | inv UP=${w.upInventory} DN=${w.downInventory} buys=${w.buyCount} sells=${w.sellCount} flips=${w.flipCount} | win=$${winningPayout.toFixed(2)} lose=$${losingLoss.toFixed(2)} sells=$${w.realizedSellPnl.toFixed(2)} net=$${netPnl.toFixed(2)} | W/L=${this.custom.windowsWon}/${this.custom.windowsLost}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: outcome === "UNKNOWN" ? undefined : outcome, signalStrength: w.signalStrengthAtEntry, flipCount: w.flipCount, upInventory: w.upInventory, downInventory: w.downInventory, phase: "resolve" }
      );

      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'RESOLVE', 0, 0, 0, datetime('now'), ?)`
        )
        .bind(
          `dt-resolve-${crypto.randomUUID()}`,
          ctx.config.id,
          w.market.conditionId,
          w.market.slug,
          `${w.market.title} [${outcomeLabel} conv=${w.convictionSide || "?"}]`,
          netPnl
        )
        .run();

      toRemove.push(i);
    }

    for (const idx of toRemove.reverse()) {
      const removed = this.custom.activeWindows.splice(idx, 1)[0];
      delete this.custom.windowRefPrices[removed.market.conditionId];
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function emptyCustom(): TakerCustomState {
  return {
    activeWindows: [],
    completedWindows: [],
    priceHistory: {},
    windowRefPrices: {},
    totalPnl: 0,
    windowsTraded: 0,
    windowsWon: 0,
    windowsLost: 0,
    directionalAccuracy: 0,
    perAsset: {},
  };
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

// ── Register ─────────────────────────────────────────────────────────

registerStrategy("directional-taker", () => new DirectionalTakerStrategy());
