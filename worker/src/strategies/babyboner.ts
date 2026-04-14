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
import {
  enableClobFeed,
  subscribeClobTokens,
  unsubscribeClobTokens,
  getClobBook,
  isClobConnected,
  onBookChange,
  offBookChange,
  type ClobTradeEntry,
} from "./clob-feed";
import type { TickSnapshot, TapeBucket, TapeMeta } from "../optimizer/types";

// ── Bonereaper shadow fill types ─────────────────────────────────────

const DEFAULT_SHADOW_WALLET = "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30"; // Bonereaper

interface BrFill {
  id: string;       // transactionHash or unique identifier
  slug: string;
  side: "UP" | "DOWN";
  price: number;
  size: number;
  timestamp: number;
}

// ── Types ────────────────────────────────────────────────────────────

export interface BabyBoneRParams {
  target_cryptos: string[];

  // Pricing mode — determines how bid prices are computed
  //   "book"   — bid at best ask from real CLOB book (what Bonereaper does)
  //   "hybrid" — max(winning_share, P_true) both sides (shadow fill mode)
  //   "ladder" — P_true - edge1/edge2 (P_true-following with edge)
  //   "bonereaper" — three-phase adaptive: deep value early, P_true mid, aggressive certainty late
  pricing_mode: "book" | "hybrid" | "ladder" | "bonereaper";

  // Bonereaper mode params
  br_certainty_threshold: number;    // P_true threshold for "strong signal" — suppress losing side (default 0.65)
  br_suppress_after_pct: number;     // suppress losing side after this % of window elapsed (default 0.50)
  br_late_size_mult: number;         // multiply winning bid size in late window (default 2.0)
  br_deep_value_price: number;       // deepest resting bid price (default 0.15)
  br_uncertain_range: number;        // P_true within 0.50 ± this is "uncertain" (default 0.10)
  br_ladder_levels: number;          // number of bid levels per side (default 4: deep, value, mid, fair)

  // Capital cap
  capital_cap_usd?: number;          // max working capital — excess locked as profit

  // Legacy pricing params (used by hybrid and ladder modes)
  target_pair_cost: number;
  winning_share: number;
  p_floor: number;
  p_ceil: number;

  // Ladder params (only used when pricing_mode="ladder")
  ladder_enabled: boolean;     // legacy flag — use pricing_mode instead
  edge1: number;
  edge2: number;
  ladder_min_bid: number;      // floor on ladder bid prices
  ladder_max_bid: number;      // cap on ladder bid prices
  ladder_max_pair_cost: number; // UP_bid + DN_bid must be <= this

  // Bid sizing
  maker_bid_size: number;      // GTC resting bid size
  taker_bid_size: number;      // FOK taker order size
  taker_ask_discount: number;  // only take if ask <= our bid - discount
  taker_max_price: number;     // max price to pay for winning-side taker (Bonereaper pays ~$0.89)

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

  // Fill rate control — paper model fills crossing GTC instantly every tick,
  // creating 100:0 skew. Cooldown limits fills to 1 per N ms per side.
  buy_cooldown_ms: number;       // min ms between fills per side (default 15000)

  // Early seeding — Bonereaper ALWAYS buys both sides. Seed both early before P drifts.
  seed_seconds: number;          // seed phase duration after window open (e.g., 30s)
  seed_bid_price: number;        // bid price during seeding (e.g., 0.50 for both sides)
  seed_min_tokens: number;       // minimum tokens per side before seeding ends

  // Requote timing
  requote_interval_ms: number;   // min ms between requotes
  p_true_min_conviction: number; // don't trade when P_true near 0.50

  // Window management
  max_window_duration_ms: number;
  min_window_duration_ms: number;  // skip short windows (5min) where balance is hard
  observation_seconds: number;
  max_concurrent_windows: number;
  discovery_interval_ms: number;

  // Shadow fill system — when set, shadow this wallet's fills instead of simulating
  shadow_wallet?: string;  // wallet address (e.g., Bonereaper's 0xeeb...)

  // Snapshot recording
  record_snapshots: boolean;
  fee_params: FeeParams;
}

export const DEFAULT_PARAMS: BabyBoneRParams = {
  target_cryptos: ["Bitcoin"],

  // Pricing mode — "book" bids at real CLOB asks, "hybrid"/"ladder" use formulas
  pricing_mode: "book",        // DEFAULT: bid at best ask (what Bonereaper does)

  // Bonereaper mode — three-phase adaptive pricing
  br_certainty_threshold: 0.65,  // P_true above this = strong signal, suppress losing side
  br_suppress_after_pct: 0.50,   // suppress losing side after 50% of window elapsed
  br_late_size_mult: 2.0,        // double bid size on winning side in late window
  br_deep_value_price: 0.15,     // deepest resting bid price
  br_uncertain_range: 0.10,      // P_true in [0.40, 0.60] = "uncertain"
  br_ladder_levels: 4,           // bid levels per side: deep($0.15), value($0.30), mid($0.45), fair(P_true)

  // Legacy pricing params (used by hybrid and ladder modes)
  target_pair_cost: 1.00,
  winning_share: 0.55,         // hybrid mode: floor for both sides
  p_floor: 0.01,
  p_ceil: 0.99,

  // Ladder params
  ladder_enabled: false,       // legacy flag — use pricing_mode="ladder" instead
  edge1: 0.03,
  edge2: 0.07,
  ladder_min_bid: 0.01,
  ladder_max_bid: 0.95,
  ladder_max_pair_cost: 0.98,  // pair cost cap for ladder levels

  maker_bid_size: 25,          // Bonereaper: 3-30 per fill, median ~15
  taker_bid_size: 15,          // crossing taker fills (smaller to limit exposure)
  taker_ask_discount: 0.02,    // legacy param, taker now takes at bid price
  taker_max_price: 0.92,       // Bonereaper pays up to ~$0.89 on winning side

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
  max_skew_ratio: 0.90,           // either side capped at 90% of total (Bonereaper shows up to 86% skew)
  skew_guard_min_tokens: 500,    // activate after 500 total tokens accumulated
  min_ask_to_bid: 0.01,          // effectively disabled — Bonereaper buys losing side at $0.11
  buy_cooldown_ms: 15_000,       // 15s between fills per side (paper model rate limiter)

  seed_seconds: 45,              // first 45s: bid $0.50 on both sides to seed inventory
  seed_bid_price: 0.55,          // aggressive bid during seeding (crosses asks that sit above $0.50)
  seed_min_tokens: 300,          // seed until at least 300 tokens per side

  requote_interval_ms: 2000,    // requote every 2s (match tick rate)
  p_true_min_conviction: 0.50,  // always trade — Bonereaper trades at all conviction levels

  max_window_duration_ms: 15 * 60_000,
  min_window_duration_ms: 10 * 60_000,  // skip 5-min windows — too short for balanced inventory
  observation_seconds: 0,           // Enter immediately at window open — catch first fills
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

  // Resting bids (GTC) — L1
  upBidOrderId: string | null;
  upBidPrice: number;
  upBidSize: number;
  downBidOrderId: string | null;
  downBidPrice: number;
  downBidSize: number;
  // Resting bids (GTC) — L2 (ladder)
  upBid2OrderId: string | null;
  upBid2Price: number;
  downBid2OrderId: string | null;
  downBid2Price: number;

  // Sell orders
  upSellOrderId: string | null;
  downSellOrderId: string | null;

  // Inventory (FIFO avg cost)
  upInventory: number;
  upAvgCost: number;   // avg cost per token
  downInventory: number;
  downAvgCost: number;

  // Peak inventory (for UI — auto-merge reduces current inventory to 0)
  peakUpInventory: number;
  peakDownInventory: number;
  totalMerged: number;       // total pairs merged
  totalMergePnl: number;     // total P&L from merges
  estimatedRebates: number;  // estimated maker rebate income (20% of taker fees on our maker fills)

  // Tracking
  fillCount: number;
  sellCount: number;
  totalBuyCost: number;
  totalSellRevenue: number;
  realizedSellPnl: number;
  enteredAt: number;
  lastRequoteAt: number;
  tickAction: string;

  // Fill cooldown (paper model rate limiting)
  lastUpBuyAt: number;
  lastDownBuyAt: number;
  // L2 ladder cooldowns (separate from L1 so both levels can fill)
  lastUpBuy2At: number;
  lastDownBuy2At: number;
  // Shadow fill tracking — Bonereaper fill IDs already processed for this window
  processedBrFillIds: string[];

  // Signal tracking
  confirmedDirection: "UP" | "DOWN" | null;

  // Multi-level order tracking (for bonereaper ladder — keyed by "UP_3" or "DOWN_1")
  ladderOrders?: Record<string, { orderId: string | null; price: number }>;

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

  // Latest spot price — updated every tick so UI can predict outcome even if strategy stops
  lastSpotPrice?: number;

  // Dynamic fields set per-tick (not persisted, used for display and fill logic)
  _upLadder?: number[];
  _dnLadder?: number[];
  upAsk?: number | null;
  dnAsk?: number | null;
  upAskVol?: number;
  dnAskVol?: number;
}

interface CompletedWindow {
  title: string;
  cryptoSymbol: string;
  outcome: "UP" | "DOWN" | "UNKNOWN";
  upInventory: number;
  downInventory: number;
  totalBuyCost: number;
  totalSellRevenue: number;
  realizedSellPnl: number;
  resolutionPnl: number;
  netPnl: number;
  fillCount: number;
  sellCount: number;
  completedAt: string;
  upAvgCost: number;
  downAvgCost: number;
  gammaConfirmed: boolean;
  slug?: string;
  upTokenId?: string;
  downTokenId?: string;
  // Peak/merge stats (for UI display — final inventory is 0/0 after auto-merge)
  peakUpInventory?: number;
  peakDownInventory?: number;
  totalMerged?: number;
  totalMergePnl?: number;
  estimatedRebates?: number;
  // Shadow fill tracking
  processedBrFillIds?: string[];
  shadowFillStats?: {
    brFillsTotal: number;
    brFillsMatched: number;
    coveragePct: number;
  };
}

interface CustomState {
  activeWindows: BabyBoneRWindow[];
  completedWindows: CompletedWindow[];
  priceHistory: Record<string, PriceSnapshot[]>;
  windowRefPrices: Record<string, { price: number; recordedAt: number }>;
  totalPnl: number;
  totalFills: number;
  totalSells: number;
  totalEstimatedRebates: number;
  windowsTraded: number;
  windowsWon: number;
  windowsLost: number;
  perAsset: Record<string, { won: number; lost: number; pnl: number; fills: number }>;
  scanStatus: string;
  peakCapitalDeployed: number;
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
    totalEstimatedRebates: 0,
    windowsTraded: 0,
    windowsWon: 0,
    windowsLost: 0,
    perAsset: {},
    scanStatus: "Starting up…",
    peakCapitalDeployed: 0,
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
  private lastBoundary5m = 0; // track last 5m boundary to force discovery on crossing
  private bookCache = new Map<string, { book: OrderBook; fetchedAt: number }>();
  // Shadow fill state
  private lastBrFetchAt = 0;
  private lastShadowPersistAt = 0;
  private brActivityCache: BrFill[] = [];
  // Event-driven fill state
  private registeredBookCallbacks = new Map<string, (tokenId: string, book: OrderBook) => void>();
  private latestCtx: StrategyContext | null = null;
  private latestParams: BabyBoneRParams | null = null;
  private eventFillLock = false; // prevent concurrent event fills
  private effectiveCapital = 0; // current effective capital (updated each tick)

  private async getBookCached(ctx: StrategyContext, tokenId: string): Promise<OrderBook> {
    // Prefer real-time CLOB WebSocket book (updated on every price_change event)
    const wsBook = getClobBook(tokenId);
    if (wsBook) return wsBook;
    // Fallback to REST with 5s cache (CF Worker or WS not connected)
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

  /** Subscribe a window's tokens to CLOB WebSocket and register event-driven fill callbacks. */
  private subscribeClobWindow(w: BabyBoneRWindow): void {
    const tokenIds = [w.market.upTokenId, w.market.downTokenId];
    subscribeClobTokens(tokenIds);

    for (const tokenId of tokenIds) {
      if (this.registeredBookCallbacks.has(tokenId)) continue;
      const cb = (_tid: string, book: OrderBook) => this.handleBookEvent(w, tokenId, book);
      this.registeredBookCallbacks.set(tokenId, cb);
      onBookChange(tokenId, cb);
    }
  }

  /** Unsubscribe a window's tokens from CLOB WebSocket. */
  private unsubscribeClobWindow(w: BabyBoneRWindow): void {
    const tokenIds = [w.market.upTokenId, w.market.downTokenId];
    for (const tokenId of tokenIds) {
      const cb = this.registeredBookCallbacks.get(tokenId);
      if (cb) { offBookChange(tokenId, cb); this.registeredBookCallbacks.delete(tokenId); }
    }
    unsubscribeClobTokens(tokenIds);
  }

  /**
   * Event-driven fill handler — fires on every CLOB book change.
   * Checks if new ask liquidity is available at our target price and fills immediately.
   * Falls back gracefully: if no ctx/params yet (first tick hasn't run), skip.
   */
  private handleBookEvent(w: BabyBoneRWindow, tokenId: string, book: OrderBook): void {
    if (this.eventFillLock || !this.latestCtx || !this.latestParams) return;
    this.eventFillLock = true;
    try {
      this.tryEventFill(w, tokenId, book);
    } finally {
      this.eventFillLock = false;
    }
  }

  private tryEventFill(w: BabyBoneRWindow, tokenId: string, book: OrderBook): void {
    const ctx = this.latestCtx!;
    const params = this.latestParams!;
    const now = Date.now();

    // Don't fill if window is winding down
    if (now > w.windowEndTime - 30_000) return;
    if (ctx.windingDown) return;

    const isUp = tokenId === w.market.upTokenId;
    const side: "UP" | "DOWN" = isUp ? "UP" : "DOWN";

    // Compute current bid price (same logic as tick-based quoting)
    const timeRemaining = Math.max(0, w.windowEndTime - now);
    const pTrue = w.lastSpotPrice != null && w.oracleStrike != null
      ? calculatePTrue(w.lastSpotPrice, w.oracleStrike, "above", timeRemaining, 0.20)
      : 0.50;
    const pCapped = Math.max(params.p_floor, Math.min(params.p_ceil, pTrue));
    const pricingMode = params.pricing_mode || "hybrid";

    let bid = 0;
    if (pricingMode === "bonereaper") {
      const windowDuration = w.windowEndTime - w.windowOpenTime;
      const elapsedPct = (now - w.windowOpenTime) / windowDuration;
      const isLateWindow = elapsedPct > params.br_suppress_after_pct;
      const isUncertain = pCapped > (0.50 - params.br_uncertain_range) && pCapped < (0.50 + params.br_uncertain_range);
      const isStrongUp = pCapped > params.br_certainty_threshold;
      const isStrongDn = pCapped < (1 - params.br_certainty_threshold);

      if (isLateWindow && (isStrongUp || isStrongDn)) {
        const sideIsWinning = (isUp && isStrongUp) || (!isUp && isStrongDn);
        bid = sideIsWinning ? (isUp ? pCapped : 1 - pCapped) : 0;
      } else if (!isLateWindow && isUncertain) {
        bid = params.br_deep_value_price;
      } else {
        bid = isUp ? Math.max(params.br_deep_value_price, pCapped) : Math.max(params.br_deep_value_price, 1 - pCapped);
      }
      bid = Math.min(0.95, bid);
    } else if (pricingMode === "hybrid") {
      bid = isUp ? Math.max(params.winning_share, pCapped) : Math.max(params.winning_share, 1 - pCapped);
    } else if (pricingMode === "book") {
      const bestAsk = this.getBestAsk(book);
      bid = bestAsk !== null ? Math.min(0.95, bestAsk) : 0;
    } else {
      // ladder — skip event-driven for complex pricing modes
      return;
    }

    // Apply suppressions
    if (w.upInventory >= params.max_inventory_per_side && isUp) return;
    if (w.downInventory >= params.max_inventory_per_side && !isUp) return;

    const currentInvCost = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
    if (currentInvCost >= params.max_total_cost) {
      const isHeavy = isUp ? w.upInventory >= w.downInventory : w.downInventory >= w.upInventory;
      if (isHeavy) return;
    }

    const totalTokens = w.upInventory + w.downInventory;
    if (totalTokens >= params.skew_guard_min_tokens) {
      const ratio = (isUp ? w.upInventory : w.downInventory) / totalTokens;
      if (ratio > params.max_skew_ratio) return;
    }

    const roundedBid = Math.floor(bid * 100) / 100;
    if (roundedBid <= 0) return;

    // Check if book has ask liquidity at our bid price
    const bestAsk = this.getBestAsk(book);
    if (bestAsk === null || roundedBid < bestAsk) return; // doesn't cross, skip

    // Size to available liquidity at ask levels <= our bid
    let availableSize = 0;
    for (const level of book.asks) {
      if (level.price <= roundedBid) availableSize += level.size;
    }
    if (availableSize < 1) return;

    const inv = isUp ? w.upInventory : w.downInventory;
    const invRoom = params.max_inventory_per_side - inv;
    const capitalRoom = params.max_total_cost - currentInvCost;
    const capitalTokens = roundedBid > 0 ? capitalRoom / roundedBid : 0;
    const fillSize = Math.max(1, Math.floor(Math.min(availableSize, invRoom, capitalTokens)));

    const isReal = ctx.config.mode === "real";

    if (isReal) {
      // Real mode: place immediate GTC order
      // Note: placeOrder is async but we're in a sync callback — queue it
      ctx.api.placeOrder({
        token_id: tokenId,
        side: "BUY",
        size: fillSize,
        price: roundedBid,
        market: w.market.slug,
        title: `${w.market.title.slice(0, 25)} [BBR ${side} EVT]`,
      }).then(result => {
        if (result.status === "filled") {
          this.recordBuyFill(ctx, w, side, result.size, result.price, `real_evt`, true);
          this.persistTradeToD1(ctx, w, side, "BUY", result.price, result.size, 0, `real_evt`);
        }
      }).catch(() => { /* order failed, tick will retry */ });
    } else {
      // Paper mode: shadow fills or grounded fill
      // Shadow: check if any BR fills at this price exist
      const processedSet = new Set(w.processedBrFillIds || []);
      for (const br of this.brActivityCache) {
        if (br.slug !== w.market.slug || br.side !== side) continue;
        if (processedSet.has(br.id)) continue;
        if (br.timestamp * 1000 < w.enteredAt) { processedSet.add(br.id); continue; }
        if (roundedBid < br.price) continue;
        // Check capital/inventory per fill
        const invNow = isUp ? w.upInventory : w.downInventory;
        const costNow = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
        if (invNow >= params.max_inventory_per_side) break;
        const heavy = isUp ? w.upInventory >= w.downInventory : w.downInventory >= w.upInventory;
        if (costNow >= params.max_total_cost && heavy) break;

        this.recordBuyFill(ctx, w, side, br.size, br.price, "shadow_evt", false);
        this.persistTradeToD1(ctx, w, side, "BUY", br.price, br.size, 0, "shadow_evt");
        processedSet.add(br.id);
        w.processedBrFillIds = [...processedSet];
      }
    }
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

    // Migrate old dn* field names to down* (frontend expects downInventory etc.)
    for (const w of this.custom.activeWindows) {
      const a = w as any;
      if (a.dnInventory !== undefined && !w.downInventory) { w.downInventory = a.dnInventory; delete a.dnInventory; }
      if (a.dnAvgCost !== undefined && !w.downAvgCost) { w.downAvgCost = a.dnAvgCost; delete a.dnAvgCost; }
      if (a.dnBidOrderId !== undefined) { w.downBidOrderId = a.dnBidOrderId; delete a.dnBidOrderId; }
      if (a.dnBidPrice !== undefined) { w.downBidPrice = a.dnBidPrice; delete a.dnBidPrice; }
      if (a.dnBidSize !== undefined) { w.downBidSize = a.dnBidSize; delete a.dnBidSize; }
      if (a.dnSellOrderId !== undefined) { w.downSellOrderId = a.dnSellOrderId; delete a.dnSellOrderId; }
      if (a.lastDnBuyAt !== undefined) { w.lastDownBuyAt = a.lastDnBuyAt; delete a.lastDnBuyAt; }
    }
    for (const c of this.custom.completedWindows) {
      const a = c as any;
      if (a.dnInventory !== undefined) { c.downInventory = a.dnInventory; delete a.dnInventory; }
      if (a.dnAvgCost !== undefined) { c.downAvgCost = a.dnAvgCost; delete a.dnAvgCost; }
    }

    // Initialize peak/merge tracking on existing windows missing these fields
    for (const w of this.custom.activeWindows) {
      if (w.peakUpInventory == null) w.peakUpInventory = w.upInventory;
      if (w.peakDownInventory == null) w.peakDownInventory = w.downInventory;
      if (w.totalMerged == null) w.totalMerged = 0;
      if (w.totalMergePnl == null) w.totalMergePnl = 0;
    }

    // Recover from NaN corruption (old code stored NaN as null in JSON)
    if (!Number.isFinite(this.custom.totalPnl)) this.custom.totalPnl = 0;
    if (!Number.isFinite(this.custom.totalFills)) this.custom.totalFills = 0;
    if (!Number.isFinite(this.custom.totalSells)) this.custom.totalSells = 0;

    // Enable reactive Binance WebSocket feed
    const binanceSymbols = params.target_cryptos.map(toBinanceSymbol);
    enableReactiveFeed(binanceSymbols);

    // Enable CLOB WebSocket for real-time book updates (event-driven fills)
    enableClobFeed();

    // Subscribe existing windows to CLOB book updates
    for (const w of this.custom.activeWindows) {
      this.subscribeClobWindow(w);
    }

    ctx.log(
      `BabyBoneR initialized: ${this.custom.activeWindows.length} active, ${this.custom.totalFills} fills, ${this.custom.totalSells} sells`,
    );
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as BabyBoneRParams;
    const now = Date.now();

    // Store latest context for event-driven fill callbacks
    this.latestCtx = ctx;
    this.latestParams = params;

    // ── Dynamic capital scaling ─────────────────────────────────────
    // Derive bid size, windows, and duration limits from available capital.
    // Allows a $20 account to trade conservatively and scale up as profits grow.
    // capital_cap_usd: hard cap on working capital — excess is locked as profit.
    const capitalCap = params.capital_cap_usd;
    let effectiveCapital = ctx.config.max_capital_usd + (this.custom.totalPnl || 0);
    if (capitalCap != null && effectiveCapital > capitalCap) effectiveCapital = capitalCap;
    if (effectiveCapital > 0) {
      // Bid size capped at 50 tokens — Bonereaper averages 53.6 (P50=26.4).
      params.maker_bid_size = Math.min(50, Math.max(5, Math.floor(effectiveCapital / 10)));
      params.taker_bid_size = params.maker_bid_size;
      // Windows: 1 under $60, 2 under $180, up to 6
      params.max_concurrent_windows = Math.min(6, Math.max(1, Math.floor(effectiveCapital / 60)));
      // Deploy max 50% of capital per window
      params.max_total_cost = effectiveCapital * 0.5;
      params.max_inventory_per_side = Math.max(20, Math.floor(effectiveCapital * 2));
      if (ctx.config.mode === "real") params.buy_cooldown_ms = 0;
      // Only trade 5m windows until enough capital for 15m
      if (effectiveCapital < 80) {
        params.max_window_duration_ms = 5 * 60_000;
        params.min_window_duration_ms = 4 * 60_000;
      } else {
        params.max_window_duration_ms = 15 * 60_000;
        params.min_window_duration_ms = 4 * 60_000;
      }
      // Scale ladder levels with capital: $39→2, $100→3, $200+→4
      if (effectiveCapital < 60) params.br_ladder_levels = 2;
      else if (effectiveCapital < 150) params.br_ladder_levels = 3;
      // else keep the configured value (default 4)
    }

    // Update params and effective capital for event-driven callbacks (after dynamic scaling)
    this.latestParams = params;
    this.effectiveCapital = effectiveCapital;

    // 1. Discover markets — use direct slug-based lookup for speed.
    //    BTC 5m windows have predictable slugs: btc-updown-5m-{unix_open_time}
    // Force discovery on every 5-minute boundary crossing (we know exactly when windows open).
    const boundary5m = Math.floor(now / 300_000) * 300_000;
    const crossedBoundary = boundary5m > this.lastBoundary5m;
    if (crossedBoundary) this.lastBoundary5m = boundary5m;
    if (now - this.lastDiscovery > params.discovery_interval_ms || crossedBoundary) {
      try {
        const markets: CryptoMarket[] = [];
        const nowSec = Math.floor(now / 1000);
        // Generate slugs for the current and next few windows
        const intervals = [300, 900]; // 5m and 15m
        for (const interval of intervals) {
          if (interval * 1000 > params.max_window_duration_ms) continue;
          if (interval * 1000 < params.min_window_duration_ms) continue;
          const prefix = interval === 300 ? "btc-updown-5m" : "btc-updown-15m";
          const rounded = Math.floor(nowSec / interval) * interval;
          for (let offset = 0; offset <= 1; offset++) {
            const openTs = rounded + offset * interval;
            const slug = `${prefix}-${openTs}`;
            try {
              const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
              if (!r.ok) continue;
              const events = (await r.json()) as Array<{ markets: Array<Record<string, unknown>> }>;
              for (const ev of events) {
                for (const m of ev.markets || []) {
                  if (m.closed) continue;
                  const outcomes = JSON.parse((m.outcomes as string) || "[]") as string[];
                  const tokens = JSON.parse((m.clobTokenIds as string) || "[]") as string[];
                  if (outcomes.length !== 2 || tokens.length !== 2) continue;
                  const upIdx = outcomes.findIndex(o => o.toLowerCase() === "up");
                  const dnIdx = outcomes.findIndex(o => o.toLowerCase() === "down");
                  if (upIdx === -1 || dnIdx === -1) continue;
                  const timeToEnd = new Date(m.endDate as string).getTime() - now;
                  if (timeToEnd < 30_000) continue; // need at least 30s
                  markets.push({
                    title: m.question as string,
                    slug: m.slug as string,
                    conditionId: m.conditionId as string,
                    endDate: m.endDate as string,
                    upTokenId: tokens[upIdx],
                    downTokenId: tokens[dnIdx],
                    strikePrice: null,
                    strikeDirection: null,
                  });
                }
              }
            } catch { /* skip failed slug lookup */ }
          }
        }
        // Fallback to old discovery if direct lookup found nothing
        if (markets.length === 0) {
          const allMarkets = await discoverCryptoMarkets(params.target_cryptos, 30_000);
          this.marketCache = allMarkets.filter(m => /up or down/i.test(m.title));
        } else {
          this.marketCache = markets;
        }
      } catch {
        // Discovery failure — keep existing cache
      }
      this.lastDiscovery = now;
    } else {
      // Pre-fetch: if the next 5m boundary is within 5s, warm the cache now so entry is instant.
      const nextBoundary5m = boundary5m + 300_000;
      const secsUntilNext = (nextBoundary5m - now) / 1000;
      if (secsUntilNext <= 5 && secsUntilNext > 0) {
        const nowSec = Math.floor(now / 1000);
        const intervals = [300, 900];
        const prefetchMarkets: CryptoMarket[] = [];
        for (const interval of intervals) {
          if (interval * 1000 > params.max_window_duration_ms) continue;
          if (interval * 1000 < params.min_window_duration_ms) continue;
          const prefix = interval === 300 ? "btc-updown-5m" : "btc-updown-15m";
          const openTs = Math.ceil(nowSec / interval) * interval;
          const slug = `${prefix}-${openTs}`;
          try {
            const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
            if (!r.ok) continue;
            const events = (await r.json()) as Array<{ markets: Array<Record<string, unknown>> }>;
            for (const ev of events) {
              for (const m of ev.markets || []) {
                if (m.closed) continue;
                const outcomes = JSON.parse((m.outcomes as string) || "[]") as string[];
                const tokens = JSON.parse((m.clobTokenIds as string) || "[]") as string[];
                if (outcomes.length !== 2 || tokens.length !== 2) continue;
                const upIdx = outcomes.findIndex((o: string) => o.toLowerCase() === "up");
                const dnIdx = outcomes.findIndex((o: string) => o.toLowerCase() === "down");
                if (upIdx === -1 || dnIdx === -1) continue;
                prefetchMarkets.push({
                  title: m.question as string,
                  slug: m.slug as string,
                  conditionId: m.conditionId as string,
                  endDate: m.endDate as string,
                  upTokenId: tokens[upIdx],
                  downTokenId: tokens[dnIdx],
                  strikePrice: null,
                  strikeDirection: null,
                });
              }
            }
          } catch { /* skip */ }
        }
        if (prefetchMarkets.length > 0) {
          // Merge into cache without updating lastDiscovery (so boundary crossing still triggers full refresh)
          const existingSlugs = new Set(this.marketCache.map(m => m.slug));
          for (const m of prefetchMarkets) {
            if (!existingSlugs.has(m.slug)) this.marketCache.push(m);
          }
        }
      }
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

    // 2b. Fetch shadow wallet fills (paper mode only, throttled to every 10s)
    const shadowWallet = params.shadow_wallet || (ctx.config.mode === "paper" ? DEFAULT_SHADOW_WALLET : undefined);
    if (ctx.config.mode !== "real" && shadowWallet && now - this.lastBrFetchAt > 10_000) {
      this.brActivityCache = await this.fetchShadowWalletFills(shadowWallet);
      this.lastBrFetchAt = now;
      // Record activity to D1 for post-analysis (throttled to 60s)
      await this.persistShadowActivity(ctx, shadowWallet);
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
        w => w.upInventory + w.downInventory > 0 || w.totalBuyCost > 0,
      );
      if (this.custom.activeWindows.length < before) {
        ctx.log(`Wind-down: dropped ${before - this.custom.activeWindows.length} empty window(s)`);
      }
    }

    // 7. Scan status
    const totalInv = this.custom.activeWindows.reduce(
      (s, w) => s + w.upInventory + w.downInventory, 0,
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
    // Capital deployed: current unmatched inventory cost (what's actually at risk).
    // Matched pairs are structurally profitable and don't count as risk.
    ctx.state.capital_deployed = this.custom.activeWindows.reduce((sum, w) => {
      const matched = Math.min(w.upInventory, w.downInventory);
      const unmatchedUp = (w.upInventory - matched) * w.upAvgCost;
      const unmatchedDn = (w.downInventory - matched) * w.downAvgCost;
      return sum + unmatchedUp + unmatchedDn;
    }, 0);
    // Track peak capital at risk (for accurate RoR% calculation)
    if (this.custom.peakCapitalDeployed == null) this.custom.peakCapitalDeployed = 0;
    this.custom.peakCapitalDeployed = Math.max(this.custom.peakCapitalDeployed, ctx.state.capital_deployed);
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

  // ── Bonereaper shadow fill fetcher ──────────────────────────────

  private async fetchShadowWalletFills(wallet: string): Promise<BrFill[]> {
    try {
      const url = `https://data-api.polymarket.com/activity?user=${wallet}&limit=200&_t=${Date.now()}`;
      const resp = await fetch(url);
      if (!resp.ok) return this.brActivityCache; // keep stale cache on error
      const items = (await resp.json()) as Array<Record<string, unknown>>;
      const fills: BrFill[] = [];
      for (const item of items) {
        if (item.type !== "TRADE" || item.side !== "BUY") continue;
        const outcome = ((item.outcome as string) || "").toLowerCase();
        const side: "UP" | "DOWN" = outcome === "up" ? "UP" : "DOWN";
        fills.push({
          id: (item.transactionHash as string) || `${item.timestamp}-${item.price}-${item.size}`,
          slug: (item.slug as string) || "",
          side,
          price: item.price as number,
          size: item.size as number,
          timestamp: item.timestamp as number,
        });
      }
      return fills;
    } catch {
      return this.brActivityCache; // keep stale on error
    }
  }

  private computeShadowStats(w: BabyBoneRWindow): CompletedWindow["shadowFillStats"] | undefined {
    const matched = w.processedBrFillIds?.length ?? 0;
    if (matched === 0 && this.brActivityCache.length === 0) return undefined;
    const brForSlug = this.brActivityCache.filter(br => br.slug === w.market.slug);
    const total = Math.max(brForSlug.length, matched); // total is at least what we matched
    return {
      brFillsTotal: total,
      brFillsMatched: matched,
      coveragePct: total > 0 ? Math.round(matched / total * 100) : 0,
    };
  }

  /** Persist compressed shadow wallet activity snapshot to D1 (throttled to 60s) */
  private async persistShadowActivity(ctx: StrategyContext, wallet: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastShadowPersistAt < 60_000) return;
    this.lastShadowPersistAt = now;

    // Group by slug
    const bySlug = new Map<string, { upFills: number; dnFills: number; upPriceSum: number; dnPriceSum: number; upSize: number; dnSize: number; ts: number }>();
    for (const fill of this.brActivityCache) {
      const s = bySlug.get(fill.slug) || { upFills: 0, dnFills: 0, upPriceSum: 0, dnPriceSum: 0, upSize: 0, dnSize: 0, ts: fill.timestamp };
      if (fill.side === "UP") { s.upFills++; s.upPriceSum += fill.price * fill.size; s.upSize += fill.size; }
      else { s.dnFills++; s.dnPriceSum += fill.price * fill.size; s.dnSize += fill.size; }
      s.ts = Math.max(s.ts, fill.timestamp);
      bySlug.set(fill.slug, s);
    }

    try {
      const stmt = ctx.db.prepare(
        `INSERT INTO shadow_wallet_activity (strategy_id, shadow_wallet, slug, timestamp, up_fills, dn_fills, up_avg_price, dn_avg_price, up_total_size, dn_total_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const stmts = [...bySlug.entries()].map(([slug, s]) =>
        stmt.bind(
          ctx.config.id, wallet, slug, s.ts,
          s.upFills, s.dnFills,
          s.upSize > 0 ? s.upPriceSum / s.upSize : 0,
          s.dnSize > 0 ? s.dnPriceSum / s.dnSize : 0,
          s.upSize, s.dnSize,
        )
      );
      if (stmts.length > 0) await ctx.db.batch(stmts);
    } catch { /* non-critical */ }
  }

  // ── Real-mode order slot helpers ─────────────────────────────────

  private getRealOrderId(w: BabyBoneRWindow, side: "UP" | "DOWN", level: number): string | null {
    // Support N levels via ladderOrders map, fall back to legacy L1/L2 fields
    if (w.ladderOrders) {
      return w.ladderOrders[`${side}_${level}`]?.orderId ?? null;
    }
    if (side === "UP") return level === 2 ? w.upBid2OrderId : w.upBidOrderId;
    return level === 2 ? w.downBid2OrderId : w.downBidOrderId;
  }

  private setRealOrderId(w: BabyBoneRWindow, side: "UP" | "DOWN", level: number, id: string | null): void {
    if (level > 2 || w.ladderOrders) {
      if (!w.ladderOrders) w.ladderOrders = {};
      const key = `${side}_${level}`;
      if (!w.ladderOrders[key]) w.ladderOrders[key] = { orderId: null, price: 0 };
      w.ladderOrders[key].orderId = id;
      return;
    }
    if (side === "UP") { if (level === 2) w.upBid2OrderId = id; else w.upBidOrderId = id; }
    else { if (level === 2) w.downBid2OrderId = id; else w.downBidOrderId = id; }
  }

  private getRealOrderPrice(w: BabyBoneRWindow, side: "UP" | "DOWN", level: number): number {
    if (w.ladderOrders) {
      return w.ladderOrders[`${side}_${level}`]?.price ?? 0;
    }
    if (side === "UP") return level === 2 ? w.upBid2Price : w.upBidPrice;
    return level === 2 ? w.downBid2Price : w.downBidPrice;
  }

  private setRealOrderPrice(w: BabyBoneRWindow, side: "UP" | "DOWN", level: number, price: number): void {
    if (level > 2 || w.ladderOrders) {
      if (!w.ladderOrders) w.ladderOrders = {};
      const key = `${side}_${level}`;
      if (!w.ladderOrders[key]) w.ladderOrders[key] = { orderId: null, price: 0 };
      w.ladderOrders[key].price = price;
      return;
    }
    if (side === "UP") { if (level === 2) w.upBid2Price = price; else w.upBidPrice = price; }
    else { if (level === 2) w.downBid2Price = price; else w.downBidPrice = price; }
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
    const costBasis = price + (isTaker && size > 0 ? fee / size : 0);

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
    // Rebate estimation is handled at the framework level (autoMergeProfitablePairs)
    // for all strategies, not per-fill here.
    // Track peak inventory for UI (auto-merge reduces current to 0)
    if (w.upInventory > (w.peakUpInventory ?? 0)) w.peakUpInventory = w.upInventory;
    if (w.downInventory > (w.peakDownInventory ?? 0)) w.peakDownInventory = w.downInventory;
    if (w.pendingFills) w.pendingFills.push({ side, price: costBasis, size });
    // Update cooldown on ALL fill types (maker, taker, requote, etc.)
    const fillNow = Date.now();
    if (side === "UP") w.lastUpBuyAt = fillNow;
    else w.lastDownBuyAt = fillNow;

    ctx.log(
      `FILL ${side} [${label}]: ${w.market.title.slice(0, 25)} ${size}@${price.toFixed(3)} inv=${w.upInventory}↑/${w.downInventory}↓`,
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
    const avgCost = side === "UP" ? w.upAvgCost : w.downAvgCost;
    const pnl = revenue - avgCost * size;

    // Reduce inventory
    if (side === "UP") {
      w.upInventory = Math.max(0, Math.round((w.upInventory - size) * 1e6) / 1e6);
    } else {
      w.downInventory = Math.max(0, Math.round((w.downInventory - size) * 1e6) / 1e6);
    }

    w.sellCount++;
    w.totalSellRevenue += revenue;
    w.realizedSellPnl += pnl;
    this.custom.totalSells++;

    ctx.log(
      `SELL ${side} [${label}]: ${w.market.title.slice(0, 25)} ${size}@${price.toFixed(3)} pnl=$${pnl.toFixed(2)} inv=${w.upInventory}↑/${w.downInventory}↓`,
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
    // Cancel all buy bids (L1 + L2)
    for (const [side, level] of [["UP", 1], ["UP", 2], ["DOWN", 1], ["DOWN", 2]] as Array<["UP" | "DOWN", 1 | 2]>) {
      const orderId = this.getRealOrderId(w, side, level);
      if (orderId) {
        const r = await safeCancelOrder(ctx.api, orderId);
        if (r.cleared) {
          if (r.fill) this.recordBuyFill(ctx, w, side, r.fill.size, r.fill.price, `cancel_L${level}`, false);
          this.setRealOrderId(w, side, level, null);
        }
      }
    }
    // Cancel sell orders
    if (w.upSellOrderId) {
      const r = await safeCancelOrder(ctx.api, w.upSellOrderId);
      if (r.cleared) w.upSellOrderId = null;
    }
    if (w.downSellOrderId) {
      const r = await safeCancelOrder(ctx.api, w.downSellOrderId);
      if (r.cleared) w.downSellOrderId = null;
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
      if (windowDuration < params.min_window_duration_ms) continue;
      if (now < windowOpenTime) continue;
      if (endMs - now < 30_000) continue;
      // Only enter windows that just opened — stale windows have accumulated one-sided BR inventory.
      // 30s gives enough buffer for discovery + first tick after a restart.
      const windowAge = now - windowOpenTime;
      if (windowAge > 30_000) continue;

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
        downBidOrderId: null, downBidPrice: 0, downBidSize: 0,
        upBid2OrderId: null, upBid2Price: 0,
        downBid2OrderId: null, downBid2Price: 0,
        upSellOrderId: null, downSellOrderId: null,

        upInventory: 0, upAvgCost: 0,
        downInventory: 0, downAvgCost: 0,

        peakUpInventory: 0, peakDownInventory: 0,
        totalMerged: 0, totalMergePnl: 0, estimatedRebates: 0,

        fillCount: 0, sellCount: 0,
        totalBuyCost: 0, totalSellRevenue: 0,
        realizedSellPnl: 0,
        enteredAt: now,
        lastRequoteAt: 0,
        tickAction: "",
        confirmedDirection: null,
        lastUpBuyAt: 0,
        lastDownBuyAt: 0,
        lastUpBuy2At: 0,
        lastDownBuy2At: 0,
        processedBrFillIds: [],
      };

      if (params.record_snapshots) {
        window.tickSnapshots = [];
        window.snapshotId = `snap-${market.conditionId}-${now}`;
        window.pendingFills = [];
      }

      this.custom.activeWindows.push(window);
      // Subscribe to CLOB WebSocket for event-driven fills
      this.subscribeClobWindow(window);
      ctx.log(
        `ENTERED: ${market.title.slice(0, 40)} ${sym} oracle=${oracleStrike?.toFixed(0) ?? "none"} clob=${isClobConnected() ? "WS" : "REST"}`,
        { level: "signal", symbol: sym, phase: "entry" },
      );
    }
  }

  // ── Manage active windows ─────────────────────────────────────────

  private async manageWindows(ctx: StrategyContext, params: BabyBoneRParams): Promise<void> {
    const now = Date.now();

    for (const w of this.custom.activeWindows) {
      // Set oracle prediction for windows past their end time (used by UI)
      if (now > w.windowEndTime && !w.binancePrediction) {
        const oracleTick = getOracleSpot(w.cryptoSymbol);
        const history = this.custom.priceHistory[w.cryptoSymbol] || [];
        const lastPrice = oracleTick?.price ?? (history.length > 0 ? history[history.length - 1].price : null);
        const strike = w.oracleStrike ?? w.priceAtWindowOpen;
        if (lastPrice !== null && strike) {
          w.binancePrediction = lastPrice >= strike ? "UP" : "DOWN";
        }
      }

      // Past resolution — handled by resolveWindows
      if (now > w.windowEndTime + 300_000) {
        w.tickAction = "Awaiting resolution";
        continue;
      }

      // Wind-down: cancel bids, but let sell logic run
      if (ctx.windingDown) {
        if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) this.recordBuyFill(ctx, w, "UP", r.fill.size, r.fill.price, "cancel", false); w.upBidOrderId = null; } }
        if (w.downBidOrderId) { const r = await safeCancelOrder(ctx.api, w.downBidOrderId); if (r.cleared) { if (r.fill) this.recordBuyFill(ctx, w, "DOWN", r.fill.size, r.fill.price, "cancel", false); w.downBidOrderId = null; } }
        w.tickAction = `Wind-down: ${w.upInventory}↑/${w.downInventory}↓`;
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

      // Track latest spot price (used by UI to show oracle prediction when strategy stops)
      w.lastSpotPrice = currentPrice;

      // Volatility floor: realized vol drops to ~0.01% in calm BTC periods, making
      // the CDF model overreact to $14 moves (P_true=0.25 instead of 0.50).
      // Bonereaper treats near-strike as ~50/50 — requires vol >= 0.20%.
      const rawVol = estimateVolatility5min(history);
      const vol = Math.max(rawVol, 0.20); // floor at 0.20% 5-min vol
      const timeRemaining = w.windowEndTime - now;
      const pTrue = calculatePTrue(currentPrice, effectiveStrike, "above", timeRemaining, vol);
      const upWinning = pTrue > 0.50;

      // Fill checking: real mode checks inline in fill loop; paper mode uses shadow fills.
      // No separate checkFills needed.

      const timeLeftSec = Math.max(0, timeRemaining / 1000);

      // ── Progressive liquidation (only when merge_exit=false) ────────
      if (!params.merge_exit && timeLeftSec < params.wind_down_seconds) {
        // Cancel all buy bids during wind-down
        if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) this.recordBuyFill(ctx, w, "UP", r.fill.size, r.fill.price, "winddown", false); w.upBidOrderId = null; } }
        if (w.downBidOrderId) { const r = await safeCancelOrder(ctx.api, w.downBidOrderId); if (r.cleared) { if (r.fill) this.recordBuyFill(ctx, w, "DOWN", r.fill.size, r.fill.price, "winddown", false); w.downBidOrderId = null; } }

        // Sell inventory
        for (const side of ["UP", "DOWN"] as const) {
          const tokens = side === "UP" ? w.upInventory : w.downInventory;
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
                fillPrice * sellSize - (side === "UP" ? w.upAvgCost : w.downAvgCost) * sellSize, "firesale");
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
                fillPrice * sellSize - (side === "UP" ? w.upAvgCost : w.downAvgCost) * sellSize, "winddown");
            }
          }
        }

        w.tickAction = timeLeftSec < params.fire_sale_seconds
          ? `Fire sale: ${w.upInventory}↑/${w.downInventory}↓`
          : `Wind-down: selling ${w.upInventory}↑/${w.downInventory}↓`;
        this.recordSnapshot(ctx, w, params, pTrue, currentPrice, history, oracleTick);
        acknowledgePriceChange(w.cryptoSymbol);
        continue;
      }

      // ── Merge exit: stop buying close to window end ─────────────────
      // When merge_exit is on, stop placing new bids 30s before end
      // to avoid getting filled right at expiry with no time for pairs
      if (params.merge_exit && timeLeftSec < 30) {
        if (w.upBidOrderId) { const r = await safeCancelOrder(ctx.api, w.upBidOrderId); if (r.cleared) { if (r.fill) this.recordBuyFill(ctx, w, "UP", r.fill.size, r.fill.price, "endstop", false); w.upBidOrderId = null; } }
        if (w.downBidOrderId) { const r = await safeCancelOrder(ctx.api, w.downBidOrderId); if (r.cleared) { if (r.fill) this.recordBuyFill(ctx, w, "DOWN", r.fill.size, r.fill.price, "endstop", false); w.downBidOrderId = null; } }
        w.tickAction = `Merge exit: holding ${w.upInventory}↑/${w.downInventory}↓ to resolution`;
        this.recordSnapshot(ctx, w, params, pTrue, currentPrice, history, oracleTick);
        acknowledgePriceChange(w.cryptoSymbol);
        continue;
      }

      // ── Throttle requotes ─────────────────────────────────────────
      const priceChanged = hasPriceChanged(w.cryptoSymbol);
      const forceRequote = w.lastRequoteAt === 0; // first tick for this window
      if (!priceChanged && !forceRequote && now - w.lastRequoteAt < params.requote_interval_ms) {
        // Nothing changed — skip quoting, tickAction retains last value
        this.recordSnapshot(ctx, w, params, pTrue, currentPrice, history, oracleTick);
        acknowledgePriceChange(w.cryptoSymbol);
        continue;
      }

      // ── Pricing: book / hybrid / ladder ────────────────────────────
      const pCapped = clamp(pTrue, params.p_floor, params.p_ceil);
      let upBid = 0;
      let dnBid = 0;
      let upBid2 = 0;
      let dnBid2 = 0;

      // Resolve pricing mode (support legacy ladder_enabled flag)
      const pricingMode = params.pricing_mode || (params.ladder_enabled ? "ladder" : "hybrid");

      if (pricingMode === "book") {
        // Book-based pricing: bid at the best ask from the real CLOB.
        // This is what Bonereaper does — their fill prices ARE the ask prices.
        // If no ask exists, don't bid (nothing to buy).
        let upAskPrice: number | null = null;
        let dnAskPrice: number | null = null;
        try { upAskPrice = this.getBestAsk(await this.getBookCached(ctx, w.market.upTokenId)); } catch {}
        try { dnAskPrice = this.getBestAsk(await this.getBookCached(ctx, w.market.downTokenId)); } catch {}
        upBid = upAskPrice !== null ? upAskPrice : 0;
        dnBid = dnAskPrice !== null ? dnAskPrice : 0;
        // Clamp to avoid buying near-certain tokens at $0.99
        upBid = Math.min(0.95, upBid);
        dnBid = Math.min(0.95, dnBid);
      } else if (pricingMode === "ladder") {
        // Ladder: P_true - edge
        const fairUp = pCapped;
        const fairDown = 1 - pCapped;
        upBid = clamp(fairUp - params.edge1, params.ladder_min_bid, params.ladder_max_bid);
        upBid2 = clamp(fairUp - params.edge2, params.ladder_min_bid, params.ladder_max_bid);
        dnBid = clamp(fairDown - params.edge1, params.ladder_min_bid, params.ladder_max_bid);
        dnBid2 = clamp(fairDown - params.edge2, params.ladder_min_bid, params.ladder_max_bid);
        // Pair cost cap
        if (w.downInventory > 0) {
          const cap = params.ladder_max_pair_cost - w.downAvgCost;
          upBid = Math.min(upBid, cap);
          upBid2 = Math.min(upBid2, cap);
        }
        if (w.upInventory > 0) {
          const cap = params.ladder_max_pair_cost - w.upAvgCost;
          dnBid = Math.min(dnBid, cap);
          dnBid2 = Math.min(dnBid2, cap);
        }
        upBid = Math.max(0.01, upBid);
        upBid2 = Math.max(0.01, upBid2);
        dnBid = Math.max(0.01, dnBid);
        dnBid2 = Math.max(0.01, dnBid2);
      } else if (pricingMode === "bonereaper") {
        // Bonereaper multi-level adaptive pricing:
        // Places a LADDER of bids at multiple price levels per side, like Bonereaper does.
        // Deep bids catch panic sellers, mid bids catch normal flow, fair bids cross the spread.
        // Late window: suppress losing side entirely, boost winning side.
        const windowDuration = w.windowEndTime - w.windowOpenTime;
        const elapsedPct = (now - w.windowOpenTime) / windowDuration;
        const isLateWindow = elapsedPct > params.br_suppress_after_pct;
        const isStrongUp = pCapped > params.br_certainty_threshold;
        const isStrongDn = pCapped < (1 - params.br_certainty_threshold);

        // Generate ladder levels from deep value up to P_true
        const upFair = pCapped;
        const dnFair = 1 - pCapped;
        const deepPrice = params.br_deep_value_price;
        const nLevels = params.br_ladder_levels;

        // Build UP ladder: evenly spaced from deep to fair
        const upLadder: number[] = [];
        const dnLadder: number[] = [];
        for (let i = 0; i < nLevels; i++) {
          const t = nLevels > 1 ? i / (nLevels - 1) : 1; // 0 = deep, 1 = fair
          upLadder.push(Math.min(0.95, deepPrice + t * Math.max(0, upFair - deepPrice)));
          dnLadder.push(Math.min(0.95, deepPrice + t * Math.max(0, dnFair - deepPrice)));
        }

        // Late certainty: suppress losing side ladder entirely
        if (isLateWindow && (isStrongUp || isStrongDn)) {
          if (isStrongDn) upLadder.fill(0);
          if (isStrongUp) dnLadder.fill(0);
        }

        // L1 bid = highest level (fair price), used for display + legacy suppression
        upBid = upLadder[upLadder.length - 1];
        dnBid = dnLadder[dnLadder.length - 1];

        // Store full ladder for fill attempts (attached to window for this tick)
        w._upLadder = upLadder;
        w._dnLadder = dnLadder;
      } else {
        // Hybrid: max(winning_share, P_true) both sides — for shadow fill matching
        upBid = Math.max(params.winning_share, pCapped);
        dnBid = Math.max(params.winning_share, 1 - pCapped);
        upBid = Math.min(0.95, upBid);
        dnBid = Math.min(0.95, dnBid);
      }

      // Inventory suppression — hard caps (apply to both L1 and L2)
      if (w.upInventory >= params.max_inventory_per_side) { upBid = 0; upBid2 = 0; }
      if (w.downInventory >= params.max_inventory_per_side) { dnBid = 0; dnBid2 = 0; }

      // Capital gate — use current inventory cost (not cumulative totalBuyCost).
      // Current cost DECREASES when auto-merge recycles pairs, allowing reinvestment.
      // Only suppress the HEAVY side — always allow buying the light side to pair inventory.
      const currentInvCost = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
      if (currentInvCost >= params.max_total_cost) {
        // Suppress heavy side, keep light side open for pairing
        if (w.upInventory >= w.downInventory) { upBid = 0; upBid2 = 0; }
        if (w.downInventory >= w.upInventory) { dnBid = 0; dnBid2 = 0; }
      }

      // Inventory skew guard — prevent EITHER side from dominating.
      // Unmatched excess on the wrong side at resolution is a total loss.
      // Suppress whichever side exceeds max_skew_ratio of total tokens.
      const totalInvTokens = w.upInventory + w.downInventory;
      if (totalInvTokens >= params.skew_guard_min_tokens) {
        const upRatio = w.upInventory / totalInvTokens;
        const dnRatio = w.downInventory / totalInvTokens;
        if (upRatio > params.max_skew_ratio) { upBid = 0; upBid2 = 0; }
        if (dnRatio > params.max_skew_ratio) { dnBid = 0; dnBid2 = 0; }
      }

      upBid = upBid > 0 ? Math.max(0.01, upBid) : 0;
      dnBid = dnBid > 0 ? Math.max(0.01, dnBid) : 0;
      upBid2 = upBid2 > 0 ? Math.max(0.01, upBid2) : 0;
      dnBid2 = dnBid2 > 0 ? Math.max(0.01, dnBid2) : 0;

      const isReal = ctx.config.mode === "real";

      // Fetch book asks for crossing detection + UI display
      let upAsk: number | null = null;
      let dnAsk: number | null = null;
      let upAskVol = 0;
      let dnAskVol = 0;
      try {
        const book = await this.getBookCached(ctx, w.market.upTokenId);
        upAsk = this.getBestAsk(book);
        if (upAsk != null) upAskVol = book.asks.filter(a => Math.abs(a.price - upAsk!) < 0.001).reduce((s, a) => s + a.size, 0);
      } catch {}
      try {
        const book = await this.getBookCached(ctx, w.market.downTokenId);
        dnAsk = this.getBestAsk(book);
        if (dnAsk != null) dnAskVol = book.asks.filter(a => Math.abs(a.price - dnAsk!) < 0.001).reduce((s, a) => s + a.size, 0);
      } catch {}

      const upCrosses = upBid > 0 && upAsk !== null && upBid >= upAsk;
      const dnCrosses = dnBid > 0 && dnAsk !== null && dnBid >= dnAsk;

      if (ctx.state.ticks % 10 === 0) {
        const l2Str = params.ladder_enabled ? ` L2: ▲${upBid2.toFixed(2)} ▼${dnBid2.toFixed(2)}` : "";
        ctx.log(`QUOTE: ${isReal ? "REAL" : "PAPER"} upBid=${upBid.toFixed(2)} dnBid=${dnBid.toFixed(2)}${l2Str} upX=${upCrosses} dnX=${dnCrosses} upAsk=${upAsk?.toFixed(2) ?? "nil"} dnAsk=${dnAsk?.toFixed(2) ?? "nil"} inv=${w.upInventory}/${w.downInventory} cdU=${Math.round((now - (w.lastUpBuyAt || 0)) / 1000)}s cdD=${Math.round((now - (w.lastDownBuyAt || 0)) / 1000)}s`,
          { level: "signal" });
      }

      // Build fill attempts: alternate UP/DN to force balanced accumulation.
      // Bonereaper achieves 74-92% pairing — alternating ensures we never go
      // more than 1 fill ahead on either side.
      const fillAttempts: Array<{ side: "UP" | "DOWN"; bid: number; level: number }> = [];

      // Determine which side goes first: the side with FEWER tokens
      const firstSide: "UP" | "DOWN" = w.upInventory <= w.downInventory ? "UP" : "DOWN";
      const secondSide: "UP" | "DOWN" = firstSide === "UP" ? "DOWN" : "UP";

      if (pricingMode === "bonereaper") {
        // Multi-level ladder: interleave UP/DN at each price level (highest first for best fills)
        const upLadder = (w._upLadder as number[]) || [upBid];
        const dnLadder = (w._dnLadder as number[]) || [dnBid];
        const maxLevels = Math.max(upLadder.length, dnLadder.length);
        for (let lvl = maxLevels - 1; lvl >= 0; lvl--) { // highest price first
          const firstBid = firstSide === "UP" ? (upLadder[lvl] ?? 0) : (dnLadder[lvl] ?? 0);
          const secondBid = secondSide === "UP" ? (upLadder[lvl] ?? 0) : (dnLadder[lvl] ?? 0);
          fillAttempts.push({ side: firstSide, bid: firstBid, level: lvl + 1 });
          fillAttempts.push({ side: secondSide, bid: secondBid, level: lvl + 1 });
        }
      } else {
        // Legacy L1/L2 interleave
        fillAttempts.push({ side: firstSide, bid: firstSide === "UP" ? upBid : dnBid, level: 1 });
        fillAttempts.push({ side: secondSide, bid: secondSide === "UP" ? upBid : dnBid, level: 1 });
        if (params.ladder_enabled) {
          fillAttempts.push({ side: firstSide, bid: firstSide === "UP" ? upBid2 : dnBid2, level: 2 });
          fillAttempts.push({ side: secondSide, bid: secondSide === "UP" ? upBid2 : dnBid2, level: 2 });
        }
      }

      // Track capital committed this tick across all orders (prevents over-deploying small balances)
      let tickCapitalCommitted = 0;
      let orderFailed = false;

      for (const { side, bid, level } of fillAttempts) {
        if (orderFailed) break; // stop placing orders after a failure (likely balance exhausted)
        const inv = side === "UP" ? w.upInventory : w.downInventory;
        const currentInvCost2 = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
        if (bid <= 0 || inv >= params.max_inventory_per_side || currentInvCost2 >= params.max_total_cost) continue;

        const tokenId = side === "UP" ? w.market.upTokenId : w.market.downTokenId;
        const roundedBid = Math.floor(bid * 100) / 100;

        // Size to available liquidity: scan the order book and buy exactly what's offered
        // at ask levels <= our bid price. This replicates Bonereaper's behavior — they buy
        // what's available, not a fixed size. Capped by remaining inventory/capital room.
        let fillSize = params.maker_bid_size; // fallback if book unavailable
        try {
          const book = await this.getBookCached(ctx, tokenId);
          let availableAtBid = 0;
          for (const level of book.asks) {
            if (level.price <= roundedBid) {
              availableAtBid += level.size;
            }
          }
          if (availableAtBid > 0) {
            // Cap by inventory room and capital room
            const invRoom = params.max_inventory_per_side - inv;
            const capitalRoom = params.max_total_cost - currentInvCost2;
            const capitalTokens = roundedBid > 0 ? capitalRoom / roundedBid : 0;
            fillSize = Math.min(availableAtBid, invRoom, capitalTokens);
            fillSize = Math.max(1, Math.floor(fillSize)); // at least 1 token, integer
          }
        } catch { /* book unavailable — use fallback size */ }

        // Bonereaper late-window size boost: increase winning side fill size
        if (pricingMode === "bonereaper") {
          const windowDuration = w.windowEndTime - w.windowOpenTime;
          const elapsedPct = (now - w.windowOpenTime) / windowDuration;
          const isWinningSide = (side === "UP" && pCapped > 0.5) || (side === "DOWN" && pCapped < 0.5);
          if (elapsedPct > params.br_suppress_after_pct && isWinningSide) {
            fillSize = Math.max(1, Math.floor(fillSize * params.br_late_size_mult));
          }
        }

        const levelLabel = `L${level}`;

        if (isReal) {
          // ── REAL MODE: place GTC orders, check fills ──────────────
          // Use the order slot for this side+level; check if existing order filled
          const existingId = this.getRealOrderId(w, side, level);
          if (existingId) {
            // Check if it filled
            const status = await ctx.api.getOrderStatus(existingId);
            if (status.status === "MATCHED" && status.size_matched > 0) {
              const fillPrice = status.price || roundedBid;
              const fillSz = status.size_matched;
              this.recordBuyFill(ctx, w, side, fillSz, fillPrice, `real_${levelLabel}`, false);
              await this.persistTradeToD1(ctx, w, side, "BUY", fillPrice, fillSz, 0, `real_${levelLabel}`);
              this.setRealOrderId(w, side, level, null);
            } else if (status.status === "ERROR" || status.status === "UNKNOWN" || status.status === "CANCELLED") {
              // Order gone from CLOB (expired, cancelled, or API error) — clear slot
              this.setRealOrderId(w, side, level, null);
            } else {
              // Still resting (LIVE) — check if price drifted enough to requote
              const existingPrice = this.getRealOrderPrice(w, side, level);
              if (Math.abs(roundedBid - existingPrice) >= 0.01) {
                const r = await safeCancelOrder(ctx.api, existingId);
                if (r.cleared) {
                  if (r.fill) {
                    this.recordBuyFill(ctx, w, side, r.fill.size, r.fill.price, `real_${levelLabel}_cancel`, false);
                    await this.persistTradeToD1(ctx, w, side, "BUY", r.fill.price, r.fill.size, 0, `real_${levelLabel}_cancel`);
                  }
                  this.setRealOrderId(w, side, level, null);
                } else {
                  // Cancel failed but order might be gone — clear if status was ERROR
                  this.setRealOrderId(w, side, level, null);
                }
              } else {
                continue; // price close enough, keep existing order
              }
            }
          }

          // Place new GTC order if no order resting
          if (!this.getRealOrderId(w, side, level)) {
            // Capital budget: don't commit more than effective capital across all orders this tick
            const orderCost = roundedBid * fillSize;
            if (tickCapitalCommitted + orderCost > this.effectiveCapital) {
              continue; // skip this level — not enough budget
            }
            try {
              ctx.log(`ORDER: ${side} ${levelLabel} $${roundedBid} sz=${fillSize} cost=$${orderCost.toFixed(1)} budget=$${(this.effectiveCapital - tickCapitalCommitted).toFixed(1)}`, { level: "signal" });
              const result = await ctx.api.placeOrder({
                token_id: tokenId,
                side: "BUY",
                size: fillSize,
                price: roundedBid,
                market: w.market.slug,
                title: `${w.market.title.slice(0, 30)} [BBR ${side} ${levelLabel}]`,
              });
              if (result.status === "filled") {
                ctx.log(`FILL: ${side} ${levelLabel} ${result.size}@$${result.price?.toFixed(3)}`, { level: "signal" });
                this.recordBuyFill(ctx, w, side, result.size, result.price, `real_${levelLabel}_imm`, true);
                await this.persistTradeToD1(ctx, w, side, "BUY", result.price, result.size, 0, `real_${levelLabel}_imm`);
                tickCapitalCommitted += result.price * result.size;
              } else if (result.status === "placed") {
                this.setRealOrderId(w, side, level, result.order_id);
                this.setRealOrderPrice(w, side, level, roundedBid);
                tickCapitalCommitted += orderCost; // reserved by resting order
              } else {
                // Order failed — likely insufficient balance. Stop placing more.
                ctx.log(`ORDER FAILED: ${side} ${levelLabel} $${roundedBid} — ${result.error?.slice(0, 80) ?? "unknown"}`, { level: "warning" });
                orderFailed = true;
              }
            } catch (e) {
              ctx.log(`ORDER ERROR: ${side} ${levelLabel} $${roundedBid} — ${String(e).slice(0, 80)}`, { level: "warning" });
              orderFailed = true;
            }
          } else {
            // Existing resting order — count its capital commitment (use stored price × bid size)
            const restingPrice = this.getRealOrderPrice(w, side, level);
            tickCapitalCommitted += restingPrice * params.maker_bid_size;
          }
        } else {
          // ── PAPER MODE: Shadow fills from Bonereaper's actual trades ──
          // Process ALL Bonereaper fills we can cover — no cooldown, no one-per-tick limit.
          // Capital/inventory gates are the only constraint. Each Bonereaper fill = one fill for us.
          const processedSet = new Set(w.processedBrFillIds || []);
          const brMatches = this.brActivityCache.filter(br => br.slug === w.market.slug && br.side === side);
          const brCoverable = brMatches.filter(br => !processedSet.has(br.id) && roundedBid >= br.price);
          if (brMatches.length > 0 && ctx.state.ticks % 5 === 0) {
            ctx.log(`SHADOW-DBG: ${side} L${level} bid=$${roundedBid} bookSize=${fillSize} brTotal=${this.brActivityCache.length} matching=${brMatches.length} coverable=${brCoverable.length} processed=${processedSet.size}`, { level: "signal" });
          }
          for (const br of this.brActivityCache) {
            // Re-check capital/inventory per fill (they change as we accumulate)
            const invNow = side === "UP" ? w.upInventory : w.downInventory;
            const costNow = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
            if (invNow >= params.max_inventory_per_side) break;
            // Capital gate: only block heavy side
            const isHeavy = (side === "UP" && w.upInventory >= w.downInventory) ||
                            (side === "DOWN" && w.downInventory >= w.upInventory);
            if (costNow >= params.max_total_cost && isHeavy) break;

            if (br.slug !== w.market.slug) continue;
            if (br.side !== side) continue;
            if (processedSet.has(br.id)) continue;
            if (br.timestamp * 1000 < w.enteredAt) { processedSet.add(br.id); continue; } // skip fills before we entered (timestamp is seconds, enteredAt is ms)
            if (roundedBid < br.price) continue; // our bid doesn't cover their fill price

            // Shadow fill at Bonereaper's price AND size — replicate their exact trade.
            const shadowLabel = level === 2 ? `shadow_L2` : `shadow_L1`;
            const shadowSize = br.size; // use Bonereaper's actual fill size, not our maker_bid_size
            this.recordBuyFill(ctx, w, side, shadowSize, br.price, shadowLabel, false);
            await this.persistTradeToD1(ctx, w, side, "BUY", br.price, shadowSize, 0, shadowLabel);
            processedSet.add(br.id);
            w.processedBrFillIds = [...processedSet];
          }
        }
      }

      // ── Mean-reversion sells (only when merge_exit=false) ───────────
      if (!params.merge_exit && params.sell_enabled) {
        for (const side of ["UP", "DOWN"] as const) {
          const tokens = side === "UP" ? w.upInventory : w.downInventory;
          const avgCost = side === "UP" ? w.upAvgCost : w.downAvgCost;
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
        const pc = (w.upInventory > 0 && w.downInventory > 0) ? (w.upAvgCost + w.downAvgCost).toFixed(2) : "—";
        const skew = totalInvTokens > 0 ? `${Math.round(w.upInventory / totalInvTokens * 100)}/${Math.round(w.downInventory / totalInvTokens * 100)}` : "—";
        const loseSideInvLog = upWinning ? w.downInventory : w.upInventory;
        const loseRatioLog = totalInvTokens > 0 ? loseSideInvLog / totalInvTokens : 0;
        const skewGuarded = totalInvTokens >= params.skew_guard_min_tokens && loseRatioLog > params.max_skew_ratio
          ? " [LOSE-CAP]" : "";
        // Show per-side state: X=crossing (fills at ask), M=maker (fills at bid)
        const upTag = upCrosses ? "X" : (upBid > 0 ? "M" : "-");
        const dnTag = dnCrosses ? "X" : (dnBid > 0 ? "M" : "-");
        const upCdLeft = Math.max(0, Math.round((params.buy_cooldown_ms - (now - (w.lastUpBuyAt || 0))) / 1000));
        const dnCdLeft = Math.max(0, Math.round((params.buy_cooldown_ms - (now - (w.lastDownBuyAt || 0))) / 1000));
        const upAskStr = upAsk !== null ? `a${upAsk.toFixed(2)}` : "a—";
        const dnAskStr = dnAsk !== null ? `a${dnAsk.toFixed(2)}` : "a—";
        ctx.log(
          `TICK: ${w.market.title.slice(0, 25)} P=${pCapped.toFixed(2)} spot=$${currentPrice.toFixed(0)} strike=$${effectiveStrike.toFixed(0)} ↑${upTag}$${upBid.toFixed(2)}(${upAskStr} cd${upCdLeft})/↓${dnTag}$${dnBid.toFixed(2)}(${dnAskStr} cd${dnCdLeft}) inv=${w.upInventory}↑/${w.downInventory}↓ skew=${skew}${skewGuarded} pc=${pc} fills=${w.fillCount}`,
          { level: "signal", symbol: w.cryptoSymbol, signalStrength: pTrue, phase: "tick" },
        );
      }

      const ladderStr = params.ladder_enabled && pricingMode !== "bonereaper" ? `/${upBid2.toFixed(2)}` : "";
      const ladderStrDn = params.ladder_enabled && pricingMode !== "bonereaper" ? `/${dnBid2.toFixed(2)}` : "";
      // Phase label and ladder display for bonereaper mode
      let phaseLabel = "";
      if (pricingMode === "bonereaper") {
        const windowDuration = w.windowEndTime - w.windowOpenTime;
        const elapsedPct = (now - w.windowOpenTime) / windowDuration;
        const isLate = elapsedPct > params.br_suppress_after_pct;
        const isUncertain = pCapped > (0.50 - params.br_uncertain_range) && pCapped < (0.50 + params.br_uncertain_range);
        const isStrong = pCapped > params.br_certainty_threshold || pCapped < (1 - params.br_certainty_threshold);
        const phase = isLate && isStrong ? "LOAD" : !isLate && isUncertain ? "DVB" : "STD";
        const upLadder = (w._upLadder as number[]) || [];
        const dnLadder = (w._dnLadder as number[]) || [];
        const c2 = (n: number) => Math.round(n * 100); // $0.15 → 15
        const fmtL = (arr: number[]) => arr.filter(p => p > 0).map(c2).join("/");
        phaseLabel = ` [${phase}] ${fmtL(upLadder)}|${fmtL(dnLadder)}`;
      }
      // Expose book state for UI visibility
      w.upAsk = upAsk;
      w.dnAsk = dnAsk;
      w.upAskVol = upAskVol;
      w.dnAskVol = dnAskVol;
      const fmtAsk = (p: number | null, v: number) => p != null ? `${Math.round(p*100)}(${Math.round(v)})` : "—";
      const bookStr = upAsk != null || dnAsk != null
        ? ` ask:${fmtAsk(upAsk, upAskVol)}/${fmtAsk(dnAsk, dnAskVol)}`
        : "";
      w.tickAction = `up=${Math.round(upBid*100)} dn=${Math.round(dnBid*100)}${phaseLabel}${bookStr}`;

      this.recordSnapshot(ctx, w, params, pTrue, currentPrice, history, oracleTick);
      acknowledgePriceChange(w.cryptoSymbol);
    }
  }

  // [REMOVED: updateBid — dead code, never called]

  // [REMOVED: checkFills — dead code. Real mode checks inline; paper mode uses shadow fills]

  // ── Resolve windows ───────────────────────────────────────────────

  private async resolveWindows(ctx: StrategyContext, params: BabyBoneRParams): Promise<void> {
    const now = Date.now();
    const toRemove: number[] = [];

    for (let i = 0; i < this.custom.activeWindows.length; i++) {
      const w = this.custom.activeWindows[i];

      const hasOracle = w.oracleStrike != null && isOracleConnected();
      const waitMs = hasOracle ? 2_000 : 60_000; // 2s with oracle (just need final price to settle)
      if (now < w.windowEndTime + waitMs) continue;

      // No inventory and no trades — nothing to resolve
      if (w.upInventory === 0 && w.downInventory === 0 && w.fillCount === 0) {
        ctx.log(`EXPIRED (no fills): ${w.market.title.slice(0, 35)}`);
        toRemove.push(i);
        continue;
      }

      let outcome: "UP" | "DOWN" | "UNKNOWN" = "UNKNOWN";
      let gammaConfirmed = false;

      const effectiveStrike = w.oracleStrike ?? w.priceAtWindowOpen;

      // 1. Oracle (instant — we already have the data, no API call needed)
      const oracleTick = getOracleSpot(w.cryptoSymbol);
      if (hasOracle && oracleTick) {
        outcome = oracleTick.price >= effectiveStrike ? "UP" : "DOWN";
      }

      // 2. Binance fallback
      if (outcome === "UNKNOWN") {
        const history = this.custom.priceHistory[w.cryptoSymbol] || [];
        const closePrice = history.length > 0 ? history[history.length - 1].price : null;
        if (closePrice !== null) {
          outcome = closePrice >= effectiveStrike ? "UP" : "DOWN";
        }
      }

      // 3. Polymarket confirmation (authoritative but slow — runs after oracle resolves)
      try {
        const resolution = await checkMarketResolution(w.market.slug, w.market.upTokenId, w.market.downTokenId);
        if (resolution.closed && resolution.outcome) {
          outcome = resolution.outcome; // override oracle if Gamma disagrees
          gammaConfirmed = true;
        }
      } catch { /* Gamma API failure — oracle/Binance outcome stands */ }

      if (outcome === "UNKNOWN") {
        if (now < w.windowEndTime + 1800_000) continue;
        ctx.log(`RESOLUTION TIMEOUT: ${w.market.title.slice(0, 25)}`);
      }

      // P&L: remaining inventory at resolution
      let resolutionPnl = 0;
      if (outcome !== "UNKNOWN") {
        const winInv = outcome === "UP" ? w.upInventory : w.downInventory;
        const winCost = outcome === "UP" ? w.upAvgCost : w.downAvgCost;
        const loseInv = outcome === "UP" ? w.downInventory : w.upInventory;
        const loseCost = outcome === "UP" ? w.downAvgCost : w.upAvgCost;

        // Guard against NaN from 0-inventory or corrupt avg cost
        const safeWinCost = Number.isFinite(winCost) ? winCost : 0;
        const safeLoseCost = Number.isFinite(loseCost) ? loseCost : 0;

        const payoutFee = calcFeePerShare(1.0, params.fee_params) * winInv;
        const winPayout = winInv * (1.0 - safeWinCost) - payoutFee;
        const loseLoss = -(loseInv * safeLoseCost);
        resolutionPnl = winPayout + loseLoss;
        if (!Number.isFinite(resolutionPnl)) resolutionPnl = 0;
      }

      const netPnl = resolutionPnl + w.realizedSellPnl;

      const completed: CompletedWindow = {
        title: w.market.title,
        cryptoSymbol: w.cryptoSymbol,
        outcome,
        upInventory: w.upInventory,
        downInventory: w.downInventory,
        totalBuyCost: w.totalBuyCost,
        totalSellRevenue: w.totalSellRevenue,
        realizedSellPnl: w.realizedSellPnl,
        resolutionPnl,
        netPnl,
        fillCount: w.fillCount,
        sellCount: w.sellCount,
        completedAt: new Date().toISOString(),
        upAvgCost: w.upAvgCost,
        downAvgCost: w.downAvgCost,
        gammaConfirmed,
        slug: w.market.slug,
        upTokenId: w.market.upTokenId,
        downTokenId: w.market.downTokenId,
        peakUpInventory: w.peakUpInventory ?? 0,
        peakDownInventory: w.peakDownInventory ?? 0,
        totalMerged: w.totalMerged ?? 0,
        totalMergePnl: w.totalMergePnl ?? 0,
        estimatedRebates: w.estimatedRebates ?? 0,
        processedBrFillIds: w.processedBrFillIds?.length ? w.processedBrFillIds : undefined,
        shadowFillStats: this.computeShadowStats(w),
      };

      this.custom.completedWindows.push(completed);
      if (this.custom.completedWindows.length > 50) {
        this.custom.completedWindows = this.custom.completedWindows.slice(-50);
      }

      if (!Number.isFinite(this.custom.totalPnl)) this.custom.totalPnl = 0;
      this.custom.totalPnl += netPnl;
      this.custom.totalEstimatedRebates = (this.custom.totalEstimatedRebates || 0) + (w.estimatedRebates ?? 0);
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

      const pairCost = (w.upInventory > 0 && w.downInventory > 0)
        ? (w.upAvgCost + w.downAvgCost).toFixed(2) : "n/a";
      const paired = Math.min(w.upInventory, w.downInventory);
      const excess = Math.abs(w.upInventory - w.downInventory);
      const exitMode = params.merge_exit ? "merge" : "sell";
      ctx.log(
        `RESOLVED [${exitMode}]: ${w.market.title.slice(0, 25)} ${outcome} | inv ${w.upInventory}↑/${w.downInventory}↓ pc=${pairCost} paired=${paired} excess=${excess} | fills=${w.fillCount} sells=${w.sellCount} | res=$${resolutionPnl.toFixed(2)} sell=$${w.realizedSellPnl.toFixed(2)} net=$${netPnl.toFixed(2)} | W/L=${this.custom.windowsWon}/${this.custom.windowsLost}`,
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
      this.unsubscribeClobWindow(removed);
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
        downBidOrderId: w.downBidOrderId, downBidPrice: w.downBidPrice, downBidSize: w.downBidSize,
        upInventory: w.upInventory, downInventory: w.downInventory,
        upAvgCost: w.upAvgCost, downAvgCost: w.downAvgCost,
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
