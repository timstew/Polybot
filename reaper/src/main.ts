/**
 * Reaper — Bonereaper Clone for Polymarket
 *
 * Event-driven architecture:
 * - User WebSocket for fill notifications (real-time, no polling)
 * - Durable order ledger in SQLite (survives restarts)
 * - 5s tick for pricing/discovery (NOT for order management)
 * - 30s reconciliation as safety net
 * - Direct CLOB integration via @polymarket/clob-client (no Python middleman)
 */

import { initDb, logActivity } from "./db.js";
import { userWs } from "./feeds/user-ws.js";
import { processUserWsFill } from "./orders/fill-processor.js";
import { cancelAllOrders } from "./orders/order-placer.js";
import { startApiServer } from "./api-server.js";
import { initClobClient } from "./clob/index.js";

async function main() {
  console.log("=".repeat(60));
  console.log("  REAPER — Bonereaper Clone for Polymarket");
  console.log("  Event-driven order management + durable ledger");
  console.log("  Direct CLOB integration (v1/v2 auto-detect)");
  console.log("=".repeat(60));

  // 1. Check clock drift against CLOB server (diagnostic — we rely on NTP for accuracy)
  const { syncClock, startClockSync, getOffset } = await import("./core/clock.js");
  await syncClock();
  startClockSync(); // re-check every 5 min, logs warning if drift > 100ms
  console.log(`[STARTUP] Clock check: ${Math.abs(getOffset()).toFixed(0)}ms ${getOffset() > 0 ? 'behind' : 'ahead of'} CLOB server`);

  // 2. Initialize database
  const db = initDb();
  logActivity("STARTUP", "Reaper starting up");

  // 2. Cancel any orphan orders from previous session
  console.log("[STARTUP] Cancelling orphan CLOB orders...");
  await cancelAllOrders();

  // 3. Initialize CLOB client (derives API credentials from private key)
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  let clobCreds: { apiKey: string; secret: string; passphrase: string } | null = null;

  if (privateKey) {
    try {
      const clobVersion = (process.env.CLOB_VERSION || "auto") as "v1" | "v2" | "auto";
      clobCreds = await initClobClient(privateKey, clobVersion);
      console.log("[STARTUP] CLOB client initialized — direct API access enabled");
    } catch (err) {
      console.warn("[STARTUP] CLOB client init failed:", err);
      console.warn("[STARTUP] Real mode will not work — paper mode only");
    }
  } else {
    console.log("[STARTUP] No POLYMARKET_PRIVATE_KEY — paper mode only");
  }

  // 4. Connect User WebSocket for real-time fill notifications
  if (clobCreds) {
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
    userWs.connect(clobCreds);
    console.log("[STARTUP] User WebSocket connected — fill notifications active");
  } else {
    console.warn("[STARTUP] No CLOB credentials — User WebSocket disabled");
    console.warn("[STARTUP] Fill detection will rely on paper fill modes only");
  }

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
    paper_fill_modes: "grounded",  // default: grounded (real trade tape). Options: shadow, grounded, book (comma-sep for multiple)
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

  // 7. Start the strategy engine
  const { start: startEngine } = await import("./core/engine.js");
  const mode = gc("mode") || "paper";
  console.log(`[STARTUP] Mode: ${mode.toUpperCase()}`);
  if (mode === "real" || mode === "paper") {
    startEngine();
  }

  // 8. Start the dashboard + API server
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

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
