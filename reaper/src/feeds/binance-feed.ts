/**
 * Binance spot price feed — fetches BTC spot price via REST.
 * Simple and reliable. Used for P_true calculation.
 */

let priceCache = new Map<string, { price: number; fetchedAt: number }>();
const CACHE_TTL_MS = 2_000;

/** Fetch spot price from Binance. Cached for 2s. */
export async function fetchSpotPrice(symbol = "BTCUSDT"): Promise<number> {
  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.price;

  try {
    const resp = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    const data = await resp.json() as { price: string };
    const price = parseFloat(data.price);
    if (price > 0) {
      priceCache.set(symbol, { price, fetchedAt: Date.now() });
      return price;
    }
  } catch { /* fall through to Coinbase */ }

  // Fallback: Coinbase
  try {
    const pair = symbol.replace("USDT", "-USD");
    const resp = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`);
    const data = await resp.json() as { data: { amount: string } };
    const price = parseFloat(data.data.amount);
    if (price > 0) {
      priceCache.set(symbol, { price, fetchedAt: Date.now() });
      return price;
    }
  } catch { /* ignore */ }

  return cached?.price ?? 0;
}

/**
 * Calculate P_true — probability that BTC will be ABOVE the strike at window end.
 * Uses a CDF-based model with volatility scaling.
 */
export function calculatePTrue(
  spotPrice: number,
  strikePrice: number,
  timeRemainingMs: number,
  volatility5minPct = 0.20,
): number {
  if (timeRemainingMs <= 0) {
    return spotPrice >= strikePrice ? 0.99 : 0.01;
  }

  const pctFromStrike = (spotPrice - strikePrice) / strikePrice;
  const timeScale = Math.sqrt(Math.max(timeRemainingMs, 1000) / 300_000); // normalize to 5min
  const vol = Math.max(volatility5minPct, 0.10) / 100; // convert from pct to decimal
  const z = pctFromStrike / (vol * timeScale);

  // Standard normal CDF approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? Math.max(0.01, Math.min(0.99, 1 - p)) : Math.max(0.01, Math.min(0.99, p));
}

/** Estimate 5-minute volatility from price history. */
export function estimateVolatility(prices: number[]): number {
  if (prices.length < 5) return 0.20; // default
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  if (returns.length === 0) return 0.20;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.max(0.10, Math.sqrt(variance) * 100); // as percentage
}
