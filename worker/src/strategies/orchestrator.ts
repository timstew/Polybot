/**
 * Orchestrator Strategy
 *
 * Detects market regime per asset+duration and delegates quoting to the best-fit
 * WindowTactic. The regime→tactic mapping is data (config params), not code.
 *
 * Lifecycle ported from unified-adaptive: discovery, entry, resolution, redemption,
 * balance protection. Per-window quoting delegated to tactics via WindowTactic interface.
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
} from "./price-feed";
import type { WindowTactic, WindowState, TacticContext } from "./tactic";
import { getTactic, listTactics, emptyWindowState, getBestAsk } from "./tactic";
import {
  type RegimeType,
  type RegimeState,
  type RegimeFeatures,
  ALL_REGIME_TYPES,
  computeRegimeFeatures,
  updateRegimeState,
  emptyRegimeState,
} from "./regime";

// Ensure tactics are registered (side-effect imports)
import "./sniper-tactic";
import "./maker-tactic";
import "./safe-maker-tactic";
import "./scaling-safe-maker-tactic";
import "./conviction-tactic";
import "./enhanced-tactic";
import "./certainty-tactic";
import "./avellaneda-tactic";


// ── Config ──

interface OrchestratorParams {
  target_cryptos: string[];
  min_bid_size: number;
  max_bid_size: number;
  default_bid_size: number;
  max_concurrent_windows: number;
  discovery_interval_ms: number;
  enable_order_flow: boolean;
  observation_seconds: number;
  stop_quoting_before_end_ms: number;
  exit_inventory_before_end_ms: number;
  fee_params: FeeParams;
  // Regime→tactic mapping (data, not code)
  regime_mapping: Record<string, string[]>;
  regime_overrides: Record<string, Record<string, string[]>>;
  tactic_params: Record<string, Record<string, unknown>>;
  // Bandit (Thompson Sampling) for tactic selection
  bandit_enabled: boolean;
  min_explore_pct: number;
  bandit_min_samples: number;
  bandit_cold_start_bonus: number;
  // Inherited params passed through to tactics
  dead_zone_pct: number;
  grounded_fills: boolean;
}

const DEFAULT_PARAMS: OrchestratorParams = {
  target_cryptos: ["Bitcoin", "Ethereum", "Solana", "XRP"],
  min_bid_size: 10,
  max_bid_size: 200,
  default_bid_size: 30,
  max_concurrent_windows: 12,
  discovery_interval_ms: 15_000,
  enable_order_flow: false,
  observation_seconds: 10,
  stop_quoting_before_end_ms: 45_000,
  exit_inventory_before_end_ms: 15_000,
  fee_params: CRYPTO_FEES,
  regime_mapping: {
    trending: ["directional-maker"],
    oscillating: ["sniper"],
    calm: ["sniper"],
    volatile: ["sniper"],
    "near-strike": ["sniper"],
    "late-window": ["sniper"],
  },
  regime_overrides: {},
  tactic_params: {},
  bandit_enabled: true,
  min_explore_pct: 0.10,
  bandit_min_samples: 5,
  bandit_cold_start_bonus: 0.5,
  dead_zone_pct: 0,
  grounded_fills: true,
};

// ── Bandit types ──

interface TacticScore {
  n: number;
  totalPnl: number;
  sumPnlSq: number;
  wins: number;
  losses: number;
  avgPnl: number;
  variance: number;
}

function randomNormal(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── State ──

interface OrchestratorCustomState {
  activeWindows: WindowState[];
  completedWindows: CompletedWindow[];
  priceHistory: Record<string, PriceSnapshot[]>;
  windowRefPrices: Record<string, { price: number; recordedAt: number }>;
  assetRegimes: Record<string, RegimeState>;
  stats: OrchestratorStats;
  pendingRedeems: { conditionIds: string[]; addedAt: number; attempts: number; value: number }[];
  resolvingValue: number;
  scanStatus: string;
}

interface CompletedWindow {
  title: string;
  cryptoSymbol: string;
  tacticId: string;
  regime: RegimeType;
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
  windowDurationMs: number;
}

interface OrchestratorStats {
  totalPnl: number;
  windowsTraded: number;
  perTactic: Record<string, { windows: number; pnl: number; wins: number }>;
  perRegime: Record<string, { windows: number; pnl: number }>;
}

// ── Helpers ──

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

function durationLabel(title: string): string {
  const ms = parseWindowDurationMs(title);
  if (ms <= 6 * 60_000) return "5min";
  if (ms <= 20 * 60_000) return "15min";
  return "other";
}

function regimeKey(symbol: string, title: string): string {
  return `${symbol}:${durationLabel(title)}`;
}

function emptyStats(): OrchestratorStats {
  return {
    totalPnl: 0,
    windowsTraded: 0,
    perTactic: {},
    perRegime: {},
  };
}

// ── Book Cache ──

interface BookCacheEntry {
  book: OrderBook;
  fetchedAt: number;
}

const BOOK_CACHE_TTL = 5_000;

// ── Strategy ──

class OrchestratorStrategy implements Strategy {
  name = "orchestrator";

  private custom: OrchestratorCustomState = {
    activeWindows: [],
    completedWindows: [],
    priceHistory: {},
    windowRefPrices: {},
    assetRegimes: {},
    stats: emptyStats(),
    pendingRedeems: [],
    resolvingValue: 0,
    scanStatus: "Starting up…",
  };

  private marketCache: CryptoMarket[] = [];
  private lastDiscovery = 0;
  private bookCache: Map<string, BookCacheEntry> = new Map();
  private tacticInstances: Map<string, WindowTactic> = new Map();
  private scoreCache: Map<string, TacticScore> = new Map();

  private async getBookCached(ctx: StrategyContext, tokenId: string): Promise<OrderBook> {
    const now = Date.now();
    const cached = this.bookCache.get(tokenId);
    if (cached && now - cached.fetchedAt < BOOK_CACHE_TTL) return cached.book;
    const book = await ctx.api.getBook(tokenId);
    this.bookCache.set(tokenId, { book, fetchedAt: now });
    return book;
  }

  private getOrCreateTactic(tacticId: string): WindowTactic | null {
    let instance = this.tacticInstances.get(tacticId);
    if (instance) return instance;
    instance = getTactic(tacticId) ?? undefined;
    if (instance) this.tacticInstances.set(tacticId, instance);
    return instance ?? null;
  }

  // ── Lifecycle ──

  async init(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as OrchestratorParams;
    const stored = ctx.state.custom as unknown as Partial<OrchestratorCustomState> | undefined;
    if (stored) {
      this.custom = {
        activeWindows: stored.activeWindows || [],
        completedWindows: stored.completedWindows || [],
        priceHistory: stored.priceHistory || {},
        windowRefPrices: stored.windowRefPrices || {},
        assetRegimes: stored.assetRegimes || {},
        stats: stored.stats || emptyStats(),
        pendingRedeems: stored.pendingRedeems || [],
        resolvingValue: stored.resolvingValue || 0,
        scanStatus: stored.scanStatus || "Resuming…",
      };
      // Ensure new fields on restored windows
      for (const w of this.custom.activeWindows) {
        if (w.lastUpBestAsk === undefined) w.lastUpBestAsk = 0;
        if (w.lastDnBestAsk === undefined) w.lastDnBestAsk = 0;
        if (!w.processedFillIds) w.processedFillIds = [];
        if (!w.tacticState) w.tacticState = {};
        if (!w.tacticId) w.tacticId = "sniper";
      }
    }

    // Reconcile totalPnl from D1
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

    // Load bandit tactic scores from D1
    try {
      const rows = await ctx.db.prepare(
        "SELECT regime, tactic_id, n, total_pnl, sum_pnl_sq, wins, losses, avg_pnl, variance FROM tactic_scores WHERE strategy_id = ?"
      ).bind(ctx.config.id).all();
      for (const r of rows.results ?? []) {
        this.scoreCache.set(`${r.regime}:${r.tactic_id}`, {
          n: r.n as number, totalPnl: r.total_pnl as number,
          sumPnlSq: r.sum_pnl_sq as number, wins: r.wins as number,
          losses: r.losses as number, avgPnl: r.avg_pnl as number,
          variance: r.variance as number,
        });
      }
      if (this.scoreCache.size > 0) {
        ctx.log(`Bandit: loaded ${this.scoreCache.size} tactic scores from D1`);
      }
    } catch { /* first run, table may not exist yet */ }

    if (params.enable_order_flow) {
      const symbols = params.target_cryptos
        .map((c) => CRYPTO_SYMBOL_MAP[c.toLowerCase()])
        .filter(Boolean) as string[];
      if (symbols.length > 0) enableOrderFlow(symbols);
    }

    const currentBalance = (ctx.config.balance_usd ?? 0) + ctx.state.total_pnl;
    const regimeCount = Object.keys(this.custom.assetRegimes).length;
    const tacticList = listTactics().map(t => t.id).join(", ");
    ctx.log(
      `Orchestrator started: bal=$${currentBalance.toFixed(2)} maxCap=$${ctx.config.max_capital_usd.toFixed(2)} regimes=${regimeCount} tactics=[${tacticList}] windows=${this.custom.stats.windowsTraded}`
    );
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as OrchestratorParams;
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

    // 3. Manage active windows (dispatch to tactics)
    await this.manageWindows(ctx, params);

    // 4. Enter new windows
    if (!ctx.windingDown && this.custom.activeWindows.length < params.max_concurrent_windows) {
      await this.enterWindows(ctx, params);
    }

    // 4b. Wind-down: drop empty windows
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

    // 6. Process pending redemptions
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
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as OrchestratorParams;
    if (params.enable_order_flow) disableOrderFlow();
    const currentBalance = (ctx.config.balance_usd ?? 0) + ctx.state.total_pnl;
    ctx.log(
      `Stopped. bal=$${currentBalance.toFixed(2)} P&L=$${this.custom.stats.totalPnl.toFixed(2)} windows=${this.custom.stats.windowsTraded}`
    );
  }

  // ── Select tactic for a regime (Thompson Sampling) ──

  private selectTacticId(params: OrchestratorParams, assetKey: string, regime: RegimeType): string {
    const candidates = this.getCandidates(params, assetKey, regime);
    if (candidates.length <= 1) return candidates[0] ?? "sniper";

    if (!params.bandit_enabled) return candidates[0]; // deterministic mode

    // Forced exploration: pick random non-primary
    if (params.min_explore_pct > 0 && Math.random() < params.min_explore_pct) {
      const nonPrimary = candidates.slice(1);
      return nonPrimary[Math.floor(Math.random() * nonPrimary.length)];
    }

    // Thompson Sampling
    let bestId = candidates[0];
    let bestSample = -Infinity;
    for (const tid of candidates) {
      const score = this.scoreCache.get(`${regime}:${tid}`);
      const sample = this.thompsonSample(score, params);
      if (sample > bestSample) { bestSample = sample; bestId = tid; }
    }
    return bestId;
  }

  private getCandidates(params: OrchestratorParams, assetKey: string, regime: RegimeType): string[] {
    // Per-asset override
    const overrides = params.regime_overrides[assetKey];
    if (overrides?.[regime]?.length) {
      const valid = overrides[regime].filter(tid => getTactic(tid));
      if (valid.length > 0) return valid;
    }
    // Global mapping
    const mapping = params.regime_mapping[regime];
    if (mapping?.length) {
      const valid = mapping.filter(tid => getTactic(tid));
      if (valid.length > 0) return valid;
    }
    return ["sniper"];
  }

  private thompsonSample(score: TacticScore | undefined, params: OrchestratorParams): number {
    const minSamples = params.bandit_min_samples;
    const coldBonus = params.bandit_cold_start_bonus;
    if (!score || score.n < minSamples) {
      const n = score?.n ?? 0;
      const mu = score?.avgPnl ?? 0;
      const bonus = coldBonus * (1 - n / minSamples);
      return mu + bonus + randomNormal() * 1.0; // wide prior
    }
    const posteriorVar = Math.max(score.variance / score.n, 0.001);
    return score.avgPnl + randomNormal() * Math.sqrt(posteriorVar);
  }

  // ── Build TacticContext ──

  private buildTacticContext(
    ctx: StrategyContext, w: WindowState, signal: WindowSignal,
    params: OrchestratorParams,
  ): TacticContext {
    const history = this.custom.priceHistory[w.cryptoSymbol] || [];
    const tacticOverrides = params.tactic_params[w.tacticId] || {};
    const mergedParams: Record<string, unknown> = {
      ...params,
      ...tacticOverrides,
    };
    return {
      ctx,
      window: w,
      signal,
      priceHistory: history,
      params: mergedParams,
      allWindows: this.custom.activeWindows,
    };
  }

  // ── Enter windows ──

  private async enterWindows(ctx: StrategyContext, params: OrchestratorParams): Promise<void> {
    const now = Date.now();
    const activeConditions = new Set(this.custom.activeWindows.map(w => w.market.conditionId));

    const capitalCommitted = this.custom.activeWindows.reduce((sum, w) => {
      const inv = w.upInventory * w.upAvgCost + w.downInventory * w.downAvgCost;
      const pending = (w.upBidOrderId ? w.upBidSize * w.upBidPrice : 0)
        + (w.downBidOrderId ? w.downBidSize * w.downBidPrice : 0);
      return sum + inv + pending;
    }, 0);
    const maxCapital = ctx.config.max_capital_usd;
    const available = maxCapital - capitalCommitted;
    const minCost = params.min_bid_size * 0.46 * 2;
    if (available < minCost) {
      this.custom.scanStatus = `Capital limit reached ($${capitalCommitted.toFixed(0)}/$${maxCapital.toFixed(0)} deployed)`;
      return;
    }

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

      // Book-aware entry gate
      const upBook = await this.getBookCached(ctx, market.upTokenId);
      const dnBook = await this.getBookCached(ctx, market.downTokenId);
      const upBestAsk = getBestAsk(upBook);
      const dnBestAsk = getBestAsk(dnBook);

      if (upBestAsk === null || dnBestAsk === null) {
        skipCounts["no liquidity"] = (skipCounts["no liquidity"] || 0) + 1;
        continue;
      }

      // Compute signal
      const currentSnap = await fetchSpotPrice(sym);
      if (!currentSnap) continue;
      const signal = computeSignal(
        sym, ref.price, currentSnap.price, now - ref.recordedAt,
        history.filter(s => s.timestamp >= ref.recordedAt)
      );

      // Classify regime
      const rKey = regimeKey(sym, market.title);
      if (!this.custom.assetRegimes[rKey]) {
        this.custom.assetRegimes[rKey] = emptyRegimeState(rKey);
      }
      const features = computeRegimeFeatures(
        history, signal, market.strikePrice, windowOpenTime, endMs,
      );
      this.custom.assetRegimes[rKey] = updateRegimeState(this.custom.assetRegimes[rKey], features);
      const regime = this.custom.assetRegimes[rKey].confirmedRegime;

      // Select tactic
      const tacticId = this.selectTacticId(params, rKey, regime);

      // Log bandit decision
      if (params.bandit_enabled) {
        const score = this.scoreCache.get(`${regime}:${tacticId}`);
        const candidates = this.getCandidates(params, rKey, regime);
        if (candidates.length > 1) {
          ctx.log(
            `BANDIT: ${tacticId} for ${regime} (n=${score?.n ?? 0} avg=${(score?.avgPnl ?? 0).toFixed(3)} candidates=${candidates.join(",")})`,
            { level: "signal", symbol: sym }
          );
        }
      }

      // Bid size (duration-scaled)
      const windowDurationMin = windowDuration / 60_000;
      const durationScale = Math.min(1.0, windowDurationMin / 15);
      let bidSize = Math.max(params.min_bid_size, Math.round(params.default_bid_size * durationScale));

      // Cap to remaining capital
      const estimatedPairCost = 0.92;
      const currentAtRisk = this.custom.activeWindows.reduce(
        (sum, w) => sum + Math.max(0, w.upInventory - w.downInventory) * w.upAvgCost
          + Math.max(0, w.downInventory - w.upInventory) * w.downAvgCost, 0
      );
      const currentAvailable = maxCapital - currentAtRisk;
      const maxBidByCapital = Math.floor(currentAvailable / estimatedPairCost);
      if (maxBidByCapital < params.min_bid_size) continue;
      bidSize = Math.min(bidSize, maxBidByCapital);

      // Create window
      const w = emptyWindowState(market, sym, windowOpenTime, endMs, ref.price, tacticId);

      // Initialize tactic
      const tactic = this.getOrCreateTactic(tacticId);
      if (tactic) {
        const tacticOverrides = params.tactic_params[tacticId] || {};
        const tc: TacticContext = {
          ctx,
          window: w,
          signal,
          priceHistory: history,
          params: { ...params, ...tacticOverrides, default_bid_size: bidSize },
          allWindows: this.custom.activeWindows,
        };
        tactic.onEnter(tc);
      }

      this.custom.activeWindows.push(w);
      activeConditions.add(market.conditionId);
      entered++;

      const regimeState = this.custom.assetRegimes[rKey];
      ctx.log(
        `ENTERED [${tacticId}/${regime}]: ${market.title.slice(0, 35)} ${sym} bidSize=${bidSize} str=${(signal.signalStrength * 100).toFixed(0)}% conf=${(regimeState.confidence * 100).toFixed(0)}%`,
        { level: "signal", symbol: sym, phase: "entry", signalStrength: signal.signalStrength }
      );
    }

    // Update scan status
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

  // ── Manage windows (dispatch to tactics) ──

  private async manageWindows(ctx: StrategyContext, params: OrchestratorParams): Promise<void> {
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

      // Get tactic instance
      const tactic = this.getOrCreateTactic(w.tacticId);
      if (!tactic) {
        w.tickAction = `ERROR: unknown tactic ${w.tacticId}`;
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
        history.filter(s => s.timestamp >= w.windowOpenTime),
        signalOpts
      );

      w.ticksInWindow++;

      const tc = this.buildTacticContext(ctx, w, signal, params);

      // Update regime state periodically (every 10 ticks)
      if (w.ticksInWindow % 10 === 0) {
        const rKey = regimeKey(w.cryptoSymbol, w.market.title);
        if (!this.custom.assetRegimes[rKey]) {
          this.custom.assetRegimes[rKey] = emptyRegimeState(rKey);
        }
        const features = computeRegimeFeatures(
          history, signal, w.market.strikePrice, w.windowOpenTime, w.windowEndTime,
        );
        features.flipCount = w.flipCount;
        this.custom.assetRegimes[rKey] = updateRegimeState(this.custom.assetRegimes[rKey], features);

        // Mid-window re-tactic: if regime changed and no fills yet, switch
        const newRegime = this.custom.assetRegimes[rKey].confirmedRegime;
        const newTacticId = this.selectTacticId(params, rKey, newRegime);
        if (newTacticId !== w.tacticId && w.fillCount === 0) {
          ctx.log(
            `RE-TACTIC: ${w.market.title.slice(0, 25)} ${w.tacticId}→${newTacticId} (regime: ${newRegime})`,
            { level: "signal", symbol: w.cryptoSymbol, phase: "re-tactic" }
          );
          // Cancel old tactic's orders
          await tactic.onCancel(tc);
          // Switch
          w.tacticId = newTacticId;
          const newTactic = this.getOrCreateTactic(newTacticId);
          if (newTactic) {
            const newTc = this.buildTacticContext(ctx, w, signal, params);
            newTactic.onEnter(newTc);
          }
          continue; // skip this tick, let new tactic take over next tick
        }
      }

      // Dispatch to tactic lifecycle phase
      if (timeToEnd < exitMs) {
        await tactic.onExit(tc);
      } else if (timeToEnd < stopQuotingMs) {
        await tactic.onWindDown(tc);
      } else {
        await tactic.onTick(tc);
      }

    }
  }

  // ── Resolve windows ──

  private async resolveWindows(ctx: StrategyContext, params: OrchestratorParams): Promise<void> {
    const now = Date.now();
    const toRemove: number[] = [];
    const windowRedeemValues = new Map<number, number>();

    for (let i = 0; i < this.custom.activeWindows.length; i++) {
      const w = this.custom.activeWindows[i];
      if (now < w.windowEndTime + 10_000) continue;

      if (w.upInventory === 0 && w.downInventory === 0 && w.fillCount === 0) {
        ctx.log(`EXPIRED (no fills): ${w.market.title.slice(0, 35)} [${w.tacticId}]`);
        toRemove.push(i);
        continue;
      }

      // Fully merged/exited windows — P&L already realized via merge/sell trades
      if (w.upInventory === 0 && w.downInventory === 0 && w.fillCount > 0) {
        const netPnl = w.realizedSellPnl; // merge pnl already counted separately
        this.custom.stats.totalPnl += netPnl;
        this.custom.stats.windowsTraded++;

        const rKey = regimeKey(w.cryptoSymbol, w.market.title);
        const regimeAtEntry = this.custom.assetRegimes[rKey]?.confirmedRegime ?? "calm";
        if (!this.custom.stats.perTactic[w.tacticId]) {
          this.custom.stats.perTactic[w.tacticId] = { windows: 0, pnl: 0, wins: 0 };
        }
        this.custom.stats.perTactic[w.tacticId].windows++;
        this.custom.stats.perTactic[w.tacticId].pnl += netPnl;
        if (netPnl >= 0) this.custom.stats.perTactic[w.tacticId].wins++;
        if (!this.custom.stats.perRegime[regimeAtEntry]) {
          this.custom.stats.perRegime[regimeAtEntry] = { windows: 0, pnl: 0 };
        }
        this.custom.stats.perRegime[regimeAtEntry].windows++;
        this.custom.stats.perRegime[regimeAtEntry].pnl += netPnl;

        ctx.log(
          `RESOLVED [${w.tacticId}/${regimeAtEntry}]: ${w.market.title.slice(0, 25)} MERGED fills=${w.fillCount} sells=${w.sellCount} sellPnl=$${netPnl.toFixed(2)} totalPnl=$${this.custom.stats.totalPnl.toFixed(2)}`,
          { level: "signal", symbol: w.cryptoSymbol, phase: "resolve" }
        );

        // Write RESOLVE trade so D1 reconciliation works
        await ctx.db.prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'RESOLVE', 0, 0, 0, datetime('now'), ?)`
        ).bind(
          `orch-resolve-${crypto.randomUUID()}`, ctx.config.id, w.market.conditionId,
          w.market.slug, `${w.market.title} [ORCH ${w.tacticId} MERGED fills=${w.fillCount}]`,
          netPnl
        ).run();

        this.custom.completedWindows.push({
          title: w.market.title, cryptoSymbol: w.cryptoSymbol,
          tacticId: w.tacticId, regime: regimeAtEntry,
          outcome: "UNKNOWN", upInventory: 0, downInventory: 0,
          upAvgCost: w.upAvgCost, downAvgCost: w.downAvgCost,
          matchedPairs: 0, netPnl, fillCount: w.fillCount, sellCount: w.sellCount,
          completedAt: new Date().toISOString(), priceMovePct: 0,
          windowDurationMs: w.windowEndTime - w.windowOpenTime,
        });
        if (this.custom.completedWindows.length > 50) {
          this.custom.completedWindows = this.custom.completedWindows.slice(-50);
        }

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

      // Per-tactic stats
      if (!this.custom.stats.perTactic[w.tacticId]) {
        this.custom.stats.perTactic[w.tacticId] = { windows: 0, pnl: 0, wins: 0 };
      }
      const tacticStats = this.custom.stats.perTactic[w.tacticId];
      tacticStats.windows++;
      tacticStats.pnl += netPnl;
      if (netPnl > 0) tacticStats.wins++;

      // Per-regime stats
      const rKey = regimeKey(w.cryptoSymbol, w.market.title);
      const regimeAtEntry = this.custom.assetRegimes[rKey]?.confirmedRegime ?? "calm";
      if (!this.custom.stats.perRegime[regimeAtEntry]) {
        this.custom.stats.perRegime[regimeAtEntry] = { windows: 0, pnl: 0 };
      }
      const regimeStats = this.custom.stats.perRegime[regimeAtEntry];
      regimeStats.windows++;
      regimeStats.pnl += netPnl;

      // Update regime state on resolution
      if (this.custom.assetRegimes[rKey]) {
        const features = computeRegimeFeatures(
          history, {
            symbol: w.cryptoSymbol,
            windowOpenPrice: w.priceAtWindowOpen,
            currentPrice: closePrice ?? w.priceAtWindowOpen,
            priceChangePct: priceMovePct,
            direction: outcome === "UNKNOWN" ? "UP" : outcome,
            signalStrength: 0,
            velocity: 0,
            sampleCount: 0,
            momentum: 0,
            acceleration: 0,
            volatilityRegime: "normal",
            confidenceMultiplier: 1,
            orderFlowImbalance: 0,
            orderFlowAvailable: false,
            oracleAvailable: false,
            rawDirection: outcome === "UNKNOWN" ? "UP" : outcome,
            inDeadZone: false,
          },
          w.market.strikePrice, w.windowOpenTime, w.windowEndTime,
        );
        features.flipCount = w.flipCount;
        this.custom.assetRegimes[rKey] = updateRegimeState(this.custom.assetRegimes[rKey], features);
      }

      // Log regime performance to D1
      try {
        const regimeState = this.custom.assetRegimes[rKey];
        const regimeFeatures = computeRegimeFeatures(
          history, {
            symbol: w.cryptoSymbol, windowOpenPrice: w.priceAtWindowOpen,
            currentPrice: closePrice ?? w.priceAtWindowOpen,
            priceChangePct: priceMovePct, direction: outcome === "UNKNOWN" ? "UP" : outcome,
            signalStrength: 0, velocity: 0, sampleCount: 0, momentum: 0, acceleration: 0,
            volatilityRegime: "normal", confidenceMultiplier: 1,
            orderFlowImbalance: 0, orderFlowAvailable: false,
            oracleAvailable: false,
            rawDirection: outcome === "UNKNOWN" ? "UP" : outcome, inDeadZone: false,
          },
          w.market.strikePrice, w.windowOpenTime, w.windowEndTime,
        );
        await ctx.db.prepare(
          `INSERT INTO strategy_regime_log (strategy_id, condition_id, symbol, window_duration_ms, regime, regime_confidence, regime_streak, tactic_id, features, ema_scores, outcome, pnl, fill_count, pair_cost, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).bind(
          ctx.config.id, w.market.conditionId, w.cryptoSymbol,
          w.windowEndTime - w.windowOpenTime,
          regimeState?.confirmedRegime ?? "calm",
          regimeState?.confidence ?? 0,
          regimeState?.streak ?? 0,
          w.tacticId,
          JSON.stringify(regimeFeatures),
          JSON.stringify(regimeState?.emaScores ?? {}),
          outcome, netPnl, w.fillCount,
          w.upInventory > 0 && w.downInventory > 0 ? w.upAvgCost + w.downAvgCost : null,
        ).run();
      } catch { /* D1 write failure is non-fatal */ }

      // Update bandit tactic score
      try {
        const cacheKey = `${regimeAtEntry}:${w.tacticId}`;
        const prev = this.scoreCache.get(cacheKey) ?? { n: 0, totalPnl: 0, sumPnlSq: 0, wins: 0, losses: 0, avgPnl: 0, variance: 0 };
        const newN = prev.n + 1;
        const newTotal = prev.totalPnl + netPnl;
        const newSumSq = prev.sumPnlSq + netPnl * netPnl;
        const newAvg = newTotal / newN;
        const newVar = newN > 1 ? (newSumSq / newN) - newAvg * newAvg : 0;
        const updated: TacticScore = {
          n: newN, totalPnl: newTotal, sumPnlSq: newSumSq,
          wins: prev.wins + (netPnl > 0 ? 1 : 0),
          losses: prev.losses + (netPnl <= 0 ? 1 : 0),
          avgPnl: newAvg, variance: Math.max(newVar, 0),
        };
        this.scoreCache.set(cacheKey, updated);

        await ctx.db.prepare(`
          INSERT INTO tactic_scores (strategy_id, regime, tactic_id, n, total_pnl, sum_pnl_sq, wins, losses, avg_pnl, variance, last_updated_at)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 0, datetime('now'))
          ON CONFLICT (strategy_id, regime, tactic_id) DO UPDATE SET
            n = n + 1,
            total_pnl = total_pnl + excluded.total_pnl,
            sum_pnl_sq = sum_pnl_sq + excluded.sum_pnl_sq,
            wins = wins + excluded.wins,
            losses = losses + excluded.losses,
            avg_pnl = (total_pnl + excluded.total_pnl) / (n + 1),
            variance = CASE WHEN n + 1 > 1
              THEN (sum_pnl_sq + excluded.sum_pnl_sq) / (n + 1) - ((total_pnl + excluded.total_pnl) / (n + 1)) * ((total_pnl + excluded.total_pnl) / (n + 1))
              ELSE 0 END,
            last_updated_at = datetime('now')
        `).bind(
          ctx.config.id, regimeAtEntry, w.tacticId,
          netPnl, netPnl * netPnl,
          netPnl > 0 ? 1 : 0, netPnl <= 0 ? 1 : 0,
          netPnl,
        ).run();
      } catch { /* D1 write failure is non-fatal */ }

      this.custom.completedWindows.push({
        title: w.market.title, cryptoSymbol: w.cryptoSymbol,
        tacticId: w.tacticId, regime: regimeAtEntry,
        outcome, upInventory: w.upInventory, downInventory: w.downInventory,
        upAvgCost: w.upAvgCost, downAvgCost: w.downAvgCost,
        matchedPairs: matched, netPnl, fillCount: w.fillCount, sellCount: w.sellCount,
        completedAt: new Date().toISOString(), priceMovePct,
        windowDurationMs: w.windowEndTime - w.windowOpenTime,
      });
      if (this.custom.completedWindows.length > 50) {
        this.custom.completedWindows = this.custom.completedWindows.slice(-50);
      }

      ctx.log(
        `RESOLVED [${w.tacticId}/${regimeAtEntry}]: ${w.market.title.slice(0, 25)} ${outcome} inv=${w.upInventory}/${w.downInventory} matched=${matched} net=$${netPnl.toFixed(2)} totalPnl=$${this.custom.stats.totalPnl.toFixed(2)}`,
        { level: "signal", symbol: w.cryptoSymbol, upInventory: w.upInventory, downInventory: w.downInventory, phase: "resolve" }
      );

      await ctx.db.prepare(
        `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
         VALUES (?, ?, ?, ?, ?, 'RESOLVE', 0, 0, 0, datetime('now'), ?)`
      ).bind(
        `orch-resolve-${crypto.randomUUID()}`, ctx.config.id, w.market.conditionId,
        w.market.slug, `${w.market.title} [ORCH ${w.tacticId} ${outcome} matched=${matched}]`,
        netPnl
      ).run();

      toRemove.push(i);
    }

    // Queue resolved conditions for deferred redemption
    if (ctx.config.mode === "real" && toRemove.length > 0) {
      const conditionIds = toRemove
        .map(i => this.custom.activeWindows[i]?.market.conditionId)
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

  // ── Deferred redemption ──

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
          if (entry.attempts < MAX_ATTEMPTS) kept.push(entry);
          else {
            this.custom.resolvingValue = Math.max(0, this.custom.resolvingValue - (entry.value || 0));
            ctx.log(`AUTO-REDEEM GAVE UP after ${MAX_ATTEMPTS} attempts`, { level: "error" } as never);
          }
        } else if (result.redeemed > 0) {
          this.custom.resolvingValue = Math.max(0, this.custom.resolvingValue - (entry.value || 0));
          ctx.log(`AUTO-REDEEM OK: ${result.redeemed}/${entry.conditionIds.length} redeemed`);
        } else {
          if (entry.attempts < MAX_ATTEMPTS) kept.push(entry);
          else {
            this.custom.resolvingValue = Math.max(0, this.custom.resolvingValue - (entry.value || 0));
          }
        }
      } catch {
        if (entry.attempts < MAX_ATTEMPTS) kept.push(entry);
      }
    }

    this.custom.pendingRedeems = kept;
  }
}

// ── Register ──

registerStrategy("orchestrator", () => new OrchestratorStrategy());
