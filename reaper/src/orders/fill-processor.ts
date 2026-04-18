/**
 * Fill Processor — handles fills from any source and updates the order ledger + inventory.
 *
 * Sources:
 * 1. User WebSocket (real-time, primary)
 * 2. Immediate fill from placeOrder response
 * 3. REST reconciliation (30s fallback)
 *
 * Every fill is deduplicated by trade ID before processing.
 * Updates: order ledger (size_matched), window inventory, activity log.
 */

import { getDb, logActivity } from "../db.js";
import * as ledger from "./order-ledger.js";
import type { UserFillEvent } from "../feeds/user-ws.js";

/** Where a fill came from. Helps diagnose which detection path is working. */
export type FillSource =
  | "user_ws"         // Real-time WebSocket — primary path for REAL mode
  | "immediate"       // Order crossed spread at placement
  | "rest_reconcile"  // 30s REST safety-net check (REAL mode only)
  | "cancel_fill"     // Cancel-fill race
  | "paper_shadow"    // PAPER: shadow-wallet (Bonereaper) fill detected
  | "paper_grounded"  // PAPER: real CLOB trade tape showed our bid covered
  | "paper_book";     // PAPER: our bid crossed real ask at check time

/** Check if a fill has already been recorded (dedup by trade ID). */
function isAlreadyRecorded(tradeId: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM fills WHERE id = ?").get(tradeId);
  return !!row;
}

/** Record a fill in the fills table and update window inventory. */
function recordFillInDb(fill: {
  tradeId: string;
  clobOrderId: string;
  windowSlug: string;
  tokenId: string;
  side: "UP" | "DOWN";
  price: number;
  size: number;
  fee: number;
  source: FillSource;
  isMaker: boolean;
}): void {
  const db = getDb();

  // Insert fill record
  db.prepare(`
    INSERT OR IGNORE INTO fills (id, order_id, clob_order_id, window_slug, token_id, side, price, size, fee, source, is_maker)
    VALUES (?, (SELECT id FROM orders WHERE clob_order_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fill.tradeId,
    fill.clobOrderId,
    fill.clobOrderId,
    fill.windowSlug,
    fill.tokenId,
    fill.side,
    fill.price,
    fill.size,
    fill.fee,
    fill.source,
    fill.isMaker ? 1 : 0,
  );

  // Update window inventory
  const costBasis = fill.price; // maker fills have zero fee on Polymarket
  if (fill.side === "UP") {
    db.prepare(`
      UPDATE windows
      SET up_inventory = up_inventory + ?,
          up_avg_cost = CASE
            WHEN up_inventory > 0 THEN (up_avg_cost * up_inventory + ? * ?) / (up_inventory + ?)
            ELSE ?
          END,
          peak_up_inventory = MAX(peak_up_inventory, up_inventory + ?),
          fill_count = fill_count + 1,
          total_buy_cost = total_buy_cost + ? * ?
      WHERE slug = ?
    `).run(fill.size, costBasis, fill.size, fill.size, costBasis, fill.size, fill.price, fill.size, fill.windowSlug);
  } else {
    db.prepare(`
      UPDATE windows
      SET down_inventory = down_inventory + ?,
          down_avg_cost = CASE
            WHEN down_inventory > 0 THEN (down_avg_cost * down_inventory + ? * ?) / (down_inventory + ?)
            ELSE ?
          END,
          peak_down_inventory = MAX(peak_down_inventory, down_inventory + ?),
          fill_count = fill_count + 1,
          total_buy_cost = total_buy_cost + ? * ?
      WHERE slug = ?
    `).run(fill.size, costBasis, fill.size, fill.size, costBasis, fill.size, fill.price, fill.size, fill.windowSlug);
  }
}

/**
 * Process a fill from the User WebSocket.
 * This is the primary fill detection path — fires in real-time.
 */
export function processUserWsFill(event: UserFillEvent): void {
  if (isAlreadyRecorded(event.tradeId)) return;

  // Find the order in our ledger
  const order = ledger.getOrderByClobId(event.orderId);
  if (!order) {
    // Fill for an order we don't track — might be from a different strategy or orphan
    console.warn(`[FILL] WebSocket fill for unknown order ${event.orderId.slice(0, 16)}`);
    logActivity("FILL_UNKNOWN", `Fill for unknown order ${event.orderId}`, { level: "warning" });
    return;
  }

  // Determine side from the order (more reliable than WS event)
  const side = order.side;
  const windowSlug = order.window_slug;

  // Record in the order ledger (updates size_matched, status)
  ledger.recordFill(event.orderId, event.price, event.sizeMatched);

  // Record in the fills table + update window inventory
  recordFillInDb({
    tradeId: event.tradeId,
    clobOrderId: event.orderId,
    windowSlug,
    tokenId: order.token_id,
    side,
    price: event.price,
    size: event.sizeMatched,
    fee: 0, // maker fills = zero fee
    source: "user_ws",
    isMaker: event.isMaker,
  });

  // Log activity
  logActivity("FILL", `${side} ${event.sizeMatched.toFixed(1)}@$${event.price.toFixed(3)} [ws]`, {
    windowSlug,
    side,
    level: "trade",
  });

  console.log(`[FILL] ${side} ${event.sizeMatched.toFixed(1)}@$${event.price.toFixed(3)} window=${windowSlug.slice(-13)} [user_ws]`);
}

/**
 * Process an immediate fill (from placeOrder response).
 * Called when placeOrder returns status="filled".
 */
export function processImmediateFill(
  localId: string,
  clobOrderId: string,
  windowSlug: string,
  tokenId: string,
  side: "UP" | "DOWN",
  fillPrice: number,
  fillSize: number,
): void {
  const tradeId = `imm-${clobOrderId}-${Date.now()}`;
  if (isAlreadyRecorded(tradeId)) return;

  // Update order ledger
  ledger.recordFill(clobOrderId, fillPrice, fillSize);

  // Record fill + update inventory
  recordFillInDb({
    tradeId,
    clobOrderId,
    windowSlug,
    tokenId,
    side,
    price: fillPrice,
    size: fillSize,
    fee: 0,
    source: "immediate",
    isMaker: false, // immediate fills are taker (crossed the spread)
  });

  logActivity("FILL", `${side} ${fillSize.toFixed(1)}@$${fillPrice.toFixed(3)} [immediate]`, {
    windowSlug,
    side,
    level: "trade",
  });

  console.log(`[FILL] ${side} ${fillSize.toFixed(1)}@$${fillPrice.toFixed(3)} window=${windowSlug.slice(-13)} [immediate]`);
}

/**
 * Process a fill discovered during REST reconciliation OR any paper fill path.
 * The `source` parameter tags where the fill came from for diagnostic attribution.
 */
export function processReconcileFill(
  tradeId: string,
  clobOrderId: string,
  windowSlug: string,
  tokenId: string,
  side: "UP" | "DOWN",
  fillPrice: number,
  fillSize: number,
  source: FillSource = "rest_reconcile",
): void {
  if (isAlreadyRecorded(tradeId)) return;

  ledger.recordFill(clobOrderId, fillPrice, fillSize);

  recordFillInDb({
    tradeId,
    clobOrderId,
    windowSlug,
    tokenId,
    side,
    price: fillPrice,
    size: fillSize,
    fee: 0,
    source,
    isMaker: true, // resting fills = maker on Polymarket
  });

  logActivity("FILL", `${side} ${fillSize.toFixed(1)}@$${fillPrice.toFixed(3)} [${source}]`, {
    windowSlug,
    side,
    level: "trade",
  });

  console.log(`[FILL] ${side} ${fillSize.toFixed(1)}@$${fillPrice.toFixed(3)} window=${windowSlug.slice(-13)} [${source}]`);
}
