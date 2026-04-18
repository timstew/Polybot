import { describe, test, expect, afterEach } from "bun:test";
import {
  queueFillProbability,
  rollForFill,
  setRandom,
  resetRandom,
  PROB_PRICE_IMPROVEMENT,
  PROB_SUBTICK_IMPROVEMENT,
  PROB_TIED_AT_LEVEL,
} from "../src/orders/queue-sim.js";

describe("queueFillProbability", () => {
  test("bid ≥ 1¢ better than trade price → price-priority lead", () => {
    expect(queueFillProbability(0.60, 0.50)).toBe(PROB_PRICE_IMPROVEMENT);
    expect(queueFillProbability(0.51, 0.50)).toBe(PROB_PRICE_IMPROVEMENT);
    expect(queueFillProbability(0.95, 0.01)).toBe(PROB_PRICE_IMPROVEMENT);
  });

  test("sub-tick improvement → probable lead", () => {
    expect(queueFillProbability(0.505, 0.50)).toBe(PROB_SUBTICK_IMPROVEMENT);
    expect(queueFillProbability(0.501, 0.50)).toBe(PROB_SUBTICK_IMPROVEMENT);
  });

  test("equal price → back of queue", () => {
    expect(queueFillProbability(0.50, 0.50)).toBe(PROB_TIED_AT_LEVEL);
    expect(queueFillProbability(0.01, 0.01)).toBe(PROB_TIED_AT_LEVEL);
  });

  test("bid below trade price → zero", () => {
    expect(queueFillProbability(0.49, 0.50)).toBe(0);
    expect(queueFillProbability(0.0, 0.01)).toBe(0);
  });

  test("probabilities are ordered: improvement > subtick > tied > 0", () => {
    expect(PROB_PRICE_IMPROVEMENT).toBeGreaterThan(PROB_SUBTICK_IMPROVEMENT);
    expect(PROB_SUBTICK_IMPROVEMENT).toBeGreaterThan(PROB_TIED_AT_LEVEL);
    expect(PROB_TIED_AT_LEVEL).toBeGreaterThan(0);
  });
});

describe("rollForFill", () => {
  afterEach(() => resetRandom());

  test("probability 1.0 always fills", () => {
    setRandom(() => 0.999999);
    expect(rollForFill(1.0)).toBe(true);
  });

  test("probability 0 never fills", () => {
    setRandom(() => 0.000001);
    expect(rollForFill(0.0)).toBe(false);
  });

  test("strict inequality — random == probability is a miss", () => {
    setRandom(() => 0.5);
    expect(rollForFill(0.5)).toBe(false);
    setRandom(() => 0.4999);
    expect(rollForFill(0.5)).toBe(true);
  });

  test("multiplier scales probability", () => {
    setRandom(() => 0.5);
    expect(rollForFill(0.4, 2.0)).toBe(true); // effective 0.8 > 0.5
    expect(rollForFill(0.4, 1.0)).toBe(false); // 0.4 < 0.5
  });

  test("multiplier clamped to [0,1]", () => {
    setRandom(() => 0.99);
    expect(rollForFill(0.5, 100)).toBe(true); // clamped to 1.0
    setRandom(() => 0.01);
    expect(rollForFill(0.5, -100)).toBe(false); // clamped to 0
  });

  test("empirical rate over N rolls approximates probability", () => {
    let seed = 1;
    const prng = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    setRandom(prng);

    const N = 10_000;
    const target = 0.25;
    let hits = 0;
    for (let i = 0; i < N; i++) if (rollForFill(target)) hits++;
    const rate = hits / N;
    expect(rate).toBeGreaterThan(target - 0.02);
    expect(rate).toBeLessThan(target + 0.02);
  });
});
