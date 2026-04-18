/**
 * Order Placer — safe order placement with ledger-first persistence.
 *
 * The critical rule: write to SQLite BEFORE calling the CLOB API.
 * If the process crashes between write and API call, recovery
 * detects the PENDING order and reconciles it.
 *
 * Real mode uses the CLOB adapter (@polymarket/clob-client or v2) directly.
 * No Python API middleman — fewer hops = fewer lost fills.
 */

import { logActivity } from "../db.js";
import * as ledger from "./order-ledger.js";
import * as fillProcessor from "./fill-processor.js";
import { getConfig } from "../db.js";
import { getClobClient, isClobInitialized } from "../clob/index.js";

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
 * 2. Execute (paper: fake ID, real: CLOB API via adapter)
 * 3. Update SQLite with result
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

  // 1. Write PENDING to SQLite FIRST (shared for paper and real)
  const truncPrice = Math.floor(price * 10000) / 10000; // 4 decimal truncate (CLOB precision)
  const truncSize = Math.floor(size * 100) / 100; // 2 decimal truncate
  const localId = ledger.createPendingOrder({
    tokenId,
    windowSlug,
    side,
    price: truncPrice,
    size: truncSize,
    ladderLevel,
  });

  // 2. Paper mode: mark as resting immediately, fills handled by fill processors
  if (isPaperMode()) {
    const fakeOrderId = `paper-${localId}`;
    ledger.markSent(localId, fakeOrderId);

    logActivity("ORDER_PLACED", `${side} L${ladderLevel} ${truncSize.toFixed(1)}@$${truncPrice.toFixed(3)} resting [paper]`, {
      windowSlug, side, level: "info",
    });
    return { localId, clobOrderId: fakeOrderId, status: "placed" };
  }

  // 3. Real mode: place via CLOB adapter (no Python middleman)
  if (!isClobInitialized()) {
    ledger.markFailed(localId, "CLOB client not initialized");
    return { localId, clobOrderId: "", status: "failed", error: "CLOB client not initialized" };
  }

  try {
    const clob = getClobClient();
    const result = await clob.placeLimitOrder(tokenId, "BUY", truncPrice, truncSize);

    if (result.status === "filled" && result.orderId) {
      ledger.markSent(localId, result.orderId);
      fillProcessor.processImmediateFill(
        localId,
        result.orderId,
        windowSlug,
        tokenId,
        side,
        result.fillPrice || truncPrice,
        result.fillSize || truncSize,
      );

      logActivity("ORDER_FILLED", `${side} L${ladderLevel} ${(result.fillSize || truncSize).toFixed(1)}@$${(result.fillPrice || truncPrice).toFixed(3)} [immediate]`, {
        windowSlug, side, level: "trade",
      });

      return {
        localId,
        clobOrderId: result.orderId,
        status: "filled",
        fillPrice: result.fillPrice || truncPrice,
        fillSize: result.fillSize || truncSize,
      };
    }

    if (result.status === "placed" && result.orderId) {
      ledger.markSent(localId, result.orderId);

      logActivity("ORDER_PLACED", `${side} L${ladderLevel} ${truncSize.toFixed(1)}@$${truncPrice.toFixed(3)} resting`, {
        windowSlug, side, level: "info",
      });

      return {
        localId,
        clobOrderId: result.orderId,
        status: "placed",
      };
    }

    // Order failed
    const error = result.error || "Unknown CLOB error";
    ledger.markFailed(localId, error);

    logActivity("ORDER_FAILED", `${side} L${ladderLevel} $${truncPrice.toFixed(3)} — ${error.slice(0, 100)}`, {
      windowSlug, side, level: "error",
    });

    return { localId, clobOrderId: "", status: "failed", error };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ledger.markFailed(localId, `Exception: ${error}`);

    logActivity("ORDER_ERROR", `${side} L${ladderLevel} $${truncPrice.toFixed(3)} — ${error.slice(0, 100)}`, {
      windowSlug, side, level: "error",
    });

    return { localId, clobOrderId: "", status: "failed", error };
  }
}

/**
 * Cancel an order on the CLOB.
 * Always updates ledger. Real mode also cancels on CLOB via adapter.
 */
export async function cancelOrder(clobOrderId: string): Promise<boolean> {
  // Always update ledger
  ledger.markCancelled(clobOrderId);

  // Paper mode: ledger update is all we need
  if (isPaperMode()) return true;

  // Real mode: cancel via CLOB adapter
  if (!isClobInitialized()) return false;

  try {
    const clob = getClobClient();
    const success = await clob.cancelOrder(clobOrderId);

    if (success) {
      logActivity("ORDER_CANCELLED", `Order ${clobOrderId.slice(0, 16)} cancelled`, { level: "info" });
    } else {
      console.warn(`[CANCEL] CLOB cancel failed for ${clobOrderId.slice(0, 16)}`);
    }
    return success;
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
  // Always cancel in ledger
  const openOrders = ledger.getOpenOrders();
  for (const order of openOrders) {
    if (order.clob_order_id) ledger.markCancelled(order.clob_order_id);
  }

  // Paper mode: ledger update is all we need
  if (isPaperMode()) return true;

  // Real mode: cancel all via CLOB adapter
  if (!isClobInitialized()) return false;

  try {
    const clob = getClobClient();
    const success = await clob.cancelAll();

    if (success) {
      logActivity("CANCEL_ALL", `Cancelled all CLOB orders (${openOrders.length} tracked)`, { level: "info" });
    }
    return success;
  } catch (err) {
    console.error("[CANCEL_ALL] Error:", err);
    return false;
  }
}
