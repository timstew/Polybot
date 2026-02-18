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
      // Return detected bots from D1 — the cloud equivalent of the local unified endpoint
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
          detected_at: string;
        }>();
      return jsonCors(
        (results ?? []).map((r) => ({
          wallet: r.wallet,
          confidence: r.confidence,
          category: r.category,
          trade_count: r.trade_count,
          tags: JSON.parse(r.tags || "[]"),
          // Provide defaults for fields the dashboard expects
          pnl_pct: 0,
          realized_pnl: 0,
          unrealized_pnl: 0,
          win_rate: 0,
          total_volume_usd: 0,
          active_positions: 0,
          portfolio_value: 0,
          market_categories: [],
          copy_score: 0,
          avg_hold_time_hours: 0,
          trades_per_market: 0,
          avg_market_burst: 0,
          max_market_burst: 0,
          market_concentration: 0,
        })),
        request,
      );
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

      // Count copy trades and targets
      const [copyTradeRow, targetRow, botRow, suspectRow] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) as cnt FROM copy_trades").first<{
          cnt: number;
        }>(),
        env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM copy_targets WHERE active = 1",
        ).first<{ cnt: number }>(),
        env.DB.prepare(
          "SELECT COUNT(DISTINCT taker) as cnt FROM firehose_trades",
        ).first<{ cnt: number }>(),
        env.DB.prepare("SELECT COUNT(*) as cnt FROM suspect_bots").first<{
          cnt: number;
        }>(),
      ]);

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

    if (url.pathname === "/targets" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM copy_targets",
      ).all<CopyTarget>();
      return jsonCors(results ?? [], request);
    }

    if (url.pathname === "/trades" && request.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const { results } = await env.DB.prepare(
        "SELECT * FROM copy_trades ORDER BY timestamp DESC LIMIT ?",
      )
        .bind(limit)
        .all<CopyTrade>();
      return jsonCors(results ?? [], request);
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
