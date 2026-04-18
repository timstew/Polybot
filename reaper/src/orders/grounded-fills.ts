/**
 * Grounded Fill System — simulates fills based on real market trade tape.
 *
 * Instead of copying Bonereaper's exact fills (shadow mode), this checks
 * whether the REAL market had enough volume at our bid price to fill us.
 * This validates OUR pricing decisions, not just Bonereaper's.
 *
 * How it works:
 * 1. Fetch recent trades from the CLOB for each token
 * 2. For each resting paper order: check if there were sells at/below our bid price
 * 3. If volume at our price >= our order size → fill at the trade price
 */

import { getDb, logActivity } from "../db.js";
import * as ledger from "./order-ledger.js";
import * as fillProcessor from "./fill-processor.js";

const DATA_API = "https://data-api.polymarket.com";

interface TapeEntry {
  price: number;
  size: number;
  side: string;
  timestamp: number;
  asset: string;
}

// Rolling trade accumulator — builds up coverage of our specific tokens over time.
// The global tape at 200 returns ~0 matches for our crypto tokens (they're a tiny
// fraction of total Polymarket volume). At 1000 (API max) we get ~6. By accumulating
// across ticks and deduplicating, we build a comprehensive view.
const accumulatedTrades = new Map<string, TapeEntry>(); // keyed by "asset-price-timestamp" for dedup
let tapeCacheAt = 0;
const TAPE_TTL_MS = 4_000;
const TAPE_RETENTION_MS = 120_000; // keep 2 min of accumulated trades

async function fetchTradeTape(): Promise<TapeEntry[]> {
  const now = Date.now();
  if (now - tapeCacheAt < TAPE_TTL_MS) return [...accumulatedTrades.values()];

  try {
    const resp = await fetch(`${DATA_API}/trades?limit=1000&_t=${Date.now()}`);
    if (!resp.ok) return [...accumulatedTrades.values()];
    const data = await resp.json() as Array<Record<string, unknown>>;

    for (const t of data) {
      const price = parseFloat(String(t.price || 0));
      const size = parseFloat(String(t.size || 0));
      const ts = (t.timestamp as number) || now / 1000;
      const asset = String(t.asset || "");
      if (price <= 0 || size <= 0 || !asset) continue;

      const key = `${asset}-${price}-${ts}`;
      if (!accumulatedTrades.has(key)) {
        accumulatedTrades.set(key, {
          price, size,
          side: String(t.side || ""),
          timestamp: ts,
          asset,
        });
      }
    }

    // Prune old entries (>2 min)
    const cutoff = now / 1000 - TAPE_RETENTION_MS / 1000;
    for (const [key, entry] of accumulatedTrades) {
      if (entry.timestamp < cutoff) accumulatedTrades.delete(key);
    }

    tapeCacheAt = now;
  } catch { /* keep accumulated */ }

  return [...accumulatedTrades.values()];
}

/**
 * Check resting paper orders against the real trade tape.
 * If sells happened at/below our bid price → simulate a fill.
 */
export async function checkGroundedFills(): Promise<void> {
  const openOrders = ledger.getOpenOrders();
  const paperOrders = openOrders.filter(o => o.clob_order_id?.startsWith("paper-"));
  if (paperOrders.length === 0) return;

  // Group orders by window slug to minimize API calls
  const bySlug = new Map<string, typeof paperOrders>();
  for (const order of paperOrders) {
    const list = bySlug.get(order.window_slug) || [];
    list.push(order);
    bySlug.set(order.window_slug, list);
  }

  // One global tape fetch per tick (cached 4s) — filter per-window client-side by token ID
  const globalTape = await fetchTradeTape();
  if (globalTape.length === 0) return;

  for (const [slug, orders] of bySlug) {
    const tape = globalTape; // filter by token happens below via tokenToSide map

    // Get the window for entry time and token IDs
    const window = getDb().prepare(
      "SELECT entered_at, up_token_id, down_token_id FROM windows WHERE slug = ?"
    ).get(slug) as { entered_at: string; up_token_id: string; down_token_id: string } | undefined;
    if (!window) continue;
    const enteredAt = window.entered_at ? new Date(window.entered_at + "Z").getTime() / 1000 : 0;

    // Map token IDs to sides so we can match tape trades to orders
    const tokenToSide: Record<string, "UP" | "DOWN"> = {};
    if (window.up_token_id) tokenToSide[window.up_token_id] = "UP";
    if (window.down_token_id) tokenToSide[window.down_token_id] = "DOWN";

    for (const order of orders) {
      if (order.size_matched >= order.size) continue; // already filled

      // Find trades on this side at or below our bid price, after we entered.
      // Each matching trade fills us at THE TRADE PRICE (not our bid) for THE TRADE SIZE.
      // This is realistic: if someone sold 10 tokens at $0.45 and our bid is $0.50,
      // we'd fill 10 tokens at $0.45 (maker gets the better price).
      const matchingTrades = tape.filter(t => {
        const tradeSide = tokenToSide[t.asset];
        return tradeSide === order.side &&
          t.price <= order.price &&
          t.timestamp >= enteredAt;
      });

      if (matchingTrades.length === 0) continue;

      // Re-fetch order state (in case shadow detector already filled it this tick)
      const fresh = ledger.getOrderByClobId(order.clob_order_id!);
      if (!fresh || fresh.size_matched >= fresh.size * 0.99) continue;

      // Fill per-trade: each trade fills us up to trade.size, at trade.price
      let remaining = fresh.size - fresh.size_matched;
      for (const trade of matchingTrades) {
        if (remaining <= 0) break;
        const fillSize = Math.min(remaining, trade.size);
        // Unique tradeId per trade to prevent duplicates
        const tradeId = `grounded-${order.clob_order_id}-${trade.asset}-${trade.price}-${trade.timestamp}`;
        fillProcessor.processReconcileFill(
          tradeId,
          order.clob_order_id!,
          order.window_slug,
          order.token_id,
          order.side as "UP" | "DOWN",
          trade.price,  // fill at the TRADE price, not our bid
          fillSize,
          "paper_grounded",
        );
        remaining -= fillSize;

        logActivity("GROUNDED_FILL", `${order.side} ${fillSize.toFixed(1)}@$${trade.price.toFixed(3)} (trade)`, {
          windowSlug: order.window_slug,
          side: order.side,
          level: "trade",
        });
      }
    }
  }
}
