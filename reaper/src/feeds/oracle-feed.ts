/**
 * Oracle Feed — Chainlink price via Polymarket RTDS WebSocket.
 *
 * Provides:
 * - Real-time oracle spot prices for BTC, ETH, SOL
 * - Oracle strike prices at window open time
 *
 * Falls back to Binance if oracle not connected.
 */

import WebSocket from "ws";
import { logActivity } from "../db.js";

const RTDS_URL = "wss://ws-live-data.polymarket.com";
const RECONNECT_DELAY_MS = 5_000;

interface OraclePrice {
  symbol: string;  // "btc/usd", "eth/usd", "sol/usd"
  price: number;
  timestamp: number;
}

// Module state
const oraclePrices = new Map<string, OraclePrice>();
const strikeCaptures = new Map<string, number>(); // windowOpenTime → strike price
let ws: WebSocket | null = null;
let enabled = false;
let reconnecting = false;
let lastMessageAt = 0;

// Symbol mapping: Binance → Oracle
const ORACLE_SYMBOLS: Record<string, string> = {
  BTCUSDT: "btc/usd",
  ETHUSDT: "eth/usd",
  SOLUSDT: "sol/usd",
};

/** Enable the oracle feed. */
export function enableOracleFeed(): void {
  if (enabled) return;
  enabled = true;
  connect();
}

export function disableOracleFeed(): void {
  enabled = false;
  cleanup();
}

/** Get the latest oracle spot price for a symbol. */
export function getOracleSpot(binanceSymbol: string): { price: number; timestamp: number } | null {
  const oracleSymbol = ORACLE_SYMBOLS[binanceSymbol];
  if (!oracleSymbol) return null;
  const entry = oraclePrices.get(oracleSymbol);
  if (!entry) return null;
  // Stale check: if >30s old, don't trust it
  if (Date.now() - entry.timestamp > 30_000) return null;
  return { price: entry.price, timestamp: entry.timestamp };
}

/** Get or capture the oracle strike price at a window open time. */
export function getOracleStrike(binanceSymbol: string, windowOpenTimeMs: number): number | null {
  const key = `${binanceSymbol}-${windowOpenTimeMs}`;
  const cached = strikeCaptures.get(key);
  if (cached) return cached;

  // Try to capture from current oracle price if we're near the window open time
  const now = Date.now();
  if (Math.abs(now - windowOpenTimeMs) < 10_000) {
    const spot = getOracleSpot(binanceSymbol);
    if (spot) {
      strikeCaptures.set(key, spot.price);
      return spot.price;
    }
  }

  return null;
}

/** Manually set a strike price (e.g., from Gamma API or price at open). */
export function setOracleStrike(binanceSymbol: string, windowOpenTimeMs: number, strike: number): void {
  const key = `${binanceSymbol}-${windowOpenTimeMs}`;
  strikeCaptures.set(key, strike);
}

export function isOracleConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt < 10_000;
}

// ── Connection ─────────────────────────────────────────────────────

function connect(): void {
  if (reconnecting || !enabled) return;
  cleanup();

  try {
    ws = new WebSocket(RTDS_URL);

    ws.on("open", () => {
      console.log("[ORACLE] Connected to Polymarket RTDS");
      lastMessageAt = Date.now();

      // Subscribe to Chainlink price feeds
      ws!.send(JSON.stringify({
        type: "subscribe",
        channel: "chainlink",
        assets: Object.values(ORACLE_SYMBOLS),
      }));
    });

    ws.on("message", (data: Buffer | string) => {
      lastMessageAt = Date.now();
      const raw = typeof data === "string" ? data : data.toString();
      if (raw === "PONG" || raw === "") return;

      try {
        const msg = JSON.parse(raw);
        handleMessage(msg);
      } catch { /* ignore parse errors */ }
    });

    ws.on("close", () => {
      console.log("[ORACLE] Disconnected");
      scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      console.error("[ORACLE] Error:", err.message);
      scheduleReconnect();
    });

    // Ping every 10s
    setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send("PING");
    }, 10_000);
  } catch (err) {
    console.error("[ORACLE] Failed to connect:", err);
    scheduleReconnect();
  }
}

function handleMessage(msg: Record<string, unknown>): void {
  // RTDS sends price updates for Chainlink feeds
  // Format varies — extract asset and price
  const asset = (msg.asset as string) || (msg.pair as string) || "";
  const price = parseFloat(String(msg.price || msg.answer || 0));

  if (asset && price > 0) {
    oraclePrices.set(asset.toLowerCase(), {
      symbol: asset.toLowerCase(),
      price,
      timestamp: Date.now(),
    });
  }
}

function scheduleReconnect(): void {
  if (!enabled || reconnecting) return;
  reconnecting = true;
  setTimeout(() => {
    reconnecting = false;
    if (enabled) connect();
  }, RECONNECT_DELAY_MS);
}

function cleanup(): void {
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
}
