/**
 * CLOB client factory — creates the right adapter based on config.
 *
 * Usage:
 *   import { getClobClient, initClobClient } from "./clob/index.js";
 *   await initClobClient(privateKey, "v1");  // once at startup
 *   const client = getClobClient();           // anywhere in the app
 */

import type { ClobAdapter, ClobCredentials } from "./types.js";
import { V1Adapter } from "./v1-adapter.js";
import { V2Adapter } from "./v2-adapter.js";

export type { ClobAdapter, ClobCredentials, PlaceResult, ClobOrder, OrderBook, BalanceInfo, BookLevel } from "./types.js";

let instance: ClobAdapter | null = null;

/**
 * Initialize the CLOB client.
 * Call once at startup. Returns API credentials for WebSocket auth.
 */
export async function initClobClient(
  privateKey: string,
  version: "v1" | "v2" | "auto" = "auto",
): Promise<ClobCredentials> {
  const resolvedVersion = version === "auto" ? await detectVersion() : version;

  if (resolvedVersion === "v2") {
    instance = new V2Adapter(privateKey);
  } else {
    instance = new V1Adapter(privateKey);
  }

  const creds = await instance.init();
  console.log(`[CLOB] Using ${resolvedVersion} adapter`);
  return creds;
}

/**
 * Get the CLOB client singleton.
 * Throws if not initialized.
 */
export function getClobClient(): ClobAdapter {
  if (!instance) {
    throw new Error("[CLOB] Client not initialized — call initClobClient() first");
  }
  return instance;
}

/** Check if the CLOB client is initialized. */
export function isClobInitialized(): boolean {
  return instance !== null;
}

/**
 * Auto-detect which CLOB version the server supports.
 * V2 exposes a /version endpoint. If it responds, use v2.
 * Otherwise fall back to v1.
 */
async function detectVersion(): Promise<"v1" | "v2"> {
  try {
    const resp = await fetch("https://clob.polymarket.com/version");
    if (resp.ok) {
      const data = await resp.json();
      const version = typeof data === "number" ? data : (data as Record<string, unknown>).version;
      console.log(`[CLOB] Server reports version: ${version}`);
      // If server reports version 2, use v2 client
      if (version === 2) return "v2";
    }
  } catch {
    // /version not available — server is still on v1
  }
  return "v1";
}
