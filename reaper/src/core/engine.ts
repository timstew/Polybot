/**
 * Strategy Engine — the main loop that ties everything together.
 *
 * Two decoupled loops:
 * - Tick (5s): discovery, pricing, bid placement decisions, resolution
 * - Fills: handled by User WebSocket events (NOT the tick loop)
 *
 * The tick loop never touches fill detection. It only decides
 * what orders SHOULD exist based on current pricing and inventory.
 */

import { getDb, logActivity, getConfig, setConfig } from "../db.js";
import { fetchSpotPrice, calculatePTrue, estimateVolatility } from "../feeds/binance-feed.js";
import { getOracleSpot, getOracleStrike, setOracleStrike, isOracleConnected, enableOracleFeed } from "../feeds/oracle-feed.js";
import * as windowMgr from "./window-manager.js";
import * as pricing from "./pricing.js";
import * as ledger from "../orders/order-ledger.js";
import * as placer from "../orders/order-placer.js";
import type { PricingConfig } from "./pricing.js";

const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://127.0.0.1:8000";
const TICK_INTERVAL_MS = 5_000;
const RECONCILE_INTERVAL_MS = 30_000;
const DISCOVERY_INTERVAL_MS = 15_000;

let running = false;
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let lastDiscoveryAt = 0;
let priceHistory: number[] = [];

/** Start the engine. */
export function start(): void {
  if (running) return;
  running = true;
  console.log("[ENGINE] Starting — 5s tick loop");
  logActivity("ENGINE_START", "Strategy engine started");
  scheduleTick();
  reconcileTimer = setInterval(reconcile, RECONCILE_INTERVAL_MS);
}

/** Stop the engine. */
export async function stop(): Promise<void> {
  running = false;
  if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
  console.log("[ENGINE] Stopped");
  logActivity("ENGINE_STOP", "Strategy engine stopped");
}

function scheduleTick(): void {
  if (!running) return;
  tickTimer = setTimeout(async () => {
    try {
      await tick();
    } catch (err) {
      console.error("[ENGINE] Tick error:", err);
      logActivity("TICK_ERROR", String(err), { level: "error" });
    }
    scheduleTick();
  }, TICK_INTERVAL_MS);
}

/** Get effective capital from config + P&L. */
function getEffectiveCapital(): number {
  const maxCapital = parseFloat(getConfig("max_capital_usd", "500") || "500");
  const totalPnl = getTotalPnl();
  const cap = parseFloat(getConfig("capital_cap_usd", "5000") || "5000");
  let effective = maxCapital + totalPnl;
  if (cap > 0 && effective > cap) effective = cap;
  return Math.max(0, effective);
}

/** Get total P&L from completed windows. */
function getTotalPnl(): number {
  const row = getDb().prepare(
    "SELECT COALESCE(SUM(net_pnl), 0) as total FROM windows WHERE status = 'RESOLVED'"
  ).get() as { total: number };
  return row.total;
}

/** Dynamic scaling based on capital. */
function getScaledConfig(effectiveCapital: number): PricingConfig & {
  maxConcurrentWindows: number;
  maxTotalCostPerWindow: number;
  maxWindowDurationMs: number;
  minWindowDurationMs: number;
  maxInventoryPerSide: number;
} {
  const baseBidSize = Math.min(50, Math.max(5, Math.floor(effectiveCapital / 10)));
  const maxConcurrentWindows = Math.min(6, Math.max(1, Math.floor(effectiveCapital / 60)));
  const maxTotalCostPerWindow = effectiveCapital * 0.5;
  const ladderLevels = effectiveCapital < 60 ? 2 : effectiveCapital < 150 ? 3 : 4;

  return {
    deepValuePrice: 0.15,
    certaintyThreshold: 0.65,
    suppressAfterPct: 0.50,
    uncertainRange: 0.10,
    ladderLevels,
    lateSizeMult: 2.0,
    baseBidSize,
    maxConcurrentWindows,
    maxTotalCostPerWindow,
    maxWindowDurationMs: effectiveCapital < 80 ? 5 * 60_000 : 15 * 60_000,
    minWindowDurationMs: 4 * 60_000,
    maxInventoryPerSide: Math.max(20, Math.floor(effectiveCapital * 2)),
  };
}

/** Main tick — runs every 5s. */
async function tick(): Promise<void> {
  const effectiveCapital = getEffectiveCapital();
  if (effectiveCapital <= 0) return; // no capital

  const config = getScaledConfig(effectiveCapital);
  const now = Date.now();

  // 1. Fetch spot price — prefer oracle, fallback to Binance
  const oracleSpot = getOracleSpot("BTCUSDT");
  const binanceSpot = await fetchSpotPrice();
  const spotPrice = oracleSpot?.price ?? binanceSpot;
  if (spotPrice <= 0) return;
  priceHistory.push(spotPrice);
  if (priceHistory.length > 60) priceHistory = priceHistory.slice(-60);
  const vol = estimateVolatility(priceHistory);

  // 2. Discover new windows (every 15s or on boundary crossing)
  const crossed = windowMgr.checkBoundaryCrossing();
  if (crossed || now - lastDiscoveryAt > DISCOVERY_INTERVAL_MS) {
    const markets = await windowMgr.discoverWindows({
      maxWindowDurationMs: config.maxWindowDurationMs,
      minWindowDurationMs: config.minWindowDurationMs,
      maxConcurrentWindows: config.maxConcurrentWindows,
    });

    const activeCount = windowMgr.getActiveWindows().length;
    for (const market of markets) {
      if (activeCount >= config.maxConcurrentWindows) break;
      await windowMgr.enterWindow(market);
    }
    lastDiscoveryAt = now;
  }

  // 3. Process each active window
  const windows = windowMgr.getActiveWindows();
  for (const w of windows) {
    const timeLeft = w.end_time - now;

    // Past end time — mark resolving
    if (timeLeft <= 0) {
      windowMgr.markResolving(w.slug);
      await tryResolveWindow(w, spotPrice);
      continue;
    }

    // Wind-down: cancel all orders 30s before end
    if (timeLeft < 30_000) {
      await cancelWindowOrders(w.slug);
      continue;
    }

    // Compute oracle strike — prefer Chainlink oracle, fallback to Binance at open
    let strike = w.oracle_strike;
    if (!strike) {
      // Try oracle
      const oracleStrike = getOracleStrike("BTCUSDT", w.open_time);
      if (oracleStrike) {
        strike = oracleStrike;
      } else {
        // Capture current price as strike (Binance fallback)
        strike = w.price_at_open || spotPrice;
        setOracleStrike("BTCUSDT", w.open_time, strike);
      }
      getDb().prepare("UPDATE windows SET oracle_strike = ? WHERE slug = ?").run(strike, w.slug);
    }

    // Compute P_true
    const pTrue = calculatePTrue(spotPrice, strike, timeLeft, vol);

    // Compute target bids
    const pricingMode = getConfig("pricing_mode") || "bonereaper";
    const bids = pricing.computeBids(w, pTrue, config, pricingMode);
    const phase = pricing.getPhaseLabel(w, pTrue, config);

    // Budget check: how much can we still deploy?
    const committedCapital = ledger.getCommittedCapital();
    const windowCost = w.up_inventory * w.up_avg_cost + w.down_inventory * w.down_avg_cost;
    const budgetRemaining = Math.max(0, effectiveCapital - committedCapital - windowCost);

    // Place orders for each bid level (only if no active order in that slot)
    let tickSpent = 0;
    for (const bid of bids) {
      if (bid.price <= 0) continue;

      // Check if slot already has an active order
      if (ledger.hasActiveOrder(w.slug, bid.side, bid.level)) continue;

      // Budget check
      const orderCost = bid.price * bid.size;
      if (tickSpent + orderCost > budgetRemaining) continue;
      if (orderCost > config.maxTotalCostPerWindow - windowCost) continue;

      // Size cap
      const size = Math.min(bid.size, config.baseBidSize);
      if (size < 5) continue; // Polymarket minimum

      // Place the order
      const tokenId = bid.side === "UP" ? w.up_token_id : w.down_token_id;
      const result = await placer.placeBuyOrder({
        windowSlug: w.slug,
        tokenId,
        side: bid.side,
        price: bid.price,
        size,
        ladderLevel: bid.level,
      });

      if (result.status === "filled" || result.status === "placed") {
        tickSpent += bid.price * size;
      }
      if (result.status === "failed") {
        break; // stop placing for this window on first failure
      }
    }

    // Log tick
    const upBid = bids.find(b => b.side === "UP" && b.level === config.ladderLevels)?.price ?? 0;
    const dnBid = bids.find(b => b.side === "DOWN" && b.level === config.ladderLevels)?.price ?? 0;
    const ladderStr = bids.filter(b => b.side === "UP" && b.price > 0).map(b => Math.round(b.price * 100)).join("/");
    const ladderStrDn = bids.filter(b => b.side === "DOWN" && b.price > 0).map(b => Math.round(b.price * 100)).join("/");

    logActivity("TICK", `P=${pTrue.toFixed(2)} spot=$${spotPrice.toFixed(0)} [${phase}] ${ladderStr}|${ladderStrDn} inv=${w.up_inventory.toFixed(0)}↑/${w.down_inventory.toFixed(0)}↓`, {
      windowSlug: w.slug, level: "signal",
    });
  }

  // 4. Try to resolve any RESOLVING windows
  const resolving = getDb().prepare("SELECT * FROM windows WHERE status = 'RESOLVING'").all() as windowMgr.WindowRow[];
  for (const w of resolving) {
    await tryResolveWindow(w, spotPrice);
  }

  // 5. Paper mode: simulate fills based on selected fill mode
  const mode = getConfig("mode") || "paper";
  const fillMode = getConfig("paper_fill_mode") || "grounded";
  if (mode === "paper") {
    if (fillMode === "shadow") {
      await processShadowFills();
    } else if (fillMode === "grounded") {
      const { checkGroundedFills } = await import("../orders/grounded-fills.js");
      await checkGroundedFills();
    }
    // "book" mode fills only happen at order placement (already handled)
  }

  // 6. Auto-merge profitable pairs
  for (const w of windows) {
    await tryMerge(w);
  }
}

/** Try to resolve a window by checking outcome. */
async function tryResolveWindow(w: windowMgr.WindowRow, spotPrice: number): Promise<void> {
  const strike = w.oracle_strike || w.price_at_open || 0;
  if (!strike) return;

  // Use Binance price as prediction (Gamma API for confirmation)
  const outcome: "UP" | "DOWN" = spotPrice >= strike ? "UP" : "DOWN";

  // Check Gamma API for official resolution
  try {
    const resp = await fetch(`${PYTHON_API_URL}/api/strategy/check-resolution?slug=${encodeURIComponent(w.slug)}&up_token=${encodeURIComponent(w.up_token_id)}&down_token=${encodeURIComponent(w.down_token_id)}`);
    if (resp.ok) {
      const data = await resp.json() as { closed: boolean; outcome?: string };
      if (data.closed && data.outcome) {
        windowMgr.resolveWindow(w.slug, data.outcome as "UP" | "DOWN");
        pricing.clearWindowState(w.slug);
        // Auto-redeem
        await tryRedeem(w);
        return;
      }
    }
  } catch { /* Gamma not available — use Binance prediction */ }

  // If past end + 5 minutes, resolve with Binance prediction
  const now = Date.now();
  if (now > w.end_time + 300_000) {
    windowMgr.resolveWindow(w.slug, outcome);
    pricing.clearWindowState(w.slug);
    await tryRedeem(w);
  }
}

/** Cancel all orders for a window. */
async function cancelWindowOrders(windowSlug: string): Promise<void> {
  const orders = ledger.getWindowOrders(windowSlug);
  for (const order of orders) {
    if (order.clob_order_id && order.status === "OPEN") {
      await placer.cancelOrder(order.clob_order_id);
    }
  }
}

/** Try to merge profitable pairs in a window. */
async function tryMerge(w: windowMgr.WindowRow): Promise<void> {
  const matched = Math.floor(Math.min(w.up_inventory, w.down_inventory));
  if (matched < 1) return;

  const pairCost = w.up_avg_cost + w.down_avg_cost;
  if (pairCost >= 1.0) return; // not profitable to merge

  try {
    const resp = await fetch(`${PYTHON_API_URL}/api/merge/positions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ condition_id: w.condition_id, amount: matched }),
    });
    const data = await resp.json() as { status: string; tx_hash?: string };

    if (data.status === "merged") {
      const mergePnl = matched * (1.0 - pairCost);
      getDb().prepare(`
        UPDATE windows SET
          up_inventory = up_inventory - ?,
          down_inventory = down_inventory - ?,
          total_merged = total_merged + ?,
          merge_pnl = merge_pnl + ?
        WHERE slug = ?
      `).run(matched, matched, matched, mergePnl, w.slug);

      logActivity("MERGE", `${matched} pairs pc=$${pairCost.toFixed(3)} pnl=$${mergePnl.toFixed(2)}`, {
        windowSlug: w.slug, level: "trade",
      });
    }
  } catch (err) {
    logActivity("MERGE_ERROR", String(err), { windowSlug: w.slug, level: "error" });
  }
}

/** Try to redeem winning tokens. */
async function tryRedeem(w: windowMgr.WindowRow): Promise<void> {
  try {
    const resp = await fetch(`${PYTHON_API_URL}/api/redeem/conditions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ condition_ids: [w.condition_id] }),
    });
    const data = await resp.json() as { results?: Array<{ status: string }> };
    if (data.results?.some(r => r.status === "redeemed")) {
      logActivity("REDEEM", `Redeemed ${w.slug.slice(-13)}`, { windowSlug: w.slug, level: "info" });
    }
  } catch { /* will be caught by sweep */ }
}

const BONEREAPER_WALLET = "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30";
let lastBrFetchAt = 0;
let brCache: Array<{ id: string; slug: string; side: "UP" | "DOWN"; price: number; size: number; timestamp: number }> = [];

/** Paper mode: fetch Bonereaper's fills and grant shadow fills for matching orders. */
async function processShadowFills(): Promise<void> {
  const now = Date.now();
  // Fetch BR activity every 10s
  if (now - lastBrFetchAt < 10_000) return;
  lastBrFetchAt = now;

  try {
    const resp = await fetch(`https://data-api.polymarket.com/activity?user=${BONEREAPER_WALLET}&limit=200&_t=${now}`);
    if (!resp.ok) return;
    const items = await resp.json() as Array<Record<string, unknown>>;
    brCache = [];
    for (const item of items) {
      if (item.type !== "TRADE" || item.side !== "BUY") continue;
      const outcome = ((item.outcome as string) || "").toLowerCase();
      brCache.push({
        id: (item.transactionHash as string) || `${item.timestamp}-${item.price}-${item.size}`,
        slug: (item.slug as string) || "",
        side: outcome === "up" ? "UP" : "DOWN",
        price: item.price as number,
        size: item.size as number,
        timestamp: item.timestamp as number,
      });
    }
  } catch { return; }

  // Match BR fills against our resting paper orders
  const openOrders = ledger.getOpenOrders();
  for (const order of openOrders) {
    if (!order.clob_order_id?.startsWith("paper-")) continue;

    const w = windowMgr.getWindow(order.window_slug);
    if (!w || w.status !== "ACTIVE") continue;

    // Find BR fills for this window+side that our bid covers
    const matching = brCache.filter(br =>
      br.slug === order.window_slug &&
      br.side === (order.side as string) &&
      order.price >= br.price &&
      br.timestamp * 1000 >= new Date(w.entered_at || "").getTime()
    );

    if (matching.length === 0) continue;

    // Grant shadow fill at BR's price and size
    for (const br of matching) {
      const tradeId = `shadow-${br.id}`;
      const { processReconcileFill } = await import("../orders/fill-processor.js");
      processReconcileFill(
        tradeId,
        order.clob_order_id!,
        order.window_slug,
        order.token_id,
        order.side as "UP" | "DOWN",
        br.price,
        Math.min(br.size, order.size - order.size_matched), // don't overfill
      );
    }
  }
}

/** Paper mode: check if any resting orders would now cross the ask (book-based fallback). */
async function checkPaperRestingFills(): Promise<void> {
  const openOrders = ledger.getOpenOrders();
  for (const order of openOrders) {
    if (!order.clob_order_id?.startsWith("paper-")) continue; // only paper orders
    try {
      const bookResp = await fetch(`https://clob.polymarket.com/book?token_id=${order.token_id}`);
      const book = await bookResp.json() as { asks?: Array<{ price: string; size: string }> };
      const bestAsk = book.asks?.[0] ? parseFloat(book.asks[0].price) : null;

      if (bestAsk !== null && order.price >= bestAsk) {
        // Would cross now — simulate fill
        const { processReconcileFill } = await import("../orders/fill-processor.js");
        processReconcileFill(
          `paper-rest-${order.id}-${Date.now()}`,
          order.clob_order_id!,
          order.window_slug,
          order.token_id,
          order.side as "UP" | "DOWN",
          bestAsk,
          order.size,
        );
      }
    } catch { /* skip */ }
  }
}

/** 30s reconciliation — cross-check CLOB activity against our ledger. */
async function reconcile(): Promise<void> {
  try {
    // Get our open orders from the ledger
    const openOrders = ledger.getOpenOrders();
    if (openOrders.length === 0) return;

    // Check each open order's status via REST
    for (const order of openOrders) {
      if (!order.clob_order_id) continue;

      try {
        const resp = await fetch(`${PYTHON_API_URL}/api/strategy/order-status/${encodeURIComponent(order.clob_order_id)}`);
        const data = await resp.json() as { status: string; size_matched?: number; price?: number; error?: string };

        if (data.error) {
          const attempts = ledger.incrementReconcileAttempts(order.clob_order_id);
          if (attempts > 10) {
            logActivity("RECONCILE_ORPHAN", `Order ${order.clob_order_id.slice(0, 16)} failed ${attempts}x — marking orphaned`, { level: "warning" });
          }
          continue;
        }

        if ((data.status === "MATCHED" || data.status === "FILLED") && (data.size_matched ?? 0) > 0) {
          // Fill detected via REST — the WebSocket should have caught this, but just in case
          const { processReconcileFill } = await import("../orders/fill-processor.js");
          processReconcileFill(
            `reconcile-${order.clob_order_id}-${Date.now()}`,
            order.clob_order_id,
            order.window_slug,
            order.token_id,
            order.side as "UP" | "DOWN",
            data.price ?? order.price,
            data.size_matched ?? order.size,
          );
          logActivity("RECONCILE_FILL", `Caught fill via REST: ${order.side} ${data.size_matched}@$${data.price?.toFixed(3)}`, {
            windowSlug: order.window_slug, level: "warning",
          });
        } else if (data.status === "CANCELLED" || data.status === "CANCELED") {
          ledger.markCancelled(order.clob_order_id);
        }
        // LIVE = still resting, do nothing
      } catch { /* skip this order, try next */ }
    }
  } catch (err) {
    logActivity("RECONCILE_ERROR", String(err), { level: "error" });
  }
}
