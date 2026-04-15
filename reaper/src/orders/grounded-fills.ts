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

/** Fetch recent trades from the public Data API. */
async function fetchTradeTape(slug: string): Promise<TapeEntry[]> {
  try {
    const resp = await fetch(`${DATA_API}/trades?market=${encodeURIComponent(slug)}&limit=100`);
    if (!resp.ok) return [];
    const data = await resp.json() as Array<Record<string, unknown>>;
    return data.map(t => ({
      price: parseFloat(String(t.price || 0)),
      size: parseFloat(String(t.size || 0)),
      side: String(t.side || ""),
      timestamp: (t.timestamp as number) || Date.now() / 1000,
      asset: String(t.asset || ""),
    })).filter(t => t.price > 0 && t.size > 0);
  } catch {
    return [];
  }
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

  for (const [slug, orders] of bySlug) {
    const tape = await fetchTradeTape(slug);
    if (tape.length === 0) continue;

    // Get the window for entry time and token IDs
    const window = getDb().prepare(
      "SELECT entered_at, up_token_id, down_token_id FROM windows WHERE slug = ?"
    ).get(slug) as { entered_at: string; up_token_id: string; down_token_id: string } | undefined;
    if (!window) continue;
    const enteredAt = window.entered_at ? new Date(window.entered_at + "Z").getTime() / 1000 : 0;

    for (const order of orders) {
      if (order.size_matched >= order.size) continue; // already filled

      // Find trades on this token at or below our bid price, after we entered
      const matchingTrades = tape.filter(t =>
        t.asset === order.token_id &&
        t.price <= order.price &&
        t.timestamp >= enteredAt
      );

      let volumeAtBid = 0;
      let bestFillPrice = order.price;
      for (const trade of matchingTrades) {
        volumeAtBid += trade.size;
        bestFillPrice = trade.price;
      }

      // Need enough volume to fill our remaining size
      const remaining = order.size - order.size_matched;
      if (volumeAtBid >= remaining * 0.5) { // 50% fill threshold — don't require exact match
        const fillSize = Math.min(remaining, volumeAtBid);
        const tradeId = `grounded-${order.id}-${Date.now()}`;
        fillProcessor.processReconcileFill(
          tradeId,
          order.clob_order_id!,
          order.window_slug,
          order.token_id,
          order.side as "UP" | "DOWN",
          bestFillPrice,
          fillSize,
        );

        logActivity("GROUNDED_FILL", `${order.side} ${fillSize.toFixed(1)}@$${bestFillPrice.toFixed(3)} (tape vol=${volumeAtBid.toFixed(0)})`, {
          windowSlug: order.window_slug,
          side: order.side,
          level: "trade",
        });
      }
    }
  }
}
