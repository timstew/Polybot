/**
 * Order Placer — safe order placement with ledger-first persistence.
 *
 * The critical rule: write to SQLite BEFORE calling the CLOB API.
 * If the process crashes between write and API call, recovery
 * detects the PENDING order and reconciles it.
 */

import { logActivity } from "../db.js";
import * as ledger from "./order-ledger.js";
import * as fillProcessor from "./fill-processor.js";

import { getConfig } from "../db.js";

const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://127.0.0.1:8000";
const MIN_ORDER_SIZE = 5; // Polymarket minimum

function isPaperMode(): boolean {
  return (getConfig("mode") || "paper") !== "real";
}

export interface PlaceOrderResult {
  localId: string;
  clobOrderId: string;
  status: "filled" | "placed" | "failed";
  fillPrice?: number;
  fillSize?: number;
  error?: string;
}

/**
 * Place a buy order on the CLOB.
 * 1. Write PENDING to SQLite
 * 2. Call Python API
 * 3. Update SQLite with result
 *
 * Returns the result. Fills are automatically processed.
 */
export async function placeBuyOrder(opts: {
  windowSlug: string;
  tokenId: string;
  side: "UP" | "DOWN";
  price: number;
  size: number;
  ladderLevel: number;
  title?: string;
}): Promise<PlaceOrderResult> {
  const { windowSlug, tokenId, side, price, size, ladderLevel } = opts;

  // Validate
  if (size < MIN_ORDER_SIZE) {
    return { localId: "", clobOrderId: "", status: "failed", error: `Size ${size} below minimum ${MIN_ORDER_SIZE}` };
  }
  if (price <= 0 || price >= 1) {
    return { localId: "", clobOrderId: "", status: "failed", error: `Price ${price} out of range` };
  }

  // Check if we already have an active order for this slot
  if (ledger.hasActiveOrder(windowSlug, side, ladderLevel)) {
    return { localId: "", clobOrderId: "", status: "failed", error: "Slot already has active order" };
  }

  // Paper mode: simulate fill if bid would cross the ask
  if (isPaperMode()) {
    const localId = ledger.createPendingOrder({
      tokenId, windowSlug, side,
      price: Math.floor(price * 10000) / 10000,
      size: Math.floor(size * 100) / 100,
      ladderLevel,
    });
    const fakeOrderId = `paper-${localId}`;
    ledger.markSent(localId, fakeOrderId);

    // Check book to see if it would cross
    try {
      const bookResp = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
      const book = await bookResp.json() as { asks?: Array<{ price: string; size: string }> };
      const bestAsk = book.asks?.[0] ? parseFloat(book.asks[0].price) : null;

      if (bestAsk !== null && price >= bestAsk) {
        // Would cross — simulate immediate fill at ask price
        fillProcessor.processImmediateFill(localId, fakeOrderId, windowSlug, tokenId, side, bestAsk, size);
        logActivity("ORDER_FILLED", `${side} L${ladderLevel} ${size.toFixed(1)}@$${bestAsk.toFixed(3)} [paper]`, {
          windowSlug, side, level: "trade",
        });
        return { localId, clobOrderId: fakeOrderId, status: "filled", fillPrice: bestAsk, fillSize: size };
      }
    } catch { /* book unavailable */ }

    // Doesn't cross — resting order (paper mode can't simulate resting fills)
    logActivity("ORDER_PLACED", `${side} L${ladderLevel} ${size.toFixed(1)}@$${price.toFixed(3)} resting [paper]`, {
      windowSlug, side, level: "info",
    });
    return { localId, clobOrderId: fakeOrderId, status: "placed" };
  }

  // 1. Write PENDING to SQLite FIRST (REAL MODE)
  const localId = ledger.createPendingOrder({
    tokenId,
    windowSlug,
    side,
    price: Math.floor(price * 10000) / 10000, // 4 decimal truncate (CLOB precision)
    size: Math.floor(size * 100) / 100, // 2 decimal truncate
    ladderLevel,
  });

  // 2. Call the Python API
  try {
    const resp = await fetch(`${PYTHON_API_URL}/api/strategy/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_id: tokenId,
        side: "BUY",
        size: Math.floor(size * 100) / 100,
        price: Math.floor(price * 10000) / 10000,
        order_type: "GTC",
      }),
    });

    const data = await resp.json() as {
      status: string;
      order_id?: string;
      size?: number;
      price?: number;
      error?: string;
    };

    // 3. Update SQLite with result
    if (data.status === "filled" && data.order_id) {
      // Order filled immediately
      ledger.markSent(localId, data.order_id);
      fillProcessor.processImmediateFill(
        localId,
        data.order_id,
        windowSlug,
        tokenId,
        side,
        data.price || price,
        data.size || size,
      );

      logActivity("ORDER_FILLED", `${side} L${ladderLevel} ${(data.size || size).toFixed(1)}@$${(data.price || price).toFixed(3)} [immediate]`, {
        windowSlug, side, level: "trade",
      });

      return {
        localId,
        clobOrderId: data.order_id,
        status: "filled",
        fillPrice: data.price || price,
        fillSize: data.size || size,
      };
    }

    if ((data.status === "placed" || data.order_id) && data.order_id) {
      // Order is resting on the CLOB — fills will come via User WebSocket
      ledger.markSent(localId, data.order_id);

      logActivity("ORDER_PLACED", `${side} L${ladderLevel} ${size.toFixed(1)}@$${price.toFixed(3)} resting`, {
        windowSlug, side, level: "info",
      });

      return {
        localId,
        clobOrderId: data.order_id,
        status: "placed",
      };
    }

    // Order failed
    const error = data.error || `Unknown status: ${data.status}`;
    ledger.markFailed(localId, error);

    logActivity("ORDER_FAILED", `${side} L${ladderLevel} $${price.toFixed(3)} — ${error.slice(0, 100)}`, {
      windowSlug, side, level: "error",
    });

    return { localId, clobOrderId: "", status: "failed", error };
  } catch (err) {
    // Network/parse error — order may or may not have been placed
    const error = err instanceof Error ? err.message : String(err);
    ledger.markFailed(localId, `Exception: ${error}`);

    logActivity("ORDER_ERROR", `${side} L${ladderLevel} $${price.toFixed(3)} — ${error.slice(0, 100)}`, {
      windowSlug, side, level: "error",
    });

    return { localId, clobOrderId: "", status: "failed", error };
  }
}

/**
 * Cancel an order on the CLOB.
 * Handles cancel-fill races: if cancel fails because order already filled,
 * the User WebSocket will deliver the fill event.
 */
export async function cancelOrder(clobOrderId: string): Promise<boolean> {
  if (isPaperMode()) {
    ledger.markCancelled(clobOrderId);
    return true;
  }
  try {
    const resp = await fetch(`${PYTHON_API_URL}/api/strategy/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: clobOrderId }),
    });

    const data = await resp.json() as { success: boolean; error?: string };

    if (data.success) {
      ledger.markCancelled(clobOrderId);
      logActivity("ORDER_CANCELLED", `Order ${clobOrderId.slice(0, 16)} cancelled`, { level: "info" });
      return true;
    }

    // Cancel failed — might be because the order already filled
    // Don't mark as cancelled — let the WebSocket or reconciler handle it
    console.warn(`[CANCEL] Failed for ${clobOrderId.slice(0, 16)}: ${data.error || "unknown"}`);
    return false;
  } catch (err) {
    console.error(`[CANCEL] Error for ${clobOrderId.slice(0, 16)}:`, err);
    return false;
  }
}

/**
 * Cancel all orders on the CLOB.
 * Used on stop and startup for cleanup.
 */
export async function cancelAllOrders(): Promise<boolean> {
  if (isPaperMode()) {
    const openOrders = ledger.getOpenOrders();
    for (const order of openOrders) {
      if (order.clob_order_id) ledger.markCancelled(order.clob_order_id);
    }
    return true;
  }
  try {
    const resp = await fetch(`${PYTHON_API_URL}/api/strategy/cancel-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await resp.json() as { success: boolean };

    if (data.success) {
      // Mark all OPEN orders as cancelled in the ledger
      const openOrders = ledger.getOpenOrders();
      for (const order of openOrders) {
        if (order.clob_order_id) {
          ledger.markCancelled(order.clob_order_id);
        }
      }
      logActivity("CANCEL_ALL", `Cancelled all CLOB orders (${openOrders.length} tracked)`, { level: "info" });
    }

    return data.success;
  } catch (err) {
    console.error("[CANCEL_ALL] Error:", err);
    return false;
  }
}
