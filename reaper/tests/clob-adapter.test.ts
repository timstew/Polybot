/**
 * CLOB Adapter integration tests — read-only operations against the real API.
 *
 * No private key needed for basic tests. No orders placed. No money at risk.
 * Run: bun test
 */

import { describe, test, expect } from "bun:test";

const CLOB_HOST = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";

async function findActiveToken(): Promise<string | null> {
  const resp = await fetch(`${DATA_API}/trades?limit=10`);
  const trades = await resp.json() as Array<{ asset: string }>;
  return trades[0]?.asset || null;
}

describe("CLOB API (unauthenticated)", () => {
  test("health check", async () => {
    const resp = await fetch(`${CLOB_HOST}/`);
    expect(resp.ok).toBe(true);
  });

  test("version detection", async () => {
    const resp = await fetch(`${CLOB_HOST}/version`);
    if (resp.ok) {
      const data = await resp.json();
      const version = typeof data === "number" ? data : (data as Record<string, unknown>).version;
      expect(typeof version).toBe("number");
      expect([1, 2]).toContain(version);
    }
    // If /version not available, that's fine — v1 server
  });

  test("order book", async () => {
    const tokenId = await findActiveToken();
    if (!tokenId) {
      console.log("  SKIP: No active token found (Data API may be slow)");
      return;
    }

    const resp = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
    // Token may have expired between discovery and book fetch — don't hard-fail
    if (!resp.ok) {
      console.log(`  SKIP: Book fetch returned ${resp.status} for token ${tokenId.slice(0, 20)}...`);
      return;
    }

    const book = await resp.json() as {
      bids?: Array<{ price: string; size: string }>;
      asks?: Array<{ price: string; size: string }>;
    };

    expect(Array.isArray(book.bids)).toBe(true);
    expect(Array.isArray(book.asks)).toBe(true);
  });
});

describe("Adapter imports", () => {
  test("V1Adapter class", async () => {
    const { V1Adapter } = await import("../src/clob/v1-adapter.js");
    expect(typeof V1Adapter).toBe("function");
  });

  test("V2Adapter class", async () => {
    const { V2Adapter } = await import("../src/clob/v2-adapter.js");
    expect(typeof V2Adapter).toBe("function");
  });

  test("Factory exports", async () => {
    const { initClobClient, getClobClient, isClobInitialized } = await import("../src/clob/index.js");
    expect(typeof initClobClient).toBe("function");
    expect(typeof getClobClient).toBe("function");
    expect(typeof isClobInitialized).toBe("function");
    expect(isClobInitialized()).toBe(false);
  });
});

describe("Authenticated operations", () => {
  const key = process.env.POLYMARKET_PRIVATE_KEY;

  test.skipIf(!key)("V1 adapter init + balance", async () => {
    const { V1Adapter } = await import("../src/clob/v1-adapter.js");
    const adapter = new V1Adapter(key!);

    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(true);

    const creds = await adapter.init();
    expect(creds.apiKey).toBeTruthy();
    expect(creds.secret).toBeTruthy();
    expect(creds.passphrase).toBeTruthy();

    const balance = await adapter.getBalance();
    expect(typeof balance.balance).toBe("number");

    const orders = await adapter.getOpenOrders();
    expect(Array.isArray(orders)).toBe(true);
  });

  test.skipIf(!key)("Auto-detect version", async () => {
    const { initClobClient, getClobClient, isClobInitialized } = await import("../src/clob/index.js");
    const creds = await initClobClient(key!, "auto");
    expect(isClobInitialized()).toBe(true);
    const client = getClobClient();
    expect(["v1", "v2"]).toContain(client.version);
    expect(creds.apiKey).toBeTruthy();
  });
});

describe("Database (bun:sqlite)", () => {
  test("init and basic operations", async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
    db.prepare("INSERT INTO test VALUES (?, ?)").run(1, "hello");
    const row = db.prepare("SELECT * FROM test WHERE id = ?").get(1) as { id: number; name: string };
    expect(row.id).toBe(1);
    expect(row.name).toBe("hello");
  });
});
