/**
 * Engine tests — pure helpers exposed for testing.
 *
 * Full tick-loop testing requires extensive mocking of feeds + CLOB;
 * that's deferred. This covers the pure helpers that drive capital sizing,
 * ladder depth, and concurrency — the levers that change daily as capital
 * grows or drains.
 */

import { describe, test, expect, beforeEach } from "bun:test";

async function resetDb() {
  const { initDb, getDb } = await import("../src/db.js");
  initDb(":memory:");
  const db = getDb();
  db.exec("DELETE FROM windows");
  db.exec("DELETE FROM config");
  return db;
}

describe("getScaledConfig: capital → strategy knobs", () => {
  test("tiny capital ($30): minimum ladder, 5m only", async () => {
    const { getScaledConfig } = await import("../src/core/engine.js");
    const cfg = getScaledConfig(30);
    expect(cfg.ladderLevels).toBe(2);
    expect(cfg.maxWindowDurationMs).toBe(5 * 60_000);
    expect(cfg.baseBidSize).toBeGreaterThanOrEqual(5);
    expect(cfg.maxConcurrentWindows).toBeGreaterThanOrEqual(2);
  });

  test("$80: 15m unlocked, 3 ladder levels", async () => {
    const { getScaledConfig } = await import("../src/core/engine.js");
    const cfg = getScaledConfig(80);
    expect(cfg.ladderLevels).toBe(3);
    expect(cfg.maxWindowDurationMs).toBe(15 * 60_000);
  });

  test("$200: full 4-level ladder", async () => {
    const { getScaledConfig } = await import("../src/core/engine.js");
    const cfg = getScaledConfig(200);
    expect(cfg.ladderLevels).toBe(4);
  });

  test("base bid size scales linearly up to cap", async () => {
    const { getScaledConfig } = await import("../src/core/engine.js");
    expect(getScaledConfig(100).baseBidSize).toBe(10);
    expect(getScaledConfig(500).baseBidSize).toBe(50);
    expect(getScaledConfig(1000).baseBidSize).toBe(100);
    expect(getScaledConfig(5000).baseBidSize).toBe(200); // capped
  });

  test("concurrent windows scales with capital, capped at 6", async () => {
    const { getScaledConfig } = await import("../src/core/engine.js");
    expect(getScaledConfig(50).maxConcurrentWindows).toBe(2); // floor
    expect(getScaledConfig(150).maxConcurrentWindows).toBe(6); // 150/25=6
    expect(getScaledConfig(10_000).maxConcurrentWindows).toBe(6); // cap
  });

  test("maxTotalCostPerWindow = 50% of capital", async () => {
    const { getScaledConfig } = await import("../src/core/engine.js");
    expect(getScaledConfig(100).maxTotalCostPerWindow).toBe(50);
    expect(getScaledConfig(500).maxTotalCostPerWindow).toBe(250);
  });

  test("deepValuePrice + certaintyThreshold are stable across capital", async () => {
    const { getScaledConfig } = await import("../src/core/engine.js");
    const low = getScaledConfig(50);
    const high = getScaledConfig(5000);
    expect(low.deepValuePrice).toBe(high.deepValuePrice);
    expect(low.certaintyThreshold).toBe(high.certaintyThreshold);
  });
});

describe("getTotalPnl: sum net_pnl from RESOLVED windows", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("returns 0 when no windows", async () => {
    const { getTotalPnl } = await import("../src/core/engine.js");
    expect(getTotalPnl()).toBe(0);
  });

  test("sums net_pnl across resolved windows, ignores active ones", async () => {
    const { getDb } = await import("../src/db.js");
    const db = getDb();
    db.prepare(`
      INSERT INTO windows (slug, condition_id, crypto_symbol, up_token_id, down_token_id,
        open_time, end_time, status, net_pnl)
      VALUES
        ('w1', 'c1', 'BTCUSDT', 'u1', 'd1', 0, 0, 'RESOLVED', 12.34),
        ('w2', 'c2', 'BTCUSDT', 'u2', 'd2', 0, 0, 'RESOLVED', -5.00),
        ('w3', 'c3', 'BTCUSDT', 'u3', 'd3', 0, 0, 'ACTIVE',   99.99),
        ('w4', 'c4', 'BTCUSDT', 'u4', 'd4', 0, 0, 'RESOLVING', 42.00)
    `).run();

    const { getTotalPnl } = await import("../src/core/engine.js");
    expect(getTotalPnl()).toBeCloseTo(7.34, 3);
  });
});

describe("getEffectiveCapital: config + P&L, capped", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("fresh config, no windows → max_capital_usd", async () => {
    const { setConfig } = await import("../src/db.js");
    setConfig("max_capital_usd", "150");
    const { getEffectiveCapital } = await import("../src/core/engine.js");
    expect(getEffectiveCapital()).toBe(150);
  });

  test("adds positive P&L", async () => {
    const { setConfig, getDb } = await import("../src/db.js");
    setConfig("max_capital_usd", "100");
    getDb().prepare(`
      INSERT INTO windows (slug, condition_id, crypto_symbol, up_token_id, down_token_id,
        open_time, end_time, status, net_pnl)
      VALUES ('w-pos', 'c', 'BTCUSDT', 'u', 'd', 0, 0, 'RESOLVED', 25)
    `).run();

    const { getEffectiveCapital } = await import("../src/core/engine.js");
    expect(getEffectiveCapital()).toBe(125);
  });

  test("subtracts negative P&L, floors at 0", async () => {
    const { setConfig, getDb } = await import("../src/db.js");
    setConfig("max_capital_usd", "100");
    getDb().prepare(`
      INSERT INTO windows (slug, condition_id, crypto_symbol, up_token_id, down_token_id,
        open_time, end_time, status, net_pnl)
      VALUES ('w-big-loss', 'c', 'BTCUSDT', 'u', 'd', 0, 0, 'RESOLVED', -500)
    `).run();

    const { getEffectiveCapital } = await import("../src/core/engine.js");
    expect(getEffectiveCapital()).toBe(0);
  });

  test("honors capital_cap_usd ceiling", async () => {
    const { setConfig, getDb } = await import("../src/db.js");
    setConfig("max_capital_usd", "100");
    setConfig("capital_cap_usd", "500");
    getDb().prepare(`
      INSERT INTO windows (slug, condition_id, crypto_symbol, up_token_id, down_token_id,
        open_time, end_time, status, net_pnl)
      VALUES ('w-huge-win', 'c', 'BTCUSDT', 'u', 'd', 0, 0, 'RESOLVED', 10000)
    `).run();

    const { getEffectiveCapital } = await import("../src/core/engine.js");
    expect(getEffectiveCapital()).toBe(500);
  });
});

describe("window resolution P&L scenarios", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function setupResolvedWindow(outcome: "UP" | "DOWN", upInv: number, upCost: number, dnInv: number, dnCost: number, mergePnl = 0) {
    const { getDb } = await import("../src/db.js");
    getDb().prepare(`
      INSERT INTO windows (slug, condition_id, crypto_symbol, up_token_id, down_token_id,
        open_time, end_time, status,
        up_inventory, up_avg_cost, down_inventory, down_avg_cost, merge_pnl)
      VALUES ('rw', 'c', 'BTCUSDT', 'u', 'd', 0, 0, 'ACTIVE', ?, ?, ?, ?, ?)
    `).run(upInv, upCost, dnInv, dnCost, mergePnl);

    const { resolveWindow } = await import("../src/core/window-manager.js");
    resolveWindow("rw", outcome);
    const { getWindow } = await import("../src/core/window-manager.js");
    return getWindow("rw")!;
  }

  test("balanced pair at pc=0.90, UP wins", async () => {
    const w = await setupResolvedWindow("UP", 100, 0.50, 100, 0.40);
    // UP: 100 * (1 - 0.50) = 50; DOWN: -100 * 0.40 = -40; net = 10
    expect(w.resolution_pnl).toBeCloseTo(10, 3);
    expect(w.net_pnl).toBeCloseTo(10, 3);
  });

  test("one-sided loss (UP-only, DOWN wins)", async () => {
    const w = await setupResolvedWindow("DOWN", 100, 0.60, 0, 0);
    // No DOWN inv to pay out; UP inv is worthless
    expect(w.resolution_pnl).toBeCloseTo(-60, 3);
  });

  test("merge_pnl added to net_pnl", async () => {
    const w = await setupResolvedWindow("UP", 50, 0.48, 50, 0.42, 5.0);
    // res = 50*(1-0.48) - 50*0.42 = 26 - 21 = 5; net = 5 + 5 = 10
    expect(w.resolution_pnl).toBeCloseTo(5, 3);
    expect(w.net_pnl).toBeCloseTo(10, 3);
  });

  test("UNKNOWN outcome → resolution_pnl = 0", async () => {
    const w = await setupResolvedWindow("UP", 100, 0.60, 100, 0.30); // setup UP win...
    // But force UNKNOWN
    const { getDb } = await import("../src/db.js");
    getDb().prepare("UPDATE windows SET status = 'ACTIVE' WHERE slug = 'rw'").run();
    const { resolveWindow, getWindow } = await import("../src/core/window-manager.js");
    resolveWindow("rw", "UNKNOWN");
    const w2 = getWindow("rw")!;
    expect(w2.resolution_pnl).toBe(0);
  });
});
