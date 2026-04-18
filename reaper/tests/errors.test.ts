/**
 * PolymarketError + withRetry tests.
 */

import { describe, test, expect } from "bun:test";
import { PolymarketError, ErrorCode, withRetry } from "../src/core/errors.js";

describe("PolymarketError", () => {
  test("construct with code and message", () => {
    const err = new PolymarketError(ErrorCode.RateLimited, "Too many requests", true);
    expect(err.code).toBe(ErrorCode.RateLimited);
    expect(err.message).toBe("Too many requests");
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("PolymarketError");
  });

  test("fromHttpStatus — 429 = rate limited, retryable", () => {
    const err = PolymarketError.fromHttpStatus(429);
    expect(err.code).toBe(ErrorCode.RateLimited);
    expect(err.retryable).toBe(true);
  });

  test("fromHttpStatus — 401 = unauthorized, not retryable", () => {
    const err = PolymarketError.fromHttpStatus(401);
    expect(err.code).toBe(ErrorCode.Unauthorized);
    expect(err.retryable).toBe(false);
  });

  test("fromHttpStatus — 500 = network error, retryable", () => {
    const err = PolymarketError.fromHttpStatus(500, "Internal Server Error");
    expect(err.code).toBe(ErrorCode.NetworkError);
    expect(err.retryable).toBe(true);
  });
});

describe("withRetry", () => {
  test("succeeds on first try", async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 42; });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  test("retries on retryable error", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new PolymarketError(ErrorCode.NetworkError, "fail", true);
      return "ok";
    }, { maxRetries: 5, baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("does NOT retry non-retryable error", async () => {
    let calls = 0;
    try {
      await withRetry(async () => {
        calls++;
        throw new PolymarketError(ErrorCode.Unauthorized, "nope", false);
      }, { maxRetries: 5, baseDelayMs: 10 });
    } catch (e) {
      expect(calls).toBe(1); // no retries
      expect((e as PolymarketError).code).toBe(ErrorCode.Unauthorized);
    }
  });

  test("gives up after maxRetries", async () => {
    let calls = 0;
    try {
      await withRetry(async () => {
        calls++;
        throw new PolymarketError(ErrorCode.NetworkError, "fail", true);
      }, { maxRetries: 2, baseDelayMs: 10 });
    } catch {
      expect(calls).toBe(3); // 1 initial + 2 retries
    }
  });

  test("calls onRetry callback", async () => {
    const retries: number[] = [];
    try {
      await withRetry(async () => {
        throw new PolymarketError(ErrorCode.NetworkError, "fail", true);
      }, { maxRetries: 2, baseDelayMs: 10, onRetry: (a) => retries.push(a) });
    } catch { /* expected */ }
    expect(retries).toEqual([1, 2]);
  });
});
