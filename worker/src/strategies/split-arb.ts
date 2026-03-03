/**
 * Split Arbitrage Strategy (modeled after 0x732F1 / Antique-Twig)
 *
 * 0x732F1's approach: aggressively BUY both sides of crypto "Up or Down" binary
 * markets whenever the combined ask price is < $1.00 after fees.  Hold to
 * resolution — one side pays $1.00, the other $0.00, guaranteeing the spread
 * as profit.
 *
 * Key observations from 0x732F1:
 *  - BUY-only, never sells — holds to automatic resolution
 *  - Sweeps existing asks in rapid bursts (50-100+ trades / minute)
 *  - Trades BTC, ETH, SOL, XRP on 5m, 15m, and hourly timeframes
 *  - Position sizes: 1,000-10,000 contracts per side per market
 *  - Profit margin ~1.1% on volume (thin edge, high throughput)
 *  - Fees on crypto markets use the formula:
 *    fee = price × rate × (price × (1 - price))^exponent
 *    charged on EACH side at purchase time (buys AND sells)
 */

import type {
  Strategy,
  StrategyContext,
  OrderBook,
} from "../strategy";
import { registerStrategy } from "../strategy";
import { calcFeePerShare, CRYPTO_FEES, type FeeParams } from "../categories";

// ── Types ────────────────────────────────────────────────────────────

interface CryptoMarket {
  title: string;
  slug: string;
  conditionId: string;
  endDate: string;
  upTokenId: string;
  downTokenId: string;
}

interface SplitPosition {
  market: CryptoMarket;
  upFilled: boolean;
  downFilled: boolean;
  upSize: number;
  downSize: number;
  upPrice: number;
  downPrice: number;
  combinedCost: number; // upPrice + downPrice per share
  netProfitPerShare: number;
  placedAt: string;
}

interface SplitArbParams {
  min_profit_per_share: number; // minimum net profit per share after fees (e.g. 0.005 = half a cent)
  order_size: number; // shares per side
  max_open_markets: number;
  max_capital_per_market: number;
  target_cryptos: string[];
  fee_params: FeeParams; // crypto: rate=0.25, exponent=2
  discovery_interval_ms: number;
}

const DEFAULT_PARAMS: SplitArbParams = {
  min_profit_per_share: 0.005,
  order_size: 50,
  max_open_markets: 10,
  max_capital_per_market: 100,
  target_cryptos: ["Bitcoin", "Ethereum", "Solana", "XRP"],
  fee_params: CRYPTO_FEES,
  discovery_interval_ms: 30_000,
};

// ── Fee Calculation ──────────────────────────────────────────────────
// Uses calcFeePerShare from ../categories (new formula)

/**
 * Calculate net profit from a split position.
 * Both fees are charged at purchase time (one on each side).
 * Payout is always $1.00 per share (one side wins).
 */
function calcSplitProfit(
  upPrice: number,
  downPrice: number,
  size: number,
  feeParams: FeeParams
): { combinedCost: number; totalFees: number; netProfitPerShare: number; netProfit: number } {
  const upFee = calcFeePerShare(upPrice, feeParams);
  const downFee = calcFeePerShare(downPrice, feeParams);
  const totalFees = (upFee + downFee) * size;

  const costPerShare = upPrice + downPrice + upFee + downFee;
  const netProfitPerShare = 1.0 - costPerShare;
  const netProfit = netProfitPerShare * size;

  return {
    combinedCost: (upPrice + downPrice) * size,
    totalFees,
    netProfitPerShare,
    netProfit,
  };
}

/**
 * Scan orderbook depth on both sides to find the best split opportunity.
 *
 * On Polymarket, the best ask on both sides of a binary market typically sums
 * to ~$1.00 (because they're the same liquidity mirrored). The arb opportunity
 * exists at LOWER price levels — e.g. resting limit orders where someone is
 * willing to sell Up at $0.25 and someone else sells Down at $0.45 = $0.70
 * combined.
 *
 * We scan all ask levels and find the combination where:
 *   upPrice + downPrice + fees < $1.00
 * with enough liquidity to fill our target size.
 */
interface SplitOpportunity {
  upPrice: number;
  downPrice: number;
  size: number; // fillable size at these prices
  netProfitPerShare: number;
  netProfit: number;
  totalFees: number;
}

function findBestSplit(
  upAsks: { price: number; size: number }[],
  downAsks: { price: number; size: number }[],
  targetSize: number,
  feeParams: FeeParams,
  minProfitPerShare: number
): SplitOpportunity | null {
  // Build cumulative liquidity for each side (sorted by price ascending)
  // For each price level, how many shares can we get at that price or better?
  const upLevels = [...upAsks].sort((a, b) => a.price - b.price);
  const downLevels = [...downAsks].sort((a, b) => a.price - b.price);

  let best: SplitOpportunity | null = null;

  // Try each combination of up and down ask levels.
  // Skip levels where upPrice + downPrice >= 1.0 (no possible arb).
  // Also skip very high prices (>0.90) — these are typically mirrored
  // liquidity from the other side's bids, not real sell interest.
  for (const upLevel of upLevels) {
    for (const downLevel of downLevels) {
      // Quick pre-check: raw prices must sum to < 1.0 for any chance of profit
      if (upLevel.price + downLevel.price >= 1.0) continue;

      const upFee = calcFeePerShare(upLevel.price, feeParams);
      const downFee = calcFeePerShare(downLevel.price, feeParams);
      const costPerShare = upLevel.price + downLevel.price + upFee + downFee;
      const netPerShare = 1.0 - costPerShare;

      if (netPerShare < minProfitPerShare) continue;

      // How many can we fill? Limited by available size at this level
      const fillable = Math.min(targetSize, upLevel.size, downLevel.size);
      if (fillable < 5) continue;

      const netProfit = netPerShare * fillable;

      if (!best || netProfit > best.netProfit) {
        best = {
          upPrice: upLevel.price,
          downPrice: downLevel.price,
          size: fillable,
          netProfitPerShare: netPerShare,
          netProfit,
          totalFees: (upFee + downFee) * fillable,
        };
      }
    }
  }

  return best;
}

// ── Market Discovery ─────────────────────────────────────────────────

async function discoverMarkets(
  cryptos: string[]
): Promise<CryptoMarket[]> {
  const markets: CryptoMarket[] = [];
  const seen = new Set<string>();

  try {
    // Fetch recent trades to find active crypto binary markets
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
      // Match "up or down" pattern in crypto markets
      if (!title.toLowerCase().includes("up or down")) continue;
      const matchesCrypto = cryptos.some((c) =>
        title.toLowerCase().includes(c.toLowerCase())
      );
      if (!matchesCrypto) continue;
      if (seen.has(eventSlug)) continue;
      seen.add(eventSlug);
      eventSlugs.add(eventSlug);
    }

    // Fetch market details from Gamma API
    // Do these in parallel for speed
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

          // Skip markets that are about to resolve (< 2 minutes)
          const timeToEnd = new Date(m.endDate).getTime() - Date.now();
          if (timeToEnd < 120_000) continue;

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

// ── Strategy Implementation ──────────────────────────────────────────

class SplitArbStrategy implements Strategy {
  name = "split-arb";
  private positions: SplitPosition[] = [];
  private marketCache: CryptoMarket[] = [];
  private lastDiscovery = 0;

  async init(ctx: StrategyContext): Promise<void> {
    this.positions =
      (ctx.state.custom.positions as SplitPosition[] | undefined) || [];
    ctx.log(
      `Initialized with ${this.positions.length} open split positions`
    );
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as SplitArbParams;

    // 1. Refresh market discovery periodically
    const now = Date.now();
    if (now - this.lastDiscovery > params.discovery_interval_ms) {
      this.marketCache = await discoverMarkets(params.target_cryptos);
      this.lastDiscovery = now;
      ctx.log(`Discovered ${this.marketCache.length} active crypto binary markets`);
    }

    // 2. Clean up resolved positions
    this.cleanupResolved(ctx);

    // 3. Scan for profitable splits and execute immediately
    const openCount = this.positions.length;
    if (openCount < params.max_open_markets) {
      await this.sweepProfitableSplits(
        ctx,
        params,
        params.max_open_markets - openCount
      );
    }

    // 4. Persist state
    ctx.state.custom.positions = this.positions;
    ctx.state.capital_deployed = this.positions.reduce(
      (sum, p) => sum + p.combinedCost,
      0
    );
  }

  async stop(ctx: StrategyContext): Promise<void> {
    // Split-arb holds to resolution — nothing to cancel
    // Just log the open positions
    ctx.log(
      `Stopped with ${this.positions.length} positions awaiting resolution`
    );
  }

  private cleanupResolved(ctx: StrategyContext): void {
    const now = Date.now();
    const toRemove: number[] = [];

    for (let i = 0; i < this.positions.length; i++) {
      const pos = this.positions[i];
      const endMs = new Date(pos.market.endDate).getTime();

      // If market has resolved (endDate has passed + 60s buffer), record the P&L
      if (now > endMs + 60_000) {
        // Both sides were filled — guaranteed $1 payout per share
        if (pos.upFilled && pos.downFilled) {
          ctx.state.total_pnl += pos.netProfitPerShare * Math.min(pos.upSize, pos.downSize);
          ctx.log(
            `RESOLVED: ${pos.market.title.slice(0, 50)} net=$${(pos.netProfitPerShare * Math.min(pos.upSize, pos.downSize)).toFixed(3)}`
          );
        } else {
          // Partial fill — one side is a naked directional bet
          const filledSide = pos.upFilled ? "UP" : pos.downFilled ? "DOWN" : "NONE";
          ctx.log(
            `RESOLVED (partial): ${pos.market.title.slice(0, 50)} only ${filledSide} filled — outcome unknown`
          );
        }
        toRemove.push(i);
      }
    }

    for (const idx of toRemove.reverse()) {
      this.positions.splice(idx, 1);
    }
  }

  /**
   * Core logic: scan all discovered markets, check orderbooks, and
   * aggressively sweep both sides if the split is profitable after fees.
   */
  private async sweepProfitableSplits(
    ctx: StrategyContext,
    params: SplitArbParams,
    slots: number
  ): Promise<void> {
    const activeMarketIds = new Set(
      this.positions.map((p) => p.market.conditionId)
    );

    let opened = 0;
    for (const market of this.marketCache) {
      if (opened >= slots) break;
      if (activeMarketIds.has(market.conditionId)) continue;

      // Check time to resolution — need enough time for orders to fill
      const timeToEnd = new Date(market.endDate).getTime() - Date.now();
      if (timeToEnd < 120_000) continue; // Skip if < 2 min left

      // Fetch orderbooks for both sides in parallel
      const [upBook, downBook] = await Promise.all([
        ctx.api.getBook(market.upTokenId),
        ctx.api.getBook(market.downTokenId),
      ]);

      // Need asks on both sides
      if (upBook.asks.length === 0 || downBook.asks.length === 0) continue;

      // Scan full orderbook depth for profitable split opportunities
      // The best ask on both sides typically sums to ~$1.00 (mirrored liquidity),
      // so we need to look at cheaper levels deeper in the book
      const opp = findBestSplit(
        upBook.asks,
        downBook.asks,
        params.order_size,
        params.fee_params,
        params.min_profit_per_share
      );

      // Log market conditions (but not every tick to reduce noise)
      const upBestAsk = upBook.asks[0].price;
      const downBestAsk = downBook.asks[0].price;
      if (opp) {
        ctx.log(
          `${market.title.slice(0, 40)}: SPLIT FOUND UP@${opp.upPrice.toFixed(2)}+DN@${opp.downPrice.toFixed(2)}=${(opp.upPrice + opp.downPrice).toFixed(3)} net/sh=${opp.netProfitPerShare.toFixed(4)} ${opp.size}sh avail`
        );
      } else {
        // Only log briefly — check if any sub-$1 ask pairs even exist
        const cheapUp = upBook.asks.filter(a => a.price < 0.90);
        const cheapDn = downBook.asks.filter(a => a.price < 0.90);
        if (cheapUp.length > 0 || cheapDn.length > 0) {
          const upMin = cheapUp.length > 0 ? cheapUp[0].price : upBestAsk;
          const dnMin = cheapDn.length > 0 ? cheapDn[0].price : downBestAsk;
          ctx.log(
            `${market.title.slice(0, 40)}: no arb (cheapest UP@${upMin.toFixed(2)}+DN@${dnMin.toFixed(2)}=${(upMin + dnMin).toFixed(3)})`
          );
        }
      }

      if (!opp) continue;

      // Check capital limits
      const totalCostWithFees = opp.size * (opp.upPrice + opp.downPrice) + opp.totalFees;
      if (totalCostWithFees > params.max_capital_per_market) continue;
      if (ctx.state.capital_deployed + totalCostWithFees > ctx.config.max_capital_usd) continue;

      // SWEEP: place aggressive market-taking orders on both sides at the arb prices
      const [upResult, downResult] = await Promise.all([
        ctx.api.placeOrder({
          token_id: market.upTokenId,
          side: "BUY",
          size: opp.size,
          price: opp.upPrice,
          market: market.slug,
          title: market.title,
        }),
        ctx.api.placeOrder({
          token_id: market.downTokenId,
          side: "BUY",
          size: opp.size,
          price: opp.downPrice,
          market: market.slug,
          title: market.title,
        }),
      ]);

      const upFilled = upResult.status === "filled";
      const downFilled = downResult.status === "filled";

      const position: SplitPosition = {
        market,
        upFilled,
        downFilled,
        upSize: opp.size,
        downSize: opp.size,
        upPrice: opp.upPrice,
        downPrice: opp.downPrice,
        combinedCost: opp.size * (opp.upPrice + opp.downPrice),
        netProfitPerShare: opp.netProfitPerShare,
        placedAt: new Date().toISOString(),
      };

      this.positions.push(position);
      opened++;

      const fillStatus = upFilled && downFilled
        ? "BOTH FILLED"
        : upFilled
          ? "UP only"
          : downFilled
            ? "DOWN only"
            : "NEITHER filled";

      ctx.log(
        `SPLIT OPENED: ${market.title.slice(0, 35)} ${opp.size}sh UP@${opp.upPrice}+DN@${opp.downPrice}=${(opp.upPrice + opp.downPrice).toFixed(3)} net=$${opp.netProfit.toFixed(3)} [${fillStatus}]`
      );

      // Record trade in D1
      const tradeId = `split-${Date.now()}-${opened}`;
      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
           VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'), ?)`
        )
        .bind(
          tradeId,
          ctx.config.id,
          market.conditionId,
          market.slug,
          market.title,
          opp.upPrice + opp.downPrice,
          opp.size,
          opp.totalFees,
          upFilled && downFilled ? opp.netProfit : 0
        )
        .run();

      // If only one side filled, log a warning — we have naked exposure
      if (upFilled !== downFilled) {
        ctx.log(
          `WARNING: Only ${upFilled ? "UP" : "DOWN"} side filled on ${market.title.slice(0, 40)} — naked directional exposure!`
        );
      }
    }
  }
}

// ── Register ─────────────────────────────────────────────────────────

registerStrategy("split-arb", () => new SplitArbStrategy());
