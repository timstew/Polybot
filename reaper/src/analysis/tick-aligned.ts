/**
 * Tick-aligned analysis — joins every BR trade with the closest window tick snapshot
 * to reconstruct the market state BR saw at the moment of each decision.
 *
 * Goal: mine empirical decision rules from BR's observable behavior.
 *
 * Output: per-trade rows with market context, then aggregated statistics
 * bucketed by (side, elapsed_pct, P_true) etc.
 */

import { getDb } from "../db.js";

export interface JoinedTrade {
  trade_id: string;
  window_slug: string;
  side: "UP" | "DOWN" | "YES" | "NO" | "OTHER";
  buy_sell: "BUY" | "SELL";
  price: number;
  size: number;
  trade_ts: number;          // unix ms
  // Market state (from nearest tick)
  tick_ts: number | null;
  tick_dt_ms: number | null; // |trade_ts - tick_ts|
  p_true: number | null;
  spot_price: number | null;
  up_best_bid: number | null;
  up_best_ask: number | null;
  up_last: number | null;
  dn_best_bid: number | null;
  dn_best_ask: number | null;
  dn_last: number | null;
  up_inventory: number | null;
  dn_inventory: number | null;
  // Derived
  elapsed_sec: number;       // since window open
  elapsed_pct: number;       // 0..1 (may exceed 1 if late in resolving)
  window_duration_sec: number;
  // Sale-price context (only meaningful for BUY events)
  price_vs_ask: number | null;   // BR_price / best_ask (on same side)
  price_vs_p_true: number | null; // BR_price - (p_true for UP, or 1-p_true for DOWN)
}

/**
 * Fetch all shadow trades joined with nearest tick.
 * @param filters optional filters: { side?, buy_sell?, window_slug?, min_ts?, max_ts? }
 */
export function joinTradesWithTicks(filters: {
  side?: "UP" | "DOWN";
  buy_sell?: "BUY" | "SELL";
  window_slug?: string;
  min_ts?: number;
  max_ts?: number;
  limit?: number;
} = {}): JoinedTrade[] {
  const db = getDb();

  // Build filter clauses
  const where: string[] = ["window_slug IS NOT NULL"];
  const params: Array<string | number> = [];
  if (filters.side) { where.push("side = ?"); params.push(filters.side); }
  if (filters.buy_sell) { where.push("buy_sell = ?"); params.push(filters.buy_sell); }
  if (filters.window_slug) { where.push("window_slug = ?"); params.push(filters.window_slug); }
  if (filters.min_ts) { where.push("timestamp >= ?"); params.push(filters.min_ts); }
  if (filters.max_ts) { where.push("timestamp <= ?"); params.push(filters.max_ts); }

  const trades = db.prepare(`
    SELECT id, window_slug, side, buy_sell, price, size, timestamp
    FROM shadow_trades
    WHERE ${where.join(" AND ")}
    ORDER BY timestamp
    ${filters.limit ? `LIMIT ${filters.limit}` : ""}
  `).all(...params) as Array<{
    id: string; window_slug: string; side: string; buy_sell: string;
    price: number; size: number; timestamp: number;
  }>;

  // Cache windows and ticks per slug (efficient batch lookup)
  const windowCache = new Map<string, { open_time: number; end_time: number } | null>();
  const ticksCache = new Map<string, Array<Record<string, number | null>>>();

  const getWindow = (slug: string) => {
    if (!windowCache.has(slug)) {
      const w = db.prepare(
        "SELECT open_time, end_time FROM windows WHERE slug = ?"
      ).get(slug) as { open_time: number; end_time: number } | null;
      windowCache.set(slug, w);
    }
    return windowCache.get(slug);
  };

  const getTicks = (slug: string) => {
    if (!ticksCache.has(slug)) {
      const ticks = db.prepare(`
        SELECT timestamp, p_true, spot_price,
               up_best_bid, up_best_ask, up_last_trade,
               dn_best_bid, dn_best_ask, dn_last_trade,
               up_inventory, down_inventory
        FROM window_ticks WHERE window_slug = ? ORDER BY timestamp
      `).all(slug) as Array<Record<string, number | null>>;
      ticksCache.set(slug, ticks);
    }
    return ticksCache.get(slug)!;
  };

  const joined: JoinedTrade[] = [];
  for (const t of trades) {
    const w = getWindow(t.window_slug);
    if (!w) continue; // window not in DB (shadow-only window we never entered)
    const ticks = getTicks(t.window_slug);

    // Binary search for nearest tick (ticks are ordered by timestamp)
    let nearest: Record<string, number | null> | null = null;
    let nearestDt = Infinity;
    // Linear scan is fine for <500 ticks per window
    for (const tick of ticks) {
      const dt = Math.abs((tick.timestamp as number) - t.timestamp);
      if (dt < nearestDt) { nearestDt = dt; nearest = tick; }
      // ticks are sorted ascending — once dt starts growing, we've passed the min
      if (nearest && (tick.timestamp as number) > t.timestamp && dt > nearestDt) break;
    }

    const durationSec = (w.end_time - w.open_time) / 1000;
    const elapsedSec = (t.timestamp - w.open_time) / 1000;
    const elapsedPct = durationSec > 0 ? elapsedSec / durationSec : 0;

    // Derived price context
    let priceVsAsk: number | null = null;
    let priceVsPTrue: number | null = null;
    if (nearest) {
      if (t.side === "UP" && nearest.up_best_ask != null) {
        priceVsAsk = t.price / (nearest.up_best_ask as number);
      } else if (t.side === "DOWN" && nearest.dn_best_ask != null) {
        priceVsAsk = t.price / (nearest.dn_best_ask as number);
      }
      if (nearest.p_true != null) {
        const fair = t.side === "UP" ? (nearest.p_true as number) : 1 - (nearest.p_true as number);
        priceVsPTrue = t.price - fair;
      }
    }

    joined.push({
      trade_id: t.id,
      window_slug: t.window_slug,
      side: t.side as JoinedTrade["side"],
      buy_sell: t.buy_sell as "BUY" | "SELL",
      price: t.price,
      size: t.size,
      trade_ts: t.timestamp,
      tick_ts: nearest ? (nearest.timestamp as number) : null,
      tick_dt_ms: nearest ? Math.abs((nearest.timestamp as number) - t.timestamp) : null,
      p_true: nearest ? (nearest.p_true as number) : null,
      spot_price: nearest ? (nearest.spot_price as number) : null,
      up_best_bid: nearest ? (nearest.up_best_bid as number) : null,
      up_best_ask: nearest ? (nearest.up_best_ask as number) : null,
      up_last: nearest ? (nearest.up_last_trade as number) : null,
      dn_best_bid: nearest ? (nearest.dn_best_bid as number) : null,
      dn_best_ask: nearest ? (nearest.dn_best_ask as number) : null,
      dn_last: nearest ? (nearest.dn_last_trade as number) : null,
      up_inventory: nearest ? (nearest.up_inventory as number) : null,
      dn_inventory: nearest ? (nearest.down_inventory as number) : null,
      elapsed_sec: elapsedSec,
      elapsed_pct: elapsedPct,
      window_duration_sec: durationSec,
      price_vs_ask: priceVsAsk,
      price_vs_p_true: priceVsPTrue,
    });
  }

  return joined;
}

// ── Bucketed statistics ──────────────────────────────────────────────

export interface BucketStat {
  bucket: string;
  n: number;
  avg_price: number;
  avg_size: number;
  median_price: number;
  p10_price: number;
  p90_price: number;
  total_usd: number;
}

function bucketStats(trades: JoinedTrade[], keyFn: (t: JoinedTrade) => string | null): BucketStat[] {
  const groups = new Map<string, JoinedTrade[]>();
  for (const t of trades) {
    const k = keyFn(t);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  const out: BucketStat[] = [];
  for (const [k, arr] of groups) {
    const prices = arr.map(t => t.price).sort((a, b) => a - b);
    const sizes = arr.map(t => t.size);
    const pct = (p: number) => prices[Math.max(0, Math.min(prices.length - 1, Math.floor(prices.length * p)))];
    out.push({
      bucket: k,
      n: arr.length,
      avg_price: prices.reduce((a, b) => a + b, 0) / prices.length,
      avg_size: sizes.reduce((a, b) => a + b, 0) / sizes.length,
      median_price: pct(0.5),
      p10_price: pct(0.1),
      p90_price: pct(0.9),
      total_usd: arr.reduce((a, t) => a + t.price * t.size, 0),
    });
  }
  return out.sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/** Elapsed-percent bucket (10% increments). */
export function byElapsedPct(trades: JoinedTrade[]): BucketStat[] {
  return bucketStats(trades, t => {
    if (t.elapsed_pct < 0) return "<0%";
    if (t.elapsed_pct > 1) return ">100%";
    const b = Math.floor(t.elapsed_pct * 10) * 10;
    return String(b).padStart(3, "0") + "-" + String(b + 10).padStart(3, "0") + "%";
  });
}

/** P_true bucket (0.1 increments). */
export function byPTrue(trades: JoinedTrade[]): BucketStat[] {
  return bucketStats(trades, t => {
    if (t.p_true == null) return null;
    const b = Math.floor(t.p_true * 10) / 10;
    return b.toFixed(1) + "-" + (b + 0.1).toFixed(1);
  });
}

/** Side × elapsed-percent joint bucket. */
export function bySideAndElapsed(trades: JoinedTrade[]): BucketStat[] {
  return bucketStats(trades, t => {
    if (t.elapsed_pct < 0) return null;
    const b = Math.floor(Math.min(1, t.elapsed_pct) * 10) * 10;
    return t.side + " " + String(b).padStart(3, "0") + "-" + String(b + 10).padStart(3, "0") + "%";
  });
}

/** Price-vs-ask ratio — shows whether BR was crossing vs resting. */
export function byPriceVsAsk(trades: JoinedTrade[]): BucketStat[] {
  return bucketStats(trades, t => {
    if (t.price_vs_ask == null) return null;
    if (t.price_vs_ask < 0.2) return "0.0-0.2 (deep)";
    if (t.price_vs_ask < 0.5) return "0.2-0.5";
    if (t.price_vs_ask < 0.8) return "0.5-0.8";
    if (t.price_vs_ask < 1.0) return "0.8-1.0 (near ask)";
    if (t.price_vs_ask < 1.1) return "1.0-1.1 (at/cross)";
    return ">1.1 (taker sweep)";
  });
}

/** Cheap-sweep detector: BR buys at price < $0.20 with high certainty on other side. */
export function findCheapSweeps(trades: JoinedTrade[]): JoinedTrade[] {
  return trades.filter(t => {
    if (t.buy_sell !== "BUY") return false;
    if (t.price > 0.20) return false;
    // Is this a "losing side" buy? (price < fair)
    if (t.p_true == null) return false;
    const fair = t.side === "UP" ? t.p_true : 1 - t.p_true;
    return fair - t.price > 0.30; // price is >30pp below fair = clear dislocation
  });
}

// ── Report generation ───────────────────────────────────────────────

export interface AnalysisReport {
  dataset: {
    total_trades: number;
    unique_windows: number;
    joined_trades: number;
    tick_match_coverage: number;  // % of trades with a tick within 10s
    avg_tick_dt_ms: number;
  };
  by_side: { UP: BucketStat | null; DOWN: BucketStat | null };
  by_elapsed: BucketStat[];
  by_p_true: BucketStat[];
  by_side_and_elapsed: BucketStat[];
  by_price_vs_ask: BucketStat[];
  cheap_sweeps: {
    count: number;
    total_usd: number;
    examples: Array<{ slug: string; time: string; side: string; price: number; size: number; fair: number; elapsed_pct: number }>;
  };
  patterns: {
    // Heuristic pattern findings
    typical_entry_price_by_side_and_phase: Record<string, { phase: string; median: number; n: number }>;
    sweep_price_distribution: { p10: number; p50: number; p90: number };
    sweep_elapsed_distribution: { p10: number; p50: number; p90: number };
  };
}

export function buildReport(filters: Parameters<typeof joinTradesWithTicks>[0] = {}): AnalysisReport {
  const joined = joinTradesWithTicks(filters);
  const buys = joined.filter(t => t.buy_sell === "BUY");
  const withTick = joined.filter(t => t.tick_dt_ms != null && t.tick_dt_ms < 10000);

  const sides = { UP: null as BucketStat | null, DOWN: null as BucketStat | null };
  for (const side of ["UP", "DOWN"] as const) {
    const arr = buys.filter(t => t.side === side);
    if (arr.length > 0) {
      const prices = arr.map(t => t.price).sort((a, b) => a - b);
      const pct = (p: number) => prices[Math.floor(prices.length * p)];
      sides[side] = {
        bucket: side,
        n: arr.length,
        avg_price: prices.reduce((a, b) => a + b, 0) / prices.length,
        avg_size: arr.reduce((a, t) => a + t.size, 0) / arr.length,
        median_price: pct(0.5),
        p10_price: pct(0.1),
        p90_price: pct(0.9),
        total_usd: arr.reduce((a, t) => a + t.price * t.size, 0),
      };
    }
  }

  const sweeps = findCheapSweeps(buys);
  const sweepPrices = sweeps.map(t => t.price).sort((a, b) => a - b);
  const sweepElapsed = sweeps.map(t => t.elapsed_pct).sort((a, b) => a - b);
  const pct = (arr: number[], p: number) => arr.length ? arr[Math.floor(arr.length * p)] : 0;

  // Typical entry price per (side, phase)
  const phases = { EARLY: [0, 0.33], MID: [0.33, 0.66], LATE: [0.66, 1.0] };
  const entryTable: Record<string, { phase: string; median: number; n: number }> = {};
  for (const side of ["UP", "DOWN"] as const) {
    for (const [phase, [lo, hi]] of Object.entries(phases)) {
      const arr = buys.filter(t => t.side === side && t.elapsed_pct >= lo && t.elapsed_pct < hi)
        .map(t => t.price).sort((a, b) => a - b);
      entryTable[`${side}_${phase}`] = {
        phase,
        median: arr.length ? arr[Math.floor(arr.length * 0.5)] : 0,
        n: arr.length,
      };
    }
  }

  const uniqueWindows = new Set(joined.map(t => t.window_slug)).size;
  const avgTickDt = withTick.length
    ? withTick.reduce((a, t) => a + (t.tick_dt_ms as number), 0) / withTick.length
    : 0;

  return {
    dataset: {
      total_trades: joined.length,
      unique_windows: uniqueWindows,
      joined_trades: withTick.length,
      tick_match_coverage: joined.length ? withTick.length / joined.length : 0,
      avg_tick_dt_ms: avgTickDt,
    },
    by_side: sides,
    by_elapsed: byElapsedPct(buys),
    by_p_true: byPTrue(buys),
    by_side_and_elapsed: bySideAndElapsed(buys),
    by_price_vs_ask: byPriceVsAsk(buys),
    cheap_sweeps: {
      count: sweeps.length,
      total_usd: sweeps.reduce((a, t) => a + t.price * t.size, 0),
      examples: sweeps.slice(0, 10).map(t => ({
        slug: t.window_slug,
        time: new Date(t.trade_ts).toISOString(),
        side: t.side,
        price: t.price,
        size: t.size,
        fair: t.side === "UP" ? (t.p_true || 0) : 1 - (t.p_true || 0),
        elapsed_pct: t.elapsed_pct,
      })),
    },
    patterns: {
      typical_entry_price_by_side_and_phase: entryTable,
      sweep_price_distribution: {
        p10: pct(sweepPrices, 0.1), p50: pct(sweepPrices, 0.5), p90: pct(sweepPrices, 0.9),
      },
      sweep_elapsed_distribution: {
        p10: pct(sweepElapsed, 0.1), p50: pct(sweepElapsed, 0.5), p90: pct(sweepElapsed, 0.9),
      },
    },
  };
}
