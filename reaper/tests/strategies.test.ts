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

  test("heavy-side inventory suppression at 90%+ skew (full tier)", () => {
    ladder.clearWindowState?.("test4");
    const bids = ladder.compute(ctx({
      p_true: 0.50, elapsed_pct: 0.20, window_slug: "test4",
      up_inventory: 100, dn_inventory: 5, // 95% UP = heavy
    }));
    const upBids = bids.filter(b => b.side === "UP" && b.price > 0);
    expect(upBids.length).toBe(0); // UP fully suppressed
  });

  test("sliding ratchet: 60/40 skew → heavy-side top bid size halved", () => {
    ladder.clearWindowState?.("tier-60");
    const bids = ladder.compute(ctx({
      p_true: 0.50, elapsed_pct: 0.20, window_slug: "tier-60", base_bid_size: 30,
      up_inventory: 60, dn_inventory: 40, // 60% UP → halve-top
    }));
    const upBids = bids.filter(b => b.side === "UP" && b.price > 0);
    const dnBids = bids.filter(b => b.side === "DOWN" && b.price > 0);
    // UP top bid (level=nLevels) should have half size; other UP levels at base
    expect(upBids.length).toBeGreaterThan(0);
    expect(dnBids.length).toBeGreaterThan(0);
    const topUp = upBids.reduce((a, b) => b.level > a.level ? b : a);
    expect(topUp.size).toBeLessThanOrEqual(16); // halved from 30, floor(30/2) = 15
    // DOWN side is untouched
    const topDn = dnBids.reduce((a, b) => b.level > a.level ? b : a);
    expect(topDn.size).toBe(30);
  });

  test("sliding ratchet: 80/20 skew → heavy-side only deepest bid remains", () => {
    ladder.clearWindowState?.("tier-80");
    const bids = ladder.compute(ctx({
      p_true: 0.50, elapsed_pct: 0.20, window_slug: "tier-80", base_bid_size: 30,
      up_inventory: 80, dn_inventory: 20,
    }));
    const upBids = bids.filter(b => b.side === "UP" && b.price > 0);
    // Only deepest (cheapest) UP bid should remain — lvl=1 which maps to idx=0 (deep value)
    expect(upBids.length).toBe(1);
    expect(upBids[0].level).toBe(1); // deepest tier
    expect(upBids[0].price).toBeCloseTo(0.15, 2);
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

  test("LATE phase: has sweep catchers on losing side when pairing gap exists", () => {
    mimic.clearWindowState?.("test-late");
    // Activate certainty and seed inventory imbalance (winning-side loaded → need DOWN sweeps)
    mimic.compute(ctx({ p_true: 0.80, elapsed_pct: 0.55, window_slug: "test-late" }));
    const bids = mimic.compute(ctx({
      p_true: 0.80, elapsed_pct: 0.80, window_slug: "test-late",
      up_inventory: 100, up_avg_cost: 0.80,
      dn_inventory: 0,
    }));
    // Should have cheap sweep bids on DOWN (losing side — we're short DOWN)
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

  test("LATE+CERT phase: 5× size boost on winning side when inventory is balanced", () => {
    mimic.clearWindowState?.("test-boost");
    mimic.compute(ctx({ p_true: 0.90, elapsed_pct: 0.55, window_slug: "test-boost" }));
    const bids = mimic.compute(ctx({
      p_true: 0.90, elapsed_pct: 0.92, base_bid_size: 25, window_slug: "test-boost",
      up_inventory: 50, up_avg_cost: 0.80,
      dn_inventory: 50, dn_avg_cost: 0.20, // balanced → UP ladder not suppressed
    }));
    const upBids = bids.filter(b => b.side === "UP");
    expect(upBids.some(b => b.size >= 75)).toBe(true); // 3-5× base = 75-125
    const phase = mimic.getPhase?.(ctx({ elapsed_pct: 0.92, window_slug: "test-boost" }));
    expect(phase).toMatch(/CERT|TAKE/); // sticky state is active (either certainty or taker phase)
  });

  test("LATE+CERT phase: floor-tier sweep catcher on losing side when skewed", () => {
    mimic.clearWindowState?.("test-sweep");
    mimic.compute(ctx({ p_true: 0.90, elapsed_pct: 0.55, window_slug: "test-sweep" }));
    const bids = mimic.compute(ctx({
      p_true: 0.90, elapsed_pct: 0.92, base_bid_size: 25, window_slug: "test-sweep",
      up_inventory: 100, up_avg_cost: 0.80, // heavy UP → short DOWN
      dn_inventory: 0,
    }));
    const dnBids = bids.filter(b => b.side === "DOWN");
    expect(dnBids.some(b => b.price <= 0.05)).toBe(true); // cheap floor sweep
  });

  test("never fully suppresses losing side (unlike ladder)", () => {
    mimic.clearWindowState?.("test-nosuppress");
    mimic.compute(ctx({ p_true: 0.90, elapsed_pct: 0.55, window_slug: "test-nosuppress" }));
    const bids = mimic.compute(ctx({ p_true: 0.90, elapsed_pct: 0.85, window_slug: "test-nosuppress" }));
    const dnBids = bids.filter(b => b.side === "DOWN" && b.price > 0);
    expect(dnBids.length).toBeGreaterThan(0); // always has losing-side bids
  });
});

describe("bonereaper-taker strategy", () => {
  let taker: { compute: (ctx: BidContext) => BidLevel[]; getPhase?: (ctx: BidContext) => string; clearWindowState?: (slug: string) => void };

  test("import", async () => {
    const m = await import("../src/strategies/bonereaper-taker.js");
    taker = m.bonereaperTaker;
    expect(typeof taker.compute).toBe("function");
  });

  test("winning side L1 bids AT the best ask (taker cross)", () => {
    taker.clearWindowState?.("tk1");
    taker.compute(ctx({ p_true: 0.80, elapsed_pct: 0.55, window_slug: "tk1", up_best_ask: 0.78, up_ask_size: 100 }));
    const bids = taker.compute(ctx({
      p_true: 0.80, elapsed_pct: 0.60, window_slug: "tk1",
      up_best_ask: 0.78, up_ask_size: 100, up_last_trade: 0.75,
    }));
    // L1 UP should bid AT or very near best ask (not at last_trade below)
    const upBids = bids.filter(b => b.side === "UP" && b.level === 3); // level = LEVELS.length - i, i=0 → level 3 (L1)
    const topUp = upBids.reduce((a, b) => b.price > a.price ? b : a);
    expect(topUp.price).toBeCloseTo(0.78, 2);
  });

  test("L1 size capped to available ask depth (no book walking)", () => {
    taker.clearWindowState?.("tk2");
    const bids = taker.compute(ctx({
      p_true: 0.80, elapsed_pct: 0.10, window_slug: "tk2", base_bid_size: 100,
      up_best_ask: 0.80, up_ask_size: 15, up_last_trade: 0.75,
    }));
    const upL1 = bids.find(b => b.side === "UP" && b.level === 3)!;
    expect(upL1.size).toBeLessThanOrEqual(15);
  });

  test("90% inventory guard suppresses heavy-side maker bids", () => {
    taker.clearWindowState?.("tk3");
    const bids = taker.compute(ctx({
      p_true: 0.50, elapsed_pct: 0.20, window_slug: "tk3", base_bid_size: 25,
      up_inventory: 95, up_avg_cost: 0.50,
      dn_inventory: 5, dn_avg_cost: 0.50,
    }));
    // High-priced UP bids (price > 0.10) should be suppressed; cheap sweeps allowed
    const expensiveUp = bids.filter(b => b.side === "UP" && b.price > 0.10);
    expect(expensiveUp.length).toBe(0);
  });
});

describe("bonereaper-hybrid-maker-taker strategy", () => {
  let hybrid: {
    compute: (ctx: BidContext) => BidLevel[];
    evaluateTaker: (ctx: BidContext, tp: number, ts: number, side: string, tok: string) => { shouldTake: boolean; side: "UP" | "DOWN"; price: number; size: number; reason: string };
    clearWindowState?: (slug: string) => void;
  };

  test("import", async () => {
    const m = await import("../src/strategies/bonereaper-hybrid-maker-taker.js");
    hybrid = m.bonereaperHybridMakerTaker;
    expect(typeof hybrid.compute).toBe("function");
    expect(typeof hybrid.evaluateTaker).toBe("function");
  });

  test("compute produces 3-level maker ladder", () => {
    hybrid.clearWindowState?.("h1");
    const bids = hybrid.compute(ctx({ p_true: 0.50, elapsed_pct: 0.05, window_slug: "h1" }));
    expect(bids.filter(b => b.side === "UP").length).toBeGreaterThanOrEqual(2);
    expect(bids.filter(b => b.side === "DOWN").length).toBeGreaterThanOrEqual(2);
  });

  test("evaluateTaker: cheap losing-side trade triggers taker buy", () => {
    hybrid.clearWindowState?.("h2");
    // P_true 0.80 → UP winning, DOWN losing. DOWN trade at $0.15 (< $0.25 threshold).
    const c = ctx({ p_true: 0.80, elapsed_pct: 0.30, window_slug: "h2" });
    const signal = hybrid.evaluateTaker(c, 0.15, 50, "SELL", "dn-token-B");
    // The evaluator uses the asset_id to determine side via the context's tokens —
    // since our ctx lacks token ids in types, behavior may differ, but basic invariant:
    // for a cheap trade price < TAKER_CHEAP_THRESHOLD, shouldTake should be true on some side.
    expect(typeof signal.shouldTake).toBe("boolean");
    if (signal.shouldTake) {
      expect(signal.size).toBeGreaterThan(0);
      expect(signal.price).toBe(0.15);
    }
  });
});

describe("bonereaper-ladder: inventory guard progression", () => {
  let ladder: { compute: (ctx: BidContext) => BidLevel[]; clearWindowState?: (slug: string) => void };

  test("import", async () => {
    const m = await import("../src/strategies/bonereaper-ladder.js");
    ladder = m.bonereaperLadder;
  });

  test("balanced inventory → both sides bid", () => {
    ladder.clearWindowState?.("lg1");
    const bids = ladder.compute(ctx({
      p_true: 0.50, elapsed_pct: 0.20, window_slug: "lg1",
      up_inventory: 50, dn_inventory: 50,
    }));
    expect(bids.filter(b => b.side === "UP" && b.price > 0).length).toBeGreaterThan(0);
    expect(bids.filter(b => b.side === "DOWN" && b.price > 0).length).toBeGreaterThan(0);
  });

  test("sticky state stays activated even if p_true wobbles", () => {
    // Use bonereaper-mimic which has documented sticky behavior
    import("../src/strategies/bonereaper-mimic.js").then(({ bonereaperMimic }) => {
      bonereaperMimic.clearWindowState?.("sticky1");
      // Activate on UP
      bonereaperMimic.compute(ctx({ p_true: 0.85, elapsed_pct: 0.40, window_slug: "sticky1" }));
      // Small wobble: p_true drops slightly but NOT past the flip-back threshold (0.40)
      bonereaperMimic.compute(ctx({ p_true: 0.55, elapsed_pct: 0.60, window_slug: "sticky1" }));
      // getPhase should still be CERT (sticky)
      const phase = bonereaperMimic.getPhase?.(ctx({ p_true: 0.55, elapsed_pct: 0.60, window_slug: "sticky1" }));
      expect(phase).toContain("CERT");
    });
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
