/**
 * HTTP API server — serves the dashboard and provides JSON endpoints.
 *
 * Serves a single-page dashboard at / and JSON APIs at /api/*.
 * Uses Bun.serve() for maximum performance.
 */

import { getDb, getAllConfig, getConfig } from "./db.js";
import * as ledger from "./orders/order-ledger.js";
import { getClobClient, isClobInitialized } from "./clob/index.js";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export function startApiServer(port = 3001): void {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 200, headers: CORS_HEADERS });
      }

      try {
        // ── Dashboard ─────────────────────────────────────────────
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(getDashboardHtml(), {
            headers: { "Content-Type": "text/html", ...CORS_HEADERS },
          });
        }

        if (url.pathname === "/compare") {
          return new Response(getCompareHtml(), {
            headers: { "Content-Type": "text/html", ...CORS_HEADERS },
          });
        }
        if (url.pathname === "/analysis") {
          return new Response(getAnalysisHtml(), {
            headers: { "Content-Type": "text/html", ...CORS_HEADERS },
          });
        }
        if (url.pathname === "/strategies") {
          return new Response(getStrategiesHtml(), {
            headers: { "Content-Type": "text/html", ...CORS_HEADERS },
          });
        }

        // Compare API — apples-to-apples us vs shadow wallet
        if (url.pathname === "/api/compare/summary") {
          return jsonResponse(computeCompareSummary());
        }
        if (url.pathname === "/api/analysis/bonereaper") {
          const { buildReport } = await import("./analysis/tick-aligned.js");
          const windowSlug = url.searchParams.get("slug") || undefined;
          return jsonResponse(buildReport(windowSlug ? { window_slug: windowSlug } : {}));
        }
        if (url.pathname === "/api/analysis/joined") {
          const { joinTradesWithTicks } = await import("./analysis/tick-aligned.js");
          const slug = url.searchParams.get("slug") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "1000");
          return jsonResponse(joinTradesWithTicks({ window_slug: slug, limit }));
        }

        // ── Strategies (bid plugin repository + config) ─────────────
        if (url.pathname === "/api/strategies") {
          const { listStrategies } = await import("./strategies/index.js");
          const active = getConfig("bid_strategy") || getConfig("pricing_mode") || "hybrid";
          return jsonResponse({ strategies: listStrategies(), active });
        }
        if (url.pathname === "/api/strategies/active" && req.method === "POST") {
          const body = await req.json() as { name: string };
          const { getStrategy } = await import("./strategies/index.js");
          try {
            getStrategy(body.name); // validate
            const { setConfig } = await import("./db.js");
            setConfig("bid_strategy", body.name);
            return jsonResponse({ status: "updated", active: body.name });
          } catch (err) {
            return jsonResponse({ status: "error", error: String(err) });
          }
        }

        // ── Backtest ───────────────────────────────────────────────
        if (url.pathname === "/api/backtest" && req.method === "POST") {
          const body = await req.json() as {
            strategies?: string[];
            only_resolved?: boolean;
            starting_capital?: number;
            merge_threshold_pc?: number;
          };
          const { backtestAll, summarizeByStrategy } = await import("./analysis/backtest.js");
          const strategies = body.strategies || ["hybrid", "bonereaper-ladder", "bonereaper-mimic"];
          const results = backtestAll(strategies, {
            only_resolved: body.only_resolved ?? true,
            starting_capital: body.starting_capital,
            merge_threshold_pc: body.merge_threshold_pc,
          });
          const summary = summarizeByStrategy(results);
          // Compute BR reference
          let brFills = 0, brSpend = 0;
          const uniqueSlugs = [...new Set(results.map(r => r.window_slug))];
          for (const slug of uniqueSlugs) {
            const s = getDb().prepare(
              "SELECT COUNT(*) as n, SUM(price * size) as spend FROM shadow_trades WHERE window_slug = ? AND buy_sell = 'BUY'"
            ).get(slug) as { n: number; spend: number };
            brFills += s.n;
            brSpend += s.spend || 0;
          }
          return jsonResponse({
            summary,
            br_reference: { windows: uniqueSlugs.length, total_fills: brFills, total_spend: brSpend },
            window_count: uniqueSlugs.length,
          });
        }
        if (url.pathname === "/api/compare/windows") {
          const limit = parseInt(url.searchParams.get("limit") || "100");
          return jsonResponse(computeCompareWindows(limit));
        }
        const compareWindowMatch = url.pathname.match(/^\/api\/compare\/window\/([^/]+)$/);
        if (compareWindowMatch) {
          const slug = decodeURIComponent(compareWindowMatch[1]);
          return jsonResponse(computeCompareWindow(slug));
        }

        // ── API endpoints ─────────────────────────────────────────
        if (url.pathname === "/api/activity") {
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const rows = getDb().prepare(
            "SELECT * FROM activity_log ORDER BY id DESC LIMIT ?"
          ).all(limit);
          return jsonResponse(rows);
        }

        if (url.pathname === "/api/orders") {
          const status = url.searchParams.get("status");
          const rows = status
            ? getDb().prepare("SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT 100").all(status)
            : getDb().prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 100").all();
          return jsonResponse(rows);
        }

        if (url.pathname === "/api/windows") {
          const rows = getDb().prepare(
            "SELECT * FROM windows ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'RESOLVING' THEN 1 ELSE 2 END, open_time DESC LIMIT 50"
          ).all();
          return jsonResponse(rows);
        }

        if (url.pathname === "/api/fills") {
          const windowSlug = url.searchParams.get("window");
          const rows = windowSlug
            ? getDb().prepare("SELECT * FROM fills WHERE window_slug = ? ORDER BY created_at DESC").all(windowSlug)
            : getDb().prepare("SELECT * FROM fills ORDER BY created_at DESC LIMIT 100").all();
          return jsonResponse(rows);
        }

        // Active orders per window — for inline display on window cards
        const windowOrdersMatch = url.pathname.match(/^\/api\/window\/([^/]+)\/orders$/);
        if (windowOrdersMatch) {
          const slug = decodeURIComponent(windowOrdersMatch[1]);
          const orders = getDb().prepare(
            "SELECT * FROM orders WHERE window_slug = ? AND status IN ('PENDING','OPEN','PARTIAL') ORDER BY side, ladder_level"
          ).all(slug);
          return jsonResponse(orders);
        }

        // Per-window detail — comprehensive view for drill-down
        const windowMatch = url.pathname.match(/^\/api\/window\/([^/]+)$/);
        if (windowMatch) {
          const slug = decodeURIComponent(windowMatch[1]);
          const window = getDb().prepare("SELECT * FROM windows WHERE slug = ?").get(slug) as Record<string, unknown> | undefined;
          if (!window) return jsonResponse({ error: "Window not found" });
          const orders = getDb().prepare("SELECT * FROM orders WHERE window_slug = ? ORDER BY created_at DESC").all(slug);
          const fills = getDb().prepare("SELECT * FROM fills WHERE window_slug = ? ORDER BY created_at DESC").all(slug);
          const ticks = getDb().prepare(
            "SELECT * FROM window_ticks WHERE window_slug = ? ORDER BY timestamp DESC LIMIT 200"
          ).all(slug);
          return jsonResponse({ window, orders, fills, ticks: (ticks as unknown[]).reverse() });
        }

        // Window history — tick snapshots for charts
        const historyMatch = url.pathname.match(/^\/api\/window\/([^/]+)\/history$/);
        if (historyMatch) {
          const slug = decodeURIComponent(historyMatch[1]);
          const ticks = getDb().prepare(
            "SELECT * FROM window_ticks WHERE window_slug = ? ORDER BY timestamp ASC LIMIT 500"
          ).all(slug);
          return jsonResponse(ticks);
        }

        // Shadow wallet trades for a window — for comparison analysis
        const shadowMatch = url.pathname.match(/^\/api\/window\/([^/]+)\/shadow-trades$/);
        if (shadowMatch) {
          const slug = decodeURIComponent(shadowMatch[1]);
          const trades = getDb().prepare(
            "SELECT * FROM shadow_trades WHERE window_slug = ? ORDER BY timestamp ASC"
          ).all(slug);
          return jsonResponse(trades);
        }

        // Window book — current order books for both tokens
        const bookMatch = url.pathname.match(/^\/api\/window\/([^/]+)\/book$/);
        if (bookMatch) {
          const slug = decodeURIComponent(bookMatch[1]);
          const window = getDb().prepare(
            "SELECT up_token_id, down_token_id FROM windows WHERE slug = ?"
          ).get(slug) as { up_token_id: string; down_token_id: string } | undefined;
          if (!window) return jsonResponse({ error: "Window not found" });

          const fetchBook = async (tid: string) => {
            try {
              const r = await fetch(`https://clob.polymarket.com/book?token_id=${tid}`);
              return await r.json();
            } catch { return { bids: [], asks: [] }; }
          };
          const [upBook, dnBook] = await Promise.all([fetchBook(window.up_token_id), fetchBook(window.down_token_id)]);
          return jsonResponse({ up: upBook, down: dnBook });
        }

        if (url.pathname === "/api/status") {
          const activeWindows = getDb().prepare("SELECT * FROM windows WHERE status = 'ACTIVE'").all() as Array<{
            up_inventory: number; up_avg_cost: number; down_inventory: number; down_avg_cost: number;
          }>;
          const openOrders = ledger.getActiveOrders();
          const recentFills = getDb().prepare("SELECT * FROM fills ORDER BY created_at DESC LIMIT 10").all();
          const config = getAllConfig();
          const committedCapital = ledger.getCommittedCapital();

          // Inventory value at cost (total $ tied up in held tokens)
          const inventoryValue = activeWindows.reduce((sum, w) =>
            sum + (w.up_inventory * w.up_avg_cost) + (w.down_inventory * w.down_avg_cost)
          , 0);

          // Get balance from CLOB adapter
          let balance = 0;
          if (isClobInitialized()) {
            try {
              const balInfo = await getClobClient().getBalance();
              balance = balInfo.balance;
            } catch { /* ignore */ }
          }

          // Stats
          const stats = getDb().prepare(`
            SELECT
              COUNT(*) as total_windows,
              SUM(CASE WHEN net_pnl >= 0 THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN net_pnl < 0 THEN 1 ELSE 0 END) as losses,
              COALESCE(SUM(net_pnl), 0) as total_pnl,
              COALESCE(SUM(total_buy_cost), 0) as total_volume
            FROM windows WHERE status = 'RESOLVED'
          `).get() as Record<string, number>;

          return jsonResponse({
            balance,
            committedCapital,
            inventoryValue,
            activeWindows,
            openOrders: openOrders.length,
            recentFills,
            config,
            stats,
            mode: config.mode || "paper",
          });
        }

        if (url.pathname === "/api/config" && req.method === "GET") {
          return jsonResponse(getAllConfig());
        }

        if (url.pathname === "/api/config" && req.method === "POST") {
          const updates = await req.json() as Record<string, string>;
          const { setConfig } = await import("./db.js");
          for (const [key, value] of Object.entries(updates)) {
            setConfig(key, String(value));
          }
          return jsonResponse({ status: "updated", config: getAllConfig() });
        }

        // Quick-buy: place a single limit order interactively
        if (url.pathname === "/api/quick-buy" && req.method === "POST") {
          const body = await req.json() as {
            windowSlug: string;
            side: "UP" | "DOWN";
            price: number;
            size: number;
          };
          const { placeBuyOrder } = await import("./orders/order-placer.js");
          const result = await placeBuyOrder({
            windowSlug: body.windowSlug,
            tokenId: await getTokenIdForSide(body.windowSlug, body.side),
            side: body.side,
            price: body.price,
            size: body.size,
            ladderLevel: 99, // manual orders get level 99 (distinct from strategy ladder)
          });
          return jsonResponse(result);
        }

        // Not found
        return new Response("Not found", { status: 404, headers: CORS_HEADERS });
      } catch (err) {
        console.error("[API]", err);
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
    },
  });

  console.log(`[API] Dashboard at http://localhost:${port}`);
}

async function getTokenIdForSide(windowSlug: string, side: "UP" | "DOWN"): Promise<string> {
  const row = getDb().prepare(
    "SELECT up_token_id, down_token_id FROM windows WHERE slug = ?"
  ).get(windowSlug) as { up_token_id: string; down_token_id: string } | null;
  if (!row) throw new Error("Window not found");
  return side === "UP" ? row.up_token_id : row.down_token_id;
}

// ── Compare (apples-to-apples vs shadow wallet) ─────────────────────

interface SideStats {
  fill_count: number;
  buy_count: number;
  sell_count: number;
  total_buy_usd: number;
  total_sell_usd: number;
  avg_up_price: number | null;
  avg_dn_price: number | null;
  up_tokens: number;
  dn_tokens: number;
  pair_cost: number | null;
  first_buy_sec: number | null;  // seconds after window open
  last_buy_sec: number | null;
  net_pnl: number | null;
}

function emptySide(): SideStats {
  return {
    fill_count: 0, buy_count: 0, sell_count: 0,
    total_buy_usd: 0, total_sell_usd: 0,
    avg_up_price: null, avg_dn_price: null,
    up_tokens: 0, dn_tokens: 0,
    pair_cost: null, first_buy_sec: null, last_buy_sec: null,
    net_pnl: null,
  };
}

function computeOursForWindow(slug: string, openTime: number): SideStats {
  const fills = getDb().prepare(
    "SELECT side, price, size, created_at FROM fills WHERE window_slug = ? ORDER BY created_at"
  ).all(slug) as Array<{ side: string; price: number; size: number; created_at: string }>;
  const win = getDb().prepare(
    "SELECT net_pnl, up_inventory, down_inventory, up_avg_cost, down_avg_cost, total_buy_cost FROM windows WHERE slug = ?"
  ).get(slug) as { net_pnl: number; up_inventory: number; down_inventory: number; up_avg_cost: number; down_avg_cost: number; total_buy_cost: number } | undefined;

  const s = emptySide();
  let upSum = 0, upN = 0, dnSum = 0, dnN = 0;
  for (const f of fills) {
    s.fill_count++;
    s.buy_count++; // our fills are always BUYs (we never SELL tokens, only merge)
    s.total_buy_usd += f.price * f.size;
    if (f.side === "UP") { upSum += f.price * f.size; upN += f.size; s.up_tokens += f.size; }
    else { dnSum += f.price * f.size; dnN += f.size; s.dn_tokens += f.size; }
    const tsSec = Math.floor((new Date(f.created_at + "Z").getTime() - openTime) / 1000);
    if (s.first_buy_sec === null) s.first_buy_sec = tsSec;
    s.last_buy_sec = tsSec;
  }
  s.avg_up_price = upN > 0 ? upSum / upN : null;
  s.avg_dn_price = dnN > 0 ? dnSum / dnN : null;
  s.pair_cost = (s.avg_up_price != null && s.avg_dn_price != null)
    ? s.avg_up_price + s.avg_dn_price : null;
  s.net_pnl = win?.net_pnl ?? null;
  return s;
}

function computeShadowForWindow(slug: string, openTime: number): SideStats {
  const trades = getDb().prepare(
    "SELECT side, buy_sell, price, size, timestamp FROM shadow_trades WHERE window_slug = ? ORDER BY timestamp"
  ).all(slug) as Array<{ side: string; buy_sell: string; price: number; size: number; timestamp: number }>;
  const s = emptySide();
  let upSum = 0, upN = 0, dnSum = 0, dnN = 0;
  for (const t of trades) {
    s.fill_count++;
    if (t.buy_sell === "BUY") {
      s.buy_count++;
      s.total_buy_usd += t.price * t.size;
      if (t.side === "UP") { upSum += t.price * t.size; upN += t.size; s.up_tokens += t.size; }
      else if (t.side === "DOWN") { dnSum += t.price * t.size; dnN += t.size; s.dn_tokens += t.size; }
      const tsSec = Math.floor((t.timestamp - openTime) / 1000);
      if (s.first_buy_sec === null) s.first_buy_sec = tsSec;
      s.last_buy_sec = tsSec;
    } else {
      s.sell_count++;
      s.total_sell_usd += t.price * t.size;
      if (t.side === "UP") s.up_tokens -= t.size;
      else if (t.side === "DOWN") s.dn_tokens -= t.size;
    }
  }
  s.avg_up_price = upN > 0 ? upSum / upN : null;
  s.avg_dn_price = dnN > 0 ? dnSum / dnN : null;
  s.pair_cost = (s.avg_up_price != null && s.avg_dn_price != null)
    ? s.avg_up_price + s.avg_dn_price : null;
  // Rough net P&L estimate: sells - buys + redemption value of held winning tokens
  // (We don't know outcome here reliably — caller can factor in window outcome.)
  s.net_pnl = s.sell_count > 0 || s.buy_count > 0
    ? s.total_sell_usd - s.total_buy_usd
    : null;
  return s;
}

function computeCompareWindow(slug: string): Record<string, unknown> {
  const w = getDb().prepare(
    "SELECT slug, title, crypto_symbol, open_time, end_time, status, outcome FROM windows WHERE slug = ?"
  ).get(slug) as { slug: string; title: string; crypto_symbol: string; open_time: number; end_time: number; status: string; outcome: string | null } | undefined;
  if (!w) return { error: "Window not found" };

  const ours = computeOursForWindow(slug, w.open_time);
  const shadow = computeShadowForWindow(slug, w.open_time);

  const fills = getDb().prepare(
    "SELECT id, side, price, size, source, created_at FROM fills WHERE window_slug = ? ORDER BY created_at"
  ).all(slug);
  const shadowTrades = getDb().prepare(
    "SELECT id, side, buy_sell, price, size, timestamp FROM shadow_trades WHERE window_slug = ? ORDER BY timestamp"
  ).all(slug);
  const ticks = getDb().prepare(
    "SELECT timestamp, p_true, up_best_bid, up_best_ask, up_last_trade, dn_best_bid, dn_best_ask, dn_last_trade FROM window_ticks WHERE window_slug = ? ORDER BY timestamp"
  ).all(slug);

  return {
    window: w,
    duration_ms: w.end_time - w.open_time,
    ours,
    shadow,
    fills,
    shadow_trades: shadowTrades,
    ticks,
  };
}

function computeCompareWindows(limit: number): Record<string, unknown>[] {
  // Include windows where WE participated + windows where shadow participated
  const windows = getDb().prepare(`
    SELECT w.slug, w.title, w.crypto_symbol, w.open_time, w.end_time, w.status, w.outcome, w.net_pnl
    FROM windows w
    WHERE EXISTS (SELECT 1 FROM fills WHERE window_slug = w.slug)
       OR EXISTS (SELECT 1 FROM shadow_trades WHERE window_slug = w.slug)
    ORDER BY w.open_time DESC
    LIMIT ?
  `).all(limit) as Array<{ slug: string; title: string; crypto_symbol: string; open_time: number; end_time: number; status: string; outcome: string | null; net_pnl: number }>;

  return windows.map(w => {
    const ours = computeOursForWindow(w.slug, w.open_time);
    const shadow = computeShadowForWindow(w.slug, w.open_time);
    return {
      slug: w.slug,
      title: w.title,
      crypto_symbol: w.crypto_symbol,
      open_time: w.open_time,
      end_time: w.end_time,
      duration_min: Math.round((w.end_time - w.open_time) / 60000),
      status: w.status,
      outcome: w.outcome,
      ours,
      shadow,
    };
  });
}

function computeCompareSummary(): Record<string, unknown> {
  // Overall cumulative stats across all windows where either side participated
  const rows = computeCompareWindows(10000);
  const totals = {
    ours: {
      windows_participated: 0,
      total_fills: 0,
      total_buy_usd: 0,
      total_sell_usd: 0,
      total_pnl: 0,
      up_tokens: 0,
      dn_tokens: 0,
      wins: 0,
      losses: 0,
      avg_pair_cost_weighted: 0,
    },
    shadow: {
      windows_participated: 0,
      total_fills: 0,
      total_buy_usd: 0,
      total_sell_usd: 0,
      total_pnl: 0,
      up_tokens: 0,
      dn_tokens: 0,
      avg_pair_cost_weighted: 0,
    },
    overlap: {
      both_participated: 0,
      we_only: 0,
      shadow_only: 0,
      we_missed_windows: 0, // BR participated, we didn't
    },
  };

  let oursPairWeightedSum = 0, oursPairWeight = 0;
  let shadowPairWeightedSum = 0, shadowPairWeight = 0;

  for (const w of rows) {
    const ours = w.ours as SideStats;
    const shadow = w.shadow as SideStats;
    const hasOurs = ours.fill_count > 0;
    const hasShadow = shadow.fill_count > 0;

    if (hasOurs) {
      totals.ours.windows_participated++;
      totals.ours.total_fills += ours.fill_count;
      totals.ours.total_buy_usd += ours.total_buy_usd;
      totals.ours.total_sell_usd += ours.total_sell_usd;
      totals.ours.up_tokens += ours.up_tokens;
      totals.ours.dn_tokens += ours.dn_tokens;
      if (ours.net_pnl != null) {
        totals.ours.total_pnl += ours.net_pnl;
        if (ours.net_pnl > 0) totals.ours.wins++;
        else if (ours.net_pnl < 0) totals.ours.losses++;
      }
      if (ours.pair_cost != null) {
        const weight = Math.min(ours.up_tokens, ours.dn_tokens);
        oursPairWeightedSum += ours.pair_cost * weight;
        oursPairWeight += weight;
      }
    }

    if (hasShadow) {
      totals.shadow.windows_participated++;
      totals.shadow.total_fills += shadow.fill_count;
      totals.shadow.total_buy_usd += shadow.total_buy_usd;
      totals.shadow.total_sell_usd += shadow.total_sell_usd;
      totals.shadow.up_tokens += shadow.up_tokens;
      totals.shadow.dn_tokens += shadow.dn_tokens;
      if (shadow.net_pnl != null) totals.shadow.total_pnl += shadow.net_pnl;
      if (shadow.pair_cost != null) {
        const weight = Math.min(shadow.up_tokens, shadow.dn_tokens);
        shadowPairWeightedSum += shadow.pair_cost * weight;
        shadowPairWeight += weight;
      }
    }

    if (hasOurs && hasShadow) totals.overlap.both_participated++;
    else if (hasOurs) totals.overlap.we_only++;
    else if (hasShadow) { totals.overlap.shadow_only++; totals.overlap.we_missed_windows++; }
  }

  totals.ours.avg_pair_cost_weighted = oursPairWeight > 0 ? oursPairWeightedSum / oursPairWeight : 0;
  totals.shadow.avg_pair_cost_weighted = shadowPairWeight > 0 ? shadowPairWeightedSum / shadowPairWeight : 0;

  return { totals, window_count: rows.length };
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reaper — Bonereaper Clone</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; background: #0a0a0a; color: #e0e0e0; }
    .card { background: #141414; border: 1px solid #2a2a2a; border-radius: 8px; padding: 16px; }
    .fill-row { animation: flash 0.5s ease-out; }
    @keyframes flash { from { background: #1a3a1a; } to { background: transparent; } }
    .error-row { background: #2a1a1a; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .badge-green { background: #1a3a1a; color: #4ade80; }
    .badge-red { background: #3a1a1a; color: #f87171; }
    .badge-blue { background: #1a1a3a; color: #60a5fa; }
    .badge-yellow { background: #3a3a1a; color: #fbbf24; }
    .badge-gray { background: #2a2a2a; color: #9ca3af; }
    .mono { font-family: 'SF Mono', 'Fira Code', monospace; }
    .pulse { animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

    /* Tooltip system — JS-driven floating tooltip escapes any overflow container */
    .tt { cursor: help; }
    .tt-icon {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #374151;
      color: #9ca3af;
      font-size: 9px;
      line-height: 12px;
      text-align: center;
      margin-left: 4px;
      font-weight: bold;
    }
    #floating-tip {
      position: fixed;
      background: #1f2937;
      color: #e5e7eb;
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid #374151;
      font-size: 11px;
      font-weight: normal;
      line-height: 1.4;
      white-space: normal;
      max-width: 320px;
      text-align: left;
      box-shadow: 0 4px 12px rgba(0,0,0,0.6);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.12s;
      z-index: 10000;
      font-family: 'SF Mono', 'Fira Code', monospace;
    }
    #floating-tip.visible { opacity: 1; }

    /* Window card */
    .win-card {
      background: #0f1419;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      padding: 10px;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .win-card:hover { border-color: #4b5563; background: #151b22; }
    .win-card.selected { border-color: #3b82f6; background: #151b22; }

    /* Balance bar */
    .bal-bar {
      display: flex;
      height: 6px;
      border-radius: 3px;
      overflow: hidden;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
    }
    .bal-bar .up { background: linear-gradient(90deg, #16a34a, #22c55e); }
    .bal-bar .dn { background: linear-gradient(90deg, #dc2626, #ef4444); }

    /* Sparkline container */
    .sparkline { display: block; }

    /* Modal overlay */
    #detail-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.75);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px;
    }
    #detail-overlay.visible { display: flex; }
    #detail-modal {
      background: #0a0a0a;
      border: 1px solid #2a2a2a;
      border-radius: 10px;
      width: 100%;
      max-width: 1200px;
      max-height: 92vh;
      overflow-y: auto;
      padding: 20px;
    }
    .book-table { width: 100%; font-size: 10px; }
    .book-table td { padding: 2px 6px; }
    .book-row-bid { color: #4ade80; }
    .book-row-ask { color: #f87171; }
    .book-row-mine { background: rgba(59, 130, 246, 0.15); border-left: 2px solid #3b82f6; }
  </style>
</head>
<body class="p-4 max-w-[1600px] mx-auto">
  <!-- Floating tooltip (escapes any overflow container) -->
  <div id="floating-tip"></div>

  <!-- Window detail overlay -->
  <div id="detail-overlay" onclick="if(event.target.id==='detail-overlay')closeDetail()">
    <div id="detail-modal">
      <div id="detail-content">Loading...</div>
    </div>
  </div>

  <!-- Quick-buy confirm modal -->
  <div id="buy-overlay" style="position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: none; align-items: center; justify-content: center; z-index: 2000;" onclick="if(event.target.id==='buy-overlay')closeBuy()">
    <div style="background: #0a0a0a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 24px; min-width: 360px; max-width: 500px;">
      <div id="buy-content"></div>
    </div>
  </div>

  <div class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-6">
      <div>
        <h1 class="text-2xl font-bold text-white">Reaper</h1>
        <p class="text-sm text-gray-500">Bonereaper Clone — Event-Driven Order Management</p>
      </div>
      <nav class="flex gap-3 text-sm">
        <a href="/" class="text-blue-400 hover:text-blue-300 border-b-2 border-blue-400 pb-1">Dashboard</a>
        <a href="/compare" class="text-gray-400 hover:text-white pb-1" data-tip="Apples-to-apples comparison of our trading vs Bonereaper">vs Bonereaper</a>
        <a href="/analysis" class="text-gray-400 hover:text-white pb-1" data-tip="Backtest + tick-aligned BR pattern analysis">Analysis</a>
        <a href="/strategies" class="text-gray-400 hover:text-white pb-1" data-tip="Bid strategy plugins — activate and view available strategies">Strategies</a>
      </nav>
    </div>
    <div id="connection-status" class="badge badge-gray">Loading...</div>
  </div>

  <!-- Capital allocation bar -->
  <div class="card mb-3" id="capital-bar-wrap" style="padding: 10px 14px;">
    <div class="flex justify-between items-center mb-1">
      <span class="text-[10px] text-gray-500 uppercase tracking-wide" data-tip="Visual breakdown of total capital: free (available) vs committed (in open orders) vs inventory value (at current pair-cost).">Capital Allocation</span>
      <span class="text-[10px] text-gray-500" id="capital-total">—</span>
    </div>
    <div style="display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: #1a1a1a; border: 1px solid #2a2a2a;">
      <div id="cap-free" style="background: #3b82f6; width: 0%" data-tip="Free capital — not yet deployed"></div>
      <div id="cap-committed" style="background: #fbbf24; width: 0%" data-tip="Committed — in resting limit orders"></div>
      <div id="cap-inventory" style="background: #22c55e; width: 0%" data-tip="Inventory value — tokens held at avg cost"></div>
    </div>
    <div class="flex justify-between text-[10px] mt-1 text-gray-500">
      <span><span class="inline-block w-2 h-2 rounded-full" style="background:#3b82f6"></span> Free: $<span id="cap-free-v">0</span></span>
      <span><span class="inline-block w-2 h-2 rounded-full" style="background:#fbbf24"></span> Committed: $<span id="cap-committed-v">0</span></span>
      <span><span class="inline-block w-2 h-2 rounded-full" style="background:#22c55e"></span> Inventory: $<span id="cap-inventory-v">0</span></span>
    </div>
  </div>

  <!-- Status cards -->
  <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6" id="status-cards">
    <div class="card">
      <div class="text-xs text-gray-500">
        <span class="tt" data-tip="Your available USDC balance on Polymarket, queried directly from the CLOB. Shows 'PAPER' when in paper mode.">USDC Balance<span class="tt-icon">?</span></span>
      </div>
      <div class="text-xl font-bold text-white" id="balance">—</div>
    </div>
    <div class="card">
      <div class="text-xs text-gray-500">
        <span class="tt" data-tip="Total capital currently tied up in open limit orders on the CLOB (not yet filled or cancelled).">Committed<span class="tt-icon">?</span></span>
      </div>
      <div class="text-xl font-bold text-yellow-400" id="committed">—</div>
    </div>
    <div class="card">
      <div class="text-xs text-gray-500">
        <span class="tt" data-tip="Cumulative net profit/loss across all resolved windows (merge P&L + resolution P&L - fees).">Total P&L<span class="tt-icon">?</span></span>
      </div>
      <div class="text-xl font-bold" id="pnl">—</div>
    </div>
    <div class="card">
      <div class="text-xs text-gray-500">
        <span class="tt" data-tip="Percentage of resolved windows that ended with positive net P&L.">Win Rate<span class="tt-icon">?</span></span>
      </div>
      <div class="text-xl font-bold" id="winrate">—</div>
    </div>
    <div class="card">
      <div class="text-xs text-gray-500">
        <span class="tt" data-tip="Number of resting limit orders currently on the CLOB (OPEN or PARTIAL status).">Open Orders<span class="tt-icon">?</span></span>
      </div>
      <div class="text-xl font-bold text-blue-400" id="open-orders">—</div>
    </div>
  </div>

  <!-- Main content: two columns -->
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
    <!-- Activity feed (2/3 width) -->
    <div class="lg:col-span-2">
      <div class="card">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide">
            <span class="tt" data-tip="Real-time event log: ticks (P_true computations), order placements, fills, resolutions, merges, errors. Hover any event badge for its meaning.">Activity Feed<span class="tt-icon">?</span></span>
          </h2>
          <span class="text-xs text-gray-600" id="activity-count">0 events</span>
        </div>
        <div id="activity-feed" class="space-y-1 max-h-[70vh] overflow-y-auto text-xs">
          <div class="text-gray-600 text-center py-8">Waiting for events...</div>
        </div>
      </div>
    </div>

    <!-- Right column: settings + windows + orders -->
    <div class="space-y-4">
      <!-- Settings panel — visible on load -->
      <div class="card">
        <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3">
          <span class="tt" data-tip="Strategy configuration. Changes are saved to the SQLite database and take effect on the next tick.">Settings<span class="tt-icon">?</span></span>
        </h2>
        <div id="settings-primary" class="grid grid-cols-2 gap-3 text-xs mb-3">
          Loading...
        </div>
        <details>
          <summary class="text-xs text-gray-500 cursor-pointer hover:text-gray-300 mb-2">Advanced</summary>
          <div id="settings-advanced" class="grid grid-cols-2 gap-3 text-xs mt-2"></div>
        </details>
        <div class="mt-3 flex gap-2">
          <button onclick="saveSettings()" class="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-500">Save</button>
          <span id="save-status" class="text-xs text-gray-500"></span>
        </div>
      </div>

      <!-- Active windows -->
      <div class="card">
        <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3">
          <span class="tt" data-tip="Binary 'up or down' crypto prediction markets we've entered. Each shows UP/DOWN inventory, pair cost (pc), and fill count. Pair cost &lt; $1.00 means structurally profitable regardless of outcome.">Active Windows<span class="tt-icon">?</span></span>
        </h2>
        <div id="windows" class="space-y-2">
          <div class="text-gray-600 text-center py-4 text-xs">No active windows</div>
        </div>
      </div>

      <!-- Recent fills -->
      <div class="card">
        <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3">
          <span class="tt" data-tip="Most recent order fills. Source badge indicates how the fill was detected: user_ws (real-time WebSocket), rest_reconcile (30s REST check), immediate (filled at placement), cancel_fill (filled during cancel race).">Recent Fills<span class="tt-icon">?</span></span>
        </h2>
        <div id="fills" class="space-y-1">
          <div class="text-gray-600 text-center py-4 text-xs">No fills yet</div>
        </div>
      </div>

      <!-- Completed windows -->
      <div class="card">
        <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3">
          <span class="tt" data-tip="Windows that have been resolved by the oracle. Shows the winning outcome (UP/DOWN) and net P&L for that window.">Completed<span class="tt-icon">?</span></span>
        </h2>
        <div id="completed" class="space-y-1">
          <div class="text-gray-600 text-center py-4 text-xs">No completed windows</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const API = '';
    let lastActivityId = 0;
    let settingsLoaded = false;
    let selectedWindowSlug = null;
    // Client-side cache of per-window tick history for sparklines
    const tickHistory = new Map(); // slug → [{ts, pUp, pDn}]

    // Floating tooltip — works across any overflow container
    const tipEl = document.getElementById('floating-tip');
    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest('[data-tip]');
      if (!target) return;
      const tip = target.getAttribute('data-tip');
      if (!tip) return;
      tipEl.textContent = tip;
      tipEl.classList.add('visible');
      positionTip(target);
    });
    document.addEventListener('mouseout', (e) => {
      if (!e.target.closest || !e.target.closest('[data-tip]')) return;
      tipEl.classList.remove('visible');
    });
    document.addEventListener('scroll', () => tipEl.classList.remove('visible'), true);
    function positionTip(target) {
      const rect = target.getBoundingClientRect();
      const tipRect = tipEl.getBoundingClientRect();
      let top = rect.top - tipRect.height - 8;
      let left = rect.left + rect.width / 2 - tipRect.width / 2;
      if (top < 8) top = rect.bottom + 8; // flip below if no room above
      if (left < 8) left = 8;
      if (left + tipRect.width > window.innerWidth - 8) left = window.innerWidth - tipRect.width - 8;
      tipEl.style.top = top + 'px';
      tipEl.style.left = left + 'px';
    }

    // ── Active Window cards ───────────────────────────────────────────
    // Create/update cards in-place to avoid flicker from full HTML rebuild.

    function renderWindowCardSkeleton(w) {
      // Static skeleton — mutable parts have dedicated IDs, populated by updateWindowCardData.
      const title = (w.title || w.slug || '').replace(/Bitcoin Up or Down - /, '').slice(0, 32);
      return '' +
        '<div class="win-card" data-slug="' + w.slug + '" onclick="openDetail(\\'' + w.slug + '\\')" id="wincard-' + w.slug + '">' +
          '<div class="flex justify-between items-center mb-1">' +
            '<span class="text-gray-200 text-xs font-semibold truncate" style="max-width: 180px" data-tip="' + (w.slug || '').replace(/"/g, '&quot;') + '">' + title + '</span>' +
            '<span class="text-[10px] text-gray-500" id="win-time-' + w.slug + '">—</span>' +
          '</div>' +
          '<div class="mb-2" id="win-bal-wrap-' + w.slug + '" data-tip="">' +
            '<div class="bal-bar">' +
              '<div class="up" id="win-bar-up-' + w.slug + '" style="width: 50%"></div>' +
              '<div class="dn" id="win-bar-dn-' + w.slug + '" style="width: 50%"></div>' +
            '</div>' +
            '<div class="flex justify-between text-[10px] mt-0.5">' +
              '<span class="text-green-400" id="win-inv-up-' + w.slug + '">0↑ $0.000</span>' +
              '<span id="win-pc-' + w.slug + '" class="text-gray-500">pc=—</span>' +
              '<span class="text-red-400" id="win-inv-dn-' + w.slug + '">$0.000 0↓</span>' +
            '</div>' +
          '</div>' +
          '<div class="flex justify-between text-[10px] mt-1 mb-1">' +
            '<span id="win-pnl-' + w.slug + '" class="text-gray-500" data-tip="Estimated P&L: merge P&L + unrealized value of inventory. Updates live.">P&L —</span>' +
            '<span id="win-spend-' + w.slug + '" class="text-gray-500" data-tip="Total capital deployed (buy cost) in this window.">spent —</span>' +
            '<span id="win-merges-' + w.slug + '" class="text-gray-500" data-tip="Number of pairs merged and their realized P&L.">0 merges</span>' +
            '<span id="win-phase-' + w.slug + '" class="text-[9px] text-gray-600 font-mono" data-tip="Current strategy phase for this window.">—</span>' +
          '</div>' +
          '<div class="sparkline-wrap" id="spark-' + w.slug + '" style="height: 36px; margin-bottom: 4px;"><div class="text-[9px] text-gray-600">—</div></div>' +
          '<div class="book-summary" id="book-' + w.slug + '" style="min-height: 48px;"></div>' +
          '<div class="orders-inline mt-1" id="orders-' + w.slug + '" style="min-height: 32px;"></div>' +
          '<div class="flex justify-between text-[10px] text-gray-500 mt-1">' +
            '<span id="win-fills-' + w.slug + '">0 fills</span>' +
            '<span class="text-blue-400">▸ click for detail</span>' +
          '</div>' +
        '</div>';
    }

    // Update only the mutable fields on an existing card — no HTML rebuild.
    function updateWindowCardData(w) {
      const up = w.up_inventory || 0;
      const dn = w.down_inventory || 0;
      const total = up + dn;
      const upPct = total > 0 ? (up / total) * 100 : 50;
      const dnPct = 100 - upPct;
      const pc = w.up_avg_cost && w.down_avg_cost && up > 0 && dn > 0
        ? (w.up_avg_cost + w.down_avg_cost) : null;
      const pcColor = pc === null ? 'text-gray-500' : pc < 1.0 ? 'text-green-400' : 'text-red-400';
      const timeLeft = w.end_time ? Math.max(0, w.end_time - Date.now()) : 0;

      setTextIf('win-time-' + w.slug, formatTimeLeft(timeLeft));

      const barUp = document.getElementById('win-bar-up-' + w.slug);
      const barDn = document.getElementById('win-bar-dn-' + w.slug);
      if (barUp) barUp.style.width = upPct + '%';
      if (barDn) barDn.style.width = dnPct + '%';

      const balTip = 'Up: ' + up.toFixed(0) + ' (' + upPct.toFixed(0) + '%). Down: ' + dn.toFixed(0) + ' (' + dnPct.toFixed(0) + '%). Balanced = profit guarantee when pair cost < $1.';
      const wrap = document.getElementById('win-bal-wrap-' + w.slug);
      if (wrap) wrap.setAttribute('data-tip', balTip);

      setTextIf('win-inv-up-' + w.slug, up.toFixed(0) + '↑ $' + (w.up_avg_cost || 0).toFixed(3));
      setTextIf('win-inv-dn-' + w.slug, '$' + (w.down_avg_cost || 0).toFixed(3) + ' ' + dn.toFixed(0) + '↓');

      const pcEl = document.getElementById('win-pc-' + w.slug);
      if (pcEl) {
        pcEl.textContent = 'pc=' + (pc === null ? '—' : '$' + pc.toFixed(3));
        pcEl.className = pcColor;
        const pcTip = pc === null ? 'No paired inventory yet.' : 'Pair cost = UP ($' + w.up_avg_cost.toFixed(3) + ') + DOWN ($' + w.down_avg_cost.toFixed(3) + ') = $' + pc.toFixed(3) + '. ' + (pc < 1 ? 'PROFITABLE pair.' : 'LOSING pair (>$1).');
        pcEl.setAttribute('data-tip', pcTip);
      }

      setTextIf('win-fills-' + w.slug, (w.fill_count || 0) + ' fills');

      // P&L — merge P&L + unrealized (inventory at cost vs worst-case $0)
      const mergePnl = w.merge_pnl || 0;
      const paired = Math.min(up, dn);
      const pairCostTotal = paired > 0 && pc ? paired * pc : 0;
      const unrealized = paired > 0 ? paired * 1.0 - pairCostTotal : 0; // pairs pay $1 at resolution
      const estPnl = mergePnl + unrealized;
      const pnlEl = document.getElementById('win-pnl-' + w.slug);
      if (pnlEl) {
        const sign = estPnl >= 0 ? '+' : '';
        pnlEl.textContent = sign + '$' + estPnl.toFixed(2);
        pnlEl.className = estPnl >= 0 ? 'text-green-400' : 'text-red-400';
        pnlEl.setAttribute('data-tip', 'Merge P&L: $' + mergePnl.toFixed(2) + '. Unrealized (paired): $' + unrealized.toFixed(2) + '. Unpaired tokens at risk.');
      }

      // Spend
      const spend = w.total_buy_cost || 0;
      const spendEl = document.getElementById('win-spend-' + w.slug);
      if (spendEl) {
        spendEl.textContent = '$' + spend.toFixed(2);
        spendEl.className = 'text-gray-400';
        spendEl.setAttribute('data-tip', 'Total capital deployed: $' + spend.toFixed(2));
      }

      // Merges
      const merges = w.total_merged || 0;
      const mergesEl = document.getElementById('win-merges-' + w.slug);
      if (mergesEl) {
        mergesEl.textContent = merges.toFixed(0) + ' merged';
        mergesEl.className = merges > 0 ? 'text-cyan-400' : 'text-gray-600';
        mergesEl.setAttribute('data-tip', merges > 0 ? merges.toFixed(0) + ' pairs merged → $' + mergePnl.toFixed(2) + ' realized' : 'No merges yet.');
      }

      // Phase — computed from elapsed%
      const elapsed = w.end_time && w.open_time ? Math.max(0, (Date.now() - w.open_time) / (w.end_time - w.open_time)) : 0;
      const phaseEl = document.getElementById('win-phase-' + w.slug);
      if (phaseEl) {
        let phase = 'OPEN';
        if (elapsed > 0.85) phase = 'SWEEP';
        else if (elapsed > 0.50) phase = 'LATE';
        else if (elapsed > 0.15) phase = 'MID';
        phaseEl.textContent = phase;
        phaseEl.className = 'text-[9px] font-mono ' + (phase === 'SWEEP' ? 'text-yellow-400' : phase === 'LATE' ? 'text-orange-400' : 'text-gray-500');
        phaseEl.setAttribute('data-tip', 'Phase: ' + phase + ' (' + (elapsed * 100).toFixed(0) + '% elapsed)');
      }

      const card = document.getElementById('wincard-' + w.slug);
      if (card) card.classList.toggle('selected', selectedWindowSlug === w.slug);
    }

    function setTextIf(id, value) {
      const el = document.getElementById(id);
      if (el && el.textContent !== value) el.textContent = value;
    }

    // Upsert cards — only create/remove when the set of active slugs changes.
    function upsertWindowCards(activeWins) {
      const container = document.getElementById('windows');
      if (!container) return;

      if (activeWins.length === 0) {
        // Show empty state and clear any cards
        for (const card of container.querySelectorAll('.win-card')) card.remove();
        if (!container.querySelector('.empty-state')) {
          container.innerHTML = '<div class="empty-state text-gray-600 text-center py-4 text-xs">No active windows</div>';
        }
        return;
      }

      // Remove the empty state placeholder and any other non-card children
      for (const child of Array.from(container.children)) {
        if (!child.classList.contains('win-card')) child.remove();
      }

      const currentSlugs = new Set(activeWins.map(w => w.slug));

      // Remove cards no longer active
      for (const card of container.querySelectorAll('.win-card')) {
        if (!currentSlugs.has(card.dataset.slug)) card.remove();
      }

      // Upsert each window
      for (const w of activeWins) {
        let card = document.getElementById('wincard-' + w.slug);
        if (!card) {
          container.insertAdjacentHTML('beforeend', renderWindowCardSkeleton(w));
        }
        updateWindowCardData(w);
        hydrateWindowCard(w.slug);
      }
    }

    // Cache last-rendered HTML per-slot to avoid redundant DOM writes.
    const lastHydration = new Map();

    async function hydrateWindowCard(slug) {
      const [orders, book, history] = await Promise.all([
        fetch(API + '/api/window/' + encodeURIComponent(slug) + '/orders').then(r => r.json()).catch(() => []),
        fetch(API + '/api/window/' + encodeURIComponent(slug) + '/book').then(r => r.json()).catch(() => null),
        fetch(API + '/api/window/' + encodeURIComponent(slug) + '/history').then(r => r.json()).catch(() => []),
      ]);
      const setIfChanged = (key, el, html) => {
        if (!el) return;
        if (lastHydration.get(key) === html) return;
        lastHydration.set(key, html);
        el.innerHTML = html;
      };

      const bookEl = document.getElementById('book-' + slug);
      if (bookEl && book && !book.error) {
        const upBid = book.up?.bids?.[0];
        const upAsk = book.up?.asks?.[0];
        const dnBid = book.down?.bids?.[0];
        const dnAsk = book.down?.asks?.[0];
        const currentMode = (window.__currentMode || 'paper');

        const askBtn = (ask, side) => {
          if (!ask) return '<span class="text-red-400">—</span>';
          const price = parseFloat(ask.price);
          const size = Math.min(20, parseFloat(ask.size));
          return '<button onclick="event.stopPropagation(); openBuy(\\'' + slug + '\\', \\'' + side + '\\', ' + price + ', ' + size + ', \\'' + currentMode + '\\')" class="text-red-400 hover:text-red-300 hover:underline cursor-pointer" data-tip="Click to BUY ' + side + ' at the ask ($' + price.toFixed(3) + ' × ' + parseFloat(ask.size).toFixed(0) + ' available)">$' + price.toFixed(3) + '</button>';
        };

        const bookHtml =
          '<div class="grid grid-cols-2 gap-1 text-[10px]">' +
            '<div class="bg-green-900/20 rounded px-1 py-0.5" data-tip="UP token top of book — best bid/ask + volume. Click ask price to buy.">' +
              '<div class="text-green-400 font-bold">UP</div>' +
              '<div class="flex justify-between"><span class="text-green-500">' + (upBid ? '$' + parseFloat(upBid.price).toFixed(3) : '—') + '</span><span class="text-gray-500">' + (upBid ? parseFloat(upBid.size).toFixed(0) : '') + '</span></div>' +
              '<div class="flex justify-between">' + askBtn(upAsk, 'UP') + '<span class="text-gray-500">' + (upAsk ? parseFloat(upAsk.size).toFixed(0) : '') + '</span></div>' +
            '</div>' +
            '<div class="bg-red-900/20 rounded px-1 py-0.5" data-tip="DOWN token top of book — best bid/ask + volume. Click ask price to buy.">' +
              '<div class="text-red-400 font-bold">DOWN</div>' +
              '<div class="flex justify-between"><span class="text-green-500">' + (dnBid ? '$' + parseFloat(dnBid.price).toFixed(3) : '—') + '</span><span class="text-gray-500">' + (dnBid ? parseFloat(dnBid.size).toFixed(0) : '') + '</span></div>' +
              '<div class="flex justify-between">' + askBtn(dnAsk, 'DOWN') + '<span class="text-gray-500">' + (dnAsk ? parseFloat(dnAsk.size).toFixed(0) : '') + '</span></div>' +
            '</div>' +
          '</div>';
        setIfChanged('book-' + slug, bookEl, bookHtml);
      }

      const ordersEl = document.getElementById('orders-' + slug);
      if (ordersEl) {
        let ordersHtml;
        if (!orders || orders.length === 0) {
          ordersHtml = '<div class="text-[10px] text-gray-600">no open orders</div>';
        } else {
          const ups = orders.filter(o => o.side === 'UP').sort((a,b) => b.price - a.price);
          const dns = orders.filter(o => o.side === 'DOWN').sort((a,b) => b.price - a.price);
          ordersHtml =
            '<div class="text-[10px] text-gray-400 mb-0.5" data-tip="Our resting bids on the CLOB for this window (L = ladder level)">bids:</div>' +
            '<div class="grid grid-cols-2 gap-1 text-[10px]">' +
              '<div>' +
                ups.map(o => '<div class="text-green-400" data-tip="UP L' + o.ladder_level + ' — ' + o.status + ' — id=' + (o.clob_order_id||'').slice(0,10) + '">↑ L' + o.ladder_level + ' ' + o.size.toFixed(0) + '@$' + o.price.toFixed(3) + '</div>').join('') +
                (ups.length === 0 ? '<div class="text-gray-600">—</div>' : '') +
              '</div>' +
              '<div class="text-right">' +
                dns.map(o => '<div class="text-red-400" data-tip="DOWN L' + o.ladder_level + ' — ' + o.status + ' — id=' + (o.clob_order_id||'').slice(0,10) + '">' + o.size.toFixed(0) + '@$' + o.price.toFixed(3) + ' L' + o.ladder_level + ' ↓</div>').join('') +
                (dns.length === 0 ? '<div class="text-gray-600">—</div>' : '') +
              '</div>' +
            '</div>';
        }
        setIfChanged('orders-' + slug, ordersEl, ordersHtml);
      }

      const sparkEl = document.getElementById('spark-' + slug);
      if (sparkEl && history && history.length > 0) {
        setIfChanged('spark-' + slug, sparkEl, renderSparkline(history));
      }
    }

    function renderSparkline(ticks) {
      if (!ticks || ticks.length < 2) return '<div class="text-[9px] text-gray-600">no history yet (wait ~10s)</div>';
      const w = 200, h = 36;
      // Full 0..1 range — binary markets always live in that range
      const scale = (p) => h - p * h;
      const n = ticks.length;
      const xAt = (i) => (i / (n - 1 || 1)) * w;

      const buildPath = (getter) => {
        const pts = [];
        let first = true;
        ticks.forEach((t, i) => {
          const v = getter(t);
          if (v == null) { first = true; return; }
          pts.push((first ? 'M' : 'L') + xAt(i).toFixed(1) + ',' + scale(v).toFixed(1));
          first = false;
        });
        return pts.join(' ');
      };
      const buildBand = (getBid, getAsk) => {
        const top = [], bot = [];
        ticks.forEach((t, i) => {
          const b = getBid(t), a = getAsk(t);
          if (b == null || a == null) return;
          const x = xAt(i).toFixed(1);
          top.push(x + ',' + scale(a).toFixed(1));
          bot.unshift(x + ',' + scale(b).toFixed(1));
        });
        if (top.length === 0) return '';
        return 'M' + top.join(' L') + ' L' + bot.join(' L') + ' Z';
      };

      const upBand = buildBand(t => t.up_best_bid, t => t.up_best_ask);
      const dnBand = buildBand(t => t.dn_best_bid, t => t.dn_best_ask);
      const upLast = buildPath(t => t.up_last_trade);
      const dnLast = buildPath(t => t.dn_last_trade);
      const pTrue = buildPath(t => t.p_true);

      const last = ticks[ticks.length - 1] || {};
      const sparkTip = 'Last-trade prices (solid), bid/ask spread bands (tinted), and P_true (dashed purple) over the last ' + ticks.length + ' ticks. Click the card for full chart.';

      return '<div class="sparkline" data-tip="' + sparkTip.replace(/"/g,'&quot;') + '" style="position: relative;">' +
        '<svg width="100%" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
          '<path d="' + upBand + '" fill="#22c55e" opacity="0.12"/>' +
          '<path d="' + dnBand + '" fill="#ef4444" opacity="0.12"/>' +
          '<path d="' + pTrue + '" fill="none" stroke="#8b5cf6" stroke-width="0.8" stroke-dasharray="2,2" opacity="0.7"/>' +
          '<path d="' + upLast + '" fill="none" stroke="#4ade80" stroke-width="1.4"/>' +
          '<path d="' + dnLast + '" fill="none" stroke="#f87171" stroke-width="1.4"/>' +
        '</svg>' +
        '<div class="absolute top-0 right-0 text-[9px] mono">' +
          '<span class="text-green-400">' + fmtPxShort(last.up_last_trade) + '</span>' +
          ' <span class="text-red-400">' + fmtPxShort(last.dn_last_trade) + '</span>' +
        '</div>' +
      '</div>';
    }

    function fmtPxShort(v) { return v != null ? '$' + Number(v).toFixed(2) : '—'; }

    function formatTimeLeft(ms) {
      if (ms <= 0) return 'ended';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      const rem = s % 60;
      return m + 'm' + (rem > 0 ? rem + 's' : '');
    }

    // ── Detail overlay ────────────────────────────────────────────────
    async function openDetail(slug) {
      selectedWindowSlug = slug;
      const overlay = document.getElementById('detail-overlay');
      overlay.classList.add('visible');
      document.getElementById('detail-content').innerHTML = '<div class="text-gray-400 p-8 text-center">Loading window detail...</div>';

      const [detail, book, shadowTrades] = await Promise.all([
        fetch(API + '/api/window/' + encodeURIComponent(slug)).then(r => r.json()),
        fetch(API + '/api/window/' + encodeURIComponent(slug) + '/book').then(r => r.json()),
        fetch(API + '/api/window/' + encodeURIComponent(slug) + '/shadow-trades').then(r => r.json()).catch(() => []),
      ]);

      renderDetailModal(detail, book, shadowTrades);
    }

    function closeDetail() {
      document.getElementById('detail-overlay').classList.remove('visible');
      selectedWindowSlug = null;
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeDetail(); closeBuy(); }
    });

    // ── Quick-buy flow ────────────────────────────────────────────────
    function openBuy(slug, side, price, size, currentMode) {
      const overlay = document.getElementById('buy-overlay');
      const color = side === 'UP' ? 'green' : 'red';
      const modeWarn = currentMode === 'real'
        ? '<div class="bg-red-900/40 border border-red-700 rounded p-2 text-xs text-red-300 mb-3"><b>⚠ REAL MODE</b> — this will place a real order on the Polymarket CLOB using your wallet funds.</div>'
        : '<div class="bg-yellow-900/30 border border-yellow-700 rounded p-2 text-xs text-yellow-300 mb-3"><b>PAPER MODE</b> — simulated order, no real money.</div>';
      document.getElementById('buy-content').innerHTML =
        '<div class="text-lg font-bold text-white mb-1">Buy <span class="text-' + color + '-400">' + side + '</span></div>' +
        '<div class="text-xs text-gray-500 mb-4">' + slug + '</div>' +
        modeWarn +
        '<div class="grid grid-cols-2 gap-3 mb-4">' +
          '<div><label class="text-[10px] text-gray-500">Price ($)</label>' +
            '<input id="buy-price" type="number" step="0.001" value="' + price.toFixed(3) + '" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white font-mono mt-1"/></div>' +
          '<div><label class="text-[10px] text-gray-500">Size (tokens)</label>' +
            '<input id="buy-size" type="number" step="1" value="' + size + '" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white font-mono mt-1"/></div>' +
        '</div>' +
        '<div class="text-xs text-gray-400 mb-4">Est. cost: $<span id="buy-cost">' + (price * size).toFixed(2) + '</span></div>' +
        '<div class="flex gap-2">' +
          '<button onclick="submitBuy(\\'' + slug + '\\', \\'' + side + '\\')" class="flex-1 px-3 py-2 bg-' + color + '-600 hover:bg-' + color + '-500 text-white rounded text-sm font-semibold">Place Order</button>' +
          '<button onclick="closeBuy()" class="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm">Cancel</button>' +
        '</div>' +
        '<div id="buy-result" class="mt-3 text-xs"></div>';
      overlay.style.display = 'flex';
      // Auto-update estimated cost
      const update = () => {
        const p = parseFloat(document.getElementById('buy-price').value) || 0;
        const s = parseFloat(document.getElementById('buy-size').value) || 0;
        document.getElementById('buy-cost').textContent = (p * s).toFixed(2);
      };
      document.getElementById('buy-price').oninput = update;
      document.getElementById('buy-size').oninput = update;
    }

    function closeBuy() {
      document.getElementById('buy-overlay').style.display = 'none';
    }

    async function submitBuy(slug, side) {
      const price = parseFloat(document.getElementById('buy-price').value);
      const size = parseFloat(document.getElementById('buy-size').value);
      const resultEl = document.getElementById('buy-result');
      resultEl.innerHTML = '<span class="text-gray-400">placing…</span>';
      try {
        const resp = await fetch(API + '/api/quick-buy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ windowSlug: slug, side, price, size }),
        });
        const data = await resp.json();
        if (data.status === 'placed' || data.status === 'filled') {
          resultEl.innerHTML = '<span class="text-green-400">✓ ' + data.status + ' — id=' + (data.clobOrderId || '').slice(0,12) + '</span>';
          setTimeout(() => closeBuy(), 1500);
        } else {
          resultEl.innerHTML = '<span class="text-red-400">✗ ' + (data.error || 'failed') + '</span>';
        }
      } catch (err) {
        resultEl.innerHTML = '<span class="text-red-400">✗ ' + err + '</span>';
      }
    }

    function renderDetailModal(data, book, shadowTrades) {
      const w = data.window || {};
      const orders = data.orders || [];
      const fills = data.fills || [];
      const ticks = data.ticks || [];
      shadowTrades = shadowTrades || [];

      const chart = renderDetailChart(ticks, fills, shadowTrades);
      const bookTable = renderBookTable(book, orders);
      const ordersTable = renderDetailOrders(orders);
      const fillsTable = renderDetailFills(fills);

      const title = w.title || w.slug || '';
      const up = w.up_inventory || 0;
      const dn = w.down_inventory || 0;
      const total = up + dn;
      const upPct = total > 0 ? (up / total) * 100 : 50;
      const pc = (up > 0 && dn > 0) ? (w.up_avg_cost + w.down_avg_cost) : null;

      document.getElementById('detail-content').innerHTML =
        '<div class="flex justify-between items-start mb-4">' +
          '<div>' +
            '<div class="text-xl font-bold text-white">' + title + '</div>' +
            '<div class="text-[10px] text-gray-500 mono">' + w.slug + '</div>' +
          '</div>' +
          '<button onclick="closeDetail()" class="text-gray-400 hover:text-white text-2xl leading-none">×</button>' +
        '</div>' +
        '<div class="grid grid-cols-4 gap-3 mb-4 text-xs">' +
          '<div class="card" data-tip="Window lifetime (open → end time)"><div class="text-gray-500">Window</div><div class="text-white mono text-[11px]">' + new Date(w.open_time).toLocaleTimeString() + ' → ' + new Date(w.end_time).toLocaleTimeString() + '</div></div>' +
          '<div class="card" data-tip="Current status: ACTIVE = open, RESOLVING = waiting for oracle, RESOLVED = settled"><div class="text-gray-500">Status</div><div class="text-white">' + w.status + (w.outcome ? ' → ' + w.outcome : '') + '</div></div>' +
          '<div class="card" data-tip="Inventory split between UP and DOWN tokens"><div class="text-gray-500">Inventory</div><div><span class="text-green-400">' + up.toFixed(0) + '↑</span> / <span class="text-red-400">' + dn.toFixed(0) + '↓</span> <span class="text-gray-500">(' + upPct.toFixed(0) + '%)</span></div></div>' +
          '<div class="card" data-tip="Pair cost = UP+DOWN avg costs. <$1 = profitable regardless of outcome"><div class="text-gray-500">Pair Cost</div><div class="' + (pc === null ? 'text-gray-500' : pc < 1 ? 'text-green-400' : 'text-red-400') + '">' + (pc === null ? '—' : '$' + pc.toFixed(3)) + '</div></div>' +
        '</div>' +
        '<div class="card mb-4">' +
          '<div class="text-xs font-bold text-gray-400 uppercase mb-2" data-tip="UP/DOWN price history over the window lifetime — should sum to ~$1.00 at all times">Price History</div>' +
          chart +
        '</div>' +
        '<div class="grid grid-cols-1 md:grid-cols-3 gap-4">' +
          '<div class="card">' +
            '<div class="text-xs font-bold text-gray-400 uppercase mb-2" data-tip="Full order book depth for both tokens. Our orders highlighted in blue.">Order Book</div>' +
            bookTable +
          '</div>' +
          '<div class="card">' +
            '<div class="text-xs font-bold text-gray-400 uppercase mb-2" data-tip="All orders ever placed for this window">Orders (' + orders.length + ')</div>' +
            ordersTable +
          '</div>' +
          '<div class="card">' +
            '<div class="text-xs font-bold text-gray-400 uppercase mb-2" data-tip="All fills received for this window in chronological order">Fills (' + fills.length + ')</div>' +
            fillsTable +
          '</div>' +
        '</div>';
    }

    function renderDetailChart(ticks, fills, shadowTrades) {
      fills = fills || [];
      shadowTrades = shadowTrades || [];
      if (!ticks || ticks.length < 2) return '<div class="text-gray-600 text-center py-8 text-xs">No tick history yet — check back in a few seconds</div>';
      const w = 1100, h = 260;
      const pad = { l: 40, r: 40, t: 10, b: 20 };
      const cw = w - pad.l - pad.r;
      const ch = h - pad.t - pad.b;

      const times = ticks.map(t => t.timestamp);
      const t0 = times[0], tN = times[times.length - 1];
      const dt = (tN - t0) || 1;

      const xAt = (ts) => pad.l + ((ts - t0) / dt) * cw;
      const yAt = (p) => pad.t + (1 - p) * ch;

      // Build a line path from a value-extractor — starts 'M' at first non-null point
      const buildPath = (getter) => {
        const pts = [];
        let first = true;
        for (const t of ticks) {
          const v = getter(t);
          if (v == null) { first = true; continue; } // break line on gap
          pts.push((first ? 'M' : 'L') + xAt(t.timestamp).toFixed(1) + ',' + yAt(v).toFixed(1));
          first = false;
        }
        return pts.join(' ');
      };

      // Build a filled band between two getters (bid..ask)
      const buildBand = (getBid, getAsk) => {
        const top = []; // ask (higher)
        const bot = []; // bid (lower)
        let started = false;
        for (const t of ticks) {
          const a = getAsk(t), b = getBid(t);
          if (a == null || b == null) continue;
          const x = xAt(t.timestamp).toFixed(1);
          top.push(x + ',' + yAt(a).toFixed(1));
          bot.unshift(x + ',' + yAt(b).toFixed(1));
        }
        if (top.length === 0) return '';
        return 'M' + top.join(' L') + ' L' + bot.join(' L') + ' Z';
      };

      const upBand = buildBand(t => t.up_best_bid, t => t.up_best_ask);
      const dnBand = buildBand(t => t.dn_best_bid, t => t.dn_best_ask);
      const upBidPath = buildPath(t => t.up_best_bid);
      const upAskPath = buildPath(t => t.up_best_ask);
      const dnBidPath = buildPath(t => t.dn_best_bid);
      const dnAskPath = buildPath(t => t.dn_best_ask);
      const upLastPath = buildPath(t => t.up_last_trade);
      const dnLastPath = buildPath(t => t.dn_last_trade);
      const pTruePath = buildPath(t => t.p_true);

      // Our fill markers — solid dots (filled circles)
      const fillMarkers = fills.filter(f => {
        const ts = new Date(f.created_at + 'Z').getTime();
        return ts >= t0 - 1000 && ts <= tN + 1000;
      }).map(f => {
        const ts = new Date(f.created_at + 'Z').getTime();
        const x = xAt(ts);
        const y = yAt(f.price);
        const color = f.side === 'UP' ? '#4ade80' : '#f87171';
        const tip = 'OUR ' + f.side + ' fill: ' + f.size + ' @ $' + f.price.toFixed(3) + ' [' + f.source + ']';
        return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4" fill="' + color + '" stroke="#0a0a0a" stroke-width="1.5" data-tip="' + tip + '"/>';
      }).join('');

      // Shadow wallet (Bonereaper) fill markers — hollow/ringed diamonds, so visually distinct from ours
      const shadowMarkers = shadowTrades.filter(t => {
        const ts = t.timestamp;
        return t.buy_sell === 'BUY' && ts >= t0 - 1000 && ts <= tN + 1000;
      }).map(t => {
        const x = xAt(t.timestamp);
        const y = yAt(t.price);
        const color = t.side === 'UP' ? '#22c55e' : '#ef4444';
        const tip = 'BR ' + t.side + ' fill: ' + Number(t.size).toFixed(0) + ' @ $' + Number(t.price).toFixed(3);
        // Hollow diamond (rotated square) at 6px to distinguish from our 4px solid circles
        return '<rect x="' + (x - 4).toFixed(1) + '" y="' + (y - 4).toFixed(1) + '" width="8" height="8" fill="none" stroke="' + color + '" stroke-width="1.5" transform="rotate(45 ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')" data-tip="' + tip + '"/>';
      }).join('');

      const yLabels = [0, 0.25, 0.5, 0.75, 1].map(v => {
        const y = pad.t + (1 - v) * ch;
        return '<line x1="' + pad.l + '" x2="' + (w - pad.r) + '" y1="' + y + '" y2="' + y + '" stroke="#1f2937" stroke-width="0.5"/>' +
          '<text x="' + (pad.l - 5) + '" y="' + (y + 3) + '" fill="#6b7280" font-size="9" text-anchor="end">$' + v.toFixed(2) + '</text>';
      }).join('');

      const last = ticks[ticks.length - 1] || {};
      const fmtPx = v => v != null ? '$' + Number(v).toFixed(3) : '—';

      return '<svg width="100%" viewBox="0 0 ' + w + ' ' + h + '" style="max-height: 260px;">' +
          yLabels +
          // Filled spread bands
          '<path d="' + upBand + '" fill="#22c55e" opacity="0.10"/>' +
          '<path d="' + dnBand + '" fill="#ef4444" opacity="0.10"/>' +
          // Bid/ask lines (muted — these are mostly flat)
          '<path d="' + upAskPath + '" fill="none" stroke="#22c55e" stroke-width="0.8" stroke-dasharray="2,2" opacity="0.5"/>' +
          '<path d="' + upBidPath + '" fill="none" stroke="#22c55e" stroke-width="0.8" opacity="0.5"/>' +
          '<path d="' + dnAskPath + '" fill="none" stroke="#ef4444" stroke-width="0.8" stroke-dasharray="2,2" opacity="0.5"/>' +
          '<path d="' + dnBidPath + '" fill="none" stroke="#ef4444" stroke-width="0.8" opacity="0.5"/>' +
          // LAST TRADE prices (main actionable lines)
          '<path d="' + upLastPath + '" fill="none" stroke="#4ade80" stroke-width="2"/>' +
          '<path d="' + dnLastPath + '" fill="none" stroke="#f87171" stroke-width="2"/>' +
          // P_true (our fair-value estimate)
          '<path d="' + pTruePath + '" fill="none" stroke="#8b5cf6" stroke-width="1.5" stroke-dasharray="3,3" opacity="0.9"/>' +
          // Bonereaper fills — hollow diamonds (underneath our solid dots)
          shadowMarkers +
          // Our fill markers — solid dots at exact fill price/time
          fillMarkers +
          // Legend
          '<g transform="translate(' + (pad.l + 10) + ', 14)" font-size="10" fill="#9ca3af">' +
            '<line x1="0" x2="16" y1="0" y2="0" stroke="#4ade80" stroke-width="2"/>' +
            '<text x="20" y="3">UP ' + fmtPx(last.up_last_trade) + '</text>' +
            '<line x1="110" x2="126" y1="0" y2="0" stroke="#f87171" stroke-width="2"/>' +
            '<text x="130" y="3">DOWN ' + fmtPx(last.dn_last_trade) + '</text>' +
            '<line x1="240" x2="256" y1="0" y2="0" stroke="#8b5cf6" stroke-width="1.5" stroke-dasharray="3,3"/>' +
            '<text x="260" y="3">P_true ' + fmtPx(last.p_true) + '</text>' +
            '<circle cx="340" cy="0" r="4" fill="#4ade80" stroke="#0a0a0a"/>' +
            '<text x="348" y="3">our fills (' + fills.length + ')</text>' +
            '<rect x="440" y="-4" width="8" height="8" fill="none" stroke="#22c55e" stroke-width="1.5" transform="rotate(45 444 0)"/>' +
            '<text x="456" y="3">BR fills (' + shadowTrades.filter(t => t.buy_sell === 'BUY').length + ')</text>' +
            '<rect x="550" y="-5" width="10" height="8" fill="#22c55e" opacity="0.25"/>' +
            '<rect x="562" y="-5" width="10" height="8" fill="#ef4444" opacity="0.25"/>' +
            '<text x="578" y="3">spread</text>' +
          '</g>' +
        '</svg>';
    }

    function renderBookTable(book, myOrders) {
      if (!book || book.error) return '<div class="text-gray-600 text-xs">book unavailable</div>';
      const myUpPrices = new Set(myOrders.filter(o => o.side === 'UP' && ['OPEN','PARTIAL','PENDING'].includes(o.status)).map(o => o.price.toFixed(3)));
      const myDnPrices = new Set(myOrders.filter(o => o.side === 'DOWN' && ['OPEN','PARTIAL','PENDING'].includes(o.status)).map(o => o.price.toFixed(3)));

      const slug = selectedWindowSlug;
      const currentMode = window.__currentMode || 'paper';
      const renderSide = (bookData, mySet, label, color, side) => {
        const asks = (bookData?.asks || []).slice(0, 8).reverse();
        const bids = (bookData?.bids || []).slice(0, 8);
        return '<div class="mb-2">' +
          '<div class="text-[10px] font-bold text-' + color + '-400 mb-1">' + label + ' <span class="text-gray-500 font-normal">— click a price to place an order</span></div>' +
          '<table class="book-table mono">' +
            asks.map(a => {
              const price = parseFloat(a.price);
              const priceStr = price.toFixed(3);
              const size = Math.min(20, parseFloat(a.size));
              const cls = mySet.has(priceStr) ? 'book-row-ask book-row-mine' : 'book-row-ask';
              return '<tr class="' + cls + ' cursor-pointer hover:bg-gray-800" onclick="openBuy(\\'' + slug + '\\', \\'' + side + '\\', ' + price + ', ' + size + ', \\'' + currentMode + '\\')" data-tip="Click: BUY ' + side + ' ' + size + '@$' + priceStr + (mySet.has(priceStr) ? ' — WE HAVE AN ORDER HERE' : '') + '"><td>$' + priceStr + '</td><td class="text-right">' + parseFloat(a.size).toFixed(0) + '</td></tr>';
            }).join('') +
            '<tr><td colspan="2" class="text-[9px] text-gray-600 text-center py-0.5">— spread —</td></tr>' +
            bids.map(b => {
              const price = parseFloat(b.price);
              const priceStr = price.toFixed(3);
              const size = Math.min(20, parseFloat(b.size));
              const cls = mySet.has(priceStr) ? 'book-row-bid book-row-mine' : 'book-row-bid';
              return '<tr class="' + cls + ' cursor-pointer hover:bg-gray-800" onclick="openBuy(\\'' + slug + '\\', \\'' + side + '\\', ' + price + ', ' + size + ', \\'' + currentMode + '\\')" data-tip="Click: BUY ' + side + ' ' + size + '@$' + priceStr + ' (match this bid)' + (mySet.has(priceStr) ? ' — WE HAVE AN ORDER HERE' : '') + '"><td>$' + priceStr + '</td><td class="text-right">' + parseFloat(b.size).toFixed(0) + '</td></tr>';
            }).join('') +
          '</table>' +
        '</div>';
      };

      return renderSide(book.up, myUpPrices, 'UP', 'green', 'UP') + renderSide(book.down, myDnPrices, 'DOWN', 'red', 'DOWN');
    }

    function renderDetailOrders(orders) {
      if (orders.length === 0) return '<div class="text-gray-600 text-xs">no orders</div>';
      return '<div class="max-h-96 overflow-y-auto"><table class="w-full text-[10px] mono">' +
        '<thead><tr class="text-gray-500 border-b border-gray-800"><th class="text-left">Side</th><th class="text-right">Price</th><th class="text-right">Size</th><th class="text-right">Matched</th><th>Status</th></tr></thead>' +
        '<tbody>' +
        orders.map(o => {
          const statusColor = o.status === 'FILLED' ? 'text-green-400' : o.status === 'OPEN' || o.status === 'PARTIAL' ? 'text-blue-400' : (o.status === 'FAILED' || o.status === 'ERROR') ? 'text-red-400' : 'text-gray-500';
          return '<tr class="border-b border-gray-900"><td class="' + (o.side === 'UP' ? 'text-green-400' : 'text-red-400') + '">' + o.side + ' L' + o.ladder_level + '</td><td class="text-right">$' + o.price.toFixed(3) + '</td><td class="text-right">' + o.size.toFixed(0) + '</td><td class="text-right">' + (o.size_matched || 0).toFixed(0) + '</td><td class="' + statusColor + '">' + o.status + '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
    }

    function renderDetailFills(fills) {
      if (fills.length === 0) return '<div class="text-gray-600 text-xs">no fills</div>';
      return '<div class="max-h-96 overflow-y-auto"><table class="w-full text-[10px] mono">' +
        '<thead><tr class="text-gray-500 border-b border-gray-800"><th class="text-left">Side</th><th class="text-right">Price</th><th class="text-right">Size</th><th>Src</th></tr></thead>' +
        '<tbody>' +
        fills.map(f => '<tr class="border-b border-gray-900"><td class="' + (f.side === 'UP' ? 'text-green-400' : 'text-red-400') + '">' + f.side + '</td><td class="text-right">$' + f.price.toFixed(3) + '</td><td class="text-right">' + f.size.toFixed(0) + '</td><td class="text-gray-500">' + f.source + '</td></tr>').join('') +
        '</tbody></table></div>';
    }

    const PRIMARY_SETTINGS = {
      mode: {
        label: 'Mode', type: 'select', options: ['paper', 'real'],
        tip: 'PAPER = simulated trades, no real money at risk (uses shadow/grounded/book fill models). REAL = places actual orders on the Polymarket CLOB with your connected wallet.'
      },
      paper_fill_modes: {
        label: 'Paper Fill Modes', type: 'text',
        tip: 'Comma-separated list of enabled paper fill detectors. Default: "shadow,grounded,book" (all). Each fill gets attributed to which detector caught it first (paper_shadow, paper_grounded, paper_book). SHADOW: copies Bonereaper\\'s fills (proven timing). GROUNDED: matches against real CLOB trade tape (validates pricing). BOOK: fills when our bid crosses best ask.'
      },
      pricing_mode: {
        label: 'Pricing Mode', type: 'select', options: ['bonereaper', 'hybrid', 'book'],
        tip: 'How bid prices are computed. BONEREAPER: mimics Bonereaper\\'s fixed $0.50 opening pattern. HYBRID: blends oracle-derived P_true with CLOB book (best for shadow paper). BOOK: pure order-book-driven pricing.'
      },
      max_capital_usd: {
        label: 'Max Capital ($)', type: 'number',
        tip: 'Maximum total capital the strategy can deploy across all active windows combined. Dynamically scales bid size and max concurrent windows.'
      },
    };

    const ADVANCED_SETTINGS = {
      balance_usd: {
        label: 'Balance ($)', type: 'number',
        tip: 'Starting balance reference used as the baseline for P&L tracking and ratchet-lock bankroll protection.'
      },
      profit_reinvest_pct: {
        label: 'Reinvest %', type: 'number',
        tip: 'Fraction of profits reinvested into new trades (0.75 = 75% reinvest, 25% locked as profit). Scales effective capital = max_capital + reinvest_pct × total_pnl.'
      },
      capital_cap_usd: {
        label: 'Capital Cap ($)', type: 'number',
        tip: 'Hard ceiling on effective deployed capital. Prevents runaway scaling from accumulated profits.'
      },
      deep_value_price: {
        label: 'Deep Value Bid', type: 'number',
        tip: 'Price threshold below which we aggressively bid (treating tokens as deep value). Used in the deep-value phase of the ladder.'
      },
      certainty_threshold: {
        label: 'Certainty Threshold', type: 'number',
        tip: 'P_true threshold above which we stop bidding the losing side (too certain which way it\\'s going). Default 0.65 = if P_true(UP) &gt; 0.65, stop bidding DOWN.'
      },
      suppress_after_pct: {
        label: 'Suppress After %', type: 'number',
        tip: 'Fraction of window elapsed after which we stop placing new bids (wind-down phase). Default 0.50 = no new bids in the last half of the window.'
      },
      uncertain_range: {
        label: 'Uncertain Range', type: 'number',
        tip: 'P_true ± this range around 0.50 defines the uncertain zone where we bid both sides symmetrically. Default 0.10 = bid both sides when P_true is between 0.40 and 0.60.'
      },
      late_size_mult: {
        label: 'Late Size Mult', type: 'number',
        tip: 'Size multiplier for bids placed in the late phase of a window (high certainty, near resolution). Default 2.0 = bid 2x larger when late + certain.'
      },
      max_concurrent_windows: {
        label: 'Max Windows', type: 'number',
        tip: 'Maximum number of betting windows open simultaneously. Capped dynamically by effective capital.'
      },
      discovery_interval_ms: {
        label: 'Discovery (ms)', type: 'number',
        tip: 'How often (in milliseconds) to scan Polymarket for newly-opened betting windows. Default 15000 = every 15 seconds.'
      },
      shadow_wallet: {
        label: 'Shadow Wallet', type: 'text',
        tip: 'Wallet address to copy fills from in paper SHADOW mode. Default is Bonereaper\\'s wallet (0xeeb...). Change to shadow a different trader.'
      },
    };

    const SETTING_LABELS = { ...PRIMARY_SETTINGS, ...ADVANCED_SETTINGS };

    function renderSettingFields(entries, config) {
      return Object.entries(entries).map(([key, meta]) => {
        const val = config[key] || '';
        let input;
        if (meta.type === 'select') {
          input = '<select id="cfg-' + key + '" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs">' +
            meta.options.map(o => '<option value="' + o + '"' + (o === val ? ' selected' : '') + '>' + o + '</option>').join('') +
            '</select>';
        } else {
          input = '<input id="cfg-' + key + '" type="' + (meta.type === 'number' ? 'number' : 'text') +
            '" value="' + val + '" step="any" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs font-mono" />';
        }
        const tip = meta.tip ? ' <span class="tt" data-tip="' + meta.tip.replace(/"/g, '&quot;') + '"><span class="tt-icon">?</span></span>' : '';
        return '<div><label class="text-gray-500 text-[10px]">' + meta.label + tip + '</label>' + input + '</div>';
      }).join('');
    }

    async function loadSettings() {
      if (settingsLoaded) return;
      const config = await fetch(API + '/api/config').then(r => r.json());
      document.getElementById('settings-primary').innerHTML = renderSettingFields(PRIMARY_SETTINGS, config);
      document.getElementById('settings-advanced').innerHTML = renderSettingFields(ADVANCED_SETTINGS, config);
      settingsLoaded = true;
    }

    async function saveSettings() {
      const updates = {};
      for (const key of Object.keys(SETTING_LABELS)) {
        const el = document.getElementById('cfg-' + key);
        if (el) updates[key] = el.value;
      }
      const resp = await fetch(API + '/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await resp.json();
      document.getElementById('save-status').textContent = data.status === 'updated' ? 'Saved!' : 'Error';
      setTimeout(() => document.getElementById('save-status').textContent = '', 2000);
    }

    // Load settings on page load
    loadSettings();

    function fmt(n) { return n == null ? '—' : '$' + Number(n).toFixed(2); }
    function fmtPnl(n) {
      if (n == null) return '—';
      const s = '$' + Math.abs(n).toFixed(2);
      return n >= 0 ? '+' + s : '-' + s;
    }
    function badge(text, color) { return '<span class="badge badge-' + color + '">' + text + '</span>'; }
    function timeAgo(ts) {
      if (!ts) return '';
      const d = new Date(ts.includes('Z') ? ts : ts + 'Z');
      const s = Math.floor((Date.now() - d.getTime()) / 1000);
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s/60) + 'm ago';
      return Math.floor(s/3600) + 'h ago';
    }

    function levelBadge(level) {
      const colors = { info: 'gray', trade: 'green', signal: 'blue', warning: 'yellow', error: 'red' };
      return badge(level, colors[level] || 'gray');
    }

    const TYPE_TOOLTIPS = {
      FILL: 'Order fill recorded — inventory and P&L updated.',
      ORDER_PLACED: 'Limit order successfully placed on the CLOB (or paper order simulated).',
      ORDER_FILLED: 'Order filled immediately at placement (crossed the spread).',
      ORDER_CANCELLED: 'Order cancelled on the CLOB.',
      ORDER_FAILED: 'CLOB rejected the order — check the detail for the reason.',
      ORDER_ERROR: 'Network/exception error during order placement.',
      MERGE: 'Paired UP+DOWN tokens merged back to USDC (locks in profit when pair cost < $1).',
      REDEEM: 'Winning tokens redeemed after window resolved.',
      WINDOW_ENTER: 'Entered a new betting window — market discovered and tokens cached.',
      RESOLVE: 'Window resolved — outcome determined from oracle/Gamma API.',
      TICK: 'Strategy tick (every 5s): recomputes P_true, places/adjusts bids, checks fills.',
      STARTUP: 'Reaper app started.',
      SHUTDOWN: 'Reaper app stopping — cancelling orders and cleaning up.',
      USER_WS: 'Polymarket user WebSocket event (connection, auth, disconnect).',
      USER_WS_ERROR: 'User WebSocket error from Polymarket.',
      RECONCILE: 'REST reconciliation event (safety-net check every 30s).',
      RECONCILE_FILL: 'Fill detected by REST check that was missed by the WebSocket.',
      RECONCILE_ORPHAN: 'An order we tracked cannot be found on the CLOB (likely cancelled externally).',
      RECONCILE_ERROR: 'Error during 30s reconciliation cycle.',
      FILL_UNKNOWN: 'WebSocket delivered a fill for an order we don\\'t track (different strategy?).',
      FILL_CONFIRMED: 'Fill confirmed on-chain.',
      FILL_REVERTED: 'On-chain fill transaction reverted — inventory should be unwound.',
      FILL_FAILED: 'Fill marked as failed by the CLOB.',
      CANCEL_ALL: 'All open orders cancelled (on startup/shutdown).',
      GROUNDED_FILL: 'Paper fill simulated based on real market trade tape.',
      SHADOW_MATCH: 'Bonereaper fill found that matches one of our paper orders.',
      SHADOW_DBG: 'Debug info for shadow fill matching.',
      TICK_ERROR: 'Exception thrown in the strategy tick loop.',
      MERGE_ERROR: 'Error during auto-merge of paired positions.',
      ENGINE_START: 'Strategy engine started (5s tick loop began).',
      ENGINE_STOP: 'Strategy engine stopped.',
      ERROR: 'Generic error.',
    };

    function typeBadge(type) {
      const colors = {
        FILL: 'green', ORDER_PLACED: 'blue', ORDER_FILLED: 'green', ORDER_CANCELLED: 'gray',
        ORDER_FAILED: 'red', ORDER_ERROR: 'red', MERGE: 'blue', REDEEM: 'green',
        WINDOW_ENTER: 'blue', RESOLVE: 'yellow', STARTUP: 'gray', SHUTDOWN: 'gray',
        USER_WS: 'blue', RECONCILE: 'yellow', FILL_UNKNOWN: 'yellow', FILL_CONFIRMED: 'green',
        FILL_REVERTED: 'red', CANCEL_ALL: 'gray', ERROR: 'red', TICK: 'blue',
        GROUNDED_FILL: 'green', SHADOW_MATCH: 'green', RECONCILE_FILL: 'yellow',
      };
      const color = colors[type] || 'gray';
      const tip = TYPE_TOOLTIPS[type];
      if (tip) {
        return '<span class="tt" data-tip="' + tip.replace(/"/g, '&quot;') + '"><span class="badge badge-' + color + '">' + type + '</span></span>';
      }
      return badge(type, color);
    }

    async function refresh() {
      try {
        // Status
        const status = await fetch(API + '/api/status').then(r => r.json());
        window.__currentMode = status.mode || 'paper';

        // Capital allocation bar
        const maxCap = parseFloat(status.config?.max_capital_usd || '500');
        const committed = status.committedCapital || 0;
        const inventory = status.inventoryValue || 0;
        const free = Math.max(0, maxCap - committed - inventory);
        const capTotal = maxCap || 1;
        const freePct = (free / capTotal) * 100;
        const comPct = (committed / capTotal) * 100;
        const invPct = (inventory / capTotal) * 100;
        document.getElementById('cap-free').style.width = freePct + '%';
        document.getElementById('cap-committed').style.width = comPct + '%';
        document.getElementById('cap-inventory').style.width = invPct + '%';
        document.getElementById('cap-free-v').textContent = free.toFixed(0);
        document.getElementById('cap-committed-v').textContent = committed.toFixed(0);
        document.getElementById('cap-inventory-v').textContent = inventory.toFixed(0);
        document.getElementById('capital-total').textContent = 'Max: $' + maxCap.toFixed(0);

        document.getElementById('balance').textContent = fmt(status.balance);
        document.getElementById('committed').textContent = fmt(status.committedCapital);
        const pnl = status.stats?.total_pnl || 0;
        const pnlEl = document.getElementById('pnl');
        pnlEl.textContent = fmtPnl(pnl);
        pnlEl.className = 'text-xl font-bold ' + (pnl >= 0 ? 'text-green-400' : 'text-red-400');
        const wins = status.stats?.wins || 0;
        const losses = status.stats?.losses || 0;
        const total = wins + losses;
        document.getElementById('winrate').textContent = total > 0 ? Math.round(wins/total*100) + '%' : '—';
        document.getElementById('winrate').className = 'text-xl font-bold ' + (wins >= losses ? 'text-green-400' : 'text-red-400');
        document.getElementById('open-orders').textContent = status.openOrders;

        // Connection
        const connEl = document.getElementById('connection-status');
        const isPaper = status.mode === 'paper';
        const hasWindows = status.activeWindows?.length > 0;
        connEl.textContent = isPaper ? (hasWindows ? 'PAPER' : 'PAPER (idle)') : (hasWindows ? 'REAL' : 'IDLE');
        connEl.className = 'badge tt ' + (isPaper ? 'badge-yellow' : (hasWindows ? 'badge-green pulse' : 'badge-gray'));
        const connTip = isPaper
          ? (hasWindows ? 'Running in PAPER mode with active windows. Simulated fills, no real money.' : 'PAPER mode, no active betting windows currently (waiting for discovery).')
          : (hasWindows ? 'LIVE REAL-money trading on the Polymarket CLOB with active windows.' : 'REAL mode enabled but no active windows.');
        connEl.setAttribute('data-tip', connTip);
        if (isPaper) {
          document.getElementById('balance').textContent = 'PAPER';
          document.getElementById('balance').className = 'text-xl font-bold text-yellow-400';
        } else {
          document.getElementById('balance').textContent = fmt(status.balance);
          document.getElementById('balance').className = 'text-xl font-bold text-white';
        }

        // Windows — in-place upsert (no HTML rebuild = no flicker)
        upsertWindowCards(status.activeWindows || []);

        // Fills — only rebuild when the set of fills changes
        const fillsEl = document.getElementById('fills');
        const fills = status.recentFills || [];
        const fillsKey = fills.map(f => f.id).join('|');
        const fillsChanged = window.__lastFillsKey !== fillsKey;
        if (fillsChanged) window.__lastFillsKey = fillsKey;
        const SOURCE_TIPS = {
          // REAL mode (all three are CLOB fills — different detection paths)
          user_ws: 'REAL/CLOB: Real-time fill from Polymarket user WebSocket. Primary, sub-second.',
          immediate: 'REAL/CLOB: Order crossed the spread and matched synchronously at placement.',
          rest_reconcile: 'REAL/CLOB: Caught by 30s REST reconciliation safety-net (WebSocket missed it).',
          cancel_fill: 'REAL/CLOB: Cancel-fill race — cancel lost to a concurrent match.',
          // PAPER mode (all three detectors run every tick; attribution shows which caught it first)
          paper_shadow: 'PAPER: Shadow wallet (Bonereaper) filled here; we granted ourselves the same fill.',
          paper_grounded: 'PAPER: Real CLOB trade tape showed sells at or below our bid — we claim the fill.',
          paper_book: 'PAPER: Our bid crossed the current best ask on the real CLOB book.',
        };
        if (fillsChanged) {
          if (fills.length === 0) {
            fillsEl.innerHTML = '<div class="text-gray-600 text-center py-4 text-xs">No fills yet</div>';
          } else {
            fillsEl.innerHTML = fills.map(f => {
              const sideTip = f.side === 'UP' ? 'UP token fill (bullish side of the binary market).' : 'DOWN token fill (bearish side).';
              const srcTip = SOURCE_TIPS[f.source] || 'Fill source: ' + f.source;
              return '<div class="flex justify-between text-xs py-0.5">' +
                '<span><span class="tt" data-tip="' + sideTip + '">' + badge(f.side, f.side === 'UP' ? 'green' : 'red') + '</span>' +
                ' ' + Number(f.size).toFixed(1) + '@$' + Number(f.price).toFixed(3) + '</span>' +
                '<span class="text-gray-500"><span class="tt" data-tip="' + srcTip + '">' + badge(f.source, 'gray') + '</span></span></div>';
            }).join('');
          }
        }

        // Completed windows — only rebuild if the set changed
        const compEl = document.getElementById('completed');
        const completed = await fetch(API + '/api/windows').then(r => r.json());
        const resolved = completed.filter(w => w.status === 'RESOLVED').slice(0, 10);
        const compKey = resolved.map(w => w.slug + ':' + (w.net_pnl || 0).toFixed(2)).join('|');
        const compChanged = window.__lastCompKey !== compKey;
        if (compChanged) window.__lastCompKey = compKey;
        if (compChanged) {
        if (resolved.length === 0) {
          compEl.innerHTML = '<div class="text-gray-600 text-center py-4 text-xs">No completed windows</div>';
        } else {
          compEl.innerHTML = resolved.map(w => {
            const net = w.net_pnl || 0;
            const confirmed = w.confirmed ? true : false;
            const statusIcon = confirmed ? '\\u2705' : '\\u23F3'; // checkmark or hourglass
            const statusTip = confirmed ? 'Confirmed by Gamma API' : 'Predicted from oracle — awaiting Gamma confirmation';
            const outTip = statusIcon + ' ' + (confirmed ? 'Confirmed' : 'Predicted') + ' outcome: ' + (w.outcome || 'unknown') + '. Merge P&L: $' + (w.merge_pnl || 0).toFixed(2) + ', Resolution P&L: $' + (w.resolution_pnl || 0).toFixed(2) + '. ' + w.fill_count + ' fills, $' + (w.total_buy_cost || 0).toFixed(2) + ' spent. Click for detail.';
            const pnlTip = 'Net P&L for this window after fees.';
            return '<div class="flex justify-between text-xs py-0.5 cursor-pointer hover:bg-gray-900 rounded px-1" onclick="openDetail(\\'' + w.slug + '\\')">' +
              '<span><span class="tt" data-tip="' + statusTip + '">' + statusIcon + '</span> <span class="tt" data-tip="' + outTip + '">' + badge(w.outcome || '?', w.outcome === 'UP' ? 'green' : 'red') + '</span>' +
              ' ' + (w.title || w.slug || '').slice(-20) + '</span>' +
              '<span class="tt ' + (net >= 0 ? 'text-green-400' : 'text-red-400') + '" data-tip="' + pnlTip + '">' + fmtPnl(net) + '</span></div>';
          }).join('');
        }
        } // end compChanged

        // Activity feed — only rebuild when there are new events
        const activity = await fetch(API + '/api/activity?limit=100').then(r => r.json());
        const feedEl = document.getElementById('activity-feed');
        document.getElementById('activity-count').textContent = activity.length + ' events';
        const maxId = activity.length > 0 ? Math.max(...activity.map(a => a.id)) : 0;
        const feedChanged = window.__lastFeedMaxId !== maxId;
        if (feedChanged) window.__lastFeedMaxId = maxId;
        if (feedChanged) {
        if (activity.length === 0) {
          feedEl.innerHTML = '<div class="text-gray-600 text-center py-8">Waiting for events...</div>';
        } else {
          feedEl.innerHTML = activity.map(a => {
            const isNew = a.id > lastActivityId;
            const cls = a.level === 'error' ? 'error-row' : isNew ? 'fill-row' : '';
            return '<div class="flex gap-2 py-1 px-2 rounded ' + cls + '">' +
              '<span class="text-gray-600 shrink-0 w-16">' + timeAgo(a.timestamp) + '</span>' +
              typeBadge(a.type) +
              '<span class="text-gray-300 truncate">' + (a.detail || '').replace(/"/g, '') + '</span>' +
              '</div>';
          }).join('');
          if (activity.length > 0) lastActivityId = Math.max(...activity.map(a => a.id));
        }
        } // end feedChanged
      } catch (err) {
        document.getElementById('connection-status').textContent = 'ERROR';
        document.getElementById('connection-status').className = 'badge badge-red';
      }
    }

    // Refresh every 2s
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}

function getCompareHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reaper — vs Bonereaper</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; background: #0a0a0a; color: #e0e0e0; }
    .card { background: #141414; border: 1px solid #2a2a2a; border-radius: 8px; padding: 16px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .badge-green { background: #1a3a1a; color: #4ade80; }
    .badge-red { background: #3a1a1a; color: #f87171; }
    .badge-blue { background: #1a1a3a; color: #60a5fa; }
    .badge-yellow { background: #3a3a1a; color: #fbbf24; }
    .badge-gray { background: #2a2a2a; color: #9ca3af; }
    .mono { font-family: 'SF Mono', 'Fira Code', monospace; }

    /* Tooltip */
    .tt { cursor: help; }
    #floating-tip {
      position: fixed; background: #1f2937; color: #e5e7eb; padding: 8px 12px;
      border-radius: 6px; border: 1px solid #374151; font-size: 11px; line-height: 1.4;
      max-width: 320px; box-shadow: 0 4px 12px rgba(0,0,0,0.6);
      opacity: 0; pointer-events: none; transition: opacity 0.12s; z-index: 10000;
    }
    #floating-tip.visible { opacity: 1; }

    /* Side-by-side panels */
    .side-ours { border-left: 3px solid #3b82f6; }
    .side-shadow { border-left: 3px solid #8b5cf6; }

    /* Compare row hover */
    .win-row { cursor: pointer; transition: background 0.15s; }
    .win-row:hover { background: #1a1a1a; }

    /* Mini bar for relative comparison */
    .mini-bar { display: inline-block; height: 4px; background: #374151; border-radius: 2px; vertical-align: middle; }

    /* Modal */
    #detail-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.75);
      display: none; align-items: center; justify-content: center;
      z-index: 1000; padding: 20px;
    }
    #detail-overlay.visible { display: flex; }
    #detail-modal {
      background: #0a0a0a; border: 1px solid #2a2a2a; border-radius: 10px;
      width: 100%; max-width: 1400px; max-height: 92vh;
      overflow-y: auto; padding: 20px;
    }

    /* Diff colors */
    .diff-better { color: #4ade80; }
    .diff-worse { color: #f87171; }
    .diff-neutral { color: #9ca3af; }
  </style>
</head>
<body class="p-4 max-w-[1600px] mx-auto">
  <div id="floating-tip"></div>

  <div id="detail-overlay" onclick="if(event.target.id==='detail-overlay')closeDetail()">
    <div id="detail-modal">
      <div id="detail-content">Loading...</div>
    </div>
  </div>

  <!-- Header + nav -->
  <div class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-6">
      <div>
        <h1 class="text-2xl font-bold text-white">Reaper</h1>
        <p class="text-sm text-gray-500">vs Bonereaper — side-by-side analysis</p>
      </div>
      <nav class="flex gap-3 text-sm">
        <a href="/" class="text-gray-400 hover:text-white pb-1">Dashboard</a>
        <a href="/compare" class="text-blue-400 hover:text-blue-300 border-b-2 border-blue-400 pb-1">vs Bonereaper</a>
        <a href="/analysis" class="text-gray-400 hover:text-white pb-1">Analysis</a>
        <a href="/strategies" class="text-gray-400 hover:text-white pb-1">Strategies</a>
      </nav>
    </div>
    <div class="text-xs text-gray-500" id="last-updated">—</div>
  </div>

  <!-- Summary cards: US (left) | BR (right) -->
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
    <div class="card side-ours">
      <div class="flex justify-between items-center mb-3">
        <h2 class="text-sm font-bold text-blue-400 uppercase tracking-wide">Ours</h2>
        <span class="text-[10px] text-gray-500" id="ours-windows">0 windows</span>
      </div>
      <div class="grid grid-cols-3 gap-3 text-xs" id="ours-summary">
        <div class="tt" data-tip="Total dollars spent buying tokens across all windows"><div class="text-gray-500">Bought</div><div class="text-xl text-white" id="ours-bought">$0</div></div>
        <div class="tt" data-tip="Total dollars received from selling/merging/redeeming"><div class="text-gray-500">Earned</div><div class="text-xl text-green-400" id="ours-earned">$0</div></div>
        <div class="tt" data-tip="Net P&L = earned - bought + unrealized redemption value"><div class="text-gray-500">Net P&L</div><div class="text-xl" id="ours-pnl">$0</div></div>
        <div class="tt" data-tip="Total number of fills (buy + sell)"><div class="text-gray-500">Fills</div><div class="text-lg text-white" id="ours-fills">0</div></div>
        <div class="tt" data-tip="Volume-weighted average pair cost across all paired positions. <$1 is profitable."><div class="text-gray-500">Avg Pair Cost</div><div class="text-lg" id="ours-pc">—</div></div>
        <div class="tt" data-tip="Win rate = windows with positive P&L / total resolved windows"><div class="text-gray-500">Win Rate</div><div class="text-lg" id="ours-winrate">—</div></div>
      </div>
    </div>

    <div class="card side-shadow">
      <div class="flex justify-between items-center mb-3">
        <h2 class="text-sm font-bold text-purple-400 uppercase tracking-wide">Bonereaper</h2>
        <span class="text-[10px] text-gray-500" id="shadow-windows">0 windows</span>
      </div>
      <div class="grid grid-cols-3 gap-3 text-xs" id="shadow-summary">
        <div class="tt" data-tip="Total dollars BR spent buying tokens in windows we also track"><div class="text-gray-500">Bought</div><div class="text-xl text-white" id="shadow-bought">$0</div></div>
        <div class="tt" data-tip="Total dollars BR received from selling/merging"><div class="text-gray-500">Earned</div><div class="text-xl text-green-400" id="shadow-earned">$0</div></div>
        <div class="tt" data-tip="BR's estimated net (sells - buys). Does not include unredeemed positions."><div class="text-gray-500">Net (est)</div><div class="text-xl" id="shadow-pnl">$0</div></div>
        <div class="tt" data-tip="Total number of BR trades detected in these windows"><div class="text-gray-500">Trades</div><div class="text-lg text-white" id="shadow-fills">0</div></div>
        <div class="tt" data-tip="Volume-weighted avg pair cost based on BR's buys"><div class="text-gray-500">Avg Pair Cost</div><div class="text-lg" id="shadow-pc">—</div></div>
        <div class="tt" data-tip="Windows BR participated in but we did not"><div class="text-gray-500">We Missed</div><div class="text-lg text-yellow-400" id="we-missed">0</div></div>
      </div>
    </div>
  </div>

  <!-- Overlap stats -->
  <div class="card mb-4">
    <div class="grid grid-cols-4 gap-3 text-xs">
      <div class="tt" data-tip="Windows where BOTH we and BR traded"><div class="text-gray-500">Both Participated</div><div class="text-lg text-white" id="both-participated">0</div></div>
      <div class="tt" data-tip="Windows where only we traded (BR didn't)"><div class="text-gray-500">We Only</div><div class="text-lg text-blue-400" id="we-only">0</div></div>
      <div class="tt" data-tip="Windows where only BR traded (we missed)"><div class="text-gray-500">Shadow Only</div><div class="text-lg text-purple-400" id="shadow-only">0</div></div>
      <div class="tt" data-tip="Total windows included in this analysis"><div class="text-gray-500">Total Windows</div><div class="text-lg text-white" id="total-windows">0</div></div>
    </div>
  </div>

  <!-- Per-window table -->
  <div class="card">
    <div class="flex justify-between items-center mb-3">
      <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide">Per-Window Comparison</h2>
      <div class="flex gap-2 text-xs items-center">
        <span class="text-gray-500">Filter:</span>
        <select id="filter-participation" class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs">
          <option value="all">All windows</option>
          <option value="both">Both participated</option>
          <option value="we_only">We only</option>
          <option value="shadow_only">Shadow only</option>
          <option value="we_missed">We missed</option>
        </select>
        <select id="filter-status" class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs">
          <option value="all">Any status</option>
          <option value="RESOLVED">Resolved</option>
          <option value="ACTIVE">Active</option>
          <option value="RESOLVING">Resolving</option>
        </select>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-[11px] mono" id="compare-table">
        <thead>
          <tr class="text-gray-500 text-left border-b border-gray-800">
            <th class="py-1 pr-2">Window</th>
            <th class="py-1 pr-2">Status</th>
            <th class="py-1 pr-2 text-right" data-tip="Our fills / BR trades">Fills</th>
            <th class="py-1 pr-2 text-right" data-tip="USD spent buying">Bought $</th>
            <th class="py-1 pr-2 text-right" data-tip="USD received selling">Sold $</th>
            <th class="py-1 pr-2 text-right" data-tip="Volume-weighted pair cost">PC</th>
            <th class="py-1 pr-2 text-right" data-tip="Seconds after window open of first buy">1st Buy</th>
            <th class="py-1 pr-2 text-right" data-tip="Net P&L (ours) / Sell-Buy (BR)">Net $</th>
          </tr>
        </thead>
        <tbody id="compare-tbody"></tbody>
      </table>
    </div>
  </div>

  <script>
    // Floating tooltip
    const tipEl = document.getElementById('floating-tip');
    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest('[data-tip]');
      if (!target) return;
      const tip = target.getAttribute('data-tip');
      if (!tip) return;
      tipEl.textContent = tip;
      tipEl.classList.add('visible');
      const r = target.getBoundingClientRect();
      const tr = tipEl.getBoundingClientRect();
      let top = r.top - tr.height - 8;
      let left = r.left + r.width / 2 - tr.width / 2;
      if (top < 8) top = r.bottom + 8;
      if (left < 8) left = 8;
      if (left + tr.width > window.innerWidth - 8) left = window.innerWidth - tr.width - 8;
      tipEl.style.top = top + 'px';
      tipEl.style.left = left + 'px';
    });
    document.addEventListener('mouseout', (e) => {
      if (!e.target.closest || !e.target.closest('[data-tip]')) return;
      tipEl.classList.remove('visible');
    });

    function fmtUsd(n, decimals) { if (n == null) return '—'; const d = decimals == null ? 2 : decimals; const s = Math.abs(n).toFixed(d); return (n < 0 ? '-$' : '$') + s; }
    function fmtPct(n) { return n == null ? '—' : (n*100).toFixed(0) + '%'; }
    function fmtSec(s) { return s == null ? '—' : s + 's'; }
    function fmtPC(p) { if (p == null) return '—'; const cls = p < 1.0 ? 'text-green-400' : 'text-red-400'; return '<span class="' + cls + '">$' + p.toFixed(3) + '</span>'; }

    let cachedWindows = [];

    async function loadAll() {
      const [summary, windows] = await Promise.all([
        fetch('/api/compare/summary').then(r => r.json()),
        fetch('/api/compare/windows?limit=200').then(r => r.json()),
      ]);
      cachedWindows = windows;
      renderSummary(summary);
      renderTable(windows);
      document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    }

    function renderSummary(s) {
      const t = s.totals || {};
      const ours = t.ours || {};
      const shadow = t.shadow || {};
      const overlap = t.overlap || {};

      document.getElementById('ours-windows').textContent = ours.windows_participated + ' windows';
      document.getElementById('ours-bought').textContent = fmtUsd(ours.total_buy_usd);
      document.getElementById('ours-earned').textContent = fmtUsd(ours.total_sell_usd);
      const pnlEl = document.getElementById('ours-pnl');
      pnlEl.textContent = fmtUsd(ours.total_pnl);
      pnlEl.className = 'text-xl ' + (ours.total_pnl >= 0 ? 'text-green-400' : 'text-red-400');
      document.getElementById('ours-fills').textContent = ours.total_fills;
      document.getElementById('ours-pc').innerHTML = fmtPC(ours.avg_pair_cost_weighted || null);
      const total = (ours.wins || 0) + (ours.losses || 0);
      document.getElementById('ours-winrate').textContent = total > 0 ? fmtPct(ours.wins/total) + ' (' + ours.wins + '/' + total + ')' : '—';

      document.getElementById('shadow-windows').textContent = shadow.windows_participated + ' windows';
      document.getElementById('shadow-bought').textContent = fmtUsd(shadow.total_buy_usd);
      document.getElementById('shadow-earned').textContent = fmtUsd(shadow.total_sell_usd);
      const sPnlEl = document.getElementById('shadow-pnl');
      sPnlEl.textContent = fmtUsd(shadow.total_pnl);
      sPnlEl.className = 'text-xl ' + (shadow.total_pnl >= 0 ? 'text-green-400' : 'text-red-400');
      document.getElementById('shadow-fills').textContent = shadow.total_fills;
      document.getElementById('shadow-pc').innerHTML = fmtPC(shadow.avg_pair_cost_weighted || null);
      document.getElementById('we-missed').textContent = overlap.we_missed_windows;

      document.getElementById('both-participated').textContent = overlap.both_participated;
      document.getElementById('we-only').textContent = overlap.we_only;
      document.getElementById('shadow-only').textContent = overlap.shadow_only;
      document.getElementById('total-windows').textContent = s.window_count || 0;
    }

    function renderTable(windows) {
      const fp = document.getElementById('filter-participation').value;
      const fs = document.getElementById('filter-status').value;
      const filtered = windows.filter(w => {
        const hasOurs = w.ours.fill_count > 0;
        const hasShadow = w.shadow.fill_count > 0;
        if (fp === 'both' && !(hasOurs && hasShadow)) return false;
        if (fp === 'we_only' && !(hasOurs && !hasShadow)) return false;
        if (fp === 'shadow_only' && !(!hasOurs && hasShadow)) return false;
        if (fp === 'we_missed' && !(!hasOurs && hasShadow)) return false;
        if (fs !== 'all' && w.status !== fs) return false;
        return true;
      });

      const tbody = document.getElementById('compare-tbody');
      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-gray-600 py-6">No windows match</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(w => {
        const title = (w.title || w.slug || '').slice(-28);
        const statusColor = w.status === 'RESOLVED' ? 'gray' : w.status === 'ACTIVE' ? 'green' : 'yellow';
        const outcomeBadge = w.outcome ? '<span class="badge badge-' + (w.outcome === 'UP' ? 'green' : 'red') + ' ml-1">' + w.outcome + '</span>' : '';

        // Two-row structure per window: OURS on top, BR on bottom, so apples-to-apples
        const mkCells = (side, label, labelColor) => {
          const empty = side.fill_count === 0;
          return '<td class="py-0.5 pr-2 text-' + labelColor + '-400 text-[9px]">' + label + '</td>' +
            '<td class="py-0.5 pr-2 text-right">' + (empty ? '—' : side.fill_count) + '</td>' +
            '<td class="py-0.5 pr-2 text-right">' + (empty ? '—' : fmtUsd(side.total_buy_usd)) + '</td>' +
            '<td class="py-0.5 pr-2 text-right">' + (empty ? '—' : fmtUsd(side.total_sell_usd)) + '</td>' +
            '<td class="py-0.5 pr-2 text-right">' + (empty ? '—' : fmtPC(side.pair_cost)) + '</td>' +
            '<td class="py-0.5 pr-2 text-right">' + (empty ? '—' : fmtSec(side.first_buy_sec)) + '</td>' +
            '<td class="py-0.5 pr-2 text-right ' + (side.net_pnl == null ? 'text-gray-500' : side.net_pnl >= 0 ? 'text-green-400' : 'text-red-400') + '">' + (side.net_pnl == null ? '—' : fmtUsd(side.net_pnl)) + '</td>';
        };

        return '<tr class="win-row border-b border-gray-900" onclick="openDetail(\\'' + w.slug + '\\')">' +
          '<td rowspan="2" class="py-1 pr-2 align-top"><div class="text-gray-300">' + title + '</div><div class="text-[9px] text-gray-600">' + w.duration_min + 'min</div></td>' +
          '<td rowspan="2" class="py-1 pr-2 align-top"><span class="badge badge-' + statusColor + '">' + w.status + '</span>' + outcomeBadge + '</td>' +
          mkCells(w.ours, 'Ours', 'blue') +
        '</tr>' +
        '<tr class="win-row border-b border-gray-800" onclick="openDetail(\\'' + w.slug + '\\')">' +
          mkCells(w.shadow, 'BR', 'purple') +
        '</tr>';
      }).join('');
    }

    document.getElementById('filter-participation').onchange = () => renderTable(cachedWindows);
    document.getElementById('filter-status').onchange = () => renderTable(cachedWindows);

    // ── Detail overlay ────────────────────────────────────────────
    async function openDetail(slug) {
      const overlay = document.getElementById('detail-overlay');
      overlay.classList.add('visible');
      document.getElementById('detail-content').innerHTML = '<div class="text-gray-400 p-8 text-center">Loading…</div>';
      const d = await fetch('/api/compare/window/' + encodeURIComponent(slug)).then(r => r.json());
      renderDetail(d);
    }
    function closeDetail() { document.getElementById('detail-overlay').classList.remove('visible'); }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

    function renderDetail(d) {
      if (d.error) { document.getElementById('detail-content').innerHTML = '<div class="text-red-400">' + d.error + '</div>'; return; }
      const w = d.window;
      const o = d.ours;
      const s = d.shadow;
      const chart = renderComparisonChart(d);

      const row = (label, oval, sval, tip) => {
        return '<tr class="border-b border-gray-900">' +
          '<td class="py-1 pr-3 text-gray-500 text-xs tt" data-tip="' + (tip||label) + '">' + label + '</td>' +
          '<td class="py-1 pr-3 text-right text-blue-300 mono">' + oval + '</td>' +
          '<td class="py-1 pr-3 text-right text-purple-300 mono">' + sval + '</td>' +
        '</tr>';
      };

      document.getElementById('detail-content').innerHTML =
        '<div class="flex justify-between items-start mb-4">' +
          '<div>' +
            '<div class="text-xl font-bold text-white">' + (w.title || w.slug) + '</div>' +
            '<div class="text-[10px] text-gray-500 mono">' + w.slug + ' · ' + new Date(w.open_time).toLocaleString() + '</div>' +
          '</div>' +
          '<button onclick="closeDetail()" class="text-gray-400 hover:text-white text-2xl leading-none">×</button>' +
        '</div>' +

        '<div class="card mb-4">' +
          '<div class="text-xs font-bold text-gray-400 uppercase mb-2">Timeline — Ours vs Bonereaper</div>' +
          chart +
        '</div>' +

        '<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">' +
          '<div class="card">' +
            '<table class="w-full text-xs">' +
              '<thead><tr class="text-gray-500 border-b border-gray-800"><th class="text-left py-1">Stat</th><th class="text-right text-blue-400 py-1">Ours</th><th class="text-right text-purple-400 py-1">BR</th></tr></thead>' +
              '<tbody>' +
                row('Fills', o.fill_count, s.fill_count, 'Total fills') +
                row('Buys', o.buy_count, s.buy_count, 'Buy-side fills') +
                row('Sells', o.sell_count, s.sell_count, 'Sell-side fills') +
                row('Bought $', fmtUsd(o.total_buy_usd), fmtUsd(s.total_buy_usd), 'Dollars spent buying') +
                row('Sold $', fmtUsd(o.total_sell_usd), fmtUsd(s.total_sell_usd), 'Dollars received selling') +
                row('UP avg px', fmtUsd(o.avg_up_price, 3), fmtUsd(s.avg_up_price, 3), 'Volume-weighted avg UP fill price') +
                row('DOWN avg px', fmtUsd(o.avg_dn_price, 3), fmtUsd(s.avg_dn_price, 3), 'Volume-weighted avg DOWN fill price') +
                row('UP tokens', o.up_tokens.toFixed(0), s.up_tokens.toFixed(0), 'UP tokens held (buys - sells)') +
                row('DOWN tokens', o.dn_tokens.toFixed(0), s.dn_tokens.toFixed(0), 'DOWN tokens held (buys - sells)') +
                row('Pair Cost', fmtPC(o.pair_cost), fmtPC(s.pair_cost), 'Avg UP + avg DOWN. <$1 is profitable.') +
                row('1st Buy', fmtSec(o.first_buy_sec), fmtSec(s.first_buy_sec), 'Seconds after window open of first buy (lower = earlier)') +
                row('Last Buy', fmtSec(o.last_buy_sec), fmtSec(s.last_buy_sec), 'Seconds after window open of last buy') +
                row('Net P&L', (o.net_pnl==null?'—':fmtUsd(o.net_pnl)), (s.net_pnl==null?'—':fmtUsd(s.net_pnl)), 'Net: ours from DB, BR estimated from sells-buys') +
              '</tbody>' +
            '</table>' +
          '</div>' +
          '<div class="card">' +
            '<div class="text-xs font-bold text-gray-400 uppercase mb-2">All Trades (interleaved timeline)</div>' +
            renderInterleavedTrades(d) +
          '</div>' +
        '</div>';
    }

    function renderComparisonChart(d) {
      const w = d.window;
      const ticks = d.ticks || [];
      const fills = d.fills || [];
      const shadowTrades = d.shadow_trades || [];
      const chartW = 1300, chartH = 280;
      const pad = { l: 50, r: 20, t: 16, b: 24 };
      const cw = chartW - pad.l - pad.r;
      const ch = chartH - pad.t - pad.b;

      const t0 = w.open_time;
      const tN = Math.min(w.end_time, Math.max(t0 + 60000, ...(ticks.length?ticks.map(t=>t.timestamp):[t0]), ...shadowTrades.map(t=>t.timestamp), ...fills.map(f => new Date(f.created_at + 'Z').getTime())));
      const dt = (tN - t0) || 1;
      const xAt = (ts) => pad.l + ((ts - t0) / dt) * cw;
      const yAt = (p) => pad.t + (1 - p) * ch;

      const buildPath = (ticks, getter) => {
        const pts = [];
        let first = true;
        for (const t of ticks) {
          const v = getter(t);
          if (v == null) { first = true; continue; }
          pts.push((first ? 'M' : 'L') + xAt(t.timestamp).toFixed(1) + ',' + yAt(v).toFixed(1));
          first = false;
        }
        return pts.join(' ');
      };

      const upLast = buildPath(ticks, t => t.up_last_trade);
      const dnLast = buildPath(ticks, t => t.dn_last_trade);
      const pTrue = buildPath(ticks, t => t.p_true);

      // Our fills — solid circles
      const ourMarks = fills.map(f => {
        const ts = new Date(f.created_at + 'Z').getTime();
        const x = xAt(ts), y = yAt(f.price);
        const color = f.side === 'UP' ? '#3b82f6' : '#60a5fa';  // blue family for OUR fills
        const tip = 'OUR ' + f.side + ': ' + f.size + ' @ $' + f.price.toFixed(3) + ' [' + f.source + ']';
        return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="5" fill="' + color + '" stroke="#0a0a0a" stroke-width="1.5" data-tip="' + tip + '"/>';
      }).join('');

      // BR trades — diamonds, purple for buys, orange for sells
      const brMarks = shadowTrades.map(t => {
        const x = xAt(t.timestamp), y = yAt(t.price);
        const color = t.buy_sell === 'BUY' ? '#a855f7' : '#f97316';
        const tip = 'BR ' + t.buy_sell + ' ' + t.side + ': ' + Number(t.size).toFixed(0) + ' @ $' + Number(t.price).toFixed(3);
        return '<rect x="' + (x-5).toFixed(1) + '" y="' + (y-5).toFixed(1) + '" width="10" height="10" fill="none" stroke="' + color + '" stroke-width="1.8" transform="rotate(45 ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')" data-tip="' + tip + '"/>';
      }).join('');

      // y-axis grid
      const yGrid = [0, 0.25, 0.5, 0.75, 1].map(v => {
        const y = pad.t + (1 - v) * ch;
        return '<line x1="' + pad.l + '" x2="' + (chartW - pad.r) + '" y1="' + y + '" y2="' + y + '" stroke="#1f2937" stroke-width="0.5"/>' +
          '<text x="' + (pad.l - 5) + '" y="' + (y + 3) + '" fill="#6b7280" font-size="9" text-anchor="end">$' + v.toFixed(2) + '</text>';
      }).join('');

      return '<svg width="100%" viewBox="0 0 ' + chartW + ' ' + chartH + '" style="max-height: 280px;">' +
        yGrid +
        '<path d="' + pTrue + '" fill="none" stroke="#8b5cf6" stroke-width="1" stroke-dasharray="3,3" opacity="0.6"/>' +
        '<path d="' + upLast + '" fill="none" stroke="#4ade80" stroke-width="1.6"/>' +
        '<path d="' + dnLast + '" fill="none" stroke="#f87171" stroke-width="1.6"/>' +
        brMarks +
        ourMarks +
        '<g transform="translate(' + (pad.l + 10) + ', 14)" font-size="10" fill="#9ca3af">' +
          '<circle cx="4" cy="0" r="4" fill="#3b82f6" stroke="#0a0a0a"/>' +
          '<text x="14" y="3">Ours (' + fills.length + ')</text>' +
          '<rect x="90" y="-4" width="10" height="10" fill="none" stroke="#a855f7" stroke-width="1.8" transform="rotate(45 95 0)"/>' +
          '<text x="108" y="3">BR buy</text>' +
          '<rect x="170" y="-4" width="10" height="10" fill="none" stroke="#f97316" stroke-width="1.8" transform="rotate(45 175 0)"/>' +
          '<text x="188" y="3">BR sell (' + shadowTrades.length + ')</text>' +
          '<line x1="290" x2="306" y1="0" y2="0" stroke="#4ade80" stroke-width="2"/>' +
          '<text x="310" y="3">UP last</text>' +
          '<line x1="370" x2="386" y1="0" y2="0" stroke="#f87171" stroke-width="2"/>' +
          '<text x="390" y="3">DOWN last</text>' +
          '<line x1="460" x2="476" y1="0" y2="0" stroke="#8b5cf6" stroke-dasharray="3,3"/>' +
          '<text x="480" y="3">P_true</text>' +
        '</g>' +
        '</svg>';
    }

    function renderInterleavedTrades(d) {
      const w = d.window;
      const all = [];
      for (const f of (d.fills || [])) all.push({ who: 'US', side: f.side, buySell: 'BUY', price: f.price, size: f.size, ts: new Date(f.created_at + 'Z').getTime(), source: f.source });
      for (const t of (d.shadow_trades || [])) all.push({ who: 'BR', side: t.side, buySell: t.buy_sell, price: t.price, size: t.size, ts: t.timestamp, source: '' });
      all.sort((a, b) => a.ts - b.ts);
      if (all.length === 0) return '<div class="text-gray-600 text-xs">no trades</div>';
      return '<div class="max-h-96 overflow-y-auto"><table class="w-full text-[10px] mono">' +
        '<thead><tr class="text-gray-500 border-b border-gray-800 sticky top-0 bg-[#141414]"><th class="text-left">Who</th><th class="text-left">+t</th><th class="text-left">Side</th><th class="text-left">B/S</th><th class="text-right">Price</th><th class="text-right">Size</th></tr></thead>' +
        '<tbody>' +
        all.map(t => {
          const dt = Math.floor((t.ts - w.open_time) / 1000);
          const whoColor = t.who === 'US' ? 'text-blue-400' : 'text-purple-400';
          const sideColor = t.side === 'UP' ? 'text-green-400' : t.side === 'DOWN' ? 'text-red-400' : 'text-gray-400';
          const bsColor = t.buySell === 'BUY' ? 'text-white' : 'text-orange-400';
          return '<tr class="border-b border-gray-900"><td class="' + whoColor + ' font-bold">' + t.who + '</td><td class="text-gray-500">' + dt + 's</td><td class="' + sideColor + '">' + t.side + '</td><td class="' + bsColor + '">' + t.buySell + '</td><td class="text-right">$' + Number(t.price).toFixed(3) + '</td><td class="text-right">' + Number(t.size).toFixed(0) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
    }

    loadAll();
    setInterval(loadAll, 5000);
  </script>
</body>
</html>`;
}

function commonHeadAndNav(title: string, active: string): string {
  const navLink = (href: string, label: string, id: string) => {
    const cls = id === active
      ? 'text-blue-400 hover:text-blue-300 border-b-2 border-blue-400 pb-1'
      : 'text-gray-400 hover:text-white pb-1';
    return `<a href="${href}" class="${cls}">${label}</a>`;
  };
  return `<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reaper — ${title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; background: #0a0a0a; color: #e0e0e0; }
    .card { background: #141414; border: 1px solid #2a2a2a; border-radius: 8px; padding: 16px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .badge-green { background: #1a3a1a; color: #4ade80; }
    .badge-red { background: #3a1a1a; color: #f87171; }
    .badge-blue { background: #1a1a3a; color: #60a5fa; }
    .badge-yellow { background: #3a3a1a; color: #fbbf24; }
    .badge-gray { background: #2a2a2a; color: #9ca3af; }
    .badge-purple { background: #2a1a3a; color: #c084fc; }
    .mono { font-family: 'SF Mono', 'Fira Code', monospace; }
    .tt { cursor: help; }
    #floating-tip {
      position: fixed; background: #1f2937; color: #e5e7eb; padding: 8px 12px;
      border-radius: 6px; border: 1px solid #374151; font-size: 11px; line-height: 1.4;
      max-width: 320px; box-shadow: 0 4px 12px rgba(0,0,0,0.6);
      opacity: 0; pointer-events: none; transition: opacity 0.12s; z-index: 10000;
    }
    #floating-tip.visible { opacity: 1; }
  </style>
</head>
<body class="p-4 max-w-[1600px] mx-auto">
  <div id="floating-tip"></div>
  <div class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-6">
      <div>
        <h1 class="text-2xl font-bold text-white">Reaper</h1>
        <p class="text-sm text-gray-500">${title}</p>
      </div>
      <nav class="flex gap-3 text-sm">
        ${navLink('/', 'Dashboard', 'dashboard')}
        ${navLink('/compare', 'vs Bonereaper', 'compare')}
        ${navLink('/analysis', 'Analysis', 'analysis')}
        ${navLink('/strategies', 'Strategies', 'strategies')}
      </nav>
    </div>
  </div>
  <script>
    const tipEl = document.getElementById('floating-tip');
    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest('[data-tip]');
      if (!target) return;
      const tip = target.getAttribute('data-tip');
      if (!tip) return;
      tipEl.textContent = tip; tipEl.classList.add('visible');
      const r = target.getBoundingClientRect(), tr = tipEl.getBoundingClientRect();
      let top = r.top - tr.height - 8, left = r.left + r.width/2 - tr.width/2;
      if (top < 8) top = r.bottom + 8;
      if (left < 8) left = 8;
      if (left + tr.width > window.innerWidth - 8) left = window.innerWidth - tr.width - 8;
      tipEl.style.top = top + 'px'; tipEl.style.left = left + 'px';
    });
    document.addEventListener('mouseout', (e) => {
      if (!e.target.closest || !e.target.closest('[data-tip]')) return;
      tipEl.classList.remove('visible');
    });
  </script>`;
}

function getStrategiesHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
${commonHeadAndNav('Bid Strategy Plugins', 'strategies')}

  <!-- Active strategy card -->
  <div class="card mb-4">
    <div class="flex justify-between items-center mb-3">
      <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide">Active Strategy</h2>
      <span id="mode-badge" class="badge badge-yellow">paper</span>
    </div>
    <div class="flex items-center gap-4">
      <div>
        <div class="text-xs text-gray-500">Currently running</div>
        <div class="text-2xl font-bold text-blue-400" id="active-strategy">—</div>
      </div>
      <div class="text-xs text-gray-500 max-w-xl" id="active-description">—</div>
    </div>
  </div>

  <!-- Strategy list -->
  <div class="card">
    <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3" data-tip="All registered bid strategies. Click 'Activate' to switch.">Available Strategies</h2>
    <div id="strategy-list" class="space-y-2">Loading…</div>
  </div>

  <!-- Comparison + info -->
  <div class="card mt-4">
    <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3">Quick Reference</h2>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
      <div class="p-3 rounded bg-gray-900 border border-gray-800">
        <div class="text-blue-400 font-bold mb-1">How plugins work</div>
        <div class="text-gray-400">Each strategy implements <code class="text-green-400">BidStrategy</code> in <code class="text-green-400">src/strategies/</code>. Every tick, the engine calls <code class="text-green-400">strategy.compute(ctx)</code> with full market state and inventory, and the strategy returns a list of bid levels.</div>
      </div>
      <div class="p-3 rounded bg-gray-900 border border-gray-800">
        <div class="text-blue-400 font-bold mb-1">Adding a new strategy</div>
        <div class="text-gray-400">1) Create <code class="text-green-400">src/strategies/my-strategy.ts</code><br/>2) Implement <code class="text-green-400">BidStrategy</code> interface<br/>3) Register in <code class="text-green-400">src/strategies/index.ts</code><br/>4) Restart; appears here.</div>
      </div>
      <div class="p-3 rounded bg-gray-900 border border-gray-800">
        <div class="text-blue-400 font-bold mb-1">Backtest before activating</div>
        <div class="text-gray-400">Visit <a href="/analysis" class="text-blue-400 underline">Analysis</a> to run a backtest of any strategy against historical data before making it live. Includes capital sweep to find minimum viable budget.</div>
      </div>
    </div>
  </div>

  <script>
    async function loadStrategies() {
      const data = await fetch('/api/strategies').then(r => r.json());
      const active = data.active;
      const status = await fetch('/api/status').then(r => r.json());

      // Mode badge
      const modeBadge = document.getElementById('mode-badge');
      modeBadge.textContent = (status.mode || 'paper').toUpperCase();
      modeBadge.className = 'badge ' + (status.mode === 'real' ? 'badge-green' : 'badge-yellow');

      // Active strategy
      const activeMeta = data.strategies.find(s => s.name === active);
      document.getElementById('active-strategy').textContent = active;
      document.getElementById('active-description').textContent = activeMeta?.description || '—';

      // List
      const listEl = document.getElementById('strategy-list');
      listEl.innerHTML = data.strategies.map(s => {
        const isActive = s.name === active;
        const btn = isActive
          ? '<span class="badge badge-green">ACTIVE</span>'
          : '<button onclick="activate(\\'' + s.name + '\\')" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs">Activate</button>';
        return '<div class="p-3 rounded bg-gray-900 border ' + (isActive ? 'border-blue-500' : 'border-gray-800') + ' flex justify-between items-center">' +
          '<div class="flex-1">' +
            '<div class="flex items-center gap-2 mb-1">' +
              '<span class="text-lg font-bold ' + (isActive ? 'text-blue-400' : 'text-white') + '">' + s.name + '</span>' +
              '<span class="text-[10px] text-gray-600 mono">src/strategies/' + s.name.replace(/bonereaper-/, 'bonereaper-').replace('hybrid', 'hybrid') + '.ts</span>' +
            '</div>' +
            '<div class="text-xs text-gray-400">' + s.description + '</div>' +
          '</div>' +
          '<div class="shrink-0 ml-4">' + btn + '</div>' +
        '</div>';
      }).join('');
    }

    async function activate(name) {
      if (!confirm('Switch to strategy "' + name + '"? The engine will use it on the next tick.')) return;
      const r = await fetch('/api/strategies/active', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const d = await r.json();
      if (d.status === 'updated') loadStrategies();
      else alert('Failed: ' + (d.error || 'unknown'));
    }

    loadStrategies();
    setInterval(loadStrategies, 5000);
  </script>
</body>
</html>`;
}

function getAnalysisHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
${commonHeadAndNav('Backtest + BR Analysis', 'analysis')}

  <!-- Backtest controls -->
  <div class="card mb-4">
    <div class="flex justify-between items-center mb-3">
      <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide tt" data-tip="Simulates each bid strategy against recorded historical data (window_ticks + shadow_trades). Uses a shadow-fill model: if our bid ≥ BR's actual fill price, we 'would have gotten' that fill. Output shows P&L, fill counts, capital usage per strategy.">Strategy Backtest</h2>
      <button id="run-btn" onclick="runBacktest()" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs">Run Backtest</button>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
      <div>
        <label class="text-gray-500 text-[10px] tt" data-tip="Starting capital for each strategy. Lower values reveal where a strategy becomes capital-constrained (shown as 'Skip' > 0 in results). Accepts comma-separated list to test multiple scenarios in one run.">Starting Capital ($)</label>
        <input id="capital" type="text" value="500,1000,5000" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs mt-1" placeholder="comma-separated, e.g. 500,1000,5000">
      </div>
      <div>
        <label class="text-gray-500 text-[10px] tt" data-tip="Merge paired positions mid-window when their combined avg cost ≤ this threshold. $1.00 = merge any profitable pair; $0.97 = more selective. Lower threshold = fewer merges but each is more profitable.">Merge Threshold</label>
        <input id="merge-pc" type="number" step="0.01" value="1.00" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs mt-1">
      </div>
      <div>
        <label class="text-gray-500 text-[10px] tt" data-tip="Only include RESOLVED windows (known outcome) for accurate P&L, or include ACTIVE/RESOLVING too (partial data).">Window Filter</label>
        <select id="resolved" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs mt-1">
          <option value="true" selected>Only resolved windows</option>
          <option value="false">All windows</option>
        </select>
      </div>
      <div>
        <label class="text-gray-500 text-[10px] tt" data-tip="Comma-separated strategy names to test (e.g. 'hybrid,bonereaper-mimic'). Leave blank to test all registered strategies.">Strategies</label>
        <input id="strategies" type="text" value="" placeholder="(all)" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs mt-1">
      </div>
    </div>
    <div id="backtest-status" class="text-xs text-gray-500 mt-2">—</div>
  </div>

  <!-- Backtest results per capital -->
  <div id="backtest-results"></div>

  <!-- BR patterns summary -->
  <div class="card mt-4">
    <div class="flex justify-between items-center mb-3">
      <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide tt" data-tip="Tick-aligned analysis of recorded Bonereaper trades. For each BR fill, we join to the nearest window_tick snapshot to reconstruct the market state BR saw at that moment. Then we bucket and summarize to extract decision patterns.">Bonereaper Patterns</h2>
      <button onclick="loadPatterns()" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs">Refresh</button>
    </div>
    <div id="br-patterns" class="text-xs">Loading…</div>
  </div>

  <script>
    function fmt(n, d) { const D = d == null ? 2 : d; return n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(D); }
    function fmtPct(n) { return n == null ? '—' : n.toFixed(0) + '%'; }

    async function runBacktest() {
      const btn = document.getElementById('run-btn');
      const statusEl = document.getElementById('backtest-status');
      btn.disabled = true; btn.textContent = 'Running…';
      statusEl.textContent = 'Running backtest…';

      const capVals = document.getElementById('capital').value.split(',').map(s => parseFloat(s.trim())).filter(v => !isNaN(v));
      const mergePc = parseFloat(document.getElementById('merge-pc').value);
      const onlyResolved = document.getElementById('resolved').value === 'true';
      const stratInput = document.getElementById('strategies').value.trim();
      const strategies = stratInput ? stratInput.split(',').map(s => s.trim()) : undefined;

      const resultsEl = document.getElementById('backtest-results');
      resultsEl.innerHTML = '';

      const allRuns = [];
      for (const cap of (capVals.length ? capVals : [null])) {
        const body = { only_resolved: onlyResolved, merge_threshold_pc: mergePc };
        if (cap != null) body.starting_capital = cap;
        if (strategies) body.strategies = strategies;
        const r = await fetch('/api/backtest', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        allRuns.push({ capital: cap, data });
      }

      resultsEl.innerHTML = allRuns.map(run => {
        const ref = run.data.br_reference || {};
        const rows = (run.data.summary || []).sort((a,b) => b.total_pnl - a.total_pnl);
        const capLabel = run.capital != null ? '$' + run.capital.toLocaleString() + ' capital' : 'Unlimited capital';
        return '<div class="card mb-3">' +
          '<div class="flex justify-between items-center mb-2">' +
          '<h3 class="text-sm font-bold text-white tt" data-tip="Each row shows one strategy simulated with this starting capital + merge threshold. Rows sorted by total P&L descending.">' + capLabel + '</h3>' +
          '<div class="text-[10px] text-gray-500 tt" data-tip="Reference: Bonereaper\\'s actual behavior across the same windows. Compare our strategies against this baseline.">BR ref: ' + ref.windows + ' windows, ' + ref.total_fills + ' fills, ' + fmt(ref.total_spend, 0) + '</div>' +
          '</div>' +
          '<table class="w-full text-[11px] mono">' +
          '<thead><tr class="text-gray-500 border-b border-gray-800">' +
          '<th class="text-left py-1">Strategy</th>' +
          '<th class="text-right py-1 tt" data-tip="Total simulated fills captured across all windows.">Fills</th>' +
          '<th class="text-right py-1 tt" data-tip="Fills we would have gotten but SKIPPED because starting capital ran out. If >0, the strategy is capital-constrained — increase starting capital to unlock more P&L.">Skip</th>' +
          '<th class="text-right py-1 tt" data-tip="Average number of fills per window (total_fills / windows).">Avg/W</th>' +
          '<th class="text-right py-1 tt" data-tip="Volume-weighted average pair cost = (UP avg + DOWN avg). Lower is better. Under $1.00 means profitable merges.">PC</th>' +
          '<th class="text-right py-1 tt" data-tip="Total cumulative dollars spent buying tokens across all windows. This is gross spend — does not subtract capital recycled via merges.">Spend</th>' +
          '<th class="text-right py-1 tt" data-tip="Total dollars returned through MID-WINDOW merges (pair_cost < threshold → redeem pair for $1 each). This is recycled capital that got spent again. The higher this is, the more efficiently the strategy reuses capital.">Mid-Merge $</th>' +
          '<th class="text-right py-1 tt" data-tip="AVERAGE per-window peak capital used. For each window, we compute (starting_capital - min_available_capital) — the high-water mark of capital tied up. Then we average across all windows. Answers: typically, how much capital does this strategy lock up at peak?">Avg Peak</th>' +
          '<th class="text-right py-1 tt" data-tip="MAXIMUM across all windows of the per-window peak. Answers: in the single worst window, what was the highest capital tied up? This is the capital you need to NEVER get capital-constrained on any observed window.">Worst Peak</th>' +
          '<th class="text-right py-1 tt" data-tip="Total simulated net P&L = merge profit + redeem profit - residual losses. Summed across all windows.">Total PnL</th>' +
          '<th class="text-right py-1 tt" data-tip="Percentage of windows where simulated net P&L > 0.">Win%</th>' +
          '</tr></thead><tbody>' +
          rows.map(s => {
            const pnlColor = s.total_pnl >= 0 ? 'text-green-400' : 'text-red-400';
            const skipColor = s.total_skipped_fills > 0 ? 'text-yellow-400' : 'text-gray-500';
            return '<tr class="border-b border-gray-900">' +
              '<td class="py-1 text-blue-300">' + s.strategy + '</td>' +
              '<td class="text-right">' + s.total_fills + '</td>' +
              '<td class="text-right ' + skipColor + '">' + s.total_skipped_fills + '</td>' +
              '<td class="text-right">' + s.avg_fills_per_window.toFixed(1) + '</td>' +
              '<td class="text-right">' + (s.avg_pair_cost != null ? '$' + s.avg_pair_cost.toFixed(3) : '—') + '</td>' +
              '<td class="text-right">' + fmt(s.total_spend, 0) + '</td>' +
              '<td class="text-right text-green-500">' + fmt(s.total_mid_merge_usd, 0) + '</td>' +
              '<td class="text-right">' + fmt(s.avg_peak_capital, 0) + '</td>' +
              '<td class="text-right">' + fmt(s.max_peak_capital, 0) + '</td>' +
              '<td class="text-right font-bold ' + pnlColor + '">' + fmt(s.total_pnl, 0) + '</td>' +
              '<td class="text-right">' + fmtPct(s.win_rate_pct) + '</td>' +
              '</tr>';
          }).join('') +
          '</tbody></table></div>';
      }).join('');

      statusEl.textContent = 'Backtest complete. ' + allRuns.length + ' capital scenario(s).';
      btn.disabled = false; btn.textContent = 'Run Backtest';
    }

    async function loadPatterns() {
      const el = document.getElementById('br-patterns');
      el.textContent = 'Loading…';
      const data = await fetch('/api/analysis/bonereaper').then(r => r.json());
      const ds = data.dataset;
      const sweeps = data.cheap_sweeps || {};
      const patterns = data.patterns || {};
      const entry = patterns.typical_entry_price_by_side_and_phase || {};

      let html = '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">';
      // Left: dataset + overall + phase
      html += '<div>';
      html += '<div class="mb-3"><div class="text-gray-500 text-[10px] uppercase mb-1 tt" data-tip="How much data this analysis is based on. Tick-match is the % of BR trades we could join to a nearby window_tick snapshot (for market-state context). Higher is better; below 50% means gaps in capture.">Dataset</div>' +
        '<div class="text-gray-300">' + ds.total_trades + ' trades joined, ' + ds.unique_windows + ' unique windows, ' +
        (ds.tick_match_coverage * 100).toFixed(1) + '% tick match, Δt ' + Math.round(ds.avg_tick_dt_ms) + 'ms avg</div></div>';

      html += '<div class="mb-3"><div class="text-gray-500 text-[10px] uppercase mb-1 tt" data-tip="Price distribution of BR BUY trades by side. Median/p10/p90 show the range of prices BR pays. Near-symmetric UP and DOWN medians confirm BR bids symmetrically — the apparent divergence comes from outcome (winning side trends up, losing side trends down over the window).">Overall buy distribution</div>' +
        '<table class="w-full text-[11px] mono"><thead><tr class="text-gray-500 border-b border-gray-800">' +
        '<th class="text-left tt" data-tip="UP or DOWN token side">Side</th>' +
        '<th class="text-right tt" data-tip="Number of trades in this group">n</th>' +
        '<th class="text-right tt" data-tip="Median (50th percentile) fill price">median</th>' +
        '<th class="text-right tt" data-tip="10th percentile fill price — 10% of fills were cheaper than this">p10</th>' +
        '<th class="text-right tt" data-tip="90th percentile fill price — 10% of fills were more expensive than this">p90</th>' +
        '<th class="text-right tt" data-tip="Average tokens per fill">avg size</th>' +
        '</tr></thead><tbody>';
      for (const side of ['UP', 'DOWN']) {
        const s = data.by_side[side];
        if (!s) continue;
        html += '<tr><td class="text-' + (side === 'UP' ? 'green' : 'red') + '-400">' + side + '</td>' +
          '<td class="text-right">' + s.n + '</td>' +
          '<td class="text-right">$' + s.median_price.toFixed(3) + '</td>' +
          '<td class="text-right">$' + s.p10_price.toFixed(3) + '</td>' +
          '<td class="text-right">$' + s.p90_price.toFixed(3) + '</td>' +
          '<td class="text-right">' + s.avg_size.toFixed(1) + '</td></tr>';
      }
      html += '</tbody></table></div>';

      html += '<div class="mb-3"><div class="text-gray-500 text-[10px] uppercase mb-1 tt" data-tip="BR median buy price by window phase (EARLY=0–33%, MID=33–66%, LATE=66–100% of window duration). Shows how BR bidding evolves: symmetric at open, winning side prices rise and losing side drops as certainty grows.">Entry price by phase</div>' +
        '<table class="w-full text-[11px] mono"><thead><tr class="text-gray-500 border-b border-gray-800">' +
        '<th class="text-left tt" data-tip="UP or DOWN token side">Side</th>' +
        '<th class="text-left tt" data-tip="Window phase based on elapsed time">Phase</th>' +
        '<th class="text-right tt" data-tip="Median BR buy price in this side+phase">Median</th>' +
        '<th class="text-right tt" data-tip="Number of BR trades in this group">n</th>' +
        '</tr></thead><tbody>';
      for (const [k, v] of Object.entries(entry)) {
        const [side, phase] = k.split('_');
        html += '<tr><td class="text-' + (side === 'UP' ? 'green' : 'red') + '-400">' + side + '</td>' +
          '<td>' + phase + '</td>' +
          '<td class="text-right">$' + v.median.toFixed(3) + '</td>' +
          '<td class="text-right">' + v.n + '</td></tr>';
      }
      html += '</tbody></table></div>';
      html += '</div>';

      // Right: cheap sweeps + price-vs-ask
      html += '<div>';
      html += '<div class="mb-3"><div class="text-gray-500 text-[10px] uppercase mb-1 tt" data-tip="Detected BR value buys: trades at price <$0.20 when market fair value on that side was >30pp higher. These represent BR catching dislocated asks (panic sellers) for near-arb profit. p50 price and elapsed show the typical sweep.">Cheap sweeps (BR opportunity buys)</div>' +
        '<div class="text-gray-300 mb-2 tt" data-tip="Total number of detected sweeps and $ value they spent.">' + sweeps.count + ' sweeps, $' + (sweeps.total_usd || 0).toFixed(0) + ' total spent</div>' +
        '<div class="text-gray-400 text-[10px] tt" data-tip="Distribution of sweep fill prices. p50 is the median sweep price. Low = BR catches very cheap mispricings.">Price: p10=$' + patterns.sweep_price_distribution.p10.toFixed(3) + ' p50=$' + patterns.sweep_price_distribution.p50.toFixed(3) + ' p90=$' + patterns.sweep_price_distribution.p90.toFixed(3) + '</div>' +
        '<div class="text-gray-400 text-[10px] tt" data-tip="Distribution of WHEN sweeps happen (as % of window elapsed). p50 is the median — sweeps cluster in the late-window period when certainty is highest.">Elapsed: p10=' + (patterns.sweep_elapsed_distribution.p10*100).toFixed(0) + '% p50=' + (patterns.sweep_elapsed_distribution.p50*100).toFixed(0) + '% p90=' + (patterns.sweep_elapsed_distribution.p90*100).toFixed(0) + '%</div>' +
        '</div>';

      html += '<div class="mb-3"><div class="text-gray-500 text-[10px] uppercase mb-1 tt" data-tip="How aggressive BR is at each fill, measured as BR_price ÷ best_ask at time of fill. <0.5 = deep-value maker; 0.5–1.0 = normal maker; >1.0 = crossed the ask (taker). Big avg size in the taker bucket shows BR pounds in size when crossing.">Buy aggressiveness (price vs ask)</div>' +
        '<table class="w-full text-[11px] mono"><thead><tr class="text-gray-500 border-b border-gray-800">' +
        '<th class="text-left tt" data-tip="Price bucket relative to best ask. 0.0–0.2 = deep-value maker; 1.0–1.1 = taker that crossed the spread">Range</th>' +
        '<th class="text-right tt" data-tip="Number of BR trades in this bucket">n</th>' +
        '<th class="text-right tt" data-tip="Average absolute fill price ($) in this bucket">avg px</th>' +
        '<th class="text-right tt" data-tip="Average tokens per fill. Large values in the taker bucket indicate aggressive size sweeps.">avg size</th>' +
        '</tr></thead><tbody>';
      for (const b of data.by_price_vs_ask) {
        html += '<tr><td>' + b.bucket + '</td>' +
          '<td class="text-right">' + b.n + '</td>' +
          '<td class="text-right">$' + b.avg_price.toFixed(3) + '</td>' +
          '<td class="text-right">' + b.avg_size.toFixed(1) + '</td></tr>';
      }
      html += '</tbody></table></div>';
      html += '</div>';
      html += '</div>';

      el.innerHTML = html;
    }

    loadPatterns();
    runBacktest();
  </script>
</body>
</html>`;
}
