/**
 * Window manager tests — lifecycle (active → resolving → resolved), queries,
 * and boundary crossing. discoverWindows/enterWindow require Gamma and Binance
 * calls so they're exercised via engine.test.ts scenarios rather than here.
 */

import { describe, test, expect, beforeEach } from "bun:test";

async function resetDb() {
  const { initDb, getDb } = await import("../src/db.js");
  initDb(":memory:");
  const db = getDb();
  db.exec("DELETE FROM windows");
  db.exec("DELETE FROM fills");
  db.exec("DELETE FROM orders");
  return db;
}

async function seedWindow(slug: string, status: "ACTIVE" | "RESOLVING" | "RESOLVED" = "ACTIVE", overrides: Record<string, unknown> = {}) {
  const { getDb } = await import("../src/db.js");
  const cols = {
    condition_id: "cond",
    crypto_symbol: "BTCUSDT",
    up_token_id: "u",
    down_token_id: "d",
    open_time: Date.now() - 60_000,
    end_time: Date.now() + 240_000,
    up_inventory: 0,
    up_avg_cost: 0,
    down_inventory: 0,
    down_avg_cost: 0,
    merge_pnl: 0,
    ...overrides,
  };
  getDb().prepare(`
    INSERT INTO windows (slug, condition_id, crypto_symbol, up_token_id, down_token_id,
      open_time, end_time, status,
      up_inventory, up_avg_cost, down_inventory, down_avg_cost, merge_pnl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, cols.condition_id, cols.crypto_symbol, cols.up_token_id, cols.down_token_id,
    cols.open_time, cols.end_time, status,
    cols.up_inventory, cols.up_avg_cost, cols.down_inventory, cols.down_avg_cost, cols.merge_pnl);
}

describe("getActiveWindows + getWindow", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("returns only ACTIVE windows", async () => {
    await seedWindow("w-a", "ACTIVE");
    await seedWindow("w-r", "RESOLVED");
    await seedWindow("w-rs", "RESOLVING");

    const { getActiveWindows } = await import("../src/core/window-manager.js");
    const active = getActiveWindows();
    expect(active.length).toBe(1);
    expect(active[0].slug).toBe("w-a");
  });

  test("getWindow returns nullish for unknown slug", async () => {
    const { getWindow } = await import("../src/core/window-manager.js");
    expect(getWindow("nonexistent") == null).toBe(true);
  });

  test("getWindow returns a window regardless of status", async () => {
    await seedWindow("w-resolved", "RESOLVED");
    const { getWindow } = await import("../src/core/window-manager.js");
    expect(getWindow("w-resolved")?.status).toBe("RESOLVED");
  });

  test("getActiveWindows ordered by open_time ascending", async () => {
    await seedWindow("late", "ACTIVE", { open_time: Date.now() });
    await seedWindow("early", "ACTIVE", { open_time: Date.now() - 300_000 });

    const { getActiveWindows } = await import("../src/core/window-manager.js");
    const active = getActiveWindows();
    expect(active.map(w => w.slug)).toEqual(["early", "late"]);
  });
});

describe("lifecycle transitions", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("markResolving changes ACTIVE → RESOLVING only", async () => {
    await seedWindow("live", "ACTIVE");
    const { markResolving, getWindow } = await import("../src/core/window-manager.js");
    markResolving("live");
    expect(getWindow("live")?.status).toBe("RESOLVING");

    // Second call is a no-op since it's now RESOLVING (condition is status = 'ACTIVE')
    markResolving("live");
    expect(getWindow("live")?.status).toBe("RESOLVING");
  });

  test("markResolving on unknown slug is silent no-op", async () => {
    const { markResolving, getWindow } = await import("../src/core/window-manager.js");
    markResolving("nope");
    // better-sqlite3 returns null for no-row; window-manager's type says undefined
    const w = getWindow("nope");
    expect(w == null).toBe(true);
  });

  test("resolveWindow refuses to re-resolve a RESOLVED window", async () => {
    await seedWindow("once", "ACTIVE", { up_inventory: 10, up_avg_cost: 0.50 });
    const { resolveWindow, getWindow } = await import("../src/core/window-manager.js");
    resolveWindow("once", "UP");
    const first = getWindow("once")!;
    const firstPnl = first.net_pnl;

    // Try again with a different outcome — should be ignored
    resolveWindow("once", "DOWN");
    const second = getWindow("once")!;
    expect(second.net_pnl).toBe(firstPnl);
    expect(second.outcome).toBe("UP");
  });

  test("resolveWindow sets resolved_at timestamp", async () => {
    await seedWindow("ts-test", "ACTIVE", { up_inventory: 10, up_avg_cost: 0.50 });
    const { resolveWindow, getWindow } = await import("../src/core/window-manager.js");
    resolveWindow("ts-test", "UP");
    const { getDb } = await import("../src/db.js");
    const row = getDb().prepare("SELECT resolved_at FROM windows WHERE slug = 'ts-test'").get() as { resolved_at: string };
    expect(row.resolved_at).not.toBeNull();
  });
});

describe("checkBoundaryCrossing", () => {
  test("fires exactly once per 5-minute boundary", async () => {
    const { checkBoundaryCrossing } = await import("../src/core/window-manager.js");
    // First call initializes and may fire depending on last crossing
    checkBoundaryCrossing();
    // Subsequent calls within the same boundary should return false
    const a = checkBoundaryCrossing();
    const b = checkBoundaryCrossing();
    expect(a).toBe(false);
    expect(b).toBe(false);
  });
});

describe("P&L edge cases in resolveWindow", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("zero inventory on both sides → zero resolution P&L", async () => {
    await seedWindow("empty", "ACTIVE");
    const { resolveWindow, getWindow } = await import("../src/core/window-manager.js");
    resolveWindow("empty", "UP");
    expect(getWindow("empty")?.resolution_pnl).toBe(0);
    expect(getWindow("empty")?.net_pnl).toBe(0);
  });

  test("pair cost exactly 1.00 → neutral merge P&L", async () => {
    await seedWindow("neutral", "ACTIVE", {
      up_inventory: 50, up_avg_cost: 0.50,
      down_inventory: 50, down_avg_cost: 0.50,
    });
    const { resolveWindow, getWindow } = await import("../src/core/window-manager.js");
    resolveWindow("neutral", "UP");
    // UP: 50 * (1-0.50) = 25; DOWN: -50 * 0.50 = -25; net = 0
    expect(getWindow("neutral")?.resolution_pnl).toBeCloseTo(0, 3);
  });

  test("pair cost < 1.00 → positive profit regardless of outcome", async () => {
    const up = { up_inventory: 50, up_avg_cost: 0.40, down_inventory: 50, down_avg_cost: 0.50 };
    // pair cost = 0.90 → each matched pair pays $0.10 at resolution
    await seedWindow("winUP", "ACTIVE", up);
    await seedWindow("winDN", "ACTIVE", up);
    const { resolveWindow, getWindow } = await import("../src/core/window-manager.js");
    resolveWindow("winUP", "UP");
    resolveWindow("winDN", "DOWN");
    // UP wins: 50*(1-0.40) - 50*0.50 = 30 - 25 = 5
    // DN wins: 50*(1-0.50) - 50*0.40 = 25 - 20 = 5
    expect(getWindow("winUP")?.resolution_pnl).toBeCloseTo(5, 3);
    expect(getWindow("winDN")?.resolution_pnl).toBeCloseTo(5, 3);
  });
});
