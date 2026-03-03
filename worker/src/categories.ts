// Fee params by market type (from docs.polymarket.com/trading/fees)
// Formula: fee_per_share = price × rate × (price × (1 - price))^exponent
export interface FeeParams {
  rate: number;
  exponent: number;
}

export const CRYPTO_FEES: FeeParams = { rate: 0.25, exponent: 2 };
export const SPORTS_FEES: FeeParams = { rate: 0.0175, exponent: 1 };

// Keywords that indicate a fee-bearing crypto market (checked against title AND slug)
const CRYPTO_FEE_KEYWORDS = [
  // Slug patterns
  "btc-updown",
  "eth-updown",
  "sol-updown",
  "updown",
  // Title patterns
  "up or down",
  "bitcoin above",
  "ethereum above",
];

// Keywords that indicate a fee-bearing sports market
const SPORTS_FEE_KEYWORDS = [
  "ncaab",
  "ncaa basketball",
  "march madness",
  "serie a",
];

/**
 * Determine fee params for a market based on its title/slug.
 * Returns null if the market has no fees.
 */
export function getMarketFeeParams(titleOrSlug: string): FeeParams | null {
  if (!titleOrSlug) return CRYPTO_FEES; // Default: assume crypto fees when unknown
  const lower = titleOrSlug.toLowerCase();
  if (CRYPTO_FEE_KEYWORDS.some((kw) => lower.includes(kw))) return CRYPTO_FEES;
  if (SPORTS_FEE_KEYWORDS.some((kw) => lower.includes(kw))) return SPORTS_FEES;
  return null;
}

/**
 * New fee formula: fee_per_share = price × rate × (price × (1 - price))^exponent
 */
export function calcFeePerShare(price: number, params: FeeParams): number {
  return price * params.rate * Math.pow(price * (1 - price), params.exponent);
}

// ── CLOB API fee rate fetching (cached) ──────────────────────────────

const feeRateCache = new Map<string, { rate: number; ts: number }>();
const FEE_RATE_CACHE_TTL = 3600_000; // 1 hour

/**
 * Fetch the base fee rate from the CLOB API for a given token ID.
 * Returns the rate as a decimal (e.g. 1000 bps → 0.10).
 * Cached for 1 hour per token.
 */
export async function fetchFeeRateFromApi(tokenId: string): Promise<number> {
  const now = Date.now();
  const cached = feeRateCache.get(tokenId);
  if (cached && now - cached.ts < FEE_RATE_CACHE_TTL) return cached.rate;

  try {
    const resp = await fetch(
      `https://clob.polymarket.com/fee-rate?token_id=${encodeURIComponent(tokenId)}`,
    );
    if (resp.ok) {
      const data = (await resp.json()) as { base_fee?: number };
      const bps = data.base_fee ?? 0;
      const rate = bps / 10_000;
      feeRateCache.set(tokenId, { rate, ts: now });
      return rate;
    }
  } catch {
    // Fall through to return 0
  }
  return 0;
}

// ── Backward-compat aliases (deprecated) ─────────────────────────────

/** @deprecated Use CRYPTO_FEES.rate with calcFeePerShare() instead */
export const DEFAULT_FEE_RATE = 0.0625;

/** @deprecated Use getMarketFeeParams() instead */
export function marketHasFees(titleOrSlug: string): boolean {
  return getMarketFeeParams(titleOrSlug) !== null;
}
