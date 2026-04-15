/**
 * Durable Order Ledger — the source of truth for all order state.
 *
 * Every order goes through this lifecycle:
 *   PENDING → OPEN → PARTIAL/FILLED → (terminal)
 *   PENDING → FAILED → (terminal)
 *   OPEN → CANCELLED → (terminal)
 *
 * Key rules:
 * 1. Write PENDING to SQLite BEFORE calling the CLOB API
 * 2. Never delete orders — mark them with terminal status
 * 3. Window resolution does NOT affect order records
 * 4. Reconciliation can update any non-terminal order
 */

import { randomUUID } from "node:crypto";
import { getDb, logActivity } from "../db.js";

export interface TrackedOrder {
  id: string;
  clob_order_id: string | null;
  token_id: string;
  window_slug: string;
  side: "UP" | "DOWN";
  buy_sell: "BUY" | "SELL";
  price: number;
  size: number;
  size_matched: number;
  avg_fill_price: number | null;
  status: "PENDING" | "OPEN" | "PARTIAL" | "FILLED" | "CANCELLED" | "FAILED";
  order_type: string;
  ladder_level: number;
  reconcile_attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  filled_at: string | null;
  cancelled_at: string | null;
}

// ── Create ─────────────────────────────────────────────────────────

/** Create a PENDING order in the ledger BEFORE calling the CLOB API. Returns the local ID. */
export function createPendingOrder(opts: {
  tokenId: string;
  windowSlug: string;
  side: "UP" | "DOWN";
  price: number;
  size: number;
  ladderLevel?: number;
}): string {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO orders (id, token_id, window_slug, side, price, size, ladder_level, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')
  `).run(id, opts.tokenId, opts.windowSlug, opts.side, opts.price, opts.size, opts.ladderLevel ?? 1);
  return id;
}

// ── Status transitions ─────────────────────────────────────────────

/** Order was placed successfully on the CLOB. */
export function markSent(localId: string, clobOrderId: string): void {
  getDb().prepare(`
    UPDATE orders SET clob_order_id = ?, status = 'OPEN', updated_at = datetime('now')
    WHERE id = ? AND status = 'PENDING'
  `).run(clobOrderId, localId);
}

/** Order placement failed. */
export function markFailed(localId: string, error: string): void {
  getDb().prepare(`
    UPDATE orders SET status = 'FAILED', error = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'PENDING'
  `).run(error, localId);
}

/** Record a fill (partial or full). Can be called multiple times for partial fills. */
export function recordFill(clobOrderId: string, fillPrice: number, fillSize: number): void {
  const order = getDb().prepare(
    "SELECT id, size, size_matched FROM orders WHERE clob_order_id = ?"
  ).get(clobOrderId) as { id: string; size: number; size_matched: number } | undefined;

  if (!order) {
    console.warn(`[LEDGER] recordFill for unknown CLOB order ${clobOrderId}`);
    return;
  }

  const newMatched = order.size_matched + fillSize;
  const isComplete = newMatched >= order.size * 0.99; // 1% tolerance for rounding
  const newStatus = isComplete ? "FILLED" : "PARTIAL";

  // Volume-weighted average fill price
  const prevCost = (order.size_matched > 0 && getAvgFillPrice(order.id)) || 0;
  const totalCost = prevCost * order.size_matched + fillPrice * fillSize;
  const avgPrice = newMatched > 0 ? totalCost / newMatched : fillPrice;

  getDb().prepare(`
    UPDATE orders
    SET size_matched = ?, avg_fill_price = ?, status = ?,
        filled_at = CASE WHEN ? = 'FILLED' THEN datetime('now') ELSE filled_at END,
        updated_at = datetime('now')
    WHERE clob_order_id = ?
  `).run(newMatched, avgPrice, newStatus, newStatus, clobOrderId);
}

/** Order was cancelled on the CLOB. */
export function markCancelled(clobOrderId: string): void {
  getDb().prepare(`
    UPDATE orders SET status = 'CANCELLED', cancelled_at = datetime('now'), updated_at = datetime('now')
    WHERE clob_order_id = ? AND status IN ('OPEN', 'PARTIAL', 'PENDING')
  `).run(clobOrderId);
}

/** Increment reconcile attempts (for orders stuck in OPEN that keep returning ERROR). */
export function incrementReconcileAttempts(clobOrderId: string): number {
  getDb().prepare(`
    UPDATE orders SET reconcile_attempts = reconcile_attempts + 1, updated_at = datetime('now')
    WHERE clob_order_id = ?
  `).run(clobOrderId);
  const row = getDb().prepare(
    "SELECT reconcile_attempts FROM orders WHERE clob_order_id = ?"
  ).get(clobOrderId) as { reconcile_attempts: number } | undefined;
  return row?.reconcile_attempts ?? 0;
}

// ── Queries ────────────────────────────────────────────────────────

/** Get all orders that are still active (PENDING, OPEN, or PARTIAL). */
export function getActiveOrders(): TrackedOrder[] {
  return getDb().prepare(
    "SELECT * FROM orders WHERE status IN ('PENDING', 'OPEN', 'PARTIAL') ORDER BY created_at"
  ).all() as TrackedOrder[];
}

/** Get active orders for a specific window. */
export function getWindowOrders(windowSlug: string): TrackedOrder[] {
  return getDb().prepare(
    "SELECT * FROM orders WHERE window_slug = ? AND status IN ('PENDING', 'OPEN', 'PARTIAL') ORDER BY ladder_level"
  ).all(windowSlug) as TrackedOrder[];
}

/** Get an order by its CLOB order ID. */
export function getOrderByClobId(clobOrderId: string): TrackedOrder | undefined {
  return getDb().prepare(
    "SELECT * FROM orders WHERE clob_order_id = ?"
  ).get(clobOrderId) as TrackedOrder | undefined;
}

/** Get an order by local ID. */
export function getOrder(localId: string): TrackedOrder | undefined {
  return getDb().prepare("SELECT * FROM orders WHERE id = ?").get(localId) as TrackedOrder | undefined;
}

/** Get all OPEN orders (for reconciliation). */
export function getOpenOrders(): TrackedOrder[] {
  return getDb().prepare(
    "SELECT * FROM orders WHERE status = 'OPEN' ORDER BY created_at"
  ).all() as TrackedOrder[];
}

/** Check if there are any non-terminal orders for a window+side+level. */
export function hasActiveOrder(windowSlug: string, side: "UP" | "DOWN", level: number): boolean {
  const row = getDb().prepare(
    "SELECT 1 FROM orders WHERE window_slug = ? AND side = ? AND ladder_level = ? AND status IN ('PENDING', 'OPEN', 'PARTIAL') LIMIT 1"
  ).get(windowSlug, side, level);
  return !!row;
}

/** Get the total capital committed in active orders (for budget tracking). */
export function getCommittedCapital(): number {
  const row = getDb().prepare(
    "SELECT COALESCE(SUM(price * size), 0) as total FROM orders WHERE status IN ('PENDING', 'OPEN', 'PARTIAL')"
  ).get() as { total: number };
  return row.total;
}

/** Get total filled capital for a window (for P&L). */
export function getWindowFillCost(windowSlug: string): number {
  const row = getDb().prepare(
    "SELECT COALESCE(SUM(price * size), 0) as total FROM fills WHERE window_slug = ?"
  ).get(windowSlug) as { total: number };
  return row.total;
}

// ── Helpers ────────────────────────────────────────────────────────

function getAvgFillPrice(localId: string): number | null {
  const row = getDb().prepare(
    "SELECT avg_fill_price FROM orders WHERE id = ?"
  ).get(localId) as { avg_fill_price: number | null } | undefined;
  return row?.avg_fill_price ?? null;
}
