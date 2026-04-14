/**
 * CLOB WebSocket feed for Polymarket orderbooks.
 *
 * Provides real-time book snapshots, trades, and resolution events.
 * Mirrors the Binance WebSocket pattern in price-feed.ts.
 *
 * LOCAL DEV ONLY: Cloudflare Workers cannot maintain persistent outbound
 * WebSocket connections in production. All consumers must check
 * isClobConnected() and fall back to REST.
 */

import type { OrderBook, BookLevel } from "../strategy";

// ── Types ────────────────────────────────────────────────────────────

export interface ClobTradeEntry {
  asset_id: string;
  price: number;
  size: number;
  side: string;
  timestamp: number;
}

interface ClobBookState {
  book: OrderBook;
  updatedAt: number;
}

// ── Module State ─────────────────────────────────────────────────────

const clobBooks = new Map<string, ClobBookState>();
const clobTrades = new Map<string, ClobTradeEntry[]>();
const clobResolutions = new Map<string, string>(); // tokenId → outcome
const subscribedTokens = new Set<string>();
// Track which tokens have received their initial book snapshot (boot race protection)
const initializedTokens = new Set<string>();

let clobSocket: WebSocket | null = null;
let clobEnabled = false;
let lastAnyMessageAt = 0; // global heartbeat for zombie detection
let pingInterval: ReturnType<typeof setInterval> | null = null;
let zombieCheckInterval: ReturnType<typeof setInterval> | null = null;
let reconnecting = false;

const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_INTERVAL_MS = 10_000;
const TRADE_RETENTION_MS = 60_000;
const STALENESS_THRESHOLD_MS = 10_000;
const ZOMBIE_THRESHOLD_MS = 3_000;
const RECONNECT_DELAY_MS = 5_000;

// ── Public API ───────────────────────────────────────────────────────

export function enableClobFeed(): void {
  if (clobEnabled) return;
  clobEnabled = true;
  connect();
}

export function disableClobFeed(): void {
  clobEnabled = false;
  cleanup();
}

export function subscribeClobTokens(tokenIds: string[]): void {
  const newTokens: string[] = [];
  for (const id of tokenIds) {
    if (!subscribedTokens.has(id)) {
      subscribedTokens.add(id);
      newTokens.push(id);
    }
  }
  // Send subscription if socket is open and there are new tokens
  if (clobSocket && clobSocket.readyState === WebSocket.OPEN && newTokens.length > 0) {
    sendSubscription(newTokens);
  }
}

export function unsubscribeClobTokens(tokenIds: string[]): void {
  for (const id of tokenIds) {
    subscribedTokens.delete(id);
    clobBooks.delete(id);
    clobTrades.delete(id);
    initializedTokens.delete(id);
  }
}

/**
 * Get the current order book for a token.
 * Returns null if:
 * - Not connected
 * - Token hasn't received initial snapshot yet (boot race protection)
 * - Book is stale (>10s old)
 * Caller should fall back to REST when null.
 */
export function getClobBook(tokenId: string): OrderBook | null {
  if (!clobEnabled) return null;
  if (!initializedTokens.has(tokenId)) return null;
  const entry = clobBooks.get(tokenId);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > STALENESS_THRESHOLD_MS) return null;
  return entry.book;
}

export function getClobRecentTrades(tokenId: string, sinceMs?: number): ClobTradeEntry[] {
  const trades = clobTrades.get(tokenId) || [];
  if (sinceMs == null) return trades;
  const cutoff = Date.now() - sinceMs;
  return trades.filter((t) => t.timestamp >= cutoff);
}

export function getClobResolution(tokenId: string): { resolved: boolean; outcome: string | null } {
  const outcome = clobResolutions.get(tokenId);
  if (outcome != null) return { resolved: true, outcome };
  return { resolved: false, outcome: null };
}

/**
 * Check if the CLOB WebSocket is connected AND healthy.
 * Returns false if zombie (no messages in >3s during active markets).
 */
export function isClobConnected(): boolean {
  if (!clobEnabled || !clobSocket) return false;
  if (clobSocket.readyState !== WebSocket.OPEN) return false;
  // Zombie check: if we have subscribed tokens but no messages for 3s, assume dead
  if (subscribedTokens.size > 0 && lastAnyMessageAt > 0) {
    if (Date.now() - lastAnyMessageAt > ZOMBIE_THRESHOLD_MS) return false;
  }
  return true;
}

// ── Connection Management ────────────────────────────────────────────

function connect(): void {
  if (reconnecting) return;
  cleanup();

  try {
    clobSocket = new WebSocket(CLOB_WS_URL);

    clobSocket.addEventListener("open", () => {
      console.log("[CLOB-WS] Connected");
      lastAnyMessageAt = Date.now();
      // Subscribe all tokens
      if (subscribedTokens.size > 0) {
        sendSubscription(Array.from(subscribedTokens));
      }
      // Start ping interval
      pingInterval = setInterval(() => {
        if (clobSocket?.readyState === WebSocket.OPEN) {
          clobSocket.send("PING");
        }
      }, PING_INTERVAL_MS);
      // Start zombie detection
      zombieCheckInterval = setInterval(checkZombie, ZOMBIE_THRESHOLD_MS);
    });

    clobSocket.addEventListener("message", (event) => {
      lastAnyMessageAt = Date.now();
      const raw = typeof event.data === "string" ? event.data : "";
      if (raw === "PONG" || raw === "") return;
      try {
        handleMessage(JSON.parse(raw));
      } catch {
        // Ignore parse errors
      }
    });

    clobSocket.addEventListener("close", (event) => {
      const ce = event as CloseEvent;
      console.log(`[CLOB-WS] Disconnected: code=${ce.code} reason="${ce.reason || "none"}"`);
      scheduleReconnect();
    });

    clobSocket.addEventListener("error", (e) => {
      // Log useful details from the error event
      const detail = (e as { message?: string }).message || String(e);
      console.error(`[CLOB-WS] Error: ${detail}`);
      scheduleReconnect();
    });
  } catch (e) {
    console.error("[CLOB-WS] Failed to connect:", e);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (!clobEnabled || reconnecting) return;
  reconnecting = true;
  // Clear initialized tokens — need fresh snapshots after reconnect
  initializedTokens.clear();
  setTimeout(() => {
    reconnecting = false;
    if (clobEnabled) connect();
  }, RECONNECT_DELAY_MS);
}

function checkZombie(): void {
  if (!clobEnabled || !clobSocket || subscribedTokens.size === 0) return;
  if (clobSocket.readyState !== WebSocket.OPEN) return;
  if (lastAnyMessageAt > 0 && Date.now() - lastAnyMessageAt > ZOMBIE_THRESHOLD_MS) {
    console.warn("[CLOB-WS] Zombie detected — no messages for 3s, force-closing");
    initializedTokens.clear();
    try { clobSocket.close(); } catch { /* ignore */ }
    clobSocket = null;
    scheduleReconnect();
  }
}

function cleanup(): void {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  if (zombieCheckInterval) { clearInterval(zombieCheckInterval); zombieCheckInterval = null; }
  if (clobSocket) {
    try { clobSocket.close(); } catch { /* ignore */ }
    clobSocket = null;
  }
  initializedTokens.clear();
}

function sendSubscription(tokenIds: string[]): void {
  if (!clobSocket || clobSocket.readyState !== WebSocket.OPEN) return;
  clobSocket.send(JSON.stringify({
    assets_ids: tokenIds,
    type: "market",
  }));
  console.log(`[CLOB-WS] Subscribed to ${tokenIds.length} tokens`);
}

// ── Message Handling ─────────────────────────────────────────────────

interface ClobMessage {
  event_type?: string;
  asset_id?: string;
  market?: string;
  // book event
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  // price_change event (incremental book update)
  changes?: Array<{ price: string; size: string; side: string }>;
  // last_trade_price event
  price?: string;
  size?: string;
  side?: string;
  timestamp?: number | string;
  // market_resolved
  outcome?: string;
}

function handleMessage(msg: ClobMessage): void {
  const eventType = msg.event_type || "";
  const assetId = msg.asset_id || msg.market || "";

  switch (eventType) {
    case "book":
      handleBookSnapshot(assetId, msg);
      break;
    case "price_change":
      handlePriceChange(assetId, msg);
      break;
    case "last_trade_price":
      handleLastTrade(assetId, msg);
      break;
    case "market_resolved":
      if (assetId && msg.outcome) {
        clobResolutions.set(assetId, msg.outcome);
        console.log(`[CLOB-WS] Market resolved: ${assetId.slice(0, 10)}... → ${msg.outcome}`);
      }
      break;
  }
}

function parseBookLevels(raw: Array<{ price: string; size: string }> | undefined): BookLevel[] {
  if (!raw) return [];
  return raw
    .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
    .filter((l) => !isNaN(l.price) && !isNaN(l.size) && l.size > 0);
}

function handleBookSnapshot(assetId: string, msg: ClobMessage): void {
  if (!assetId) return;
  const book: OrderBook = {
    bids: parseBookLevels(msg.bids),
    asks: parseBookLevels(msg.asks),
  };
  // Sort bids descending by price, asks ascending
  book.bids.sort((a, b) => b.price - a.price);
  book.asks.sort((a, b) => a.price - b.price);

  clobBooks.set(assetId, { book, updatedAt: Date.now() });
  initializedTokens.add(assetId);
}

function handlePriceChange(assetId: string, msg: ClobMessage): void {
  if (!assetId || !msg.changes) return;
  const entry = clobBooks.get(assetId);
  if (!entry) return; // Haven't received snapshot yet — ignore incremental

  const book = entry.book;
  for (const change of msg.changes) {
    const price = parseFloat(change.price);
    const size = parseFloat(change.size);
    const side = change.side?.toLowerCase();
    if (isNaN(price) || isNaN(size)) continue;

    const levels = side === "buy" || side === "bid" ? book.bids : book.asks;

    if (size <= 0) {
      // Remove level
      const idx = levels.findIndex((l) => Math.abs(l.price - price) < 0.00001);
      if (idx !== -1) levels.splice(idx, 1);
    } else {
      // Update or insert level
      const existing = levels.find((l) => Math.abs(l.price - price) < 0.00001);
      if (existing) {
        existing.size = size;
      } else {
        levels.push({ price, size });
      }
    }
  }

  // Re-sort
  book.bids.sort((a, b) => b.price - a.price);
  book.asks.sort((a, b) => a.price - b.price);
  entry.updatedAt = Date.now();
}

function handleLastTrade(assetId: string, msg: ClobMessage): void {
  if (!assetId) return;
  const price = parseFloat(msg.price || "0");
  const size = parseFloat(msg.size || "0");
  if (price <= 0 || size <= 0) return;

  let ts: number;
  if (typeof msg.timestamp === "number") {
    ts = msg.timestamp < 1e12 ? msg.timestamp * 1000 : msg.timestamp;
  } else {
    ts = Date.now();
  }

  const trade: ClobTradeEntry = {
    asset_id: assetId,
    price,
    size,
    side: msg.side || "",
    timestamp: ts,
  };

  if (!clobTrades.has(assetId)) clobTrades.set(assetId, []);
  const trades = clobTrades.get(assetId)!;
  trades.push(trade);

  // Prune old trades
  const cutoff = Date.now() - TRADE_RETENTION_MS;
  while (trades.length > 0 && trades[0].timestamp < cutoff) {
    trades.shift();
  }
}
