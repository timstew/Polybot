/**
 * Goldsky feed tests — cursor state machine + where-clause construction.
 * Pure logic, no network.
 */

import { describe, test, expect } from "bun:test";
import {
  buildWhereClause,
  advanceCursor,
  emptyCursor,
  type CursorState,
  type GoldskyEvent,
} from "../src/feeds/goldsky-feed.js";

function event(id: string, ts: number): GoldskyEvent {
  return {
    id, timestamp: String(ts),
    maker: "0xaaa", makerAssetId: "1", makerAmountFilled: "1000000",
    taker: "0xbbb", takerAssetId: "0", takerAmountFilled: "500000",
    fee: "0", orderHash: "0xord", transactionHash: "0xtx",
  };
}

describe("buildWhereClause", () => {
  test("initial cursor → timestamp_gt 0", () => {
    const where = buildWhereClause(emptyCursor(), {});
    expect(where).toBe(`timestamp_gt: "0"`);
  });

  test("sticky cursor → equality + id_gt", () => {
    const c: CursorState = { lastTimestamp: 100, lastId: "abc", stickyTimestamp: 150 };
    const where = buildWhereClause(c, {});
    expect(where).toContain(`timestamp: "150"`);
    expect(where).toContain(`id_gt: "abc"`);
  });

  test("maker filter is lowercased", () => {
    const where = buildWhereClause(emptyCursor(), { makerEq: "0xABCDef" });
    expect(where).toContain(`maker: "0xabcdef"`);
  });

  test("taker filter is lowercased", () => {
    const where = buildWhereClause(emptyCursor(), { takerEq: "0xEEBDE7A0" });
    expect(where).toContain(`taker: "0xeebde7a0"`);
  });
});

describe("advanceCursor", () => {
  const BATCH = 10;

  test("empty batch without sticky → done=true, cursor unchanged", () => {
    const c = emptyCursor();
    const { next, done } = advanceCursor(c, [], BATCH);
    expect(done).toBe(true);
    expect(next).toEqual(c);
  });

  test("empty batch while sticky → clear sticky, advance past sticky timestamp", () => {
    const c: CursorState = { lastTimestamp: 100, lastId: "x", stickyTimestamp: 150 };
    const { next, done } = advanceCursor(c, [], BATCH);
    expect(done).toBe(false);
    expect(next.lastTimestamp).toBe(150);
    expect(next.lastId).toBe(null);
    expect(next.stickyTimestamp).toBe(null);
  });

  test("full batch, all same timestamp → enter sticky at that timestamp", () => {
    const c = emptyCursor();
    const events = Array.from({ length: BATCH }, (_, i) => event(`id-${i}`, 200));
    const { next, done } = advanceCursor(c, events, BATCH);
    expect(done).toBe(false);
    expect(next.stickyTimestamp).toBe(200);
    expect(next.lastId).toBe("id-9");
  });

  test("full batch, mixed timestamps → sticky on last timestamp", () => {
    const c = emptyCursor();
    const events = [
      ...Array.from({ length: 5 }, (_, i) => event(`id-${i}`, 200)),
      ...Array.from({ length: 5 }, (_, i) => event(`id-${i + 5}`, 210)),
    ];
    const { next, done } = advanceCursor(c, events, BATCH);
    expect(done).toBe(false);
    expect(next.stickyTimestamp).toBe(210);
    expect(next.lastId).toBe("id-9");
  });

  test("partial batch while sticky → exhausted, advance past sticky", () => {
    const c: CursorState = { lastTimestamp: 100, lastId: "x", stickyTimestamp: 150 };
    const events = [event("id-a", 150), event("id-b", 150)];
    const { next, done } = advanceCursor(c, events, BATCH);
    expect(next.lastTimestamp).toBe(150);
    expect(next.stickyTimestamp).toBe(null);
    expect(next.lastId).toBe(null);
    expect(done).toBe(false);
  });

  test("partial batch, not sticky → advance to last observed timestamp", () => {
    const c = emptyCursor();
    const events = [event("id-a", 200), event("id-b", 210)];
    const { next, done } = advanceCursor(c, events, BATCH);
    expect(next.lastTimestamp).toBe(210);
    expect(next.stickyTimestamp).toBe(null);
  });
});
