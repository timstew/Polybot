/**
 * Portable strategy execution framework.
 *
 * Contains all interfaces, API implementations, and helpers that are shared
 * between the Cloudflare Worker (StrategyDO) and the standalone Node.js runner.
 * No Cloudflare-specific dependencies (DurableObject, DurableObjectState).
 */

// ── Interfaces ───────────────────────────────────────────────────────

export interface StrategyConfig {
  id: string;
  name: string;
  strategy_type: string;
  mode: "paper" | "real";
  active: boolean;
  params: Record<string, unknown>;
  tick_interval_ms: number;
  max_capital_usd: number;
  balance_usd: number | null;
  lock_increment_usd: number | null;
  created_at: string;
  updated_at: string;
}

export interface OrderState {
  id: string;
  token_id: string;
  market: string;
  title: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  originalSize: number;
  filled: number;
  status: "open" | "filled" | "cancelled" | "failed";
  placed_at: string;
}

export interface PositionState {
  token_id: string;
  market: string;
  title: string;
  side: "BUY" | "SELL";
  size: number;
  avg_price: number;
  cost: number;
}

export interface LogEntry {
  ts: string;
  msg: string;
  data?: StructuredLogData;
}

export interface StructuredLogData {
  level?: "info" | "signal" | "trade" | "warning" | "error";
  symbol?: string;
  direction?: "UP" | "DOWN";
  signalStrength?: number;
  priceChangePct?: number;
  momentum?: number;
  volatilityRegime?: string;
  inDeadZone?: boolean;
  flipCount?: number;
  upInventory?: number;
  downInventory?: number;
  phase?: string;
}

export interface StrategyState {
  open_orders: OrderState[];
  positions: PositionState[];
  total_pnl: number;
  capital_deployed: number;
  last_tick_at: string;
  started_at: string;
  ticks: number;
  errors: number;
  cumulative_runtime_ms: number;
  custom: Record<string, unknown>;
  logs: LogEntry[];
  high_water_balance: number;
  windingDown: boolean;
  wallet_balance_at_start: number | null;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface PlaceOrderResult {
  order_id: string;
  status: "placed" | "filled" | "failed";
  size: number;
  price: number;
  error?: string;
}

export interface OrderStatusResult {
  order_id: string;
  status: string;
  size_matched: number;
  original_size: number;
  price: number;
}

export interface ActivityTrade {
  id: string;
  asset: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  timestamp: string;
  type: string;
}

export type OrderType = "GTC" | "FAK" | "FOK";

export interface StrategyAPI {
  placeOrder(params: {
    token_id: string;
    side: "BUY" | "SELL";
    size: number;
    price: number;
    market?: string;
    title?: string;
    order_type?: OrderType;
  }): Promise<PlaceOrderResult>;

  cancelOrder(order_id: string): Promise<boolean>;
  cancelAllOrders(): Promise<{ success: boolean }>;
  getOrderStatus(order_id: string): Promise<OrderStatusResult>;
  getBook(token_id: string): Promise<OrderBook>;
  getBalance(): Promise<number>;
  getOpenOrders(): Promise<OrderState[]>;
  getActivity(limit?: number): Promise<ActivityTrade[]>;
  redeemConditions(conditionIds: string[]): Promise<{ redeemed: number; error?: string }>;
  mergePositions(conditionId: string, amount: number): Promise<{
    status: "merged" | "failed";
    tx_hash?: string;
    duration_ms?: number;
    error?: string;
  }>;
}

export interface StrategyContext {
  config: StrategyConfig;
  state: StrategyState;
  api: StrategyAPI;
  db: D1Database;
  log: (msg: string, data?: StructuredLogData) => void;
  windingDown: boolean;
}

export interface Strategy {
  name: string;
  init(ctx: StrategyContext): Promise<void>;
  tick(ctx: StrategyContext): Promise<void>;
  stop(ctx: StrategyContext): Promise<void>;
}

// ── Safe cancel helper ──────────────────────────────────────────────

export interface SafeCancelResult {
  cleared: boolean;
  fill?: { size: number; price: number };
}

export async function safeCancelOrder(
  api: StrategyAPI,
  orderId: string,
): Promise<SafeCancelResult> {
  const cancelled = await api.cancelOrder(orderId);
  if (cancelled) return { cleared: true };

  try {
    const status = await api.getOrderStatus(orderId);
    if (status.status === "MATCHED") {
      return {
        cleared: true,
        fill: { size: status.size_matched, price: status.price },
      };
    }
    if (status.status === "CANCELLED") return { cleared: true };
    return { cleared: false };
  } catch {
    return { cleared: false };
  }
}

// ── Paper API (simulates fills from live book data) ─────────────────

let paperOrderCounter = 0;

export interface PaperFillConfig {
  takerFillRate: number;
  slippageBps: number;
  makerFillProb: number;
}

const DEFAULT_PAPER_FILL: PaperFillConfig = {
  takerFillRate: 0.65,
  slippageBps: 30,
  makerFillProb: 0.4,
};

export class PaperStrategyAPI implements StrategyAPI {
  private pythonApiUrl: string;
  private orders: OrderState[] = [];
  private fillConfig: PaperFillConfig;
  private grounded: boolean;
  balanceOverride: number | null = null;

  constructor(pythonApiUrl: string, fillConfig?: Partial<PaperFillConfig>, grounded = true) {
    this.pythonApiUrl = pythonApiUrl;
    this.fillConfig = { ...DEFAULT_PAPER_FILL, ...fillConfig };
    this.grounded = grounded;
  }

  private async simulatePaperFill(
    bidPrice: number,
    bidSize: number,
    book: OrderBook,
    tokenId: string,
    placedAtMs?: number,
  ): Promise<{ filled: boolean; fillPrice: number }> {
    const bestAsk = book.asks.length > 0
      ? Math.min(...book.asks.map(a => a.price))
      : null;

    if (bestAsk !== null && bidPrice >= bestAsk) {
      // Check available size at ask levels we can hit (same logic as placeOrder)
      let availableSize = 0;
      for (const level of book.asks) {
        if (level.price <= bidPrice) {
          availableSize += Math.floor(level.size * this.fillConfig.takerFillRate);
        }
      }
      if (availableSize >= bidSize) {
        return { filled: true, fillPrice: bestAsk };
      }
      // Not enough size at the ask — fall through to grounded tape check or prob model
    }

    if (this.grounded) {
      const { fetchTradeTape, checkTapeFill } = await import("./strategies/price-feed");
      const tape = await fetchTradeTape();

      const queueAhead = book.bids
        .filter(b => b.price >= bidPrice)
        .reduce((sum, b) => sum + b.size, 0);

      return checkTapeFill(tape, tokenId, bidPrice, bidSize, placedAtMs, queueAhead);
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

  async placeOrder(params: {
    token_id: string;
    side: "BUY" | "SELL";
    size: number;
    price: number;
    market?: string;
    title?: string;
    order_type?: OrderType;
  }): Promise<PlaceOrderResult> {
    const orderType = params.order_type || "GTC";

    const book = await this.getBook(params.token_id);
    const levels = params.side === "BUY" ? book.asks : book.bids;

    const bestOpposite = levels.length > 0 ? levels[0].price : null;
    const crossesSpread = bestOpposite !== null && (
      params.side === "BUY" ? params.price >= bestOpposite :
      params.price <= bestOpposite
    );

    let remaining = params.size;
    let totalCost = 0;
    let filledSize = 0;

    if (crossesSpread) {
      for (const level of levels) {
        const priceOk =
          params.side === "BUY"
            ? level.price <= params.price
            : level.price >= params.price;
        if (!priceOk) continue;

        const availableAtLevel = Math.floor(level.size * this.fillConfig.takerFillRate);
        if (availableAtLevel <= 0) continue;

        const fillAtLevel = Math.min(remaining, availableAtLevel);
        totalCost += fillAtLevel * level.price;
        filledSize += fillAtLevel;
        remaining -= fillAtLevel;
        if (remaining <= 0) break;
      }
    }

    const id = `paper-${Date.now()}-${++paperOrderCounter}`;

    if (orderType === "FAK") {
      const actualFilled = filledSize;
      let vwap = actualFilled > 0 ? totalCost / actualFilled : params.price;
      if (actualFilled > 0 && this.fillConfig.slippageBps > 0) {
        const slippageMult = this.fillConfig.slippageBps / 10000;
        vwap = params.side === "BUY"
          ? Math.min(1.0, vwap * (1 + slippageMult))
          : Math.max(0.01, vwap * (1 - slippageMult));
      }
      const order: OrderState = {
        id, token_id: params.token_id, market: params.market || "",
        title: params.title || "", side: params.side, price: vwap,
        size: actualFilled, originalSize: params.size, filled: actualFilled,
        status: actualFilled > 0 ? "filled" : "cancelled",
        placed_at: new Date().toISOString(),
      };
      this.orders.push(order);
      return {
        order_id: id,
        status: actualFilled > 0 ? "filled" : "failed",
        size: actualFilled,
        price: vwap,
      };
    }

    if (orderType === "FOK") {
      const wouldFillAll = filledSize >= params.size;
      if (!wouldFillAll) {
        return { order_id: id, status: "failed", size: 0, price: params.price };
      }
      let vwap = totalCost / params.size;
      if (this.fillConfig.slippageBps > 0) {
        const slippageMult = this.fillConfig.slippageBps / 10000;
        vwap = params.side === "BUY"
          ? Math.min(1.0, vwap * (1 + slippageMult))
          : Math.max(0.01, vwap * (1 - slippageMult));
      }
      const order: OrderState = {
        id, token_id: params.token_id, market: params.market || "",
        title: params.title || "", side: params.side, price: vwap,
        size: params.size, originalSize: params.size, filled: params.size,
        status: "filled", placed_at: new Date().toISOString(),
      };
      this.orders.push(order);
      return { order_id: id, status: "filled", size: params.size, price: vwap };
    }

    // GTC
    const wouldFill = filledSize >= params.size;
    const partialFill = !wouldFill && filledSize >= params.size * 0.2;
    const actualFilled = wouldFill ? params.size : (partialFill ? filledSize : 0);
    let vwap = actualFilled > 0 ? totalCost / actualFilled : params.price;

    if (actualFilled > 0 && this.fillConfig.slippageBps > 0) {
      const slippageMult = this.fillConfig.slippageBps / 10000;
      if (params.side === "BUY") {
        vwap = Math.min(1.0, vwap * (1 + slippageMult));
      } else {
        vwap = Math.max(0.01, vwap * (1 - slippageMult));
      }
    }

    const order: OrderState = {
      id,
      token_id: params.token_id,
      market: params.market || "",
      title: params.title || "",
      side: params.side,
      price: actualFilled > 0 ? vwap : params.price,
      size: actualFilled > 0 ? actualFilled : params.size,
      originalSize: params.size,
      filled: actualFilled,
      status: actualFilled > 0 ? "filled" : "open",
      placed_at: new Date().toISOString(),
    };

    this.orders.push(order);

    if (this.orders.length > 500) {
      this.orders = this.orders.filter(
        (o) => o.status === "open" || Date.now() - new Date(o.placed_at).getTime() < 300_000
      );
    }

    return {
      order_id: id,
      status: actualFilled > 0 ? "filled" : "placed",
      size: actualFilled > 0 ? actualFilled : params.size,
      price: vwap,
    };
  }

  async cancelAllOrders(): Promise<{ success: boolean }> {
    // Paper mode: just clear all open orders
    this.orders = this.orders.filter(o => o.status !== "open");
    return { success: true };
  }

  async cancelOrder(order_id: string): Promise<boolean> {
    const order = this.orders.find((o) => o.id === order_id);
    if (!order || order.status !== "open") return false;

    const book = await this.getBook(order.token_id);
    const placedMs = new Date(order.placed_at).getTime();
    const result = await this.simulatePaperFill(
      order.price, order.originalSize, book, order.token_id, placedMs,
    );
    if (result.filled) {
      order.status = "filled";
      order.price = result.fillPrice;
      order.filled = order.originalSize;
      return false;
    }

    order.status = "cancelled";
    return true;
  }

  async getBook(token_id: string): Promise<OrderBook> {
    try {
      const resp = await fetch(
        `https://clob.polymarket.com/book?token_id=${token_id}`
      );
      if (!resp.ok) return { bids: [], asks: [] };
      const data = (await resp.json()) as {
        bids?: { price: string; size: string }[];
        asks?: { price: string; size: string }[];
      };
      return {
        bids: (data.bids || []).map((l) => ({
          price: parseFloat(l.price),
          size: parseFloat(l.size),
        })),
        asks: (data.asks || []).map((l) => ({
          price: parseFloat(l.price),
          size: parseFloat(l.size),
        })),
      };
    } catch {
      return { bids: [], asks: [] };
    }
  }

  async getOrderStatus(order_id: string): Promise<OrderStatusResult> {
    const order = this.orders.find((o) => o.id === order_id);
    if (!order) {
      return { order_id, status: "UNKNOWN", size_matched: 0, original_size: 0, price: 0 };
    }

    if (order.status !== "open") {
      return {
        order_id,
        status: order.status === "filled" ? "MATCHED" : "CANCELLED",
        size_matched: order.status === "filled" ? order.filled : 0,
        original_size: order.originalSize,
        price: order.price,
      };
    }

    const book = await this.getBook(order.token_id);
    const placedMs = new Date(order.placed_at).getTime();
    const result = await this.simulatePaperFill(
      order.price, order.originalSize, book, order.token_id, placedMs,
    );
    if (result.filled) {
      order.status = "filled";
      order.price = result.fillPrice;
      order.filled = order.originalSize;
      return {
        order_id,
        status: "MATCHED",
        size_matched: order.originalSize,
        original_size: order.originalSize,
        price: result.fillPrice,
      };
    }

    return {
      order_id,
      status: "LIVE",
      size_matched: 0,
      original_size: order.originalSize,
      price: order.price,
    };
  }

  async getBalance(): Promise<number> {
    return this.balanceOverride ?? 10000;
  }

  async getOpenOrders(): Promise<OrderState[]> {
    return this.orders.filter((o) => o.status === "open");
  }

  async getActivity(_limit?: number): Promise<ActivityTrade[]> {
    return [];
  }

  async redeemConditions(_conditionIds: string[]): Promise<{ redeemed: number }> {
    return { redeemed: 0 };
  }

  async mergePositions(_conditionId: string, _amount: number): Promise<{
    status: "merged" | "failed"; tx_hash?: string; duration_ms?: number; error?: string;
  }> {
    return { status: "merged", duration_ms: 0 };
  }
}

// ── Real API (places actual orders via Cloud Run) ───────────────────

export class RealStrategyAPI implements StrategyAPI {
  private pythonApiUrl: string;

  constructor(pythonApiUrl: string) {
    this.pythonApiUrl = pythonApiUrl;
  }

  async placeOrder(params: {
    token_id: string;
    side: "BUY" | "SELL";
    size: number;
    price: number;
    market?: string;
    title?: string;
    order_type?: OrderType;
  }): Promise<PlaceOrderResult> {
    try {
      const resp = await fetch(`${this.pythonApiUrl}/api/strategy/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token_id: params.token_id,
          side: params.side,
          size: params.size,
          price: params.price,
          order_type: params.order_type || "GTC",
        }),
      });
      const data = (await resp.json()) as {
        status: string;
        order_id?: string;
        size?: number;
        price?: number;
        error?: string;
      };
      return {
        order_id: data.order_id || "",
        status: data.status === "filled" ? "filled" : data.status === "placed" ? "placed" : "failed",
        size: data.size || params.size,
        price: data.price || params.price,
        error: data.error,
      };
    } catch (e) {
      return {
        order_id: "",
        status: "failed",
        size: params.size,
        price: params.price,
        error: String(e),
      };
    }
  }

  async cancelOrder(order_id: string): Promise<boolean> {
    try {
      const resp = await fetch(`${this.pythonApiUrl}/api/strategy/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id }),
      });
      const data = (await resp.json()) as { success: boolean };
      return data.success;
    } catch (e) {
      console.error("[RealStrategyAPI] cancelOrder failed:", e);
      return false;
    }
  }

  async cancelAllOrders(): Promise<{ success: boolean }> {
    try {
      const resp = await fetch(`${this.pythonApiUrl}/api/strategy/cancel-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      return (await resp.json()) as { success: boolean };
    } catch (e) {
      console.error("[RealStrategyAPI] cancelAllOrders failed:", e);
      return { success: false };
    }
  }

  async getOrderStatus(order_id: string): Promise<OrderStatusResult> {
    try {
      const resp = await fetch(
        `${this.pythonApiUrl}/api/strategy/order-status/${encodeURIComponent(order_id)}`
      );
      const data = (await resp.json()) as OrderStatusResult & { error?: string };
      if (data.error) {
        console.error(`[RealStrategyAPI] getOrderStatus error for ${order_id}: ${data.error}`);
        return { order_id, status: "ERROR", size_matched: 0, original_size: 0, price: 0 };
      }
      return {
        order_id: data.order_id ?? order_id,
        status: data.status ?? "UNKNOWN",
        size_matched: data.size_matched ?? 0,
        original_size: data.original_size ?? 0,
        price: data.price ?? 0,
      };
    } catch (e) {
      console.error(`[RealStrategyAPI] getOrderStatus exception for ${order_id}:`, e);
      return { order_id, status: "ERROR", size_matched: 0, original_size: 0, price: 0 };
    }
  }

  async getBook(token_id: string): Promise<OrderBook> {
    try {
      const resp = await fetch(
        `${this.pythonApiUrl}/api/strategy/book/${token_id}`
      );
      const data = (await resp.json()) as OrderBook;
      return data;
    } catch {
      return { bids: [], asks: [] };
    }
  }

  async getBalance(): Promise<number> {
    try {
      const resp = await fetch(`${this.pythonApiUrl}/api/strategy/balance`);
      const data = (await resp.json()) as { balance: number };
      return data.balance ?? -1; // -1 signals "could not fetch" — caller must handle
    } catch (e) {
      console.error("[RealStrategyAPI] getBalance failed:", e);
      return -1; // -1 = unknown, NOT 0 (which would halt all orders)
    }
  }

  async getOpenOrders(): Promise<OrderState[]> {
    try {
      const resp = await fetch(`${this.pythonApiUrl}/api/strategy/orders`);
      const data = (await resp.json()) as { orders: OrderState[] };
      return data.orders || [];
    } catch {
      return [];
    }
  }

  async getActivity(limit = 50): Promise<ActivityTrade[]> {
    try {
      const resp = await fetch(
        `${this.pythonApiUrl}/api/strategy/activity?limit=${limit}`
      );
      const data = (await resp.json()) as { trades: ActivityTrade[] };
      return data.trades || [];
    } catch {
      return [];
    }
  }

  async redeemConditions(conditionIds: string[]): Promise<{ redeemed: number; error?: string }> {
    try {
      const resp = await fetch(`${this.pythonApiUrl}/api/redeem/conditions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ condition_ids: conditionIds }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const error = `redeem API returned ${resp.status}: ${text.slice(0, 200)}`;
        console.error(`[REDEEM] ${error}`);
        return { redeemed: 0, error };
      }
      const data = (await resp.json()) as { redeemed: number };
      return { redeemed: data.redeemed || 0 };
    } catch (e) {
      const error = `redeem API call failed: ${e}`;
      console.error(`[REDEEM] ${error}`);
      return { redeemed: 0, error };
    }
  }

  async mergePositions(conditionId: string, amount: number): Promise<{
    status: "merged" | "failed"; tx_hash?: string; duration_ms?: number; error?: string;
  }> {
    try {
      const resp = await fetch(`${this.pythonApiUrl}/api/merge/positions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ condition_id: conditionId, amount }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { status: "failed", error: `merge API returned ${resp.status}: ${text.slice(0, 200)}` };
      }
      const data = (await resp.json()) as {
        status: string; tx_hash?: string; gas_used?: number; duration_ms?: number; error?: string;
      };
      return {
        status: data.status === "merged" ? "merged" : "failed",
        tx_hash: data.tx_hash,
        duration_ms: data.duration_ms,
        error: data.error,
      };
    } catch (e) {
      return { status: "failed", error: `merge API call failed: ${e}` };
    }
  }
}

// ── Strategy Registry ───────────────────────────────────────────────

const strategyRegistry: Record<string, () => Strategy> = {};

export function registerStrategy(type: string, factory: () => Strategy) {
  strategyRegistry[type] = factory;
}

export function getStrategy(type: string): Strategy | null {
  const factory = strategyRegistry[type];
  return factory ? factory() : null;
}

export function getRegisteredTypes(): string[] {
  return Object.keys(strategyRegistry);
}

// ── State helpers ───────────────────────────────────────────────────

export function emptyState(): StrategyState {
  return {
    open_orders: [],
    positions: [],
    total_pnl: 0,
    capital_deployed: 0,
    last_tick_at: "",
    started_at: "",
    ticks: 0,
    errors: 0,
    cumulative_runtime_ms: 0,
    custom: {},
    logs: [],
    high_water_balance: 0,
    windingDown: false,
    wallet_balance_at_start: null,
  };
}

// ── Balance protection ──────────────────────────────────────────────

export interface BalanceProtection {
  currentBalance: number;
  lockedAmount: number;
  workingCapital: number;
  highWaterBalance: number;
  effectiveMaxCapital: number;
  drawdownScale: number;
  exhausted: boolean;
}

export function computeBalanceProtection(
  config: StrategyConfig,
  state: StrategyState,
): BalanceProtection | null {
  if (config.balance_usd == null) return null;

  const currentBalance = config.balance_usd + state.total_pnl;
  const hwb = state.high_water_balance || 0;

  const params = config.params as Record<string, unknown>;
  const reinvestPct = (params?.profit_reinvest_pct as number) ?? 0;
  const capitalCap = (params?.max_capital_cap_usd as number) || Infinity;
  const hwmProfit = Math.max(0, hwb - config.balance_usd);

  const lockedAmount = Math.min(hwmProfit * (1 - reinvestPct), Math.max(0, currentBalance));
  const workingCapital = Math.max(0, currentBalance - lockedAmount);

  const growthMax = Math.min(
    config.max_capital_usd + hwmProfit * reinvestPct,
    capitalCap,
  );
  let effectiveMaxCapital = Math.min(growthMax, workingCapital);

  let drawdownScale = 1.0;
  const maxDrawdownPct = params?.max_drawdown_pct as number | undefined;
  if (maxDrawdownPct && maxDrawdownPct > 0 && currentBalance < hwb) {
    const threshold = hwb * (1 - maxDrawdownPct);
    const ratio = Math.max(0, (currentBalance - threshold) / (hwb - threshold));
    drawdownScale = 0.25 + 0.75 * Math.min(1.0, Math.max(0, ratio));
    effectiveMaxCapital *= drawdownScale;
  }

  return {
    currentBalance,
    lockedAmount,
    workingCapital,
    highWaterBalance: hwb,
    effectiveMaxCapital,
    drawdownScale,
    exhausted: workingCapital <= 0,
  };
}

/**
 * Build a StrategyContext with balance protection applied.
 * Used by both StrategyDO and standalone runner.
 */
export function buildProtectedConfig(
  config: StrategyConfig,
  state: StrategyState,
): { config: StrategyConfig; protection: BalanceProtection | null } {
  const protection = computeBalanceProtection(config, state);
  if (!protection) return { config, protection: null };

  return {
    config: { ...config, max_capital_usd: protection.effectiveMaxCapital },
    protection,
  };
}
