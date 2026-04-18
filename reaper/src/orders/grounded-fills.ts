/**
 * Grounded Fill System — gap-filler for paper fills when Market WS is unhealthy.
 *
 * Normal path is the Market WS (engine.ts `onMarketTrade`). This module only
 * runs when WS is disconnected or zombie (see engine.ts tick() gating).
 *
 * Correctness rules:
 *   1. No trade caching across calls — each invocation fetches fresh.
 *   2. Per-(order, trade) dedup so queue-sim rolls happen exactly once
 *      for each (order, underlying trade) pair, even across multiple calls.
 *   3. Fill-layer dedup via `fills.id` (tradeId) — DB INSERT OR IGNORE
 *      catches any remaining overlap with the WS path.
 */

import { getDb, logActivity, getConfig } from "../db.js";
import * as ledger from "./order-ledger.js";
import * as fillProcessor from "./fill-processor.js";
import { queueFillProbability, rollForFill } from "./queue-sim.js";

const DATA_API = "https://data-api.polymarket.com";

interface TapeEntry {
  price: number;
  size: number;
  side: string;
  timestamp: number;
  asset: string;
}

const evaluatedPairs = new Map<string, number>();
const EVAL_TTL_MS = 10 * 60 * 1000;

function pairKey(orderId: string, t: TapeEntry): string {
  return `${orderId}|${t.asset}|${t.price}|${t.size}|${t.timestamp}`;
}

function pruneEvaluated(): void {
  if (evaluatedPairs.size < 5_000) return;
  const cutoff = Date.now() - EVAL_TTL_MS;
  for (const [k, ts] of evaluatedPairs) {
    if (ts < cutoff) evaluatedPairs.delete(k);
  }
}

export function resetEvaluatedPairs(): void {
  evaluatedPairs.clear();
}

async function fetchFromDataApi(): Promise<TapeEntry[]> {
  try {
    const resp = await fetch(`${DATA_API}/trades?limit=1000&_t=${Date.now()}`);
    if (!resp.ok) return [];
    const data = await resp.json() as Array<Record<string, unknown>>;
    const out: TapeEntry[] = [];
    for (const t of data) {
      const price = parseFloat(String(t.price || 0));
      const size = parseFloat(String(t.size || 0));
      const ts = (t.timestamp as number) || Date.now() / 1000;
      const asset = String(t.asset || "");
      if (price <= 0 || size <= 0 || !asset) continue;
      out.push({ price, size, side: String(t.side || ""), timestamp: ts, asset });
    }
    return out;
  } catch {
    return [];
  }
}

let tapeFetcher: () => Promise<TapeEntry[]> = fetchFromDataApi;

export function setTapeFetcher(fn: () => Promise<TapeEntry[]>): void {
  tapeFetcher = fn;
}

export function resetTapeFetcher(): void {
  tapeFetcher = fetchFromDataApi;
}

export async function checkGroundedFills(): Promise<void> {
  const openOrders = ledger.getOpenOrders();
  const paperOrders = openOrders.filter(o => o.clob_order_id?.startsWith("paper-"));
  if (paperOrders.length === 0) return;

  const bySlug = new Map<string, typeof paperOrders>();
  for (const order of paperOrders) {
    const list = bySlug.get(order.window_slug) || [];
    list.push(order);
    bySlug.set(order.window_slug, list);
  }

  const globalTape = await tapeFetcher();
  if (globalTape.length === 0) return;

  pruneEvaluated();

  const queueSimEnabled = (getConfig("queue_fill_sim", "true") || "true") !== "false";
  const queueMult = parseFloat(getConfig("queue_fill_mult", "1.0") || "1.0");

  for (const [slug, orders] of bySlug) {
    const window = getDb().prepare(
      "SELECT entered_at, up_token_id, down_token_id FROM windows WHERE slug = ?"
    ).get(slug) as { entered_at: string; up_token_id: string; down_token_id: string } | undefined;
    if (!window) continue;
    const enteredAt = window.entered_at ? new Date(window.entered_at + "Z").getTime() / 1000 : 0;

    const tokenToSide: Record<string, "UP" | "DOWN"> = {};
    if (window.up_token_id) tokenToSide[window.up_token_id] = "UP";
    if (window.down_token_id) tokenToSide[window.down_token_id] = "DOWN";

    for (const order of orders) {
      if (order.size_matched >= order.size) continue;

      const matchingTrades = globalTape.filter(t => {
        const tradeSide = tokenToSide[t.asset];
        return tradeSide === order.side &&
          t.price <= order.price &&
          t.timestamp >= enteredAt;
      });
      if (matchingTrades.length === 0) continue;

      const fresh = ledger.getOrderByClobId(order.clob_order_id!);
      if (!fresh || fresh.size_matched >= fresh.size * 0.99) continue;

      let remaining = fresh.size - fresh.size_matched;
      for (const trade of matchingTrades) {
        if (remaining <= 0) break;

        const key = pairKey(order.clob_order_id!, trade);
        if (evaluatedPairs.has(key)) continue;
        evaluatedPairs.set(key, Date.now());

        const fillSize = Math.min(remaining, trade.size);
        remaining -= fillSize;

        if (queueSimEnabled) {
          const prob = queueFillProbability(order.price, trade.price);
          if (!rollForFill(prob, queueMult)) continue;
        }

        const tradeId = `grounded-${order.clob_order_id}-${trade.asset}-${trade.price}-${trade.timestamp}`;
        fillProcessor.processReconcileFill(
          tradeId,
          order.clob_order_id!,
          order.window_slug,
          order.token_id,
          order.side as "UP" | "DOWN",
          trade.price,
          fillSize,
          "paper_grounded",
        );

        logActivity("GROUNDED_FILL", `${order.side} ${fillSize.toFixed(1)}@$${trade.price.toFixed(3)} (trade)`, {
          windowSlug: order.window_slug,
          side: order.side,
          level: "trade",
        });
      }
    }
  }
}
