/**
 * WindowTactic interface and registry.
 *
 * Any strategy that implements WindowTactic can be orchestrated — the orchestrator
 * discovers tactics at runtime via the registry. Adding a new tactic requires:
 * 1. Implement WindowTactic in a new file
 * 2. Call registerTactic() at module level
 * 3. It appears in the dashboard card pool. Done.
 */

import type { StrategyContext, StrategyAPI, OrderBook } from "../strategy";
import { safeCancelOrder } from "../strategy";
import type { CryptoMarket, PriceSnapshot, WindowSignal } from "./price-feed";
import type { RegimeType } from "./regime";

// ── Shared window state (owned by orchestrator, mutated by tactics) ──

export interface WindowState {
  // Identity
  market: CryptoMarket;
  cryptoSymbol: string;
  windowOpenTime: number;
  windowEndTime: number;
  priceAtWindowOpen: number;

  // Orders (tactic places/cancels via ctx.api, updates these IDs)
  upBidOrderId: string | null;
  downBidOrderId: string | null;
  upBidPrice: number;
  downBidPrice: number;
  upBidSize: number;
  downBidSize: number;

  // Inventory (tactic updates on fill)
  upInventory: number;
  upAvgCost: number;
  downInventory: number;
  downAvgCost: number;

  // Tracking
  fillCount: number;
  sellCount: number;
  realizedSellPnl: number;
  totalBuyCost: number;
  confirmedDirection: "UP" | "DOWN" | null;
  flipCount: number;
  lastDirectionChangeAt: number;
  lastQuotedAt: number;
  tickAction: string;

  // Book-aware pricing: last observed best asks
  lastUpBestAsk: number;
  lastDnBestAsk: number;

  // Real fill tracking: avoid double-counting activity trades
  processedFillIds: string[];

  // Tactic assignment
  tacticId: string;
  ticksInWindow: number;

  // Tactic-specific opaque state
  tacticState: Record<string, unknown>;
}

// ── Context passed to tactic each tick ──

export interface TacticContext {
  ctx: StrategyContext;
  window: WindowState;
  signal: WindowSignal;
  priceHistory: PriceSnapshot[];
  params: Record<string, unknown>;
  allWindows: readonly WindowState[];
}

// ── The interface every tactic implements ──

export interface WindowTactic {
  /** Unique ID — matches the card label in dashboard. e.g. "sniper", "avellaneda" */
  readonly id: string;

  /** Human-readable name for UI. e.g. "Spread Sniper", "Avellaneda MM" */
  readonly displayName: string;

  /** Short description for dashboard tooltip */
  readonly description: string;

  /** Which regimes this tactic is designed for (hint for UI, not enforced) */
  readonly naturalRegimes: RegimeType[];

  /** Default params this tactic uses (shown in UI when configuring) */
  readonly defaultParams: Record<string, unknown>;

  /** Called once when tactic is assigned to a window. Initialize tacticState. */
  onEnter(tc: TacticContext): void;

  /** Core quoting: check fills, update quotes, manage inventory. Every tick. */
  onTick(tc: TacticContext): Promise<void>;

  /** Wind-down: stop new quoting, try to balance inventory. Near window end. */
  onWindDown(tc: TacticContext): Promise<void>;

  /** Exit: dump remaining unmatched inventory. Final seconds. */
  onExit(tc: TacticContext): Promise<void>;

  /** Cancel all orders for this window. Called on tactic switch or force-stop. */
  onCancel(tc: TacticContext): Promise<void>;
}

// ── Tactic Registry ──

const tacticRegistry = new Map<string, () => WindowTactic>();

export function registerTactic(id: string, factory: () => WindowTactic): void {
  tacticRegistry.set(id, factory);
}

export function getTactic(id: string): WindowTactic | null {
  const factory = tacticRegistry.get(id);
  return factory ? factory() : null;
}

export function listTactics(): Array<{
  id: string;
  displayName: string;
  description: string;
  naturalRegimes: RegimeType[];
  defaultParams: Record<string, unknown>;
}> {
  const result: Array<{
    id: string;
    displayName: string;
    description: string;
    naturalRegimes: RegimeType[];
    defaultParams: Record<string, unknown>;
  }> = [];
  for (const [, factory] of tacticRegistry) {
    const tactic = factory();
    result.push({
      id: tactic.id,
      displayName: tactic.displayName,
      description: tactic.description,
      naturalRegimes: tactic.naturalRegimes,
      defaultParams: tactic.defaultParams,
    });
  }
  return result;
}

// ── Helpers shared by all tactics ──

export function emptyWindowState(
  market: CryptoMarket,
  cryptoSymbol: string,
  windowOpenTime: number,
  windowEndTime: number,
  priceAtWindowOpen: number,
  tacticId: string,
): WindowState {
  return {
    market,
    cryptoSymbol,
    windowOpenTime,
    windowEndTime,
    priceAtWindowOpen,
    upBidOrderId: null,
    downBidOrderId: null,
    upBidPrice: 0,
    downBidPrice: 0,
    upBidSize: 0,
    downBidSize: 0,
    upInventory: 0,
    upAvgCost: 0,
    downInventory: 0,
    downAvgCost: 0,
    fillCount: 0,
    sellCount: 0,
    realizedSellPnl: 0,
    totalBuyCost: 0,
    confirmedDirection: null,
    flipCount: 0,
    lastDirectionChangeAt: Date.now(),
    lastQuotedAt: 0,
    tickAction: "entered",
    lastUpBestAsk: 0,
    lastDnBestAsk: 0,
    processedFillIds: [],
    tacticId,
    ticksInWindow: 0,
    tacticState: {},
  };
}

/** Record a fill on a window (shared by sniper + maker tactics). */
export function recordFill(
  w: WindowState,
  side: "UP" | "DOWN",
  size: number,
  price: number,
): void {
  if (side === "UP") {
    if (w.upInventory > 0) {
      const tc = w.upAvgCost * w.upInventory + price * size;
      w.upInventory += size;
      w.upAvgCost = tc / w.upInventory;
    } else {
      w.upInventory = size;
      w.upAvgCost = price;
    }
  } else {
    if (w.downInventory > 0) {
      const tc = w.downAvgCost * w.downInventory + price * size;
      w.downInventory += size;
      w.downAvgCost = tc / w.downInventory;
    } else {
      w.downInventory = size;
      w.downAvgCost = price;
    }
  }
  w.fillCount++;
  w.totalBuyCost += price * size;
}

/** Cancel an order safely and record any fill that happened before cancel. */
export async function safeCancelAndRecord(
  api: StrategyAPI,
  w: WindowState,
  side: "UP" | "DOWN",
): Promise<void> {
  const orderId = side === "UP" ? w.upBidOrderId : w.downBidOrderId;
  if (!orderId) return;
  const r = await safeCancelOrder(api, orderId);
  if (r.cleared) {
    if (r.fill) recordFill(w, side, r.fill.size, r.fill.price);
    if (side === "UP") w.upBidOrderId = null;
    else w.downBidOrderId = null;
  }
}

/** Get best ask from an order book. */
export function getBestAsk(book: OrderBook): number | null {
  if (book.asks.length === 0) return null;
  let best = book.asks[0].price;
  for (const level of book.asks) {
    if (level.price < best) best = level.price;
  }
  return best;
}

/** Get best bid from an order book. */
export function getBestBid(book: OrderBook): number | null {
  if (book.bids.length === 0) return null;
  let best = book.bids[0].price;
  for (const level of book.bids) {
    if (level.price > best) best = level.price;
  }
  return best;
}
