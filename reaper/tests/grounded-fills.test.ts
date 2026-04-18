/**
 * Grounded-fills tests — verify per-(order, trade) dedup and queue-sim
 * integration using an in-memory DB and a stubbed tape fetcher.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";

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

async function seedWindow(slug: string, upTok: string, dnTok: string) {
  const { getDb } = await import("../src/db.js");
  const enteredAt = new Date(Date.now() - 30_000).toISOString().replace("T", " ").slice(0, 19);
  getDb().prepare(`
    INSERT INTO windows (slug, condition_id, crypto_symbol, up_token_id, down_token_id,
      open_time, end_time, entered_at, status)
    VALUES (?, ?, 'BTCUSDT', ?, ?, ?, ?, ?, 'ACTIVE')
  `).run(slug, `cond-${slug}`, upTok, dnTok, Date.now() - 60_000, Date.now() + 240_000, enteredAt);
}

async function seedPaperOrder(clobId: string, slug: string, tokenId: string, side: "UP" | "DOWN", price: number, size: number) {
  const ledger = await import("../src/orders/order-ledger.js");
  const id = ledger.createPendingOrder({ tokenId, windowSlug: slug, side, price, size });
  ledger.markSent(id, clobId);
  return id;
}

describe("grounded-fills: per-(order, trade) dedup + queue-sim", () => {
  beforeEach(async () => {
    await resetDb();
    const { resetEvaluatedPairs, resetTapeFetcher } = await import("../src/orders/grounded-fills.js");
    resetEvaluatedPairs();
    resetTapeFetcher();
    const { resetRandom } = await import("../src/orders/queue-sim.js");
    resetRandom();
  });

  afterAll(async () => {
    const { resetTapeFetcher } = await import("../src/orders/grounded-fills.js");
    resetTapeFetcher();
    const { resetRandom } = await import("../src/orders/queue-sim.js");
    resetRandom();
  });

  test("a trade is evaluated exactly once per order across multiple calls", async () => {
    await seedWindow("w1", "up1", "dn1");
    await seedPaperOrder("paper-order-A", "w1", "up1", "UP", 0.60, 100);

    const { setTapeFetcher, checkGroundedFills } = await import("../src/orders/grounded-fills.js");
    const { setRandom } = await import("../src/orders/queue-sim.js");
    setRandom(() => 0); // always fill

    const trade = { asset: "up1", price: 0.55, size: 10, side: "SELL", timestamp: Date.now() / 1000 };
    setTapeFetcher(async () => [trade]);

    await checkGroundedFills();
    await checkGroundedFills();
    await checkGroundedFills();

    const { getDb } = await import("../src/db.js");
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM fills").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  test("same trade grants one fill per matching order (different orders not deduped against each other)", async () => {
    await seedWindow("w2", "up2", "dn2");
    await seedPaperOrder("paper-order-B1", "w2", "up2", "UP", 0.60, 100);
    await seedPaperOrder("paper-order-B2", "w2", "up2", "UP", 0.55, 100);

    const { setTapeFetcher, checkGroundedFills } = await import("../src/orders/grounded-fills.js");
    const { setRandom } = await import("../src/orders/queue-sim.js");
    setRandom(() => 0);

    const trade = { asset: "up2", price: 0.50, size: 10, side: "SELL", timestamp: Date.now() / 1000 };
    setTapeFetcher(async () => [trade]);

    await checkGroundedFills();

    const { getDb } = await import("../src/db.js");
    const rows = getDb().prepare("SELECT clob_order_id, COUNT(*) AS n FROM fills GROUP BY clob_order_id").all() as Array<{ clob_order_id: string; n: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.n === 1)).toBe(true);
  });

  test("queue-sim miss still marks pair evaluated (no later re-roll)", async () => {
    await seedWindow("w3", "up3", "dn3");
    await seedPaperOrder("paper-order-C", "w3", "up3", "UP", 0.60, 100);

    const { setTapeFetcher, checkGroundedFills } = await import("../src/orders/grounded-fills.js");
    const { setRandom } = await import("../src/orders/queue-sim.js");

    const trade = { asset: "up3", price: 0.60, size: 10, side: "SELL", timestamp: Date.now() / 1000 };
    setTapeFetcher(async () => [trade]);

    setRandom(() => 0.99); // tied-at-level prob is 0.25 → roll always misses
    await checkGroundedFills();

    setRandom(() => 0); // would hit if re-rolled — but pair was already evaluated
    await checkGroundedFills();

    const { getDb } = await import("../src/db.js");
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM fills").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test("queue_fill_sim=false bypasses the roll (always fills at any gap)", async () => {
    await seedWindow("w4", "up4", "dn4");
    await seedPaperOrder("paper-order-D", "w4", "up4", "UP", 0.60, 100);

    const { setConfig } = await import("../src/db.js");
    setConfig("queue_fill_sim", "false");

    const { setTapeFetcher, checkGroundedFills } = await import("../src/orders/grounded-fills.js");
    const { setRandom } = await import("../src/orders/queue-sim.js");
    setRandom(() => 0.99); // would miss every roll if enabled

    const trade = { asset: "up4", price: 0.60, size: 10, side: "SELL", timestamp: Date.now() / 1000 };
    setTapeFetcher(async () => [trade]);

    await checkGroundedFills();

    const { getDb } = await import("../src/db.js");
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM fills").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  test("no fills when tape is empty", async () => {
    await seedWindow("w5", "up5", "dn5");
    await seedPaperOrder("paper-order-E", "w5", "up5", "UP", 0.60, 100);

    const { setTapeFetcher, checkGroundedFills } = await import("../src/orders/grounded-fills.js");
    setTapeFetcher(async () => []);

    await checkGroundedFills();

    const { getDb } = await import("../src/db.js");
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM fills").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test("trades on the wrong side don't fill", async () => {
    await seedWindow("w6", "up6", "dn6");
    await seedPaperOrder("paper-order-F", "w6", "up6", "UP", 0.60, 100);

    const { setTapeFetcher, checkGroundedFills } = await import("../src/orders/grounded-fills.js");
    const { setRandom } = await import("../src/orders/queue-sim.js");
    setRandom(() => 0);

    const trade = { asset: "dn6", price: 0.50, size: 10, side: "SELL", timestamp: Date.now() / 1000 };
    setTapeFetcher(async () => [trade]);

    await checkGroundedFills();

    const { getDb } = await import("../src/db.js");
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM fills").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test("trades below order price do not fill", async () => {
    await seedWindow("w7", "up7", "dn7");
    await seedPaperOrder("paper-order-G", "w7", "up7", "UP", 0.30, 100);

    const { setTapeFetcher, checkGroundedFills } = await import("../src/orders/grounded-fills.js");
    const { setRandom } = await import("../src/orders/queue-sim.js");
    setRandom(() => 0);

    const trade = { asset: "up7", price: 0.45, size: 10, side: "SELL", timestamp: Date.now() / 1000 };
    setTapeFetcher(async () => [trade]);

    await checkGroundedFills();

    const { getDb } = await import("../src/db.js");
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM fills").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
