/**
 * Bonereaper flip correlation — compare directional flips against
 * Binance BTC spot price movements to find the trigger signal.
 *
 * Usage: npx tsx src/optimizer/bonereaper-flip-corr.ts
 */

const BONEREAPER = "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30";
const DATA_API = "https://data-api.polymarket.com";

interface Trade {
  timestamp: number;
  side: string;
  outcome: string;
  price: number;
  size: number;
  slug: string;
  conditionId: string;
}

interface KlinePoint {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

async function fetchTrades(offset: number, limit: number): Promise<Trade[]> {
  const url = `${DATA_API}/activity?user=${BONEREAPER}&limit=${limit}&offset=${offset}`;
  const resp = await fetch(url);
  if (!resp.ok) return [];
  const items: any[] = await resp.json() as any[];
  return items
    .filter(i => i.type === "TRADE")
    .map(i => ({
      timestamp: i.timestamp,
      side: i.side,
      outcome: (i.outcome || "").toLowerCase(),
      price: i.price || 0,
      size: i.size || 0,
      slug: i.slug || i.eventSlug || "",
      conditionId: i.conditionId || "",
    }));
}

async function fetchBinanceKlines(startMs: number, endMs: number): Promise<KlinePoint[]> {
  // 1-second klines for fine granularity
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`Binance kline error: ${resp.status}`);
    // Try 1-minute klines as fallback
    const url2 = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=1000`;
    const resp2 = await fetch(url2);
    if (!resp2.ok) return [];
    const data2: any[][] = await resp2.json() as any[][];
    return data2.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
    }));
  }
  const data: any[][] = await resp.json() as any[][];
  return data.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));
}

function getBinancePrice(klines: KlinePoint[], tsMs: number): number | null {
  // Find the kline closest to this timestamp
  let best: KlinePoint | null = null;
  let bestDist = Infinity;
  for (const k of klines) {
    const dist = Math.abs(k.openTime - tsMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = k;
    }
  }
  return best && bestDist < 120_000 ? best.close : null;
}

async function main() {
  console.log("Fetching Bonereaper trades...\n");

  const allTrades: Trade[] = [];
  for (let offset = 0; offset < 3000; offset += 500) {
    const batch = await fetchTrades(offset, 500);
    allTrades.push(...batch);
    if (batch.length < 500) break;
  }

  // Sort by timestamp ascending
  allTrades.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Total trades: ${allTrades.length}`);

  const minTs = allTrades[0]?.timestamp || 0;
  const maxTs = allTrades[allTrades.length - 1]?.timestamp || 0;

  console.log(`Time range: ${new Date(minTs * 1000).toISOString()} → ${new Date(maxTs * 1000).toISOString()}`);
  console.log(`\nFetching Binance BTC/USDT klines for this period...\n`);

  const klines = await fetchBinanceKlines(minTs * 1000 - 60_000, maxTs * 1000 + 60_000);
  console.log(`Klines fetched: ${klines.length} (interval: ${klines.length > 0 ? (klines[1]?.openTime - klines[0]?.openTime) / 1000 : '?'}s)\n`);

  // Group trades into 30-second buckets
  const BUCKET_SEC = 30;
  const buckets = new Map<number, Trade[]>();

  for (const t of allTrades) {
    const bucket = Math.floor(t.timestamp / BUCKET_SEC) * BUCKET_SEC;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)!.push(t);
  }

  console.log("══════════════════════════════════════════════════════════════════");
  console.log("  30-SECOND BUCKET ANALYSIS: BONEREAPER BIAS vs BINANCE BTC PRICE");
  console.log("══════════════════════════════════════════════════════════════════\n");

  const sortedBuckets = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  let prevBias = "";
  let prevBtcPrice = 0;

  const rows: {
    time: string;
    btcPrice: number;
    btcChange: string;
    upPct: number;
    bias: string;
    flipped: boolean;
    trades: number;
    upAvgPrice: number;
    dnAvgPrice: number;
  }[] = [];

  for (const [bucketTs, trades] of sortedBuckets) {
    if (trades.length < 3) continue;

    const upTrades = trades.filter(t => t.outcome === "up" && t.side === "BUY");
    const dnTrades = trades.filter(t => t.outcome === "down" && t.side === "BUY");
    const upVol = upTrades.reduce((s, t) => s + t.size, 0);
    const dnVol = dnTrades.reduce((s, t) => s + t.size, 0);
    const total = upVol + dnVol;
    if (total === 0) continue;

    const upPct = upVol / total * 100;
    const bias = upPct > 55 ? "UP" : upPct < 45 ? "DN" : "==";

    const btcPrice = getBinancePrice(klines, bucketTs * 1000);
    const btcChange = prevBtcPrice > 0 && btcPrice
      ? ((btcPrice - prevBtcPrice) / prevBtcPrice * 100).toFixed(3) + "%"
      : "n/a";

    const flipped = prevBias !== "" && prevBias !== "==" && bias !== "==" && prevBias !== bias;

    const upAvg = upTrades.length > 0 ? upTrades.reduce((s, t) => s + t.price, 0) / upTrades.length : 0;
    const dnAvg = dnTrades.length > 0 ? dnTrades.reduce((s, t) => s + t.price, 0) / dnTrades.length : 0;

    const time = new Date(bucketTs * 1000).toISOString().slice(11, 19);

    rows.push({
      time,
      btcPrice: btcPrice || 0,
      btcChange,
      upPct,
      bias,
      flipped,
      trades: trades.length,
      upAvgPrice: upAvg,
      dnAvgPrice: dnAvg,
    });

    if (btcPrice) prevBtcPrice = btcPrice;
    if (bias !== "==") prevBias = bias;
  }

  // Print with flip highlighting
  for (const r of rows) {
    const biasBar = r.bias === "UP"
      ? `UP ${"█".repeat(Math.round((r.upPct - 50) / 3))}`
      : r.bias === "DN"
      ? `DN ${"█".repeat(Math.round((50 - r.upPct) / 3))}`
      : "==";

    const flipMark = r.flipped ? " *** FLIP ***" : "";
    const btcStr = r.btcPrice > 0 ? `$${r.btcPrice.toFixed(0)}` : "n/a";

    console.log(
      `${r.time} | BTC=${btcStr} (${r.btcChange.padStart(7)}) | ` +
      `${biasBar.padEnd(12)} UP=${r.upPct.toFixed(0).padStart(2)}% | ` +
      `UP@$${r.upAvgPrice.toFixed(2)} DN@$${r.dnAvgPrice.toFixed(2)} | ` +
      `${r.trades}t${flipMark}`
    );
  }

  // Summary: correlation between BTC price moves and bias flips
  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log("  FLIP ANALYSIS: WHAT TRIGGERED EACH DIRECTIONAL CHANGE?");
  console.log("══════════════════════════════════════════════════════════════════\n");

  let flipCount = 0;
  let flipWithBtcMove = 0;
  let flipAgainstBtcMove = 0;

  for (let i = 1; i < rows.length; i++) {
    if (!rows[i].flipped) continue;
    flipCount++;

    const prev = rows[i - 1];
    const curr = rows[i];
    const btcPctChange = parseFloat(curr.btcChange);

    const btcDirection = btcPctChange > 0.01 ? "UP" : btcPctChange < -0.01 ? "DN" : "FLAT";
    const biasDirection = curr.bias;

    // BTC going UP → should favor UP tokens; BTC going DOWN → should favor DN tokens
    const aligned = btcDirection === biasDirection;
    if (aligned) flipWithBtcMove++;
    else if (btcDirection !== "FLAT") flipAgainstBtcMove++;

    console.log(`  FLIP at ${curr.time}: ${prev.bias} → ${curr.bias}`);
    console.log(`    BTC: $${prev.btcPrice.toFixed(0)} → $${curr.btcPrice.toFixed(0)} (${curr.btcChange})`);
    console.log(`    UP avg price: $${prev.upAvgPrice.toFixed(3)} → $${curr.upAvgPrice.toFixed(3)}`);
    console.log(`    DN avg price: $${prev.dnAvgPrice.toFixed(3)} → $${curr.dnAvgPrice.toFixed(3)}`);
    console.log(`    BTC direction: ${btcDirection}, Bias direction: ${biasDirection} → ${aligned ? "ALIGNED" : "DIVERGENT"}`);
    console.log();
  }

  console.log(`Total flips: ${flipCount}`);
  console.log(`Aligned with BTC price: ${flipWithBtcMove}`);
  console.log(`Against BTC price: ${flipAgainstBtcMove}`);
  console.log(`Inconclusive (BTC flat): ${flipCount - flipWithBtcMove - flipAgainstBtcMove}`);

  if (flipCount > 0) {
    const alignPct = (flipWithBtcMove / flipCount * 100).toFixed(0);
    console.log(`\nAlignment rate: ${alignPct}% of flips follow BTC direction`);
    if (parseInt(alignPct) > 70) {
      console.log("→ STRONG correlation: Bonereaper likely tracks Binance BTC spot price for directional signal");
    } else if (parseInt(alignPct) > 50) {
      console.log("→ MODERATE correlation: BTC spot is one input, but not the only signal");
    } else {
      console.log("→ WEAK correlation: Bonereaper's signal is NOT primarily Binance BTC spot");
    }
  }
}

main().catch(console.error);
