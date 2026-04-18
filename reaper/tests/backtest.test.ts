/**
 * Backtest engine unit tests — deterministic replay with known data.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";

// We need to init the DB before importing backtest modules
let origGetDb: () => Database;

beforeAll(async () => {
  // Create in-memory DB with schema
  const { initDb } = await import("../src/db.js");
  initDb(":memory:");
});

describe("backtest engine", () => {
  test("import", async () => {
    const m = await import("../src/analysis/backtest.js");
    expect(typeof m.backtestWindow).toBe("function");
    expect(typeof m.backtestAll).toBe("function");
    expect(typeof m.summarizeByStrategy).toBe("function");
  });

  test("backtestWindow with synthetic data", async () => {
    const { backtestWindow } = await import("../src/analysis/backtest.js");
    const { getDb } = await import("../src/db.js");
    const db = getDb();

    // Insert a test window
    db.prepare(`
      INSERT OR REPLACE INTO windows (slug, condition_id, crypto_symbol, up_token_id, down_token_id, open_time, end_time, status, outcome)
      VALUES ('test-bt-1', '0xabc', 'BTCUSDT', 'tok-up', 'tok-dn', 1000000, 1300000, 'RESOLVED', 'UP')
    `).run();

    // Insert ticks
    const tickBase = { up_best_bid: 0.01, up_best_ask: 0.99, dn_best_bid: 0.01, dn_best_ask: 0.99 };
    for (let i = 0; i < 10; i++) {
      db.prepare(`
        INSERT INTO window_ticks (window_slug, timestamp, p_true, spot_price, up_best_bid, up_best_ask, dn_best_bid, dn_best_ask, phase)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('test-bt-1', 1000000 + i * 30000, 0.50 + i * 0.03, 75000, 0.01, 0.99, 0.01, 0.99, 'STD');
    }

    // Insert shadow trades (BR fills we'd try to match)
    db.prepare(`
      INSERT INTO shadow_trades (id, wallet, window_slug, side, buy_sell, price, size, timestamp)
      VALUES ('br-1', '0xbr', 'test-bt-1', 'UP', 'BUY', 0.50, 25, 1060000)
    `).run();
    db.prepare(`
      INSERT INTO shadow_trades (id, wallet, window_slug, side, buy_sell, price, size, timestamp)
      VALUES ('br-2', '0xbr', 'test-bt-1', 'DOWN', 'BUY', 0.45, 20, 1090000)
    `).run();

    const ticks = db.prepare("SELECT * FROM window_ticks WHERE window_slug = ? ORDER BY timestamp").all('test-bt-1') as any[];
    const shadow = db.prepare("SELECT * FROM shadow_trades WHERE window_slug = ? ORDER BY timestamp").all('test-bt-1') as any[];
    const window = db.prepare("SELECT * FROM windows WHERE slug = ?").get('test-bt-1') as any;

    const result = backtestWindow("hybrid", window, ticks, shadow, { starting_capital: 500 });

    expect(result.strategy).toBe("hybrid");
    expect(result.window_slug).toBe("test-bt-1");
    expect(result.outcome).toBe("UP");
    expect(result.fill_count).toBeGreaterThanOrEqual(1); // should match at least 1 BR fill
    expect(result.starting_capital).toBe(500);
    expect(result.peak_capital_used).toBeGreaterThan(0);
  });

  test("capital constraint reduces fills", async () => {
    const { backtestWindow } = await import("../src/analysis/backtest.js");
    const { getDb } = await import("../src/db.js");
    const db = getDb();

    const ticks = db.prepare("SELECT * FROM window_ticks WHERE window_slug = ? ORDER BY timestamp").all('test-bt-1') as any[];
    const shadow = db.prepare("SELECT * FROM shadow_trades WHERE window_slug = ? ORDER BY timestamp").all('test-bt-1') as any[];
    const window = db.prepare("SELECT * FROM windows WHERE slug = ?").get('test-bt-1') as any;

    const unlimited = backtestWindow("hybrid", window, ticks, shadow, { starting_capital: 10000 });
    const tiny = backtestWindow("hybrid", window, ticks, shadow, { starting_capital: 5 });

    expect(tiny.fill_count).toBeLessThanOrEqual(unlimited.fill_count);
    expect(tiny.skipped_fills_capital).toBeGreaterThanOrEqual(0);
  });

  test("summarizeByStrategy aggregates correctly", async () => {
    const { summarizeByStrategy } = await import("../src/analysis/backtest.js");

    const results = [
      { strategy: "a", net_pnl: 10, fill_count: 5, total_spend: 100, pair_cost: 0.90, first_fill_sec: 5, skipped_fills_capital: 0, peak_capital_used: 50, mid_window_merges: 1, mid_window_merge_usd: 20, window_slug: "w1" },
      { strategy: "a", net_pnl: -3, fill_count: 3, total_spend: 50, pair_cost: 1.05, first_fill_sec: 10, skipped_fills_capital: 1, peak_capital_used: 30, mid_window_merges: 0, mid_window_merge_usd: 0, window_slug: "w2" },
    ] as any[];

    const summary = summarizeByStrategy(results);
    const a = summary.find(s => s.strategy === "a")!;
    expect(a.windows).toBe(2);
    expect(a.total_fills).toBe(8);
    expect(a.total_pnl).toBe(7);
    expect(a.total_skipped_fills).toBe(1);
    expect(a.win_rate_pct).toBe(50);
  });
});
