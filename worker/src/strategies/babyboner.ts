/**
 * BabyBoneR Strategy — Hybrid Liquidity Maker
 *
 * Evolved from Bonereaper analysis (see BONEREAPER-ANALYSIS.md):
 *   - Passive base: always-on GTC bids on both UP and DOWN sides
 *   - Active snipe: FOK taker orders on cheap asks (BabyBoneR's edge)
 *   - Merge/redeem exit (default): hold paired inventory to resolution,
 *     merge for $1.00, redeem winners. No sells, no wind-down.
 *   - Optional sell mode: mean-reversion sells + progressive liquidation
 *     (toggled via merge_exit=false for A/B testing)
 *
 * Key findings driving this design:
 *   - Bonereaper has ZERO sells across 10k+ trades (merge/redeem only)
 *   - 0s reaction lag = passive maker with resting GTC bids
 *   - 64% follows retail flow, 36% fades — not contrarian
 *   - Directional skew is emergent from taker flow, not intentional
 */

import type { Strategy, StrategyContext, OrderBook } from "../strategy";
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
  fetchOracleStrike,
  toOracleSymbol,
  toVariant,
  calculatePTrue,
  estimateVolatility5min,
  CRYPTO_SYMBOL_MAP,
  fetchTradeTape,
} from "./price-feed";
import {
  getOracleStrike as getOracleStrikeWs,
  isOracleConnected,
  getOracleSpot,
} from "./oracle-feed";
import {
  enableReactiveFeed,
  getReactiveSpot,
  hasPriceChanged,
  acknowledgePriceChange,
  disableReactiveFeed,
} from "./reactive-feed";
import { classifyRegime, computeRegimeFeatures } from "./regime";
import type { TickSnapshot, TapeBucket, TapeMeta } from "../optimizer/types";

// ── Types ────────────────────────────────────────────────────────────

export interface BabyBoneRParams {
  target_cryptos: string[];

  // Pricing — P_true-proportional (matches Bonereaper's dynamic pricing)
  // upBid = clamp(pTrue, p_floor, p_ceil) * target_pair_cost
  // dnBid = clamp(1-pTrue, p_floor, p_ceil) * target_pair_cost
  target_pair_cost: number;    // winning_bid + losing_bid target (~0.97)
  p_floor: number;             // min probability used for pricing (0.05)
  p_ceil: number;              // max probability used for pricing (0.92)

  // Bid sizing
  maker_bid_size: number;      // GTC resting bid size
  taker_bid_size: number;      // FOK taker order size
  taker_ask_discount: number;  // only take if ask <= our bid - discount

  // Exit mode
  merge_exit: boolean;           // true = hold to resolution, merge/redeem (Bonereaper-style)
                                 // false = sell-based mean-reversion + wind-down

  // Sell logic — only active when merge_exit=false
  sell_enabled: boolean;
  sell_profit_threshold: number;  // sell when market_price >= avg_cost + this
  sell_size: number;              // tokens per sell order
  sell_min_price: number;         // don't sell below this

  // Progressive liquidation — only active when merge_exit=false
  wind_down_seconds: number;     // start selling inventory N sec before end
  fire_sale_seconds: number;     // dump everything in last N sec
  fire_sale_min_price: number;   // absolute floor for fire-sale

  // Inventory limits
  max_inventory_per_side: number;
  max_total_cost: number;        // max $ committed per window
  max_skew_ratio: number;        // 0.75 = pause heavy side when ratio exceeds 75/25
  skew_guard_min_tokens: number; // min total tokens before skew guard activates

  // Market price guard — don't bid on sides the market values as near-worthless
  min_ask_to_bid: number;        // skip bidding when best ask < this (default 0.25)

  // Requote timing
  requote_interval_ms: number;   // min ms between requotes
  p_true_min_conviction: number; // don't trade when P_true near 0.50

  // Window management
  max_window_duration_ms: number;
  observation_seconds: number;
  max_concurrent_windows: number;
  discovery_interval_ms: number;

  // Snapshot recording
  record_snapshots: boolean;
  fee_params: FeeParams;
}

export const DEFAULT_PARAMS: BabyBoneRParams = {
  target_cryptos: ["Bitcoin"],

  // Pricing: near-fair-value market maker
  // Bonereaper's ACTUAL current fills: UP ~$0.53, DN ~$0.45-$0.60
  // NOT the $0.28/$0.70 from earlier analysis — they bid near 0.50 on both sides.
  // p_floor/p_ceil compress P_true to keep bids close enough to cross both sides.
  target_pair_cost: 0.98,      // Bonereaper PC: $1.00-$1.12 (varies)
  p_floor: 0.40,              // losing bids at ~$0.39 (crosses $0.40 asks)
  p_ceil: 0.60,               // winning bids at ~$0.59 (crosses $0.60 asks)

  maker_bid_size: 50,          // Bonereaper: 3-220 per fill, median 26, mean 45
  taker_bid_size: 25,          // aggressive taker for missing side
  taker_ask_discount: 0.02,    // legacy param, taker now takes at bid price

  merge_exit: true,             // Bonereaper-style: hold to resolution, merge/redeem

  sell_enabled: true,           // only used when merge_exit=false
  sell_profit_threshold: 0.05,
  sell_size: 10,
  sell_min_price: 0.10,

  wind_down_seconds: 180,       // only used when merge_exit=false
  fire_sale_seconds: 30,
  fire_sale_min_price: 0.03,

  max_inventory_per_side: 3000,  // Bonereaper goes 5000+ on winning side
  max_total_cost: 3000,          // Bonereaper deploys $5000+/window
  max_skew_ratio: 1.0,           // DISABLED — Bonereaper goes 97% one-sided when direction is clear
  skew_guard_min_tokens: 99999,  // disabled — market price guard handles safety
  min_ask_to_bid: 0.40,          // don't bid when market values side < $0.40 (prevents losing-side flooding)

  requote_interval_ms: 2000,    // requote every 2s (match tick rate)
  p_true_min_conviction: 0.50,  // always trade — Bonereaper trades at all conviction levels

  max_window_duration_ms: 15 * 60_000,
  observation_seconds: 3,
  max_concurrent_windows: 6,
  discovery_interval_ms: 30_000,

  record_snapshots: true,
  fee_params: CRYPTO_FEES,
};

// ── Window State ─────────────────────────────────────────────────────

interface BabyBoneRWindow {
  market: CryptoMarket;
  cryptoSymbol: string;
  windowOpenTime: number;
  windowEndTime: number;
  priceAtWindowOpen: number;
  oracleStrike: number | null;

  // Resting bids (GTC)
  upBidOrderId: string | null;
  upBidPrice: number;
  upBidSize: number;
  dnBidOrderId: string | null;
  dnBidPrice: number;
  dnBidSize: number;

  // Sell orders
  upSellOrderId: string | null;
  dnSellOrderId: string | null;

  // Inventory (FIFO avg cost)
  upInventory: number;
  upAvgCost: number;   // avg cost per token
  dnInventory: number;
  dnAvgCost: number;

  // Tracking
  fillCount: number;
  sellCount: number;
  totalBuyCost: number;
  totalSellRevenue: number;
  realizedSellPnl: number;
  enteredAt: number;
  lastRequoteAt: number;
  tickAction: string;

  // Signal tracking
  confirmedDirection: "UP" | "DOWN" | null;

  // Prediction at end
  binancePrediction?: "UP" | "DOWN" | null;

  // Snapshots
  tickSnapshots?: TickSnapshot[];
  snapshotId?: string;
  pendingFills?: Array<{ side: "UP" | "DOWN"; price: number; size: number }>;
  cumulativeTapeBuckets?: Map<string, number>;
  cumulativeTapeWallets?: Set<string>;
  cumulativeTapeVolume?: number;
  cumulativeTapeCount?: number;
  lastTapeTimestamp?: number;
}

interface CompletedWindow {
  title: string;
  cryptoSymbol: string;
  outcome: "UP" | "DOWN" | "UNKNOWN";
  upInventory: number;
  dnInventory: number;
  totalBuyCost: number;
  totalSellRevenue: number;
  realizedSellPnl: number;
  resolutionPnl: number;
  netPnl: number;
  fillCount: number;
  sellCount: number;
  completedAt: string;
  upAvgCost: number;
  dnAvgCost: number;
  gammaConfirmed: boolean;
  slug?: string;
  upTokenId?: string;
  downTokenId?: string;
}

interface CustomState {
  activeWindows: BabyBoneRWindow[];
  completedWindows: CompletedWindow[];
  priceHistory: Record<string, PriceSnapshot[]>;
  windowRefPrices: Record<string, { price: number; recordedAt: number }>;
  totalPnl: number;
  totalFills: number;
  totalSells: number;
  windowsTraded: number;
  windowsWon: number;
  windowsLost: number;
  perAsset: Record<string, { won: number; lost: number; pnl: number; fills: number }>;
  scanStatus: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function emptyCustom(): CustomState {
  return {
    activeWindows: [],
    completedWindows: [],
    priceHistory: {},
    windowRefPrices: {},
    totalPnl: 0,
    totalFills: 0,
    totalSells: 0,
    windowsTraded: 0,
    windowsWon: 0,
    windowsLost: 0,
    perAsset: {},
    scanStatus: "Starting up…",
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function toBinanceSymbol(crypto: string): string {
  const mapped = CRYPTO_SYMBOL_MAP[crypto.toLowerCase()];
  if (mapped) return mapped;
  const upper = crypto.toUpperCase();
  if (upper.endsWith("USDT")) return upper;
  if (upper.endsWith("USD")) return upper + "T";
  return upper + "USDT";
}

// ── Strategy ─────────────────────────────────────────────────────────

class BabyBoneRStrategy implements Strategy {
  name = "babyboner";
  private custom: CustomState = emptyCustom();
  private marketCache: CryptoMarket[] = [];
  private lastDiscovery = 0;
  private bookCache = new Map<string, { book: OrderBook; fetchedAt: number }>();

  private async getBookCached(ctx: StrategyContext, tokenId: string): Promise<OrderBook> {
    const now = Date.now();
    const cached = this.bookCache.get(tokenId);
    if (cached && now - cached.fetchedAt < 5_000) return cached.book;
    const book = await ctx.api.getBook(tokenId);
    this.bookCache.set(tokenId, { book, fetchedAt: now });
    return book;
  }

  private getBestAsk(book: OrderBook): number | null {
    if (book.asks.length === 0) return null;
    let best = book.asks[0].price;
    for (const a of book.asks) if (a.price < best) best = a.price;
    return best;
  }

  async init(ctx: StrategyContext): Promise<void> {
    const stored = ctx.state.custom as Partial<CustomState>;
    this.custom = {
      ...emptyCustom(),
      ...stored,
      activeWindows: stored.activeWindows || [],
      completedWindows: stored.completedWindows || [],
      priceHistory: stored.priceHistory || {},
      windowRefPrices: stored.windowRefPrices || {},
    };

    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as BabyBoneRParams;

    // Enable reactive Binance WebSocket feed
    const binanceSymbols = params.target_cryptos.map(toBinanceSymbol);
    enableReactiveFeed(binanceSymbols);

    ctx.log(
      `BabyBoneR initialized: ${this.custom.activeWindows.length} active, ${this.custom.totalFills} fills, ${this.custom.totalSells} sells`,
    );
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as BabyBoneRParams;
    const now = Date.now();

    // 1. Discover markets
    if (now - this.lastDiscovery > params.discovery_interval_ms) {
      const allMarkets = await discoverCryptoMarkets(params.target_cryptos, 30_000);
      // Only trade "Up or Down" markets (Bonereaper's target). Filter out "above/below" markets.
      this.marketCache = allMarkets.filter(m => /up or down/i.test(m.title));
      this.lastDiscovery = now;
    }

    // 2. Fetch prices — prefer reactive feed, fallback to REST
    const activeSymbols = new Set<string>();
    for (const m of this.marketCache) {
      const sym = extractCryptoSymbol(m.title);
      if (sym) activeSymbols.add(sym);
    }
    for (const w of this.custom.activeWindows) activeSymbols.add(w.cryptoSymbol);

    for (const sym of activeSymbols) {
      // Try reactive feed first
      const reactive = getReactiveSpot(sym);
      if (reactive) {
        if (!this.custom.priceHistory[sym]) this.custom.priceHistory[sym] = [];
        this.custom.priceHistory[sym].push({
          symbol: sym,
          price: reactive.price,
          timestamp: reactive.timestamp,
          source: "binance",
        });
      } else {
        // Fallback to REST
        const snap = await fetchSpotPrice(sym);
        if (snap) {
          if (!this.custom.priceHistory[sym]) this.custom.priceHistory[sym] = [];
          this.custom.priceHistory[sym].push(snap);
        }
      }
      // Trim history
      if (this.custom.priceHistory[sym]?.length > 60) {
        this.custom.priceHistory[sym] = this.custom.priceHistory[sym].slice(-60);
      }
    }

    // Prune stale symbols
    for (const sym of Object.keys(this.custom.priceHistory)) {
      if (!activeSymbols.has(sym)) delete this.custom.priceHistory[sym];
    }

    // 3. Manage active windows (quote, fill check, sells, wind-down)
    await this.manageWindows(ctx, params);

    // 4. Enter new windows (skip when winding down)
    if (!ctx.windingDown && this.custom.activeWindows.length < params.max_concurrent_windows) {
      await this.enterWindows(ctx, params);
    }

    // 5. Resolve completed windows
    await this.resolveWindows(ctx, params);

    // 6. Wind-down: drop empty windows
    if (ctx.windingDown) {
      const before = this.custom.activeWindows.length;
      this.custom.activeWindows = this.custom.activeWindows.filter(
        w => w.upInventory + w.dnInventory > 0 || w.totalBuyCost > 0,
      );
      if (this.custom.activeWindows.length < before) {
        ctx.log(`Wind-down: dropped ${before - this.custom.activeWindows.length} empty window(s)`);
      }
    }

    // 7. Scan status
    const totalInv = this.custom.activeWindows.reduce(
      (s, w) => s + w.upInventory + w.dnInventory, 0,
    );
    if (ctx.windingDown) {
      this.custom.scanStatus = this.custom.activeWindows.length > 0
        ? `Winding down: ${this.custom.activeWindows.length} window(s), ${totalInv} tokens`
        : "Wind-down complete";
    } else if (this.custom.activeWindows.length > 0) {
      this.custom.scanStatus = totalInv > 0
        ? `${this.custom.activeWindows.length} active, ${totalInv} tokens`
        : `${this.custom.activeWindows.length} active, waiting for fills…`;
    } else {
      this.custom.scanStatus = this.marketCache.length > 0 ? "No open windows" : "Scanning…";
    }

    // 8. Persist
    ctx.state.custom = this.custom as unknown as Record<string, unknown>;
    ctx.state.capital_deployed = this.custom.activeWindows.reduce(
      (sum, w) => sum + w.upInventory * w.upAvgCost + w.dnInventory * w.dnAvgCost, 0,
    );
    ctx.state.total_pnl = this.custom.totalPnl;
  }

  async stop(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as BabyBoneRParams;
    for (const w of this.custom.activeWindows) {
      await this.cancelAllOrders(ctx, w, params);
    }
    const binanceSymbols = params.target_cryptos.map(toBinanceSymbol);
    disableReactiveFeed(binanceSymbols);
    ctx.log(`BabyBoneR stopped: ${this.custom.totalFills} fills, ${this.custom.totalSells} sells, P&L=$${ctx.state.total_pnl.toFixed(2)}`);
  }

  // ── Fill recording (buy) ──────────────────────────────────────────

  private recordBuyFill(
    ctx: StrategyContext,
    w: BabyBoneRWindow,
    side: "UP" | "DOWN",
    size: number,
    price: number,
    label: string,
    isTaker: boolean,
  ): void {
    const fee = isTaker ? calcFeePerShare(price, DEFAULT_PARAMS.fee_params) * size : 0;
    const costBasis = price + (isTaker ? fee / size : 0);

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
      if (w.dnInventory > 0) {
        const totalCost = w.dnAvgCost * w.dnInventory + costBasis * size;
        w.dnInventory += size;
        w.dnAvgCost = totalCost / w.dnInventory;
      } else {
        w.dnInventory = size;
        w.dnAvgCost = costBasis;
      }
    }
    w.fillCount++;
    w.totalBuyCost += costBasis * size;
    this.custom.totalFills++;
    if (w.pendingFills) w.pendingFills.push({ side, price: costBasis, size });

    ctx.log(
      `FILL ${side} [${label}]: ${w.market.title.slice(0, 25)} ${size}@${price.toFixed(3)} inv=${w.upInventory}↑/${w.dnInventory}↓`,
      { level: "trade", symbol: w.cryptoSymbol, direction: side, phase: label },
    );
  }

  // ── Sell recording ────────────────────────────────────────────────

  private recordSellFill(
    ctx: StrategyContext,
    w: BabyBoneRWindow,
    side: "UP" | "DOWN",
    size: number,
    price: number,
    label: string,
  ): void {
    const fee = calcFeePerShare(price, DEFAULT_PARAMS.fee_params) * size;
    const revenue = price * size - fee;
    const avgCost = side === "UP" ? w.upAvgCost : w.dnAvgCost;
    const pnl = revenue - avgCost * size;

    // Reduce inventory
    if (side === "UP") {
      w.upInventory = Math.max(0, Math.round((w.upInventory - size) * 1e6) / 1e6);
    } else {
      w.dnInventory = Math.max(0, Math.round((w.dnInventory - size) * 1e6) / 1e6);
    }

    w.sellCount++;
    w.totalSellRevenue += revenue;
    w.realizedSellPnl += pnl;
    this.custom.totalSells++;

    ctx.log(
      `SELL ${side} [${label}]: ${w.market.title.slice(0, 25)} ${size}@${price.toFixed(3)} pnl=$${pnl.toFixed(2)} inv=${w.upInventory}↑/${w.dnInventory}↓`,
      { level: "trade", symbol: w.cryptoSymbol, direction: side, phase: label },
    );
  }

  private async persistTradeToD1(
    ctx: StrategyContext,
    w: BabyBoneRWindow,
    side: "UP" | "DOWN",
    buySell: "BUY" | "SELL",
    price: number,
    size: number,
    pnl: number,
    label: string,
  ): Promise<void> {
    const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
    const fee = calcFeePerShare(price, DEFAULT_PARAMS.fee_params) * size;
    await ctx.db
      .prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
      )
      .bind(
        `bbr-${label}-${crypto.randomUUID()}`,
        ctx.config.id,
        tokenId,
        w.market.slug,
        `${w.market.title} [BBR ${label} ${side}]`,
        buySell, price, size, fee, pnl,
      )
      .run();
  }

  // ── Cancel all orders ─────────────────────────────────────────────

  private async cancelAllOrders(ctx: StrategyContext, w: BabyBoneRWindow, params: BabyBoneRParams): Promise<void> {
    if (w.upBidOrderId) {
      const r = await safeCancelOrder(ctx.api, w.upBidOrderId);
      if (r.cleared) {
        if (r.fill) this.recordBuyFill(ctx, w, "UP", r.fill.size, r.fill.price, "cancel", false);
        w.upBidOrderId = null;
      }
    }
    if (w.dnBidOrderId) {
      const r = await safeCancelOrder(ctx.api, w.dnBidOrderId);
      if (r.cleared) {
        if (r.fill) this.recordBuyFill(ctx, w, "DOWN", r.fill.size, r.fill.price, "cancel", false);
        w.dnBidOrderId = null;
      }
    }
    if (w.upSellOrderId) {
      const r = await safeCancelOrder(ctx.api, w.upSellOrderId);
      if (r.cleared) w.upSellOrderId = null;
    }
    if (w.dnSellOrderId) {
      const r = await safeCancelOrder(ctx.api, w.dnSellOrderId);
      if (r.cleared) w.dnSellOrderId = null;
    }
  }

  // ── Enter new windows ─────────────────────────────────────────────

  private async enterWindows(ctx: StrategyContext, params: BabyBoneRParams): Promise<void> {
    const now = Date.now();
    const activeConditions = new Set(this.custom.activeWindows.map(w => w.market.conditionId));

    for (const market of this.marketCache) {
      if (this.custom.activeWindows.length >= params.max_concurrent_windows) break;
      if (activeConditions.has(market.conditionId)) continue;

      const sym = extractCryptoSymbol(market.title);
      if (!sym) continue;

      const endMs = new Date(market.endDate).getTime();
      const windowDuration = parseWindowDurationMs(market.title);
      const windowOpenTime = endMs - windowDuration;

      if (windowDuration > params.max_window_duration_ms) continue;
      if (now < windowOpenTime) continue;
      if (endMs - now < 30_000) continue;

      // Reference price
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
      } catch { /* best-effort */ }

      const window: BabyBoneRWindow = {
        market,
        cryptoSymbol: sym,
        windowOpenTime,
        windowEndTime: endMs,
        priceAtWindowOpen: ref.price,
        oracleStrike,

        upBidOrderId: null, upBidPrice: 0, upBidSize: 0,
        dnBidOrderId: null, dnBidPrice: 0, dnBidSize: 0,
        upSellOrderId: null, dnSellOrderId: null,

        upInventory: 0, upAvgCost: 0,
        dnInventory: 0, dnAvgCost: 0,

        fillCount: 0, sellCount: 0,
        totalBuyCost: 0, totalSellRevenue: 0,
        realizedSellPnl: 0,
        enteredAt: now,
        lastRequoteAt: 0,
        tickAction: "",
        confirmedDirection: null,
      };

      if (params.record_snapshots) {
        window.tickSnapshots = [];
        window.snapshotId = `snap-${market.conditionId}-${now}`;
        window.pendingFills = [];
      }

      this.custom.activeWindows.push(window);
      ctx.log(
        `ENTERED: ${market.title.slice(0, 40)} ${sym} oracle=${oracleStrike?.toFixed(0) ?? "none"}`,
        { level: "signal", symbol: sym, phase: "entry" },
      );
    }
  }

  // ── Manage active windows ─────────────────────────────────────────

  private async manageWindows(ctx: StrategyContext, params: BabyBoneRParams): Promise<void> {
    const now = Date.now();

    for (const w of this.custom.activeWindows) {
      // Past resolution — handled by resolveWindows
      if (now > w.windowEndTime + 300_000) {
        w.tickAction = "Awaiting resolution";
        continue;
      }

      // Wind-down: cancel bids, but let sell logic run
      if (ctx.windingDown) {
        if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) this.recordBuyFill(ctx, w, "UP", r.fill.size, r.fill.price, "cancel", false); w.upBidOrderId = null; } }
        if (w.dnBidOrderId) { const r = await safeCancelOrder(ctx.api, w.dnBidOrderId); if (r.cleared) { if (r.fill) this.recordBuyFill(ctx, w, "DOWN", r.fill.size, r.fill.price, "cancel", false); w.dnBidOrderId = null; } }
        w.tickAction = `Wind-down: ${w.upInventory}↑/${w.dnInventory}↓`;
        continue;
      }

      // Re-init snapshots after DO re-hydration
      if (params.record_snapshots && !w.tickSnapshots) {
        if (w.snapshotId) {
          try {
            const row = await ctx.db.prepare(
              "SELECT ticks FROM strategy_snapshots WHERE id = ?",
            ).bind(w.snapshotId).first<{ ticks: string }>();
            w.tickSnapshots = row?.ticks ? JSON.parse(row.ticks) : [];
          } catch { w.tickSnapshots = []; }
        } else {
          w.tickSnapshots = [];
        }
        w.pendingFills = [];
      }

      // Retry oracle strike
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
        } catch { /* best-effort */ }
      }

      // Get current spot price
      const effectiveStrike = w.oracleStrike ?? w.priceAtWindowOpen;
      const history = this.custom.priceHistory[w.cryptoSymbol] || [];
      const oracleTick = getOracleSpot(w.cryptoSymbol);
      const reactiveSpot = getReactiveSpot(w.cryptoSymbol);

      // Prefer oracle > reactive WebSocket > REST
      let currentPrice: number;
      if (oracleTick && isOracleConnected()) {
        currentPrice = oracleTick.price;
      } else if (reactiveSpot) {
        currentPrice = reactiveSpot.price;
      } else if (history.length > 0) {
        currentPrice = history[history.length - 1].price;
      } else {
        continue; // no price data
      }

      const vol = estimateVolatility5min(history);
      const timeRemaining = w.windowEndTime - now;
      const pTrue = calculatePTrue(currentPrice, effectiveStrike, "above", timeRemaining, vol);
      const upWinning = pTrue > 0.50;

      // Check fills on all bids
      await this.checkFills(ctx, w, params);

      const timeLeftSec = Math.max(0, timeRemaining / 1000);

      // ── Progressive liquidation (only when merge_exit=false) ────────
      if (!params.merge_exit && timeLeftSec < params.wind_down_seconds) {
        // Cancel all buy bids during wind-down
        if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) this.recordBuyFill(ctx, w, "UP", r.fill.size, r.fill.price, "winddown", false); w.upBidOrderId = null; } }
        if (w.dnBidOrderId) { const r = await safeCancelOrder(ctx.api, w.dnBidOrderId); if (r.cleared) { if (r.fill) this.recordBuyFill(ctx, w, "DOWN", r.fill.size, r.fill.price, "winddown", false); w.dnBidOrderId = null; } }

        // Sell inventory
        for (const side of ["UP", "DOWN"] as const) {
          const tokens = side === "UP" ? w.upInventory : w.dnInventory;
          if (tokens <= 0) continue;
          const marketPrice = side === "UP" ? pTrue : (1 - pTrue);

          if (timeLeftSec < params.fire_sale_seconds) {
            // Fire sale — dump at any price
            const sellPrice = Math.max(params.fire_sale_min_price, marketPrice * 0.50);
            const sellSize = tokens; // sell ALL
            const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
            const result = await ctx.api.placeOrder({
              token_id: tokenId, side: "SELL", size: sellSize,
              price: Math.round(sellPrice * 100) / 100,
            });
            if (result.status === "filled") {
              const fillPrice = result.price || sellPrice;
              this.recordSellFill(ctx, w, side, sellSize, fillPrice, "firesale");
              await this.persistTradeToD1(ctx, w, side, "SELL", fillPrice, sellSize,
                fillPrice * sellSize - (side === "UP" ? w.upAvgCost : w.dnAvgCost) * sellSize, "firesale");
            }
          } else {
            // Progressive unwind — sell at slightly below market
            const sellPrice = Math.max(params.sell_min_price, marketPrice * 0.90);
            const sellSize = Math.min(params.sell_size * 2, tokens);
            const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
            const result = await ctx.api.placeOrder({
              token_id: tokenId, side: "SELL", size: sellSize,
              price: Math.round(sellPrice * 100) / 100,
            });
            if (result.status === "filled") {
              const fillPrice = result.price || sellPrice;
              this.recordSellFill(ctx, w, side, sellSize, fillPrice, "winddown");
              await this.persistTradeToD1(ctx, w, side, "SELL", fillPrice, sellSize,
                fillPrice * sellSize - (side === "UP" ? w.upAvgCost : w.dnAvgCost) * sellSize, "winddown");
            }
          }
        }

        w.tickAction = timeLeftSec < params.fire_sale_seconds
          ? `Fire sale: ${w.upInventory}↑/${w.dnInventory}↓`
          : `Wind-down: selling ${w.upInventory}↑/${w.dnInventory}↓`;
        this.recordSnapshot(ctx, w, params, pTrue, currentPrice, history, oracleTick);
        acknowledgePriceChange(w.cryptoSymbol);
        continue;
      }

      // ── Merge exit: stop buying close to window end ─────────────────
      // When merge_exit is on, stop placing new bids 30s before end
      // to avoid getting filled right at expiry with no time for pairs
      if (params.merge_exit && timeLeftSec < 30) {
        if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) this.recordBuyFill(ctx, w, "UP", r.fill.size, r.fill.price, "endstop", false); w.upBidOrderId = null; } }
        if (w.dnBidOrderId) { const r = await safeCancelOrder(ctx.api, w.dnBidOrderId); if (r.cleared) { if (r.fill) this.recordBuyFill(ctx, w, "DOWN", r.fill.size, r.fill.price, "endstop", false); w.dnBidOrderId = null; } }
        w.tickAction = `Merge exit: holding ${w.upInventory}↑/${w.dnInventory}↓ to resolution`;
        this.recordSnapshot(ctx, w, params, pTrue, currentPrice, history, oracleTick);
        acknowledgePriceChange(w.cryptoSymbol);
        continue;
      }

      // ── Throttle requotes ─────────────────────────────────────────
      const priceChanged = hasPriceChanged(w.cryptoSymbol);
      const forceRequote = w.lastRequoteAt === 0; // first tick for this window
      if (!priceChanged && !forceRequote && now - w.lastRequoteAt < params.requote_interval_ms) {
        // Nothing changed — skip quoting
        this.recordSnapshot(ctx, w, params, pTrue, currentPrice, history, oracleTick);
        acknowledgePriceChange(w.cryptoSymbol);
        continue;
      }

      // ── Compressed P_true pricing (matches Bonereaper avg) ──────────
      // Raw P_true always extreme (0.000 or 1.000) due to low BTC vol.
      // Compress via p_floor/p_ceil → winning ~$0.70, losing ~$0.28, PC ~$0.98
      const pCapped = clamp(pTrue, params.p_floor, params.p_ceil);
      let upBid = Math.round(pCapped * params.target_pair_cost * 100) / 100;
      let dnBid = Math.round((1 - pCapped) * params.target_pair_cost * 100) / 100;

      // NOTE: No bid shading. Bonereaper goes 97% one-sided when direction is clear
      // (DN 5188@$0.985 vs UP 176@$0.148 in one window). Balance is an average across
      // windows, not enforced within windows. The market price guard handles safety.

      // Inventory suppression — hard caps
      if (w.upInventory >= params.max_inventory_per_side) upBid = 0;
      if (w.dnInventory >= params.max_inventory_per_side) dnBid = 0;
      if (w.totalBuyCost >= params.max_total_cost) { upBid = 0; dnBid = 0; }

      // Skew guard — pause heavy side to force pairing
      // Only activates after minimum tokens accumulated (avoids blocking on first fill)
      const totalInvTokens = w.upInventory + w.dnInventory;
      if (totalInvTokens >= params.skew_guard_min_tokens && params.max_skew_ratio < 1.0) {
        const upRatio = w.upInventory / totalInvTokens;
        const dnRatio = w.dnInventory / totalInvTokens;
        if (upRatio > params.max_skew_ratio) upBid = 0;
        if (dnRatio > params.max_skew_ratio) dnBid = 0;
      }

      upBid = upBid > 0 ? Math.max(0.01, upBid) : 0;
      dnBid = dnBid > 0 ? Math.max(0.01, dnBid) : 0;

      // ── Market price guard ───────────────────────────────────────
      // Don't bid on a side the market values as near-worthless.
      // When UP is winning, DN asks drop to $0.05-$0.15 — our $0.39 bid would
      // cross the ask and flood inventory with cheap losing tokens.
      // Bonereaper fills at ~$0.50 on BOTH sides — they don't accumulate near-worthless tokens.
      for (const side of ["UP", "DOWN"] as const) {
        let bid = side === "UP" ? upBid : dnBid;
        if (bid <= 0) continue;
        try {
          const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
          const book = await this.getBookCached(ctx, tokenId);
          const bestAsk = this.getBestAsk(book);
          if (bestAsk !== null) {
            // Guard 1: skip sides the market values as near-worthless
            if (bestAsk < params.min_ask_to_bid) {
              if (side === "UP") upBid = 0;
              else dnBid = 0;
              continue;
            }
            // Guard 2: cap bid well below ask to be a true resting maker
            // Using ask * 0.80 creates enough distance that the probability-based
            // fill model (~0.30 * exp(-distance * 20)) gives low fill rates.
            // With ask=$0.36, bid=max($0.29, our_bid) → distance=0.07 → prob=7.4%
            if (bid > bestAsk * 0.80) {
              bid = Math.round(bestAsk * 0.80 * 100) / 100;
              if (bid <= 0) bid = 0;
              if (side === "UP") upBid = bid;
              else dnBid = bid;
            }
          }
        } catch { /* best effort */ }
      }

      // ── Place/update GTC resting bids ─────────────────────────────
      await this.updateBid(ctx, w, "UP", upBid, params.maker_bid_size, params);
      await this.updateBid(ctx, w, "DOWN", dnBid, params.maker_bid_size, params);

      // ── Taker: hit asks at or below our bid (Bonereaper does ~100 taker trades per 2hr) ──
      for (const side of ["UP", "DOWN"] as const) {
        const bid = side === "UP" ? upBid : dnBid;
        const inv = side === "UP" ? w.upInventory : w.dnInventory;
        if (bid <= 0 || inv >= params.max_inventory_per_side || w.totalBuyCost >= params.max_total_cost) continue;

        try {
          const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
          const book = await this.getBookCached(ctx, tokenId);
          const ask = this.getBestAsk(book);
          // Take any ask at or below our bid price (no discount — be aggressive like Bonereaper)
          if (ask !== null && ask <= bid) {
            const result = await ctx.api.placeOrder({
              token_id: tokenId, side: "BUY",
              size: params.taker_bid_size, price: ask,
            });
            if (result.status === "filled") {
              const fillPrice = result.price || ask;
              this.recordBuyFill(ctx, w, side, result.size, fillPrice, "taker", true);
              await this.persistTradeToD1(ctx, w, side, "BUY", fillPrice, result.size, 0, "taker");
            }
          }
        } catch { /* best-effort */ }
      }

      // ── Mean-reversion sells (only when merge_exit=false) ───────────
      if (!params.merge_exit && params.sell_enabled) {
        for (const side of ["UP", "DOWN"] as const) {
          const tokens = side === "UP" ? w.upInventory : w.dnInventory;
          const avgCost = side === "UP" ? w.upAvgCost : w.dnAvgCost;
          if (tokens <= 0 || avgCost <= 0) continue;

          const marketPrice = side === "UP" ? pTrue : (1 - pTrue);

          if (marketPrice >= avgCost + params.sell_profit_threshold && avgCost > params.sell_min_price) {
            const sellPrice = Math.max(params.sell_min_price, Math.round((marketPrice - 0.02) * 100) / 100);
            const sellSize = Math.min(params.sell_size, tokens);
            const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;

            const result = await ctx.api.placeOrder({
              token_id: tokenId, side: "SELL", size: sellSize, price: sellPrice,
            });
            if (result.status === "filled") {
              const fillPrice = result.price || sellPrice;
              const pnl = (fillPrice * sellSize - calcFeePerShare(fillPrice, params.fee_params) * sellSize) - avgCost * sellSize;
              this.recordSellFill(ctx, w, side, sellSize, fillPrice, "meanrev");
              await this.persistTradeToD1(ctx, w, side, "SELL", fillPrice, sellSize, pnl, "meanrev");
            }
          }
        }
      }

      w.lastRequoteAt = now;

      // Periodic log
      if (ctx.state.ticks % 5 === 0) {
        const pc = (w.upInventory > 0 && w.dnInventory > 0) ? (w.upAvgCost + w.dnAvgCost).toFixed(2) : "—";
        const skew = totalInvTokens > 0 ? `${Math.round(w.upInventory / totalInvTokens * 100)}/${Math.round(w.dnInventory / totalInvTokens * 100)}` : "—";
        const skewActive = totalInvTokens >= params.skew_guard_min_tokens && params.max_skew_ratio < 1.0;
        const skewGuarded = skewActive &&
          (w.upInventory / totalInvTokens > params.max_skew_ratio || w.dnInventory / totalInvTokens > params.max_skew_ratio)
          ? " [SKEW-GUARD]" : "";
        ctx.log(
          `TICK: ${w.market.title.slice(0, 25)} P=${pCapped.toFixed(2)} spot=$${currentPrice.toFixed(0)} strike=$${effectiveStrike.toFixed(0)} bid=↑$${upBid.toFixed(2)}/↓$${dnBid.toFixed(2)} inv=${w.upInventory}↑/${w.dnInventory}↓ skew=${skew}${skewGuarded} pc=${pc} fills=${w.fillCount}`,
          { level: "signal", symbol: w.cryptoSymbol, signalStrength: pTrue, phase: "tick" },
        );
      }

      w.tickAction = `Quoting: up=${upBid.toFixed(2)} dn=${dnBid.toFixed(2)}`;

      this.recordSnapshot(ctx, w, params, pTrue, currentPrice, history, oracleTick);
      acknowledgePriceChange(w.cryptoSymbol);
    }
  }

  // ── Bid management ────────────────────────────────────────────────

  private async updateBid(
    ctx: StrategyContext,
    w: BabyBoneRWindow,
    side: "UP" | "DOWN",
    targetPrice: number,
    targetSize: number,
    params: BabyBoneRParams,
  ): Promise<void> {
    const orderId = side === "UP" ? w.upBidOrderId : w.dnBidOrderId;
    const currentPrice = side === "UP" ? w.upBidPrice : w.dnBidPrice;
    const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;

    // Cancel if target is 0 or price changed significantly
    if (orderId && (targetPrice <= 0 || Math.abs(targetPrice - currentPrice) > 0.005)) {
      const r = await safeCancelOrder(ctx.api, orderId);
      if (r.cleared) {
        if (r.fill) {
          this.recordBuyFill(ctx, w, side, r.fill.size, r.fill.price, "requote", false);
          await this.persistTradeToD1(ctx, w, side, "BUY", r.fill.price, r.fill.size, 0, "requote");
        }
        if (side === "UP") { w.upBidOrderId = null; w.upBidPrice = 0; w.upBidSize = 0; }
        else { w.dnBidOrderId = null; w.dnBidPrice = 0; w.dnBidSize = 0; }
      }
    }

    // Place new bid
    const curOrderId = side === "UP" ? w.upBidOrderId : w.dnBidOrderId;
    if (!curOrderId && targetPrice > 0) {
      const result = await ctx.api.placeOrder({
        token_id: tokenId, side: "BUY", size: targetSize, price: targetPrice,
        market: w.market.slug,
      });
      if (result.order_id) {
        if (side === "UP") {
          w.upBidOrderId = result.order_id;
          w.upBidPrice = targetPrice;
          w.upBidSize = targetSize;
        } else {
          w.dnBidOrderId = result.order_id;
          w.dnBidPrice = targetPrice;
          w.dnBidSize = targetSize;
        }
        // Immediate fill check (GTC can match immediately)
        if (result.status === "filled") {
          const fillPrice = result.price || targetPrice;
          this.recordBuyFill(ctx, w, side, result.size, fillPrice, "maker", false);
          await this.persistTradeToD1(ctx, w, side, "BUY", fillPrice, result.size, 0, "maker");
          if (side === "UP") w.upBidOrderId = null;
          else w.dnBidOrderId = null;
        }
      }
    }
  }

  // ── Check fills ───────────────────────────────────────────────────

  private async checkFills(ctx: StrategyContext, w: BabyBoneRWindow, params: BabyBoneRParams): Promise<void> {
    if (w.upBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.upBidOrderId);
      if (status.status === "MATCHED" && status.size_matched > 0) {
        const price = status.price || w.upBidPrice;
        this.recordBuyFill(ctx, w, "UP", status.size_matched, price, "maker", false);
        await this.persistTradeToD1(ctx, w, "UP", "BUY", price, status.size_matched, 0, "maker");
        w.upBidOrderId = null;
      }
    }
    if (w.dnBidOrderId) {
      const status = await ctx.api.getOrderStatus(w.dnBidOrderId);
      if (status.status === "MATCHED" && status.size_matched > 0) {
        const price = status.price || w.dnBidPrice;
        this.recordBuyFill(ctx, w, "DOWN", status.size_matched, price, "maker", false);
        await this.persistTradeToD1(ctx, w, "DOWN", "BUY", price, status.size_matched, 0, "maker");
        w.dnBidOrderId = null;
      }
    }
  }

  // ── Resolve windows ───────────────────────────────────────────────

  private async resolveWindows(ctx: StrategyContext, params: BabyBoneRParams): Promise<void> {
    const now = Date.now();
    const toRemove: number[] = [];

    for (let i = 0; i < this.custom.activeWindows.length; i++) {
      const w = this.custom.activeWindows[i];

      const hasOracle = w.oracleStrike != null && isOracleConnected();
      const waitMs = hasOracle ? 5_000 : 60_000;
      if (now < w.windowEndTime + waitMs) continue;

      // No inventory and no trades — nothing to resolve
      if (w.upInventory === 0 && w.dnInventory === 0 && w.fillCount === 0) {
        ctx.log(`EXPIRED (no fills): ${w.market.title.slice(0, 35)}`);
        toRemove.push(i);
        continue;
      }

      let outcome: "UP" | "DOWN" | "UNKNOWN" = "UNKNOWN";
      let gammaConfirmed = false;

      // 1. Polymarket resolution (authoritative)
      try {
        const resolution = await checkMarketResolution(w.market.slug, w.market.upTokenId, w.market.downTokenId);
        if (resolution.closed && resolution.outcome) {
          outcome = resolution.outcome;
          gammaConfirmed = true;
        }
      } catch { /* Gamma API failure */ }

      // 2. Oracle fallback
      const oracleTick = getOracleSpot(w.cryptoSymbol);
      const effectiveStrike = w.oracleStrike ?? w.priceAtWindowOpen;
      if (outcome === "UNKNOWN" && hasOracle && oracleTick) {
        outcome = oracleTick.price >= effectiveStrike ? "UP" : "DOWN";
      }

      // 3. Binance fallback
      if (outcome === "UNKNOWN") {
        const history = this.custom.priceHistory[w.cryptoSymbol] || [];
        const closePrice = history.length > 0 ? history[history.length - 1].price : null;
        if (closePrice !== null) {
          outcome = closePrice >= effectiveStrike ? "UP" : "DOWN";
        }
      }

      if (outcome === "UNKNOWN") {
        if (now < w.windowEndTime + 1800_000) continue;
        ctx.log(`RESOLUTION TIMEOUT: ${w.market.title.slice(0, 25)}`);
      }

      // P&L: remaining inventory at resolution
      let resolutionPnl = 0;
      if (outcome !== "UNKNOWN") {
        const winInv = outcome === "UP" ? w.upInventory : w.dnInventory;
        const winCost = outcome === "UP" ? w.upAvgCost : w.dnAvgCost;
        const loseInv = outcome === "UP" ? w.dnInventory : w.upInventory;
        const loseCost = outcome === "UP" ? w.dnAvgCost : w.upAvgCost;

        const payoutFee = calcFeePerShare(1.0, params.fee_params) * winInv;
        const winPayout = winInv * (1.0 - winCost) - payoutFee;
        const loseLoss = -(loseInv * loseCost);
        resolutionPnl = winPayout + loseLoss;
      }

      const netPnl = resolutionPnl + w.realizedSellPnl;

      const completed: CompletedWindow = {
        title: w.market.title,
        cryptoSymbol: w.cryptoSymbol,
        outcome,
        upInventory: w.upInventory,
        dnInventory: w.dnInventory,
        totalBuyCost: w.totalBuyCost,
        totalSellRevenue: w.totalSellRevenue,
        realizedSellPnl: w.realizedSellPnl,
        resolutionPnl,
        netPnl,
        fillCount: w.fillCount,
        sellCount: w.sellCount,
        completedAt: new Date().toISOString(),
        upAvgCost: w.upAvgCost,
        dnAvgCost: w.dnAvgCost,
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

      const pairCost = (w.upInventory > 0 && w.dnInventory > 0)
        ? (w.upAvgCost + w.dnAvgCost).toFixed(2) : "n/a";
      const paired = Math.min(w.upInventory, w.dnInventory);
      const excess = Math.abs(w.upInventory - w.dnInventory);
      const exitMode = params.merge_exit ? "merge" : "sell";
      ctx.log(
        `RESOLVED [${exitMode}]: ${w.market.title.slice(0, 25)} ${outcome} | inv ${w.upInventory}↑/${w.dnInventory}↓ pc=${pairCost} paired=${paired} excess=${excess} | fills=${w.fillCount} sells=${w.sellCount} | res=$${resolutionPnl.toFixed(2)} sell=$${w.realizedSellPnl.toFixed(2)} net=$${netPnl.toFixed(2)} | W/L=${this.custom.windowsWon}/${this.custom.windowsLost}`,
        { level: "signal", symbol: w.cryptoSymbol, direction: outcome === "UNKNOWN" ? undefined : outcome, phase: "resolve" },
      );

      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'RESOLVE', 0, 0, 0, datetime('now'), ?)`,
        )
        .bind(
          `bbr-resolve-${crypto.randomUUID()}`,
          ctx.config.id,
          w.market.conditionId,
          w.market.slug,
          `${w.market.title} [BBR ${outcome} f=${w.fillCount} s=${w.sellCount}]`,
          netPnl,
        )
        .run();

      // Update snapshot outcome
      if (params.record_snapshots && w.snapshotId) {
        try {
          await ctx.db.prepare("UPDATE strategy_snapshots SET outcome = ? WHERE id = ?")
            .bind(outcome, w.snapshotId).run();
          await ctx.db.prepare("DELETE FROM strategy_snapshots WHERE window_end_time < ?")
            .bind(Date.now() - 7 * 24 * 60 * 60 * 1000).run();
        } catch { /* best-effort */ }
      }

      toRemove.push(i);
    }

    // Auto-redeem resolved conditions
    if (toRemove.length > 0) {
      const conditionIds = toRemove
        .map(i => this.custom.activeWindows[i]?.market.conditionId)
        .filter((cid): cid is string => !!cid);
      if (conditionIds.length > 0) {
        try {
          const result = await ctx.api.redeemConditions(conditionIds);
          if (result.error) {
            ctx.log(`AUTO-REDEEM ERROR: ${result.error}`, { level: "error" } as never);
          } else {
            ctx.log(`AUTO-REDEEM OK: ${conditionIds.length} conditions`, { level: "info" } as never);
          }
        } catch (e) {
          ctx.log(`AUTO-REDEEM EXCEPTION: ${e}`, { level: "error" } as never);
        }
      }
    }

    for (const idx of toRemove.reverse()) {
      const removed = this.custom.activeWindows.splice(idx, 1)[0];
      delete this.custom.windowRefPrices[removed.market.conditionId];
    }
  }

  // ── Snapshot Recording ────────────────────────────────────────────

  private async recordSnapshot(
    ctx: StrategyContext,
    w: BabyBoneRWindow,
    params: BabyBoneRParams,
    pTrue: number,
    currentPrice: number,
    history: PriceSnapshot[],
    oracleTick: import("./oracle-feed").OracleTick | null,
  ): Promise<void> {
    if (!params.record_snapshots || !w.tickSnapshots) return;

    const now = Date.now();
    const effectiveStrike = w.oracleStrike ?? w.priceAtWindowOpen;

    try {
      // Re-hydrate cumulative tape state
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

      const tapeBuckets: TapeBucket[] = [];
      for (const [key, size] of w.cumulativeTapeBuckets!) {
        const sep = key.lastIndexOf(":");
        tapeBuckets.push({ tokenId: key.slice(0, sep), price: parseFloat(key.slice(sep + 1)), size });
      }
      const tapeMeta: TapeMeta = {
        totalTrades: w.cumulativeTapeCount!,
        totalVolume: w.cumulativeTapeVolume!,
        uniqueWallets: w.cumulativeTapeWallets!.size,
      };

      // Regime
      const regimeSignal = {
        symbol: w.cryptoSymbol,
        windowOpenPrice: w.priceAtWindowOpen,
        currentPrice,
        priceChangePct: ((currentPrice - w.priceAtWindowOpen) / w.priceAtWindowOpen) * 100,
        direction: pTrue > 0.5 ? "UP" as const : "DOWN" as const,
        signalStrength: Math.abs(pTrue - 0.5) * 2,
        velocity: 0, sampleCount: history.length, momentum: 0, acceleration: 0,
        volatilityRegime: "normal" as const, confidenceMultiplier: 1.0,
        orderFlowImbalance: 0, orderFlowAvailable: false,
        oracleSpot: oracleTick?.price, oracleAvailable: isOracleConnected(),
        rawDirection: pTrue > 0.5 ? "UP" as const : "DOWN" as const,
        inDeadZone: false,
      };
      const regimeFeatures = computeRegimeFeatures(history, regimeSignal, effectiveStrike, w.windowOpenTime, w.windowEndTime);
      const { regime, scores: regimeScores } = classifyRegime(regimeFeatures);

      // Book state
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
        price: currentPrice,
        signal: regimeSignal,
        regime, regimeFeatures, regimeScores,
        fairUp: pTrue, fairDown: 1 - pTrue,
        bookConviction: { upMid: null, downMid: null, bookDirection: "NEUTRAL", bookStrength: 0, bidDepthRatio: 0.5, midDelta: 0, agreement: 0 },
        tapeBuckets, tapeMeta, bookBids, upBookAsks, downBookAsks,
        fills: w.pendingFills?.length ? [...w.pendingFills] : undefined,
        upBidOrderId: w.upBidOrderId, upBidPrice: w.upBidPrice, upBidSize: w.upBidSize,
        downBidOrderId: w.dnBidOrderId, downBidPrice: w.dnBidPrice, downBidSize: w.dnBidSize,
        upInventory: w.upInventory, downInventory: w.dnInventory,
        upAvgCost: w.upAvgCost, downAvgCost: w.dnAvgCost,
        oracleSpot: oracleTick?.price,
        pTrue,
      };

      w.tickSnapshots.push(snapshot);
      if (w.pendingFills) w.pendingFills = [];

      // Flush to D1
      if (w.snapshotId) {
        try {
          const openDate = new Date(w.windowOpenTime);
          await ctx.db.prepare(
            `INSERT OR REPLACE INTO strategy_snapshots (id, strategy_id, window_title, crypto_symbol, window_open_time, window_end_time, window_duration_ms, oracle_strike, price_at_open, hour_utc, day_of_week, up_token_id, down_token_id, outcome, ticks)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            w.snapshotId, ctx.config.id, w.market.title, w.cryptoSymbol,
            w.windowOpenTime, w.windowEndTime, w.windowEndTime - w.windowOpenTime,
            w.oracleStrike ?? null, w.priceAtWindowOpen,
            openDate.getUTCHours(), openDate.getUTCDay(),
            w.market.upTokenId, w.market.downTokenId,
            null, JSON.stringify(w.tickSnapshots),
          ).run();
        } catch (e) { ctx.log(`SNAPSHOT FLUSH ERROR: ${e}`, { level: "error" }); }
      }
    } catch (e) { ctx.log(`SNAPSHOT RECORD ERROR: ${e}`, { level: "error" }); }
  }
}

// ── Register ─────────────────────────────────────────────────────────

registerStrategy("babyboner", () => new BabyBoneRStrategy());
