/**
 * Shared price feed and market discovery module.
 *
 * Provides live crypto spot prices from Binance, directional signal computation,
 * and market discovery for Polymarket "Up or Down" binary markets.
 * Used by directional-taker, directional-maker, and split-arb strategies.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface CryptoMarket {
  title: string;
  slug: string;
  conditionId: string;
  endDate: string;
  upTokenId: string;
  downTokenId: string;
}

export interface PriceSnapshot {
  symbol: string;
  price: number;
  timestamp: number; // epoch ms
  source: "binance" | "coinbase";
}

export interface WindowSignal {
  symbol: string;
  windowOpenPrice: number;
  currentPrice: number;
  priceChangePct: number; // (current - open) / open * 100
  direction: "UP" | "DOWN";
  signalStrength: number; // 0.0 to 1.0
  velocity: number; // pct change per second
  sampleCount: number;
  // Enhanced signal components (for logging/tuning)
  momentum: number; // -1 to +1: multi-window momentum confirmation
  acceleration: number; // is the move speeding up (+) or slowing down (-)?
  volatilityRegime: "low" | "normal" | "high"; // choppy vs trending
  confidenceMultiplier: number; // 0.5-1.5: scales conviction_multiplier based on regime
  // Order flow (when WebSocket enabled)
  orderFlowImbalance: number; // -1 to +1: net buy/sell pressure
  orderFlowAvailable: boolean;
  // Hysteresis
  rawDirection: "UP" | "DOWN"; // direction before dead zone filtering
  inDeadZone: boolean; // true when |priceChangePct| < dead zone threshold
}

// ── Binance Symbol Mapping ──────────────────────────────────────────

export const CRYPTO_SYMBOL_MAP: Record<string, string> = {
  bitcoin: "BTCUSDT",
  btc: "BTCUSDT",
  ethereum: "ETHUSDT",
  eth: "ETHUSDT",
  solana: "SOLUSDT",
  sol: "SOLUSDT",
  xrp: "XRPUSDT",
};

// Signal thresholds per asset (% move for full conviction)
export const SIGNAL_THRESHOLDS: Record<string, number> = {
  BTCUSDT: 0.15,
  ETHUSDT: 0.25,
  SOLUSDT: 0.25,
  XRPUSDT: 0.25,
};

// Dead zone defaults per asset (% — price must move this far to flip direction)
const DEAD_ZONE_DEFAULTS: Record<string, number> = {
  BTCUSDT: 0.02,
  ETHUSDT: 0.03,
  SOLUSDT: 0.03,
  XRPUSDT: 0.03,
};

export interface ComputeSignalOptions {
  deadZonePct?: number; // override per-asset dead zone default
  prevDirection?: "UP" | "DOWN" | null; // previous confirmed direction for hysteresis
}

/**
 * Extract Binance symbol from a Polymarket market title.
 * e.g. "Bitcoin Up or Down - March 3, 4:30AM-4:35AM ET" → "BTCUSDT"
 */
export function extractCryptoSymbol(title: string): string | null {
  const lower = title.toLowerCase();
  for (const [keyword, symbol] of Object.entries(CRYPTO_SYMBOL_MAP)) {
    if (lower.includes(keyword)) return symbol;
  }
  return null;
}

// ── Price Fetching ──────────────────────────────────────────────────

const priceCache = new Map<string, { snapshot: PriceSnapshot; ts: number }>();
const CACHE_TTL_MS = 1000; // avoid redundant fetches when multiple strategies tick

/**
 * Fetch current spot price from Binance (free, no auth).
 * Caches for 500ms per symbol.
 */
export async function fetchSpotPrice(
  symbol: string
): Promise<PriceSnapshot | null> {
  const now = Date.now();
  const cached = priceCache.get(symbol);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.snapshot;

  try {
    const resp = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
    );
    if (!resp.ok) return fallbackCoinbase(symbol);
    const data = (await resp.json()) as { symbol: string; price: string };
    const price = parseFloat(data.price);
    if (isNaN(price) || price <= 0) return fallbackCoinbase(symbol);
    const snapshot: PriceSnapshot = {
      symbol,
      price,
      timestamp: now,
      source: "binance",
    };
    priceCache.set(symbol, { snapshot, ts: now });
    return snapshot;
  } catch {
    return fallbackCoinbase(symbol);
  }
}

async function fallbackCoinbase(symbol: string): Promise<PriceSnapshot | null> {
  // Map BTCUSDT → BTC-USD for Coinbase
  const pair = symbol.replace("USDT", "-USD");
  try {
    const resp = await fetch(
      `https://api.coinbase.com/v2/prices/${pair}/spot`
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      data: { amount: string; currency: string };
    };
    const price = parseFloat(data.data.amount);
    if (isNaN(price) || price <= 0) return null;
    const now = Date.now();
    const snapshot: PriceSnapshot = {
      symbol,
      price,
      timestamp: now,
      source: "coinbase",
    };
    priceCache.set(symbol, { snapshot, ts: now });
    return snapshot;
  } catch {
    return null;
  }
}

// ── Signal Computation ──────────────────────────────────────────────

/**
 * Compute directional signal from window open price vs current.
 *
 * Uses three layers of analysis (all from existing price history):
 * 1. Raw magnitude: how far has price moved from window open?
 * 2. Multi-window momentum: are 5s, 15s, and 30s slopes all agreeing?
 * 3. Volatility regime: is the market choppy (reduce sizing) or trending (increase)?
 *
 * signalStrength is 0-1, incorporating all three layers.
 * confidenceMultiplier scales the strategy's conviction_multiplier.
 */
export function computeSignal(
  symbol: string,
  windowOpenPrice: number,
  currentPrice: number,
  elapsedMs: number,
  priceHistory: PriceSnapshot[],
  options?: ComputeSignalOptions
): WindowSignal {
  const priceChangePct =
    ((currentPrice - windowOpenPrice) / windowOpenPrice) * 100;
  const threshold = SIGNAL_THRESHOLDS[symbol] ?? 0.15;
  const elapsedSec = Math.max(1, elapsedMs / 1000);
  const velocity = priceChangePct / elapsedSec;

  // ── Layer 1: Raw magnitude ──────────────────────────────────────
  const rawStrength = Math.min(1.0, Math.abs(priceChangePct) / threshold);

  // ── Layer 2: Multi-window momentum confirmation ─────────────────
  // Check if 5s, 15s, and 30s lookback windows all agree on direction.
  // More confirming windows → stronger signal. Disagreement → weaker.
  let momentum = 0; // -1 to +1
  const now = priceHistory.length > 0
    ? priceHistory[priceHistory.length - 1].timestamp
    : Date.now();

  const lookbacks = [5_000, 15_000, 30_000]; // 5s, 15s, 30s
  let confirmingWindows = 0;
  let totalWindows = 0;

  for (const lb of lookbacks) {
    const cutoff = now - lb;
    const older = priceHistory.find((s) => s.timestamp >= cutoff);
    if (!older) continue;
    totalWindows++;
    const lbChangePct =
      ((currentPrice - older.price) / older.price) * 100;
    // Does this window agree with the overall direction?
    if (
      (priceChangePct >= 0 && lbChangePct >= 0) ||
      (priceChangePct < 0 && lbChangePct < 0)
    ) {
      confirmingWindows++;
    }
  }
  if (totalWindows > 0) {
    // 3/3 confirming = +1.0, 2/3 = +0.33, 1/3 = -0.33, 0/3 = -1.0
    momentum = (2 * confirmingWindows - totalWindows) / totalWindows;
  }

  // Momentum bonus: +0.15 when all windows confirm, -0.1 when they disagree
  const momentumBonus = momentum > 0.5 ? 0.15 : momentum < -0.5 ? -0.1 : 0;

  // ── Layer 3: Acceleration ──────────────────────────────────────
  // Is the move speeding up or slowing down?
  // Compare velocity of recent 5s vs previous 5s
  let acceleration = 0;
  if (priceHistory.length >= 4) {
    const recent = priceHistory.slice(-2);
    const prior = priceHistory.slice(-4, -2);
    if (recent.length >= 2 && prior.length >= 2) {
      const recentVel =
        ((recent[1].price - recent[0].price) / recent[0].price) * 100;
      const priorVel =
        ((prior[1].price - prior[0].price) / prior[0].price) * 100;
      acceleration = recentVel - priorVel;
    }
  }
  // Acceleration bonus: move is speeding up in the same direction
  const accelBonus =
    priceChangePct >= 0
      ? acceleration > 0 ? 0.05 : acceleration < -0.001 ? -0.05 : 0
      : acceleration < 0 ? 0.05 : acceleration > 0.001 ? -0.05 : 0;

  // ── Layer 4: Volatility regime ─────────────────────────────────
  // Compute recent volatility from sample-to-sample returns.
  // High vol (choppy) → reduce confidence. Low vol (trending) → boost.
  let volatilityRegime: "low" | "normal" | "high" = "normal";
  let confidenceMultiplier = 1.0;

  if (priceHistory.length >= 5) {
    const returns: number[] = [];
    for (let i = 1; i < priceHistory.length; i++) {
      returns.push(
        Math.abs(
          (priceHistory[i].price - priceHistory[i - 1].price) /
            priceHistory[i - 1].price
        ) * 100
      );
    }
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    // Count direction changes (how choppy is it?)
    let dirChanges = 0;
    for (let i = 2; i < priceHistory.length; i++) {
      const prev = priceHistory[i - 1].price - priceHistory[i - 2].price;
      const curr = priceHistory[i].price - priceHistory[i - 1].price;
      if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) dirChanges++;
    }
    const choppiness = dirChanges / Math.max(1, priceHistory.length - 2);

    if (choppiness > 0.6 || avgReturn > threshold * 0.5) {
      // Choppy: many direction changes or high average move per tick
      volatilityRegime = "high";
      confidenceMultiplier = 0.6; // reduce overweight in choppy markets
    } else if (choppiness < 0.3 && avgReturn < threshold * 0.2) {
      // Trending steadily with low tick-to-tick noise
      volatilityRegime = "low";
      confidenceMultiplier = 1.3; // increase overweight in smooth trends
    }
  }

  // ── Layer 5: Order flow (when WebSocket enabled) ────────────────
  // If Binance aggTrade stream is connected, use buy/sell volume
  // imbalance as a leading indicator.
  const flow = getOrderFlowSignal(symbol);
  let orderFlowBonus = 0;
  if (flow.available && flow.tradeCount10s >= 5) {
    // Order flow confirms direction → bonus
    // Order flow contradicts → penalty
    const flowDirection = flow.imbalance10s >= 0 ? "UP" : "DOWN";
    const priceDirection = priceChangePct >= 0 ? "UP" : "DOWN";
    const flowMagnitude = Math.min(1.0, Math.abs(flow.imbalance10s));

    if (flowDirection === priceDirection) {
      // Flow confirms price direction — strong bonus scaled by imbalance magnitude
      orderFlowBonus = 0.15 * flowMagnitude;
    } else {
      // Flow contradicts price — divergence warning, reduce confidence
      orderFlowBonus = -0.1 * flowMagnitude;
    }

    // Also adjust confidence multiplier based on sustained flow
    if (flow.tradeCount30s >= 20) {
      const flow30Dir = flow.imbalance30s >= 0 ? "UP" : "DOWN";
      if (flow30Dir === priceDirection && Math.abs(flow.imbalance30s) > 0.3) {
        // Strong sustained flow in same direction
        confidenceMultiplier = Math.min(1.5, confidenceMultiplier * 1.2);
      } else if (flow30Dir !== priceDirection && Math.abs(flow.imbalance30s) > 0.3) {
        // Strong sustained flow against price — likely reversal
        confidenceMultiplier = Math.max(0.4, confidenceMultiplier * 0.7);
      }
    }
  }

  // ── Combine ────────────────────────────────────────────────────
  // Consistency bonus (legacy): last 3 samples all same direction
  let consistencyBonus = 0;
  if (priceHistory.length >= 3) {
    const last3 = priceHistory.slice(-3);
    const allUp = last3.every((s) => s.price >= windowOpenPrice);
    const allDown = last3.every((s) => s.price < windowOpenPrice);
    if (allUp || allDown) consistencyBonus = 0.1;
  }

  const signalStrength = Math.max(
    0,
    Math.min(1.0, rawStrength + consistencyBonus + momentumBonus + accelBonus + orderFlowBonus)
  );

  // ── Dead zone hysteresis ─────────────────────────────────────────
  const rawDirection: "UP" | "DOWN" = priceChangePct >= 0 ? "UP" : "DOWN";
  const deadZone = options?.deadZonePct ?? DEAD_ZONE_DEFAULTS[symbol] ?? 0.03;
  const inDeadZone = Math.abs(priceChangePct) < deadZone;
  // When inside dead zone: stick to previous confirmed direction (or fall back to raw)
  const direction: "UP" | "DOWN" = inDeadZone && options?.prevDirection
    ? options.prevDirection
    : rawDirection;

  return {
    symbol,
    windowOpenPrice,
    currentPrice,
    priceChangePct,
    direction,
    signalStrength,
    velocity,
    sampleCount: priceHistory.length,
    momentum,
    acceleration,
    volatilityRegime,
    confidenceMultiplier,
    orderFlowImbalance: flow.imbalance10s,
    orderFlowAvailable: flow.available,
    rawDirection,
    inDeadZone,
  };
}

// ── Trade Tape (for grounded paper fills) ───────────────────────────

export interface TradeTapeEntry {
  asset: string;    // token ID
  price: number;
  size: number;
  timestamp: number; // epoch ms
}

let tradeTapeCache: TradeTapeEntry[] = [];
let tradeTapeLastFetch = 0;
const TRADE_TAPE_TTL = 4_000; // just under 5s tick interval

/**
 * Fetch recent trades from Polymarket Data API.
 * Shared across all strategies — one fetch per tick via 4s cache.
 */
export async function fetchTradeTape(): Promise<TradeTapeEntry[]> {
  const now = Date.now();
  if (now - tradeTapeLastFetch < TRADE_TAPE_TTL) return tradeTapeCache;
  try {
    const resp = await fetch("https://data-api.polymarket.com/trades?limit=200");
    if (!resp.ok) return tradeTapeCache;
    const raw = await resp.json() as Array<{
      asset?: string; price?: number; size?: number; timestamp?: number;
    }>;
    tradeTapeCache = raw
      .filter(t => t.asset && t.price != null && t.size != null && t.timestamp)
      .map(t => ({
        asset: t.asset!,
        price: t.price!,
        size: t.size!,
        timestamp: t.timestamp! < 1e12 ? t.timestamp! * 1000 : t.timestamp!,
      }));
    tradeTapeLastFetch = now;
  } catch { /* keep stale cache */ }
  return tradeTapeCache;
}

/**
 * Check if a resting BUY at bidPrice would have filled, based on observed trades.
 * Sums volume of all tape trades on this token at price <= bidPrice.
 * Only fills when accumulated volume >= bidSize (realistic depth check).
 * Returns fill at bidPrice (maker semantics: resting order gets its price).
 */
export function checkTapeFill(
  tape: TradeTapeEntry[],
  tokenId: string,
  bidPrice: number,
  bidSize: number,
): { filled: boolean; fillPrice: number } {
  let volumeAtOrBelow = 0;
  for (const t of tape) {
    if (t.asset === tokenId && t.price <= bidPrice) {
      volumeAtOrBelow += t.size;
      if (volumeAtOrBelow >= bidSize) {
        return { filled: true, fillPrice: bidPrice };
      }
    }
  }
  return { filled: false, fillPrice: 0 };
}

// ── Market Discovery ────────────────────────────────────────────────

/**
 * Discover active "Up or Down" crypto binary markets from Polymarket.
 * Refactored from split-arb.ts to be shared across strategies.
 */
export async function discoverCryptoMarkets(
  cryptos: string[],
  minTimeToEnd = 120_000
): Promise<CryptoMarket[]> {
  const markets: CryptoMarket[] = [];
  const seen = new Set<string>();

  try {
    const resp = await fetch(
      "https://data-api.polymarket.com/trades?limit=200"
    );
    if (!resp.ok) return markets;
    const trades = (await resp.json()) as Array<{
      title?: string;
      eventSlug?: string;
    }>;

    const eventSlugs = new Set<string>();
    for (const t of trades) {
      const title = t.title || "";
      const eventSlug = t.eventSlug || "";
      if (!eventSlug) continue;
      if (!title.toLowerCase().includes("up or down")) continue;
      const matchesCrypto = cryptos.some((c) =>
        title.toLowerCase().includes(c.toLowerCase())
      );
      if (!matchesCrypto) continue;
      if (seen.has(eventSlug)) continue;
      seen.add(eventSlug);
      eventSlugs.add(eventSlug);
    }

    const slugArray = Array.from(eventSlugs);
    const eventResponses = await Promise.allSettled(
      slugArray.map(async (slug) => {
        const evResp = await fetch(
          `https://gamma-api.polymarket.com/events?slug=${slug}`
        );
        if (!evResp.ok) return [];
        return (await evResp.json()) as Array<{
          title: string;
          markets: Array<{
            question: string;
            slug: string;
            conditionId: string;
            endDate: string;
            closed: boolean;
            clobTokenIds: string;
            outcomes: string;
          }>;
        }>;
      })
    );

    for (const result of eventResponses) {
      if (result.status !== "fulfilled") continue;
      for (const ev of result.value) {
        for (const m of ev.markets) {
          if (m.closed) continue;
          const outcomes = JSON.parse(m.outcomes || "[]") as string[];
          const tokens = JSON.parse(m.clobTokenIds || "[]") as string[];
          if (outcomes.length !== 2 || tokens.length !== 2) continue;

          const upIdx = outcomes.findIndex(
            (o) => o.toLowerCase() === "up" || o.toLowerCase() === "yes"
          );
          const downIdx = outcomes.findIndex(
            (o) => o.toLowerCase() === "down" || o.toLowerCase() === "no"
          );
          if (upIdx === -1 || downIdx === -1) continue;

          const timeToEnd = new Date(m.endDate).getTime() - Date.now();
          if (timeToEnd < minTimeToEnd) continue;

          markets.push({
            title: m.question,
            slug: m.slug,
            conditionId: m.conditionId,
            endDate: m.endDate,
            upTokenId: tokens[upIdx],
            downTokenId: tokens[downIdx],
          });
        }
      }
    }
  } catch {
    // Discovery failure — return empty
  }

  return markets;
}

// ── Market Resolution Verification ──────────────────────────────────

export interface MarketResolution {
  closed: boolean;
  outcome: "UP" | "DOWN" | null; // null if not yet resolved
  outcomePrices: number[]; // [upPrice, downPrice]
}

/**
 * Check if a Polymarket market has resolved and what the outcome was.
 * Fetches from Gamma API by slug, checks outcomePrices to determine winner.
 */
export async function checkMarketResolution(
  slug: string,
  upTokenId: string,
  downTokenId: string
): Promise<MarketResolution> {
  const empty: MarketResolution = { closed: false, outcome: null, outcomePrices: [] };
  try {
    const resp = await fetch(
      `https://gamma-api.polymarket.com/markets?slug=${slug}`
    );
    if (!resp.ok) return empty;
    const markets = (await resp.json()) as Array<{
      closed: boolean;
      outcomePrices: string;
      outcomes: string;
      clobTokenIds: string;
    }>;
    if (markets.length === 0) return empty;
    const m = markets[0];
    if (!m.closed) return { closed: false, outcome: null, outcomePrices: [] };

    const prices = JSON.parse(m.outcomePrices || "[]") as number[];
    const tokens = JSON.parse(m.clobTokenIds || "[]") as string[];
    if (prices.length < 2 || tokens.length < 2) {
      return { closed: true, outcome: null, outcomePrices: prices };
    }

    const upIdx = tokens.indexOf(upTokenId);
    const downIdx = tokens.indexOf(downTokenId);
    if (upIdx === -1 || downIdx === -1) {
      return { closed: true, outcome: null, outcomePrices: prices };
    }

    const upPrice = prices[upIdx];
    const downPrice = prices[downIdx];

    let outcome: "UP" | "DOWN" | null = null;
    if (upPrice >= 0.99) outcome = "UP";
    else if (downPrice >= 0.99) outcome = "DOWN";

    return { closed: true, outcome, outcomePrices: [upPrice, downPrice] };
  } catch {
    return empty;
  }
}

// ── Binance WebSocket Order Flow (local dev only) ────────────────────
//
// Connects to Binance aggTrade stream to get real-time buy/sell volume.
// Only works when explicitly enabled (local dev) — Cloudflare Workers
// can't maintain outbound WebSocket clients across requests in production.
//
// Usage: call enableOrderFlow(["BTCUSDT","ETHUSDT"]) once at startup.
// Then getOrderFlowSignal("BTCUSDT") returns the current imbalance.

interface AggTrade {
  symbol: string;
  price: number;
  quantity: number;
  isBuyerMaker: boolean; // true = seller-initiated (taker sell), false = buyer-initiated (taker buy)
  timestamp: number;
}

interface OrderFlowBucket {
  buyVolume: number;
  sellVolume: number;
  trades: AggTrade[];
}

export interface OrderFlowSignal {
  symbol: string;
  buyVolume10s: number;
  sellVolume10s: number;
  buyVolume30s: number;
  sellVolume30s: number;
  imbalance10s: number; // -1 to +1: (buy - sell) / (buy + sell)
  imbalance30s: number;
  tradeCount10s: number;
  tradeCount30s: number;
  available: boolean;
}

const orderFlowData = new Map<string, AggTrade[]>();
let orderFlowEnabled = false;
const orderFlowSockets = new Map<string, WebSocket>();
const ORDER_FLOW_RETENTION_MS = 60_000; // keep 60s of trades

/**
 * Enable order flow tracking for the given symbols.
 * Connects to Binance aggTrade WebSocket streams.
 * Call once — subsequent calls with new symbols will add connections.
 */
export function enableOrderFlow(symbols: string[]): void {
  orderFlowEnabled = true;

  for (const symbol of symbols) {
    const lower = symbol.toLowerCase();
    if (orderFlowSockets.has(symbol)) continue;

    try {
      const ws = new WebSocket(
        `wss://stream.binance.com:9443/ws/${lower}@aggTrade`
      );

      ws.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(
            typeof event.data === "string" ? event.data : ""
          ) as {
            s: string; // symbol
            p: string; // price
            q: string; // quantity
            m: boolean; // is buyer maker
            T: number; // trade time
          };

          const trade: AggTrade = {
            symbol: data.s,
            price: parseFloat(data.p),
            quantity: parseFloat(data.q),
            isBuyerMaker: data.m,
            timestamp: data.T,
          };

          if (!orderFlowData.has(symbol)) orderFlowData.set(symbol, []);
          const trades = orderFlowData.get(symbol)!;
          trades.push(trade);

          // Also update price cache from WS (faster than REST)
          const snapshot: PriceSnapshot = {
            symbol,
            price: trade.price,
            timestamp: Date.now(),
            source: "binance",
          };
          priceCache.set(symbol, { snapshot, ts: Date.now() });

          // Prune old trades
          const cutoff = Date.now() - ORDER_FLOW_RETENTION_MS;
          while (trades.length > 0 && trades[0].timestamp < cutoff) {
            trades.shift();
          }
        } catch {
          // Ignore parse errors
        }
      });

      ws.addEventListener("error", () => {
        // Will attempt to use REST fallback
      });

      ws.addEventListener("close", () => {
        orderFlowSockets.delete(symbol);
        // Auto-reconnect after 5s if still enabled
        if (orderFlowEnabled) {
          setTimeout(() => {
            if (orderFlowEnabled) enableOrderFlow([symbol]);
          }, 5_000);
        }
      });

      orderFlowSockets.set(symbol, ws);
    } catch {
      // WebSocket not available (production Workers) — silently skip
    }
  }
}

/**
 * Disable order flow tracking and close all WebSocket connections.
 */
export function disableOrderFlow(): void {
  orderFlowEnabled = false;
  for (const [symbol, ws] of orderFlowSockets) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    orderFlowSockets.delete(symbol);
  }
  orderFlowData.clear();
}

/**
 * Get the current order flow signal for a symbol.
 * Returns buy/sell volume imbalance over 10s and 30s windows.
 *
 * imbalance > 0 = net buying pressure (bullish)
 * imbalance < 0 = net selling pressure (bearish)
 */
export function getOrderFlowSignal(symbol: string): OrderFlowSignal {
  const empty: OrderFlowSignal = {
    symbol,
    buyVolume10s: 0, sellVolume10s: 0,
    buyVolume30s: 0, sellVolume30s: 0,
    imbalance10s: 0, imbalance30s: 0,
    tradeCount10s: 0, tradeCount30s: 0,
    available: false,
  };

  if (!orderFlowEnabled) return empty;
  const trades = orderFlowData.get(symbol);
  if (!trades || trades.length === 0) return empty;

  const now = Date.now();
  const cutoff10 = now - 10_000;
  const cutoff30 = now - 30_000;

  let buy10 = 0, sell10 = 0, count10 = 0;
  let buy30 = 0, sell30 = 0, count30 = 0;

  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (t.timestamp < cutoff30) break;

    const vol = t.price * t.quantity; // USD volume
    if (t.isBuyerMaker) {
      // buyer is maker → taker is selling
      sell30 += vol;
    } else {
      // buyer is taker → aggressive buying
      buy30 += vol;
    }
    count30++;

    if (t.timestamp >= cutoff10) {
      if (t.isBuyerMaker) sell10 += vol;
      else buy10 += vol;
      count10++;
    }
  }

  const total10 = buy10 + sell10;
  const total30 = buy30 + sell30;

  return {
    symbol,
    buyVolume10s: buy10,
    sellVolume10s: sell10,
    buyVolume30s: buy30,
    sellVolume30s: sell30,
    imbalance10s: total10 > 0 ? (buy10 - sell10) / total10 : 0,
    imbalance30s: total30 > 0 ? (buy30 - sell30) / total30 : 0,
    tradeCount10s: count10,
    tradeCount30s: count30,
    available: count30 > 0,
  };
}

/**
 * Check if order flow data is available and fresh for a symbol.
 */
export function hasOrderFlow(symbol: string): boolean {
  if (!orderFlowEnabled) return false;
  const trades = orderFlowData.get(symbol);
  if (!trades || trades.length === 0) return false;
  // Check if last trade is within 5 seconds
  return Date.now() - trades[trades.length - 1].timestamp < 5_000;
}

// ── Parse Window Duration ────────────────────────────────────────────

/**
 * Parse the window duration from a market title.
 * "Bitcoin Up or Down - March 3, 4:30AM-4:35AM ET" → 300000 (5 min)
 * Falls back to 300000 if unparseable.
 */
export function parseWindowDurationMs(title: string): number {
  // Look for time range like "4:30AM-4:35AM" or "4:30PM-4:35PM"
  const match = title.match(
    /(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)/i
  );
  if (!match) return 300_000;

  let startH = parseInt(match[1]);
  const startM = parseInt(match[2]);
  const startAmPm = match[3].toUpperCase();
  let endH = parseInt(match[4]);
  const endM = parseInt(match[5]);
  const endAmPm = match[6].toUpperCase();

  if (startAmPm === "PM" && startH !== 12) startH += 12;
  if (startAmPm === "AM" && startH === 12) startH = 0;
  if (endAmPm === "PM" && endH !== 12) endH += 12;
  if (endAmPm === "AM" && endH === 12) endH = 0;

  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  const diffMin = endMin - startMin;

  if (diffMin > 0 && diffMin <= 60) return diffMin * 60_000;
  return 300_000; // default 5 min
}
