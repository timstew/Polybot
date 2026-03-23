/**
 * Abstract strategy execution framework.
 *
 * StrategyDO is a Durable Object that runs trading strategies on a configurable
 * tick interval.  Each strategy implements the Strategy interface (init/tick/stop).
 * The StrategyAPI abstraction handles paper vs real mode transparently — paper
 * mode simulates fills from live orderbook data; real mode places actual CLOB orders
 * via the Cloud Run backend.
 */

// ── Interfaces ───────────────────────────────────────────────────────

export interface StrategyConfig {
  id: string;
  name: string;
  strategy_type: string; // registry key, e.g. "split-arb", "passive-mm"
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
  originalSize: number; // requested size at placement (size may be 0 for resting orders)
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
  status: string; // "MATCHED" | "LIVE" | "CANCELLED" | "ERROR" | "UNKNOWN"
  size_matched: number;
  original_size: number;
  price: number;
}

export interface ActivityTrade {
  id: string;
  asset: string;       // token_id
  side: "BUY" | "SELL";
  price: number;       // actual execution price
  size: number;
  timestamp: string;
  type: string;        // "TRADE", "CONVERSION", etc.
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

/**
 * Cancel an order safely, mode-agnostic. Both PaperStrategyAPI and
 * RealStrategyAPI now handle fill-before-cancel internally.
 * If cancel fails (already matched, network error), checks order status.
 * Returns cleared=false if the order is still live — caller should retry.
 */
export async function safeCancelOrder(
  api: StrategyAPI,
  orderId: string,
): Promise<SafeCancelResult> {
  const cancelled = await api.cancelOrder(orderId);
  if (cancelled) return { cleared: true };

  // Cancel failed — check if already filled or cancelled
  try {
    const status = await api.getOrderStatus(orderId);
    if (status.status === "MATCHED") {
      return {
        cleared: true,
        fill: { size: status.size_matched, price: status.price },
      };
    }
    if (status.status === "CANCELLED") return { cleared: true };
    // Still LIVE — don't clear, retry next tick
    return { cleared: false };
  } catch {
    return { cleared: false };
  }
}

// ── Paper API (simulates fills from live book data) ─────────────────

let paperOrderCounter = 0;

export interface PaperFillConfig {
  takerFillRate: number;   // fraction of book depth available to us (default 0.65)
  slippageBps: number;     // additional slippage in basis points (default 30)
  makerFillProb: number;   // probability a resting maker bid gets filled when price touches (default 0.4)
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

  /**
   * Simulate a paper fill for a resting bid using real CLOB book + trade tape.
   * Shared by getOrderStatus() and cancelOrder() so strategies never branch on mode.
   */
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

    // Bid crosses the spread — immediate fill at best ask (taker)
    if (bestAsk !== null && bidPrice >= bestAsk) {
      return { filled: true, fillPrice: bestAsk };
    }

    if (this.grounded) {
      // Grounded mode: only fill if enough real volume traded through our level
      const { fetchTradeTape, checkTapeFill } = await import("./strategies/price-feed");
      const tape = await fetchTradeTape();

      // Queue depth: sum of all REAL resting bids at or above our price
      // These orders have queue priority (higher price = first; same price = FIFO, we're last)
      const queueAhead = book.bids
        .filter(b => b.price >= bidPrice)
        .reduce((sum, b) => sum + b.size, 0);

      return checkTapeFill(tape, tokenId, bidPrice, bidSize, placedAtMs, queueAhead);
    }

    // Legacy probabilistic model
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

    // Check live orderbook to see if this would fill immediately.
    // Walk the book to compute realistic VWAP and partial fills.
    const book = await this.getBook(params.token_id);
    const levels = params.side === "BUY" ? book.asks : book.bids;

    // Quick check: if order doesn't cross the spread, it's a resting limit order
    const bestOpposite = levels.length > 0 ? levels[0].price : null;
    const crossesSpread = bestOpposite !== null && (
      params.side === "BUY" ? params.price >= bestOpposite :
      params.price <= bestOpposite
    );

    // Walk book levels to compute fill — VWAP across levels, partial if not enough depth
    // Apply fill rate: we can only access a fraction of displayed depth
    // (the rest is stale, gets pulled, or other takers beat us)
    let remaining = params.size;
    let totalCost = 0; // sum of (price × size) for filled portion
    let filledSize = 0;

    if (crossesSpread) {
      for (const level of levels) {
        const priceOk =
          params.side === "BUY"
            ? level.price <= params.price
            : level.price >= params.price;
        if (!priceOk) continue;

        // Only a fraction of displayed size is realistically available
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

    // FAK/FOK: immediate execution only, no resting orders
    if (orderType === "FAK") {
      // FAK: fill what's available, cancel the rest
      const actualFilled = filledSize; // whatever crossed, even if partial
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
      // FOK: fill entirely or cancel entirely
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

    // GTC: existing behavior — fill what crosses, rest goes on book
    const wouldFill = filledSize >= params.size;
    // Partial fill: filled at least 20% of requested size
    const partialFill = !wouldFill && filledSize >= params.size * 0.2;
    const actualFilled = wouldFill ? params.size : (partialFill ? filledSize : 0);
    let vwap = actualFilled > 0 ? totalCost / actualFilled : params.price;

    // Apply slippage: shift VWAP unfavorably
    if (actualFilled > 0 && this.fillConfig.slippageBps > 0) {
      const slippageMult = this.fillConfig.slippageBps / 10000;
      if (params.side === "BUY") {
        vwap = Math.min(1.0, vwap * (1 + slippageMult)); // pay more
      } else {
        vwap = Math.max(0.01, vwap * (1 - slippageMult)); // receive less
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

    // Trim old filled/cancelled orders to avoid unbounded growth
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

  async cancelOrder(order_id: string): Promise<boolean> {
    const order = this.orders.find((o) => o.id === order_id);
    if (!order || order.status !== "open") return false;

    // Check for fill before cancelling — mirrors real CLOB behavior where
    // a cancel request can fail because the order was already matched.
    const book = await this.getBook(order.token_id);
    const placedMs = new Date(order.placed_at).getTime();
    const result = await this.simulatePaperFill(
      order.price, order.originalSize, book, order.token_id, placedMs,
    );
    if (result.filled) {
      order.status = "filled";
      order.price = result.fillPrice;
      order.filled = order.originalSize;
      return false; // Can't cancel — was filled
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

    // Already terminal — return stored state
    if (order.status !== "open") {
      return {
        order_id,
        status: order.status === "filled" ? "MATCHED" : "CANCELLED",
        size_matched: order.status === "filled" ? order.filled : 0,
        original_size: order.originalSize,
        price: order.price,
      };
    }

    // Open order: check book + tape for fill
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
    return []; // Paper mode has no real activity
  }

  async redeemConditions(_conditionIds: string[]): Promise<{ redeemed: number }> {
    return { redeemed: 0 }; // Paper mode — nothing to redeem
  }

  async mergePositions(_conditionId: string, _amount: number): Promise<{
    status: "merged" | "failed"; tx_hash?: string; duration_ms?: number; error?: string;
  }> {
    return { status: "merged", duration_ms: 0 }; // Paper mode — instant accounting
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
    } catch {
      return false;
    }
  }

  async getOrderStatus(order_id: string): Promise<OrderStatusResult> {
    try {
      const resp = await fetch(
        `${this.pythonApiUrl}/api/strategy/order-status/${encodeURIComponent(order_id)}`
      );
      const data = (await resp.json()) as OrderStatusResult;
      return {
        order_id: data.order_id || order_id,
        status: data.status || "UNKNOWN",
        size_matched: data.size_matched || 0,
        original_size: data.original_size || 0,
        price: data.price || 0,
      };
    } catch {
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
      return data.balance;
    } catch {
      return 0;
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

/**
 * Ensure strategy implementations are registered.
 * Side-effect imports in index.ts should have already populated the registry,
 * but after DO eviction/re-creation those may not have run yet.
 * We explicitly import them here as a safety net.
 */
async function ensureRegistered(): Promise<void> {
  // Dynamic imports to trigger side-effect registration.
  // Always run all imports — the early-return check was too coarse
  // (existing registrations blocked new strategy imports).
  await import("./strategies/split-arb");
  await import("./strategies/passive-mm");
  await import("./strategies/directional-taker");
  await import("./strategies/directional-maker");
  await import("./strategies/spread-sniper");
  await import("./strategies/unified-adaptive");
  await import("./strategies/safe-maker");
  await import("./strategies/conviction-maker");
  await import("./strategies/certainty-taker");
  await import("./strategies/avellaneda-maker");
  await import("./strategies/enhanced-maker");
  await import("./strategies/orchestrator");
  await import("./strategies/scaling-safe-maker");
}

export function getStrategy(type: string): Strategy | null {
  const factory = strategyRegistry[type];
  return factory ? factory() : null;
}

// ── StrategyDO (Durable Object) ─────────────────────────────────────

export interface StrategyEnv {
  DB: D1Database;
  PYTHON_API_URL: string;
  STRATEGY: DurableObjectNamespace;
}

const MAX_LOG_ENTRIES = 100;

function emptyState(): StrategyState {
  return {
    open_orders: [],
    positions: [],
    total_pnl: 0,
    capital_deployed: 0,
    last_tick_at: "",
    started_at: "",
    ticks: 0,
    errors: 0,
    custom: {},
    logs: [],
    high_water_balance: 0,
    windingDown: false,
    wallet_balance_at_start: null,
  };
}

export class StrategyDO implements DurableObject {
  private doState: DurableObjectState;
  private env: StrategyEnv;
  private strategy: Strategy | null = null;
  private api: StrategyAPI | null = null;
  private currentConfig: StrategyConfig | null = null;
  private state: StrategyState = emptyState();
  private logBuffer: Array<{ msg: string; data?: StructuredLogData; ts: string }> = [];

  constructor(state: DurableObjectState, env: StrategyEnv) {
    this.doState = state;
    this.env = env;
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.handleFetch(request);
    } catch (e) {
      const msg = e instanceof Error ? e.stack || e.message : String(e);
      console.error(`[DO CRASH] ${this.currentConfig?.name || "unknown"}:`, msg);
      this.addLog(`CRASH: ${msg}`, { level: "error" });
      // Best-effort flush crash log to D1
      try { await this.flushLogsToD1(); } catch { /* ignore */ }
      return this.json({ error: msg }, 500);
    }
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      const configId = url.searchParams.get("config_id") || "";
      return this.start(configId);
    }

    if (url.pathname === "/stop") {
      return this.stopStrategy();
    }

    if (url.pathname === "/wind-down") {
      const activeWindows = ((this.state.custom as Record<string, unknown>)?.activeWindows as unknown[] | undefined) ?? [];
      if (activeWindows.length === 0) {
        // No windows to wind down — just stop immediately
        await this.stopStrategy();
        return this.json({ status: "stopped" });
      }
      this.state.windingDown = true;
      this.addLog("WIND DOWN: stopping new entries, completing existing windows");
      await this.persistState();
      return this.json({ status: "winding_down" });
    }

    if (url.pathname === "/reload-config") {
      // Re-read config from D1 without resetting state
      const cfgId = this.currentConfig?.id || await this.doState.storage.get<string>("configId");
      if (cfgId) {
        try {
          const row = await this.env.DB.prepare(
            "SELECT * FROM strategy_configs WHERE id = ?"
          ).bind(cfgId).first<Record<string, unknown>>();
          if (row) this.currentConfig = this.rowToConfig(row);
        } catch { /* ignore */ }
      }
      return this.json({ status: "reloaded" });
    }

    if (url.pathname === "/reset-state") {
      // Reset all stats while keeping config — useful before switching to real mode
      if (this.currentConfig?.active) {
        return this.json({ error: "Cannot reset while running — stop first" }, 400);
      }
      this.state = emptyState();
      await this.persistState();
      // Also clear trades/logs from D1 for this strategy
      const cfgId = this.currentConfig?.id || await this.doState.storage.get<string>("configId");
      if (cfgId) {
        await this.env.DB.batch([
          this.env.DB.prepare("DELETE FROM strategy_trades WHERE strategy_id = ?").bind(cfgId),
          this.env.DB.prepare("DELETE FROM strategy_orders WHERE strategy_id = ?").bind(cfgId),
          this.env.DB.prepare("DELETE FROM strategy_logs WHERE strategy_id = ?").bind(cfgId),
        ]);
        // Re-read config from D1 to pick up any changes (mode, balance, etc.)
        try {
          const row = await this.env.DB.prepare(
            "SELECT * FROM strategy_configs WHERE id = ?"
          ).bind(cfgId).first<Record<string, unknown>>();
          if (row) this.currentConfig = this.rowToConfig(row);
        } catch { /* ignore */ }
      }
      return this.json({ status: "reset" });
    }

    if (url.pathname === "/merge" && request.method === "POST") {
      return this.handleMerge(request);
    }

    if (url.pathname === "/status") {
      // Re-hydrate state from storage if DO was evicted
      if (!this.currentConfig) {
        const stored = await this.doState.storage.get<StrategyState>("state");
        if (stored) {
          this.state = stored;
          if (!this.state.logs) this.state.logs = [];
        }
        // Also try to load the config ID so we can show it
        const storedConfigId = await this.doState.storage.get<string>("configId");
        if (storedConfigId) {
          try {
            const row = await this.env.DB.prepare(
              "SELECT * FROM strategy_configs WHERE id = ?"
            )
              .bind(storedConfigId)
              .first<Record<string, unknown>>();
            if (row) {
              this.currentConfig = this.rowToConfig(row);
            }
          } catch {
            // DB not available yet
          }
        }
      }
      const running = !!this.currentConfig?.active;

      // Self-heal: if strategy should be running (or winding down with windows) but
      // alarm loop died (e.g. after OOM crash / laptop sleep), re-arm the alarm.
      const hasActiveWindows = ((this.state.custom as Record<string, unknown>)?.activeWindows as unknown[] | undefined)?.length ?? 0;
      const needsAlarm = running || (this.state.windingDown && hasActiveWindows > 0);
      if (needsAlarm && this.state.last_tick_at) {
        const staleSec = (Date.now() - new Date(this.state.last_tick_at).getTime()) / 1000;
        if (staleSec > 30) {
          const existingAlarm = await this.doState.storage.getAlarm();
          console.log(`[SELF-HEAL] ${this.currentConfig?.name} stale=${staleSec.toFixed(0)}s existingAlarm=${existingAlarm} windingDown=${this.state.windingDown}`);
          // Force re-arm even if alarm exists — it might be stuck
          await this.doState.storage.setAlarm(Date.now() + 100);
          this.addLog(`Self-heal: alarm re-armed after ${staleSec.toFixed(0)}s stale (had alarm=${!!existingAlarm})`);
        }
      }

      // Compute balance protection info if enabled
      let balanceProtection: {
        current_balance: number;
        locked_amount: number;
        working_capital: number;
        high_water_balance: number;
        effective_max_capital: number;
        drawdown_scale: number;
        capital_status: "ok" | "low" | "exhausted";
        wallet_floor: number | null;
        wallet_balance_at_start: number | null;
      } | null = null;
      if (this.currentConfig?.balance_usd != null) {
        const currentBalance = this.currentConfig.balance_usd + this.state.total_pnl;
        const hwb = this.state.high_water_balance || 0;

        const statusParams = this.currentConfig.params as Record<string, unknown>;
        const reinvestPct = (statusParams?.profit_reinvest_pct as number) ?? 0;
        const capitalCap = (statusParams?.max_capital_cap_usd as number) || Infinity;
        const hwmProfit = Math.max(0, hwb - this.currentConfig.balance_usd);

        // Lock (1 - reinvestPct) of peak profits above initial balance
        const lockedAmount = Math.min(hwmProfit * (1 - reinvestPct), Math.max(0, currentBalance));

        // Effective deployment cap: base max + reinvested profit share
        const effectiveMaxCapital = Math.min(
          this.currentConfig.max_capital_usd + hwmProfit * reinvestPct,
          capitalCap,
        );

        // Compute drawdown scale
        let drawdownScale = 1.0;
        const maxDrawdownPct = (this.currentConfig.params as Record<string, unknown>)?.max_drawdown_pct as number | undefined;
        if (maxDrawdownPct && maxDrawdownPct > 0 && currentBalance < hwb) {
          const threshold = hwb * (1 - maxDrawdownPct);
          const ratio = Math.max(0, (currentBalance - threshold) / (hwb - threshold));
          drawdownScale = 0.25 + 0.75 * Math.min(1.0, Math.max(0, ratio));
        }

        const walletFloor = this.state.wallet_balance_at_start != null && this.currentConfig.balance_usd != null
          ? this.state.wallet_balance_at_start - this.currentConfig.balance_usd
          : null;

        const workingCap = currentBalance - lockedAmount;
        const capitalStatus: "ok" | "low" | "exhausted" =
          workingCap <= 0 ? "exhausted" :
          workingCap < this.currentConfig.max_capital_usd * 0.25 ? "low" : "ok";

        balanceProtection = {
          current_balance: currentBalance,
          locked_amount: lockedAmount,
          working_capital: workingCap,
          high_water_balance: hwb,
          effective_max_capital: effectiveMaxCapital,
          drawdown_scale: drawdownScale,
          capital_status: capitalStatus,
          wallet_floor: walletFloor,
          wallet_balance_at_start: this.state.wallet_balance_at_start,
        };
      }

      const activeWindowCount = ((this.state.custom as Record<string, unknown>)?.activeWindows as unknown[] | undefined)?.length ?? 0;

      // Clean up stale state when not running
      if (!running) {
        let dirty = false;
        if (this.state.windingDown && activeWindowCount === 0) {
          this.state.windingDown = false;
          dirty = true;
        }
        const custom = this.state.custom as Record<string, unknown> | undefined;
        if (custom?.scanStatus) {
          custom.scanStatus = "";
          dirty = true;
        }
        if (dirty) {
          await this.doState.storage.put("state", this.state);
        }
      }

      // Recover stats from D1 if DO state P&L was lost (OOM, eviction, partial state loss)
      if (this.state.total_pnl === 0 && this.currentConfig) {
        try {
          const row = await this.env.DB.prepare(
            "SELECT COALESCE(SUM(pnl), 0) as total_pnl, COUNT(*) as trade_count FROM strategy_trades WHERE strategy_id = ?"
          ).bind(this.currentConfig.id).first<{ total_pnl: number; trade_count: number }>();
          if (row && row.trade_count > 0) {
            this.state.total_pnl = row.total_pnl;
            await this.doState.storage.put("state", this.state);
          }
        } catch {
          // D1 not available
        }
      }

      // Strip logs from status response — they're already in D1, and including
      // 500 logs per strategy in every 5s poll causes wrangler dev OOM (~8MB/min
      // through the inspector proxy). Return last 5 for quick debugging only.
      const { logs: _allLogs, ...stateWithoutLogs } = this.state;
      const recentLogs = (this.state.logs ?? []).slice(-5);

      // Strip tickSnapshots from active windows in response — they're large
      // (trade tape data) and only needed internally for D1 flush on resolve
      const responseState = { ...stateWithoutLogs, logs: recentLogs };
      const custom = responseState.custom as Record<string, unknown> | undefined;
      if (custom?.activeWindows) {
        custom.activeWindows = (custom.activeWindows as Array<Record<string, unknown>>).map(
          (w) => {
            const { tickSnapshots: _, ...rest } = w;
            return { ...rest, snapshotCount: Array.isArray(_) ? _.length : 0 };
          }
        );
      }

      return this.json({
        running,
        winding_down: this.state.windingDown,
        active_windows: activeWindowCount,
        config: this.currentConfig,
        state: responseState,
        balance_protection: balanceProtection,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  private rowToConfig(row: Record<string, unknown>): StrategyConfig {
    return {
      id: row.id as string,
      name: row.name as string,
      strategy_type: row.strategy_type as string,
      mode: row.mode as "paper" | "real",
      active: !!(row.active as number),
      params: JSON.parse((row.params as string) || "{}"),
      tick_interval_ms: (row.tick_interval_ms as number) || 3000,
      max_capital_usd: (row.max_capital_usd as number) || 200,
      balance_usd: row.balance_usd != null ? (row.balance_usd as number) : null,
      lock_increment_usd: row.lock_increment_usd != null ? (row.lock_increment_usd as number) : null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  /**
   * Core hydration: load config from D1, create strategy + API, restore state.
   * Used by both start() and alarm re-hydration (including wind-down recovery).
   * Returns null on success, or an error Response on failure.
   */
  private async hydrate(configId: string): Promise<Response | null> {
    await ensureRegistered();

    const row = await this.env.DB.prepare(
      "SELECT * FROM strategy_configs WHERE id = ?"
    )
      .bind(configId)
      .first<Record<string, unknown>>();

    if (!row) {
      return this.json({ error: "Config not found" }, 404);
    }

    const config = this.rowToConfig(row);

    const strategy = getStrategy(config.strategy_type);
    if (!strategy) {
      const available = Object.keys(strategyRegistry).join(", ") || "(none)";
      return this.json(
        { error: `Unknown strategy type: ${config.strategy_type}. Available: ${available}` },
        400
      );
    }

    const grounded = (config.params as Record<string, unknown>)?.grounded_fills !== false;
    const api =
      config.mode === "paper"
        ? new PaperStrategyAPI(this.env.PYTHON_API_URL, undefined, grounded)
        : new RealStrategyAPI(this.env.PYTHON_API_URL);

    this.currentConfig = config;
    this.strategy = strategy;
    this.api = api;
    this.state = (await this.doState.storage.get<StrategyState>("state")) || emptyState();
    if (!this.state.logs) this.state.logs = [];

    // Recover stats from D1 if DO storage was lost (OOM crash, eviction).
    // D1 trades survive — recompute total_pnl and ticks from them.
    if (this.state.ticks === 0 && this.state.total_pnl === 0) {
      try {
        const row = await this.env.DB.prepare(
          "SELECT COALESCE(SUM(pnl), 0) as total_pnl, COUNT(*) as trade_count FROM strategy_trades WHERE strategy_id = ?"
        ).bind(config.id).first<{ total_pnl: number; trade_count: number }>();
        if (row && row.trade_count > 0) {
          this.state.total_pnl = row.total_pnl;
          this.addLog(`Recovered stats from D1: ${row.trade_count} trades, P&L=$${row.total_pnl.toFixed(2)}`);
        }
      } catch {
        // D1 not available — will get stats on next persist
      }
    }

    return null; // success
  }

  private async start(configId: string): Promise<Response> {
    const err = await this.hydrate(configId);
    if (err) return err;

    this.currentConfig!.active = true;
    this.state.windingDown = false;
    this.state.started_at = new Date().toISOString();

    // Ensure HWM is at least current balance on start (never lower it — locked funds are permanent)
    if (this.currentConfig!.balance_usd != null) {
      const currentBalance = this.currentConfig!.balance_usd + this.state.total_pnl;
      this.state.high_water_balance = Math.max(this.state.high_water_balance || 0, currentBalance);
    }

    // In real mode with balance_usd, record actual wallet balance so we can
    // enforce a hard floor: the strategy must never draw the wallet below
    // wallet_balance_at_start - balance_usd (protecting the unallocated funds).
    if (this.currentConfig!.mode === "real" && this.currentConfig!.balance_usd != null) {
      try {
        const walletBalance = await this.api!.getBalance();
        if (walletBalance > 0) {
          this.state.wallet_balance_at_start = walletBalance;
          this.addLog(`Wallet floor: $${walletBalance.toFixed(2)} total, $${this.currentConfig!.balance_usd.toFixed(2)} allocated → $${(walletBalance - this.currentConfig!.balance_usd).toFixed(2)} protected`);
        }
      } catch (e) {
        this.addLog(`Could not fetch wallet balance: ${e instanceof Error ? e.message : String(e)}`, { level: "warning" });
      }
    }

    // Mark active in D1
    await this.env.DB.prepare(
      "UPDATE strategy_configs SET active = 1, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(this.currentConfig!.id)
      .run();

    await this.doState.storage.put("configId", this.currentConfig!.id);
    await this.doState.storage.put("userStopped", false);

    this.addLog(`Started: ${this.currentConfig!.name} (${this.currentConfig!.strategy_type}, ${this.currentConfig!.mode} mode)`);
    const ctx = this.buildContext();
    try {
      await this.strategy!.init(ctx);
    } catch (e) {
      this.addLog(`Init error: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.persistState();

    // Start alarm
    await this.doState.storage.setAlarm(
      Date.now() + this.currentConfig!.tick_interval_ms
    );

    return this.json({ status: "started", config: this.currentConfig });
  }

  private async stopStrategy(): Promise<Response> {
    if (this.strategy && this.currentConfig) {
      this.addLog(`Stopped: ${this.currentConfig.name}`);
      const ctx = this.buildContext();
      try {
        await this.strategy.stop(ctx);
      } catch (e) {
        console.error("Strategy stop error:", e);
      }
    }

    // Flush any pending logs to D1 before clearing — they survive DO eviction
    try {
      await this.flushLogsToD1();
    } catch {
      // Non-critical
    }

    // Clear wind-down and scan status
    this.state.windingDown = false;
    const custom = this.state.custom as Record<string, unknown> | undefined;
    if (custom?.scanStatus) custom.scanStatus = "";

    // Always mark inactive in D1 — even if DO was evicted and currentConfig is null
    const storedConfigId =
      this.currentConfig?.id ||
      (await this.doState.storage.get<string>("configId"));
    if (storedConfigId) {
      await this.env.DB.prepare(
        "UPDATE strategy_configs SET active = 0, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(storedConfigId)
        .run();
    }

    await this.persistState();
    this.currentConfig = null;
    this.strategy = null;
    this.api = null;
    await this.doState.storage.deleteAlarm();
    await this.doState.storage.put("userStopped", true);

    return this.json({ status: "stopped" });
  }

  async alarm(): Promise<void> {
    console.log(`[ALARM] fired for ${this.currentConfig?.name || "unknown"} (has strategy=${!!this.strategy})`);
    const userStopped = await this.doState.storage.get<boolean>("userStopped");
    // Check if we're winding down — if so, keep ticking even if userStopped
    // (wind-down needs the alarm loop to resolve remaining windows)
    const storedState = (!this.state.windingDown)
      ? await this.doState.storage.get<StrategyState>("state")
      : null;
    const isWindingDown = this.state.windingDown || storedState?.windingDown;
    if (userStopped && !isWindingDown) {
      console.log("[ALARM] userStopped=true and not winding down, exiting");
      return;
    }

    // Re-hydrate from D1 if DO was evicted and recreated
    if (!this.strategy || !this.currentConfig || !this.api) {
      try {
        const storedConfigId = await this.doState.storage.get<string>("configId");
        if (!storedConfigId) {
          console.log("[ALARM] no stored configId, exiting");
          return;
        }
        console.log(`[ALARM] re-hydrating ${storedConfigId}`);

        const err = await this.hydrate(storedConfigId);
        if (err) {
          console.log(`[ALARM] hydrate failed for ${storedConfigId}`);
          return;
        }

        // If not active and not winding down, nothing to do
        if (!this.currentConfig!.active && !this.state.windingDown) {
          console.log(`[ALARM] config ${storedConfigId} not active and not winding down, exiting`);
          this.currentConfig = null;
          this.strategy = null;
          this.api = null;
          return;
        }

        if (this.state.windingDown) {
          // Wind-down re-hydration: don't call init, don't mark active
          this.addLog("Self-heal: wind-down re-hydrated after eviction");
          console.log(`[ALARM] wind-down re-hydrated ${storedConfigId}`);
          // Fall through to the normal tick loop
        } else {
          // Normal re-hydration: full start (marks active, calls init, sets alarm)
          await this.start(storedConfigId);
          console.log(`[ALARM] re-hydrated ${storedConfigId} successfully`);
          // start() already sets the next alarm, so return
          return;
        }
      } catch (e) {
        console.error("[ALARM] re-hydration failed:", e);
        return;
      }
    }

    // Guard: if we somehow got here without config/strategy, bail
    if (!this.strategy || !this.currentConfig || !this.api) {
      console.error("[ALARM] no strategy/config/api after re-hydration, exiting");
      return;
    }

    // Wrap everything in try/finally to GUARANTEE alarm rescheduling.
    // Any uncaught error between here and setAlarm kills the tick loop permanently.
    let shouldStop = false;
    try {
      const ctx = this.buildContext();

      try {
        await this.strategy.tick(ctx);
        this.state.ticks++;
        this.state.last_tick_at = new Date().toISOString();
      } catch (e) {
        this.state.errors++;
        this.addLog(`Tick error: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Flush structured logs to D1 every 10 ticks
      if (this.state.ticks % 10 === 0 && this.logBuffer.length > 0) {
        try {
          await this.flushLogsToD1();
        } catch (e) {
          this.addLog(`D1 flush error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Wind-down auto-stop: if winding down and no active windows remain, stop
      if (this.state.windingDown) {
        const custom = this.state.custom as Record<string, unknown>;
        const activeWindows = custom?.activeWindows as unknown[] | undefined;
        if (!activeWindows || activeWindows.length === 0) {
          this.addLog("WIND DOWN COMPLETE: all windows resolved, auto-stopping");
          shouldStop = true;
        }
      }

      // Balance protection check
      if (this.currentConfig.balance_usd != null) {
        const currentBalance = this.currentConfig.balance_usd + this.state.total_pnl;
        this.state.high_water_balance = Math.max(this.state.high_water_balance || 0, currentBalance);

        const alarmParams = this.currentConfig.params as Record<string, unknown>;
        const reinvestPct = (alarmParams?.profit_reinvest_pct as number) ?? 0;
        const hwmProfit = Math.max(0, this.state.high_water_balance - this.currentConfig.balance_usd);

        // Lock (1 - reinvestPct) of peak profits above initial balance
        const lockedAmount = Math.min(hwmProfit * (1 - reinvestPct), Math.max(0, currentBalance));
        const workingCapital = currentBalance - lockedAmount;

        if (workingCapital <= 0) {
          this.addLog(
            `BALANCE PROTECTION: working capital exhausted (balance=${currentBalance.toFixed(2)}, locked=${lockedAmount.toFixed(2)}). Auto-stopping.`,
            { level: "warning" }
          );
          shouldStop = true;
        }

        // Log drawdown scaling when active
        const maxDrawdownPct = (this.currentConfig.params as Record<string, unknown>)?.max_drawdown_pct as number | undefined;
        if (maxDrawdownPct && maxDrawdownPct > 0 && currentBalance < this.state.high_water_balance) {
          const threshold = this.state.high_water_balance * (1 - maxDrawdownPct);
          const ratio = Math.max(0, (currentBalance - threshold) / (this.state.high_water_balance - threshold));
          const drawdownScale = 0.25 + 0.75 * Math.min(1.0, Math.max(0, ratio));
          if (drawdownScale < 1.0 && this.state.ticks % 20 === 0) {
            this.addLog(
              `DRAWDOWN: ${(drawdownScale * 100).toFixed(0)}% capital (bal=${currentBalance.toFixed(2)} hwm=${this.state.high_water_balance.toFixed(2)})`,
              { level: "warning" }
            );
          }
        }
      }

      // Wallet floor protection: in real mode, check actual USDC every 5 ticks (~15-25s).
      // If wallet_balance_at_start is set, enforce a hard floor: the strategy must never
      // draw the wallet below (wallet_balance_at_start - balance_usd).
      if (this.currentConfig.mode === "real" && this.state.ticks % 5 === 0 && this.api) {
        try {
          const actual = await this.api.getBalance();
          if (actual <= 0) {
            this.addLog(`Balance check skipped: API returned $${actual.toFixed(2)} (likely unreachable)`, { level: "warning" });
          } else {
            // Hard wallet floor check: protect the unallocated portion
            const floor = this.state.wallet_balance_at_start != null && this.currentConfig.balance_usd != null
              ? this.state.wallet_balance_at_start - this.currentConfig.balance_usd
              : 0;
            if (floor > 0 && actual < floor) {
              this.addLog(
                `WALLET FLOOR BREACHED: wallet=$${actual.toFixed(2)} floor=$${floor.toFixed(2)} (started=$${this.state.wallet_balance_at_start!.toFixed(2)}, allocated=$${this.currentConfig.balance_usd!.toFixed(2)}). Auto-stopping.`,
                { level: "error" }
              );
              shouldStop = true;
            }

            // Divergence check: only alarm when wallet is BELOW expected (losing money unexpectedly)
            // Wallet above expected is normal — other strategies or prior runs may hold funds
            if (!shouldStop) {
              const expected = (this.currentConfig.balance_usd ?? 0) + this.state.total_pnl;
              const shortfall = expected - actual; // positive = wallet is below expected
              const pct = expected > 0 ? shortfall / expected : 0;
              if (shortfall > 0 && pct > 0.5) {
                this.addLog(
                  `BALANCE ALARM: wallet=$${actual.toFixed(2)} expected=$${expected.toFixed(2)} shortfall=${(pct * 100).toFixed(1)}%. Auto-stopping.`,
                  { level: "error" }
                );
                shouldStop = true;
              } else if (shortfall > 10 && this.state.ticks % 30 === 0) {
                this.addLog(
                  `BALANCE WARNING: wallet=$${actual.toFixed(2)} expected=$${expected.toFixed(2)} diff=$${shortfall.toFixed(2)}`,
                  { level: "warning" }
                );
              }
            }
          }
        } catch (e) {
          this.addLog(`Balance check failed: ${e instanceof Error ? e.message : String(e)}`, { level: "warning" });
        }
      }

      // Sweep unredeemed positions every 60 ticks (~5 min) in real mode
      // Fire-and-forget to avoid blocking the alarm chain
      if (this.currentConfig.mode === "real" && this.state.ticks % 60 === 0) {
        const sweepUrl = `${this.env.PYTHON_API_URL}/api/redeem/sweep`;
        fetch(sweepUrl, { method: "POST", headers: { "Content-Type": "application/json" } })
          .then(async (resp) => {
            if (resp.ok) {
              const data = (await resp.json()) as { redeemed: number; scanned: number };
              if (data.redeemed > 0) {
                this.addLog(`REDEEM SWEEP: redeemed ${data.redeemed} orphaned positions`, { level: "info" });
              }
            }
          })
          .catch(() => {}); // Non-critical
      }

      // Clean up old D1 logs every 100 ticks
      if (this.state.ticks % 100 === 0) {
        try {
          await this.env.DB.prepare(
            "DELETE FROM strategy_logs WHERE timestamp < datetime('now', '-24 hours')"
          ).run();
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (e) {
      // Catch-all for anything unexpected (buildContext, balance math, etc.)
      console.error(`[ALARM] unexpected error in ${this.currentConfig?.name}:`, e);
      this.state.errors++;
    }

    // These MUST run regardless of any error above
    try {
      await this.persistState();
    } catch (e) {
      console.error("persistState error:", e);
    }

    if (shouldStop) {
      if (this.state.windingDown) {
        // Already winding down — force-stop now
        await this.stopStrategy();
        return;
      }
      // Enter wind-down mode instead of hard kill — lets in-flight positions resolve
      this.state.windingDown = true;
      this.addLog("AUTO WIND-DOWN: safety trigger activated, completing existing windows");
      await this.persistState();
      // Keep ticking — the wind-down auto-stop check will hard-stop once all windows resolve
    }

    // Schedule next tick — GUARANTEED to run
    console.log(`[ALARM] scheduling next tick for ${this.currentConfig.name} in ${this.currentConfig.tick_interval_ms}ms`);
    await this.doState.storage.setAlarm(
      Date.now() + this.currentConfig.tick_interval_ms
    );
  }

  private addLog(msg: string, data?: StructuredLogData): void {
    const ts = new Date().toISOString();
    this.state.logs.push({ ts, msg, data });
    if (this.state.logs.length > MAX_LOG_ENTRIES) {
      this.state.logs = this.state.logs.slice(-MAX_LOG_ENTRIES);
    }
    // Buffer for D1 flush
    if (data) {
      this.logBuffer.push({ msg, data, ts });
    }
    console.log(`[STRATEGY ${this.currentConfig?.name || "?"}] ${msg}`);
  }

  private buildContext(): StrategyContext {
    let config = this.currentConfig!;

    // Enforce balance protection: cap max_capital_usd at working capital
    if (config.balance_usd != null) {
      const currentBalance = config.balance_usd + this.state.total_pnl;
      const hwb = this.state.high_water_balance || 0;

      // profit_reinvest_pct (0-1): fraction of peak profits that stay available for growth
      // The rest is permanently locked (HWM-based, never unlocks on drawdown)
      // max_capital_cap_usd: hard ceiling so growth doesn't become unbounded
      const params = config.params as Record<string, unknown>;
      const reinvestPct = (params?.profit_reinvest_pct as number) ?? 0;
      const capitalCap = (params?.max_capital_cap_usd as number) || Infinity;
      const hwmProfit = Math.max(0, hwb - config.balance_usd);

      // Lock (1 - reinvestPct) of peak profits above initial balance
      const lockedAmount = Math.min(hwmProfit * (1 - reinvestPct), Math.max(0, currentBalance));
      const workingCapital = Math.max(0, currentBalance - lockedAmount);

      // Effective deployment cap: base max + reinvested profit share, capped
      const growthMax = Math.min(
        config.max_capital_usd + hwmProfit * reinvestPct,
        capitalCap,
      );
      let effectiveMax = Math.min(growthMax, workingCapital);

      // Proportional drawdown: scale capital as balance drops toward threshold
      const maxDrawdownPct = (config.params as Record<string, unknown>)?.max_drawdown_pct as number | undefined;
      if (maxDrawdownPct && maxDrawdownPct > 0 && currentBalance < hwb) {
        const drawdownThreshold = hwb * (1 - maxDrawdownPct);
        const ratio = Math.max(0, (currentBalance - drawdownThreshold) / (hwb - drawdownThreshold));
        const scale = 0.25 + 0.75 * Math.min(1.0, Math.max(0, ratio)); // floor at 25%
        effectiveMax = effectiveMax * scale;
      }

      const originalMax = config.max_capital_usd;
      config = { ...config, max_capital_usd: effectiveMax };

      // Log warning every ~5 min when effective capital < 50% of configured max
      if (effectiveMax < originalMax * 0.5 && this.state.ticks % 60 === 0) {
        this.addLog(
          `LOW CAPITAL: $${effectiveMax.toFixed(2)} effective (${(effectiveMax / originalMax * 100).toFixed(0)}% of max $${originalMax.toFixed(2)}, working=$${workingCapital.toFixed(2)})`,
          { level: "warning" }
        );
      }

      // Also set paper API balance to working capital
      if (this.api instanceof PaperStrategyAPI) {
        this.api.balanceOverride = workingCapital;
      }
    }

    return {
      config,
      state: this.state,
      api: this.api!,
      db: this.env.DB,
      log: (msg: string, data?: StructuredLogData) => this.addLog(msg, data),
      windingDown: this.state.windingDown,
    };
  }

  private async flushLogsToD1(): Promise<void> {
    if (this.logBuffer.length === 0 || !this.currentConfig) return;
    try {
      const stmts = this.logBuffer.map((entry) => {
        const d = entry.data || {};
        return this.env.DB.prepare(
          `INSERT INTO strategy_logs (strategy_id, tick, phase, level, message, symbol, direction, signal_strength, price_change_pct, momentum, volatility_regime, in_dead_zone, flip_count, up_inventory, down_inventory, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          this.currentConfig!.id,
          this.state.ticks,
          d.phase ?? "",
          d.level ?? "info",
          entry.msg,
          d.symbol ?? null,
          d.direction ?? null,
          d.signalStrength ?? null,
          d.priceChangePct ?? null,
          d.momentum ?? null,
          d.volatilityRegime ?? null,
          d.inDeadZone != null ? (d.inDeadZone ? 1 : 0) : null,
          d.flipCount ?? null,
          d.upInventory ?? null,
          d.downInventory ?? null,
          entry.ts
        );
      });
      await this.env.DB.batch(stmts);
    } catch {
      // D1 flush failure — logs are still in DO memory
    }
    this.logBuffer = [];
  }

  private async handleMerge(request: Request): Promise<Response> {
    if (!this.currentConfig?.active) {
      return this.json({ error: "Strategy not running" }, 400);
    }

    let body: { conditionId?: string; amount?: number };
    try {
      body = (await request.json()) as { conditionId?: string; amount?: number };
    } catch {
      return this.json({ error: "Invalid JSON body" }, 400);
    }
    const { conditionId, amount } = body;
    if (!conditionId || !amount || amount <= 0) {
      return this.json({ error: "Need conditionId and amount > 0" }, 400);
    }

    // Find matching window
    const windows = ((this.state.custom as Record<string, unknown>)?.activeWindows as Array<{
      market: { conditionId: string; upTokenId: string; title: string };
      cryptoSymbol: string;
      upInventory: number; downInventory: number;
      upAvgCost: number; downAvgCost: number;
    }> | undefined) ?? [];
    const w = windows.find(w => w.market.conditionId === conditionId);
    if (!w) {
      return this.json({ error: `No active window for conditionId ${conditionId}` }, 404);
    }

    const matched = Math.min(w.upInventory, w.downInventory);
    const mergeAmount = Math.min(amount, matched);
    if (mergeAmount <= 0) {
      return this.json({ error: "No matched pairs to merge" }, 400);
    }

    const pairCost = w.upAvgCost + w.downAvgCost;
    if (pairCost >= 1.0) {
      return this.json({ error: `Pair cost ${pairCost.toFixed(4)} >= 1.0 — unprofitable` }, 400);
    }

    // Build API for mode
    const api = this.currentConfig.mode === "real"
      ? new RealStrategyAPI(this.env.PYTHON_API_URL)
      : new PaperStrategyAPI(this.env.PYTHON_API_URL);

    const result = await api.mergePositions(conditionId, mergeAmount);
    if (result.status !== "merged") {
      return this.json({ status: "failed", error: result.error }, 500);
    }

    // Accounting
    const pnl = mergeAmount * (1.0 - pairCost);
    w.upInventory = Math.round((w.upInventory - mergeAmount) * 1e6) / 1e6;
    w.downInventory = Math.round((w.downInventory - mergeAmount) * 1e6) / 1e6;
    this.state.total_pnl += pnl;

    // D1 trade record
    try {
      await this.env.DB.prepare(
        `INSERT INTO strategy_trades (id, strategy_id, token_id, side, price, size, fee_amount, pnl, created_at)
         VALUES (?, ?, ?, 'MERGE', ?, ?, 0, ?, datetime('now'))`
      ).bind(
        `mrg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        this.currentConfig.id, w.market.upTokenId, pairCost, mergeAmount, pnl,
      ).run();
    } catch { /* non-critical */ }

    this.addLog(
      `MERGE (manual): ${mergeAmount} pairs @ pc=${pairCost.toFixed(4)} → +$${pnl.toFixed(2)}`,
      { level: "trade" },
    );
    await this.persistState();

    return this.json({
      status: "merged",
      merged: mergeAmount,
      pnl: Math.round(pnl * 100) / 100,
      pairCost: Math.round(pairCost * 10000) / 10000,
      duration_ms: result.duration_ms,
      tx_hash: result.tx_hash,
    });
  }

  private async persistState(): Promise<void> {
    // Strip tickSnapshots before persisting — they're transient (flushed to D1 on resolve)
    // and can exceed DO storage limits (1MB) with full trade tapes
    const custom = this.state.custom as Record<string, unknown> | undefined;
    const activeWindows = custom?.activeWindows as Array<Record<string, unknown>> | undefined;
    if (activeWindows?.some((w) => w.tickSnapshots)) {
      const saved = activeWindows.map((w) => w.tickSnapshots);
      for (const w of activeWindows) delete w.tickSnapshots;
      await this.doState.storage.put("state", this.state);
      for (let i = 0; i < activeWindows.length; i++) {
        if (saved[i]) activeWindows[i].tickSnapshots = saved[i];
      }
    } else {
      await this.doState.storage.put("state", this.state);
    }
  }
}
