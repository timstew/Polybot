/**
 * Reaper — Bonereaper Clone for Polymarket
 *
 * Event-driven architecture:
 * - User WebSocket for fill notifications (real-time, no polling)
 * - Durable order ledger in SQLite (survives restarts)
 * - 5s tick for pricing/discovery (NOT for order management)
 * - 30s reconciliation as safety net
 */

import { initDb, logActivity } from "./db.js";
import { userWs } from "./feeds/user-ws.js";
import { processUserWsFill } from "./orders/fill-processor.js";
import { cancelAllOrders } from "./orders/order-placer.js";
import { startApiServer } from "./api-server.js";

const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://127.0.0.1:8000";

async function main() {
  console.log("=".repeat(60));
  console.log("  REAPER — Bonereaper Clone for Polymarket");
  console.log("  Event-driven order management + durable ledger");
  console.log("=".repeat(60));

  // 1. Initialize database
  const db = initDb();
  logActivity("STARTUP", "Reaper starting up");

  // 2. Cancel any orphan orders from previous session
  console.log("[STARTUP] Cancelling orphan CLOB orders...");
  await cancelAllOrders();

  // 3. Get CLOB API credentials for User WebSocket
  console.log("[STARTUP] Fetching CLOB API credentials...");
  const creds = await fetchClobCredentials();
  if (creds) {
    // 4. Connect User WebSocket for real-time fill notifications
    userWs.on("fill", (event) => {
      processUserWsFill(event);
    });
    userWs.on("confirmed", (event) => {
      logActivity("FILL_CONFIRMED", `Order ${event.orderId.slice(0, 16)} confirmed on-chain`, { level: "info" });
    });
    userWs.on("failed", (event) => {
      logActivity("FILL_REVERTED", `Order ${event.orderId.slice(0, 16)} reverted on-chain`, { level: "error" });
    });
    userWs.on("reconnecting", () => {
      logActivity("USER_WS", "Reconnecting — will reconcile on reconnect", { level: "warning" });
    });
    userWs.connect(creds);
    console.log("[STARTUP] User WebSocket connected — fill notifications active");
  } else {
    console.warn("[STARTUP] Could not get CLOB credentials — User WebSocket disabled");
    console.warn("[STARTUP] Fill detection will rely on REST reconciliation only (SLOWER)");
  }

  // TODO: Phase 2-6 implementation
  // 5. Start market WebSocket (book updates)
  // 6. Start oracle + Binance feeds
  // 7. Start strategy engine (5s tick loop)
  // 8. Start reconciliation loop (30s)
  // 9. Start HTTP API server for dashboard

  // 5. Start oracle feed (Chainlink via RTDS)
  try {
    const { enableOracleFeed } = await import("./feeds/oracle-feed.js");
    enableOracleFeed();
    console.log("[STARTUP] Oracle feed enabled (Chainlink via RTDS)");
  } catch (err) {
    console.warn("[STARTUP] Oracle feed unavailable:", err);
  }

  // 6. Set default config if not set
  const { setConfig: sc, getConfig: gc } = await import("./db.js");
  const defaults: Record<string, string> = {
    mode: "paper",                    // paper or real — default SAFE
    max_capital_usd: "500",
    balance_usd: "500",
    profit_reinvest_pct: "0.75",
    capital_cap_usd: "5000",
    // Pricing
    pricing_mode: "hybrid",            // hybrid (best for shadow paper), bonereaper (for real), book
    paper_fill_mode: "shadow",          // shadow (BR activity — proven), grounded (trade tape — WIP), book (ask crossing)
    deep_value_price: "0.15",
    certainty_threshold: "0.65",
    suppress_after_pct: "0.50",
    uncertain_range: "0.10",
    late_size_mult: "2.0",
    // Windows
    max_concurrent_windows: "6",
    discovery_interval_ms: "15000",
    // Shadow fills
    shadow_wallet: "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!gc(key)) sc(key, value);
  }

  // 6. Start the strategy engine
  const { start: startEngine, stop: stopEngine } = await import("./core/engine.js");
  const mode = gc("mode") || "paper";
  console.log(`[STARTUP] Mode: ${mode.toUpperCase()}`);
  if (mode === "real" || mode === "paper") {
    startEngine();
  }

  // 7. Start the dashboard + API server
  const port = parseInt(process.env.PORT || "3001", 10);
  startApiServer(port);

  console.log("\n[STARTUP] Reaper fully operational");
  console.log("[STARTUP] Dashboard: http://localhost:" + port);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[SHUTDOWN] Stopping Reaper...");
    const { stop: stopEngine } = await import("./core/engine.js");
    await stopEngine();
    userWs.disconnect();
    await cancelAllOrders();
    logActivity("SHUTDOWN", "Reaper stopped cleanly");
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/** Fetch CLOB API credentials from the Python API. */
async function fetchClobCredentials(): Promise<{ apiKey: string; secret: string; passphrase: string } | null> {
  try {
    // The Python API can derive API credentials from the private key
    const resp = await fetch(`${PYTHON_API_URL}/api/strategy/clob-creds`);
    if (!resp.ok) {
      console.warn("[STARTUP] /api/strategy/clob-creds not available — need to add this endpoint");
      return null;
    }
    const data = await resp.json() as { apiKey: string; secret: string; passphrase: string };
    if (data.apiKey && data.secret && data.passphrase) return data;
    return null;
  } catch (err) {
    console.warn("[STARTUP] Could not fetch CLOB credentials:", err);
    return null;
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
