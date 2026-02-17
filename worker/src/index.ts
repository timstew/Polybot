import { pollCycle } from "./listener";
import type { CopyTarget, CopyTrade, Env } from "./types";

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

    // Durable Object control routes
    if (["/start", "/stop"].includes(url.pathname)) {
      const id = env.LISTENER.idFromName("singleton");
      const obj = env.LISTENER.get(id);
      return obj.fetch(request);
    }

    // Status: merge DO status with trade count from D1
    if (url.pathname === "/status") {
      const id = env.LISTENER.idFromName("singleton");
      const obj = env.LISTENER.get(id);
      const doResp = await obj.fetch(request);
      const doStatus = (await doResp.json()) as Record<string, unknown>;
      const { results } = await env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM copy_trades",
      ).all<{ cnt: number }>();
      const tradeCount = results?.[0]?.cnt ?? 0;
      return json({ ...doStatus, trade_count: tradeCount });
    }

    // GET /targets — read copy_targets from D1
    if (url.pathname === "/targets" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM copy_targets",
      ).all<CopyTarget>();
      return json(results ?? []);
    }

    // GET /trades — read recent copy_trades from D1
    if (url.pathname === "/trades" && request.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const { results } = await env.DB.prepare(
        "SELECT * FROM copy_trades ORDER BY timestamp DESC LIMIT ?",
      )
        .bind(limit)
        .all<CopyTrade>();
      return json(results ?? []);
    }

    // POST /sync — receive copy_targets from local app, upsert into D1
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
      return json({ status: "synced", count: targets.length });
    }

    return json({ service: "polybot-copy-listener" });
  },

  // Cron trigger: auto-start unless the user explicitly stopped it
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
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
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
