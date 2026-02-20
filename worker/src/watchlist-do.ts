import type { Env } from "./types";

const DATA_API = "https://data-api.polymarket.com";

// Category-specific check intervals (minutes)
const CATEGORY_INTERVALS: Record<string, number> = {
  crypto: 20,
  sports: 90,
  politics: 240,
  finance: 120,
  unknown: 60,
};

interface WatchlistEntry {
  wallet: string;
  category: string;
  check_interval_min: number;
  last_checked: string | null;
  username: string;
}

interface ActivityItem {
  proxyWallet?: string;
  name?: string;
  side?: string;
  price?: number;
  size?: number;
  usdcSize?: number;
  timestamp?: number | string;
  title?: string;
  conditionId?: string;
  slug?: string;
  type?: string;
}

interface PositionItem {
  title?: string;
  outcome?: string;
  size?: number;
  avgPrice?: number;
  curPrice?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  conditionId?: string;
  slug?: string;
}

interface ProfitData {
  amount?: number;
}

export class WatchlistDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      await this.state.storage.put("userStopped", false);
      await this.state.storage.setAlarm(Date.now() + 5_000);
      return json({ status: "started" });
    }

    if (url.pathname === "/stop") {
      await this.state.storage.put("userStopped", true);
      await this.state.storage.deleteAlarm();
      return json({ status: "stopped" });
    }

    if (url.pathname === "/status") {
      const alarm = await this.state.storage.getAlarm();
      const userStopped =
        (await this.state.storage.get("userStopped")) ?? false;
      const lastRun =
        (await this.state.storage.get("lastRunTime")) as string | null;
      const walletsChecked =
        (await this.state.storage.get("walletsCheckedTotal")) as number ?? 0;
      return json({
        running: alarm !== null,
        userStopped,
        lastRun,
        walletsChecked,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const userStopped = (await this.state.storage.get("userStopped")) ?? false;
    if (userStopped) return;

    try {
      await this.checkDueWallets();
      await this.pruneOldSnapshots();
    } catch (e) {
      console.error("WatchlistDO alarm error:", e);
    }

    // Re-schedule every 5 minutes
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }

  private async checkDueWallets(): Promise<void> {
    // Find wallets due for a check
    const { results } = await this.env.DB.prepare(
      `SELECT wallet, category, check_interval_min, last_checked, username
       FROM watchlist
       WHERE last_checked IS NULL
          OR datetime(last_checked, '+' || check_interval_min || ' minutes') <= datetime('now')
       ORDER BY last_checked ASC
       LIMIT 3`,
    ).all<WatchlistEntry>();

    if (!results || results.length === 0) return;

    let checked = 0;
    for (const entry of results) {
      try {
        await this.snapshotWallet(entry);
        checked++;
      } catch (e) {
        console.error(`Watchlist check failed for ${entry.wallet}:`, e);
      }
    }

    const total =
      ((await this.state.storage.get("walletsCheckedTotal")) as number) ?? 0;
    await this.state.storage.put("walletsCheckedTotal", total + checked);
    await this.state.storage.put("lastRunTime", new Date().toISOString());
  }

  private async snapshotWallet(entry: WatchlistEntry): Promise<void> {
    const w = entry.wallet;

    // Fetch activity (last 100 trades)
    let activities: ActivityItem[] = [];
    try {
      const resp = await fetch(
        `${DATA_API}/activity?user=${w}&limit=100`,
      );
      if (resp.ok) {
        activities = (await resp.json()) as ActivityItem[];
      }
    } catch { /* skip */ }

    // Fetch profit data for multiple windows
    const profitWindows = ["1d", "7d", "30d", "all"];
    const profits: Record<string, number> = {};
    for (const window of profitWindows) {
      try {
        const resp = await fetch(
          `${DATA_API}/profit?window=${window}&user=${w}`,
        );
        if (resp.ok) {
          const data = (await resp.json()) as ProfitData;
          profits[window] = data?.amount ?? 0;
        }
      } catch { /* skip */ }
    }

    // Fetch positions
    let positions: PositionItem[] = [];
    try {
      const resp = await fetch(
        `${DATA_API}/positions?user=${w}&sizeThreshold=-1&limit=100`,
      );
      if (resp.ok) {
        positions = (await resp.json()) as PositionItem[];
      }
    } catch { /* skip */ }

    // Compute metrics from activity data
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const trades = activities.filter(
      (a) => a.type === "TRADE" || (!a.type && a.side),
    );
    const recentTrades = trades.filter((t) => {
      const ts =
        typeof t.timestamp === "number"
          ? t.timestamp > 1e12
            ? t.timestamp
            : t.timestamp * 1000
          : new Date(String(t.timestamp)).getTime();
      return ts >= oneDayAgo;
    });

    const trades24h = recentTrades.length;
    const volume24h = recentTrades.reduce(
      (sum, t) => sum + (t.usdcSize ?? (t.price ?? 0) * (t.size ?? 0)),
      0,
    );
    const avgTradeSize =
      trades24h > 0 ? volume24h / trades24h : 0;

    // Count unique active markets from positions
    const activeMarkets = new Set(
      positions.map((p) => p.conditionId).filter(Boolean),
    ).size;

    // Win rate from suspect_bots if available
    const botRow = await this.env.DB.prepare(
      "SELECT win_rate, copy_score FROM suspect_bots WHERE wallet = ?",
    )
      .bind(w)
      .first<{ win_rate: number; copy_score: number }>();

    // Compact top 5 positions by value
    const topPositions = positions
      .sort(
        (a, b) =>
          Math.abs(Number(b.currentValue ?? 0)) -
          Math.abs(Number(a.currentValue ?? 0)),
      )
      .slice(0, 5)
      .map((p) => ({
        title: String(p.title ?? "").slice(0, 80),
        outcome: String(p.outcome ?? ""),
        size: Number(p.size ?? 0),
        avgPrice: Number(p.avgPrice ?? 0),
        curPrice: Number(p.curPrice ?? 0),
        value: Number(p.currentValue ?? 0),
        pnl: Number(p.cashPnl ?? 0),
      }));

    // Update username if we got one from activity
    let username = entry.username;
    if (!username && activities.length > 0) {
      const name = activities[0]?.name;
      if (name && typeof name === "string" && !name.startsWith("0x")) {
        username = name;
        await this.env.DB.prepare(
          "UPDATE watchlist SET username = ? WHERE wallet = ?",
        )
          .bind(username, w)
          .run();
      }
    }

    // Insert snapshot
    await this.env.DB.prepare(
      `INSERT INTO watchlist_snapshots
       (wallet, profit_1d, profit_7d, profit_30d, profit_all,
        volume_24h, win_rate, open_positions, active_markets,
        avg_trade_size, trades_24h, copy_score, positions_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        w,
        profits["1d"] ?? 0,
        profits["7d"] ?? 0,
        profits["30d"] ?? 0,
        profits["all"] ?? 0,
        Math.round(volume24h * 100) / 100,
        botRow?.win_rate ?? 0,
        positions.length,
        activeMarkets,
        Math.round(avgTradeSize * 100) / 100,
        trades24h,
        botRow?.copy_score ?? 0,
        JSON.stringify(topPositions),
      )
      .run();

    // Update last_checked
    await this.env.DB.prepare(
      "UPDATE watchlist SET last_checked = datetime('now') WHERE wallet = ?",
    )
      .bind(w)
      .run();
  }

  private async pruneOldSnapshots(): Promise<void> {
    try {
      await this.env.DB.prepare(
        "DELETE FROM watchlist_snapshots WHERE snapshot_at < datetime('now', '-30 days')",
      ).run();
    } catch { /* non-critical */ }
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
