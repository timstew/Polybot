/**
 * Window Manager — discovers, enters, and resolves 5m/15m BTC up-or-down windows.
 *
 * Uses slug-based lookup (predictable: btc-updown-5m-{unix_timestamp})
 * with boundary-crossing detection for fast entry.
 */

import { getDb, logActivity } from "../db.js";
import { fetchSpotPrice } from "../feeds/binance-feed.js";

const GAMMA_API = "https://gamma-api.polymarket.com";

export interface CryptoMarket {
  title: string;
  slug: string;
  conditionId: string;
  endDate: string;
  upTokenId: string;
  downTokenId: string;
}

export interface WindowRow {
  slug: string;
  condition_id: string;
  title: string;
  crypto_symbol: string;
  up_token_id: string;
  down_token_id: string;
  open_time: number;
  end_time: number;
  oracle_strike: number | null;
  price_at_open: number | null;
  status: string;
  outcome: string | null;
  up_inventory: number;
  down_inventory: number;
  up_avg_cost: number;
  down_avg_cost: number;
  fill_count: number;
  total_merged: number;
  merge_pnl: number;
  net_pnl: number;
}

let lastBoundary5m = 0;

/** Discover new windows via slug-based Gamma API lookup. */
export async function discoverWindows(config: {
  maxWindowDurationMs: number;
  minWindowDurationMs: number;
  maxConcurrentWindows: number;
}): Promise<CryptoMarket[]> {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const markets: CryptoMarket[] = [];

  const intervals = [300, 900]; // 5m and 15m
  for (const interval of intervals) {
    if (interval * 1000 > config.maxWindowDurationMs) continue;
    if (interval * 1000 < config.minWindowDurationMs) continue;

    const prefix = interval === 300 ? "btc-updown-5m" : "btc-updown-15m";
    const rounded = Math.floor(nowSec / interval) * interval;

    for (let offset = 0; offset <= 1; offset++) {
      const openTs = rounded + offset * interval;
      const slug = `${prefix}-${openTs}`;

      try {
        const r = await fetch(`${GAMMA_API}/events?slug=${slug}`);
        if (!r.ok) continue;
        const events = (await r.json()) as Array<{ markets: Array<Record<string, unknown>> }>;
        for (const ev of events) {
          for (const m of ev.markets || []) {
            if (m.closed) continue;
            const outcomes = JSON.parse((m.outcomes as string) || "[]") as string[];
            const tokens = JSON.parse((m.clobTokenIds as string) || "[]") as string[];
            if (outcomes.length !== 2 || tokens.length !== 2) continue;
            const upIdx = outcomes.findIndex(o => o.toLowerCase() === "up");
            const dnIdx = outcomes.findIndex(o => o.toLowerCase() === "down");
            if (upIdx === -1 || dnIdx === -1) continue;

            const endMs = new Date(m.endDate as string).getTime();
            if (endMs - now < 30_000) continue; // need at least 30s

            markets.push({
              title: m.question as string,
              slug: m.slug as string,
              conditionId: m.conditionId as string,
              endDate: m.endDate as string,
              upTokenId: tokens[upIdx],
              downTokenId: tokens[dnIdx],
            });
          }
        }
      } catch { /* skip failed lookup */ }
    }
  }

  return markets;
}

/** Check if we've crossed a 5-minute boundary (for fast window detection). */
export function checkBoundaryCrossing(): boolean {
  const boundary = Math.floor(Date.now() / 300_000) * 300_000;
  if (boundary > lastBoundary5m) {
    lastBoundary5m = boundary;
    return true;
  }
  return false;
}

/** Enter a window — create it in the database. */
export async function enterWindow(market: CryptoMarket): Promise<boolean> {
  const db = getDb();
  const now = Date.now();

  // Parse timing
  const endMs = new Date(market.endDate).getTime();
  const duration = parseWindowDurationMs(market.title);
  const openTime = endMs - duration;
  const windowAge = now - openTime;

  // Only enter fresh windows (< 30s old)
  if (windowAge > 30_000) return false;

  // Check if already entered
  const existing = db.prepare("SELECT 1 FROM windows WHERE slug = ?").get(market.slug);
  if (existing) return false;

  // Check concurrent window limit
  const activeCount = db.prepare("SELECT COUNT(*) as c FROM windows WHERE status = 'ACTIVE'").get() as { c: number };
  // We'll check the limit in the engine, not here

  // Get spot price for reference
  const spotPrice = await fetchSpotPrice();

  db.prepare(`
    INSERT INTO windows (slug, condition_id, title, crypto_symbol, up_token_id, down_token_id,
                         open_time, end_time, price_at_open, entered_at, status)
    VALUES (?, ?, ?, 'BTCUSDT', ?, ?, ?, ?, ?, datetime('now'), 'ACTIVE')
  `).run(
    market.slug, market.conditionId, market.title,
    market.upTokenId, market.downTokenId,
    openTime, endMs, spotPrice,
  );

  logActivity("WINDOW_ENTER", `${market.title.slice(0, 40)}`, {
    windowSlug: market.slug, level: "info",
  });

  console.log(`[WINDOW] Entered: ${market.title.slice(0, 45)} (${Math.round(windowAge / 1000)}s after open)`);
  return true;
}

/** Get all active windows. */
export function getActiveWindows(): WindowRow[] {
  return getDb().prepare(
    "SELECT * FROM windows WHERE status = 'ACTIVE' ORDER BY open_time"
  ).all() as WindowRow[];
}

/** Get a window by slug. */
export function getWindow(slug: string): WindowRow | undefined {
  return getDb().prepare("SELECT * FROM windows WHERE slug = ?").get(slug) as WindowRow | undefined;
}

/** Mark a window as resolving (past end time, waiting for outcome). */
export function markResolving(slug: string): void {
  getDb().prepare(
    "UPDATE windows SET status = 'RESOLVING' WHERE slug = ? AND status = 'ACTIVE'"
  ).run(slug);
}

/** Resolve a window with an outcome. Compute P&L. */
export function resolveWindow(slug: string, outcome: "UP" | "DOWN" | "UNKNOWN"): void {
  const w = getWindow(slug);
  if (!w || w.status === "RESOLVED") return;

  let resolutionPnl = 0;
  if (outcome !== "UNKNOWN") {
    const winInv = outcome === "UP" ? w.up_inventory : w.down_inventory;
    const winCost = outcome === "UP" ? w.up_avg_cost : w.down_avg_cost;
    const loseInv = outcome === "UP" ? w.down_inventory : w.up_inventory;
    const loseCost = outcome === "UP" ? w.down_avg_cost : w.up_avg_cost;

    resolutionPnl = winInv * (1.0 - winCost) - loseInv * loseCost;
  }

  const netPnl = (w.merge_pnl || 0) + resolutionPnl;

  getDb().prepare(`
    UPDATE windows
    SET status = 'RESOLVED', outcome = ?, resolution_pnl = ?, net_pnl = ?,
        resolved_at = datetime('now')
    WHERE slug = ?
  `).run(outcome, resolutionPnl, netPnl, slug);

  logActivity("RESOLVE", `${outcome} net=$${netPnl.toFixed(2)} (mrg=$${(w.merge_pnl || 0).toFixed(2)} res=$${resolutionPnl.toFixed(2)})`, {
    windowSlug: slug, level: "trade",
  });

  console.log(`[RESOLVE] ${slug.slice(-13)} ${outcome} net=$${netPnl.toFixed(2)}`);
}

/** Parse window duration from title (e.g., "10:45PM-10:50PM" → 300000ms). */
function parseWindowDurationMs(title: string): number {
  // Try to find duration markers
  if (title.includes("5m") || /\d+:\d+[AP]M-\d+:\d+[AP]M/.test(title)) {
    // Extract times and compute difference
    const timeMatch = title.match(/(\d{1,2}):(\d{2})([AP]M)\s*-\s*(\d{1,2}):(\d{2})([AP]M)/i);
    if (timeMatch) {
      let h1 = parseInt(timeMatch[1]), m1 = parseInt(timeMatch[2]);
      let h2 = parseInt(timeMatch[4]), m2 = parseInt(timeMatch[5]);
      if (timeMatch[3].toUpperCase() === "PM" && h1 !== 12) h1 += 12;
      if (timeMatch[6].toUpperCase() === "PM" && h2 !== 12) h2 += 12;
      if (timeMatch[3].toUpperCase() === "AM" && h1 === 12) h1 = 0;
      if (timeMatch[6].toUpperCase() === "AM" && h2 === 12) h2 = 0;
      const diffMin = (h2 * 60 + m2) - (h1 * 60 + m1);
      if (diffMin > 0) return diffMin * 60_000;
    }
  }
  return 300_000; // default 5 minutes
}
