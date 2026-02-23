import {
  pollCycle,
  getOpenPositionCount,
  checkCircuitBreaker,
  getMaxBalanceFailures,
} from "./listener";
import type { CopyTarget, CopyTrade, Env } from "./types";

type ListenerState = "running" | "winding_down" | "stopped";

export { FirehoseDO } from "./firehose-do";
export { WatchlistDO } from "./watchlist-do";

// ── Auto-start DOs on first request ────────────────────────────────

let autoStarted = false;

async function autoStartDOs(env: Env) {
  // Start copy listener unless user explicitly stopped it
  try {
    const id = env.LISTENER.idFromName("singleton");
    const obj = env.LISTENER.get(id);
    const resp = await obj.fetch(new Request("https://dummy/status"));
    const status = (await resp.json()) as {
      running: boolean;
      userStopped?: boolean;
    };
    if (!status.running && !status.userStopped) {
      await obj.fetch(new Request("https://dummy/start", { method: "POST" }));
    }
  } catch {
    /* ignore */
  }

  // Start firehose
  try {
    const id = env.FIREHOSE.idFromName("singleton");
    const obj = env.FIREHOSE.get(id);
    const resp = await obj.fetch(new Request("https://dummy/firehose/status"));
    const status = (await resp.json()) as {
      running: boolean;
      userStopped?: boolean;
    };
    if (!status.running && !status.userStopped) {
      await obj.fetch(
        new Request("https://dummy/firehose/start", { method: "POST" }),
      );
    }
  } catch {
    /* ignore */
  }

  // Start watchlist if entries exist
  try {
    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM watchlist",
    ).first<{ cnt: number }>();
    if (cnt && cnt.cnt > 0) {
      const id = env.WATCHLIST.idFromName("singleton");
      const obj = env.WATCHLIST.get(id);
      const resp = await obj.fetch(new Request("https://dummy/status"));
      const status = (await resp.json()) as {
        running: boolean;
        userStopped?: boolean;
      };
      if (!status.running && !status.userStopped) {
        await obj.fetch(new Request("https://dummy/start", { method: "POST" }));
      }
    }
  } catch {
    /* ignore */
  }
}

// ── CORS ───────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://polybot.pages.dev",
  "https://polybot-b5l.pages.dev",
  "https://polybot-copy-listener.timstew.workers.dev",
];

function corsHeaders(origin: string): Record<string, string> {
  const allowed = ALLOWED_ORIGINS.some(
    (o) =>
      origin === o ||
      origin.endsWith(".polybot.pages.dev") ||
      origin.endsWith(".polybot-b5l.pages.dev"),
  );
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonCors(data: unknown, request: Request, status = 200): Response {
  const origin = request.headers.get("Origin") || "";
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

// ── Category-specific check intervals for watchlist (minutes) ──────

const CATEGORY_INTERVALS: Record<string, number> = {
  crypto: 20,
  sports: 90,
  politics: 240,
  finance: 120,
  unknown: 60,
};

// ── Market category detection ──────────────────────────────────────

type MarketCategory = "crypto" | "sports" | "politics" | "other";

function classifyTitle(title: string): MarketCategory | null {
  if (!title) return null;
  const t = title.toLowerCase();
  if (
    t.includes("bitcoin") ||
    t.includes("ethereum") ||
    t.includes("sol") ||
    t.includes("up or down") ||
    t.includes("updown") ||
    t.includes("above")
  )
    return "crypto";
  if (
    t.includes("win the") ||
    t.includes("division") ||
    t.includes("championship") ||
    t.includes("nfl") ||
    t.includes("nba") ||
    t.includes("nhl") ||
    t.includes("mlb") ||
    t.includes("score") ||
    t.includes("super bowl") ||
    t.includes("playoffs")
  )
    return "sports";
  if (
    t.includes("trump") ||
    t.includes("biden") ||
    t.includes("election") ||
    t.includes("president") ||
    t.includes("strike") ||
    t.includes("congress") ||
    t.includes("senate") ||
    t.includes("iran") ||
    t.includes("tariff")
  )
    return "politics";
  return "other";
}

function walletCategories(trades: { title: string }[]): MarketCategory[] {
  const counts: Record<MarketCategory, number> = {
    crypto: 0,
    sports: 0,
    politics: 0,
    other: 0,
  };
  for (const t of trades) {
    const cat = classifyTitle(t.title);
    if (cat) counts[cat]++;
  }
  // Return categories sorted by frequency, only those with > 0
  return (Object.entries(counts) as [MarketCategory, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([cat]) => cat);
}

// ── FIFO P&L computation ───────────────────────────────────────────

interface TradeRow {
  asset_id: string;
  side: string;
  price: number;
  size: number;
  timestamp: string;
  fee_amount: number;
}

interface ClosedPosition {
  market: string;
  asset_id: string;
  size: number;
  entry_price: number;
  exit_price: number;
  realized_pnl: number;
  hold_time_hours: number;
  closed_at: string;
}

interface OpenPosition {
  market: string;
  asset_id: string;
  size: number;
  entry_price: number;
  entry_time: string;
}

type OutcomeType =
  | "resolution_win"
  | "resolution_loss"
  | "sold_profit"
  | "sold_loss";

interface OutcomeBreakdown {
  resolution_win: number;
  resolution_loss: number;
  sold_profit: number;
  sold_loss: number;
}

interface PnlResult {
  realized_pnl: number;
  total_fees: number;
  avg_hold_time_hours: number;
  wins: number;
  losses: number;
  best_trade_pnl: number;
  worst_trade_pnl: number;
  closed_positions: ClosedPosition[];
  open_positions: OpenPosition[];
  pnl_series: { t: string; pnl: number }[];
  peak_capital: number;
  outcome_breakdown: OutcomeBreakdown;
}

interface TradeRowWithMarket extends TradeRow {
  market?: string;
}

function computeFifoPnl(trades: TradeRowWithMarket[]): PnlResult {
  const byAsset = new Map<string, TradeRowWithMarket[]>();
  for (const t of trades) {
    const arr = byAsset.get(t.asset_id);
    if (arr) arr.push(t);
    else byAsset.set(t.asset_id, [t]);
  }

  let realizedPnl = 0;
  let totalFees = 0;
  let holdTimeSum = 0;
  let holdTimeCount = 0;
  let wins = 0;
  let losses = 0;
  let bestTradePnl = 0;
  let worstTradePnl = 0;
  const closedPositions: ClosedPosition[] = [];
  const openPositions: OpenPosition[] = [];
  const pnlEvents: { t: string; pnl: number }[] = [];
  // Track capital deployed over time to find peak
  const capitalEvents: { ts: number; delta: number }[] = [];
  const outcomeBreakdown: OutcomeBreakdown = {
    resolution_win: 0,
    resolution_loss: 0,
    sold_profit: 0,
    sold_loss: 0,
  };

  for (const [assetId, assetTrades] of byAsset) {
    assetTrades.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const queue: {
      price: number;
      remaining: number;
      ts: number;
      market: string;
    }[] = [];

    for (const t of assetTrades) {
      totalFees += t.fee_amount || 0;
      if (t.side === "BUY") {
        const cost = t.price * t.size;
        queue.push({
          price: t.price,
          remaining: t.size,
          ts: new Date(t.timestamp).getTime(),
          market: t.market || "",
        });
        capitalEvents.push({
          ts: new Date(t.timestamp).getTime(),
          delta: cost,
        });
      } else {
        let sellRemaining = t.size;
        const sellTs = new Date(t.timestamp).getTime();
        let positionPnl = 0;
        let positionSize = 0;
        let entryPriceSum = 0;
        let entryTs = 0;
        let market = t.market || "";

        while (sellRemaining > 0 && queue.length > 0) {
          const buy = queue[0];
          const matched = Math.min(sellRemaining, buy.remaining);
          const matchPnl = matched * (t.price - buy.price);
          realizedPnl += matchPnl;
          positionPnl += matchPnl;
          positionSize += matched;
          entryPriceSum += buy.price * matched;
          if (!entryTs) entryTs = buy.ts;
          if (!market) market = buy.market;
          holdTimeSum += ((sellTs - buy.ts) / 3_600_000) * matched;
          holdTimeCount += matched;
          buy.remaining -= matched;
          sellRemaining -= matched;
          if (buy.remaining <= 0) queue.shift();
        }

        // Release capital for matched sells
        if (positionSize > 0) {
          capitalEvents.push({ ts: sellTs, delta: -entryPriceSum });
          const netPnl = Math.round(positionPnl * 100) / 100;
          if (netPnl >= 0) wins++;
          else losses++;
          if (netPnl > bestTradePnl) bestTradePnl = netPnl;
          if (netPnl < worstTradePnl) worstTradePnl = netPnl;

          // Classify outcome: resolution (price ~0 or ~1) vs active sell
          const isResolution = t.price >= 0.99 || t.price <= 0.01;
          if (isResolution) {
            if (netPnl >= 0) outcomeBreakdown.resolution_win++;
            else outcomeBreakdown.resolution_loss++;
          } else {
            if (netPnl >= 0) outcomeBreakdown.sold_profit++;
            else outcomeBreakdown.sold_loss++;
          }

          closedPositions.push({
            market,
            asset_id: assetId,
            size: Math.round(positionSize * 1000) / 1000,
            entry_price:
              Math.round((entryPriceSum / positionSize) * 10000) / 10000,
            exit_price: t.price,
            realized_pnl: netPnl,
            hold_time_hours:
              Math.round(((sellTs - entryTs) / 3_600_000) * 10) / 10,
            closed_at: t.timestamp,
          });

          pnlEvents.push({ t: t.timestamp, pnl: netPnl });
        }
      }
    }

    // Remaining in queue = open positions
    for (const buy of queue) {
      if (buy.remaining > 0.001) {
        openPositions.push({
          market: buy.market,
          asset_id: assetId,
          size: Math.round(buy.remaining * 1000) / 1000,
          entry_price: buy.price,
          entry_time: new Date(buy.ts).toISOString(),
        });
      }
    }
  }

  // Build cumulative P&L series
  pnlEvents.sort((a, b) => a.t.localeCompare(b.t));
  let cumPnl = 0;
  const pnl_series = pnlEvents.map((e) => {
    cumPnl += e.pnl;
    return { t: e.t, pnl: Math.round(cumPnl * 100) / 100 };
  });

  // Sort closed positions by time desc
  closedPositions.sort((a, b) => b.closed_at.localeCompare(a.closed_at));

  // Compute peak capital (max simultaneous open cost)
  capitalEvents.sort((a, b) => a.ts - b.ts);
  let runningCapital = 0;
  let peakCapital = 0;
  for (const ev of capitalEvents) {
    runningCapital += ev.delta;
    if (runningCapital > peakCapital) peakCapital = runningCapital;
  }

  return {
    realized_pnl: Math.round((realizedPnl - totalFees) * 100) / 100,
    total_fees: Math.round(totalFees * 100) / 100,
    avg_hold_time_hours:
      holdTimeCount > 0
        ? Math.round((holdTimeSum / holdTimeCount) * 10) / 10
        : 0,
    wins,
    losses,
    best_trade_pnl: bestTradePnl,
    worst_trade_pnl: worstTradePnl,
    closed_positions: closedPositions,
    open_positions: openPositions,
    pnl_series,
    peak_capital: Math.round(peakCapital * 100) / 100,
    outcome_breakdown: outcomeBreakdown,
  };
}

// ── Durable Object: self-scheduling copy listener ──────────────────

export class CopyListenerDO implements DurableObject {
  private seenIds = new Set<string>();
  private doState: DurableObjectState;
  private env: Env;
  private pollCount = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.doState = state;
    this.env = env;
  }

  private async getListenerState(): Promise<ListenerState> {
    return (
      (await this.doState.storage.get<ListenerState>("listenerState")) ??
      "stopped"
    );
  }

  private async setListenerState(state: ListenerState): Promise<void> {
    await this.doState.storage.put("listenerState", state);
    // Keep userStopped in sync for backward compat (autoStartDOs checks it)
    await this.doState.storage.put("userStopped", state === "stopped");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      await this.setListenerState("running");
      await this.doState.storage.setAlarm(Date.now() + 1000);
      return json({ status: "started" });
    }

    if (url.pathname === "/stop") {
      // Graceful wind-down: stop new BUYs but continue SELLs until flat
      const current = await this.getListenerState();
      if (current === "running") {
        await this.setListenerState("winding_down");
        // Keep alarm running so SELLs continue processing
        return json({ status: "winding_down" });
      }
      // If already winding down or stopped, do a full stop
      await this.setListenerState("stopped");
      await this.doState.storage.deleteAlarm();
      this.pollCount = 0;
      return json({ status: "stopped" });
    }

    if (url.pathname === "/force-stop") {
      // Emergency stop: immediately halt everything
      await this.setListenerState("stopped");
      await this.doState.storage.deleteAlarm();
      this.pollCount = 0;
      return json({ status: "stopped" });
    }

    if (url.pathname === "/status") {
      const alarm = await this.doState.storage.getAlarm();
      const listenerState = await this.getListenerState();
      const userStopped = listenerState === "stopped";
      let openPositions = 0;
      if (listenerState === "winding_down") {
        try {
          openPositions = await getOpenPositionCount(this.env.DB);
        } catch {
          /* ignore */
        }
      }
      return json({
        running: alarm !== null,
        polls: this.pollCount,
        userStopped,
        state: listenerState,
        open_positions: openPositions,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const listenerState = await this.getListenerState();
    if (listenerState === "stopped") return;

    const buysDisabled = listenerState === "winding_down";

    try {
      await pollCycle(
        this.env.DB,
        this.seenIds,
        this.env.PYTHON_API_URL,
        buysDisabled,
      );
      this.pollCount++;

      // Circuit breaker: check if losses exceeded threshold → trigger wind-down
      if (listenerState === "running") {
        const tripped = await checkCircuitBreaker(this.env.DB);
        if (tripped) {
          await this.setListenerState("winding_down");
        }
      }

      // Balance failure check: 5+ consecutive failures → trigger wind-down
      if (listenerState === "running" && getMaxBalanceFailures() >= 5) {
        console.log("[BALANCE] 5+ consecutive balance failures — winding down");
        await this.setListenerState("winding_down");
      }

      // If winding down, check if we're flat (no open positions)
      const currentState = await this.getListenerState();
      if (currentState === "winding_down") {
        const openCount = await getOpenPositionCount(this.env.DB);
        if (openCount === 0) {
          console.log("[WIND-DOWN] All positions closed — stopping listener");
          await this.setListenerState("stopped");
          return; // Don't re-schedule
        }
      }
    } catch (e) {
      console.error("Poll cycle error:", e);
    }
    // Re-schedule next poll in 2 seconds
    await this.doState.storage.setAlarm(Date.now() + 2000);
  }
}

// ── Worker fetch handler ───────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // Auto-start DOs on first request (cron doesn't fire in local dev)
    if (!autoStarted) {
      autoStarted = true;
      autoStartDOs(env).catch(() => {});
    }

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    // ── Firehose cleanup & stats ───────────────────────────────────

    if (url.pathname === "/api/firehose/stats") {
      const fdb = env.FIREHOSE_DB ?? env.DB;
      const [tradeRow, walletRow, botRow, targetRow, watchRow] =
        await Promise.all([
          fdb
            .prepare("SELECT COUNT(*) as cnt FROM firehose_trades")
            .first<{ cnt: number }>(),
          fdb
            .prepare("SELECT COUNT(*) as cnt FROM firehose_wallets")
            .first<{ cnt: number }>(),
          env.DB.prepare("SELECT COUNT(*) as cnt FROM suspect_bots").first<{
            cnt: number;
          }>(),
          env.DB.prepare("SELECT COUNT(*) as cnt FROM copy_targets").first<{
            cnt: number;
          }>(),
          env.DB.prepare("SELECT COUNT(*) as cnt FROM watchlist").first<{
            cnt: number;
          }>(),
        ]);
      return jsonCors(
        {
          firehose_trades: tradeRow?.cnt ?? 0,
          firehose_wallets: walletRow?.cnt ?? 0,
          suspect_bots: botRow?.cnt ?? 0,
          copy_targets: targetRow?.cnt ?? 0,
          watchlist: watchRow?.cnt ?? 0,
        },
        request,
      );
    }

    if (url.pathname === "/api/firehose/cleanup" && request.method === "POST") {
      const fdb = env.FIREHOSE_DB ?? env.DB;
      const BATCH = 50_000;
      let tradesDeleted = 0;
      let walletsDeleted = 0;

      // Step 1: Delete old trades (> 3 days) in batches — fastest path
      for (;;) {
        const r = await fdb
          .prepare(
            `DELETE FROM firehose_trades WHERE rowid IN (
               SELECT rowid FROM firehose_trades
               WHERE timestamp < datetime('now', '-3 days')
               LIMIT ?
             )`,
          )
          .bind(BATCH)
          .run();
        const changed = r.meta?.changes ?? 0;
        tradesDeleted += changed;
        if (changed < BATCH) break;
      }

      // Step 2: Delete non-bot trades in batches
      for (;;) {
        const r = await fdb
          .prepare(
            `DELETE FROM firehose_trades WHERE rowid IN (
               SELECT rowid FROM firehose_trades
               WHERE taker NOT IN (
                 SELECT wallet FROM suspect_bots
                 UNION SELECT wallet FROM copy_targets
                 UNION SELECT wallet FROM watchlist
               )
               LIMIT ?
             )`,
          )
          .bind(BATCH)
          .run();
        const changed = r.meta?.changes ?? 0;
        tradesDeleted += changed;
        if (changed < BATCH) break;
      }

      // Step 3: Delete non-bot wallets in batches
      for (;;) {
        const r = await fdb
          .prepare(
            `DELETE FROM firehose_wallets WHERE rowid IN (
               SELECT rowid FROM firehose_wallets
               WHERE wallet NOT IN (
                 SELECT wallet FROM suspect_bots
                 UNION SELECT wallet FROM copy_targets
                 UNION SELECT wallet FROM watchlist
               )
               LIMIT ?
             )`,
          )
          .bind(BATCH)
          .run();
        const changed = r.meta?.changes ?? 0;
        walletsDeleted += changed;
        if (changed < BATCH) break;
      }

      return jsonCors(
        {
          status: "cleaned",
          trades_deleted: tradesDeleted,
          wallets_deleted: walletsDeleted,
        },
        request,
      );
    }

    // ── Firehose routes → FirehoseDO ───────────────────────────────

    if (url.pathname.startsWith("/firehose/")) {
      const id = env.FIREHOSE.idFromName("singleton");
      const obj = env.FIREHOSE.get(id);
      const doResp = await obj.fetch(request);
      const data = await doResp.json();
      return jsonCors(data, request, doResp.status);
    }

    // ── API routes (dashboard compatibility) ───────────────────────

    if (url.pathname === "/api/listener/start") {
      const id = env.FIREHOSE.idFromName("singleton");
      const obj = env.FIREHOSE.get(id);
      const doResp = await obj.fetch(
        new Request("https://dummy/firehose/start", { method: "POST" }),
      );
      return jsonCors(await doResp.json(), request);
    }

    if (url.pathname === "/api/listener/stop") {
      const id = env.FIREHOSE.idFromName("singleton");
      const obj = env.FIREHOSE.get(id);
      const doResp = await obj.fetch(
        new Request("https://dummy/firehose/stop", { method: "POST" }),
      );
      return jsonCors(await doResp.json(), request);
    }

    if (
      (url.pathname === "/api/detect" ||
        url.pathname === "/api/detect/status" ||
        url.pathname === "/api/detect/stop") &&
      env.PYTHON_API_URL
    ) {
      const id = env.FIREHOSE.idFromName("singleton");
      const stub = env.FIREHOSE.get(id);
      // Map routes: /api/detect → start, /api/detect/status → status, /api/detect/stop → stop
      let doPath = "/firehose/detect/start";
      if (url.pathname === "/api/detect/status")
        doPath = "/firehose/detect/status";
      else if (url.pathname === "/api/detect/stop")
        doPath = "/firehose/detect/stop";
      const doResp = await stub.fetch(
        new Request(`https://do${doPath}?${url.searchParams}`, {
          method: request.method,
        }),
      );
      return jsonCors(await doResp.json(), request);
    }

    if (url.pathname === "/api/bots") {
      const minConfidence = Number(
        url.searchParams.get("min_confidence") ?? "0",
      );
      const { results } = await env.DB.prepare(
        "SELECT * FROM suspect_bots WHERE confidence >= ? ORDER BY confidence DESC",
      )
        .bind(minConfidence)
        .all<{
          wallet: string;
          confidence: number;
          category: string;
          trade_count: number;
          tags: string;
          detected_at: string;
        }>();
      return jsonCors(
        (results ?? []).map((r) => ({
          ...r,
          tags: JSON.parse(r.tags || "[]"),
        })),
        request,
      );
    }

    if (url.pathname === "/api/bots/clear") {
      await env.DB.prepare("DELETE FROM suspect_bots").run();
      return jsonCors({ status: "cleared" }, request);
    }

    if (url.pathname === "/api/unified") {
      // Return detected bots from D1 with profitability data
      // Supports pagination: offset (default 0), limit (default 50, max 500)
      const offset = Math.max(Number(url.searchParams.get("offset") ?? "0"), 0);
      const limit = Math.min(
        Math.max(Number(url.searchParams.get("limit") ?? "50"), 1),
        500,
      );

      type SuspectBotRow = {
        wallet: string;
        confidence: number;
        category: string;
        trade_count: number;
        tags: string;
        pnl_pct: number;
        realized_pnl: number;
        win_rate: number;
        total_volume_usd: number;
        profit_1d: number;
        profit_7d: number;
        profit_30d: number;
        profit_all: number;
        username: string;
        copy_score: number;
      };

      // Get total count for pagination
      const countResult = await env.DB.prepare(
        "SELECT COUNT(*) as total FROM suspect_bots",
      ).first<{ total: number }>();
      const total = countResult?.total ?? 0;

      const { results } = await env.DB.prepare(
        "SELECT * FROM suspect_bots ORDER BY copy_score DESC, confidence DESC LIMIT ? OFFSET ?",
      )
        .bind(limit, offset)
        .all<SuspectBotRow>();

      function mapBotRow(r: SuspectBotRow) {
        const vol = r.total_volume_usd || 0;
        const pall = r.profit_all || 0;
        return {
          wallet: r.wallet,
          confidence: r.confidence,
          category: r.category,
          trade_count: r.trade_count,
          tags: JSON.parse(r.tags || "[]"),
          username: r.username || "",
          pnl_pct: r.pnl_pct || 0,
          realized_pnl: r.realized_pnl || 0,
          unrealized_pnl: 0,
          win_rate: r.win_rate || 0,
          total_volume_usd: vol,
          active_positions: 0,
          portfolio_value: pall,
          market_categories: [],
          copy_score: r.copy_score ?? 0,
          avg_hold_time_hours: 0,
          trades_per_market: 0,
          avg_market_burst: 0,
          max_market_burst: 0,
          market_concentration: 0,
          profit_1d: r.profit_1d || 0,
          profit_7d: r.profit_7d || 0,
          profit_30d: r.profit_30d || 0,
          profit_all: pall,
          efficiency: vol > 0 ? Math.round((pall / vol) * 10000) / 100 : 0,
        };
      }

      return jsonCors(
        {
          bots: (results ?? []).map(mapBotRow),
          total,
          offset,
          limit,
        },
        request,
      );
    }

    // ── Watchlist routes ───────────────────────────────────────────────

    if (url.pathname === "/api/watchlist" && request.method === "GET") {
      // List all watchlist entries with their latest snapshot
      const { results: entries } = await env.DB.prepare(
        `SELECT w.*,
                s.profit_1d, s.profit_7d, s.profit_30d, s.profit_all,
                s.volume_24h, s.win_rate, s.open_positions, s.active_markets,
                s.avg_trade_size, s.trades_24h, s.copy_score, s.positions_json,
                s.snapshot_at
         FROM watchlist w
         LEFT JOIN watchlist_snapshots s ON s.wallet = w.wallet
           AND s.snapshot_at = (
             SELECT MAX(s2.snapshot_at) FROM watchlist_snapshots s2
             WHERE s2.wallet = w.wallet
           )
         ORDER BY w.added_at DESC`,
      ).all<{
        wallet: string;
        added_at: string;
        added_by: string;
        category: string;
        check_interval_min: number;
        last_checked: string | null;
        notes: string;
        username: string;
        profit_1d: number | null;
        profit_7d: number | null;
        profit_30d: number | null;
        profit_all: number | null;
        volume_24h: number | null;
        win_rate: number | null;
        open_positions: number | null;
        active_markets: number | null;
        avg_trade_size: number | null;
        trades_24h: number | null;
        copy_score: number | null;
        positions_json: string | null;
        snapshot_at: string | null;
      }>();

      // For trend calculation, get snapshot from ~7 days ago for each wallet
      const wallets = (entries ?? []).map((e) => e.wallet);
      const trends: Record<string, number> = {};
      for (const w of wallets) {
        const old = await env.DB.prepare(
          `SELECT profit_all FROM watchlist_snapshots
           WHERE wallet = ? AND snapshot_at <= datetime('now', '-7 days')
           ORDER BY snapshot_at DESC LIMIT 1`,
        )
          .bind(w)
          .first<{ profit_all: number }>();
        if (old && old.profit_all !== 0) {
          const current = entries?.find((e) => e.wallet === w)?.profit_all ?? 0;
          trends[w] =
            Math.round(
              ((current - old.profit_all) / Math.abs(old.profit_all)) * 1000,
            ) / 10;
        }
      }

      const result = (entries ?? []).map((e) => ({
        wallet: e.wallet,
        username: e.username || "",
        added_at: e.added_at,
        added_by: e.added_by,
        category: e.category,
        check_interval_min: e.check_interval_min,
        last_checked: e.last_checked,
        notes: e.notes,
        latest: e.snapshot_at
          ? {
              profit_1d: e.profit_1d ?? 0,
              profit_7d: e.profit_7d ?? 0,
              profit_30d: e.profit_30d ?? 0,
              profit_all: e.profit_all ?? 0,
              volume_24h: e.volume_24h ?? 0,
              win_rate: e.win_rate ?? 0,
              open_positions: e.open_positions ?? 0,
              active_markets: e.active_markets ?? 0,
              avg_trade_size: e.avg_trade_size ?? 0,
              trades_24h: e.trades_24h ?? 0,
              copy_score: e.copy_score ?? 0,
              trend_7d: trends[e.wallet] ?? null,
              snapshot_at: e.snapshot_at,
            }
          : null,
      }));

      return jsonCors(result, request);
    }

    if (url.pathname === "/api/watchlist/add" && request.method === "POST") {
      const body = (await request.json()) as {
        wallet: string;
        notes?: string;
        category?: string;
        added_by?: string;
      };
      const w = body.wallet?.toLowerCase();
      if (!w) return jsonCors({ error: "wallet required" }, request, 400);

      // Auto-infer category from suspect_bots tags if not provided
      let category = body.category || "unknown";
      if (category === "unknown") {
        try {
          const bot = await env.DB.prepare(
            "SELECT tags FROM suspect_bots WHERE wallet = ?",
          )
            .bind(w)
            .first<{ tags: string }>();
          if (bot?.tags) {
            const tags: string[] = JSON.parse(bot.tags);
            const marketCats = ["crypto", "politics", "sports", "finance"];
            const found = marketCats.find((c) => tags.includes(c));
            if (found) category = found;
          }
        } catch {
          /* ignore */
        }
      }

      const interval =
        CATEGORY_INTERVALS[category] ?? CATEGORY_INTERVALS["unknown"];

      // Try to fetch username
      let username = "";
      try {
        const resp = await fetch(
          `https://data-api.polymarket.com/activity?user=${w}&limit=1`,
        );
        if (resp.ok) {
          const entries = (await resp.json()) as Array<{ name?: string }>;
          const n = entries?.[0]?.name;
          if (n && !n.startsWith("0x")) username = n;
        }
      } catch {
        /* optional */
      }

      await env.DB.prepare(
        `INSERT OR REPLACE INTO watchlist
         (wallet, added_by, category, check_interval_min, notes, username)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          w,
          body.added_by || "user",
          category,
          interval,
          body.notes || "",
          username,
        )
        .run();

      // Ensure WatchlistDO is running + take immediate snapshot
      const wlId = env.WATCHLIST.idFromName("singleton");
      const wlObj = env.WATCHLIST.get(wlId);
      await wlObj.fetch(new Request("https://dummy/start", { method: "POST" }));
      wlObj
        .fetch(
          new Request("https://dummy/snapshot", {
            method: "POST",
            body: JSON.stringify({ wallet: w }),
          }),
        )
        .catch(() => {});

      return jsonCors(
        {
          status: "added",
          wallet: w,
          category,
          username,
          check_interval_min: interval,
        },
        request,
      );
    }

    if (url.pathname === "/api/watchlist/remove" && request.method === "POST") {
      const body = (await request.json()) as { wallet: string };
      const w = body.wallet?.toLowerCase();
      if (!w) return jsonCors({ error: "wallet required" }, request, 400);

      await env.DB.batch([
        env.DB.prepare("DELETE FROM watchlist WHERE wallet = ?").bind(w),
        env.DB.prepare("DELETE FROM watchlist_snapshots WHERE wallet = ?").bind(
          w,
        ),
      ]);

      return jsonCors({ status: "removed", wallet: w }, request);
    }

    if (
      url.pathname === "/api/watchlist/promote" &&
      request.method === "POST"
    ) {
      const body = (await request.json()) as {
        wallet: string;
        mode?: string;
        trade_pct?: number;
        max_position_usd?: number;
      };
      const w = body.wallet?.toLowerCase();
      if (!w) return jsonCors({ error: "wallet required" }, request, 400);

      const mode = body.mode === "real" ? "real" : "paper";

      // Get username from watchlist
      const wlEntry = await env.DB.prepare(
        "SELECT username FROM watchlist WHERE wallet = ?",
      )
        .bind(w)
        .first<{ username: string }>();

      await env.DB.prepare(
        `INSERT OR REPLACE INTO copy_targets
         (wallet, mode, trade_pct, max_position_usd, active,
          total_paper_pnl, total_real_pnl,
          slippage_bps, latency_ms, fee_rate, measured_slippage_bps, username)
         VALUES (?, ?, ?, ?, 1, 0, 0, 50, 2000, 0, -1, ?)`,
      )
        .bind(
          w,
          mode,
          body.trade_pct ?? 100,
          body.max_position_usd ?? 10000,
          wlEntry?.username || "",
        )
        .run();

      return jsonCors({ status: "promoted", wallet: w, mode }, request);
    }

    // Watchlist history — snapshots over time for a wallet
    const watchlistHistoryMatch = url.pathname.match(
      /^\/api\/watchlist\/(0x[a-fA-F0-9]+)\/history$/,
    );
    if (watchlistHistoryMatch) {
      const w = watchlistHistoryMatch[1].toLowerCase();
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const { results } = await env.DB.prepare(
        `SELECT * FROM watchlist_snapshots
         WHERE wallet = ?
         ORDER BY snapshot_at DESC
         LIMIT ?`,
      )
        .bind(w, limit)
        .all();

      return jsonCors(results ?? [], request);
    }

    // Watchlist positions — latest positions_json for a wallet
    const watchlistPosMatch = url.pathname.match(
      /^\/api\/watchlist\/(0x[a-fA-F0-9]+)\/positions$/,
    );
    if (watchlistPosMatch) {
      const w = watchlistPosMatch[1].toLowerCase();
      const snap = await env.DB.prepare(
        `SELECT positions_json FROM watchlist_snapshots
         WHERE wallet = ?
         ORDER BY snapshot_at DESC LIMIT 1`,
      )
        .bind(w)
        .first<{ positions_json: string }>();

      return jsonCors(JSON.parse(snap?.positions_json || "[]"), request);
    }

    // Watchlist DO status
    if (url.pathname === "/api/watchlist/status") {
      const wlId = env.WATCHLIST.idFromName("singleton");
      const wlObj = env.WATCHLIST.get(wlId);
      const doResp = await wlObj.fetch(new Request("https://dummy/status"));
      return jsonCors(await doResp.json(), request);
    }

    // ── Wallet detail (D1 bot data + copy trade FIFO + Polymarket positions)
    const walletMatch = url.pathname.match(/^\/api\/wallet\/(0x[a-fA-F0-9]+)$/);
    if (walletMatch) {
      const w = walletMatch[1].toLowerCase();

      // 1. Bot info from D1
      const botRow = await env.DB.prepare(
        "SELECT * FROM suspect_bots WHERE wallet = ?",
      )
        .bind(w)
        .first<{
          wallet: string;
          confidence: number;
          category: string;
          trade_count: number;
          tags: string;
          win_rate: number;
          total_volume_usd: number;
          pnl_pct: number;
          realized_pnl: number;
          profit_1d: number;
          profit_7d: number;
          profit_30d: number;
          profit_all: number;
          username: string;
          copy_score: number;
        }>();

      // 2. Copy trade data (if we're copy-trading this wallet)
      const { results: copyTrades } = await env.DB.prepare(
        `SELECT market, asset_id, side, price, size, timestamp, fee_amount, title
         FROM copy_trades
         WHERE source_wallet = ? AND status = 'filled'
         ORDER BY timestamp`,
      )
        .bind(w)
        .all<TradeRowWithMarket & { title: string }>();

      const copyPnl =
        copyTrades && copyTrades.length > 0 ? computeFifoPnl(copyTrades) : null;

      // 3. Username from activity API
      let username = botRow?.username || "";
      if (!username) {
        try {
          const actResp = await fetch(
            `https://data-api.polymarket.com/activity?user=${w}&limit=1`,
          );
          if (actResp.ok) {
            const entries = (await actResp.json()) as Array<{
              name?: string;
            }>;
            const n = entries?.[0]?.name;
            if (n && !n.startsWith("0x")) username = n;
          }
        } catch {
          // optional
        }
      }

      // 4. Polymarket positions
      let positions: Array<Record<string, unknown>> = [];
      try {
        const posResp = await fetch(
          `https://data-api.polymarket.com/positions?user=${w}&sizeThreshold=-1&limit=100`,
        );
        if (posResp.ok) {
          positions = (await posResp.json()) as Array<Record<string, unknown>>;
        }
      } catch {
        // optional
      }

      const vol = botRow?.total_volume_usd || 0;
      const winRate = botRow?.win_rate || 0;
      const copyWinRate =
        copyPnl && copyPnl.wins + copyPnl.losses > 0
          ? Math.round(
              (copyPnl.wins / (copyPnl.wins + copyPnl.losses)) * 1000,
            ) / 10
          : 0;

      return jsonCors(
        {
          username,
          bot: botRow
            ? {
                wallet: botRow.wallet,
                confidence: botRow.confidence,
                category: botRow.category,
                tags: JSON.parse(botRow.tags || "[]"),
                avg_hold_time_hours: 0,
              }
            : null,
          profitability: {
            total_trades: botRow?.trade_count || copyTrades?.length || 0,
            total_volume_usd: vol,
            realized_pnl: copyPnl?.realized_pnl ?? botRow?.realized_pnl ?? 0,
            unrealized_pnl: 0,
            pnl_pct: botRow?.pnl_pct || 0,
            win_rate: copyPnl ? copyWinRate / 100 : winRate,
            markets_traded: 0,
            active_positions: positions.length,
            market_categories: [],
          },
          copy_trading: copyPnl
            ? {
                trade_count: copyTrades?.length ?? 0,
                realized_pnl: copyPnl.realized_pnl,
                total_fees: copyPnl.total_fees,
                peak_capital: copyPnl.peak_capital,
                avg_hold_time_hours: copyPnl.avg_hold_time_hours,
                wins: copyPnl.wins,
                losses: copyPnl.losses,
                win_rate: copyWinRate,
                best_trade_pnl: copyPnl.best_trade_pnl,
                worst_trade_pnl: copyPnl.worst_trade_pnl,
                pnl_series: copyPnl.pnl_series,
              }
            : null,
          positions: positions.map((p) => ({
            title: String(p.title ?? ""),
            outcome: String(p.outcome ?? ""),
            size: Number(p.size ?? 0),
            avg_price: Number(p.avgPrice ?? 0),
            current_price: Number(p.curPrice ?? 0),
            initial_value: Number(p.initialValue ?? 0),
            current_value: Number(p.currentValue ?? 0),
            cash_pnl: Number(p.cashPnl ?? 0),
            percent_pnl: Number(p.percentPnl ?? 0),
            realized_pnl: Number(p.realizedPnl ?? 0),
            slug: String(p.slug ?? ""),
          })),
          profit_1d: botRow?.profit_1d || 0,
          profit_7d: botRow?.profit_7d || 0,
          profit_30d: botRow?.profit_30d || 0,
          profit_all: botRow?.profit_all || 0,
        },
        request,
      );
    }

    // Wallet trades — return copy trades if available, else fall through to Python
    const walletTradesMatch = url.pathname.match(
      /^\/api\/wallet\/(0x[a-fA-F0-9]+)\/trades$/,
    );
    if (walletTradesMatch) {
      const w = walletTradesMatch[1].toLowerCase();
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const { results: trades } = await env.DB.prepare(
        `SELECT id, market, title, side, price, size, timestamp
         FROM copy_trades
         WHERE source_wallet = ? AND status = 'filled'
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
        .bind(w, limit)
        .all<{
          id: string;
          market: string;
          title: string;
          side: string;
          price: number;
          size: number;
          timestamp: string;
        }>();

      if (trades && trades.length > 0) {
        return jsonCors(trades, request);
      }
      // Fall through to Python API if no copy trades
    }

    if (url.pathname === "/api/trades/clear") {
      const id = env.FIREHOSE.idFromName("singleton");
      const obj = env.FIREHOSE.get(id);
      const doResp = await obj.fetch(
        new Request("https://dummy/firehose/clear", { method: "POST" }),
      );
      return jsonCors(await doResp.json(), request);
    }

    if (url.pathname === "/api/stats") {
      // Merge firehose + copy listener stats
      const firehoseId = env.FIREHOSE.idFromName("singleton");
      const firehoseObj = env.FIREHOSE.get(firehoseId);
      const firehoseResp = await firehoseObj.fetch(
        new Request("https://dummy/firehose/status"),
      );
      const firehose = (await firehoseResp.json()) as Record<string, unknown>;

      const listenerId = env.LISTENER.idFromName("singleton");
      const listenerObj = env.LISTENER.get(listenerId);
      const listenerResp = await listenerObj.fetch(
        new Request("https://dummy/status"),
      );
      const listener = (await listenerResp.json()) as Record<string, unknown>;

      // Count copy trades and targets + DB sizes
      const fdb = env.FIREHOSE_DB ?? env.DB;

      const [
        copyTradeRow,
        targetRow,
        botRow,
        suspectRow,
        firehoseTradeRow,
        firehoseWalletRow,
      ] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) as cnt FROM copy_trades").first<{
          cnt: number;
        }>(),
        env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM copy_targets WHERE active = 1",
        ).first<{ cnt: number }>(),
        fdb
          .prepare("SELECT COUNT(DISTINCT taker) as cnt FROM firehose_trades")
          .first<{ cnt: number }>(),
        env.DB.prepare("SELECT COUNT(*) as cnt FROM suspect_bots").first<{
          cnt: number;
        }>(),
        fdb
          .prepare("SELECT COUNT(*) as cnt FROM firehose_trades")
          .first<{ cnt: number }>(),
        fdb
          .prepare("SELECT COUNT(*) as cnt FROM firehose_wallets")
          .first<{ cnt: number }>(),
      ]);

      // Get DB sizes from D1 query metadata (size_after is returned on every query)
      const [opsMetaResult, firehoseMetaResult] = await Promise.all([
        env.DB.prepare("SELECT 1").run(),
        fdb.prepare("SELECT 1").run(),
      ]);
      const opsSizeBytes =
        ((opsMetaResult.meta as Record<string, unknown>)
          ?.size_after as number) ?? 0;
      const firehoseSizeBytes =
        ((firehoseMetaResult.meta as Record<string, unknown>)
          ?.size_after as number) ?? 0;

      return jsonCors(
        {
          trade_count: firehose.trade_count ?? 0,
          wallet_count: firehose.wallet_count ?? 0,
          bot_count: suspectRow?.cnt ?? 0,
          copy_targets: targetRow?.cnt ?? 0,
          listening: firehose.running ?? false,
          listener_new_trades: firehose.trade_count ?? 0,
          listener_polls: firehose.polls ?? 0,
          listener_cumulative_seconds: 0,
          copy_listening: listener.running ?? false,
          copy_trade_count: copyTradeRow?.cnt ?? 0,
          unique_wallets: botRow?.cnt ?? 0,
          db_ops: {
            copy_trades: copyTradeRow?.cnt ?? 0,
            copy_targets: targetRow?.cnt ?? 0,
            suspect_bots: suspectRow?.cnt ?? 0,
            size_mb: Math.round((opsSizeBytes / 1048576) * 100) / 100,
          },
          db_firehose: {
            firehose_trades: firehoseTradeRow?.cnt ?? 0,
            firehose_wallets: firehoseWalletRow?.cnt ?? 0,
            size_mb: Math.round((firehoseSizeBytes / 1048576) * 100) / 100,
          },
        },
        request,
      );
    }

    // ── Copy listener routes (existing) ────────────────────────────

    if (["/start", "/stop"].includes(url.pathname)) {
      const id = env.LISTENER.idFromName("singleton");
      const obj = env.LISTENER.get(id);
      const doResp = await obj.fetch(request);
      return jsonCors(await doResp.json(), request);
    }

    if (url.pathname === "/status") {
      const id = env.LISTENER.idFromName("singleton");
      const obj = env.LISTENER.get(id);
      const doResp = await obj.fetch(request);
      const doStatus = (await doResp.json()) as Record<string, unknown>;
      const { results } = await env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM copy_trades",
      ).all<{ cnt: number }>();
      const tradeCount = results?.[0]?.cnt ?? 0;
      return jsonCors({ ...doStatus, trade_count: tradeCount }, request);
    }

    // ── Copy trading routes (D1-backed) ──────────────────────────────

    if (
      url.pathname === "/targets" ||
      url.pathname === "/api/copy/targets" ||
      url.pathname === "/api/copy/targets/cloud"
    ) {
      // Fetch targets (username now stored directly on copy_targets)
      const { results: targets } = await env.DB.prepare(
        `SELECT ct.*,
                CASE WHEN ct.username != '' THEN ct.username
                     ELSE COALESCE(sb.username, '') END as display_username
         FROM copy_targets ct
         LEFT JOIN suspect_bots sb ON ct.wallet = sb.wallet`,
      ).all<CopyTarget & { username: string; display_username: string }>();

      // Fetch all filled trades for FIFO P&L computation
      const { results: allTrades } = await env.DB.prepare(
        `SELECT source_wallet, market, asset_id, side, price, size, timestamp, fee_amount, title
         FROM copy_trades WHERE status = 'filled'
         ORDER BY timestamp`,
      ).all<TradeRowWithMarket & { source_wallet: string; title: string }>();

      // Group trades by wallet
      const tradesByWallet = new Map<
        string,
        (TradeRowWithMarket & { source_wallet: string; title: string })[]
      >();
      for (const t of allTrades ?? []) {
        const arr = tradesByWallet.get(t.source_wallet);
        if (arr) arr.push(t);
        else tradesByWallet.set(t.source_wallet, [t]);
      }

      const enriched = (targets ?? []).map((r) => {
        const walletTrades = tradesByWallet.get(r.wallet) ?? [];
        const tradeCount = walletTrades.length;
        const pnl = tradeCount > 0 ? computeFifoPnl(walletTrades) : null;

        let listening_hours = 0;
        if (tradeCount > 0) {
          const first = new Date(walletTrades[0].timestamp).getTime();
          const last = new Date(
            walletTrades[tradeCount - 1].timestamp,
          ).getTime();
          if (first && last) {
            listening_hours =
              Math.round(((last - first) / 3_600_000) * 10) / 10;
          }
        }

        const categories = walletCategories(walletTrades);

        const openCount = pnl?.open_positions.length ?? 0;
        const wins = pnl?.wins ?? 0;
        const losses = pnl?.losses ?? 0;
        const rated = wins + losses;
        const winRate = rated > 0 ? Math.round((wins / rated) * 1000) / 10 : 0;
        const peakCap = pnl?.peak_capital ?? 0;
        const realizedPnl = pnl?.realized_pnl ?? 0;

        return {
          wallet: r.wallet,
          username: r.display_username || r.username || "",
          mode: r.mode,
          trade_pct: r.trade_pct,
          max_position_usd: r.max_position_usd,
          active: !!r.active,
          total_paper_pnl: realizedPnl,
          total_real_pnl: r.total_real_pnl,
          slippage_bps: r.slippage_bps,
          latency_ms: r.latency_ms,
          fee_rate: r.fee_rate,
          measured_slippage_bps: r.measured_slippage_bps,
          measured_latency_ms: -1,
          observations: 0,
          trade_count: tradeCount,
          listening_hours,
          avg_hold_time_hours: pnl?.avg_hold_time_hours ?? 0,
          peak_capital: peakCap,
          categories,
          wins,
          losses,
          win_rate: winRate,
          open_positions_count: openCount,
          roi_pct:
            peakCap > 0 ? Math.round((realizedPnl / peakCap) * 1000) / 10 : 0,
          circuit_breaker_usd: r.circuit_breaker_usd ?? 50,
          circuit_triggered_at: r.circuit_triggered_at ?? null,
          virtual_balance: r.virtual_balance ?? 1000,
          virtual_balance_initial: r.virtual_balance_initial ?? 1000,
        };
      });
      return jsonCors(enriched, request);
    }

    if (
      url.pathname === "/trades" ||
      url.pathname === "/api/copy/trades" ||
      url.pathname === "/api/copy/trades/cloud"
    ) {
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const wallet = url.searchParams.get("wallet") || "";
      const stmt = wallet
        ? env.DB.prepare(
            "SELECT * FROM copy_trades WHERE source_wallet = ? ORDER BY timestamp DESC LIMIT ?",
          ).bind(wallet, limit)
        : env.DB.prepare(
            "SELECT * FROM copy_trades ORDER BY timestamp DESC LIMIT ?",
          ).bind(limit);
      const { results } = await stmt.all<CopyTrade>();
      return jsonCors(results ?? [], request);
    }

    // Copy target comparison — source bot vs our copies
    const comparisonMatch = url.pathname.match(
      /^\/api\/copy\/comparison\/(0x[a-fA-F0-9]+)$/,
    );
    if (comparisonMatch) {
      const wallet = comparisonMatch[1].toLowerCase();

      // Our copy trades
      const { results: copyTrades } = await env.DB.prepare(
        `SELECT side, status, price, size, fee_amount, timestamp, source_price
         FROM copy_trades WHERE source_wallet = ?`,
      )
        .bind(wallet)
        .all<{
          side: string;
          status: string;
          price: number;
          size: number;
          fee_amount: number;
          timestamp: string;
          source_price: number;
        }>();

      const trades = copyTrades ?? [];
      const total = trades.length;
      const filled = trades.filter((t) => t.status === "filled");
      const buys = filled.filter((t) => t.side === "BUY");
      const sells = filled.filter((t) => t.side === "SELL");

      const buyAttempts = trades.filter((t) => t.side === "BUY").length;
      const sellAttempts = trades.filter((t) => t.side === "SELL").length;
      const buyFillRate =
        buyAttempts > 0
          ? Math.round((buys.length / buyAttempts) * 1000) / 10
          : 0;
      const sellFillRate =
        sellAttempts > 0
          ? Math.round((sells.length / sellAttempts) * 1000) / 10
          : 0;
      const overallFillRate =
        total > 0 ? Math.round((filled.length / total) * 1000) / 10 : 0;

      // Compute realized P&L from filled trades
      const buyNotional = buys.reduce((s, t) => s + t.price * t.size, 0);
      const sellNotional = sells.reduce((s, t) => s + t.price * t.size, 0);
      const totalFees = filled.reduce((s, t) => s + (t.fee_amount || 0), 0);
      const realizedPnl =
        Math.round((sellNotional - buyNotional - totalFees) * 100) / 100;

      // Average slippage (source_price vs exec_price)
      let slippageSum = 0;
      let slippageCount = 0;
      for (const t of filled) {
        if (t.source_price > 0 && t.price > 0) {
          slippageSum += Math.abs(t.price - t.source_price) / t.source_price;
          slippageCount++;
        }
      }
      const avgSlippageBps =
        slippageCount > 0
          ? Math.round((slippageSum / slippageCount) * 10000)
          : 0;

      // Source bot stats from leaderboard
      let sourceProfit = 0;
      try {
        const lbResp = await fetch(
          `https://lb-api.polymarket.com/profit?window=all&address=${wallet}`,
        );
        if (lbResp.ok) {
          const lbData = (await lbResp.json()) as
            | { amount?: number }
            | Array<{ amount?: number }>;
          if (Array.isArray(lbData) && lbData.length > 0) {
            sourceProfit = lbData[0].amount ?? 0;
          } else if (!Array.isArray(lbData)) {
            sourceProfit = (lbData as { amount?: number }).amount ?? 0;
          }
        }
      } catch {
        /* optional */
      }

      return jsonCors(
        {
          source: {
            wallet,
            pnl_all: Math.round(sourceProfit * 100) / 100,
          },
          ours: {
            trades_attempted: total,
            trades_filled: filled.length,
            fill_rate: overallFillRate,
            buy_fill_rate: buyFillRate,
            sell_fill_rate: sellFillRate,
            pnl_realized: realizedPnl,
            total_fees: Math.round(totalFees * 100) / 100,
            avg_slippage_bps: avgSlippageBps,
          },
          divergence: {
            missed_trades: total - filled.length,
            fill_rate_gap: Math.round((100 - overallFillRate) * 10) / 10,
          },
        },
        request,
      );
    }

    // Copy target detail — FIFO P&L breakdown
    const detailMatch = url.pathname.match(
      /^\/api\/copy\/detail\/(0x[a-fA-F0-9]+)$/,
    );
    if (detailMatch) {
      const wallet = detailMatch[1].toLowerCase();
      const { results: trades } = await env.DB.prepare(
        `SELECT market, asset_id, side, price, size, timestamp, fee_amount,
                source_price, exec_price
         FROM copy_trades
         WHERE source_wallet = ? AND status = 'filled'
         ORDER BY timestamp`,
      )
        .bind(wallet)
        .all<
          TradeRowWithMarket & { source_price: number; exec_price: number }
        >();

      const pnl = computeFifoPnl(trades ?? []);
      const totalTrades = trades?.length ?? 0;
      const winRate =
        pnl.wins + pnl.losses > 0
          ? Math.round((pnl.wins / (pnl.wins + pnl.losses)) * 1000) / 10
          : 0;

      // Compute total slippage cost from source_price vs exec_price
      let totalSlippageCost = 0;
      for (const t of trades ?? []) {
        totalSlippageCost += Math.abs(t.exec_price - t.source_price) * t.size;
      }

      // For open positions, entry_price ≈ implied probability at entry.
      // Without live CLOB calls we use entry_price as "current" estimate.
      const openPositions = pnl.open_positions.map((p) => {
        // entry_price is a reasonable proxy for current price on binary markets
        const estimatedPrice = p.entry_price;
        const unrealizedPnl =
          Math.round((estimatedPrice - p.entry_price) * p.size * 100) / 100;
        return {
          ...p,
          title: "",
          current_price: estimatedPrice,
          unrealized_pnl: unrealizedPnl,
        };
      });
      const totalUnrealizedPnl = openPositions.reduce(
        (sum, p) => sum + p.unrealized_pnl,
        0,
      );

      // Compute weighted average implied probability for open positions
      // entry_price IS the implied probability on binary Polymarket markets
      let openTotalNotional = 0;
      let openWeightedProb = 0;
      for (const p of pnl.open_positions) {
        const notional = p.entry_price * p.size;
        openTotalNotional += notional;
        // If bought at $0.80, implied 80% chance of resolving to $1.00
        openWeightedProb += p.entry_price * notional;
      }
      const avgImpliedProb =
        openTotalNotional > 0
          ? Math.round((openWeightedProb / openTotalNotional) * 1000) / 10
          : 0;
      // Expected value of open positions if they resolve at implied probabilities
      let openExpectedPnl = 0;
      for (const p of pnl.open_positions) {
        // EV = prob * (1 - entry) * size - (1 - prob) * entry * size
        // simplified: EV = size * (prob - entry_price), but prob ≈ entry_price so EV ≈ 0
        // More useful: if resolution at $1 happens with prob = entry_price:
        const winPnl = (1 - p.entry_price) * p.size; // profit if resolves YES
        const lossPnl = -p.entry_price * p.size; // loss if resolves NO
        openExpectedPnl +=
          p.entry_price * winPnl + (1 - p.entry_price) * lossPnl;
      }
      const openCapitalAtRisk = pnl.open_positions.reduce(
        (sum, p) => sum + p.entry_price * p.size,
        0,
      );

      return jsonCors(
        {
          summary: {
            total_trades: totalTrades,
            wins: pnl.wins,
            losses: pnl.losses,
            win_rate: winRate,
            open_positions_count: pnl.open_positions.length,
            total_realized_pnl: pnl.realized_pnl,
            total_unrealized_pnl: Math.round(totalUnrealizedPnl * 100) / 100,
            total_fees: pnl.total_fees,
            total_slippage_cost: Math.round(totalSlippageCost * 100) / 100,
            best_trade_pnl: pnl.best_trade_pnl,
            worst_trade_pnl: pnl.worst_trade_pnl,
            peak_capital: pnl.peak_capital,
          },
          outcome_breakdown: pnl.outcome_breakdown,
          open_position_stats: {
            count: pnl.open_positions.length,
            capital_at_risk: Math.round(openCapitalAtRisk * 100) / 100,
            avg_implied_prob: avgImpliedProb,
            expected_pnl: Math.round(openExpectedPnl * 100) / 100,
          },
          pnl_series: pnl.pnl_series,
          open_positions: openPositions,
          closed_positions: pnl.closed_positions.map((p) => ({
            ...p,
            title: "",
          })),
          missed_positions: [],
        },
        request,
      );
    }

    // ── Copy target mutations ──────────────────────────────────────
    if (url.pathname === "/api/copy/add" && request.method === "POST") {
      const body = (await request.json()) as {
        wallet: string;
        trade_pct?: number;
        max_position_usd?: number;
        slippage_bps?: number;
        latency_ms?: number;
        fee_rate?: number;
      };
      const w = body.wallet?.toLowerCase();
      if (!w) return jsonCors({ error: "wallet required" }, request, 400);

      // Fetch username from Polymarket activity API
      let username = "";
      try {
        const profResp = await fetch(
          `https://data-api.polymarket.com/activity?user=${w}&limit=1`,
        );
        if (profResp.ok) {
          const entries = (await profResp.json()) as Array<{
            name?: string;
          }>;
          const n = entries?.[0]?.name;
          if (n && !n.startsWith("0x")) username = n;
        }
      } catch {
        // username is optional
      }

      await env.DB.prepare(
        `INSERT OR REPLACE INTO copy_targets
         (wallet, mode, trade_pct, max_position_usd, active,
          total_paper_pnl, total_real_pnl,
          slippage_bps, latency_ms, fee_rate, measured_slippage_bps, username)
         VALUES (?, 'paper', ?, ?, 1, 0, 0, ?, ?, ?, -1, ?)`,
      )
        .bind(
          w,
          body.trade_pct ?? 100,
          body.max_position_usd ?? 10000,
          body.slippage_bps ?? 50,
          body.latency_ms ?? 2000,
          body.fee_rate ?? 0,
          username,
        )
        .run();
      return jsonCors(
        { status: "added", wallet: w, mode: "paper", username },
        request,
      );
    }

    if (url.pathname === "/api/copy/remove" && request.method === "POST") {
      const body = (await request.json()) as { wallet: string };
      const w = body.wallet?.toLowerCase();
      if (!w) return jsonCors({ error: "wallet required" }, request, 400);
      await env.DB.prepare(
        "UPDATE copy_targets SET active = 0 WHERE wallet = ?",
      )
        .bind(w)
        .run();
      return jsonCors({ status: "removed", wallet: w }, request);
    }

    if (url.pathname === "/api/copy/reactivate" && request.method === "POST") {
      const body = (await request.json()) as { wallet: string };
      const w = body.wallet?.toLowerCase();
      if (!w) return jsonCors({ error: "wallet required" }, request, 400);
      await env.DB.prepare(
        "UPDATE copy_targets SET active = 1 WHERE wallet = ?",
      )
        .bind(w)
        .run();
      return jsonCors({ status: "reactivated", wallet: w }, request);
    }

    if (url.pathname === "/api/copy/reset-paper" && request.method === "POST") {
      const body = (await request.json()) as { wallet: string };
      const w = body.wallet?.toLowerCase();
      if (!w) return jsonCors({ error: "wallet required" }, request, 400);

      // Delete all paper copy trades for this wallet
      await env.DB.prepare(
        "DELETE FROM copy_trades WHERE source_wallet = ? AND mode = 'paper'",
      )
        .bind(w)
        .run();

      // Reset virtual balance to initial
      await env.DB.prepare(
        "UPDATE copy_targets SET virtual_balance = virtual_balance_initial, circuit_triggered_at = NULL WHERE wallet = ?",
      )
        .bind(w)
        .run();

      return jsonCors({ status: "reset", wallet: w }, request);
    }

    if (url.pathname === "/api/copy/set-mode" && request.method === "POST") {
      const body = (await request.json()) as {
        wallet: string;
        mode: string;
      };
      const w = body.wallet?.toLowerCase();
      const mode = body.mode === "real" ? "real" : "paper";
      if (!w) return jsonCors({ error: "wallet required" }, request, 400);
      await env.DB.prepare("UPDATE copy_targets SET mode = ? WHERE wallet = ?")
        .bind(mode, w)
        .run();
      return jsonCors({ status: "updated", wallet: w, mode }, request);
    }

    // Update copy target settings (trade_pct, max_position_usd)
    if (url.pathname === "/api/copy/update" && request.method === "POST") {
      const body = (await request.json()) as {
        wallet: string;
        trade_pct?: number;
        max_position_usd?: number;
        full_copy_below_usd?: number;
        circuit_breaker_usd?: number;
      };
      const w = body.wallet?.toLowerCase();
      if (!w) return jsonCors({ error: "wallet required" }, request, 400);
      const updates: string[] = [];
      const values: (string | number)[] = [];
      if (body.trade_pct !== undefined) {
        updates.push("trade_pct = ?");
        values.push(body.trade_pct);
      }
      if (body.max_position_usd !== undefined) {
        updates.push("max_position_usd = ?");
        values.push(body.max_position_usd);
      }
      if (body.full_copy_below_usd !== undefined) {
        updates.push("full_copy_below_usd = ?");
        values.push(body.full_copy_below_usd);
      }
      if (body.circuit_breaker_usd !== undefined) {
        updates.push("circuit_breaker_usd = ?");
        values.push(body.circuit_breaker_usd);
      }
      if (updates.length === 0)
        return jsonCors({ error: "nothing to update" }, request, 400);
      values.push(w);
      await env.DB.prepare(
        `UPDATE copy_targets SET ${updates.join(", ")} WHERE wallet = ?`,
      )
        .bind(...values)
        .run();
      return jsonCors({ status: "updated", wallet: w }, request);
    }

    // Backfill usernames for all copy targets missing them
    if (
      url.pathname === "/api/copy/backfill-usernames" &&
      request.method === "POST"
    ) {
      const targets = await env.DB.prepare(
        "SELECT wallet FROM copy_targets WHERE username = '' OR username IS NULL",
      ).all<{ wallet: string }>();
      const results: Record<string, string> = {};
      for (const t of targets.results) {
        try {
          const resp = await fetch(
            `https://data-api.polymarket.com/activity?user=${t.wallet}&limit=1`,
          );
          if (resp.ok) {
            const entries = (await resp.json()) as Array<{ name?: string }>;
            const n = entries?.[0]?.name;
            if (n && !n.startsWith("0x")) {
              await env.DB.prepare(
                "UPDATE copy_targets SET username = ? WHERE wallet = ?",
              )
                .bind(n, t.wallet)
                .run();
              results[t.wallet] = n;
            }
          }
        } catch {
          // skip
        }
      }
      return jsonCors({ status: "backfilled", updated: results }, request);
    }

    // Backfill fees for copy trades with empty titles
    // Wallets that only trade crypto get fees applied; non-crypto wallets are skipped
    if (
      url.pathname === "/api/copy/backfill-fees" &&
      request.method === "POST"
    ) {
      const FEE_RATE = 0.0625;

      // Find wallets that have titled non-crypto trades (sports, politics, etc.)
      const nonCryptoWallets = await env.DB.prepare(
        `
        SELECT DISTINCT source_wallet FROM copy_trades
        WHERE title != ''
          AND title NOT LIKE '%Bitcoin%'
          AND title NOT LIKE '%Ethereum%'
          AND title NOT LIKE '%up or down%'
          AND title NOT LIKE '%above%'
          AND title NOT LIKE '%updown%'
      `,
      ).all<{ source_wallet: string }>();
      const skipWallets = new Set(
        nonCryptoWallets.results.map((r) => r.source_wallet),
      );

      // Get all trades needing fee backfill (empty title, zero fee)
      const trades = await env.DB.prepare(
        `
        SELECT id, source_wallet, exec_price, size FROM copy_trades
        WHERE title = '' AND fee_amount = 0
      `,
      ).all<{
        id: number;
        source_wallet: string;
        exec_price: number;
        size: number;
      }>();

      let updated = 0;
      let skipped = 0;
      const batchSize = 50;
      const stmts: Array<ReturnType<typeof env.DB.prepare>> = [];

      for (const t of trades.results) {
        if (skipWallets.has(t.source_wallet)) {
          skipped++;
          continue;
        }
        const feePerShare = t.exec_price * (1 - t.exec_price) * FEE_RATE;
        const feeAmount = feePerShare * t.size;
        stmts.push(
          env.DB.prepare(
            "UPDATE copy_trades SET fee_amount = ? WHERE id = ?",
          ).bind(feeAmount, t.id),
        );
        updated++;
      }

      // Execute in batches (D1 batch limit)
      for (let i = 0; i < stmts.length; i += batchSize) {
        await env.DB.batch(stmts.slice(i, i + batchSize));
      }

      // Also fix the few titled crypto trades that have fee_amount = 0
      const cryptoFix = await env.DB.prepare(
        `
        SELECT id, exec_price, size FROM copy_trades
        WHERE fee_amount = 0
          AND (title LIKE '%Bitcoin%' OR title LIKE '%Ethereum%'
               OR title LIKE '%up or down%' OR title LIKE '%above%'
               OR title LIKE '%updown%')
      `,
      ).all<{ id: number; exec_price: number; size: number }>();

      const cryptoStmts: Array<ReturnType<typeof env.DB.prepare>> = [];
      for (const t of cryptoFix.results) {
        const feePerShare = t.exec_price * (1 - t.exec_price) * FEE_RATE;
        const feeAmount = feePerShare * t.size;
        cryptoStmts.push(
          env.DB.prepare(
            "UPDATE copy_trades SET fee_amount = ? WHERE id = ?",
          ).bind(feeAmount, t.id),
        );
      }
      for (let i = 0; i < cryptoStmts.length; i += batchSize) {
        await env.DB.batch(cryptoStmts.slice(i, i + batchSize));
      }

      return jsonCors(
        {
          status: "backfilled",
          crypto_wallets_updated: updated,
          non_crypto_wallets_skipped: skipped,
          titled_crypto_fixed: cryptoFix.results.length,
          total_processed: trades.results.length,
        },
        request,
      );
    }

    if (url.pathname === "/sync" && request.method === "POST") {
      const targets: CopyTarget[] = await request.json();
      const stmt = env.DB.prepare(
        `INSERT OR REPLACE INTO copy_targets
         (wallet, mode, trade_pct, max_position_usd, active,
          total_paper_pnl, total_real_pnl,
          slippage_bps, latency_ms, fee_rate, measured_slippage_bps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const batch = targets.map((t) =>
        stmt.bind(
          t.wallet,
          t.mode,
          t.trade_pct,
          t.max_position_usd,
          t.active,
          t.total_paper_pnl,
          t.total_real_pnl,
          t.slippage_bps,
          t.latency_ms,
          t.fee_rate,
          t.measured_slippage_bps,
        ),
      );
      if (batch.length > 0) await env.DB.batch(batch);
      return jsonCors({ status: "synced", count: targets.length }, request);
    }

    // ── Python API proxy (Cloud Run) ──────────────────────────────────

    if (env.PYTHON_API_URL) {
      const pyUrl = `${env.PYTHON_API_URL}${url.pathname}${url.search}`;
      try {
        const pyResp = await fetch(pyUrl, {
          method: request.method,
          headers: { "Content-Type": "application/json" },
          body: request.method !== "GET" ? await request.text() : undefined,
        });
        const data = await pyResp.text();
        return new Response(data, {
          status: pyResp.status,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin),
          },
        });
      } catch {
        return jsonCors(
          {
            error: "python_unavailable",
            message: "Python backend not reachable",
          },
          request,
          502,
        );
      }
    }

    return jsonCors(
      { error: "not_found", message: "Unknown route" },
      request,
      404,
    );
  },

  // Cron trigger: auto-start DOs unless the user explicitly stopped them
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    // Auto-start copy listener
    const listenerId = env.LISTENER.idFromName("singleton");
    const listenerObj = env.LISTENER.get(listenerId);
    const listenerResp = await listenerObj.fetch(
      new Request("https://dummy/status"),
    );
    const listenerStatus = (await listenerResp.json()) as {
      running: boolean;
      userStopped?: boolean;
    };
    if (!listenerStatus.running && !listenerStatus.userStopped) {
      await listenerObj.fetch(
        new Request("https://dummy/start", { method: "POST" }),
      );
    }

    // Auto-start firehose
    const firehoseId = env.FIREHOSE.idFromName("singleton");
    const firehoseObj = env.FIREHOSE.get(firehoseId);
    const firehoseResp = await firehoseObj.fetch(
      new Request("https://dummy/firehose/status"),
    );
    const firehoseStatus = (await firehoseResp.json()) as {
      running: boolean;
      userStopped?: boolean;
    };
    if (!firehoseStatus.running && !firehoseStatus.userStopped) {
      await firehoseObj.fetch(
        new Request("https://dummy/firehose/start", { method: "POST" }),
      );
    }

    // Auto-start watchlist DO (if there are entries)
    try {
      const wlCount = await env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM watchlist",
      ).first<{ cnt: number }>();
      if (wlCount && wlCount.cnt > 0) {
        const wlId = env.WATCHLIST.idFromName("singleton");
        const wlObj = env.WATCHLIST.get(wlId);
        const wlResp = await wlObj.fetch(new Request("https://dummy/status"));
        const wlStatus = (await wlResp.json()) as {
          running: boolean;
          userStopped?: boolean;
        };
        if (!wlStatus.running && !wlStatus.userStopped) {
          await wlObj.fetch(
            new Request("https://dummy/start", { method: "POST" }),
          );
        }
      }
    } catch {
      // watchlist table might not exist yet
    }
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
