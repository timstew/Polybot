/**
 * Oracle Price Feed via Polymarket RTDS (Real-Time Data Socket).
 *
 * Polymarket relays Chainlink Data Streams prices through their public
 * RTDS WebSocket. Since Polymarket's 5-minute crypto markets resolve
 * against Chainlink, using this feed gives us ZERO basis risk — our
 * P_true calculations use the exact same price the referee uses.
 *
 * Architecture:
 *   - Oracle feed (this module): Chainlink prices via RTDS for P_true + strike
 *   - Binance feed (price-feed.ts): raw exchange data for volatility + order flow
 *
 * LOCAL DEV ONLY: Cloudflare Workers cannot maintain persistent outbound
 * WebSocket connections in production. Consumers must check isOracleConnected()
 * and fall back to REST (fetchOracleStrike / fetchSpotPrice).
 */

// ── Types ────────────────────────────────────────────────────────────

export interface OracleTick {
  symbol: string;   // "btc/usd", "eth/usd", etc.
  price: number;
  timestamp: number; // ms
}

interface StrikeCapture {
  price: number;
  timestamp: number;
  locked: boolean;
}

// ── Module State ─────────────────────────────────────────────────────

// Rolling price buffer per symbol (last 60s of ticks)
const oraclePrices = new Map<string, OracleTick[]>();

// Strike captures: key = `${symbol}-${eventStartTimeMs}`
const strikeCaptures = new Map<string, StrikeCapture>();

// Subscribed symbols
const subscribedSymbols = new Set<string>();

let oracleSocket: WebSocket | null = null;
let oracleEnabled = false;
let lastMessageAt = 0;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let reconnecting = false;

const RTDS_URL = "wss://ws-live-data.polymarket.com";
const PING_INTERVAL_MS = 5_000;
const PRICE_RETENTION_MS = 60_000;
const RECONNECT_DELAY_MS = 3_000;
const STALENESS_THRESHOLD_MS = 10_000;

// Map from Binance symbol to RTDS Chainlink symbol
const BINANCE_TO_RTDS: Record<string, string> = {
  BTCUSDT: "btc/usd",
  ETHUSDT: "eth/usd",
  SOLUSDT: "sol/usd",
  XRPUSDT: "xrp/usd",
  DOGEUSDT: "doge/usd",
  AVAXUSDT: "avax/usd",
  DOTUSDT: "dot/usd",
  LINKUSDT: "link/usd",
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start the oracle feed WebSocket connection and subscribe to symbols.
 * @param binanceSymbols - Array of Binance-format symbols (e.g., ["BTCUSDT", "ETHUSDT"])
 */
export function enableOracleFeed(binanceSymbols: string[]): void {
  if (oracleEnabled) {
    // Just add new subscriptions
    addSubscriptions(binanceSymbols);
    return;
  }
  oracleEnabled = true;
  addSubscriptions(binanceSymbols);
  connect();
}

export function disableOracleFeed(): void {
  oracleEnabled = false;
  cleanup();
  oraclePrices.clear();
  subscribedSymbols.clear();
}

/**
 * Get the latest oracle (Chainlink) spot price for a symbol.
 * Returns null if no recent data or feed is stale.
 * @param binanceSymbol - e.g., "BTCUSDT"
 */
export function getOracleSpot(binanceSymbol: string): OracleTick | null {
  const rtdsSymbol = BINANCE_TO_RTDS[binanceSymbol.toUpperCase()];
  if (!rtdsSymbol) return null;

  const ticks = oraclePrices.get(rtdsSymbol);
  if (!ticks || ticks.length === 0) return null;

  const latest = ticks[ticks.length - 1];
  // Reject if stale
  if (Date.now() - latest.timestamp > STALENESS_THRESHOLD_MS) return null;
  return latest;
}

/**
 * Capture the oracle strike price at a specific eventStartTime.
 *
 * The first RTDS tick where timestamp >= eventStartTime becomes the
 * immutable strike price for that window. This matches how Polymarket's
 * smart contract locks the Chainlink price at the window boundary.
 *
 * @param binanceSymbol - e.g., "BTCUSDT"
 * @param eventStartTimeMs - Window start time in milliseconds
 * @returns The captured strike price, or null if not yet captured
 */
export function getOracleStrike(
  binanceSymbol: string,
  eventStartTimeMs: number,
): number | null {
  const rtdsSymbol = BINANCE_TO_RTDS[binanceSymbol.toUpperCase()];
  if (!rtdsSymbol) return null;

  const key = `${rtdsSymbol}-${eventStartTimeMs}`;
  const capture = strikeCaptures.get(key);
  if (capture?.locked) return capture.price;

  // Try to capture from buffer: first tick >= eventStartTime
  const ticks = oraclePrices.get(rtdsSymbol);
  if (!ticks || ticks.length === 0) return null;

  for (const tick of ticks) {
    if (tick.timestamp >= eventStartTimeMs) {
      strikeCaptures.set(key, {
        price: tick.price,
        timestamp: tick.timestamp,
        locked: true,
      });
      return tick.price;
    }
  }

  return null;
}

/**
 * Get recent oracle price history for volatility cross-reference.
 * @param binanceSymbol - e.g., "BTCUSDT"
 * @param sinceMs - Only return ticks from the last N ms
 */
export function getOracleHistory(
  binanceSymbol: string,
  sinceMs?: number,
): OracleTick[] {
  const rtdsSymbol = BINANCE_TO_RTDS[binanceSymbol.toUpperCase()];
  if (!rtdsSymbol) return [];

  const ticks = oraclePrices.get(rtdsSymbol) || [];
  if (sinceMs == null) return ticks;
  const cutoff = Date.now() - sinceMs;
  return ticks.filter((t) => t.timestamp >= cutoff);
}

export function isOracleConnected(): boolean {
  if (!oracleEnabled || !oracleSocket) return false;
  if (oracleSocket.readyState !== WebSocket.OPEN) return false;
  // Stale check: no messages for 10s means feed is dead
  if (lastMessageAt > 0 && Date.now() - lastMessageAt > STALENESS_THRESHOLD_MS) return false;
  return true;
}

/**
 * Convert Binance symbol to RTDS Chainlink symbol.
 * "BTCUSDT" → "btc/usd"
 */
export function toRtdsSymbol(binanceSymbol: string): string | null {
  return BINANCE_TO_RTDS[binanceSymbol.toUpperCase()] ?? null;
}

// ── Connection Management ────────────────────────────────────────────

function addSubscriptions(binanceSymbols: string[]): void {
  for (const sym of binanceSymbols) {
    const rtds = BINANCE_TO_RTDS[sym.toUpperCase()];
    if (rtds) subscribedSymbols.add(rtds);
  }
  // If socket is open, send subscription for any new symbols
  if (oracleSocket?.readyState === WebSocket.OPEN) {
    sendSubscription();
  }
}

function connect(): void {
  if (reconnecting) return;
  cleanup();

  try {
    oracleSocket = new WebSocket(RTDS_URL);

    oracleSocket.addEventListener("open", () => {
      console.log("[ORACLE-WS] Connected to Polymarket RTDS");
      lastMessageAt = Date.now();
      sendSubscription();
      // PING every 5s to keep connection alive
      pingInterval = setInterval(() => {
        if (oracleSocket?.readyState === WebSocket.OPEN) {
          oracleSocket.send("PING");
        }
      }, PING_INTERVAL_MS);
    });

    oracleSocket.addEventListener("message", (event) => {
      lastMessageAt = Date.now();
      const raw = typeof event.data === "string" ? event.data : "";
      if (raw === "PONG" || raw === "") return;
      try {
        handleMessage(JSON.parse(raw));
      } catch {
        // Ignore parse errors
      }
    });

    oracleSocket.addEventListener("close", () => {
      console.log("[ORACLE-WS] Disconnected");
      scheduleReconnect();
    });

    oracleSocket.addEventListener("error", (e) => {
      console.error("[ORACLE-WS] Error:", e);
      scheduleReconnect();
    });
  } catch (e) {
    console.error("[ORACLE-WS] Failed to connect:", e);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (!oracleEnabled || reconnecting) return;
  reconnecting = true;
  setTimeout(() => {
    reconnecting = false;
    if (oracleEnabled) connect();
  }, RECONNECT_DELAY_MS);
}

function cleanup(): void {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  if (oracleSocket) {
    try { oracleSocket.close(); } catch { /* ignore */ }
    oracleSocket = null;
  }
}

function sendSubscription(): void {
  if (!oracleSocket || oracleSocket.readyState !== WebSocket.OPEN) return;

  // Subscribe to ALL Chainlink crypto prices — no per-symbol filters.
  // Per-symbol filters only work for BTC; subscribing without filters
  // streams all symbols (BTC, ETH, SOL, XRP, DOGE, BNB, HYPE).
  // We filter for our target symbols in handleMessage().
  oracleSocket.send(JSON.stringify({
    action: "subscribe",
    subscriptions: [{ topic: "crypto_prices_chainlink", type: "*" }],
  }));

  console.log(`[ORACLE-WS] Subscribed to all Chainlink prices (tracking: ${Array.from(subscribedSymbols).join(", ")})`);
}

// ── Message Handling ─────────────────────────────────────────────────

interface RtdsMessage {
  topic?: string;
  type?: string;
  timestamp?: number;
  payload?: {
    symbol?: string;
    timestamp?: number;
    value?: number;
  };
}

function handleMessage(msg: RtdsMessage): void {
  if (msg.topic !== "crypto_prices_chainlink") return;
  if (msg.type !== "update" || !msg.payload) return;

  const { symbol, timestamp, value } = msg.payload;
  if (!symbol || !value || value <= 0) return;

  // Only track symbols we're interested in
  if (!subscribedSymbols.has(symbol)) return;

  const ts = timestamp ?? msg.timestamp ?? Date.now();

  const tick: OracleTick = { symbol, price: value, timestamp: ts };

  // Store in rolling buffer
  if (!oraclePrices.has(symbol)) oraclePrices.set(symbol, []);
  const ticks = oraclePrices.get(symbol)!;
  ticks.push(tick);

  // Prune old ticks
  const cutoff = Date.now() - PRICE_RETENTION_MS;
  while (ticks.length > 0 && ticks[0].timestamp < cutoff) {
    ticks.shift();
  }

  // Check if any pending strike captures can be resolved
  for (const [key, capture] of strikeCaptures.entries()) {
    if (capture.locked) continue;
    if (!key.startsWith(symbol + "-")) continue;
    const eventStartMs = parseInt(key.split("-").pop()!);
    if (ts >= eventStartMs) {
      capture.price = value;
      capture.timestamp = ts;
      capture.locked = true;
    }
  }
}
