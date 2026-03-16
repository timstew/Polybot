/**
 * Scalp Market Making Strategy (modeled after hue8883 / Gloomy-Pilgrim)
 *
 * hue8883's approach: active BUY+SELL scalping on BTC 5-minute "Up or Down"
 * markets.  They post bids below mid, get filled, then sell into strength when
 * the price moves up — capturing the bid-ask spread on high volume.
 *
 * Key observations from hue8883:
 *  - Exclusively BTC 5-minute binary markets
 *  - 40-90+ trades per 5-minute window, executing every 2-6 seconds
 *  - Buys AND sells within the same window (not buy-and-hold)
 *  - Market-making oscillation: buy low, sell high within the spread
 *  - Near expiry, scoops the winning side at very low prices (penny scooping)
 *  - +$4,645 all-time but recently losing — fees (6.25%) eat thin spreads
 *
 * IMPORTANT: A CF Worker ticking every 5s cannot replicate true HFT scalping.
 * This implementation captures the core concept: post resting bids below mid,
 * sell inventory when profitable, and manage risk by exiting before resolution.
 *
 * Fees on crypto markets use the formula:
 *   fee = price × rate × (price × (1 - price))^exponent
 * charged on both BUYs and SELLs.
 */

import type {
  Strategy,
  StrategyContext,
  OrderBook,
} from "../strategy";
import { registerStrategy } from "../strategy";
import { calcFeePerShare, CRYPTO_FEES, type FeeParams } from "../categories";

// ── Types ────────────────────────────────────────────────────────────

interface MarketInfo {
  title: string;
  slug: string;
  conditionId: string;
  endDate: string;
  upTokenId: string;
  downTokenId: string;
}

interface InventoryPosition {
  tokenId: string;
  side: "up" | "down";
  size: number;
  avgCostBasis: number; // average price paid per share including fees
}

interface ScalpState {
  market: MarketInfo;
  inventory: InventoryPosition[];
  pendingBuyOrderId: string | null;
  pendingBuyTokenId: string | null;
  pendingBuyPrice: number;
  pendingBuySize: number;
  pendingSellOrderId: string | null;
  pendingSellTokenId: string | null;
  pendingSellPrice: number;
  pendingSellSize: number;
  totalBuys: number;
  totalSells: number;
  realizedPnl: number;
  placedAt: string;
}

interface ScalpMMParams {
  bid_offset: number; // how far below mid to post bids (e.g. 0.03)
  sell_profit_target: number; // minimum profit per share to sell (e.g. 0.02)
  order_size: number;
  max_inventory_per_side: number;
  max_open_markets: number;
  max_capital_usd: number;
  min_spread: number; // minimum book spread to trade (e.g. 0.04)
  exit_before_ms: number; // dump inventory this long before resolution
  fee_params: FeeParams;
  discovery_interval_ms: number;
}

const DEFAULT_PARAMS: ScalpMMParams = {
  bid_offset: 0.03,
  sell_profit_target: 0.02,
  order_size: 20,
  max_inventory_per_side: 100,
  max_open_markets: 3,
  max_capital_usd: 200,
  min_spread: 0.04,
  exit_before_ms: 30_000,
  fee_params: CRYPTO_FEES,
  discovery_interval_ms: 30_000,
};

// ── Helpers ──────────────────────────────────────────────────────────
// Fee calculation uses calcFeePerShare from ../categories

function getMid(book: OrderBook): number | null {
  if (book.bids.length === 0 || book.asks.length === 0) return null;
  return (book.bids[0].price + book.asks[0].price) / 2;
}

function getSpread(book: OrderBook): number {
  if (book.bids.length === 0 || book.asks.length === 0) return 0;
  return book.asks[0].price - book.bids[0].price;
}

// ── Market Discovery (BTC 5-minute only, matching hue8883) ───────────

async function discoverBtc5mMarkets(): Promise<MarketInfo[]> {
  const markets: MarketInfo[] = [];
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
      const title = (t.title || "").toLowerCase();
      const eventSlug = t.eventSlug || "";
      if (!eventSlug) continue;
      // hue8883 only trades Bitcoin 5-minute markets
      if (!title.includes("bitcoin") && !title.includes("btc")) continue;
      if (!title.includes("up or down")) continue;
      if (seen.has(eventSlug)) continue;
      seen.add(eventSlug);
      eventSlugs.add(eventSlug);
    }

    const slugArray = Array.from(eventSlugs);
    const results = await Promise.allSettled(
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

    for (const result of results) {
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
          if (timeToEnd < 60_000) continue; // Too close to resolution

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
    // Discovery failure
  }

  // Sort by endDate ascending — trade the soonest-expiring first
  markets.sort(
    (a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
  );

  return markets;
}

// ── Strategy Implementation ──────────────────────────────────────────

class ScalpMMStrategy implements Strategy {
  name = "passive-mm";
  private scalps: ScalpState[] = [];
  private marketCache: MarketInfo[] = [];
  private lastDiscovery = 0;

  async init(ctx: StrategyContext): Promise<void> {
    this.scalps =
      (ctx.state.custom.scalps as ScalpState[] | undefined) || [];
    ctx.log(`Initialized with ${this.scalps.length} active scalp positions`);
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const params = { ...DEFAULT_PARAMS, ...ctx.config.params } as ScalpMMParams;

    // 1. Refresh market discovery
    const now = Date.now();
    if (now - this.lastDiscovery > params.discovery_interval_ms) {
      this.marketCache = await discoverBtc5mMarkets();
      this.lastDiscovery = now;
      ctx.log(`Discovered ${this.marketCache.length} active BTC binary markets`);
    }

    // 2. Manage existing scalps: check fills, sell inventory, exit expiring
    await this.manageScalps(ctx, params);

    // 3. Enter new markets
    const activeCount = this.scalps.length;
    if (activeCount < params.max_open_markets) {
      await this.enterNewMarkets(
        ctx,
        params,
        params.max_open_markets - activeCount
      );
    }

    // 4. Persist state
    ctx.state.custom.scalps = this.scalps;
    ctx.state.capital_deployed = this.scalps.reduce((sum, s) => {
      return (
        sum +
        s.inventory.reduce((iSum, inv) => iSum + inv.size * inv.avgCostBasis, 0)
      );
    }, 0);
    ctx.state.total_pnl = this.scalps.reduce(
      (sum, s) => sum + s.realizedPnl,
      0
    );
  }

  async stop(ctx: StrategyContext): Promise<void> {
    for (const s of this.scalps) {
      if (s.pendingBuyOrderId) await ctx.api.cancelOrder(s.pendingBuyOrderId);
      if (s.pendingSellOrderId) await ctx.api.cancelOrder(s.pendingSellOrderId);
    }
    ctx.log(
      `Stopped — cancelled all pending orders. ${this.scalps.reduce((sum, s) => sum + s.inventory.length, 0)} inventory positions remain.`
    );
  }

  private async manageScalps(
    ctx: StrategyContext,
    params: ScalpMMParams
  ): Promise<void> {
    const now = Date.now();
    const toRemove: number[] = [];

    for (let i = 0; i < this.scalps.length; i++) {
      const s = this.scalps[i];
      const endMs = new Date(s.market.endDate).getTime();
      const timeToEnd = endMs - now;

      // Exit before resolution — cancel orders and dump inventory
      if (timeToEnd < params.exit_before_ms) {
        if (s.pendingBuyOrderId) {
          await ctx.api.cancelOrder(s.pendingBuyOrderId);
          s.pendingBuyOrderId = null;
        }
        if (s.pendingSellOrderId) {
          await ctx.api.cancelOrder(s.pendingSellOrderId);
          s.pendingSellOrderId = null;
        }

        // Dump remaining inventory at market
        for (const inv of s.inventory) {
          if (inv.size <= 0) continue;
          const book = await ctx.api.getBook(inv.tokenId);
          const bestBid = book.bids.length > 0 ? book.bids[0].price : 0;
          if (bestBid > 0) {
            const result = await ctx.api.placeOrder({
              token_id: inv.tokenId,
              side: "SELL",
              size: inv.size,
              price: bestBid,
              market: s.market.slug,
              title: s.market.title + ` [${inv.side.toUpperCase()} exit]`,
            });
            if (result.status === "filled") {
              const pnl = (bestBid - inv.avgCostBasis) * inv.size;
              s.realizedPnl += pnl;
              s.totalSells++;
              ctx.log(
                `EXIT SELL ${inv.side.toUpperCase()}: ${s.market.title.slice(0, 40)} ${inv.size}@${bestBid.toFixed(2)} pnl=$${pnl.toFixed(3)}`
              );
              inv.size = 0;
            }
          }
        }

        // Log and remove
        ctx.log(
          `Exiting ${s.market.title.slice(0, 40)}: ${s.totalBuys} buys, ${s.totalSells} sells, realized=$${s.realizedPnl.toFixed(3)}`
        );
        toRemove.push(i);
        continue;
      }

      // Remove if market has passed
      if (now > endMs + 30_000) {
        toRemove.push(i);
        continue;
      }

      // Check for pending buy fill
      if (s.pendingBuyOrderId && s.pendingBuyTokenId) {
        const book = await ctx.api.getBook(s.pendingBuyTokenId);
        // In paper mode, check if best ask is at or below our buy price
        const bestAsk = book.asks.length > 0 ? book.asks[0].price : Infinity;
        if (bestAsk <= s.pendingBuyPrice) {
          // Filled! Update inventory
          const side = s.pendingBuyTokenId === s.market.upTokenId ? "up" : "down";
          const fee = calcFeePerShare(s.pendingBuyPrice, params.fee_params);
          const costBasis = s.pendingBuyPrice + fee;

          let inv = s.inventory.find(
            (p) => p.tokenId === s.pendingBuyTokenId
          );
          if (inv) {
            const totalCost = inv.avgCostBasis * inv.size + costBasis * s.pendingBuySize;
            inv.size += s.pendingBuySize;
            inv.avgCostBasis = totalCost / inv.size;
          } else {
            inv = {
              tokenId: s.pendingBuyTokenId!,
              side,
              size: s.pendingBuySize,
              avgCostBasis: costBasis,
            };
            s.inventory.push(inv);
          }

          s.totalBuys++;
          ctx.log(
            `BUY FILL ${side.toUpperCase()}: ${s.market.title.slice(0, 40)} ${s.pendingBuySize}@${s.pendingBuyPrice.toFixed(3)} (cost=${costBasis.toFixed(3)}) inv=${inv.size}`
          );

          // Record in D1
          await ctx.db
            .prepare(
              `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp)
               VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, datetime('now'))`
            )
            .bind(
              `scalp-buy-${Date.now()}`,
              ctx.config.id,
              s.pendingBuyTokenId,
              s.market.slug,
              s.market.title + ` [${side.toUpperCase()}]`,
              s.pendingBuyPrice,
              s.pendingBuySize,
              fee * s.pendingBuySize
            )
            .run();

          s.pendingBuyOrderId = null;
          s.pendingBuyTokenId = null;
        }
      }

      // Check for pending sell fill
      if (s.pendingSellOrderId && s.pendingSellTokenId) {
        const book = await ctx.api.getBook(s.pendingSellTokenId);
        const bestBid = book.bids.length > 0 ? book.bids[0].price : 0;
        if (bestBid >= s.pendingSellPrice) {
          // Filled! Reduce inventory
          const inv = s.inventory.find(
            (p) => p.tokenId === s.pendingSellTokenId
          );
          if (inv) {
            const pnl = (s.pendingSellPrice - inv.avgCostBasis) * s.pendingSellSize;
            inv.size -= s.pendingSellSize;
            s.realizedPnl += pnl;
            s.totalSells++;
            ctx.log(
              `SELL FILL ${inv.side.toUpperCase()}: ${s.market.title.slice(0, 40)} ${s.pendingSellSize}@${s.pendingSellPrice.toFixed(3)} pnl=$${pnl.toFixed(3)} inv=${inv.size}`
            );

            // Record in D1 (sell fees apply too)
            const sellFee = calcFeePerShare(s.pendingSellPrice, params.fee_params) * s.pendingSellSize;
            await ctx.db
              .prepare(
                `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
                 VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
              )
              .bind(
                `scalp-sell-${Date.now()}`,
                ctx.config.id,
                s.pendingSellTokenId,
                s.market.slug,
                s.market.title + ` [${inv.side.toUpperCase()}]`,
                s.pendingSellPrice,
                s.pendingSellSize,
                sellFee,
                pnl
              )
              .run();
          }
          s.pendingSellOrderId = null;
          s.pendingSellTokenId = null;
        }
      }

      // Place new buy orders if we have capacity and no pending buy
      if (!s.pendingBuyOrderId) {
        await this.placeBuyOrder(ctx, s, params);
      }

      // Sell inventory if profitable and no pending sell
      if (!s.pendingSellOrderId) {
        await this.placeSellOrder(ctx, s, params);
      }
    }

    for (const idx of toRemove.reverse()) {
      this.scalps.splice(idx, 1);
    }
  }

  private async placeBuyOrder(
    ctx: StrategyContext,
    s: ScalpState,
    params: ScalpMMParams
  ): Promise<void> {
    // Pick the side with less inventory to stay balanced
    const upInv = s.inventory.find((p) => p.side === "up");
    const downInv = s.inventory.find((p) => p.side === "down");
    const upSize = upInv?.size || 0;
    const downSize = downInv?.size || 0;

    // Buy the side with less inventory (or up if equal)
    const targetSide = downSize < upSize ? "down" : "up";
    const targetTokenId =
      targetSide === "up" ? s.market.upTokenId : s.market.downTokenId;

    const currentInv = targetSide === "up" ? upSize : downSize;
    if (currentInv >= params.max_inventory_per_side) return;

    // Global capital check
    const capitalDeployed = this.scalps.reduce((sum, sc) =>
      sum + sc.inventory.reduce((iSum, inv) => iSum + inv.size * inv.avgCostBasis, 0), 0
    );
    if (capitalDeployed > ctx.config.max_capital_usd) return;

    const book = await ctx.api.getBook(targetTokenId);
    const mid = getMid(book);
    const spread = getSpread(book);
    if (mid === null || spread < params.min_spread) return;

    // Post bid below mid
    const bidPrice = Math.max(0.01, mid - params.bid_offset);
    const roundedBid = Math.floor(bidPrice * 100) / 100;

    // Check that we can be profitable after fees
    const fee = calcFeePerShare(roundedBid, params.fee_params);
    const breakeven = roundedBid + fee + params.sell_profit_target;
    const bestAsk = book.asks.length > 0 ? book.asks[0].price : Infinity;
    // Only bid if the current ask is above our breakeven (there's room to sell profitably)
    if (bestAsk < breakeven) return;

    const result = await ctx.api.placeOrder({
      token_id: targetTokenId,
      side: "BUY",
      size: params.order_size,
      price: roundedBid,
      market: s.market.slug,
      title: s.market.title + ` [${targetSide.toUpperCase()}]`,
    });

    if (result.status === "filled") {
      // Immediate fill — update inventory directly
      const costBasis = roundedBid + fee;
      let inv = s.inventory.find((p) => p.tokenId === targetTokenId);
      if (inv) {
        const totalCost = inv.avgCostBasis * inv.size + costBasis * params.order_size;
        inv.size += params.order_size;
        inv.avgCostBasis = totalCost / inv.size;
      } else {
        inv = {
          tokenId: targetTokenId,
          side: targetSide,
          size: params.order_size,
          avgCostBasis: costBasis,
        };
        s.inventory.push(inv);
      }
      s.totalBuys++;
      ctx.log(
        `BUY (immediate): ${targetSide.toUpperCase()} ${params.order_size}@${roundedBid} cost=${costBasis.toFixed(3)}`
      );
    } else if (result.status === "placed") {
      s.pendingBuyOrderId = result.order_id;
      s.pendingBuyTokenId = targetTokenId;
      s.pendingBuyPrice = roundedBid;
      s.pendingBuySize = params.order_size;
    }
  }

  private async placeSellOrder(
    ctx: StrategyContext,
    s: ScalpState,
    params: ScalpMMParams
  ): Promise<void> {
    // Find inventory we can sell profitably
    for (const inv of s.inventory) {
      if (inv.size <= 0) continue;

      const book = await ctx.api.getBook(inv.tokenId);
      if (book.bids.length === 0) continue;

      const bestBid = book.bids[0].price;
      const profitPerShare = bestBid - inv.avgCostBasis;

      if (profitPerShare >= params.sell_profit_target) {
        const sellSize = Math.min(inv.size, params.order_size);
        const result = await ctx.api.placeOrder({
          token_id: inv.tokenId,
          side: "SELL",
          size: sellSize,
          price: bestBid,
          market: s.market.slug,
          title: s.market.title + ` [${inv.side.toUpperCase()} sell]`,
        });

        if (result.status === "filled") {
          const pnl = profitPerShare * sellSize;
          inv.size -= sellSize;
          s.realizedPnl += pnl;
          s.totalSells++;
          ctx.log(
            `SELL (immediate): ${inv.side.toUpperCase()} ${sellSize}@${bestBid.toFixed(3)} pnl=$${pnl.toFixed(3)}`
          );

          const immSellFee = calcFeePerShare(bestBid, params.fee_params) * sellSize;
          await ctx.db
            .prepare(
              `INSERT OR IGNORE INTO strategy_trades (id, strategy_id, token_id, market, title, side, price, size, fee_amount, timestamp, pnl)
               VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, datetime('now'), ?)`
            )
            .bind(
              `scalp-sell-${Date.now()}`,
              ctx.config.id,
              inv.tokenId,
              s.market.slug,
              s.market.title + ` [${inv.side.toUpperCase()}]`,
              bestBid,
              sellSize,
              immSellFee,
              pnl
            )
            .run();
        } else if (result.status === "placed") {
          s.pendingSellOrderId = result.order_id;
          s.pendingSellTokenId = inv.tokenId;
          s.pendingSellPrice = bestBid;
          s.pendingSellSize = sellSize;
        }
        break; // One sell order at a time
      }
    }
  }

  private async enterNewMarkets(
    ctx: StrategyContext,
    params: ScalpMMParams,
    slots: number
  ): Promise<void> {
    const activeConditions = new Set(
      this.scalps.map((s) => s.market.conditionId)
    );

    // Global capital check: total cost of all inventory across all scalps
    const capitalDeployed = this.scalps.reduce((sum, s) =>
      sum + s.inventory.reduce((iSum, inv) => iSum + inv.size * inv.avgCostBasis, 0), 0
    );

    let opened = 0;
    for (const market of this.marketCache) {
      if (opened >= slots) break;
      if (activeConditions.has(market.conditionId)) continue;

      // Capital limit check
      if (capitalDeployed > ctx.config.max_capital_usd) break;

      const timeToEnd = new Date(market.endDate).getTime() - Date.now();
      if (timeToEnd < params.exit_before_ms * 3) continue;

      // Check spreads on both sides
      const [upBook, downBook] = await Promise.all([
        ctx.api.getBook(market.upTokenId),
        ctx.api.getBook(market.downTokenId),
      ]);

      const upSpread = getSpread(upBook);
      const downSpread = getSpread(downBook);

      // Need at least one side with a tradeable spread
      if (upSpread < params.min_spread && downSpread < params.min_spread) {
        ctx.log(
          `${market.title.slice(0, 40)}: spreads too tight UP=${upSpread.toFixed(3)} DN=${downSpread.toFixed(3)}`
        );
        continue;
      }

      const scalp: ScalpState = {
        market,
        inventory: [],
        pendingBuyOrderId: null,
        pendingBuyTokenId: null,
        pendingBuyPrice: 0,
        pendingBuySize: 0,
        pendingSellOrderId: null,
        pendingSellTokenId: null,
        pendingSellPrice: 0,
        pendingSellSize: 0,
        totalBuys: 0,
        totalSells: 0,
        realizedPnl: 0,
        placedAt: new Date().toISOString(),
      };

      this.scalps.push(scalp);
      opened++;
      ctx.log(
        `ENTERED: ${market.title.slice(0, 40)} UP spread=${upSpread.toFixed(3)} DN spread=${downSpread.toFixed(3)} expires=${Math.round(timeToEnd / 1000)}s`
      );
    }
  }
}

// ── Register ─────────────────────────────────────────────────────────

registerStrategy("passive-mm", () => new ScalpMMStrategy());
