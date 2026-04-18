/**
 * Fill-processor tests: taker-fee formula, fee accounting through
 * processReconcileFill, and fees subtracted at window resolution.
 */

import { describe, test, expect, beforeEach } from "bun:test";

async function resetDb() {
  const { initDb, getDb } = await import("../src/db.js");
  initDb(":memory:");
  const db = getDb();
  db.exec("DELETE FROM fills");
  db.exec("DELETE FROM orders");
  db.exec("DELETE FROM windows");
  db.exec("DELETE FROM config");
  return db;
}

async function seedWindow(slug: string) {
  const { getDb } = await import("../src/db.js");
  getDb().prepare(`
    INSERT INTO windows (slug, condition_id, crypto_symbol, up_token_id, down_token_id,
      open_time, end_time, status, entered_at)
    VALUES (?, 'cond', 'BTCUSDT', 'up-tok', 'dn-tok', ?, ?, 'ACTIVE', datetime('now'))
  `).run(slug, Date.now() - 60_000, Date.now() + 240_000);
}

async function seedOrder(clobId: string, slug: string, side: "UP" | "DOWN", price: number, size: number) {
  const ledger = await import("../src/orders/order-ledger.js");
  const tokenId = side === "UP" ? "up-tok" : "dn-tok";
  const id = ledger.createPendingOrder({ tokenId, windowSlug: slug, side, price, size });
  ledger.markSent(id, clobId);
  return id;
}

describe("takerFee formula", () => {
  test("zero at the extremes", async () => {
    const { takerFee } = await import("../src/orders/fill-processor.js");
    expect(takerFee(0.0, 100)).toBe(0);
    expect(takerFee(1.0, 100)).toBe(0);
  });

  test("peaks at $0.50", async () => {
    const { takerFee, TAKER_FEE_RATE } = await import("../src/orders/fill-processor.js");
    expect(takerFee(0.50, 100)).toBeCloseTo(0.25 * TAKER_FEE_RATE * 100, 6);
    expect(takerFee(0.50, 100)).toBeGreaterThan(takerFee(0.10, 100));
    expect(takerFee(0.50, 100)).toBeGreaterThan(takerFee(0.90, 100));
  });

  test("symmetric around $0.50", async () => {
    const { takerFee } = await import("../src/orders/fill-processor.js");
    expect(takerFee(0.30, 100)).toBeCloseTo(takerFee(0.70, 100), 6);
    expect(takerFee(0.10, 100)).toBeCloseTo(takerFee(0.90, 100), 6);
  });

  test("linear in size", async () => {
    const { takerFee } = await import("../src/orders/fill-processor.js");
    expect(takerFee(0.50, 200)).toBeCloseTo(takerFee(0.50, 100) * 2, 6);
  });

  test("price clamped to [0, 1]", async () => {
    const { takerFee } = await import("../src/orders/fill-processor.js");
    expect(takerFee(-0.5, 100)).toBe(0);
    expect(takerFee(1.5, 100)).toBe(0);
  });
});

describe("processReconcileFill fee tagging", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("isMaker=true (default) → zero fee", async () => {
    await seedWindow("fee-maker");
    await seedOrder("paper-fm-1", "fee-maker", "UP", 0.60, 100);
    const { processReconcileFill } = await import("../src/orders/fill-processor.js");

    processReconcileFill("t-1", "paper-fm-1", "fee-maker", "up-tok", "UP", 0.55, 50, "paper_grounded");

    const { getDb } = await import("../src/db.js");
    const row = getDb().prepare("SELECT fee, is_maker FROM fills WHERE id = 't-1'").get() as { fee: number; is_maker: number };
    expect(row.fee).toBe(0);
    expect(row.is_maker).toBe(1);
  });

  test("isMaker=false → fee = p*(1-p)*0.0625*size", async () => {
    await seedWindow("fee-taker");
    await seedOrder("paper-ft-1", "fee-taker", "UP", 0.60, 100);
    const { processReconcileFill, takerFee } = await import("../src/orders/fill-processor.js");

    processReconcileFill("t-2", "paper-ft-1", "fee-taker", "up-tok", "UP", 0.50, 40, "paper_book", false);

    const { getDb } = await import("../src/db.js");
    const row = getDb().prepare("SELECT fee, is_maker FROM fills WHERE id = 't-2'").get() as { fee: number; is_maker: number };
    expect(row.fee).toBeCloseTo(takerFee(0.50, 40), 6);
    expect(row.is_maker).toBe(0);
  });

  test("dedup: same tradeId twice → only one row", async () => {
    await seedWindow("fee-dedup");
    await seedOrder("paper-fd-1", "fee-dedup", "UP", 0.60, 100);
    const { processReconcileFill } = await import("../src/orders/fill-processor.js");

    processReconcileFill("t-3", "paper-fd-1", "fee-dedup", "up-tok", "UP", 0.55, 50, "paper_grounded");
    processReconcileFill("t-3", "paper-fd-1", "fee-dedup", "up-tok", "UP", 0.55, 50, "paper_grounded");

    const { getDb } = await import("../src/db.js");
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM fills WHERE id = 't-3'").get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe("processImmediateFill", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("records a taker fill with computed fee", async () => {
    await seedWindow("imm-1");
    await seedOrder("paper-i1", "imm-1", "UP", 0.52, 100);
    const { processImmediateFill, takerFee } = await import("../src/orders/fill-processor.js");

    processImmediateFill("local-id", "paper-i1", "imm-1", "up-tok", "UP", 0.50, 40);

    const { getDb } = await import("../src/db.js");
    const row = getDb().prepare("SELECT price, size, fee, is_maker, source FROM fills").get() as { price: number; size: number; fee: number; is_maker: number; source: string };
    expect(row.price).toBe(0.50);
    expect(row.size).toBe(40);
    expect(row.fee).toBeCloseTo(takerFee(0.50, 40), 6);
    expect(row.is_maker).toBe(0);
    expect(row.source).toBe("immediate");
  });

  test("updates window inventory on UP side", async () => {
    await seedWindow("imm-2");
    await seedOrder("paper-i2", "imm-2", "UP", 0.60, 100);
    const { processImmediateFill } = await import("../src/orders/fill-processor.js");

    processImmediateFill("x", "paper-i2", "imm-2", "up-tok", "UP", 0.55, 25);

    const { getWindow } = await import("../src/core/window-manager.js");
    const w = getWindow("imm-2")!;
    expect(w.up_inventory).toBe(25);
    expect(w.up_avg_cost).toBeCloseTo(0.55, 6);
    expect(w.down_inventory).toBe(0);
  });
});

describe("processUserWsFill", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("maker WS fill: zero fee, inventory updated", async () => {
    await seedWindow("uws-1");
    await seedOrder("ws-order-A", "uws-1", "UP", 0.55, 100);
    const { processUserWsFill } = await import("../src/orders/fill-processor.js");

    processUserWsFill({
      orderId: "ws-order-A",
      status: "MATCHED",
      sizeMatched: 30,
      price: 0.55,
      tradeId: "ws-trade-1",
      isMaker: true,
      tokenId: "up-tok",
      side: "BUY",
      timestamp: Date.now() / 1000,
    });

    const { getDb } = await import("../src/db.js");
    const row = getDb().prepare("SELECT fee, is_maker, source FROM fills WHERE id = 'ws-trade-1'").get() as { fee: number; is_maker: number; source: string };
    expect(row.fee).toBe(0);
    expect(row.is_maker).toBe(1);
    expect(row.source).toBe("user_ws");

    const { getWindow } = await import("../src/core/window-manager.js");
    const w = getWindow("uws-1")!;
    expect(w.up_inventory).toBe(30);
  });

  test("unknown orderId → fill is ignored (logged)", async () => {
    await seedWindow("uws-2");
    const { processUserWsFill } = await import("../src/orders/fill-processor.js");

    processUserWsFill({
      orderId: "ghost-order",
      status: "MATCHED",
      sizeMatched: 10,
      price: 0.50,
      tradeId: "ws-trade-ghost",
      isMaker: true,
      tokenId: "up-tok",
      side: "BUY",
      timestamp: Date.now() / 1000,
    });

    const { getDb } = await import("../src/db.js");
    const count = getDb().prepare("SELECT COUNT(*) AS n FROM fills").get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("inventory avg cost recalc across fills", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("two fills at different prices → volume-weighted avg", async () => {
    await seedWindow("avg-1");
    await seedOrder("paper-a1", "avg-1", "UP", 0.60, 200);
    const { processReconcileFill } = await import("../src/orders/fill-processor.js");

    processReconcileFill("avg-t1", "paper-a1", "avg-1", "up-tok", "UP", 0.50, 100, "paper_grounded");
    processReconcileFill("avg-t2", "paper-a1", "avg-1", "up-tok", "UP", 0.40, 100, "paper_grounded");

    const { getWindow } = await import("../src/core/window-manager.js");
    const w = getWindow("avg-1")!;
    expect(w.up_inventory).toBe(200);
    // VWAP = (100*0.50 + 100*0.40) / 200 = 0.45
    expect(w.up_avg_cost).toBeCloseTo(0.45, 6);
  });

  test("fill_count increments per fill", async () => {
    await seedWindow("cnt-1");
    await seedOrder("paper-c1", "cnt-1", "UP", 0.60, 200);
    const { processReconcileFill } = await import("../src/orders/fill-processor.js");

    processReconcileFill("c-t1", "paper-c1", "cnt-1", "up-tok", "UP", 0.50, 50, "paper_grounded");
    processReconcileFill("c-t2", "paper-c1", "cnt-1", "up-tok", "UP", 0.50, 50, "paper_grounded");
    processReconcileFill("c-t3", "paper-c1", "cnt-1", "up-tok", "UP", 0.50, 50, "paper_grounded");

    const { getWindow } = await import("../src/core/window-manager.js");
    const w = getWindow("cnt-1")!;
    expect(w.fill_count).toBe(3);
  });

  test("peak inventory tracks the high-water mark", async () => {
    await seedWindow("pk-1");
    await seedOrder("paper-pk1", "pk-1", "UP", 0.60, 200);
    const { processReconcileFill } = await import("../src/orders/fill-processor.js");

    processReconcileFill("pk-t1", "paper-pk1", "pk-1", "up-tok", "UP", 0.50, 150, "paper_grounded");
    const { getDb } = await import("../src/db.js");
    getDb().prepare("UPDATE windows SET up_inventory = 20 WHERE slug = 'pk-1'").run(); // simulate merge
    processReconcileFill("pk-t2", "paper-pk1", "pk-1", "up-tok", "UP", 0.50, 10, "paper_grounded");

    const { getWindow } = await import("../src/core/window-manager.js");
    const w = getWindow("pk-1")!;
    expect(w.peak_up_inventory).toBeGreaterThanOrEqual(150);
  });

  test("partial fills transition to FILLED at completion", async () => {
    await seedWindow("pf-1");
    await seedOrder("paper-pf1", "pf-1", "UP", 0.60, 100);
    const { processReconcileFill } = await import("../src/orders/fill-processor.js");

    processReconcileFill("pf-t1", "paper-pf1", "pf-1", "up-tok", "UP", 0.55, 40, "paper_grounded");
    const { getDb } = await import("../src/db.js");
    let row = getDb().prepare("SELECT status, size_matched FROM orders WHERE clob_order_id = 'paper-pf1'").get() as { status: string; size_matched: number };
    expect(row.status).toBe("PARTIAL");
    expect(row.size_matched).toBe(40);

    processReconcileFill("pf-t2", "paper-pf1", "pf-1", "up-tok", "UP", 0.55, 60, "paper_grounded");
    row = getDb().prepare("SELECT status, size_matched FROM orders WHERE clob_order_id = 'paper-pf1'").get() as { status: string; size_matched: number };
    expect(row.status).toBe("FILLED");
    expect(row.size_matched).toBe(100);
  });
});

describe("resolveWindow subtracts taker fees from net P&L", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("maker-only window: fees=0, net_pnl unchanged", async () => {
    await seedWindow("res-m");
    await seedOrder("paper-rm-1", "res-m", "UP", 0.50, 100);
    const { processReconcileFill } = await import("../src/orders/fill-processor.js");
    processReconcileFill("r-1", "paper-rm-1", "res-m", "up-tok", "UP", 0.50, 100, "paper_grounded");

    const { resolveWindow, getWindow } = await import("../src/core/window-manager.js");
    resolveWindow("res-m", "UP");

    const w = getWindow("res-m")!;
    // 100 UP tokens at $0.50 → resolution_pnl = 100 * (1 - 0.50) - 0 = $50
    expect(w.resolution_pnl).toBeCloseTo(50, 3);
    expect(w.net_pnl).toBeCloseTo(50, 3);
  });

  test("taker window: fees subtracted from net_pnl", async () => {
    await seedWindow("res-t");
    await seedOrder("paper-rt-1", "res-t", "UP", 0.50, 100);
    const { processReconcileFill, takerFee } = await import("../src/orders/fill-processor.js");
    processReconcileFill("r-2", "paper-rt-1", "res-t", "up-tok", "UP", 0.50, 100, "paper_book", false);

    const expectedFee = takerFee(0.50, 100);

    const { resolveWindow, getWindow } = await import("../src/core/window-manager.js");
    resolveWindow("res-t", "UP");

    const w = getWindow("res-t")!;
    expect(w.resolution_pnl).toBeCloseTo(50, 3);
    expect(w.net_pnl).toBeCloseTo(50 - expectedFee, 3);
  });

  test("mixed maker+taker: only taker fills incur fees", async () => {
    await seedWindow("res-mix");
    await seedOrder("paper-rx-1", "res-mix", "UP", 0.50, 100);
    await seedOrder("paper-rx-2", "res-mix", "UP", 0.55, 50);
    const { processReconcileFill, takerFee } = await import("../src/orders/fill-processor.js");
    processReconcileFill("r-3a", "paper-rx-1", "res-mix", "up-tok", "UP", 0.50, 100, "paper_grounded"); // maker
    processReconcileFill("r-3b", "paper-rx-2", "res-mix", "up-tok", "UP", 0.55, 50, "paper_book", false); // taker

    const expectedFee = takerFee(0.55, 50);

    const { resolveWindow, getWindow } = await import("../src/core/window-manager.js");
    resolveWindow("res-mix", "UP");

    const w = getWindow("res-mix")!;
    // avg cost of 150 tokens: (100*0.50 + 50*0.55)/150 ≈ 0.5167
    // resolution_pnl = 150 * (1 - 0.5167) ≈ 72.5
    expect(w.resolution_pnl).toBeCloseTo(150 * (1 - (100 * 0.50 + 50 * 0.55) / 150), 3);
    expect(w.net_pnl).toBeCloseTo(w.resolution_pnl - expectedFee, 3);
  });
});
