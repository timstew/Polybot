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
import { marketWs, type MarketTradeEvent } from "../feeds/market-ws.js";
import { processReconcileFill as processWsFill } from "../orders/fill-processor.js";
import { queueFillProbability, rollForFill } from "../orders/queue-sim.js";
// Time: relies on system NTP for clock accuracy. CLOB order signing uses
// server time via useServerTime:true in the adapter. See core/clock.ts for
// offset diagnostics if drift ever becomes an issue.
import { fetchSpotPrice, calculatePTrue, estimateVolatility } from "../feeds/binance-feed.js";
import { getOracleSpot, getOracleSpotForResolution, getOracleStrike, setOracleStrike, isOracleConnected, enableOracleFeed } from "../feeds/oracle-feed.js";
import * as windowMgr from "./window-manager.js";
import * as pricing from "./pricing.js";
import * as ledger from "../orders/order-ledger.js";
import * as placer from "../orders/order-placer.js";
import { getClobClient, isClobInitialized } from "../clob/index.js";
import { getStrategy } from "../strategies/index.js";
import { checkMarketResolution } from "../feeds/gamma-feed.js";
import type { BidContext } from "../strategies/index.js";
import type { PricingConfig } from "./pricing.js";

// Python API fully eliminated — all operations are now native TS:
//   Orders: @polymarket/clob-client via reaper/src/clob/
//   Resolution: gamma-feed.ts (direct Gamma API)
//   Merge/Redeem: ctf-operations.ts (direct on-chain via ethers)
const TICK_INTERVAL_MS = 5_000;
const RECONCILE_INTERVAL_MS = 30_000;
const DISCOVERY_INTERVAL_MS = 15_000;

let running = false;
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let boundaryTimer: ReturnType<typeof setTimeout> | null = null;
let lastDiscoveryAt = 0;
let priceHistory: number[] = [];

/** Start the engine. */
export function start(): void {
  if (running) return;
  running = true;
  console.log("[ENGINE] Starting — 5s tick + boundary discovery + market WS fills");
  logActivity("ENGINE_START", "Strategy engine started");
  scheduleTick();
  scheduleNextBoundary();
  reconcileTimer = setInterval(reconcile, RECONCILE_INTERVAL_MS);

  // Connect market WebSocket for real-time per-token trade events.
  // Every trade on our subscribed tokens triggers instant grounded fill checking.
  marketWs.connect();
  marketWs.on("trade", enqueueMarketTrade);

  // Subscribe existing active window tokens
  const windows = windowMgr.getActiveWindows();
  const tokens: string[] = [];
  for (const w of windows) {
    tokens.push(w.up_token_id, w.down_token_id);
  }
  if (tokens.length > 0) marketWs.subscribeTokens(tokens);
}

/** Stop the engine. */
export async function stop(): Promise<void> {
  running = false;
  if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
  if (boundaryTimer) { clearTimeout(boundaryTimer); boundaryTimer = null; }
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
  marketWs.disconnect();
  flushTapeBuckets(); // persist any remaining tape data
  console.log("[ENGINE] Stopped");
  logActivity("ENGINE_STOP", "Strategy engine stopped");
}

// Track last-known trade price per token for reprice detection
const lastTradeByToken = new Map<string, number>();
const REPRICE_THRESHOLD = 0.02;

// ── Tape bucket accumulator (1-second aggregation for offline replay) ────
// Accumulates raw WS events in memory, flushes to DB every second.
interface BucketAccum {
  count: number;
  volume: number;
  priceVolumeSum: number; // for VWAP
  minPrice: number;
  maxPrice: number;
  buyVolume: number;
  sellVolume: number;
  windowSlug: string | null;
}
const bucketAccum = new Map<string, BucketAccum>(); // key: "tokenId-bucketTs"
let lastBucketFlush = 0;

function accumulateTapeBucket(event: MarketTradeEvent): void {
  // WS timestamps can be ms or seconds — normalize to seconds
  const tsSec = event.timestamp > 1e12 ? Math.floor(event.timestamp / 1000) : Math.floor(event.timestamp);
  const bucketTs = tsSec;
  const key = `${event.asset_id}-${bucketTs}`;

  let bucket = bucketAccum.get(key);
  if (!bucket) {
    // Find which window this token belongs to (for the window_slug column)
    let slug: string | null = null;
    const windows = windowMgr.getActiveWindows();
    for (const w of windows) {
      if (w.up_token_id === event.asset_id || w.down_token_id === event.asset_id) {
        slug = w.slug;
        break;
      }
    }
    bucket = { count: 0, volume: 0, priceVolumeSum: 0, minPrice: Infinity, maxPrice: 0, buyVolume: 0, sellVolume: 0, windowSlug: slug };
    bucketAccum.set(key, bucket);
  }

  bucket.count++;
  bucket.volume += event.size;
  bucket.priceVolumeSum += event.price * event.size;
  if (event.price < bucket.minPrice) bucket.minPrice = event.price;
  if (event.price > bucket.maxPrice) bucket.maxPrice = event.price;
  if (event.side === "BUY") bucket.buyVolume += event.size;
  else bucket.sellVolume += event.size;

  // Flush completed buckets every 2 seconds
  const now = Date.now();
  if (now - lastBucketFlush > 2000) {
    flushTapeBuckets();
    lastBucketFlush = now;
  }
}

function flushTapeBuckets(): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const insert = getDb().prepare(`
    INSERT INTO tape_buckets (token_id, window_slug, bucket_ts, trade_count, total_volume, min_price, max_price, vwap, side_buy_volume, side_sell_volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [key, bucket] of bucketAccum) {
    const [tokenId, tsStr] = [key.slice(0, key.lastIndexOf("-")), key.slice(key.lastIndexOf("-") + 1)];
    const bucketTs = parseInt(tsStr);
    // Only flush completed buckets (at least 1 second old)
    if (bucketTs >= nowSec) continue;

    const vwap = bucket.volume > 0 ? bucket.priceVolumeSum / bucket.volume : 0;
    insert.run(tokenId, bucket.windowSlug, bucketTs, bucket.count, bucket.volume,
      bucket.minPrice, bucket.maxPrice, vwap, bucket.buyVolume, bucket.sellVolume);
    bucketAccum.delete(key);
  }
}

// Serialize market trade processing
let tradeQueueProcessing = false;
const tradeQueue: MarketTradeEvent[] = [];

function enqueueMarketTrade(event: MarketTradeEvent): void {
  // Record every event into 1-second tape buckets (for offline replay)
  accumulateTapeBucket(event);
  // Queue for fill processing + repricing
  tradeQueue.push(event);
  if (!tradeQueueProcessing) drainTradeQueue();
}

async function drainTradeQueue(): Promise<void> {
  tradeQueueProcessing = true;
  while (tradeQueue.length > 0) {
    const event = tradeQueue.shift()!;
    await onMarketTrade(event);
  }
  tradeQueueProcessing = false;
}

/**
 * Real-time trade event from market WebSocket.
 * Two jobs:
 *   1. Instant grounded fill check (paper mode)
 *   2. Trigger bid repricing when market moves away from our resting prices
 */
async function onMarketTrade(event: MarketTradeEvent): Promise<void> {
  const isPaper = (getConfig("mode") || "paper") !== "real";

  // ── Job 1: Instant grounded fill (paper mode only) ─────────
  // Simulates a real CLOB resting order:
  //   - ANY trade at price ≤ our bid means a seller reached our level → we fill
  //   - Fill at OUR bid price (maker semantics — resting order gets its posted price)
  //   - Fill ALL matching orders from this trade event (not just one), consuming
  //     the trade's volume across our ladder levels (best bid first)
  if (isPaper) {
    // INVENTORY CHECK: skip fills on the heavy side if over tolerance.
    // This prevents the WS handler from accumulating 50K one-sided tokens between ticks.
    const windowForToken = windowMgr.getActiveWindows().find(
      w => w.up_token_id === event.asset_id || w.down_token_id === event.asset_id
    );
    if (windowForToken) {
      const isUpToken = windowForToken.up_token_id === event.asset_id;
      const thisSideInv = isUpToken ? windowForToken.up_inventory : windowForToken.down_inventory;
      const otherSideInv = isUpToken ? windowForToken.down_inventory : windowForToken.up_inventory;
      const paired = Math.min(thisSideInv, otherSideInv);
      const excess = thisSideInv - paired;
      const effCap = parseFloat(getConfig("max_capital_usd", "500") || "500");
      const tolerance = Math.min(1.0, Math.max(0.05, effCap / 200000));
      const maxExcess = Math.max(200, Math.floor(Math.max(paired, 200) * tolerance));
      if (excess > maxExcess) {
        // Heavy side — skip this fill entirely
        return;
      }
    }

    let remainingVolume = event.size;
    const openOrders = getDb().prepare(
      "SELECT * FROM orders WHERE token_id = ? AND status IN ('OPEN','PARTIAL') AND price >= ? ORDER BY price DESC"
    ).all(event.asset_id, event.price) as Array<{
      id: string; clob_order_id: string | null; token_id: string; window_slug: string;
      side: string; price: number; size: number; size_matched: number; ladder_level: number;
    }>;

    const queueSimEnabled = (getConfig("queue_fill_sim", "true") || "true") !== "false";
    const queueMult = parseFloat(getConfig("queue_fill_mult", "1.0") || "1.0");

    for (const order of openOrders) {
      if (remainingVolume <= 0) break;

      const fresh = ledger.getOrderByClobId(order.clob_order_id!);
      if (!fresh || fresh.size_matched >= fresh.size * 0.99) continue;

      const orderRemaining = fresh.size - fresh.size_matched;
      const fillSize = Math.min(orderRemaining, remainingVolume);
      // Consume volume regardless of our outcome — if we lose the queue roll,
      // competition at this level got the fill, and the seller walks on.
      remainingVolume -= fillSize;

      // Queue-position simulation: paper bids must contend with real CLOB queue.
      // A brand-new paper bid at the same price as an existing resting bid goes
      // to the back of the queue; price improvement jumps ahead.
      if (queueSimEnabled) {
        const prob = queueFillProbability(order.price, event.price);
        if (!rollForFill(prob, queueMult)) continue;
      }

      // Unique trade ID per order (same trade can fill multiple orders)
      const tradeId = `ws-grounded-${order.clob_order_id}-${event.timestamp}-${event.price}`;

      // Fill at OUR bid price (maker semantics), not the trade price
      processWsFill(
        tradeId, order.clob_order_id!, order.window_slug, order.token_id,
        order.side as "UP" | "DOWN", order.price, fillSize, "paper_grounded",
      );

      logActivity("WS_GROUNDED_FILL", `${order.side} ${fillSize.toFixed(1)}@$${order.price.toFixed(3)} [maker fill]`, {
        windowSlug: order.window_slug, side: order.side, level: "trade",
      });

      // Immediately replenish at current market price
      const newPrice = Math.round(Math.max(0.01, event.price) * 1000) / 1000;
      if (newPrice > 0.005 && order.size >= 5) {
        await placer.placeBuyOrder({
          windowSlug: order.window_slug,
          tokenId: order.token_id,
          side: order.side as "UP" | "DOWN",
          price: newPrice,
          size: order.size,
          ladderLevel: order.ladder_level,
        }).catch(() => {});
      }
    }
  }

  // ── Job 1b: Opportunistic taker buys (hybrid strategy only) ─────
  // If the active strategy has evaluateTaker(), check if this trade is
  // worth taking (cheap losing-side sweep or winning-side dip).
  if (isPaper) {
    const strategyName = getConfig("bid_strategy") || "bonereaper-mimic";
    const strategy = getStrategy(strategyName) as any;
    if (typeof strategy.evaluateTaker === "function") {
      // Find which window this token belongs to
      const windows = windowMgr.getActiveWindows();
      for (const w of windows) {
        const isUp = w.up_token_id === event.asset_id;
        const isDn = w.down_token_id === event.asset_id;
        if (!isUp && !isDn) continue;

        const now = Date.now();
        const ctx = {
          window_slug: w.slug,
          window_duration_sec: (w.end_time - w.open_time) / 1000,
          elapsed_sec: (now - w.open_time) / 1000,
          elapsed_pct: (now - w.open_time) / (w.end_time - w.open_time),
          remaining_sec: Math.max(0, (w.end_time - now) / 1000),
          p_true: 0.50, // approximate — full compute is expensive
          spot_price: 0,
          up_best_bid: null, up_best_ask: null, up_ask_size: null, up_last_trade: lastTradeByToken.get(w.up_token_id) ?? null,
          dn_best_bid: null, dn_best_ask: null, dn_ask_size: null, dn_last_trade: lastTradeByToken.get(w.down_token_id) ?? null,
          up_inventory: w.up_inventory, up_avg_cost: w.up_avg_cost,
          dn_inventory: w.down_inventory, dn_avg_cost: w.down_avg_cost,
          base_bid_size: Math.max(5, Math.floor(100000 / 10)), // from effective capital
          committed_capital: 0, effective_capital: 100000,
        };

        const signal = strategy.evaluateTaker(ctx, event.price, event.size, event.side, event.asset_id);
        if (signal.shouldTake && signal.size >= 5) {
          const side: "UP" | "DOWN" = isUp ? "UP" : "DOWN";
          const tradeId = `taker-${event.asset_id}-${event.timestamp}-${event.price}`;

          processWsFill(
            tradeId, `taker-${w.slug}-${side}-${Date.now()}`, w.slug,
            event.asset_id, side, event.price,
            Math.min(signal.size, event.size), "paper_grounded",
            false, // taker: aggressive buy at trade price — 6.25% fee applies
          );

          logActivity("TAKER_BUY", `${side} ${Math.min(signal.size, event.size).toFixed(0)}@$${event.price.toFixed(3)} [${signal.reason}]`, {
            windowSlug: w.slug, side, level: "trade",
          });
        }
        break; // one window per token
      }
    }
  }

  // ── Job 2: Reprice stale bids when market moves ────────────
  // If the market just traded at a price that's moved significantly from our
  // resting bids, cancel them and let the next processWindow place fresh ones
  // anchored at the new market price. This is how BR reprices ~2.7×/30s.
  const prevPrice = lastTradeByToken.get(event.asset_id);
  lastTradeByToken.set(event.asset_id, event.price);

  if (prevPrice != null && Math.abs(event.price - prevPrice) > REPRICE_THRESHOLD) {
    // Find MAKER orders (L1-L3) on this token that are now stale.
    // Do NOT cancel sweep orders (L4+) — they're deliberately priced above
    // the losing-side market to catch cheap sellers for pairing.
    const openOrders = ledger.getOpenOrders();
    let cancelled = 0;
    for (const order of openOrders) {
      if (order.token_id !== event.asset_id) continue;
      if (!order.clob_order_id) continue;
      if (order.ladder_level >= 4) continue; // protect sweep orders from repricing
      const gap = Math.abs(order.price - event.price);
      if (gap > REPRICE_THRESHOLD || order.price > event.price) {
        await placer.cancelOrder(order.clob_order_id);
        cancelled++;
      }
    }
    if (cancelled > 0) {
      // Trigger immediate re-evaluation for this window
      // (processWindow will place fresh bids on the next tick or we can call it inline)
      logActivity("REPRICE", `${cancelled} stale bids cancelled (market moved $${prevPrice.toFixed(3)}→$${event.price.toFixed(3)})`, {
        level: "signal",
      });
    }
  }
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

/**
 * Schedule a wake-up at the next 5-minute boundary.
 * Crypto windows open exactly at :00, :05, :10, ... — if we schedule a timer
 * for that exact moment, we can discover and enter new windows within ~200ms
 * instead of waiting up to 5s for the next tick.
 */
function scheduleNextBoundary(): void {
  if (!running) return;
  const now = Date.now();
  // Next 5-min boundary (also catches 15-min since 15 is a multiple of 5)
  const nextBoundary = Math.ceil(now / 300_000) * 300_000;
  const delay = Math.max(500, nextBoundary - now + 250); // +250ms to ensure windows are actually created on server side
  boundaryTimer = setTimeout(async () => {
    try {
      await onBoundaryFire(nextBoundary);
    } catch (err) {
      console.error("[ENGINE] Boundary fire error:", err);
      logActivity("BOUNDARY_ERROR", String(err), { level: "error" });
    }
    scheduleNextBoundary();
  }, delay);
}

/**
 * Fired at exactly the next window-open boundary. Immediately discovers and
 * enters new windows, then places initial bids for them — no waiting for tick.
 */
async function onBoundaryFire(boundaryTs: number): Promise<void> {
  const startMs = Date.now();
  const effectiveCapital = getEffectiveCapital();
  if (effectiveCapital <= 0) return;
  const config = getScaledConfig(effectiveCapital);

  logActivity("BOUNDARY", `Boundary fire at ${new Date(boundaryTs).toISOString().slice(11, 19)} — discovering…`, { level: "signal" });

  const markets = await windowMgr.discoverWindows({
    maxWindowDurationMs: config.maxWindowDurationMs,
    minWindowDurationMs: config.minWindowDurationMs,
    maxConcurrentWindows: config.maxConcurrentWindows,
  });
  lastDiscoveryAt = Date.now();

  const activeCount = windowMgr.getActiveWindows().length;
  let entered = 0;
  for (const market of markets) {
    if (activeCount + entered >= config.maxConcurrentWindows) break;
    const ok = await windowMgr.enterWindow(market);
    if (ok) entered++;
  }

  const elapsed = Date.now() - startMs;
  if (entered > 0) {
    // Subscribe new window tokens to market WebSocket for real-time trade events
    const newWindows = windowMgr.getActiveWindows();
    const newTokens: string[] = [];
    for (const w of newWindows) newTokens.push(w.up_token_id, w.down_token_id);
    marketWs.subscribeTokens(newTokens);

    logActivity("BOUNDARY", `Entered ${entered} new window(s) in ${elapsed}ms via boundary fire`, { level: "signal" });
    // Immediately place first bids — don't wait for next tick
    const spot = getOracleSpot("BTCUSDT")?.price ?? await fetchSpotPrice();
    if (spot > 0) {
      const vol = estimateVolatility(priceHistory);
      const windows = windowMgr.getActiveWindows();
      for (const w of windows) {
        await processWindow(w, spot, vol, config, effectiveCapital).catch(e =>
          console.error("[BOUNDARY] processWindow error", w.slug, e));
      }
    }
  }
}

/** Get effective capital from config + P&L. */
export function getEffectiveCapital(): number {
  const maxCapital = parseFloat(getConfig("max_capital_usd", "500") || "500");
  const totalPnl = getTotalPnl();
  const cap = parseFloat(getConfig("capital_cap_usd", "5000") || "5000");
  let effective = maxCapital + totalPnl;
  if (cap > 0 && effective > cap) effective = cap;
  return Math.max(0, effective);
}

/** Get total P&L from completed windows. */
export function getTotalPnl(): number {
  const row = getDb().prepare(
    "SELECT COALESCE(SUM(net_pnl), 0) as total FROM windows WHERE status = 'RESOLVED'"
  ).get() as { total: number };
  return row.total;
}

/** Dynamic scaling based on capital. */
export function getScaledConfig(effectiveCapital: number): PricingConfig & {
  maxConcurrentWindows: number;
  maxTotalCostPerWindow: number;
  maxWindowDurationMs: number;
  minWindowDurationMs: number;
  maxInventoryPerSide: number;
} {
  // Cap at 200 tokens per order — unlimited capital doesn't mean unlimited order size.
  // BR's avg fill is ~40 tokens. 200 gives us headroom without creating 99K one-sided inventory.
  const baseBidSize = Math.min(200, Math.max(5, Math.floor(effectiveCapital / 10)));
  // With mid-window merging, $100 can sustain 3+ concurrent windows (capital recycles
  // every ~30s). Old formula: floor(capital/60) → only 1 window at $100. New: floor(capital/25).
  const maxConcurrentWindows = Math.min(6, Math.max(2, Math.floor(effectiveCapital / 25)));
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
    let tickEntered = 0;
    for (const market of markets) {
      if (activeCount + tickEntered >= config.maxConcurrentWindows) break;
      const ok = await windowMgr.enterWindow(market);
      if (ok) tickEntered++;
    }
    lastDiscoveryAt = now;

    // Subscribe new tokens to market WS (same as boundary fire)
    if (tickEntered > 0) {
      const allWindows = windowMgr.getActiveWindows();
      const allTokens: string[] = [];
      for (const w of allWindows) allTokens.push(w.up_token_id, w.down_token_id);
      marketWs.subscribeTokens(allTokens);
    }
  }

  // 3. Process each active window
  const windows = windowMgr.getActiveWindows();
  for (const w of windows) {
    // Use the window's own crypto symbol — prefer oracle, fallback to Binance
    const sym = w.crypto_symbol || "BTCUSDT";
    const wSpot = getOracleSpot(sym)?.price ?? await fetchSpotPrice(sym);
    await processWindow(w, wSpot, vol, config, effectiveCapital);
  }

  // 4. Try to resolve any RESOLVING windows + confirm unconfirmed RESOLVED ones
  const resolving = getDb().prepare("SELECT * FROM windows WHERE status = 'RESOLVING'").all() as windowMgr.WindowRow[];
  for (const w of resolving) {
    await tryResolveWindow(w);
  }
  // Confirm unconfirmed resolved windows via Gamma (limit to recent ones)
  const unconfirmed = getDb().prepare("SELECT * FROM windows WHERE status = 'RESOLVED' AND confirmed = 0 LIMIT 5").all() as windowMgr.WindowRow[];
  for (const w of unconfirmed) {
    await tryResolveWindow(w);
  }

  // 5. Always fetch + persist shadow wallet trades for analysis/replay,
  //    independent of fill mode. This populates shadow_trades + brCache.
  await fetchAndPersistShadowTrades();

  // Paper mode: run enabled fill detectors. Source attribution shows which
  // detector caught each fill first. Stable tradeIds + size_matched checks
  // prevent double-fills across detectors.
  const mode = getConfig("mode") || "paper";
  if (mode === "paper") {
    const modesRaw = getConfig("paper_fill_modes")
      || getConfig("paper_fill_mode")
      || "grounded"; // default: grounded (validates OUR pricing against real market tape)
    const modes = new Set(modesRaw.split(",").map(m => m.trim()));

    if (modes.has("shadow")) await processShadowFills();
    // Market WS is the primary fill source (real-time per-trade events, fills at
    // maker price). Tape poller runs only as a gap-filler when WS is unhealthy
    // (zombie / reconnecting / disconnected). Both use their own tradeId schemes
    // so a single underlying trade can produce fills via both paths if overlapped
    // — this gate prevents the overlap in the common case.
    if (modes.has("grounded")) {
      const forceTape = (getConfig("tape_always", "false") || "false") === "true";
      if (forceTape || !marketWs.isConnected()) {
        const { checkGroundedFills } = await import("../orders/grounded-fills.js");
        await checkGroundedFills();
        if (!forceTape) {
          logActivity("TAPE_GAPFILL", `WS unhealthy (age=${marketWs.dataAge}s) — running tape poller as gap-filler`, { level: "signal" });
        }
      }
    }
  }

  // 6. Auto-merge profitable pairs
  for (const w of windows) {
    await tryMerge(w);
  }
}

/**
 * Process a single window: compute bids, place orders, handle wind-down/resolve.
 * Extracted from tick() so it can be called from event handlers (boundary fire,
 * book update, fill event, etc.).
 */
async function processWindow(
  w: windowMgr.WindowRow,
  spotPrice: number,
  vol: number,
  config: ReturnType<typeof getScaledConfig>,
  effectiveCapital: number,
): Promise<void> {
  const now = Date.now();
  const timeLeft = w.end_time - now;

  // Past end time — capture spot price and resolve immediately
  if (timeLeft <= 0) {
    // Capture the current oracle-preferred spot price NOW, while it's fresh
    if (!w.spot_at_close) {
      console.log(`[CLOSE] ${w.slug.slice(-15)} spot_at_close=${spotPrice} sym=${w.crypto_symbol} strike=${w.oracle_strike}`);
      getDb().prepare("UPDATE windows SET spot_at_close = ? WHERE slug = ?").run(spotPrice, w.slug);
      w.spot_at_close = spotPrice;
    }
    windowMgr.markResolving(w.slug);
    await tryResolveWindow(w);
    return;
  }

  // Wind-down: cancel all orders 10s before end (keep sweeping as long as possible)
  if (timeLeft < 10_000) {
    await cancelWindowOrders(w.slug);
    return;
  }

  // Compute oracle strike — prefer Chainlink oracle, fallback to Binance at open
  const cryptoSymbol = w.crypto_symbol || "BTCUSDT";
  let strike = w.oracle_strike;
  if (!strike) {
    const oracleStrike = getOracleStrike(cryptoSymbol, w.open_time);
    if (oracleStrike) {
      strike = oracleStrike;
    } else {
      strike = w.price_at_open || spotPrice;
      setOracleStrike(cryptoSymbol, w.open_time, strike);
    }
    getDb().prepare("UPDATE windows SET oracle_strike = ? WHERE slug = ?").run(strike, w.slug);
  }

  const pTrue = calculatePTrue(spotPrice, strike, timeLeft, vol);

  // Fetch current book state for both tokens (parallel, non-blocking)
  const [upSnap, dnSnap] = await Promise.all([
    fetchBookSnapshot(w.up_token_id),
    fetchBookSnapshot(w.down_token_id),
  ]);

  const strategyName = getConfig("bid_strategy") || getConfig("pricing_mode") || "hybrid";
  const strategy = getStrategy(strategyName);
  const ctx: BidContext = {
    window_slug: w.slug,
    window_duration_sec: (w.end_time - w.open_time) / 1000,
    elapsed_sec: (now - w.open_time) / 1000,
    elapsed_pct: (now - w.open_time) / (w.end_time - w.open_time),
    remaining_sec: Math.max(0, (w.end_time - now) / 1000),
    p_true: pTrue,
    spot_price: spotPrice,
    up_best_bid: upSnap.bid, up_best_ask: upSnap.ask, up_ask_size: upSnap.askSize, up_last_trade: upSnap.lastTrade,
    dn_best_bid: dnSnap.bid, dn_best_ask: dnSnap.ask, dn_ask_size: dnSnap.askSize, dn_last_trade: dnSnap.lastTrade,
    up_inventory: w.up_inventory, up_avg_cost: w.up_avg_cost,
    dn_inventory: w.down_inventory, dn_avg_cost: w.down_avg_cost,
    base_bid_size: config.baseBidSize,
    committed_capital: ledger.getCommittedCapital(),
    effective_capital: effectiveCapital,
  };
  const bids = strategy.compute(ctx);
  const phase = strategy.getPhase ? strategy.getPhase(ctx) : "—";

  // If strategy suppressed a side (inventory guard), cancel existing orders on that side.
  // This prevents the WS fill handler from filling stale orders after the guard fires.
  const hasSideUp = bids.some(b => b.side === "UP");
  const hasSideDn = bids.some(b => b.side === "DOWN");
  if (!hasSideUp || !hasSideDn) {
    const windowOrders = ledger.getWindowOrders(w.slug);
    for (const order of windowOrders) {
      if (!order.clob_order_id) continue;
      if (!hasSideUp && order.side === "UP") await placer.cancelOrder(order.clob_order_id);
      if (!hasSideDn && order.side === "DOWN") await placer.cancelOrder(order.clob_order_id);
    }
  }

  const committedCapital = ledger.getCommittedCapital();
  const windowCost = w.up_inventory * w.up_avg_cost + w.down_inventory * w.down_avg_cost;
  const budgetRemaining = Math.max(0, effectiveCapital - committedCapital - windowCost);

  let tickSpent = 0;
  for (const bid of bids) {
    if (bid.price <= 0) continue;
    if (ledger.hasActiveOrder(w.slug, bid.side, bid.level)) continue;
    const orderCost = bid.price * bid.size;
    if (tickSpent + orderCost > budgetRemaining) continue;
    if (orderCost > config.maxTotalCostPerWindow - windowCost) continue;
    const size = Math.min(bid.size, config.baseBidSize);
    if (size < 5) continue;

    const tokenId = bid.side === "UP" ? w.up_token_id : w.down_token_id;
    const result = await placer.placeBuyOrder({
      windowSlug: w.slug,
      tokenId,
      side: bid.side,
      price: bid.price,
      size,
      ladderLevel: bid.level,
    });
    if (result.status === "filled" || result.status === "placed") tickSpent += bid.price * size;
    if (result.status === "failed") break;
  }

  const ladderStr = bids.filter(b => b.side === "UP" && b.price > 0).map(b => Math.round(b.price * 100)).join("/");
  const ladderStrDn = bids.filter(b => b.side === "DOWN" && b.price > 0).map(b => Math.round(b.price * 100)).join("/");
  logActivity("TICK", `P=${pTrue.toFixed(2)} spot=$${spotPrice.toFixed(0)} [${phase}] ${ladderStr}|${ladderStrDn} inv=${w.up_inventory.toFixed(0)}↑/${w.down_inventory.toFixed(0)}↓`, {
    windowSlug: w.slug, level: "signal",
  });

  captureWindowTick(w, pTrue, spotPrice, phase).catch(() => { /* ignore */ });
}

/** Try to resolve a window by checking outcome. */
async function tryResolveWindow(w: windowMgr.WindowRow): Promise<void> {
  const strike = w.oracle_strike || w.price_at_open || 0;
  if (!strike) return;

  // If already resolved but not confirmed, try to confirm via Gamma
  if (w.status === "RESOLVED" && !w.confirmed) {
    const resolution = await checkMarketResolution(w.slug);
    if (resolution.closed && resolution.outcome) {
      // If Gamma disagrees with our prediction, re-resolve with correct outcome
      if (resolution.outcome !== w.outcome) {
        windowMgr.resolveWindow(w.slug, resolution.outcome);
        logActivity("RESOLVE_CORRECTED", `${w.outcome} → ${resolution.outcome} (Gamma override)`, { windowSlug: w.slug, level: "warning" });
      }
      getDb().prepare("UPDATE windows SET confirmed = 1 WHERE slug = ?").run(w.slug);
      logActivity("RESOLVE_CONFIRMED", `${resolution.outcome} confirmed by Gamma`, { windowSlug: w.slug, level: "info" });
    }
    return;
  }

  // Check Gamma API first for official resolution (authoritative)
  const resolution = await checkMarketResolution(w.slug);
  if (resolution.closed && resolution.outcome) {
    await cancelWindowOrders(w.slug);
    marketWs.unsubscribeTokens([w.up_token_id, w.down_token_id]);
    windowMgr.resolveWindow(w.slug, resolution.outcome);
    getDb().prepare("UPDATE windows SET confirmed = 1 WHERE slug = ?").run(w.slug);
    pricing.clearWindowState(w.slug);
    const sName = getConfig("bid_strategy") || getConfig("pricing_mode") || "hybrid";
    getStrategy(sName).clearWindowState?.(w.slug);
    await tryRedeem(w);
    return;
  }

  // Gamma not ready — predict using the oracle price we captured at window close.
  // This was the live oracle-preferred spot price at the exact moment the window ended.
  // Fallback: current oracle with relaxed staleness.
  const cryptoSymbol = w.crypto_symbol || "BTCUSDT";
  const closePrice = w.spot_at_close || getOracleSpotForResolution(cryptoSymbol)?.price;
  if (!closePrice) return; // no data — keep waiting for Gamma

  const outcome: "UP" | "DOWN" = closePrice >= strike ? "UP" : "DOWN";
  await cancelWindowOrders(w.slug);
  marketWs.unsubscribeTokens([w.up_token_id, w.down_token_id]);
  windowMgr.resolveWindow(w.slug, outcome);
  // confirmed stays 0 — will be confirmed by Gamma on next tick
  pricing.clearWindowState(w.slug);
  const sName = getConfig("bid_strategy") || getConfig("pricing_mode") || "hybrid";
  getStrategy(sName).clearWindowState?.(w.slug);
}

/** Cancel all non-terminal orders for a window. */
async function cancelWindowOrders(windowSlug: string): Promise<void> {
  const orders = ledger.getWindowOrders(windowSlug); // returns PENDING/OPEN/PARTIAL
  for (const order of orders) {
    if (order.clob_order_id) {
      await placer.cancelOrder(order.clob_order_id);
    }
  }
}

/** Try to merge profitable pairs in a window. Paper mode = simulated; real mode = on-chain. */
async function tryMerge(w: windowMgr.WindowRow): Promise<void> {
  const matched = Math.floor(Math.min(w.up_inventory, w.down_inventory));
  const MIN_MERGE_BATCH = 5; // avoid excessively small merges
  if (matched < MIN_MERGE_BATCH) return;

  const pairCost = w.up_avg_cost + w.down_avg_cost;
  // Merge when pc < $1.00 — only merge profitable pairs.
  const mergeThreshold = parseFloat(getConfig("merge_threshold_pc", "1.00") || "1.00");
  if (pairCost >= mergeThreshold) return;

  const mergePnl = matched * (1.0 - pairCost);
  const mode = getConfig("mode") || "paper";

  if (mode !== "real") {
    // PAPER MODE: simulate the merge — update inventory directly, no on-chain tx
    getDb().prepare(`
      UPDATE windows SET
        up_inventory = up_inventory - ?,
        down_inventory = down_inventory - ?,
        total_merged = total_merged + ?,
        merge_pnl = merge_pnl + ?
      WHERE slug = ?
    `).run(matched, matched, matched, mergePnl, w.slug);

    logActivity("MERGE", `${matched} pairs pc=$${pairCost.toFixed(3)} pnl=$${mergePnl.toFixed(2)} [paper]`, {
      windowSlug: w.slug, level: "trade",
    });
    return;
  }

  // REAL MODE: merge on-chain directly (no Python middleman)
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    logActivity("MERGE_ERROR", "No POLYMARKET_PRIVATE_KEY — cannot merge on-chain", { windowSlug: w.slug, level: "error" });
    return;
  }

  try {
    const { mergePositions } = await import("../clob/ctf-operations.js");
    const result = await mergePositions(privateKey, w.condition_id, matched);

    if (result.status === "merged") {
      getDb().prepare(`
        UPDATE windows SET
          up_inventory = up_inventory - ?,
          down_inventory = down_inventory - ?,
          total_merged = total_merged + ?,
          merge_pnl = merge_pnl + ?
        WHERE slug = ?
      `).run(matched, matched, matched, mergePnl, w.slug);

      logActivity("MERGE", `${matched} pairs pc=$${pairCost.toFixed(3)} pnl=$${mergePnl.toFixed(2)} tx=${(result.tx_hash || '').slice(0, 12)}`, {
        windowSlug: w.slug, level: "trade",
      });
    } else {
      logActivity("MERGE_ERROR", `Merge failed: ${result.error || 'unknown'}`, { windowSlug: w.slug, level: "error" });
    }
  } catch (err) {
    logActivity("MERGE_ERROR", String(err), { windowSlug: w.slug, level: "error" });
  }
}

/** Try to redeem winning tokens on-chain. */
async function tryRedeem(w: windowMgr.WindowRow): Promise<void> {
  const mode = getConfig("mode") || "paper";
  if (mode !== "real") return; // paper mode doesn't need on-chain redeem

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) return;

  try {
    const { redeemPositions } = await import("../clob/ctf-operations.js");
    const result = await redeemPositions(privateKey, w.condition_id);

    if (result.status === "redeemed") {
      logActivity("REDEEM", `Redeemed ${w.slug.slice(-13)} tx=${(result.tx_hash || '').slice(0, 12)}`, { windowSlug: w.slug, level: "info" });
    } else if (result.error) {
      // Not all windows have redeemable positions — only log actual errors
      if (!result.error.includes("Dry-run reverted")) {
        logActivity("REDEEM_ERROR", result.error.slice(0, 100), { windowSlug: w.slug, level: "warning" });
      }
    }
  } catch { /* will be caught by sweep */ }
}

const DEFAULT_SHADOW_WALLET = "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30";
let lastBrFetchAt = 0;
let brCache: Array<{ id: string; slug: string; side: "UP" | "DOWN"; price: number; size: number; timestamp: number }> = [];

/**
 * Fetch + persist shadow wallet trades (always runs, regardless of fill mode).
 * Populates brCache + shadow_trades DB table.
 */
async function fetchAndPersistShadowTrades(): Promise<void> {
  const shadowWallet = getConfig("shadow_wallet") || DEFAULT_SHADOW_WALLET;
  const now = Date.now();
  if (now - lastBrFetchAt < 10_000) return;
  lastBrFetchAt = now;

  try {
    const resp = await fetch(`https://data-api.polymarket.com/activity?user=${shadowWallet}&limit=200&_t=${now}`);
    if (!resp.ok) return;
    const items = await resp.json() as Array<Record<string, unknown>>;
    brCache = [];
    const insert = getDb().prepare(`
      INSERT OR IGNORE INTO shadow_trades
        (id, wallet, window_slug, condition_id, token_id, side, buy_sell, price, size, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      if (item.type !== "TRADE") continue;
      const outcome = ((item.outcome as string) || "").toLowerCase();
      const side = outcome === "up" ? "UP" : outcome === "down" ? "DOWN"
        : outcome === "yes" ? "YES" : outcome === "no" ? "NO" : "OTHER";
      const buySell = (item.side as string) === "SELL" ? "SELL" : "BUY";
      const id = (item.transactionHash as string) || `${item.timestamp}-${item.price}-${item.size}-${outcome}`;
      const price = item.price as number;
      const size = item.size as number;
      const ts = ((item.timestamp as number) || 0) * 1000;

      insert.run(
        id,
        shadowWallet,
        (item.slug as string) || null,
        (item.conditionId as string) || null,
        (item.asset as string) || null,
        side,
        buySell,
        price,
        size,
        ts,
      );

      // Keep in-memory cache for shadow-fill matching (BUY fills on UP/DOWN markets only)
      if (buySell === "BUY" && (side === "UP" || side === "DOWN")) {
        brCache.push({
          id,
          slug: (item.slug as string) || "",
          side,
          price,
          size,
          timestamp: item.timestamp as number,
        });
      }
    }
  } catch { return; }
}

/** Paper mode: grant shadow fills by querying persistent shadow_trades DB (not volatile cache). */
async function processShadowFills(): Promise<void> {
  const openOrders = ledger.getOpenOrders();
  const paperOrders = openOrders.filter(o => o.clob_order_id?.startsWith("paper-"));
  if (paperOrders.length === 0) return;

  // Query DB for matching BR trades — this handles ANY window duration (5m, 15m, 4h)
  // unlike the old 200-item brCache which rotated out long-window entries.
  const matchStmt = getDb().prepare(`
    SELECT id, side, price, size FROM shadow_trades
    WHERE window_slug = ? AND side = ? AND buy_sell = 'BUY'
      AND price <= ? AND timestamp >= ?
    ORDER BY timestamp
  `);

  for (const order of paperOrders) {
    const w = windowMgr.getWindow(order.window_slug);
    if (!w) continue;

    const fresh = ledger.getOrderByClobId(order.clob_order_id!);
    if (!fresh || fresh.size_matched >= fresh.size * 0.99) continue;

    // Use WINDOW OPEN TIME, not our entry time. This way even if we discover
    // the window late, we claim all BR fills from window-open onward — correctly
    // simulating "if we'd been there from the start with this bid."
    const windowOpenMs = w.open_time;

    const matching = matchStmt.all(
      order.window_slug,
      order.side,
      order.price,
      windowOpenMs,
    ) as Array<{ id: string; side: string; price: number; size: number }>;

    if (matching.length === 0) continue;

    logActivity("SHADOW_MATCH", `${order.side} L${order.ladder_level}: ${matching.length} BR fills match (bid=$${order.price.toFixed(3)} covers)`, {
      windowSlug: order.window_slug, side: order.side, level: "trade",
    });

    for (const br of matching) {
      const freshAgain = ledger.getOrderByClobId(order.clob_order_id!);
      if (!freshAgain || freshAgain.size_matched >= freshAgain.size * 0.99) break;
      const remaining = freshAgain.size - freshAgain.size_matched;
      const tradeId = `shadow-${br.id}-${order.clob_order_id}`;
      const { processReconcileFill } = await import("../orders/fill-processor.js");
      processReconcileFill(
        tradeId,
        order.clob_order_id!,
        order.window_slug,
        order.token_id,
        order.side as "UP" | "DOWN",
        br.price,
        Math.min(br.size, remaining),
        "paper_shadow",
      );
    }
  }
}

/** Capture a per-tick snapshot of window state for charts/drill-down. */
async function captureWindowTick(
  w: windowMgr.WindowRow,
  pTrue: number,
  spotPrice: number,
  phase: string,
): Promise<void> {
  // Fetch current books for UP and DOWN tokens (parallel)
  const [upBook, dnBook] = await Promise.all([
    fetchBookSnapshot(w.up_token_id),
    fetchBookSnapshot(w.down_token_id),
  ]);

  getDb().prepare(`
    INSERT INTO window_ticks (
      window_slug, timestamp, p_true, spot_price,
      up_best_bid, up_best_ask, up_bid_size, up_ask_size, up_last_trade,
      dn_best_bid, dn_best_ask, dn_bid_size, dn_ask_size, dn_last_trade,
      up_inventory, down_inventory, up_avg_cost, down_avg_cost, phase
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    w.slug, Date.now(), pTrue, spotPrice,
    upBook.bid, upBook.ask, upBook.bidSize, upBook.askSize, upBook.lastTrade,
    dnBook.bid, dnBook.ask, dnBook.bidSize, dnBook.askSize, dnBook.lastTrade,
    w.up_inventory, w.down_inventory, w.up_avg_cost, w.down_avg_cost, phase,
  );

  // Trim old ticks — keep last 500 per window
  getDb().prepare(`
    DELETE FROM window_ticks WHERE window_slug = ? AND id NOT IN (
      SELECT id FROM window_ticks WHERE window_slug = ? ORDER BY id DESC LIMIT 500
    )
  `).run(w.slug, w.slug);
}

interface BookSnap { bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null; lastTrade: number | null; }
async function fetchBookSnapshot(tokenId: string): Promise<BookSnap> {
  // Parallel: book (bid/ask) + dedicated last-trade-price endpoint (per-token, unlike book's shared value)
  try {
    const [bookResp, ltResp] = await Promise.all([
      fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`),
      fetch(`https://clob.polymarket.com/last-trade-price?token_id=${tokenId}`),
    ]);
    const book = await bookResp.json() as {
      bids?: Array<{ price: string; size: string }>;
      asks?: Array<{ price: string; size: string }>;
    };
    const lt = await ltResp.json() as { price?: string };
    const topBid = book.bids?.[0];
    const topAsk = book.asks?.[0];
    return {
      bid: topBid ? parseFloat(topBid.price) : null,
      ask: topAsk ? parseFloat(topAsk.price) : null,
      bidSize: topBid ? parseFloat(topBid.size) : null,
      askSize: topAsk ? parseFloat(topAsk.size) : null,
      lastTrade: lt.price ? parseFloat(lt.price) : null,
    };
  } catch {
    return { bid: null, ask: null, bidSize: null, askSize: null, lastTrade: null };
  }
}

/** Paper mode: check if any resting orders would now cross the real best ask. */
async function checkPaperRestingFills(): Promise<void> {
  const openOrders = ledger.getOpenOrders();
  for (const order of openOrders) {
    if (!order.clob_order_id?.startsWith("paper-")) continue; // only paper orders
    // Re-fetch state — other detectors may have filled this order already this tick
    const fresh = ledger.getOrderByClobId(order.clob_order_id);
    if (!fresh || fresh.size_matched >= fresh.size * 0.99) continue;

    try {
      const bookResp = await fetch(`https://clob.polymarket.com/book?token_id=${order.token_id}`);
      const book = await bookResp.json() as { asks?: Array<{ price: string; size: string }> };
      const bestAsk = book.asks?.[0] ? parseFloat(book.asks[0].price) : null;

      if (bestAsk !== null && order.price >= bestAsk) {
        const remaining = fresh.size - fresh.size_matched;
        const { processReconcileFill } = await import("../orders/fill-processor.js");
        // Stable tradeId: one book fill per order
        processReconcileFill(
          `book-${order.clob_order_id}`,
          order.clob_order_id!,
          order.window_slug,
          order.token_id,
          order.side as "UP" | "DOWN",
          bestAsk,
          remaining,
          "paper_book",
          false, // taker: crossed the real ask — 6.25% fee applies
        );
      }
    } catch { /* skip */ }
  }
}

/** 30s reconciliation — cross-check CLOB activity against our ledger. */
async function reconcile(): Promise<void> {
  // Paper orders can't be queried via CLOB REST — skip reconciliation
  if ((getConfig("mode") || "paper") !== "real") return;
  if (!isClobInitialized()) return;

  try {
    const openOrders = ledger.getOpenOrders();
    if (openOrders.length === 0) return;

    const clob = getClobClient();

    // Check each open order's status via the CLOB adapter
    for (const order of openOrders) {
      if (!order.clob_order_id) continue;

      try {
        const clobOrder = await clob.getOrder(order.clob_order_id);

        if (!clobOrder) {
          const attempts = ledger.incrementReconcileAttempts(order.clob_order_id);
          if (attempts > 10) {
            logActivity("RECONCILE_ORPHAN", `Order ${order.clob_order_id.slice(0, 16)} failed ${attempts}x — marking orphaned`, { level: "warning" });
          }
          continue;
        }

        if ((clobOrder.status === "MATCHED" || clobOrder.status === "FILLED") && clobOrder.sizeMatched > 0) {
          const { processReconcileFill } = await import("../orders/fill-processor.js");
          processReconcileFill(
            `reconcile-${order.clob_order_id}-${Date.now()}`,
            order.clob_order_id,
            order.window_slug,
            order.token_id,
            order.side as "UP" | "DOWN",
            clobOrder.price,
            clobOrder.sizeMatched,
          );
          logActivity("RECONCILE_FILL", `Caught fill via CLOB: ${order.side} ${clobOrder.sizeMatched}@$${clobOrder.price.toFixed(3)}`, {
            windowSlug: order.window_slug, level: "warning",
          });
        } else if (clobOrder.status === "CANCELLED" || clobOrder.status === "CANCELED") {
          ledger.markCancelled(order.clob_order_id);
        }
        // LIVE = still resting, do nothing
      } catch { /* skip this order, try next */ }
    }
  } catch (err) {
    logActivity("RECONCILE_ERROR", String(err), { level: "error" });
  }
}
