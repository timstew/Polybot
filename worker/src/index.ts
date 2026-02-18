import { pollCycle } from "./listener";
import type { CopyTarget, CopyTrade, Env } from "./types";

export { FirehoseDO } from "./firehose-do";

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
  };
}

// ── Durable Object: self-scheduling copy listener ──────────────────

export class CopyListenerDO implements DurableObject {
  private seenIds = new Set<string>();
  private lastCopy = new Map<string, number>();
  private state: DurableObjectState;
  private env: Env;
  private pollCount = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      await this.state.storage.put("userStopped", false);
      await this.state.storage.setAlarm(Date.now() + 1000);
      return json({ status: "started" });
    }

    if (url.pathname === "/stop") {
      await this.state.storage.put("userStopped", true);
      await this.state.storage.deleteAlarm();
      this.pollCount = 0;
      return json({ status: "stopped" });
    }

    if (url.pathname === "/status") {
      const alarm = await this.state.storage.getAlarm();
      const userStopped =
        (await this.state.storage.get("userStopped")) ?? false;
      return json({
        running: alarm !== null,
        polls: this.pollCount,
        userStopped,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    try {
      await pollCycle(this.env.DB, this.seenIds, this.lastCopy);
      this.pollCount++;
    } catch (e) {
      console.error("Poll cycle error:", e);
    }
    // Re-schedule next poll in 5 seconds
    await this.state.storage.setAlarm(Date.now() + 5000);
  }
}

// ── Worker fetch handler ───────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
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
      const top = Math.min(Number(url.searchParams.get("top") ?? "200"), 500);
      const { results } = await env.DB.prepare(
        "SELECT * FROM suspect_bots ORDER BY confidence DESC LIMIT ?",
      )
        .bind(top)
        .all<{
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
        }>();
      return jsonCors(
        (results ?? []).map((r) => {
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
        }),
        request,
      );
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
        `SELECT source_wallet, market, asset_id, side, price, size, timestamp, fee_amount
         FROM copy_trades WHERE status = 'filled'
         ORDER BY timestamp`,
      ).all<TradeRowWithMarket & { source_wallet: string }>();

      // Group trades by wallet
      const tradesByWallet = new Map<
        string,
        (TradeRowWithMarket & { source_wallet: string })[]
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

        return {
          wallet: r.wallet,
          username: r.display_username || r.username || "",
          mode: r.mode,
          trade_pct: r.trade_pct,
          max_position_usd: r.max_position_usd,
          active: !!r.active,
          total_paper_pnl: pnl?.realized_pnl ?? 0,
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
          peak_capital: pnl?.peak_capital ?? 0,
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

      return jsonCors(
        {
          summary: {
            total_trades: totalTrades,
            wins: pnl.wins,
            losses: pnl.losses,
            win_rate: winRate,
            total_realized_pnl: pnl.realized_pnl,
            total_unrealized_pnl: 0,
            total_fees: pnl.total_fees,
            total_slippage_cost: Math.round(totalSlippageCost * 100) / 100,
            best_trade_pnl: pnl.best_trade_pnl,
            worst_trade_pnl: pnl.worst_trade_pnl,
            peak_capital: pnl.peak_capital,
          },
          pnl_series: pnl.pnl_series,
          open_positions: pnl.open_positions.map((p) => ({
            ...p,
            title: "",
            current_price: 0,
            unrealized_pnl: 0,
          })),
          closed_positions: pnl.closed_positions.slice(0, 100).map((p) => ({
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
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
