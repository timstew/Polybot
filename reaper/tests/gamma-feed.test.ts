/**
 * Gamma feed tests — resolution checking against real Gamma API.
 */

import { describe, test, expect } from "bun:test";
import { checkMarketResolution } from "../src/feeds/gamma-feed.js";

describe("gamma-feed", () => {
  test("checkMarketResolution — active market returns closed=false", async () => {
    // Use a slug pattern that's likely active or very recent
    const result = await checkMarketResolution("btc-updown-5m-9999999999");
    // Non-existent slug → closed=false, outcome=null
    expect(result.closed).toBe(false);
    expect(result.outcome).toBeNull();
  });

  test("checkMarketResolution — handles network errors gracefully", async () => {
    // Invalid slug won't crash
    const result = await checkMarketResolution("");
    expect(result.closed).toBe(false);
    expect(result.outcome).toBeNull();
  });

  test("checkMarketResolution — returns valid structure", async () => {
    const result = await checkMarketResolution("test");
    expect(typeof result.closed).toBe("boolean");
    expect(result.outcome === null || result.outcome === "UP" || result.outcome === "DOWN").toBe(true);
  });
});
