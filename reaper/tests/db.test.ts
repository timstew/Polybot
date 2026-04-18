/**
 * Database tests — schema, config, activity log, migrations.
 */

import { describe, test, expect, beforeAll } from "bun:test";

describe("database", () => {
  beforeAll(async () => {
    const { initDb } = await import("../src/db.js");
    initDb(":memory:");
  });

  test("tables exist", async () => {
    const { getDb } = await import("../src/db.js");
    const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    expect(names).toContain("orders");
    expect(names).toContain("windows");
    expect(names).toContain("fills");
    expect(names).toContain("exits");
    expect(names).toContain("activity_log");
    expect(names).toContain("config");
    expect(names).toContain("window_ticks");
    expect(names).toContain("shadow_trades");
  });

  test("setConfig + getConfig", async () => {
    const { setConfig, getConfig } = await import("../src/db.js");
    setConfig("test_key", "test_value");
    expect(getConfig("test_key")).toBe("test_value");
  });

  test("getConfig returns default for missing key", async () => {
    const { getConfig } = await import("../src/db.js");
    expect(getConfig("nonexistent")).toBeUndefined();
    expect(getConfig("nonexistent", "fallback")).toBe("fallback");
  });

  test("setConfig overwrites existing", async () => {
    const { setConfig, getConfig } = await import("../src/db.js");
    setConfig("overwrite_test", "v1");
    setConfig("overwrite_test", "v2");
    expect(getConfig("overwrite_test")).toBe("v2");
  });

  test("getAllConfig returns all keys", async () => {
    const { setConfig, getAllConfig } = await import("../src/db.js");
    setConfig("all_test_a", "1");
    setConfig("all_test_b", "2");
    const all = getAllConfig();
    expect(all.all_test_a).toBe("1");
    expect(all.all_test_b).toBe("2");
  });

  test("logActivity writes to activity_log", async () => {
    const { logActivity, getDb } = await import("../src/db.js");
    logActivity("TEST_EVENT", "test detail", { level: "info" });
    const row = getDb().prepare("SELECT * FROM activity_log WHERE type = 'TEST_EVENT' ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
    expect(row).not.toBeNull();
    expect(row.detail).toBe("test detail");
    expect(row.level).toBe("info");
  });

  test("fills table accepts new source values (migration)", async () => {
    const { getDb } = await import("../src/db.js");
    // Should not throw — source CHECK removed by migration
    getDb().prepare(`
      INSERT INTO fills (id, window_slug, token_id, side, price, size, source)
      VALUES ('test-fill-1', 'test-slug', 'tok', 'UP', 0.50, 10, 'paper_shadow')
    `).run();
    getDb().prepare(`
      INSERT INTO fills (id, window_slug, token_id, side, price, size, source)
      VALUES ('test-fill-2', 'test-slug', 'tok', 'DOWN', 0.48, 10, 'paper_grounded')
    `).run();
    getDb().prepare(`
      INSERT INTO fills (id, window_slug, token_id, side, price, size, source)
      VALUES ('test-fill-3', 'test-slug', 'tok', 'UP', 0.51, 10, 'paper_book')
    `).run();
    const count = getDb().prepare("SELECT COUNT(*) as n FROM fills WHERE source LIKE 'paper_%'").get() as { n: number };
    expect(count.n).toBe(3);
  });

  test("window_ticks has last_trade columns", async () => {
    const { getDb } = await import("../src/db.js");
    const info = getDb().prepare("PRAGMA table_info(window_ticks)").all() as Array<{ name: string }>;
    const cols = info.map(c => c.name);
    expect(cols).toContain("up_last_trade");
    expect(cols).toContain("dn_last_trade");
  });
});
