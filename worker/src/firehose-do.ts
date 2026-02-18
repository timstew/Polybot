import type { Env } from "./types";

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

const LEADERBOARD_CATEGORIES = [
  "POLITICS",
  "ECONOMICS",
  "TECH",
  "FINANCE",
  "SPORTS",
];
const LEADERBOARD_PERIODS = ["DAY", "WEEK", "MONTH", "ALL"];
const HARVEST_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const POLL_INTERVAL_MS = 5_000; // 5 seconds

interface TradeItem {
  transactionHash?: string;
  id?: string;
  conditionId?: string;
  market?: string;
  asset?: string;
  asset_id?: string;
  side?: string;
  price?: number;
  size?: number;
  timestamp?: number | string;
  createdAt?: string;
  proxyWallet?: string;
  taker?: string;
  title?: string;
  outcome?: string;
}

// ── FirehoseDO ─────────────────────────────────────────────────────

export class FirehoseDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private seenIds = new Set<string>();
  private pollCount = 0;

  // Detection state (in-memory, survives across alarm cycles while DO is alive)
  private detectRunning = false;
  private detectOffset = 0;
  private detectBotsFound = 0;
  private detectWalletsScanned = 0;
  private detectTotalWallets = 0;
  private detectMinTrades = 1;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** Shorthand: firehose DB for trades/wallets (high-volume). */
  private get fdb(): D1Database {
    return this.env.FIREHOSE_DB ?? this.env.DB;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/firehose/start") {
      await this.state.storage.put("userStopped", false);
      await this.state.storage.setAlarm(Date.now() + 1000);
      return json({ status: "started" });
    }

    if (url.pathname === "/firehose/stop") {
      await this.state.storage.put("userStopped", true);
      await this.state.storage.deleteAlarm();
      this.pollCount = 0;
      return json({ status: "stopped" });
    }

    if (url.pathname === "/firehose/status") {
      const alarm = await this.state.storage.getAlarm();
      const userStopped =
        (await this.state.storage.get("userStopped")) ?? false;

      // Query firehose DB for counts
      const [tradeRow, walletRow] = await Promise.all([
        this.fdb
          .prepare("SELECT COUNT(*) as cnt FROM firehose_trades")
          .first<{ cnt: number }>(),
        this.fdb
          .prepare("SELECT COUNT(*) as cnt FROM firehose_wallets")
          .first<{ cnt: number }>(),
      ]);

      return json({
        running: alarm !== null,
        polls: this.pollCount,
        userStopped,
        trade_count: tradeRow?.cnt ?? 0,
        wallet_count: walletRow?.cnt ?? 0,
      });
    }

    if (url.pathname === "/firehose/detect/start") {
      if (this.detectRunning) {
        return json({
          status: "already_running",
          progress: this.detectProgress(),
        });
      }
      const params = new URL(request.url).searchParams;
      this.detectMinTrades = Number(params.get("min_trades") ?? "10");
      // Count total wallets to scan
      const countRow = await this.fdb
        .prepare(
          "SELECT COUNT(*) as cnt FROM firehose_wallets WHERE trade_count >= ?",
        )
        .bind(this.detectMinTrades)
        .first<{ cnt: number }>();
      this.detectTotalWallets = countRow?.cnt ?? 0;
      this.detectOffset = 0;
      this.detectBotsFound = 0;
      this.detectWalletsScanned = 0;
      this.detectRunning = true;
      // Ensure alarm is running to process batches
      const alarm = await this.state.storage.getAlarm();
      if (!alarm) {
        await this.state.storage.setAlarm(Date.now() + 500);
      }
      return json({
        status: "started",
        total_wallets: this.detectTotalWallets,
      });
    }

    if (url.pathname === "/firehose/detect/status") {
      return json({
        running: this.detectRunning,
        ...this.detectProgress(),
      });
    }

    if (url.pathname === "/firehose/detect/stop") {
      this.detectRunning = false;
      return json({ status: "stopped", ...this.detectProgress() });
    }

    if (url.pathname === "/firehose/clear") {
      await this.fdb.batch([
        this.fdb.prepare("DELETE FROM firehose_trades"),
        this.fdb.prepare("DELETE FROM firehose_wallets"),
      ]);
      this.seenIds.clear();
      this.pollCount = 0;
      return json({ status: "cleared" });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    try {
      await this.pollTrades();
      this.pollCount++;

      // Check if it's time for a wallet harvest
      const lastHarvest =
        ((await this.state.storage.get("lastHarvestTime")) as number) ?? 0;
      if (Date.now() - lastHarvest >= HARVEST_INTERVAL_MS) {
        await this.harvestWallets();
        await this.state.storage.put("lastHarvestTime", Date.now());
      }

      // Process a detection batch if running
      if (this.detectRunning) {
        await this.processDetectBatch();
      }
    } catch (e) {
      console.error("FirehoseDO poll error:", e);
    }

    // Re-schedule (use shorter interval if detection is running)
    const userStopped = (await this.state.storage.get("userStopped")) ?? false;
    if (userStopped && !this.detectRunning) return;
    const interval = this.detectRunning ? 1_000 : POLL_INTERVAL_MS;
    await this.state.storage.setAlarm(Date.now() + interval);
  }

  private detectProgress() {
    return {
      bots_found: this.detectBotsFound,
      wallets_scanned: this.detectWalletsScanned,
      total_wallets: this.detectTotalWallets,
    };
  }

  private async processDetectBatch(): Promise<void> {
    if (!this.env.PYTHON_API_URL) {
      this.detectRunning = false;
      return;
    }

    const BATCH_SIZE = 100;
    const { results } = await this.fdb
      .prepare(
        "SELECT wallet FROM firehose_wallets WHERE trade_count >= ? ORDER BY trade_count DESC LIMIT ? OFFSET ?",
      )
      .bind(this.detectMinTrades, BATCH_SIZE, this.detectOffset)
      .all<{ wallet: string }>();

    const wallets = (results ?? []).map((r) => r.wallet);
    if (wallets.length === 0) {
      // Done — no more wallets
      this.detectRunning = false;
      console.log(
        `Detection complete: ${this.detectBotsFound} bots from ${this.detectWalletsScanned} wallets`,
      );
      return;
    }

    try {
      const pyUrl = `${this.env.PYTHON_API_URL}/api/detect/cloud?min_trades=${this.detectMinTrades}&min_confidence=0.5`;
      const pyResp = await fetch(pyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(wallets),
      });
      const data = (await pyResp.json()) as {
        bots_found?: number;
        wallets_scanned?: number;
        bots?: Array<{
          wallet: string;
          confidence: number;
          category: string;
          trade_count: number;
          tags: string[];
          username?: string;
          pnl_pct?: number;
          realized_pnl?: number;
          win_rate?: number;
          total_volume_usd?: number;
          profit_1d?: number;
          profit_7d?: number;
          profit_30d?: number;
          profit_all?: number;
          copy_score?: number;
        }>;
      };
      this.detectBotsFound += data.bots_found ?? 0;
      this.detectWalletsScanned += data.wallets_scanned ?? 0;

      // Store detected bots in D1
      if (data.bots && data.bots.length > 0) {
        const stmt = this.env.DB.prepare(
          `INSERT OR REPLACE INTO suspect_bots
           (wallet, confidence, category, trade_count, tags, detected_at,
            pnl_pct, realized_pnl, win_rate, total_volume_usd,
            profit_1d, profit_7d, profit_30d, profit_all, username, copy_score)
           VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const batch = data.bots.map((b) =>
          stmt.bind(
            b.wallet,
            b.confidence,
            b.category,
            b.trade_count,
            JSON.stringify(b.tags),
            b.pnl_pct ?? 0,
            b.realized_pnl ?? 0,
            b.win_rate ?? 0,
            b.total_volume_usd ?? 0,
            b.profit_1d ?? 0,
            b.profit_7d ?? 0,
            b.profit_30d ?? 0,
            b.profit_all ?? 0,
            b.username ?? "",
            b.copy_score ?? 0,
          ),
        );
        for (let i = 0; i < batch.length; i += 100) {
          await this.env.DB.batch(batch.slice(i, i + 100));
        }
      }
    } catch (e) {
      console.error("Detection batch failed:", e);
    }

    this.detectOffset += BATCH_SIZE;
    if (wallets.length < BATCH_SIZE) {
      // Last batch
      this.detectRunning = false;
      console.log(
        `Detection complete: ${this.detectBotsFound} bots from ${this.detectWalletsScanned} wallets`,
      );
    }
  }

  // ── Trade polling ────────────────────────────────────────────────

  private async pollTrades(): Promise<void> {
    const url = `${DATA_API}/trades?limit=500&_t=${Date.now()}`;
    const resp = await fetch(url);
    if (!resp.ok) return;

    const items: TradeItem[] = await resp.json();
    if (!items.length) return;

    const newTrades: TradeItem[] = [];
    for (const item of items) {
      const id = item.transactionHash || item.id || "";
      if (!id || this.seenIds.has(id)) continue;
      this.seenIds.add(id);
      newTrades.push(item);
    }

    // Prune seen IDs if too large
    if (this.seenIds.size > 50_000) {
      this.seenIds.clear();
    }

    if (!newTrades.length) return;

    // Batch insert trades into firehose DB
    const tradeStmt = this.fdb.prepare(
      `INSERT OR IGNORE INTO firehose_trades
       (id, market, asset_id, side, price, size, timestamp, taker, title, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const walletStmt = this.fdb.prepare(
      `INSERT INTO firehose_wallets (wallet, source, trade_count)
       VALUES (?, 'trade', 1)
       ON CONFLICT(wallet) DO UPDATE SET trade_count = trade_count + 1`,
    );

    const batch: D1PreparedStatement[] = [];
    const seenWallets = new Set<string>();

    for (const item of newTrades) {
      const id = item.transactionHash || item.id || "";
      const market = item.conditionId || item.market || "";
      const assetId = item.asset || item.asset_id || "";
      const side = (item.side || "BUY").toUpperCase();
      const price = item.price ?? 0;
      const size = item.size ?? 0;
      const taker = item.proxyWallet || item.taker || "";
      const title = item.title || "";
      const outcome = item.outcome || "";

      // Parse timestamp to ISO string
      let ts = "";
      const raw = item.timestamp ?? item.createdAt;
      if (typeof raw === "number") {
        ts = new Date(raw > 1e12 ? raw : raw * 1000).toISOString();
      } else if (typeof raw === "string") {
        const n = Number(raw);
        if (!isNaN(n)) {
          ts = new Date(n > 1e12 ? n : n * 1000).toISOString();
        } else {
          ts = raw;
        }
      }

      batch.push(
        tradeStmt.bind(
          id,
          market,
          assetId,
          side,
          price,
          size,
          ts,
          taker,
          title,
          outcome,
        ),
      );

      // Track wallet
      if (taker && !seenWallets.has(taker)) {
        seenWallets.add(taker);
        batch.push(walletStmt.bind(taker));
      }
    }

    // D1 batch limit is 100 statements — chunk if needed
    for (let i = 0; i < batch.length; i += 100) {
      await this.fdb.batch(batch.slice(i, i + 100));
    }

    // Retention pruning: delete firehose_trades older than 7 days
    try {
      await this.fdb
        .prepare(
          "DELETE FROM firehose_trades WHERE timestamp < datetime('now', '-7 days')",
        )
        .run();
    } catch {
      // non-critical
    }
  }

  // ── Wallet harvesting ────────────────────────────────────────────

  private async harvestWallets(): Promise<void> {
    const wallets = new Set<string>();

    // 1. Leaderboard sweep
    for (const category of LEADERBOARD_CATEGORIES) {
      for (const period of LEADERBOARD_PERIODS) {
        try {
          const resp = await fetch(
            `${DATA_API}/v1/leaderboard?category=${category}&timePeriod=${period}&orderBy=PNL&limit=50&offset=0`,
          );
          if (!resp.ok) continue;
          const entries: Array<{ proxyWallet?: string }> = await resp.json();
          for (const e of entries) {
            if (e.proxyWallet) wallets.add(e.proxyWallet);
          }
        } catch {
          // skip
        }
      }
    }

    // 2. Top market position holders
    try {
      const marketsResp = await fetch(
        `${GAMMA_API}/markets?active=true&limit=20&order=volume24hr&ascending=false`,
      );
      if (marketsResp.ok) {
        const markets: Array<{ conditionId?: string }> =
          await marketsResp.json();
        for (const m of markets) {
          if (!m.conditionId) continue;
          try {
            const posResp = await fetch(
              `${DATA_API}/v1/market-positions?market=${m.conditionId}&limit=500&status=ALL`,
            );
            if (!posResp.ok) continue;
            const positions: Array<{ proxyWallet?: string }> =
              await posResp.json();
            for (const p of positions) {
              if (p.proxyWallet) wallets.add(p.proxyWallet);
            }
          } catch {
            // skip
          }
        }
      }
    } catch {
      // skip
    }

    if (!wallets.size) return;

    // Insert harvested wallets into firehose DB
    const stmt = this.fdb.prepare(
      `INSERT OR IGNORE INTO firehose_wallets (wallet, source)
       VALUES (?, 'harvest')`,
    );

    const batch = Array.from(wallets).map((w) => stmt.bind(w));
    for (let i = 0; i < batch.length; i += 100) {
      await this.fdb.batch(batch.slice(i, i + 100));
    }

    console.log(`Harvested ${wallets.size} wallets`);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
