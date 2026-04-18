/**
 * Gamma API client — market metadata + resolution status (pure TS, no Python needed).
 *
 * Endpoints used:
 *   GET https://gamma-api.polymarket.com/markets?slug=<slug>
 *     → returns market including `closed`, `outcomePrices`, `outcomes`
 */

export interface MarketResolution {
  closed: boolean;
  outcome: "UP" | "DOWN" | null;
  resolution_source?: string;
}

const GAMMA_API = "https://gamma-api.polymarket.com";

interface GammaMarket {
  slug: string;
  closed: boolean;
  outcomes?: string;        // JSON string of outcome labels
  outcomePrices?: string;   // JSON string of prices like "[1.0,0.0]" after resolution
  endDateIso?: string;
  clobTokenIds?: string;    // JSON string of token IDs
}

/**
 * Check if a Polymarket market is resolved and which side won.
 * Returns { closed: false, outcome: null } for active markets.
 */
export async function checkMarketResolution(slug: string): Promise<MarketResolution> {
  try {
    const resp = await fetch(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`);
    if (!resp.ok) return { closed: false, outcome: null };

    const data = await resp.json() as GammaMarket | GammaMarket[];
    const market = Array.isArray(data) ? data[0] : data;
    if (!market) return { closed: false, outcome: null };

    if (!market.closed) return { closed: false, outcome: null };

    // Parse outcomePrices to determine winner
    // Format: "[1.0,0.0]" where [0]=UP price, [1]=DOWN price (1.0 = won, 0.0 = lost)
    // Or for YES/NO: "[1.0,0.0]" where [0]=YES, [1]=NO
    let outcome: "UP" | "DOWN" | null = null;
    if (market.outcomePrices) {
      try {
        const prices = JSON.parse(market.outcomePrices) as Array<string | number>;
        const [upPrice, dnPrice] = prices.map(p => typeof p === "string" ? parseFloat(p) : p);
        if (upPrice >= 0.99) outcome = "UP";
        else if (dnPrice >= 0.99) outcome = "DOWN";
      } catch { /* leave null */ }
    }

    return { closed: true, outcome, resolution_source: "gamma-api" };
  } catch {
    return { closed: false, outcome: null };
  }
}
