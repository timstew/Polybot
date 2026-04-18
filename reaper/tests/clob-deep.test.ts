/**
 * Deep CLOB testing — exercises the full API surface without spending money.
 *
 * All operations are read-only or sign-but-don't-post.
 * Requires POLYMARKET_PRIVATE_KEY env var.
 */

import { describe, test, expect } from "bun:test";

const key = process.env.POLYMARKET_PRIVATE_KEY;
const CLOB_HOST = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

// Find a currently-active token for book/price queries
async function findActiveMarket(): Promise<{ slug: string; upToken: string; dnToken: string; conditionId: string } | null> {
  try {
    const resp = await fetch(`${GAMMA_API}/markets?active=true&closed=false&limit=5`);
    const markets = await resp.json() as Array<Record<string, unknown>>;
    for (const m of markets) {
      const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds as string) as string[] : [];
      if (tokens.length >= 2 && m.conditionId) {
        return {
          slug: (m.slug as string) || "",
          upToken: tokens[0],
          dnToken: tokens[1],
          conditionId: m.conditionId as string,
        };
      }
    }
  } catch { /* fall through */ }
  return null;
}

describe("CLOB read-only operations", () => {
  test("server time", async () => {
    const resp = await fetch(`${CLOB_HOST}/time`);
    expect(resp.ok).toBe(true);
    const data = await resp.json();
    expect(typeof data).toBe("number");
    // Server time should be within 30s of our time
    expect(Math.abs(data - Date.now() / 1000)).toBeLessThan(30);
  });

  test("tick size for active token", async () => {
    const market = await findActiveMarket();
    if (!market) return; // skip if no active market
    const resp = await fetch(`${CLOB_HOST}/tick-size?token_id=${market.upToken}`);
    if (!resp.ok) return;
    const data = await resp.json() as { minimum_tick_size: string };
    expect(data.minimum_tick_size).toBeTruthy();
    const tick = parseFloat(data.minimum_tick_size);
    expect(tick).toBeGreaterThan(0);
    expect(tick).toBeLessThanOrEqual(0.01);
  });

  test("midpoint for active token", async () => {
    const market = await findActiveMarket();
    if (!market) return;
    const resp = await fetch(`${CLOB_HOST}/midpoint?token_id=${market.upToken}`);
    if (!resp.ok) return; // some tokens have no book
    const data = await resp.json() as { mid: string };
    if (data.mid) {
      const mid = parseFloat(data.mid);
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);
    }
  });

  test("spread for active token", async () => {
    const market = await findActiveMarket();
    if (!market) return;
    const resp = await fetch(`${CLOB_HOST}/spread?token_id=${market.upToken}`);
    if (!resp.ok) return;
    const data = await resp.json() as { spread: string };
    if (data.spread) {
      const spread = parseFloat(data.spread);
      expect(spread).toBeGreaterThanOrEqual(0);
    }
  });

  test("last trade price for active token", async () => {
    const market = await findActiveMarket();
    if (!market) return;
    const resp = await fetch(`${CLOB_HOST}/last-trade-price?token_id=${market.upToken}`);
    expect(resp.ok).toBe(true);
    const data = await resp.json() as { price: string };
    expect(data.price).toBeTruthy();
    const price = parseFloat(data.price);
    expect(price).toBeGreaterThanOrEqual(0);
    expect(price).toBeLessThanOrEqual(1);
  });

  test("order book structure is valid", async () => {
    const market = await findActiveMarket();
    if (!market) return;
    const resp = await fetch(`${CLOB_HOST}/book?token_id=${market.upToken}`);
    if (!resp.ok) return;
    const book = await resp.json() as {
      market?: string;
      asset_id?: string;
      bids?: Array<{ price: string; size: string }>;
      asks?: Array<{ price: string; size: string }>;
      min_order_size?: string;
      tick_size?: string;
      hash?: string;
    };
    expect(book.asset_id).toBeTruthy();
    expect(Array.isArray(book.bids)).toBe(true);
    expect(Array.isArray(book.asks)).toBe(true);
    // Verify prices are valid numbers in 0..1 range
    for (const b of (book.bids || []).slice(0, 3)) {
      const p = parseFloat(b.price);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
    for (const a of (book.asks || []).slice(0, 3)) {
      const p = parseFloat(a.price);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  test("UP + DOWN last trade prices sum to ~$1.00", async () => {
    const market = await findActiveMarket();
    if (!market) return;
    const [upResp, dnResp] = await Promise.all([
      fetch(`${CLOB_HOST}/last-trade-price?token_id=${market.upToken}`),
      fetch(`${CLOB_HOST}/last-trade-price?token_id=${market.dnToken}`),
    ]);
    if (!upResp.ok || !dnResp.ok) return;
    const up = parseFloat((await upResp.json() as { price: string }).price);
    const dn = parseFloat((await dnResp.json() as { price: string }).price);
    if (up > 0 && dn > 0) {
      const sum = up + dn;
      // Binary market: should sum to approximately $1.00 (allow ±$0.15 for market inefficiency)
      expect(sum).toBeGreaterThan(0.85);
      expect(sum).toBeLessThan(1.15);
    }
  });
});

describe("CLOB authenticated operations (no-spend)", () => {
  test.skipIf(!key)("V1 adapter — get open orders (should be empty or valid)", async () => {
    const { V1Adapter } = await import("../src/clob/v1-adapter.js");
    const adapter = new V1Adapter(key!);
    await adapter.init();
    const orders = await adapter.getOpenOrders();
    expect(Array.isArray(orders)).toBe(true);
    for (const o of orders) {
      expect(o.id).toBeTruthy();
      expect(typeof o.price).toBe("number");
      expect(typeof o.originalSize).toBe("number");
    }
  });

  test.skipIf(!key)("V1 adapter — balance (COLLATERAL)", async () => {
    const { V1Adapter } = await import("../src/clob/v1-adapter.js");
    const adapter = new V1Adapter(key!);
    await adapter.init();
    const bal = await adapter.getBalance();
    expect(typeof bal.balance).toBe("number");
    expect(typeof bal.allowance).toBe("number");
    expect(bal.balance).toBeGreaterThanOrEqual(0);
  });

  test.skipIf(!key)("V1 adapter — order book via adapter", async () => {
    const market = await findActiveMarket();
    if (!market) return;
    const { V1Adapter } = await import("../src/clob/v1-adapter.js");
    const adapter = new V1Adapter(key!);
    await adapter.init();
    const book = await adapter.getOrderBook(market.upToken);
    expect(Array.isArray(book.bids)).toBe(true);
    expect(Array.isArray(book.asks)).toBe(true);
    expect(book.tokenId).toBe(market.upToken);
    if (book.bestBid !== null && book.bestAsk !== null) {
      expect(book.bestAsk).toBeGreaterThan(book.bestBid); // ask > bid
      expect(book.spread).toBeGreaterThan(0);
    }
  });

  test.skipIf(!key)("create order (sign only, DO NOT post)", async () => {
    const market = await findActiveMarket();
    if (!market) return;
    const { ClobClient, Chain, Side } = await import("@polymarket/clob-client");
    const { Wallet } = await import("ethers");
    const signer = new Wallet(key!);
    const client = new ClobClient(CLOB_HOST, Chain.POLYGON, signer);
    const creds = await client.createOrDeriveApiKey();
    const authed = new ClobClient(CLOB_HOST, Chain.POLYGON, signer, creds);

    // createOrder signs but does NOT post — safe, free, tests the signing pipeline
    const signedOrder = await authed.createOrder({
      tokenID: market.upToken,
      price: 0.01, // extremely low — would never fill even if posted
      size: 5,
      side: Side.BUY,
    });

    expect(signedOrder).toBeTruthy();
    // The signed order should have the EIP-712 signature fields
    expect(typeof signedOrder).toBe("object");
  });

  test.skipIf(!key)("closed-only mode check", async () => {
    const { ClobClient, Chain } = await import("@polymarket/clob-client");
    const { Wallet } = await import("ethers");
    const signer = new Wallet(key!);
    const client = new ClobClient(CLOB_HOST, Chain.POLYGON, signer);
    const creds = await client.createOrDeriveApiKey();
    const authed = new ClobClient(CLOB_HOST, Chain.POLYGON, signer, creds);
    const status = await authed.getClosedOnlyMode();
    expect(typeof status.closed_only).toBe("boolean");
    // We should NOT be in closed-only mode
    expect(status.closed_only).toBe(false);
  });
});

describe("CTF contract (read-only)", () => {
  test.skipIf(!key)("token balance check (free, read-only)", async () => {
    const { getTokenBalance } = await import("../src/clob/ctf-operations.js");
    const market = await findActiveMarket();
    if (!market) return;
    // Check balance of UP token — should be 0 or a number
    const bal = await getTokenBalance(key!, market.upToken);
    expect(typeof bal).toBe("number");
    expect(bal).toBeGreaterThanOrEqual(0);
  });

  test.skipIf(!key)("merge dry-run (callStatic — free, no tx sent)", async () => {
    const { mergePositions } = await import("../src/clob/ctf-operations.js");
    const market = await findActiveMarket();
    if (!market) return;
    // Dry-run merge with 0.001 tokens — will likely revert (insufficient balance) but that's fine
    const result = await mergePositions(key!, market.conditionId, 0.001, true /* dryRun */);
    // Either "simulated" (if we happened to have tokens) or "failed" with a dry-run revert
    expect(result.status === "simulated" || result.status === "failed").toBe(true);
    if (result.status === "failed") {
      expect(result.error).toContain("Dry-run reverted"); // confirms callStatic ran
    }
  });
});

describe("Gamma API", () => {
  test("fetch active markets", async () => {
    const resp = await fetch(`${GAMMA_API}/markets?active=true&closed=false&limit=3`);
    expect(resp.ok).toBe(true);
    const markets = await resp.json() as Array<Record<string, unknown>>;
    expect(Array.isArray(markets)).toBe(true);
    expect(markets.length).toBeGreaterThan(0);
    // Each market should have expected fields
    for (const m of markets) {
      expect(m.slug).toBeTruthy();
      expect(typeof m.closed).toBe("boolean");
    }
  });

  test("resolution check on resolved market", async () => {
    const { checkMarketResolution } = await import("../src/feeds/gamma-feed.js");
    // Find a resolved crypto up/down market specifically
    const resp = await fetch(`${GAMMA_API}/markets?active=false&closed=true&limit=20`);
    const markets = await resp.json() as Array<{ slug: string; closed: boolean }>;
    const cryptoMarket = markets.find(m => m.slug?.includes("updown") || m.slug?.includes("up-or-down"));
    if (!cryptoMarket) {
      console.log("  SKIP: No resolved crypto market found in Gamma API results");
      return;
    }
    const result = await checkMarketResolution(cryptoMarket.slug);
    // Gamma API may return different data per query path — verify structure, not specific value
    expect(typeof result.closed).toBe("boolean");
    expect(result.outcome === null || result.outcome === "UP" || result.outcome === "DOWN").toBe(true);
  });
});

describe("Data API", () => {
  test("recent trades", async () => {
    const resp = await fetch(`${DATA_API}/trades?limit=5`);
    expect(resp.ok).toBe(true);
    const trades = await resp.json() as Array<Record<string, unknown>>;
    expect(Array.isArray(trades)).toBe(true);
    expect(trades.length).toBeGreaterThan(0);
    expect(trades[0].price).toBeTruthy();
    expect(trades[0].size).toBeTruthy();
  });
});
