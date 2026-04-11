/**
 * Bonereaper trade analysis — pull trades from Data API and analyze
 * per-market pricing, sell margins, and inventory patterns.
 *
 * Usage:
 *   npx tsx src/optimizer/bonereaper-analysis.ts
 */

const BONEREAPER = "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30";
const DATA_API = "https://data-api.polymarket.com";

interface ActivityItem {
  type: string;
  side: string;
  size: number;
  usdcSize: number;
  price: number;
  timestamp: number;
  createdAt?: string;
  market?: string;
  title?: string;
  slug?: string;
  asset?: string;
  tokenId?: string;
  conditionId?: string;
  outcome?: string;
  transactionHash?: string;
  [key: string]: unknown;
}

interface MarketStats {
  symbol: string;
  buyCount: number;
  sellCount: number;
  buyPrices: number[];
  sellPrices: number[];
  buyAvg: number;
  sellAvg: number;
  sellMargins: number[];  // (sellPrice - avgBuyCost) / avgBuyCost
  totalBuyVolume: number;
  totalSellVolume: number;
  titles: Set<string>;
}

// ── Fetch all activity (paginated) ─────────────────────────────────

async function fetchAllActivity(wallet: string, maxPages = 20): Promise<ActivityItem[]> {
  const all: ActivityItem[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      user: wallet,
      limit: "500",
      _t: Date.now().toString(),
    });
    if (cursor) params.set("cursor", cursor);

    const url = `${DATA_API}/activity?${params}`;
    console.log(`  Fetching page ${page + 1}... (${all.length} trades so far)`);

    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`  API error: ${resp.status} ${resp.statusText}`);
      break;
    }

    const items: ActivityItem[] = await resp.json() as ActivityItem[];
    if (!items.length) break;

    all.push(...items);

    // Check for next_cursor in response headers or last item
    const nextCursor = resp.headers.get("next_cursor");
    if (nextCursor) {
      cursor = nextCursor;
    } else if (items.length < 500) {
      break; // Last page
    } else {
      // Use timestamp of last item as cursor
      const lastTs = items[items.length - 1].timestamp || items[items.length - 1].createdAt;
      if (!lastTs) break;
      cursor = String(lastTs);
    }
  }

  return all;
}

// ── Extract crypto symbol from market title ────────────────────────

function extractSymbol(item: ActivityItem): string | null {
  // Try slug first (most reliable: "btc-updown-5m-1234")
  const slug = (item.slug || item.eventSlug || "").toLowerCase();
  if (slug.startsWith("btc-")) return "BTC";
  if (slug.startsWith("eth-")) return "ETH";
  if (slug.startsWith("xrp-")) return "XRP";
  if (slug.startsWith("doge-")) return "DOGE";
  if (slug.startsWith("bnb-")) return "BNB";
  if (slug.startsWith("sol-")) return "SOL";
  if (slug.startsWith("hype-")) return "HYPE";

  // Fallback to title
  const text = item.title || item.market || "";
  const match = text.match(/\b(BTC|Bitcoin|ETH|Ethereum|XRP|DOGE|Dogecoin|BNB|SOL|Solana|HYPE|ADA|AVAX|LINK|DOT|MATIC)\b/i);
  if (!match) return null;

  const sym = match[1].toUpperCase();
  // Normalize
  if (sym === "BITCOIN") return "BTC";
  if (sym === "ETHEREUM") return "ETH";
  if (sym === "DOGECOIN") return "DOGE";
  if (sym === "SOLANA") return "SOL";
  return sym;
}

function extractSide(item: ActivityItem): "UP" | "DOWN" | null {
  // Use outcome field (most reliable) — "Up" or "Down"
  const outcome = (item.outcome || "").toLowerCase();
  if (outcome === "up") return "UP";
  if (outcome === "down") return "DOWN";

  // Fallback to outcomeIndex (0 = Up, 1 = Down for most markets)
  if (item.outcomeIndex === 0) return "UP";
  if (item.outcomeIndex === 1) return "DOWN";

  return null;
}

// ── Main analysis ──────────────────────────────────────────────────

async function main() {
  console.log(`\nBonereaper Trade Analysis`);
  console.log(`Wallet: ${BONEREAPER}\n`);

  // Step 1: Fetch trades
  console.log("Fetching activity...");
  const items = await fetchAllActivity(BONEREAPER);
  console.log(`\nTotal items: ${items.length}`);

  // Filter to TRADE types only
  const trades = items.filter(i =>
    i.type === "TRADE" || i.type === "BUY" || i.type === "SELL" ||
    (i.side === "BUY" || i.side === "SELL")
  );
  console.log(`Trade items: ${trades.length}`);

  // Debug: show first few items to understand structure
  console.log("\n── Sample items (first 3) ──");
  for (const item of items.slice(0, 3)) {
    console.log(JSON.stringify(item, null, 2));
  }

  // Count types
  const typeCounts = new Map<string, number>();
  for (const item of items) {
    const t = item.type || "UNKNOWN";
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
  }
  console.log("\n── Activity types ──");
  for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  // Step 2: Group by crypto symbol
  const stats = new Map<string, MarketStats>();

  for (const t of trades) {
    const symbol = extractSymbol(t);
    if (!symbol) continue;

    if (!stats.has(symbol)) {
      stats.set(symbol, {
        symbol,
        buyCount: 0,
        sellCount: 0,
        buyPrices: [],
        sellPrices: [],
        buyAvg: 0,
        sellAvg: 0,
        sellMargins: [],
        totalBuyVolume: 0,
        totalSellVolume: 0,
        titles: new Set(),
      });
    }

    const s = stats.get(symbol)!;
    const title = t.title || t.market || "";
    if (title) s.titles.add(title);

    const price = t.price || (t.size > 0 ? (t.usdcSize / t.size) : 0);
    const size = t.size || 0;

    if (t.side === "BUY") {
      s.buyCount++;
      if (price > 0) s.buyPrices.push(price);
      s.totalBuyVolume += size;
    } else if (t.side === "SELL") {
      s.sellCount++;
      if (price > 0) s.sellPrices.push(price);
      s.totalSellVolume += size;
    }
  }

  // Step 3: Compute statistics
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  PER-MARKET ANALYSIS");
  console.log("══════════════════════════════════════════════════════════\n");

  const sortedSymbols = [...stats.entries()].sort((a, b) => b[1].buyCount - a[1].buyCount);

  for (const [symbol, s] of sortedSymbols) {
    const buyAvg = s.buyPrices.length > 0
      ? s.buyPrices.reduce((a, b) => a + b, 0) / s.buyPrices.length
      : 0;
    const sellAvg = s.sellPrices.length > 0
      ? s.sellPrices.reduce((a, b) => a + b, 0) / s.sellPrices.length
      : 0;

    // Price distribution
    const buyLow = s.buyPrices.filter(p => p < 0.40);
    const buyMid = s.buyPrices.filter(p => p >= 0.40 && p < 0.60);
    const buyHigh = s.buyPrices.filter(p => p >= 0.60);

    const sellLow = s.sellPrices.filter(p => p < 0.20);
    const sellMid = s.sellPrices.filter(p => p >= 0.20 && p < 0.50);
    const sellHigh = s.sellPrices.filter(p => p >= 0.50);

    // Percentiles
    const sorted = [...s.buyPrices].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.10)] || 0;
    const p25 = sorted[Math.floor(sorted.length * 0.25)] || 0;
    const p50 = sorted[Math.floor(sorted.length * 0.50)] || 0;
    const p75 = sorted[Math.floor(sorted.length * 0.75)] || 0;
    const p90 = sorted[Math.floor(sorted.length * 0.90)] || 0;

    const sellSorted = [...s.sellPrices].sort((a, b) => a - b);
    const sp10 = sellSorted[Math.floor(sellSorted.length * 0.10)] || 0;
    const sp50 = sellSorted[Math.floor(sellSorted.length * 0.50)] || 0;
    const sp90 = sellSorted[Math.floor(sellSorted.length * 0.90)] || 0;

    console.log(`── ${symbol} ──`);
    console.log(`  Buys:  ${s.buyCount} trades, ${s.totalBuyVolume.toFixed(0)} tokens, avg $${buyAvg.toFixed(4)}`);
    console.log(`  Sells: ${s.sellCount} trades, ${s.totalSellVolume.toFixed(0)} tokens, avg $${sellAvg.toFixed(4)}`);
    console.log(`  Buy price distribution: <$0.40: ${buyLow.length} | $0.40-0.60: ${buyMid.length} | >$0.60: ${buyHigh.length}`);
    console.log(`  Buy percentiles: P10=$${p10.toFixed(3)} P25=$${p25.toFixed(3)} P50=$${p50.toFixed(3)} P75=$${p75.toFixed(3)} P90=$${p90.toFixed(3)}`);
    if (s.sellPrices.length > 0) {
      console.log(`  Sell price distribution: <$0.20: ${sellLow.length} | $0.20-0.50: ${sellMid.length} | >$0.50: ${sellHigh.length}`);
      console.log(`  Sell percentiles: P10=$${sp10.toFixed(3)} P50=$${sp50.toFixed(3)} P90=$${sp90.toFixed(3)}`);
    }
    console.log(`  Sample titles: ${[...s.titles].slice(0, 2).join(", ")}`);
    console.log();
  }

  // Step 4: Overall summary
  console.log("══════════════════════════════════════════════════════════");
  console.log("  OVERALL SUMMARY");
  console.log("══════════════════════════════════════════════════════════\n");

  let totalBuys = 0, totalSells = 0;
  for (const [, s] of stats) {
    totalBuys += s.buyCount;
    totalSells += s.sellCount;
  }
  console.log(`  Total buys: ${totalBuys}`);
  console.log(`  Total sells: ${totalSells}`);
  console.log(`  Sell ratio: ${totalSells > 0 ? (totalSells / (totalBuys + totalSells) * 100).toFixed(1) : 0}%`);
  console.log(`  Markets: ${stats.size} (${[...stats.keys()].join(", ")})`);

  // Step 5: Time analysis (if timestamps available)
  const withTs = trades.filter(t => t.timestamp || t.createdAt);
  if (withTs.length > 0) {
    const timestamps = withTs.map(t => {
      let ts = Number(t.timestamp || 0);
      if (!ts && t.createdAt) ts = new Date(t.createdAt).getTime();
      if (ts > 0 && ts < 4_102_444_800) ts *= 1000;
      return ts;
    }).filter(t => t > 0).sort((a, b) => a - b);

    if (timestamps.length > 1) {
      const earliest = new Date(timestamps[0]);
      const latest = new Date(timestamps[timestamps.length - 1]);
      const spanHours = (timestamps[timestamps.length - 1] - timestamps[0]) / 3_600_000;
      console.log(`\n  Time span: ${earliest.toISOString()} → ${latest.toISOString()} (${spanHours.toFixed(1)}h)`);
      console.log(`  Trades/hour: ${(trades.length / Math.max(1, spanHours)).toFixed(1)}`);
    }
  }

  // Step 6: Look at UP vs DOWN token patterns
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  UP vs DOWN TOKEN ANALYSIS");
  console.log("══════════════════════════════════════════════════════════\n");

  const sideStats = new Map<string, { upBuys: number[]; dnBuys: number[]; upSells: number[]; dnSells: number[] }>();

  for (const t of trades) {
    const symbol = extractSymbol(t);
    const side = extractSide(t);
    if (!symbol || !side) continue;

    if (!sideStats.has(symbol)) {
      sideStats.set(symbol, { upBuys: [], dnBuys: [], upSells: [], dnSells: [] });
    }

    const ss = sideStats.get(symbol)!;
    const price = t.price || (t.size > 0 ? (t.usdcSize / t.size) : 0);
    if (price <= 0) continue;

    if (t.side === "BUY" && side === "UP") ss.upBuys.push(price);
    if (t.side === "BUY" && side === "DOWN") ss.dnBuys.push(price);
    if (t.side === "SELL" && side === "UP") ss.upSells.push(price);
    if (t.side === "SELL" && side === "DOWN") ss.dnSells.push(price);
  }

  for (const [symbol, ss] of [...sideStats.entries()].sort((a, b) => (b[1].upBuys.length + b[1].dnBuys.length) - (a[1].upBuys.length + a[1].dnBuys.length))) {
    const avg = (arr: number[]) => arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3) : "n/a";

    console.log(`── ${symbol} ──`);
    console.log(`  UP  buys: ${ss.upBuys.length} (avg $${avg(ss.upBuys)})  |  UP  sells: ${ss.upSells.length} (avg $${avg(ss.upSells)})`);
    console.log(`  DOWN buys: ${ss.dnBuys.length} (avg $${avg(ss.dnBuys)})  |  DOWN sells: ${ss.dnSells.length} (avg $${avg(ss.dnSells)})`);

    // Check if winning vs losing side pricing is consistent
    if (ss.upBuys.length > 5 && ss.dnBuys.length > 5) {
      const upAvg = parseFloat(avg(ss.upBuys));
      const dnAvg = parseFloat(avg(ss.dnBuys));
      const pairCost = upAvg + dnAvg;
      console.log(`  Implied pair cost: $${upAvg.toFixed(3)} + $${dnAvg.toFixed(3)} = $${pairCost.toFixed(3)}`);
    }
    console.log();
  }

  // Step 7: Fill size distribution
  console.log("══════════════════════════════════════════════════════════");
  console.log("  FILL SIZE DISTRIBUTION");
  console.log("══════════════════════════════════════════════════════════\n");

  const sizes = trades.map(t => t.size).filter(s => s > 0);
  if (sizes.length > 0) {
    const sortedSizes = [...sizes].sort((a, b) => a - b);
    const sP10 = sortedSizes[Math.floor(sortedSizes.length * 0.10)];
    const sP25 = sortedSizes[Math.floor(sortedSizes.length * 0.25)];
    const sP50 = sortedSizes[Math.floor(sortedSizes.length * 0.50)];
    const sP75 = sortedSizes[Math.floor(sortedSizes.length * 0.75)];
    const sP90 = sortedSizes[Math.floor(sortedSizes.length * 0.90)];
    const sMax = sortedSizes[sortedSizes.length - 1];
    const sMin = sortedSizes[0];
    const sAvg = sizes.reduce((a, b) => a + b, 0) / sizes.length;

    console.log(`  Total fills: ${sizes.length}`);
    console.log(`  Size range: ${sMin.toFixed(1)} — ${sMax.toFixed(1)} tokens`);
    console.log(`  Average: ${sAvg.toFixed(1)} tokens`);
    console.log(`  Percentiles: P10=${sP10.toFixed(1)} P25=${sP25.toFixed(1)} P50=${sP50.toFixed(1)} P75=${sP75.toFixed(1)} P90=${sP90.toFixed(1)}`);

    // Bucket by size
    const tiny = sizes.filter(s => s <= 10);
    const small = sizes.filter(s => s > 10 && s <= 30);
    const med = sizes.filter(s => s > 30 && s <= 100);
    const large = sizes.filter(s => s > 100);
    console.log(`  Buckets: ≤10: ${tiny.length} | 11-30: ${small.length} | 31-100: ${med.length} | >100: ${large.length}`);
  }

  // Step 8: Window duration breakdown (from slug)
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  WINDOW DURATION BREAKDOWN");
  console.log("══════════════════════════════════════════════════════════\n");

  const durationCounts = new Map<string, number>();
  for (const t of trades) {
    const slug = t.slug || t.eventSlug || "";
    let dur = "unknown";
    if (slug.includes("-5m-")) dur = "5min";
    else if (slug.includes("-15m-")) dur = "15min";
    else if (slug.includes("-1h-")) dur = "1hr";
    else if (slug.includes("-4h-")) dur = "4hr";
    durationCounts.set(dur, (durationCounts.get(dur) || 0) + 1);
  }
  for (const [dur, count] of [...durationCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${dur}: ${count} trades (${(count / trades.length * 100).toFixed(1)}%)`);
  }

  // Step 9: Per-window aggregation (group by conditionId)
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  PER-WINDOW AGGREGATION (last 20 windows)");
  console.log("══════════════════════════════════════════════════════════\n");

  const windows = new Map<string, {
    conditionId: string;
    title: string;
    slug: string;
    trades: ActivityItem[];
    upBuys: number;
    dnBuys: number;
    upSells: number;
    dnSells: number;
    totalCost: number;
    totalSellRevenue: number;
    merges: number;
    redeems: number;
    minTs: number;
    maxTs: number;
  }>();

  for (const item of items) {
    const cid = item.conditionId || "";
    if (!cid) continue;

    if (!windows.has(cid)) {
      windows.set(cid, {
        conditionId: cid,
        title: item.title || "",
        slug: item.slug || item.eventSlug || "",
        trades: [],
        upBuys: 0,
        dnBuys: 0,
        upSells: 0,
        dnSells: 0,
        totalCost: 0,
        totalSellRevenue: 0,
        merges: 0,
        redeems: 0,
        minTs: Infinity,
        maxTs: 0,
      });
    }

    const w = windows.get(cid)!;
    w.trades.push(item);

    let ts = Number(item.timestamp || 0);
    if (ts > 0 && ts < 4_102_444_800) ts *= 1000;
    if (ts > 0) {
      w.minTs = Math.min(w.minTs, ts);
      w.maxTs = Math.max(w.maxTs, ts);
    }

    if (item.type === "MERGE") {
      w.merges++;
      continue;
    }
    if (item.type === "REDEEM") {
      w.redeems++;
      continue;
    }

    const side = extractSide(item);
    const price = item.price || 0;
    const size = item.size || 0;

    if (item.side === "BUY") {
      if (side === "UP") w.upBuys += size;
      else if (side === "DOWN") w.dnBuys += size;
      w.totalCost += price * size;
    } else if (item.side === "SELL") {
      if (side === "UP") w.upSells += size;
      else if (side === "DOWN") w.dnSells += size;
      w.totalSellRevenue += price * size;
    }
  }

  // Sort by timestamp, show last 20
  const sortedWindows = [...windows.values()]
    .filter(w => w.trades.length > 0)
    .sort((a, b) => b.maxTs - a.maxTs)
    .slice(0, 20);

  for (const w of sortedWindows) {
    const dur = w.slug.includes("-5m-") ? "5m" : w.slug.includes("-15m-") ? "15m" : "??";
    const tradeCount = w.trades.filter(t => t.type === "TRADE").length;
    const upTotal = w.upBuys - w.upSells;
    const dnTotal = w.dnBuys - w.dnSells;
    const ts = w.maxTs > 0 ? new Date(w.maxTs).toISOString().slice(11, 19) : "??";

    console.log(`  [${dur}] ${ts} | ${tradeCount} trades | UP: +${w.upBuys.toFixed(0)}/-${w.upSells.toFixed(0)}=${upTotal.toFixed(0)} | DN: +${w.dnBuys.toFixed(0)}/-${w.dnSells.toFixed(0)}=${dnTotal.toFixed(0)} | cost=$${w.totalCost.toFixed(0)} | merges=${w.merges} redeems=${w.redeems}`);
  }
}

main().catch(console.error);
