/**
 * Avellaneda Maker Strategy
 *
 * Mutated Avellaneda-Stoikov market maker for Polymarket binary contracts.
 * NOT classic AS — adapted with 4 Polymarket-specific mutations:
 *
 * 1. TERMINAL TIME: Delta-based kill switch (not smooth time-decay).
 *    Near-expiry quotes are death traps for latency-arb bots.
 *
 * 2. BOUNDED PRICES: Quotes clamped to [0.01, 0.99] with regime switching.
 *    When P_true > 0.86, switch from maker to taker (FAK sweeps).
 *
 * 3. DELTA-BASED SPREAD: First-principles adverse selection cost, not raw BTC vol.
 *    s_eff = max(base_spread, 2 × |δ| × E_move + edge_per_share)
 *
 * 4. MERGE EXPLOIT: CTF merge for instant inventory reset. γ only penalizes
 *    unmatched inventory, enabling aggressive two-sided quoting.
 */

import type { Strategy, StrategyContext, OrderBook, PlaceOrderResult } from "../strategy";
import { registerStrategy, safeCancelOrder } from "../strategy";
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
  realtimeVolatility,
  estimateVolatility5min,
  roundShares,
  enableOrderFlow,
  disableOrderFlow,
  getOrderFlowSignal,
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
import { tryMerge } from "./merge";

// ── Types ────────────────────────────────────────────────────────────

type WindowRegime = "maker" | "taker" | "transition" | "danger_zone" | "delta_kill" | "time_kill";

interface AvellanedaWindow {
  market: CryptoMarket;
  cryptoSymbol: string;
  strikePrice: number | null;       // null until oracle confirms
  strikeDirection: "above" | "below";
  windowEndTime: number;
  windowOpenTime: number;
  windowDurationMs: number;

  // Fair value tracking
  lastPTrue: number;
  lastDelta: number;
  lastSpotPrice: number;
  lastReservationPrice: number;
  lastEffectiveSpread: number;

  // Orders (both sides, GTC resting)
  upBidOrderId: string | null;
  upBidPrice: number;
  upBidSize: number;
  downBidOrderId: string | null;
  downBidPrice: number;
  downBidSize: number;

  // Spot at quote time (for smart cancellation)
  spotAtQuoteTime: number;

  // Inventory
  upInventory: number;
  upAvgCost: number;
  downInventory: number;
  downAvgCost: number;

  // Merge tracking
  totalMerged: number;
  mergedPnl: number;

  // Stats
  fillCount: number;
  sellCount: number;
  spreadsCaptured: number;
  realizedPnl: number;
  totalBuyCost: number;
  tickAction: string;

  // Taker mode stats
  takerFills: number;
  takerCost: number;

  // Defensive
  lastShockAt: number;
  regime: WindowRegime;
  lastRealizedVol: number;

  // Resolution
  binancePrediction?: "UP" | "DOWN" | null;
}

interface CompletedAvellanedaWindow {
  title: string;
  cryptoSymbol: string;
  outcome: "UP" | "DOWN" | "UNKNOWN";
  upInventory: number;
  downInventory: number;
  upAvgCost: number;
  downAvgCost: number;
  pairCost: number | null;
  matchedPairs: number;
  totalMerged: number;
  mergedPnl: number;
  totalBuyCost: number;
  realizedPnl: number;
  winningPayout: number;
  losingLoss: number;
  netPnl: number;
  fillCount: number;
  sellCount: number;
  takerFills: number;
  completedAt: string;
}

interface AvellanedaCustomState {
  activeWindows: AvellanedaWindow[];
  completedWindows: CompletedAvellanedaWindow[];
  priceHistory: Record<string, PriceSnapshot[]>;
  totalPnl: number;
  totalFills: number;
  totalMerges: number;
  windowsTraded: number;
  windowsWon: number;
  windowsLost: number;
  scanStatus: string;
}

interface AvellanedaMakerParams {
  target_cryptos: string[];
  gamma: number;
  base_spread: number;
  edge_per_share: number;
  delta_kill_threshold: number; // normalized: |δ|×S×0.01 — P_true shift per 1% spot move
  api_cancel_latency_ms: number;
  max_inventory_per_side: number;
  max_capital_per_window: number;
  max_concurrent_windows: number;
  max_pair_cost: number;
  bid_size: number;
  merge_threshold: number;
  exit_buffer_ms: number;
  danger_zone_ms: number;
  maker_to_taker_threshold: number;
  taker_to_maker_threshold: number;
  vol_ema_window_s: number;
  shock_imbalance_threshold: number;
  fee_params: FeeParams;
  discovery_interval_ms: number;
  use_clob_websocket: boolean;
  enable_order_flow: boolean;
  // Taker mode params (when regime switches)
  taker_min_ev_per_share: number;
  taker_min_level_size: number;
  taker_max_price: number;          // never buy above this price
  taker_max_shares_per_sweep: number; // cap shares per tick
  taker_min_edge_pct: number;       // min edge as % of cost
}

const DEFAULT_PARAMS: AvellanedaMakerParams = {
  target_cryptos: ["Bitcoin", "Ethereum", "Solana", "XRP"],
  gamma: 0.005,
  base_spread: 0.04,
  edge_per_share: 0.005,
  delta_kill_threshold: 5.0,   // |δ|×S×0.01 — P_true shift per 1% spot move
  api_cancel_latency_ms: 100,
  max_inventory_per_side: 200,
  max_capital_per_window: 500,
  max_concurrent_windows: 8,
  max_pair_cost: 0.96,
  bid_size: 20,
  merge_threshold: 500,
  exit_buffer_ms: 60_000,
  danger_zone_ms: 120_000,
  maker_to_taker_threshold: 0.86,
  taker_to_maker_threshold: 0.83,
  vol_ema_window_s: 60,
  shock_imbalance_threshold: 0.70,
  fee_params: CRYPTO_FEES,
  discovery_interval_ms: 15_000,
  use_clob_websocket: true,
  enable_order_flow: true,
  taker_min_ev_per_share: 0.001,
  taker_min_level_size: 5,
  taker_max_price: 0.95,
  taker_max_shares_per_sweep: 50,
  taker_min_edge_pct: 0.01,
};

function emptyCustom(): AvellanedaCustomState {
  return {
    activeWindows: [],
    completedWindows: [],
    priceHistory: {},
    totalPnl: 0,
    totalFills: 0,
    totalMerges: 0,
    windowsTraded: 0,
    windowsWon: 0,
    windowsLost: 0,
    scanStatus: "Starting up…",
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ── Strategy ─────────────────────────────────────────────────────────

class AvellanedaMakerStrategy implements Strategy {
  name = "avellaneda-maker";
  private custom: AvellanedaCustomState = emptyCustom();
  private marketCache: CryptoMarket[] = [];
  private lastDiscovery = 0;
  private wsAvailable = true; // false if cross-DO I/O blocks WebSocket access

  async init(ctx: StrategyContext): Promise<void> {
    const existing = ctx.state.custom as unknown as AvellanedaCustomState | undefined;
    if (existing?.activeWindows) {
      this.custom = existing;
      if (!this.custom.completedWindows) this.custom.completedWindows = [];
    }
    const params = this.getParams(ctx);

    // WebSocket features may fail in CF Workers when another DO owns the connection
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
    ctx.log(`Avellaneda Maker initialized: γ=${params.gamma}, spread=${params.base_spread}, cryptos=${params.target_cryptos.join(",")}`);
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

      if (params.use_clob_websocket && this.wsAvailable) {
        try {
          const allTokens = discovered.flatMap((m) => [m.upTokenId, m.downTokenId]);
          if (allTokens.length > 0) subscribeClobTokens(allTokens);
        } catch { this.wsAvailable = false; }
      }

      for (const market of discovered) {
        const symbol = extractCryptoSymbol(market.title);
        if (!symbol) continue;
        if (this.custom.activeWindows.some((w) => w.market.conditionId === market.conditionId)) continue;
        if (this.custom.activeWindows.length >= params.max_concurrent_windows) break;
        if (ctx.windingDown) break;

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

        // Global capital check: respect framework-capped max_capital_usd (balance protection)
        const totalDeployedGlobal = this.custom.activeWindows.reduce(
          (sum, w) => sum + w.totalBuyCost, 0
        );
        if (totalDeployedGlobal >= ctx.config.max_capital_usd) break;

        // For explicit "above $X" markets: use parsed strike
        // For "Up or Down" markets: start with null strike, fetch oracle price later
        const strike = market.strikePrice;
        const direction = market.strikeDirection ?? "above";

        this.custom.activeWindows.push(this.createWindow(market, symbol, windowEndTime, durationMs, strike, direction));
      }
      this.custom.scanStatus = `${this.marketCache.length} markets, ${this.custom.activeWindows.length} windows`;
    }

    // ── Process each window ──
    const resolvedWindows: AvellanedaWindow[] = [];

    for (const w of this.custom.activeWindows) {
      const timeRemaining = w.windowEndTime - now;

      // ── Resolution check ──
      if (timeRemaining <= 0) {
        // Cancel any resting orders
        await this.cancelAllOrders(ctx, w);
        const resolution = await checkMarketResolution(
          w.market.slug, w.market.upTokenId, w.market.downTokenId
        );
        if (resolution.closed && resolution.outcome) {
          this.resolveWindow(ctx, w, resolution.outcome);
          resolvedWindows.push(w);
          continue;
        }
        if (timeRemaining < -1800_000) {
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

      // Wind-down: don't enter new windows, only manage existing
      if (ctx.windingDown && w.upInventory === 0 && w.downInventory === 0) {
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

      // Volatility from Binance (exchange-level data is better for raw σ)
      const vol = realtimeVolatility(history, params.vol_ema_window_s);
      w.lastRealizedVol = vol;

      // ── P_true + Delta (using oracle-aligned spot) ──
      const pTrue = calculatePTrue(spot, w.strikePrice, w.strikeDirection, timeRemaining, vol);
      const delta = calculateDelta(spot, w.strikePrice, w.strikeDirection, timeRemaining, vol);
      w.lastPTrue = pTrue;
      w.lastDelta = delta;

      // ── Gate 1: Delta kill switch (normalized by spot price) ──
      // |δ|×S×0.01 = how much P_true shifts on a 1% spot move
      const normalizedDelta = Math.abs(delta) * spot * 0.01;
      if (normalizedDelta > params.delta_kill_threshold) {
        await this.cancelAllOrders(ctx, w);
        w.regime = "delta_kill";
        // Near exit + delta kill → flatten
        if (timeRemaining < params.exit_buffer_ms) {
          await this.flattenInventory(ctx, w, params);
          w.regime = "time_kill";
        }
        // Delta-kill with 0 inventory in danger zone: release the slot
        // These windows will never recover — market moved too far, no fills to show for it
        if (w.upInventory === 0 && w.downInventory === 0 && timeRemaining < params.danger_zone_ms) {
          resolvedWindows.push(w);
          w.tickAction = `δ-KILL DROP (0 inv, ${(timeRemaining / 1000).toFixed(0)}s left)`;
          ctx.log(`DROP: ${w.market.title.slice(0, 35)} δ-kill with 0 inventory, freeing slot`, { symbol: w.cryptoSymbol });
          continue;
        }
        w.tickAction = `δ-KILL nδ=${normalizedDelta.toFixed(3)} > ${params.delta_kill_threshold}`;
        continue;
      }

      // ── Gate 2: Time kill switch ──
      if (timeRemaining < params.exit_buffer_ms) {
        await this.cancelAllOrders(ctx, w);
        await this.flattenInventory(ctx, w, params);
        w.regime = "time_kill";
        w.tickAction = `TIME KILL: ${(timeRemaining / 1000).toFixed(0)}s left, flattening`;
        continue;
      }

      // ── Gate 3: Danger zone (time backstop) ──
      const inDangerZone = timeRemaining < params.danger_zone_ms;

      // ── Gate 4: Order flow shock ──
      if (params.enable_order_flow && this.wsAvailable) {
        const flow = getOrderFlowSignal(w.cryptoSymbol);
        if (flow.available && Math.abs(flow.imbalance10s) > params.shock_imbalance_threshold) {
          await this.cancelAllOrders(ctx, w);
          w.lastShockAt = now;
          w.tickAction = `SHOCK: imbalance=${flow.imbalance10s.toFixed(2)}`;
          continue;
        }
      }

      // ── Gate 5: Regime switching with hysteresis ──
      const upperThreshold = params.maker_to_taker_threshold;
      const lowerThreshold = params.taker_to_maker_threshold;
      const inTakerZone = pTrue > upperThreshold || pTrue < (1 - upperThreshold);
      const inMakerZone = pTrue > lowerThreshold && pTrue < (1 - lowerThreshold)
        && pTrue < upperThreshold && pTrue > (1 - upperThreshold);

      if (w.regime === "taker") {
        // Currently in taker mode — revert to maker only when P_true returns to safe zone
        if (inMakerZone) {
          w.regime = "maker";
        }
      } else {
        // Currently in maker mode — switch to taker when P_true exceeds threshold
        if (inTakerZone) {
          await this.cancelAllOrders(ctx, w);
          w.regime = "taker";
        }
      }

      // ── TAKER MODE: sweep book on winning side ──
      if (w.regime === "taker") {
        // If too close to exit for taker, revert to maker/danger_zone
        // so we don't get stuck in limbo (can't take, can't make)
        const takerCutoff = params.exit_buffer_ms * 2;
        if (timeRemaining < takerCutoff) {
          w.regime = inDangerZone ? "danger_zone" : "maker";
          // Fall through to maker logic below
        } else {
          await this.executeTakerMode(ctx, w, params, spot, pTrue);
          continue;
        }
      }

      // ── Transition zone ──
      const inTransition = (pTrue > (1 - upperThreshold) && pTrue <= (1 - lowerThreshold))
        || (pTrue >= lowerThreshold && pTrue < upperThreshold
            && (pTrue > 0.80 || pTrue < 0.20));

      // ── MAKER MODE: two-sided quoting with AS shading ──

      // Net unmatched inventory (merge exploit: γ only on unmatched)
      const q = w.upInventory - w.downInventory;

      // Reservation price (inventory-shaded)
      const vr = pTrue - q * params.gamma;
      w.lastReservationPrice = vr;

      // First-principles spread from adverse selection cost
      const sigma = vol / 100; // convert from % to decimal
      const staleWindowMs = (ctx.config.tick_interval_ms || 2000) + params.api_cancel_latency_ms;
      const eMoveAbs = spot * sigma * Math.sqrt(staleWindowMs / 300_000);
      const minHalfSpread = Math.abs(delta) * eMoveAbs;
      let sEff = Math.max(params.base_spread, 2 * minHalfSpread + params.edge_per_share);

      // Danger zone: double spread, halve bid size
      let effectiveBidSize = params.bid_size;
      if (inDangerZone) {
        sEff *= 2;
        effectiveBidSize = Math.max(5, Math.floor(effectiveBidSize / 2));
        w.regime = "danger_zone";
      } else if (inTransition) {
        effectiveBidSize = Math.max(5, Math.floor(effectiveBidSize / 2));
        w.regime = "transition";
      } else {
        w.regime = "maker";
      }

      w.lastEffectiveSpread = sEff;

      // Bounded quotes
      let upBid = clamp(vr - sEff / 2, 0.01, 0.99);
      let dnBid = clamp((1 - vr) - sEff / 2, 0.01, 0.99);

      // ── Inventory caps ──
      const absQ = Math.abs(q);
      let skipUp = false;
      let skipDn = false;

      if (absQ > params.max_inventory_per_side) {
        // Only quote the offsetting side
        if (q > 0) skipUp = true; // too much UP, only quote DN
        else skipDn = true;        // too much DN, only quote UP
      }

      // ── Pair cost guards ──
      // Guard 1: Instantaneous bid sum cap
      if (upBid + dnBid > params.max_pair_cost) {
        const excess = (upBid + dnBid) - params.max_pair_cost;
        if (q > 0) {
          upBid = Math.max(0.01, upBid - excess);
        } else if (q < 0) {
          dnBid = Math.max(0.01, dnBid - excess);
        } else {
          upBid = Math.max(0.01, upBid - excess / 2);
          dnBid = Math.max(0.01, dnBid - excess / 2);
        }
      }
      // Guard 2: Cross-fill pair cost cap.
      // When we already hold one side, cap the other bid so the REALIZED
      // pair cost stays below max_pair_cost. This prevents the adverse
      // selection scenario where UP fills at high V and DN fills at low V.
      if (w.upInventory > 0 && w.upAvgCost > 0) {
        const maxDnBid = params.max_pair_cost - w.upAvgCost;
        if (dnBid > maxDnBid) dnBid = Math.max(0.01, maxDnBid);
      }
      if (w.downInventory > 0 && w.downAvgCost > 0) {
        const maxUpBid = params.max_pair_cost - w.downAvgCost;
        if (upBid > maxUpBid) upBid = Math.max(0.01, maxUpBid);
      }

      // Capital check: per-window AND global (framework-capped max_capital_usd respects balance protection)
      const windowDeployed = w.totalBuyCost + (w.upBidSize * w.upBidPrice) + (w.downBidSize * w.downBidPrice);
      if (windowDeployed >= params.max_capital_per_window) {
        w.tickAction = `capital full ($${windowDeployed.toFixed(2)})`;
        continue;
      }
      const globalDeployed = this.custom.activeWindows.reduce((sum, aw) => sum + aw.totalBuyCost, 0);
      if (globalDeployed >= ctx.config.max_capital_usd) {
        w.tickAction = `global capital full ($${globalDeployed.toFixed(0)}/$${ctx.config.max_capital_usd.toFixed(0)})`;
        continue;
      }

      // ── Smart order management (adverse-selection-based cancellation) ──
      const spotMove = Math.abs(spot - w.spotAtQuoteTime);
      const cancelThreshold = Math.abs(delta) > 0.0001
        ? (sEff / 2) / Math.abs(delta)
        : Infinity; // if delta ≈ 0, quotes barely need updating

      if (spotMove > cancelThreshold || w.upBidOrderId === null || w.downBidOrderId === null) {
        // Cancel stale orders
        await this.cancelAllOrders(ctx, w);

        // Place new orders
        if (!skipUp && upBid > 0.01) {
          const res = await ctx.api.placeOrder({
            token_id: w.market.upTokenId,
            side: "BUY",
            size: effectiveBidSize,
            price: upBid,
            market: w.market.conditionId,
            title: w.market.title,
          });
          if (res.status === "placed") {
            w.upBidOrderId = res.order_id;
            w.upBidPrice = upBid;
            w.upBidSize = effectiveBidSize;
          } else if (res.status === "filled") {
            this.handleFill(ctx, w, "UP", res.size, res.price, params);
          }
        }

        if (!skipDn && dnBid > 0.01) {
          const res = await ctx.api.placeOrder({
            token_id: w.market.downTokenId,
            side: "BUY",
            size: effectiveBidSize,
            price: dnBid,
            market: w.market.conditionId,
            title: w.market.title,
          });
          if (res.status === "placed") {
            w.downBidOrderId = res.order_id;
            w.downBidPrice = dnBid;
            w.downBidSize = effectiveBidSize;
          } else if (res.status === "filled") {
            this.handleFill(ctx, w, "DOWN", res.size, res.price, params);
          }
        }

        w.spotAtQuoteTime = spot;
      }

      // ── Check fills on resting orders ──
      if (w.upBidOrderId) {
        const status = await ctx.api.getOrderStatus(w.upBidOrderId);
        if (status.status === "MATCHED") {
          this.handleFill(ctx, w, "UP", status.size_matched, status.price, params);
          w.upBidOrderId = null;
        } else if (status.status === "CANCELLED") {
          w.upBidOrderId = null;
        }
      }
      if (w.downBidOrderId) {
        const status = await ctx.api.getOrderStatus(w.downBidOrderId);
        if (status.status === "MATCHED") {
          this.handleFill(ctx, w, "DOWN", status.size_matched, status.price, params);
          w.downBidOrderId = null;
        } else if (status.status === "CANCELLED") {
          w.downBidOrderId = null;
        }
      }

      // ── Merge check (CTF exploit — batched) ──
      if (timeRemaining > params.exit_buffer_ms) {
        const mergeResult = await tryMerge(ctx, w, params.merge_threshold);
        if (mergeResult) {
          w.totalMerged += mergeResult.merged;
          w.mergedPnl += mergeResult.pnl;
          w.realizedPnl += mergeResult.pnl;
          w.spreadsCaptured++;
          this.custom.totalMerges++;
          this.custom.totalPnl += mergeResult.pnl;
        }
      }

      w.tickAction = `${w.regime} V=${pTrue.toFixed(3)} Vr=${vr.toFixed(3)} δ=${delta.toFixed(5)} s=${sEff.toFixed(3)} q=${q.toFixed(0)} σ=${vol.toFixed(3)}%`;
    }

    // Remove resolved windows
    this.custom.activeWindows = this.custom.activeWindows.filter(
      (w) => !resolvedWindows.includes(w)
    );

    ctx.state.custom = this.custom as unknown as Record<string, unknown>;
    ctx.state.capital_deployed = this.custom.activeWindows.reduce(
      (sum, w) => sum + w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost, 0
    );
  }

  async stop(ctx: StrategyContext): Promise<void> {
    const params = this.getParams(ctx);
    // Cancel all resting orders
    for (const w of this.custom.activeWindows) {
      await this.cancelAllOrders(ctx, w);
    }
    if (params.enable_order_flow) disableOrderFlow();
    if (params.use_clob_websocket) disableClobFeed();
    ctx.log("Avellaneda Maker stopped");
  }

  // ── Helper: handle fill ──

  private handleFill(
    ctx: StrategyContext,
    w: AvellanedaWindow,
    side: "UP" | "DOWN",
    filledSize: number,
    fillPrice: number,
    params: AvellanedaMakerParams,
    isTaker = false,
  ): void {
    const size = roundShares(filledSize);
    // Maker fills (GTC resting bids) pay ZERO fee on Polymarket.
    // Only taker fills (FAK/FOK market orders) pay the dynamic fee.
    const fee = isTaker ? calcFeePerShare(fillPrice, params.fee_params) * size : 0;
    const cost = fillPrice * size + fee;

    if (side === "UP") {
      const prevTotal = w.upInventory * w.upAvgCost;
      w.upInventory = roundShares(w.upInventory + size);
      w.upAvgCost = w.upInventory > 0 ? (prevTotal + cost) / w.upInventory : 0;
    } else {
      const prevTotal = w.downInventory * w.downAvgCost;
      w.downInventory = roundShares(w.downInventory + size);
      w.downAvgCost = w.downInventory > 0 ? (prevTotal + cost) / w.downInventory : 0;
    }

    w.totalBuyCost += cost;
    w.fillCount++;
    this.custom.totalFills++;

    // D1 trade record
    const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
    try {
      ctx.db.prepare(
        `INSERT INTO strategy_trades (id, strategy_id, token_id, side, price, size, fee_amount, pnl, created_at)
         VALUES (?, ?, ?, 'BUY', ?, ?, ?, 0, datetime('now'))`
      ).bind(
        `am-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ctx.config.id, tokenId, fillPrice, size, fee,
      ).run();
    } catch { /* non-critical */ }
  }

  // ── Helper: taker mode (regime switch) ──

  private async executeTakerMode(
    ctx: StrategyContext,
    w: AvellanedaWindow,
    params: AvellanedaMakerParams,
    spot: number,
    pTrue: number,
  ): Promise<void> {
    if (w.strikePrice == null) return;
    // Determine winning side
    const isAbove = spot > w.strikePrice;
    const winningSide = w.strikeDirection === "above"
      ? (isAbove ? "UP" : "DOWN")
      : (isAbove ? "DOWN" : "UP");
    const winningTokenId = winningSide === "UP" ? w.market.upTokenId : w.market.downTokenId;
    const pWin = winningSide === "UP" ? pTrue : (1 - pTrue);

    // Capital check
    const remainingCapital = params.max_capital_per_window - w.totalBuyCost;
    if (remainingCapital <= 0) {
      w.tickAction = `taker: capital full`;
      return;
    }

    // Get book
    let book: OrderBook | null = null;
    if (params.use_clob_websocket && this.wsAvailable && isClobConnected()) {
      try { book = getClobBook(winningTokenId); } catch { this.wsAvailable = false; }
    }
    if (!book) {
      book = await ctx.api.getBook(winningTokenId);
    }
    if (!book || book.asks.length === 0) {
      w.tickAction = "taker: no asks";
      return;
    }

    // Find profitable levels (with risk controls)
    const sweeps: Promise<PlaceOrderResult>[] = [];
    let capitalUsed = 0;
    let sharesQueued = 0;

    for (const level of book.asks) {
      if (level.size < params.taker_min_level_size) continue;
      // Price cap: never buy above max price — limits worst-case loss per share
      if (level.price > params.taker_max_price) continue;
      const fee = calcFeePerShare(level.price, params.fee_params) * level.size;
      const cost = level.price * level.size + fee;
      const ev = pWin * level.size - cost;
      const edgePct = cost > 0 ? ev / cost : 0;
      if (ev <= 0 || ev / level.size < params.taker_min_ev_per_share) continue;
      // Edge % check: require meaningful edge relative to capital at risk
      if (edgePct < params.taker_min_edge_pct) continue;
      if (capitalUsed + cost > remainingCapital) break;
      // Share cap: limit total shares per sweep
      const cappedSize = Math.min(level.size, params.taker_max_shares_per_sweep - sharesQueued);
      if (cappedSize <= 0) break;

      sweeps.push(
        ctx.api.placeOrder({
          token_id: winningTokenId,
          side: "BUY",
          size: cappedSize,
          price: level.price,
          market: w.market.conditionId,
          title: w.market.title,
          order_type: "FAK",
        })
      );
      capitalUsed += level.price * cappedSize + calcFeePerShare(level.price, params.fee_params) * cappedSize;
      sharesQueued += cappedSize;
    }

    if (sweeps.length === 0) {
      w.tickAction = `taker: P=${pTrue.toFixed(3)} no profitable levels`;
      return;
    }

    const results = await Promise.all(sweeps);
    let totalFilled = 0;
    for (const res of results) {
      if (res.status === "filled" && res.size > 0) {
        this.handleFill(ctx, w, winningSide, res.size, res.price, params, true);
        totalFilled += res.size;
        w.takerFills++;
        w.takerCost += res.price * res.size;
      }
    }

    w.tickAction = `TAKER: swept ${totalFilled.toFixed(0)} ${winningSide} @ P=${pTrue.toFixed(3)}`;
    if (totalFilled > 0) {
      ctx.log(w.tickAction, { level: "trade", symbol: w.cryptoSymbol, direction: winningSide });
    }
  }

  // ── Helper: cancel all orders ──

  private async cancelAllOrders(ctx: StrategyContext, w: AvellanedaWindow): Promise<void> {
    if (w.upBidOrderId) {
      const result = await safeCancelOrder(ctx.api, w.upBidOrderId);
      if (result.fill) {
        this.handleFill(ctx, w, "UP", result.fill.size, result.fill.price, this.getParams(ctx));
      }
      if (result.cleared) w.upBidOrderId = null;
    }
    if (w.downBidOrderId) {
      const result = await safeCancelOrder(ctx.api, w.downBidOrderId);
      if (result.fill) {
        this.handleFill(ctx, w, "DOWN", result.fill.size, result.fill.price, this.getParams(ctx));
      }
      if (result.cleared) w.downBidOrderId = null;
    }
  }

  // ── Helper: flatten inventory (sell excess via FAK) ──

  private async flattenInventory(
    ctx: StrategyContext,
    w: AvellanedaWindow,
    params: AvellanedaMakerParams,
  ): Promise<void> {
    const q = w.upInventory - w.downInventory;
    if (Math.abs(q) < 5) return; // min order size

    if (q > 0) {
      // Too much UP — sell UP via FAK (buy DOWN would also work)
      const sellSize = Math.floor(Math.abs(q));
      if (sellSize >= 5) {
        const res = await ctx.api.placeOrder({
          token_id: w.market.upTokenId,
          side: "SELL",
          size: sellSize,
          price: 0.01, // aggressive sell
          market: w.market.conditionId,
          title: w.market.title,
          order_type: "FAK",
        });
        if (res.status === "filled" && res.size > 0) {
          const sold = roundShares(res.size);
          w.upInventory = roundShares(w.upInventory - sold);
          w.realizedPnl += (res.price - w.upAvgCost) * sold;
          w.sellCount++;
          ctx.log(`FLATTEN: sold ${sold} UP @ $${res.price.toFixed(4)}`, { level: "trade", symbol: w.cryptoSymbol });
        }
      }
    } else if (q < 0) {
      const sellSize = Math.floor(Math.abs(q));
      if (sellSize >= 5) {
        const res = await ctx.api.placeOrder({
          token_id: w.market.downTokenId,
          side: "SELL",
          size: sellSize,
          price: 0.01,
          market: w.market.conditionId,
          title: w.market.title,
          order_type: "FAK",
        });
        if (res.status === "filled" && res.size > 0) {
          const sold = roundShares(res.size);
          w.downInventory = roundShares(w.downInventory - sold);
          w.realizedPnl += (res.price - w.downAvgCost) * sold;
          w.sellCount++;
          ctx.log(`FLATTEN: sold ${sold} DN @ $${res.price.toFixed(4)}`, { level: "trade", symbol: w.cryptoSymbol });
        }
      }
    }
  }

  // ── Helper: resolve window ──

  private resolveWindow(
    ctx: StrategyContext,
    w: AvellanedaWindow,
    outcome: "UP" | "DOWN" | "UNKNOWN",
  ): void {
    // Cancel any remaining orders
    // (already cancelled in the main loop, but safety)

    const matched = Math.min(w.upInventory, w.downInventory);
    const upPayout = outcome === "UP" ? w.upInventory : 0;
    const dnPayout = outcome === "DOWN" ? w.downInventory : 0;
    const winningPayout = upPayout + dnPayout;

    const upLoss = outcome === "DOWN" ? w.upInventory * w.upAvgCost : 0;
    const dnLoss = outcome === "UP" ? w.downInventory * w.downAvgCost : 0;
    const losingLoss = upLoss + dnLoss;

    // P&L: winning inventory pays $1 each, losing pays $0, plus realized from sells/merges
    const resolutionPnl = winningPayout - (w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost);
    const totalNetPnl = resolutionPnl + w.realizedPnl;

    const pairCost = matched > 0 && w.upAvgCost > 0 && w.downAvgCost > 0
      ? w.upAvgCost + w.downAvgCost
      : null;

    this.custom.totalPnl += totalNetPnl;
    ctx.state.total_pnl += totalNetPnl;
    this.custom.windowsTraded++;
    if (totalNetPnl > 0) this.custom.windowsWon++;
    else if (totalNetPnl < 0) this.custom.windowsLost++;

    this.custom.completedWindows.push({
      title: w.market.title,
      cryptoSymbol: w.cryptoSymbol,
      outcome,
      upInventory: w.upInventory,
      downInventory: w.downInventory,
      upAvgCost: w.upAvgCost,
      downAvgCost: w.downAvgCost,
      pairCost,
      matchedPairs: matched,
      totalMerged: w.totalMerged,
      mergedPnl: w.mergedPnl,
      totalBuyCost: w.totalBuyCost,
      realizedPnl: w.realizedPnl,
      winningPayout,
      losingLoss,
      netPnl: totalNetPnl,
      fillCount: w.fillCount,
      sellCount: w.sellCount,
      takerFills: w.takerFills,
      completedAt: new Date().toISOString(),
    });

    if (this.custom.completedWindows.length > 50) {
      this.custom.completedWindows = this.custom.completedWindows.slice(-50);
    }

    // D1 resolution trade
    try {
      ctx.db.prepare(
        `INSERT INTO strategy_trades (id, strategy_id, token_id, side, price, size, fee_amount, pnl, created_at)
         VALUES (?, ?, ?, 'RESOLVE', 0, 0, 0, ?, datetime('now'))`
      ).bind(
        `am-res-${Date.now()}`, ctx.config.id, w.market.upTokenId, totalNetPnl,
      ).run();
    } catch { /* non-critical */ }

    const emoji = totalNetPnl >= 0 ? "✓" : "✗";
    ctx.log(
      `${emoji} ${w.market.title.slice(0, 50)} → ${outcome} | UP=${w.upInventory.toFixed(0)}@${w.upAvgCost.toFixed(3)} DN=${w.downInventory.toFixed(0)}@${w.downAvgCost.toFixed(3)} merged=${w.totalMerged} | P&L=$${totalNetPnl.toFixed(2)}`,
      { level: "trade", symbol: w.cryptoSymbol, direction: outcome === "UNKNOWN" ? undefined : outcome }
    );
  }

  // ── Helper: create window ──

  private createWindow(
    market: CryptoMarket,
    symbol: string,
    windowEndTime: number,
    durationMs: number,
    strike: number | null,
    direction: "above" | "below",
  ): AvellanedaWindow {
    return {
      market,
      cryptoSymbol: symbol,
      strikePrice: strike,
      strikeDirection: direction,
      windowDurationMs: durationMs,
      windowEndTime,
      windowOpenTime: windowEndTime - durationMs,
      lastPTrue: 0.5,
      lastDelta: 0,
      lastSpotPrice: 0,
      lastReservationPrice: 0.5,
      lastEffectiveSpread: 0,
      upBidOrderId: null,
      upBidPrice: 0,
      upBidSize: 0,
      downBidOrderId: null,
      downBidPrice: 0,
      downBidSize: 0,
      spotAtQuoteTime: 0,
      upInventory: 0,
      upAvgCost: 0,
      downInventory: 0,
      downAvgCost: 0,
      totalMerged: 0,
      mergedPnl: 0,
      fillCount: 0,
      sellCount: 0,
      spreadsCaptured: 0,
      realizedPnl: 0,
      totalBuyCost: 0,
      tickAction: "scanning",
      takerFills: 0,
      takerCost: 0,
      lastShockAt: 0,
      regime: "maker",
      lastRealizedVol: 0,
    };
  }

  private getParams(ctx: StrategyContext): AvellanedaMakerParams {
    return { ...DEFAULT_PARAMS, ...ctx.config.params } as AvellanedaMakerParams;
  }
}

// ── Register ─────────────────────────────────────────────────────────

registerStrategy("avellaneda-maker", () => new AvellanedaMakerStrategy());
