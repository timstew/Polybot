/**
 * Bid strategy unit tests — pure functions, deterministic.
 * Each strategy's compute() takes a BidContext and returns BidLevel[].
 */

import { describe, test, expect } from "bun:test";
import type { BidContext, BidLevel } from "../src/strategies/types.js";

// Helper to build a context with sensible defaults
function ctx(overrides: Partial<BidContext> = {}): BidContext {
  return {
    window_slug: "test-window",
    window_duration_sec: 300, // 5 min
    elapsed_sec: 60,
    elapsed_pct: 0.20,
    remaining_sec: 240,
    p_true: 0.55,
    spot_price: 75000,
    up_best_bid: 0.01, up_best_ask: 0.99, up_last_trade: 0.55,
    dn_best_bid: 0.01, dn_best_ask: 0.99, dn_last_trade: 0.45,
    up_inventory: 0, up_avg_cost: 0,
    dn_inventory: 0, dn_avg_cost: 0,
    base_bid_size: 25,
    committed_capital: 0,
    effective_capital: 1000,
    ...overrides,
  };
}

describe("hybrid strategy", () => {
  let hybrid: { compute: (ctx: BidContext) => BidLevel[] };

  test("import", async () => {
    const m = await import("../src/strategies/hybrid.js");
    hybrid = m.hybrid;
    expect(typeof hybrid.compute).toBe("function");
  });

  test("bids both sides at open (P_true=0.50)", () => {
    const bids = hybrid.compute(ctx({ p_true: 0.50, elapsed_pct: 0.05 }));
    expect(bids.length).toBe(2);
    const up = bids.find(b => b.side === "UP")!;
    const dn = bids.find(b => b.side === "DOWN")!;
    expect(up.price).toBeGreaterThanOrEqual(0.50);
    expect(dn.price).toBeGreaterThanOrEqual(0.50);
  });

  test("winning side follows P_true when high", () => {
    const bids = hybrid.compute(ctx({ p_true: 0.80 }));
    const up = bids.find(b => b.side === "UP")!;
    expect(up.price).toBeGreaterThanOrEqual(0.80);
  });

  test("losing side stays at floor", () => {
    const bids = hybrid.compute(ctx({ p_true: 0.80 }));
    const dn = bids.find(b => b.side === "DOWN")!;
    expect(dn.price).toBe(0.50); // $0.50 floor
  });

  test("prices capped at 0.95", () => {
    const bids = hybrid.compute(ctx({ p_true: 0.99 }));
    for (const b of bids) expect(b.price).toBeLessThanOrEqual(0.95);
  });

  test("size matches base_bid_size", () => {
    const bids = hybrid.compute(ctx({ base_bid_size: 30 }));
    for (const b of bids) expect(b.size).toBe(30);
  });
});

describe("bonereaper-ladder strategy", () => {
  let ladder: { compute: (ctx: BidContext) => BidLevel[]; clearWindowState?: (slug: string) => void };

  test("import", async () => {
    const m = await import("../src/strategies/bonereaper-ladder.js");
    ladder = m.bonereaperLadder;
    expect(typeof ladder.compute).toBe("function");
  });

  test("multi-level ladder at P_true=0.50 (uncertain)", () => {
    ladder.clearWindowState?.("test");
    const bids = ladder.compute(ctx({ p_true: 0.50, elapsed_pct: 0.10, window_slug: "test" }));
    // Should have multiple levels on both sides
    const upBids = bids.filter(b => b.side === "UP");
    const dnBids = bids.filter(b => b.side === "DOWN");
    expect(upBids.length).toBeGreaterThanOrEqual(2);
    expect(dnBids.length).toBeGreaterThanOrEqual(2);
  });

  test("ladder levels have ascending prices", () => {
    ladder.clearWindowState?.("test2");
    const bids = ladder.compute(ctx({ p_true: 0.60, window_slug: "test2" }));
    const upBids = bids.filter(b => b.side === "UP").sort((a, b) => a.level - b.level);
    for (let i = 1; i < upBids.length; i++) {
      expect(upBids[i].price).toBeGreaterThanOrEqual(upBids[i - 1].price);
    }
  });

  test("suppresses losing side late window when certainty is high", () => {
    ladder.clearWindowState?.("test3");
    // Activate certainty state
    ladder.compute(ctx({ p_true: 0.80, elapsed_pct: 0.60, window_slug: "test3" }));
    const bids = ladder.compute(ctx({ p_true: 0.80, elapsed_pct: 0.70, window_slug: "test3" }));
    const dnBids = bids.filter(b => b.side === "DOWN" && b.price > 0);
    expect(dnBids.length).toBe(0); // DOWN suppressed
  });

  test("heavy-side inventory suppression", () => {
    ladder.clearWindowState?.("test4");
    const bids = ladder.compute(ctx({
      p_true: 0.50, elapsed_pct: 0.20, window_slug: "test4",
      up_inventory: 100, dn_inventory: 5, // 95% UP = heavy
    }));
    const upBids = bids.filter(b => b.side === "UP" && b.price > 0);
    expect(upBids.length).toBe(0); // UP suppressed (too heavy)
  });
});

describe("bonereaper-mimic strategy", () => {
  let mimic: { compute: (ctx: BidContext) => BidLevel[]; getPhase?: (ctx: BidContext) => string; clearWindowState?: (slug: string) => void };

  test("import", async () => {
    const m = await import("../src/strategies/bonereaper-mimic.js");
    mimic = m.bonereaperMimic;
    expect(typeof mimic.compute).toBe("function");
  });

  test("OPEN phase: multi-level ladder with top level at ~$0.50", () => {
    mimic.clearWindowState?.("test-open");
    const bids = mimic.compute(ctx({ p_true: 0.50, elapsed_pct: 0.05, window_slug: "test-open" }));
    const upBids = bids.filter(b => b.side === "UP");
    const dnBids = bids.filter(b => b.side === "DOWN");
    // Should have multiple ladder levels
    expect(upBids.length).toBeGreaterThanOrEqual(2);
    expect(dnBids.length).toBeGreaterThanOrEqual(2);
    // Top level should be at hybrid floor ($0.50)
    const topUp = upBids.reduce((a, b) => b.price > a.price ? b : a);
    expect(topUp.price).toBeGreaterThanOrEqual(0.50);
    expect(mimic.getPhase?.(ctx({ elapsed_pct: 0.05 }))).toBe("OPEN");
  });

  test("MID phase: both sides near last-trade, multi-level", () => {
    mimic.clearWindowState?.("test-mid");
    // UP last-trade=0.55, so top bid should be ~0.53 (anchor - 2%)
    const bids = mimic.compute(ctx({ p_true: 0.60, elapsed_pct: 0.25, window_slug: "test-mid", up_last_trade: 0.55, dn_last_trade: 0.45 }));
    expect(bids.filter(b => b.side === "UP").length).toBeGreaterThanOrEqual(2);
    expect(bids.filter(b => b.side === "DOWN").length).toBeGreaterThanOrEqual(2);
    // Top UP bid should be anchored at last_trade (0.55) minus small offset
    const topUp = bids.filter(b => b.side === "UP").reduce((a, b) => b.price > a.price ? b : a);
    expect(topUp.price).toBeGreaterThanOrEqual(0.50);
    expect(topUp.price).toBeLessThanOrEqual(0.55); // below market
    expect(mimic.getPhase?.(ctx({ elapsed_pct: 0.25 }))).toBe("MID");
  });

  test("LATE phase: has sweep catchers on losing side", () => {
    mimic.clearWindowState?.("test-late");
    // Activate certainty
    mimic.compute(ctx({ p_true: 0.80, elapsed_pct: 0.55, window_slug: "test-late" }));
    const bids = mimic.compute(ctx({ p_true: 0.80, elapsed_pct: 0.80, window_slug: "test-late" }));
    // Should have cheap bids on DOWN (losing side)
    const dnBids = bids.filter(b => b.side === "DOWN");
    expect(dnBids.length).toBeGreaterThanOrEqual(1);
    expect(dnBids.some(b => b.price <= 0.15)).toBe(true); // sweep catcher
  });

  test("LATE phase: winning side gets larger size", () => {
    mimic.clearWindowState?.("test-late2");
    mimic.compute(ctx({ p_true: 0.80, elapsed_pct: 0.55, window_slug: "test-late2" }));
    const bids = mimic.compute(ctx({ p_true: 0.80, elapsed_pct: 0.80, base_bid_size: 25, window_slug: "test-late2" }));
    const upBid = bids.find(b => b.side === "UP")!;
    expect(upBid.size).toBeGreaterThan(25); // should be 2× = 50
  });

  test("LATE+CERT phase: size boost + sweep catchers", () => {
    mimic.clearWindowState?.("test-final");
    mimic.compute(ctx({ p_true: 0.90, elapsed_pct: 0.55, window_slug: "test-final" }));
    const bids = mimic.compute(ctx({ p_true: 0.90, elapsed_pct: 0.92, base_bid_size: 25, window_slug: "test-final" }));
    // Winning side (UP) should have 3× size at >85% elapsed
    const upBids = bids.filter(b => b.side === "UP");
    expect(upBids.some(b => b.size >= 75)).toBe(true); // 3× = 75
    // Losing side should have sweep catchers
    const dnBids = bids.filter(b => b.side === "DOWN");
    expect(dnBids.some(b => b.price <= 0.05)).toBe(true); // cheap sweep
    expect(mimic.getPhase?.(ctx({ elapsed_pct: 0.92, window_slug: "test-final" }))).toContain("CERT");
  });

  test("never fully suppresses losing side (unlike ladder)", () => {
    mimic.clearWindowState?.("test-nosuppress");
    mimic.compute(ctx({ p_true: 0.90, elapsed_pct: 0.55, window_slug: "test-nosuppress" }));
    const bids = mimic.compute(ctx({ p_true: 0.90, elapsed_pct: 0.85, window_slug: "test-nosuppress" }));
    const dnBids = bids.filter(b => b.side === "DOWN" && b.price > 0);
    expect(dnBids.length).toBeGreaterThan(0); // always has losing-side bids
  });
});

describe("strategy registry", () => {
  test("list strategies", async () => {
    const { listStrategies } = await import("../src/strategies/index.js");
    const list = listStrategies();
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.some(s => s.name === "hybrid")).toBe(true);
    expect(list.some(s => s.name === "bonereaper-mimic")).toBe(true);
  });

  test("get strategy by name", async () => {
    const { getStrategy } = await import("../src/strategies/index.js");
    const s = getStrategy("hybrid");
    expect(s.name).toBe("hybrid");
    expect(typeof s.compute).toBe("function");
  });

  test("throws on unknown strategy", async () => {
    const { getStrategy } = await import("../src/strategies/index.js");
    expect(() => getStrategy("nonexistent")).toThrow();
  });
});
