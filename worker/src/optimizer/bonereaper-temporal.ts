/**
 * Bonereaper temporal analysis — look at intra-window side flipping
 * and directional bias over time.
 *
 * Usage: npx tsx src/optimizer/bonereaper-temporal.ts
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
  title: string;
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
      title: i.title || "",
    }));
}

async function main() {
  console.log("Fetching trades for temporal analysis...\n");

  // Fetch 3000 trades (API max)
  const allTrades: Trade[] = [];
  for (let offset = 0; offset < 3000; offset += 500) {
    const batch = await fetchTrades(offset, 500);
    allTrades.push(...batch);
    if (batch.length < 500) break;
  }
  console.log(`Total trades: ${allTrades.length}\n`);

  // Group by conditionId (window)
  const windows = new Map<string, Trade[]>();
  for (const t of allTrades) {
    if (!t.conditionId) continue;
    if (!windows.has(t.conditionId)) windows.set(t.conditionId, []);
    windows.get(t.conditionId)!.push(t);
  }

  // Sort windows by earliest trade timestamp
  const sortedWindows = [...windows.entries()]
    .map(([cid, trades]) => ({
      cid,
      trades: trades.sort((a, b) => a.timestamp - b.timestamp),
      slug: trades[0].slug,
      title: trades[0].title,
    }))
    .sort((a, b) => a.trades[0].timestamp - b.trades[0].timestamp);

  console.log("══════════════════════════════════════════════════════════════════");
  console.log("  INTRA-WINDOW TEMPORAL ANALYSIS");
  console.log("══════════════════════════════════════════════════════════════════\n");

  for (const w of sortedWindows.slice(-10)) {  // Last 10 windows
    const trades = w.trades;
    if (trades.length < 10) continue;

    const dur = w.slug.includes("-5m-") ? "5m" : w.slug.includes("-15m-") ? "15m" : "??";
    const startTs = trades[0].timestamp;
    const endTs = trades[trades.length - 1].timestamp;
    const spanSec = endTs - startTs;

    // Split window into time thirds
    const third = spanSec / 3;
    const early = trades.filter(t => t.timestamp < startTs + third);
    const mid = trades.filter(t => t.timestamp >= startTs + third && t.timestamp < startTs + 2 * third);
    const late = trades.filter(t => t.timestamp >= startTs + 2 * third);

    function sideBreakdown(arr: Trade[]) {
      const upBuys = arr.filter(t => t.side === "BUY" && t.outcome === "up");
      const dnBuys = arr.filter(t => t.side === "BUY" && t.outcome === "down");
      const upVol = upBuys.reduce((s, t) => s + t.size, 0);
      const dnVol = dnBuys.reduce((s, t) => s + t.size, 0);
      const upAvg = upBuys.length > 0 ? upBuys.reduce((s, t) => s + t.price, 0) / upBuys.length : 0;
      const dnAvg = dnBuys.length > 0 ? dnBuys.reduce((s, t) => s + t.price, 0) / dnBuys.length : 0;
      const total = upVol + dnVol;
      const pctUp = total > 0 ? (upVol / total * 100) : 0;
      return { upVol, dnVol, upAvg, dnAvg, pctUp, count: arr.length };
    }

    const e = sideBreakdown(early);
    const m = sideBreakdown(mid);
    const l = sideBreakdown(late);
    const all = sideBreakdown(trades);

    const startTime = new Date(startTs * 1000).toISOString().slice(11, 19);
    const endTime = new Date(endTs * 1000).toISOString().slice(11, 19);

    console.log(`── [${dur}] ${startTime} → ${endTime} (${spanSec}s, ${trades.length} trades) ──`);
    console.log(`  Overall: UP=${all.upVol.toFixed(0)} (${all.pctUp.toFixed(0)}%) DN=${all.dnVol.toFixed(0)} (${(100-all.pctUp).toFixed(0)}%)  avg: UP=$${all.upAvg.toFixed(3)} DN=$${all.dnAvg.toFixed(3)}`);
    console.log(`  Early ${e.count}t: UP=${e.pctUp.toFixed(0)}% (avg $${e.upAvg.toFixed(3)}) DN=${(100-e.pctUp).toFixed(0)}% (avg $${e.dnAvg.toFixed(3)})`);
    console.log(`  Mid   ${m.count}t: UP=${m.pctUp.toFixed(0)}% (avg $${m.upAvg.toFixed(3)}) DN=${(100-m.pctUp).toFixed(0)}% (avg $${m.dnAvg.toFixed(3)})`);
    console.log(`  Late  ${l.count}t: UP=${l.pctUp.toFixed(0)}% (avg $${l.upAvg.toFixed(3)}) DN=${(100-l.pctUp).toFixed(0)}% (avg $${l.dnAvg.toFixed(3)})`);

    // Check if heavy side flipped within window
    const earlyHeavy = e.pctUp > 50 ? "UP" : "DN";
    const lateHeavy = l.pctUp > 50 ? "UP" : "DN";
    if (earlyHeavy !== lateHeavy) {
      console.log(`  *** INTRA-WINDOW FLIP: ${earlyHeavy} → ${lateHeavy} ***`);
    }

    // Price progression (does it pay more as window progresses?)
    const earlyUpPrices = early.filter(t => t.outcome === "up" && t.side === "BUY").map(t => t.price);
    const lateUpPrices = late.filter(t => t.outcome === "up" && t.side === "BUY").map(t => t.price);
    const earlyDnPrices = early.filter(t => t.outcome === "down" && t.side === "BUY").map(t => t.price);
    const lateDnPrices = late.filter(t => t.outcome === "down" && t.side === "BUY").map(t => t.price);

    if (earlyUpPrices.length > 0 && lateUpPrices.length > 0) {
      const earlyUp = earlyUpPrices.reduce((a, b) => a + b) / earlyUpPrices.length;
      const lateUp = lateUpPrices.reduce((a, b) => a + b) / lateUpPrices.length;
      console.log(`  UP price: $${earlyUp.toFixed(3)} → $${lateUp.toFixed(3)} (${lateUp > earlyUp ? "▲" : "▼"}${Math.abs(lateUp - earlyUp).toFixed(3)})`);
    }
    if (earlyDnPrices.length > 0 && lateDnPrices.length > 0) {
      const earlyDn = earlyDnPrices.reduce((a, b) => a + b) / earlyDnPrices.length;
      const lateDn = lateDnPrices.reduce((a, b) => a + b) / lateDnPrices.length;
      console.log(`  DN price: $${earlyDn.toFixed(3)} → $${lateDn.toFixed(3)} (${lateDn > earlyDn ? "▲" : "▼"}${Math.abs(lateDn - earlyDn).toFixed(3)})`);
    }
    console.log();
  }

  // Cross-window directional consistency
  console.log("══════════════════════════════════════════════════════════════════");
  console.log("  CROSS-WINDOW DIRECTIONAL BIAS OVER TIME");
  console.log("════════════════════════════════════════════════════════════��═════\n");

  for (const w of sortedWindows) {
    const trades = w.trades;
    if (trades.length < 5) continue;

    const upVol = trades.filter(t => t.side === "BUY" && t.outcome === "up").reduce((s, t) => s + t.size, 0);
    const dnVol = trades.filter(t => t.side === "BUY" && t.outcome === "down").reduce((s, t) => s + t.size, 0);
    const total = upVol + dnVol;
    const pctUp = total > 0 ? upVol / total * 100 : 50;
    const heavy = pctUp > 50 ? "UP" : "DN";
    const skew = Math.abs(pctUp - 50);

    const dur = w.slug.includes("-5m-") ? "5m" : w.slug.includes("-15m-") ? "15m" : "??";
    const ts = new Date(trades[0].timestamp * 1000).toISOString().slice(11, 19);

    const bar = "█".repeat(Math.round(skew / 2));
    console.log(`  ${ts} [${dur}] ${heavy} ${bar} ${skew.toFixed(0)}% skew (${trades.length} trades)`);
  }
}

main().catch(console.error);
