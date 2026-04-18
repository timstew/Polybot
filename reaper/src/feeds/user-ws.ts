/**
 * User WebSocket — real-time fill notifications from the Polymarket CLOB.
 *
 * This is THE solution to fill detection. Instead of polling getOrderStatus()
 * and missing fills due to timing races, the CLOB pushes fill events to us
 * the instant they happen.
 *
 * Protocol (from poly-maker reference implementation):
 *   URL: wss://ws-subscriptions-clob.polymarket.com/ws/user
 *   Auth: { type: "user", auth: { apiKey, secret, passphrase } }
 *   Events: trade events with status MATCHED → MINED → CONFIRMED/FAILED
 *
 * Uses Bun's built-in WebSocket (browser API).
 */

import { EventEmitter } from "node:events";
import { logActivity } from "../db.js";

const USER_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const PING_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 5_000;
const ZOMBIE_THRESHOLD_MS = 30_000; // no messages for 30s = zombie

export interface UserFillEvent {
  orderId: string;
  status: "MATCHED" | "MINED" | "CONFIRMED" | "FAILED";
  sizeMatched: number;
  price: number;
  tradeId: string;
  isMaker: boolean;
  tokenId: string;
  side: string;
  timestamp: number;
}

export interface UserWsCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

class UserWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private credentials: UserWsCredentials | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private zombieInterval: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private reconnecting = false;
  private enabled = false;

  /** Connect with CLOB API credentials. */
  connect(credentials: UserWsCredentials): void {
    this.credentials = credentials;
    this.enabled = true;
    this._connect();
  }

  disconnect(): void {
    this.enabled = false;
    this._cleanup();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !this._isZombie();
  }

  private _connect(): void {
    if (this.reconnecting || !this.enabled) return;
    this._cleanup();

    try {
      this.ws = new WebSocket(USER_WS_URL);

      this.ws.onopen = () => {
        console.log("[USER-WS] Connected");
        this.lastMessageAt = Date.now();
        logActivity("USER_WS", "Connected to Polymarket user WebSocket", { level: "info" });

        // Authenticate
        if (this.credentials) {
          this.ws!.send(JSON.stringify({
            type: "user",
            auth: {
              apiKey: this.credentials.apiKey,
              secret: this.credentials.secret,
              passphrase: this.credentials.passphrase,
            },
          }));
          console.log("[USER-WS] Auth sent");
        }

        // Start ping
        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send("PING");
          }
        }, PING_INTERVAL_MS);

        // Start zombie detection
        this.zombieInterval = setInterval(() => this._checkZombie(), ZOMBIE_THRESHOLD_MS);

        this.emit("connected");
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.lastMessageAt = Date.now();
        const raw = typeof event.data === "string" ? event.data : String(event.data);

        if (raw === "PONG" || raw === "") return;

        try {
          const msg = JSON.parse(raw);
          this._handleMessage(msg);
        } catch {
          // Ignore parse errors
        }
      };

      this.ws.onclose = (event: CloseEvent) => {
        console.log(`[USER-WS] Disconnected: code=${event.code} reason="${event.reason || "none"}"`);
        logActivity("USER_WS", `Disconnected: code=${event.code}`, { level: "warning" });
        this._scheduleReconnect();
      };

      this.ws.onerror = (event) => {
        console.error("[USER-WS] Error:", event);
        this._scheduleReconnect();
      };
    } catch (err) {
      console.error("[USER-WS] Failed to connect:", err);
      this._scheduleReconnect();
    }
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    const eventType = (msg.event_type as string) || (msg.type as string) || "";

    if (eventType === "trade" || eventType === "order") {
      this._handleTradeEvent(msg);
    } else if (eventType === "error") {
      console.error("[USER-WS] Server error:", msg);
      logActivity("USER_WS_ERROR", JSON.stringify(msg), { level: "error" });
    }
  }

  private _handleTradeEvent(msg: Record<string, unknown>): void {
    const status = (msg.status as string) || "";
    const orderId = (msg.order_id as string) || (msg.id as string) || "";

    if (!orderId) return;

    // Extract fill details
    const sizeMatched = parseFloat(String(msg.size_matched || msg.size || 0));
    const price = parseFloat(String(msg.price || 0));
    const tradeId = (msg.trade_id as string) || (msg.id as string) || `${orderId}-${Date.now()}`;
    const tokenId = (msg.asset_id as string) || (msg.token_id as string) || "";
    const side = (msg.side as string) || (msg.outcome as string) || "";

    // Determine if we're the maker
    const makerAddress = (msg.maker_address as string) || "";
    const isMaker = !!makerAddress;

    const event: UserFillEvent = {
      orderId,
      status: status as UserFillEvent["status"],
      sizeMatched,
      price,
      tradeId,
      isMaker,
      tokenId,
      side,
      timestamp: Date.now(),
    };

    switch (status) {
      case "MATCHED":
        console.log(`[USER-WS] FILL: order=${orderId.slice(0, 12)} ${sizeMatched}@$${price.toFixed(3)}`);
        this.emit("fill", event);
        break;

      case "MINED":
        this.emit("mined", event);
        break;

      case "CONFIRMED":
        this.emit("confirmed", event);
        break;

      case "FAILED":
        console.warn(`[USER-WS] FAILED: order=${orderId.slice(0, 12)}`);
        logActivity("FILL_FAILED", `Order ${orderId} fill reverted on-chain`, { level: "error" });
        this.emit("failed", event);
        break;

      default:
        if (sizeMatched > 0) {
          console.log(`[USER-WS] Unknown status "${status}" for order ${orderId.slice(0, 12)}`);
          this.emit("fill", event);
        }
    }
  }

  private _isZombie(): boolean {
    if (this.lastMessageAt === 0) return false;
    return Date.now() - this.lastMessageAt > ZOMBIE_THRESHOLD_MS;
  }

  private _checkZombie(): void {
    if (!this.enabled || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this._isZombie()) {
      console.warn("[USER-WS] Zombie detected — no messages for 30s, reconnecting");
      logActivity("USER_WS", "Zombie detected, reconnecting", { level: "warning" });
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
      this._scheduleReconnect();
    }
  }

  private _scheduleReconnect(): void {
    if (!this.enabled || this.reconnecting) return;
    this.reconnecting = true;
    setTimeout(() => {
      this.reconnecting = false;
      if (this.enabled) this._connect();
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
export const userWs = new UserWebSocket();
