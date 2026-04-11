/**
 * Oracle Price Feed — Chainlink Data Streams (authenticated) + RTDS fallback.
 *
 * Two-layer architecture:
 *   1. Chainlink SDK (authenticated, direct) — primary when env vars present
 *   2. Polymarket RTDS (public WebSocket) — automatic fallback
 *
 * Polymarket resolves 5-minute crypto markets against Chainlink, so using
 * this feed gives ZERO basis risk — P_true uses the exact settlement price.
 *
 * PUBLIC API (unchanged — no consumers need modification):
 *   enableOracleFeed(binanceSymbols)  / disableOracleFeed()
 *   getOracleSpot(binanceSymbol)      → OracleTick | null
 *   getOracleStrike(binanceSymbol, eventStartTimeMs) → number | null
 *   getOracleHistory(binanceSymbol, sinceMs?) → OracleTick[]
 *   isOracleConnected()               → boolean
 *   toRtdsSymbol(binanceSymbol)       → string | null
 *
 * LOCAL DEV ONLY: Cloudflare Workers cannot maintain persistent outbound
 * WebSocket connections. The dynamic import of the SDK fails gracefully in CF.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface OracleTick {
  symbol: string;   // "btc/usd", "eth/usd", etc.
  price: number;
  bid?: number;     // V3 reports include bid/ask
  ask?: number;
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

// Subscribed symbols (in RTDS format: "btc/usd")
const subscribedSymbols = new Set<string>();

let oracleEnabled = false;
let lastMessageAt = 0;

// Chainlink SDK state
let chainlinkStream: { close(): Promise<void> } | null = null;
let chainlinkConnected = false;
// Map: binanceSymbol (e.g. "BTCUSDT") → feedId (hex)
const feedIdMap = new Map<string, string>();
// Map: feedId → { rtdsSymbol, decimals }
const feedMeta = new Map<string, { rtdsSymbol: string; decimals: number }>();

// RTDS fallback state
let rtdsSocket: WebSocket | null = null;
let rtdsReconnecting = false;
let rtdsPingInterval: ReturnType<typeof setInterval> | null = null;

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

// Well-known Chainlink Data Streams feed IDs (mainnet, V3 crypto, 18 decimals)
// Source: https://data.chain.link/streams
const KNOWN_FEED_IDS: Record<string, { binanceSymbol: string; rtdsSymbol: string; decimals: number }> = {
  "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8": { binanceSymbol: "BTCUSDT", rtdsSymbol: "btc/usd", decimals: 18 },
  "0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9": { binanceSymbol: "ETHUSDT", rtdsSymbol: "eth/usd", decimals: 18 },
  "0x0003b778d3f6b2ac4991302b89cb313f99a42467d6c9c5f96f57c29c0d2bc24f": { binanceSymbol: "SOLUSDT", rtdsSymbol: "sol/usd", decimals: 18 },
  "0x0003c16c6aed42294f5cb4741f6e59ba2d728f0eae2eb9e6d3f555808c59fc45": { binanceSymbol: "XRPUSDT", rtdsSymbol: "xrp/usd", decimals: 18 },
  "0x000356ca64d3b32135e17dc0dc721a645bf50d0303be8ceb2cdca0a50bab8fdc": { binanceSymbol: "DOGEUSDT", rtdsSymbol: "doge/usd", decimals: 18 },
  "0x0003b1cb55b8a00a18111ff745b56d70f04c2d41e03fc7fd8d3d9b09f142aad9": { binanceSymbol: "AVAXUSDT", rtdsSymbol: "avax/usd", decimals: 18 },
  "0x00036d7a1251e3f67d6658466b5e9e7fe8418af7feac9567ff322bff95cc2401": { binanceSymbol: "LINKUSDT", rtdsSymbol: "link/usd", decimals: 18 },
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start the oracle feed. Tries Chainlink SDK first (if env vars present),
 * falls back to Polymarket RTDS.
 * @param binanceSymbols - Array of Binance-format symbols (e.g., ["BTCUSDT", "ETHUSDT"])
 */
export function enableOracleFeed(binanceSymbols: string[]): void {
  if (oracleEnabled) {
    addSubscriptions(binanceSymbols);
    return;
  }
  oracleEnabled = true;
  addSubscriptions(binanceSymbols);

  // Try Chainlink SDK (async, non-blocking)
  connectChainlink().catch(() => {
    // Chainlink unavailable — fall through to RTDS
  });

  // Always start RTDS as fallback (it's free and provides coverage while SDK connects)
  connectRtds();
}

export function disableOracleFeed(): void {
  oracleEnabled = false;
  cleanupChainlink();
  cleanupRtds();
  oraclePrices.clear();
  subscribedSymbols.clear();
  feedIdMap.clear();
  feedMeta.clear();
}

/**
 * Get the latest oracle (Chainlink) spot price for a symbol.
 * Returns null if no recent data or feed is stale.
 */
export function getOracleSpot(binanceSymbol: string): OracleTick | null {
  const rtdsSymbol = BINANCE_TO_RTDS[binanceSymbol.toUpperCase()];
  if (!rtdsSymbol) return null;

  const ticks = oraclePrices.get(rtdsSymbol);
  if (!ticks || ticks.length === 0) return null;

  const latest = ticks[ticks.length - 1];
  if (Date.now() - latest.timestamp > STALENESS_THRESHOLD_MS) return null;
  return latest;
}

/**
 * Capture the oracle strike price at a specific eventStartTime.
 * The first tick where timestamp >= eventStartTime becomes the immutable strike.
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
  if (!oracleEnabled) return false;

  // Chainlink SDK connected?
  if (chainlinkConnected && lastMessageAt > 0 &&
      Date.now() - lastMessageAt <= STALENESS_THRESHOLD_MS) {
    return true;
  }

  // RTDS fallback connected?
  if (rtdsSocket?.readyState === WebSocket.OPEN &&
      lastMessageAt > 0 && Date.now() - lastMessageAt <= STALENESS_THRESHOLD_MS) {
    return true;
  }

  return false;
}

/**
 * Which feed source is active?
 * "chainlink" = authenticated SDK, "rtds" = public Polymarket relay, "none"
 */
export function getOracleSource(): "chainlink" | "rtds" | "none" {
  if (chainlinkConnected && lastMessageAt > 0 &&
      Date.now() - lastMessageAt <= STALENESS_THRESHOLD_MS) {
    return "chainlink";
  }
  if (rtdsSocket?.readyState === WebSocket.OPEN &&
      lastMessageAt > 0 && Date.now() - lastMessageAt <= STALENESS_THRESHOLD_MS) {
    return "rtds";
  }
  return "none";
}

/**
 * Convert Binance symbol to RTDS Chainlink symbol.
 * "BTCUSDT" → "btc/usd"
 */
export function toRtdsSymbol(binanceSymbol: string): string | null {
  return BINANCE_TO_RTDS[binanceSymbol.toUpperCase()] ?? null;
}

// ── Subscription Management ──────────────────────────────────────────

function addSubscriptions(binanceSymbols: string[]): void {
  for (const sym of binanceSymbols) {
    const rtds = BINANCE_TO_RTDS[sym.toUpperCase()];
    if (rtds) subscribedSymbols.add(rtds);
  }
  // If RTDS socket is open, resend subscription
  if (rtdsSocket?.readyState === WebSocket.OPEN) {
    sendRtdsSubscription();
  }
}

// ── Shared Tick Ingestion ────────────────────────────────────────────

function ingestTick(tick: OracleTick): void {
  lastMessageAt = Date.now();

  if (!oraclePrices.has(tick.symbol)) oraclePrices.set(tick.symbol, []);
  const ticks = oraclePrices.get(tick.symbol)!;
  ticks.push(tick);

  // Prune old ticks
  const cutoff = Date.now() - PRICE_RETENTION_MS;
  while (ticks.length > 0 && ticks[0].timestamp < cutoff) {
    ticks.shift();
  }

  // Check if any pending strike captures can be resolved
  for (const [key, capture] of strikeCaptures.entries()) {
    if (capture.locked) continue;
    if (!key.startsWith(tick.symbol + "-")) continue;
    const eventStartMs = parseInt(key.split("-").pop()!);
    if (tick.timestamp >= eventStartMs) {
      capture.price = tick.price;
      capture.timestamp = tick.timestamp;
      capture.locked = true;
    }
  }
}

// ── Layer 1: Chainlink SDK (authenticated) ───────────────────────────

async function connectChainlink(): Promise<void> {
  const apiKey = process.env.CHAINLINK_USER_ID;
  const userSecret = process.env.CHAINLINK_USER_SECRET;

  if (!apiKey || !userSecret) {
    console.log("[ORACLE] No Chainlink credentials — using RTDS fallback");
    return;
  }

  // Dynamic import — fails gracefully in CF Workers (no Node.js crypto/ws)
  let sdk: typeof import("@chainlink/data-streams-sdk");
  try {
    sdk = await import("@chainlink/data-streams-sdk");
  } catch (e) {
    console.log("[ORACLE] Chainlink SDK not available (CF Worker?) — using RTDS fallback");
    return;
  }

  try {
    const client = sdk.createClient({
      apiKey,
      userSecret,
      endpoint: "https://api.dataengine.chain.link",
      wsEndpoint: "wss://ws.dataengine.chain.link",
      logging: {
        logger: {
          info: (msg: string) => console.log(`[CHAINLINK] ${msg}`),
          error: (msg: string) => console.error(`[CHAINLINK] ${msg}`),
        },
        logLevel: sdk.LogLevel.INFO,
      },
    });

    // Match known feed IDs to our subscribed symbols
    const targetFeedIds: string[] = [];
    for (const [fid, meta] of Object.entries(KNOWN_FEED_IDS)) {
      if (!subscribedSymbols.has(meta.rtdsSymbol)) continue;
      feedIdMap.set(meta.binanceSymbol, fid);
      feedMeta.set(fid, { rtdsSymbol: meta.rtdsSymbol, decimals: meta.decimals });
      targetFeedIds.push(fid);
    }

    if (targetFeedIds.length === 0) {
      console.log("[ORACLE] No matching Chainlink feeds for subscribed symbols — using RTDS fallback");
      return;
    }

    console.log(`[ORACLE] Chainlink feeds matched: ${targetFeedIds.length}`);
    for (const [sym, fid] of feedIdMap) {
      console.log(`  ${sym} → ${fid.slice(0, 20)}...`);
    }

    // Create and connect stream
    const stream = client.createStream(targetFeedIds, {
      maxReconnectAttempts: 100,
      reconnectInterval: 2000,
    });

    stream.on("report", (report) => {
      handleChainlinkReport(report, sdk);
    });

    stream.on("error", (err) => {
      console.error("[ORACLE] Chainlink stream error:", err.message);
    });

    stream.on("disconnected", () => {
      console.log("[ORACLE] Chainlink disconnected");
      chainlinkConnected = false;
    });

    stream.on("reconnecting", (info) => {
      console.log(`[ORACLE] Chainlink reconnecting (attempt ${info.attempt})...`);
    });

    await stream.connect();
    chainlinkStream = stream;
    chainlinkConnected = true;
    console.log("[ORACLE] Chainlink connected — authenticated direct feed active");
  } catch (e) {
    console.error("[ORACLE] Chainlink connection failed:", e instanceof Error ? e.message : String(e));
    chainlinkConnected = false;
  }
}

function handleChainlinkReport(
  report: { feedID: string; fullReport: string; observationsTimestamp: number },
  sdk: typeof import("@chainlink/data-streams-sdk"),
): void {
  const meta = feedMeta.get(report.feedID);
  if (!meta) return;

  try {
    const decoded = sdk.decodeReport(report.fullReport, report.feedID);
    if (!("price" in decoded)) return;

    const divisor = 10 ** meta.decimals;
    const price = Number(decoded.price) / divisor;
    if (price <= 0 || !isFinite(price)) return;

    const tick: OracleTick = {
      symbol: meta.rtdsSymbol,
      price,
      timestamp: report.observationsTimestamp * 1000,
    };

    // V3 crypto reports include bid/ask
    if ("bid" in decoded && "ask" in decoded) {
      tick.bid = Number(decoded.bid) / divisor;
      tick.ask = Number(decoded.ask) / divisor;
    }

    ingestTick(tick);
    chainlinkConnected = true;
  } catch {
    // Decode failure — skip this report
  }
}

function cleanupChainlink(): void {
  if (chainlinkStream) {
    chainlinkStream.close().catch(() => {});
    chainlinkStream = null;
  }
  chainlinkConnected = false;
}

// ── Layer 2: Polymarket RTDS (public fallback) ───────────────────────

function connectRtds(): void {
  if (rtdsReconnecting) return;
  cleanupRtds();

  try {
    rtdsSocket = new WebSocket(RTDS_URL);

    rtdsSocket.addEventListener("open", () => {
      console.log("[ORACLE-RTDS] Connected to Polymarket RTDS (fallback)");
      lastMessageAt = Date.now();
      sendRtdsSubscription();
      rtdsPingInterval = setInterval(() => {
        if (rtdsSocket?.readyState === WebSocket.OPEN) {
          rtdsSocket.send("PING");
        }
      }, PING_INTERVAL_MS);
    });

    rtdsSocket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (raw === "PONG" || raw === "") return;
      try {
        handleRtdsMessage(JSON.parse(raw));
      } catch {
        // Ignore parse errors
      }
    });

    rtdsSocket.addEventListener("close", () => {
      console.log("[ORACLE-RTDS] Disconnected");
      scheduleRtdsReconnect();
    });

    rtdsSocket.addEventListener("error", () => {
      scheduleRtdsReconnect();
    });
  } catch {
    scheduleRtdsReconnect();
  }
}

function scheduleRtdsReconnect(): void {
  if (!oracleEnabled || rtdsReconnecting) return;
  rtdsReconnecting = true;
  setTimeout(() => {
    rtdsReconnecting = false;
    if (oracleEnabled) connectRtds();
  }, RECONNECT_DELAY_MS);
}

function cleanupRtds(): void {
  if (rtdsPingInterval) { clearInterval(rtdsPingInterval); rtdsPingInterval = null; }
  if (rtdsSocket) {
    try { rtdsSocket.close(); } catch { /* ignore */ }
    rtdsSocket = null;
  }
}

function sendRtdsSubscription(): void {
  if (!rtdsSocket || rtdsSocket.readyState !== WebSocket.OPEN) return;

  rtdsSocket.send(JSON.stringify({
    action: "subscribe",
    subscriptions: [{ topic: "crypto_prices_chainlink", type: "*" }],
  }));

  console.log(`[ORACLE-RTDS] Subscribed to all Chainlink prices (tracking: ${Array.from(subscribedSymbols).join(", ")})`);
}

// ── RTDS Message Handling ────────────────────────────────────────────

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

function handleRtdsMessage(msg: RtdsMessage): void {
  if (msg.topic !== "crypto_prices_chainlink") return;
  if (msg.type !== "update" || !msg.payload) return;

  const { symbol, timestamp, value } = msg.payload;
  if (!symbol || !value || value <= 0) return;

  // Only track symbols we're interested in
  if (!subscribedSymbols.has(symbol)) return;

  // If Chainlink SDK is active and fresh, skip RTDS ticks (avoid duplicates)
  if (chainlinkConnected && lastMessageAt > 0 &&
      Date.now() - lastMessageAt <= STALENESS_THRESHOLD_MS) {
    return;
  }

  const ts = timestamp ?? msg.timestamp ?? Date.now();
  ingestTick({ symbol, price: value, timestamp: ts });
}
