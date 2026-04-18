/**
 * Market WebSocket — real-time per-token trade events from Polymarket CLOB.
 *
 * Subscribes to specific token IDs and receives EVERY trade on those tokens
 * in real-time. Replaces the polling-based grounded fill check (which only
 * saw ~6 trades per 1000 global trades).
 *
 * Protocol:
 *   URL: wss://ws-subscriptions-clob.polymarket.com/ws/market
 *   Subscribe: { type: "market", assets_id: ["tokenId1", "tokenId2", ...] }
 *   Events: { event_type: "trade", asset_id, price, size, side, timestamp, ... }
 */

import { EventEmitter } from "node:events";
import { logActivity } from "../db.js";

const MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 1_000; // fast reconnect — server drops us every ~6s, minimize downtime
// Proactive reconnect: when data stops flowing, kill and reconnect to trigger
// a fresh initial dump. Each new connection gets recent data burst.
// This is intentional cycling — the WS is most useful in the first few seconds.
const DATA_LULL_RECONNECT_MS = 10_000; // 10s of no data → force reconnect for fresh dump

export interface MarketTradeEvent {
  asset_id: string;
  price: number;
  size: number;
  side: string;        // "BUY" or "SELL"
  timestamp: number;   // unix seconds
}

class MarketWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private zombieInterval: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;      // any message (including PONG)
  private lastDataAt = 0;          // actual trade/book data (NOT pong)
  private reconnecting = false;
  private enabled = false;

  // Track subscribed tokens — re-subscribe on reconnect
  private subscribedTokens = new Set<string>();

  connect(): void {
    this.enabled = true;
    // Don't connect yet — wait for subscribeTokens() to trigger lazy connect.
    // Connecting with 0 tokens causes server to drop us repeatedly (code 1006).
  }

  disconnect(): void {
    this.enabled = false;
    this._cleanup();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !this._isZombie();
  }

  /** Seconds since last actual data (trade/book event). For diagnostics. */
  get dataAge(): number {
    return this.lastDataAt > 0 ? Math.round((Date.now() - this.lastDataAt) / 1000) : -1;
  }

  /** Subscribe to trade events for specific token IDs. Connects lazily on first subscribe. */
  subscribeTokens(tokenIds: string[]): void {
    for (const id of tokenIds) this.subscribedTokens.add(id);
    if (this.subscribedTokens.size === 0) return;
    // Connect if not connected (or if existing WS is closed/closing)
    if (this.enabled && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) {
      this._cleanup();
      this._connect();
    } else {
      this._sendSubscription();
    }
  }

  /** Unsubscribe tokens (e.g., when a window resolves). */
  unsubscribeTokens(tokenIds: string[]): void {
    for (const id of tokenIds) this.subscribedTokens.delete(id);
    // Re-send full subscription (server overwrites previous)
    this._sendSubscription();
  }

  /** Get count of subscribed tokens. */
  get tokenCount(): number {
    return this.subscribedTokens.size;
  }

  private _connect(): void {
    if (this.reconnecting || !this.enabled) return;
    this._cleanup();

    try {
      this.ws = new WebSocket(MARKET_WS_URL);

      this.ws.addEventListener("open", () => {
        console.log("[MARKET-WS] Connected");
        this.lastMessageAt = Date.now();
        logActivity("MARKET_WS", "Connected to market WebSocket", { level: "info" });

        this._sendSubscription();
        // Subscription refresh hack (poly-sdk): re-send after 2s
        setTimeout(() => this._sendSubscription(), 2000);

        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("PING");
        }, PING_INTERVAL_MS);

        this.zombieInterval = setInterval(() => this._checkZombie(), 5_000); // check every 5s
        this.emit("connected");
      });

      this.ws.addEventListener("message", (event: MessageEvent) => {
        this.lastMessageAt = Date.now();
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        if (raw === "PONG" || raw === "") return;

        // ANY non-PONG message counts as data (resets zombie timer)
        this.lastDataAt = Date.now();

        try {
          const msgs = JSON.parse(raw);
          const list = Array.isArray(msgs) ? msgs : [msgs];
          for (const msg of list) {
            this._handleMessage(msg);
          }
        } catch { /* ignore parse errors */ }
      });

      this.ws.addEventListener("close", (event: Event) => {
        const ce = event as CloseEvent;
        console.log(`[MARKET-WS] Disconnected: code=${ce.code}, tokens=${this.subscribedTokens.size}`);
        logActivity("MARKET_WS", `Disconnected: code=${ce.code}, reconnecting (${this.subscribedTokens.size} tokens)`, { level: "warning" });
        this._scheduleReconnect();
      });

      this.ws.addEventListener("error", () => {
        console.error("[MARKET-WS] Error");
        this._scheduleReconnect();
      });
    } catch (err) {
      console.error("[MARKET-WS] Failed to connect:", err);
      this._scheduleReconnect();
    }
  }

  private _sendSubscription(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.subscribedTokens.size === 0) return;

    // Polymarket market WS: send all tokens in one message.
    // Server overwrites previous subscription of the same type,
    // so always send the FULL list (accumulated pattern from poly-sdk).
    const msg = JSON.stringify({
      assets_ids: [...this.subscribedTokens],
      type: "market",
      initial_dump: true, // official example sends this — triggers initial book snapshot
    });
    this.ws.send(msg);
    console.log(`[MARKET-WS] Subscribed to ${this.subscribedTokens.size} tokens`);
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    const eventType = (msg.event_type as string) || (msg.type as string) || "";

    if (eventType === "trade" || eventType === "last_trade_price") {
      // Extract trade details
      const assetId = (msg.asset_id as string) || "";
      const price = parseFloat(String(msg.price || 0));
      const size = parseFloat(String(msg.size || 0));
      const side = (msg.side as string) || "";
      const timestamp = (msg.timestamp as number) || Date.now() / 1000;

      if (assetId && price > 0) {
        const event: MarketTradeEvent = { asset_id: assetId, price, size, side, timestamp };
        this.emit("trade", event);
      }
    } else if (eventType === "book") {
      // Book update — emit for future use (real-time book tracking)
      this.emit("book", msg);
    }
  }

  private _isZombie(): boolean {
    // Proactive lull detection: if data stopped flowing, reconnect to get fresh dump.
    // This is intentional — each new connection triggers a data burst.
    if (this.lastDataAt === 0 && this.lastMessageAt === 0) return false;
    if (this.lastDataAt > 0) return Date.now() - this.lastDataAt > DATA_LULL_RECONNECT_MS;
    return Date.now() - this.lastMessageAt > DATA_LULL_RECONNECT_MS;
  }

  private _checkZombie(): void {
    if (!this.enabled || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this._isZombie()) {
      console.warn("[MARKET-WS] Zombie detected — reconnecting");
      logActivity("MARKET_WS", "Zombie detected, reconnecting", { level: "warning" });
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
      this._scheduleReconnect();
    }
  }

  private _scheduleReconnect(): void {
    if (!this.enabled || this.reconnecting) return;
    // Don't reconnect if we have no tokens — just wait for subscribeTokens
    if (this.subscribedTokens.size === 0) return;
    this.reconnecting = true;
    setTimeout(() => {
      this.reconnecting = false;
      if (this.enabled && this.subscribedTokens.size > 0) this._connect();
    }, RECONNECT_DELAY_MS);
    this.emit("reconnecting");
  }

  private _cleanup(): void {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    if (this.zombieInterval) { clearInterval(this.zombieInterval); this.zombieInterval = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}

// Singleton
export const marketWs = new MarketWebSocket();
