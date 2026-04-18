import { describe, test, expect } from "bun:test";
import { computeSkewGuard, applyGuardToLadder } from "../src/strategies/inventory-guard.js";

describe("computeSkewGuard tiers", () => {
  test("below trigger returns none", () => {
    const g = computeSkewGuard(5, 0, 50);
    expect(g.up).toBe("none");
    expect(g.dn).toBe("none");
    expect(g.reason).toBe("below-trigger");
  });

  test("under 50% skew (e.g. 40/60 from UP's view) returns none for balanced side", () => {
    // 40 UP + 60 DN → heavy is DN at 60%, UP is balanced
    const g = computeSkewGuard(40, 60, 50);
    expect(g.up).toBe("none");
    // DN is in 50-75% tier
    expect(g.dn).toBe("halve-top");
  });

  test("exactly 50.01/49.99 → just over 50% triggers halve-top", () => {
    const g = computeSkewGuard(50.01, 49.99, 50);
    expect(g.up).toBe("halve-top");
  });

  test("60/40 → halve-top on heavy", () => {
    const g = computeSkewGuard(60, 40, 50);
    expect(g.up).toBe("halve-top");
    expect(g.dn).toBe("none");
    expect(g.reason).toBe("skew-50-75");
  });

  test("80/20 → deepest-only on heavy", () => {
    const g = computeSkewGuard(80, 20, 50);
    expect(g.up).toBe("deepest-only");
    expect(g.dn).toBe("none");
  });

  test("95/5 → full suppression on heavy", () => {
    const g = computeSkewGuard(95, 5, 50);
    expect(g.up).toBe("full");
    expect(g.dn).toBe("none");
  });

  test("all-one-side (100/0) → full on that side", () => {
    const g = computeSkewGuard(100, 0, 50);
    expect(g.up).toBe("full");
    expect(g.heavyPct).toBe(1);
  });

  test("tier boundaries: exactly 50% triggers first tier (halve-top)", () => {
    const g = computeSkewGuard(50, 50, 10);
    // heavyPct = 0.50 falls into [0.50, 0.75) → halve-top. Ties resolve to UP.
    expect(g.up).toBe("halve-top");
    expect(g.dn).toBe("none");
  });

  test("tier boundaries: 75% triggers deepest-only", () => {
    const g = computeSkewGuard(75, 25, 50);
    expect(g.up).toBe("deepest-only");
  });

  test("tier boundaries: 90% triggers full", () => {
    const g = computeSkewGuard(90, 10, 50);
    expect(g.up).toBe("full");
  });

  test("skew on DOWN side mirrors UP", () => {
    const g = computeSkewGuard(10, 90, 50);
    expect(g.up).toBe("none");
    expect(g.dn).toBe("full");
  });
});

describe("applyGuardToLadder", () => {
  test("none leaves prices and sizes unchanged", () => {
    const prices = [0.15, 0.30, 0.50];
    const sizes = [25, 25, 25];
    applyGuardToLadder(prices, sizes, "none");
    expect(prices).toEqual([0.15, 0.30, 0.50]);
    expect(sizes).toEqual([25, 25, 25]);
  });

  test("halve-top halves only the top level size", () => {
    const prices = [0.15, 0.30, 0.50];
    const sizes = [25, 25, 24];
    applyGuardToLadder(prices, sizes, "halve-top");
    expect(prices).toEqual([0.15, 0.30, 0.50]); // prices unchanged
    expect(sizes).toEqual([25, 25, 12]); // top halved
  });

  test("halve-top respects minimum size floor", () => {
    const prices = [0.15, 0.30, 0.50];
    const sizes = [25, 25, 8];
    applyGuardToLadder(prices, sizes, "halve-top", 5);
    expect(sizes[2]).toBeGreaterThanOrEqual(5);
  });

  test("deepest-only zeros everything except prices[0]", () => {
    const prices = [0.15, 0.30, 0.50];
    const sizes = [25, 25, 25];
    applyGuardToLadder(prices, sizes, "deepest-only");
    expect(prices[0]).toBe(0.15); // deepest preserved
    expect(prices[1]).toBe(0);
    expect(prices[2]).toBe(0);
  });

  test("full zeros all prices", () => {
    const prices = [0.15, 0.30, 0.50];
    const sizes = [25, 25, 25];
    applyGuardToLadder(prices, sizes, "full");
    expect(prices).toEqual([0, 0, 0]);
  });

  test("handles empty ladder", () => {
    const prices: number[] = [];
    const sizes: number[] = [];
    applyGuardToLadder(prices, sizes, "full");
    expect(prices).toEqual([]);
  });
});
