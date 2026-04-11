/**
 * Reactive Price Feed — Binance WebSocket for real-time spot prices.
 *
 * Module-level singleton that maintains a persistent Binance WebSocket.
 * Any strategy can subscribe to symbols and get zero-latency price reads.
 *
 * LOCAL DEV ONLY: Cloudflare Workers cannot maintain persistent outbound
 * WebSocket connections. Falls back gracefully (returns null → caller uses REST).
 *
 * PUBLIC API:
 *   enableReactiveFeed(symbols)      — subscribe to Binance miniTicker
 *   getReactiveSpot(symbol)          — latest buffered price (instant)
 *   hasPriceChanged(symbol)          — true if price updated since last ack
 *   acknowledgePriceChange(symbol)   — reset changed flag after processing
 *   disableReactiveFeed(symbols)     — unsubscribe (closes socket when 0 subs)
 *   isReactiveFeedConnected()        — health check
 */

// ── Types ────────────────────────────────────────────────────────────

interface PriceEntry {
  price: number;
  timestamp: number;
  changed: boolean;
}

// ── Module State ─────────────────────────────────────────────────────

const prices = new Map<string, PriceEntry>();
const subscribers = new Map<string, number>(); // symbol → ref count
let ws: WebSocket | null = null;
let connected = false;
let reconnecting = false;
let reconnectDelay = 3_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RECONNECT_DELAY = 30_000;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Subscribe to Binance miniTicker streams for given symbols.
 * Symbols should be Binance format: "BTCUSDT", "ETHUSDT", etc.
 */
export function enableReactiveFeed(symbols: string[]): void {
  let needsReconnect = false;

  for (const sym of symbols) {
    const upper = sym.toUpperCase();
    const prev = subscribers.get(upper) ?? 0;
    subscribers.set(upper, prev + 1);
    if (prev === 0) needsReconnect = true; // new symbol — need to resubscribe
  }

  if (!ws && !reconnecting) {
    connectWebSocket();
  } else if (needsReconnect && ws?.readyState === WebSocket.OPEN) {
    // Resubscribe with updated symbol list
    sendSubscription();
  }
}

/**
 * Get latest buffered spot price for a symbol.
 * Returns null if no update received yet (caller should fallback to REST).
 */
export function getReactiveSpot(symbol: string): { price: number; timestamp: number } | null {
  const entry = prices.get(symbol.toUpperCase());
  if (!entry) return null;
  // Stale check: 30s
  if (Date.now() - entry.timestamp > 30_000) return null;
  return { price: entry.price, timestamp: entry.timestamp };
}

/** True if price changed since last acknowledgePriceChange() call. */
export function hasPriceChanged(symbol: string): boolean {
  return prices.get(symbol.toUpperCase())?.changed ?? false;
}

/** Reset the "changed" flag after processing a price update. */
export function acknowledgePriceChange(symbol: string): void {
  const entry = prices.get(symbol.toUpperCase());
  if (entry) entry.changed = false;
}

/**
 * Unsubscribe symbols. Closes WebSocket when no subscribers remain.
 */
export function disableReactiveFeed(symbols: string[]): void {
  for (const sym of symbols) {
    const upper = sym.toUpperCase();
    const count = subscribers.get(upper) ?? 0;
    if (count <= 1) {
      subscribers.delete(upper);
      prices.delete(upper);
    } else {
      subscribers.set(upper, count - 1);
    }
  }

  // Close socket if no subscribers
  if (subscribers.size === 0) {
    cleanup();
  }
}

/** Health check: is the WebSocket connected and receiving data? */
export function isReactiveFeedConnected(): boolean {
  return connected && ws?.readyState === WebSocket.OPEN;
}

// ── WebSocket Management ─────────────────────────────────────────────

function connectWebSocket(): void {
  if (subscribers.size === 0) return;

  try {
    const streams = Array.from(subscribers.keys())
      .map(s => `${s.toLowerCase()}@miniTicker`)
      .join("/");

    ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);

    ws.addEventListener("open", () => {
      console.log(`[REACTIVE-FEED] Connected (${subscribers.size} symbols)`);
      connected = true;
      reconnectDelay = 3_000; // reset backoff on success
    });

    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      try {
        const msg = JSON.parse(raw) as {
          stream?: string;
          data?: { s?: string; c?: string; E?: number };
        };
        if (msg.data?.s && msg.data?.c) {
          const symbol = msg.data.s.toUpperCase();
          const price = parseFloat(msg.data.c);
          if (price > 0 && isFinite(price)) {
            const existing = prices.get(symbol);
            const priceChanged = !existing || existing.price !== price;
            prices.set(symbol, {
              price,
              timestamp: msg.data.E ?? Date.now(),
              changed: priceChanged,
            });
          }
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.addEventListener("close", () => {
      console.log("[REACTIVE-FEED] Disconnected");
      connected = false;
      ws = null;
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      connected = false;
      // close event will follow
    });
  } catch {
    // WebSocket creation failed (CF Workers, etc.)
    console.log("[REACTIVE-FEED] WebSocket unavailable — strategies will use REST fallback");
    connected = false;
    ws = null;
  }
}

function sendSubscription(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const params = Array.from(subscribers.keys())
    .map(s => `${s.toLowerCase()}@miniTicker`);

  ws.send(JSON.stringify({
    method: "SUBSCRIBE",
    params,
    id: Date.now(),
  }));
}

function scheduleReconnect(): void {
  if (reconnecting || subscribers.size === 0) return;
  reconnecting = true;

  reconnectTimer = setTimeout(() => {
    reconnecting = false;
    if (subscribers.size > 0) {
      console.log(`[REACTIVE-FEED] Reconnecting (delay=${reconnectDelay}ms)...`);
      connectWebSocket();
    }
    // Exponential backoff
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }, reconnectDelay);
}

function cleanup(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnecting = false;
  connected = false;
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  prices.clear();
}
