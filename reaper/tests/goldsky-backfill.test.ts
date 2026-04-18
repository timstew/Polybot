/**
 * Backfill integration tests — stubbed Goldsky fetcher drives rows into DB.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import type { GoldskyEvent, CursorState } from "../src/feeds/goldsky-feed.js";

async function resetDb() {
  const { initDb, getDb } = await import("../src/db.js");
  initDb(":memory:");
  const db = getDb();
  db.exec("DELETE FROM goldsky_trades");
  db.exec("DELETE FROM goldsky_cursor");
  db.exec("DELETE FROM config");
  return db;
}

function event(id: string, ts: number, maker = "0xbr", taker = "0xcp"): GoldskyEvent {
  return {
    id, timestamp: String(ts),
    maker, makerAssetId: "1", makerAmountFilled: "1000000",
    taker, takerAssetId: "0", takerAmountFilled: "500000",
    fee: "0", orderHash: "0xord" + id, transactionHash: "0xtx" + id,
  };
}

describe("backfillWalletRole: stubbed fetcher", () => {
  beforeEach(async () => { await resetDb(); });

  afterAll(async () => {
    const { resetGoldskyFetcher } = await import("../src/analysis/goldsky-backfill.js");
    resetGoldskyFetcher();
  });

  test("fetches and inserts events, then stops at empty batch", async () => {
    const { setGoldskyFetcher, backfillWalletRole } = await import("../src/analysis/goldsky-backfill.js");

    let called = 0;
    const batches: GoldskyEvent[][] = [
      [event("e1", 100), event("e2", 101), event("e3", 102)],
      [], // done
    ];
    setGoldskyFetcher(async () => batches[called++] ?? []);

    const r = await backfillWalletRole("0xBR", "maker", 10);
    expect(r.fetched).toBe(3);
    expect(r.inserted).toBe(3);
    expect(r.reachedEnd).toBe(true);

    const { getDb } = await import("../src/db.js");
    const rows = getDb().prepare("SELECT id, tracked_wallet, role FROM goldsky_trades ORDER BY id").all() as Array<{ id: string; tracked_wallet: string; role: string }>;
    expect(rows).toHaveLength(3);
    expect(rows[0].tracked_wallet).toBe("0xbr"); // lowercased
    expect(rows[0].role).toBe("maker");
  });

  test("dedup: re-running with overlapping events inserts zero new rows", async () => {
    const { setGoldskyFetcher, backfillWalletRole } = await import("../src/analysis/goldsky-backfill.js");
    const first = [event("a", 100), event("b", 101)];

    let callCount = 0;
    setGoldskyFetcher(async () => { callCount++; return callCount === 1 ? first : []; });
    await backfillWalletRole("0xX", "maker", 10);

    // Second run: fetcher returns same events again (simulating overlap)
    callCount = 0;
    setGoldskyFetcher(async () => { callCount++; return callCount === 1 ? first : []; });
    const r = await backfillWalletRole("0xX", "maker", 10);

    expect(r.fetched).toBe(2);
    expect(r.inserted).toBe(0); // all deduped by id

    const { getDb } = await import("../src/db.js");
    const count = getDb().prepare("SELECT COUNT(*) AS n FROM goldsky_trades").get() as { n: number };
    expect(count.n).toBe(2);
  });

  test("cursor persists across invocations", async () => {
    const { setGoldskyFetcher, backfillWalletRole } = await import("../src/analysis/goldsky-backfill.js");
    setGoldskyFetcher(async () => [event("a", 500)]);
    await backfillWalletRole("0xY", "taker", 2);

    const { getDb } = await import("../src/db.js");
    const cursor = getDb().prepare("SELECT last_timestamp, last_id, sticky_timestamp FROM goldsky_cursor WHERE wallet = '0xy' AND role = 'taker'").get() as { last_timestamp: number; last_id: string | null; sticky_timestamp: number | null };
    expect(cursor).toBeDefined();
    expect(cursor.last_timestamp).toBe(500);
  });

  test("per-(wallet, role) cursors are independent", async () => {
    const { setGoldskyFetcher, backfillWalletRole } = await import("../src/analysis/goldsky-backfill.js");

    let phase: "br-maker" | "br-taker" | "cp-maker" | "cp-taker" | "done" = "br-maker";
    setGoldskyFetcher(async (cursor: CursorState, opts: { makerEq?: string; takerEq?: string }) => {
      if (phase === "br-maker" && opts.makerEq === "0xbr") { phase = "done"; return [event("m1", 100)]; }
      if (phase === "br-taker" && opts.takerEq === "0xbr") { phase = "done"; return [event("t1", 200)]; }
      return [];
    });

    phase = "br-maker";
    await backfillWalletRole("0xBR", "maker", 2);
    phase = "br-taker";
    await backfillWalletRole("0xBR", "taker", 2);

    const { getDb } = await import("../src/db.js");
    const cursors = getDb().prepare("SELECT wallet, role, last_timestamp FROM goldsky_cursor ORDER BY role").all() as Array<{ wallet: string; role: string; last_timestamp: number }>;
    expect(cursors).toHaveLength(2);
    expect(cursors.find(c => c.role === "maker")?.last_timestamp).toBe(100);
    expect(cursors.find(c => c.role === "taker")?.last_timestamp).toBe(200);
  });

  test("backfillAll iterates configured wallets × both roles", async () => {
    const { setConfig } = await import("../src/db.js");
    setConfig("goldsky_wallets", "0xABC,0xDEF");

    const { setGoldskyFetcher, backfillAll } = await import("../src/analysis/goldsky-backfill.js");
    const seen: string[] = [];
    setGoldskyFetcher(async (_c: CursorState, opts: { makerEq?: string; takerEq?: string }) => {
      seen.push(opts.makerEq ?? opts.takerEq ?? "?");
      return [];
    });

    const results = await backfillAll(1);
    expect(results).toHaveLength(4); // 2 wallets × 2 roles
    expect(seen.sort()).toEqual(["0xabc", "0xabc", "0xdef", "0xdef"]);
  });

  test("empty goldsky_wallets config → no results", async () => {
    const { setConfig } = await import("../src/db.js");
    setConfig("goldsky_wallets", "");

    const { backfillAll } = await import("../src/analysis/goldsky-backfill.js");
    const results = await backfillAll(1);
    expect(results).toEqual([]);
  });
});
