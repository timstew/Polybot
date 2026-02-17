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

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
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

      // Query D1 for counts
      const [tradeRow, walletRow] = await Promise.all([
        this.env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM firehose_trades",
        ).first<{ cnt: number }>(),
        this.env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM firehose_wallets",
        ).first<{ cnt: number }>(),
      ]);

      return json({
        running: alarm !== null,
        polls: this.pollCount,
        userStopped,
        trade_count: tradeRow?.cnt ?? 0,
        wallet_count: walletRow?.cnt ?? 0,
      });
    }

    if (url.pathname === "/firehose/clear") {
      await this.env.DB.batch([
        this.env.DB.prepare("DELETE FROM firehose_trades"),
        this.env.DB.prepare("DELETE FROM firehose_wallets"),
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
    } catch (e) {
      console.error("FirehoseDO poll error:", e);
    }

    // Re-schedule
    await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
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

    // Batch insert trades into D1
    const tradeStmt = this.env.DB.prepare(
      `INSERT OR IGNORE INTO firehose_trades
       (id, market, asset_id, side, price, size, timestamp, taker, title, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const walletStmt = this.env.DB.prepare(
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
        tradeStmt.bind(id, market, assetId, side, price, size, ts, taker, title, outcome),
      );

      // Track wallet
      if (taker && !seenWallets.has(taker)) {
        seenWallets.add(taker);
        batch.push(walletStmt.bind(taker));
      }
    }

    // D1 batch limit is 100 statements — chunk if needed
    for (let i = 0; i < batch.length; i += 100) {
      await this.env.DB.batch(batch.slice(i, i + 100));
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

    // Insert harvested wallets into D1
    const stmt = this.env.DB.prepare(
      `INSERT OR IGNORE INTO firehose_wallets (wallet, source)
       VALUES (?, 'harvest')`,
    );

    const batch = Array.from(wallets).map((w) => stmt.bind(w));
    for (let i = 0; i < batch.length; i += 100) {
      await this.env.DB.batch(batch.slice(i, i + 100));
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
