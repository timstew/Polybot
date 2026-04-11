/**
 * Bonereaper "Fade the Retail Flow" test
 *
 * Strategy: Pull the global trade tape, filter for BTC updown markets where
 * Bonereaper is active, then check whether Bonereaper buys the OPPOSITE side
 * within seconds of large retail trades.
 *
 * Usage: npx tsx src/optimizer/bonereaper-frf.ts
 */

const BONEREAPER = "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30";
const DATA_API = "https://data-api.polymarket.com";

interface TapeItem {
  proxyWallet: string;
  side: string;         // BUY or SELL
  size: number;
  price: number;
  timestamp: number;
  conditionId: string;
  outcome: string;      // "Up" or "Down"
  slug: string;
  pseudonym: string;
  asset: string;
  transactionHash?: string;
}

// ── Fetch Bonereaper's recent conditionIds ─────────────────────────

async function fetchBonereaperConditions(): Promise<Set<string>> {
  const url = `${DATA_API}/activity?user=${BONEREAPER}&limit=500`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Activity API error: ${resp.status}`);
  const items: any[] = await resp.json() as any[];
  const conds = new Set<string>();
  for (const item of items) {
    if (item.conditionId) conds.add(item.conditionId);
  }
  return conds;
}

// ── Fetch global tape (paginated backward) ─────────────────────────

async function fetchGlobalTape(pages = 10): Promise<TapeItem[]> {
  const all: TapeItem[] = [];
  // Data API /trades returns most recent, no cursor/offset for backward pagination
  // But we can use timestamps to paginate
  let beforeTs: number | null = null;

  for (let page = 0; page < pages; page++) {
    const params = new URLSearchParams({ limit: "1000" });
    if (beforeTs) params.set("before", String(beforeTs));

    const url = `${DATA_API}/trades?${params}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`Tape error: ${resp.status}`);
      break;
    }
    const items: TapeItem[] = await resp.json() as TapeItem[];
    if (!items.length) break;
    all.push(...items);

    // Set before to earliest timestamp for next page
    const minTs = Math.min(...items.map(t => t.timestamp));
    if (beforeTs !== null && minTs >= beforeTs) break; // No progress
    beforeTs = minTs;

    console.log(`  Page ${page + 1}: ${items.length} trades (down to ts=${minTs}, ${new Date(minTs * 1000).toISOString().slice(11, 19)})`);
    if (items.length < 1000) break;
  }
  return all;
}

function opposite(outcome: string): string {
  return outcome.toLowerCase() === "up" ? "Down" : "Up";
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  BONEREAPER: FADE THE RETAIL FLOW TEST");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Step 1: Get Bonereaper's active conditionIds
  console.log("Fetching Bonereaper's active windows...");
  const brConditions = await fetchBonereaperConditions();
  console.log(`Active conditionIds: ${brConditions.size}\n`);

  // Step 2: Pull global tape
  console.log("Fetching global trade tape...");
  const tape = await fetchGlobalTape(15);
  console.log(`\nTotal tape trades: ${tape.length}`);

  const tapeTimeRange = tape.length > 0
    ? `${new Date(Math.min(...tape.map(t => t.timestamp)) * 1000).toISOString().slice(11, 19)} → ${new Date(Math.max(...tape.map(t => t.timestamp)) * 1000).toISOString().slice(11, 19)}`
    : "n/a";
  console.log(`Tape time range: ${tapeTimeRange}\n`);

  // Step 3: Filter tape to Bonereaper's active windows
  const brWindowTape = tape.filter(t => brConditions.has(t.conditionId));
  console.log(`Trades in BR's active windows: ${brWindowTape.length}`);

  const brAddr = BONEREAPER.toLowerCase();
  const brTrades = brWindowTape.filter(t => t.proxyWallet.toLowerCase() === brAddr);
  const otherTrades = brWindowTape.filter(t => t.proxyWallet.toLowerCase() !== brAddr);
  console.log(`  Bonereaper's trades: ${brTrades.length}`);
  console.log(`  Other traders: ${otherTrades.length}`);

  // Step 4: Per-conditionId analysis
  const conditionGroups = new Map<string, TapeItem[]>();
  for (const t of brWindowTape) {
    if (!conditionGroups.has(t.conditionId)) conditionGroups.set(t.conditionId, []);
    conditionGroups.get(t.conditionId)!.push(t);
  }

  console.log(`\nActive windows in tape: ${conditionGroups.size}\n`);

  // Unique traders
  const allTraders = new Map<string, { count: number; volume: number; pseudonym: string }>();
  for (const t of brWindowTape) {
    const addr = t.proxyWallet.toLowerCase();
    if (!allTraders.has(addr)) allTraders.set(addr, { count: 0, volume: 0, pseudonym: t.pseudonym || "" });
    allTraders.get(addr)!.count++;
    allTraders.get(addr)!.volume += t.size * t.price;
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TRADERS IN BONEREAPER'S WINDOWS");
  console.log("═══════════════════════════════════════════════════════════\n");

  const sortedTraders = [...allTraders.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [addr, info] of sortedTraders.slice(0, 15)) {
    const isBR = addr === brAddr;
    const marker = isBR ? " *** BONEREAPER ***" : "";
    console.log(
      `  ${info.pseudonym.padEnd(30)} ${info.count.toString().padStart(5)} trades  ` +
      `$${info.volume.toFixed(0).padStart(6)} vol${marker}`
    );
  }

  // Step 5: FADE ANALYSIS
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  FADE ANALYSIS: DOES BR BUY OPPOSITE SIDE AFTER RETAIL?");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Sort all trades by timestamp
  const sorted = brWindowTape.sort((a, b) => a.timestamp - b.timestamp);

  // Find non-BR trades that are "large" relative to the window
  const nonBrSizes = otherTrades.map(t => t.size).sort((a, b) => a - b);
  const p75Size = nonBrSizes[Math.floor(nonBrSizes.length * 0.75)] || 20;
  const largeThreshold = Math.max(p75Size, 20);
  console.log(`P75 non-BR trade size: ${p75Size.toFixed(1)}, large threshold: ${largeThreshold.toFixed(1)}\n`);

  const largeTrades = otherTrades
    .filter(t => t.size >= largeThreshold)
    .sort((a, b) => a.timestamp - b.timestamp);

  console.log(`Large non-BR trades to test: ${largeTrades.length}\n`);

  let fadeCount = 0;
  let followCount = 0;
  let noReactionCount = 0;
  let sameWindowOnly = 0;

  for (const retail of largeTrades) {
    const retailTs = retail.timestamp;
    const retailOutcome = retail.outcome.toLowerCase();
    const retailSide = retail.side;

    // What "direction" does this retail trade push?
    // BUY UP = pushes price UP (bullish for UP tokens)
    // BUY DOWN = pushes price DOWN (bullish for DOWN tokens)
    const retailPushesSide = retailOutcome; // If you BUY "Up" tokens, you're pushing Up price up

    // Find BR trades in same conditionId within 5 seconds AFTER
    const brReactions = brTrades.filter(t =>
      t.conditionId === retail.conditionId &&
      t.timestamp > retailTs &&
      t.timestamp <= retailTs + 5
    );

    if (brReactions.length === 0) {
      noReactionCount++;
      continue;
    }

    // What side did BR buy?
    const brUpVol = brReactions
      .filter(t => t.outcome.toLowerCase() === "up")
      .reduce((s, t) => s + t.size, 0);
    const brDnVol = brReactions
      .filter(t => t.outcome.toLowerCase() === "down")
      .reduce((s, t) => s + t.size, 0);

    const brHeavySide = brUpVol > brDnVol ? "up" : "down";
    const isFade = brHeavySide !== retailPushesSide;
    const isFollow = brHeavySide === retailPushesSide;

    if (isFade) fadeCount++;
    else if (isFollow) followCount++;

    const time = new Date(retailTs * 1000).toISOString().slice(11, 19);
    const marker = isFade ? "FADE" : "FOLLOW";
    const retailInfo = `${retail.pseudonym.slice(0, 20)} ${retailSide} ${retail.outcome} ${retail.size.toFixed(0).padStart(4)}@$${retail.price.toFixed(2)}`;
    const brInfo = `UP=${brUpVol.toFixed(0)} DN=${brDnVol.toFixed(0)}`;
    console.log(`  ${time} ${retailInfo.padEnd(50)} → BR: ${brInfo} → ${marker}`);
  }

  const total = fadeCount + followCount;
  console.log(`\n  ── FADE RESULT ──`);
  console.log(`  Fades (opposite side): ${fadeCount}`);
  console.log(`  Follows (same side): ${followCount}`);
  console.log(`  No BR reaction within 5s: ${noReactionCount}`);
  if (total > 0) {
    const fadePct = (fadeCount / total * 100).toFixed(0);
    console.log(`  Fade rate: ${fadePct}% (${fadeCount}/${total})`);
    if (parseInt(fadePct) > 65) {
      console.log(`  → STRONG fade behavior: BR consistently buys opposite side from retail`);
    } else if (parseInt(fadePct) > 45) {
      console.log(`  → MIXED: no clear fade or follow pattern`);
    } else {
      console.log(`  → FOLLOWS retail flow (not fading)`);
    }
  }

  // Step 6: TIMING ANALYSIS — how quickly does BR react?
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  REACTION TIMING: BR's RESPONSE LAG TO ANY TRADE");
  console.log("═══════════════════════════════════════════════════════════\n");

  // For each BR trade, find the closest preceding non-BR trade in the same window
  const reactionTimes: number[] = [];
  const samesSideReaction: number[] = [];
  const oppSideReaction: number[] = [];

  for (const brTrade of brTrades) {
    const precedingNonBr = otherTrades
      .filter(t =>
        t.conditionId === brTrade.conditionId &&
        t.timestamp <= brTrade.timestamp &&
        t.timestamp > brTrade.timestamp - 10
      )
      .sort((a, b) => b.timestamp - a.timestamp);

    if (precedingNonBr.length === 0) continue;

    const closest = precedingNonBr[0];
    const lag = brTrade.timestamp - closest.timestamp;
    reactionTimes.push(lag);

    if (brTrade.outcome.toLowerCase() === closest.outcome.toLowerCase()) {
      samesSideReaction.push(lag);
    } else {
      oppSideReaction.push(lag);
    }
  }

  if (reactionTimes.length > 0) {
    const avg = reactionTimes.reduce((a, b) => a + b) / reactionTimes.length;
    const sorted = reactionTimes.sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];

    console.log(`BR trades with preceding non-BR activity: ${reactionTimes.length}`);
    console.log(`Reaction time: avg=${avg.toFixed(1)}s, median=${med}s, P10=${p10}s, P90=${p90}s`);
    console.log(`  Same-side reactions: ${samesSideReaction.length} (avg ${samesSideReaction.length > 0 ? (samesSideReaction.reduce((a,b)=>a+b)/samesSideReaction.length).toFixed(1) : 'n/a'}s)`);
    console.log(`  Opp-side reactions:  ${oppSideReaction.length} (avg ${oppSideReaction.length > 0 ? (oppSideReaction.reduce((a,b)=>a+b)/oppSideReaction.length).toFixed(1) : 'n/a'}s)`);

    // Distribution
    console.log(`\n  Reaction time distribution:`);
    const buckets = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    for (const b of buckets) {
      const count = reactionTimes.filter(t => t === b).length;
      const bar = "█".repeat(Math.min(count * 2, 60));
      console.log(`    ${b}s: ${bar} ${count}`);
    }
  }

  // Step 7: WHO fills Bonereaper's orders?
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  BR's COUNTERPARTIES: WHO TRADES AGAINST BONEREAPER?");
  console.log("═══════════════════════════════════════════════════════════\n");

  // BR is a maker. So who are the takers hitting BR's resting orders?
  // We can't see maker/taker in Data API /trades, but we can look at
  // which non-BR trades happen in the same conditionId at the same timestamp
  // (within 1 second) as BR's trades — these are likely the same match.

  const brCounterparties = new Map<string, { count: number; volume: number; pseudonym: string }>();

  for (const brTrade of brTrades) {
    // Find non-BR trades at same timestamp ± 1s in same conditionId
    const matches = otherTrades.filter(t =>
      t.conditionId === brTrade.conditionId &&
      Math.abs(t.timestamp - brTrade.timestamp) <= 1 &&
      // Opposite sides of the same trade: if BR BUY, counterparty is SELL (or taker BUY hitting BR's SELL)
      // Actually in a matched trade, both sides show as "BUY" if the taker bought from the maker
      // The outcome should be the same (same token)
      t.outcome.toLowerCase() === brTrade.outcome.toLowerCase()
    );

    for (const m of matches) {
      const addr = m.proxyWallet.toLowerCase();
      if (!brCounterparties.has(addr)) brCounterparties.set(addr, { count: 0, volume: 0, pseudonym: m.pseudonym || "" });
      brCounterparties.get(addr)!.count++;
      brCounterparties.get(addr)!.volume += m.size * m.price;
    }
  }

  if (brCounterparties.size > 0) {
    const sortedCp = [...brCounterparties.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [addr, info] of sortedCp.slice(0, 10)) {
      console.log(
        `  ${info.pseudonym.padEnd(30)} ${info.count.toString().padStart(4)} matches  ` +
        `$${info.volume.toFixed(0).padStart(6)} vol  ` +
        `${addr.slice(0, 10)}...`
      );
    }

    // Check if it's always the same few
    const topCount = sortedCp.slice(0, 3).reduce((s, [, i]) => s + i.count, 0);
    const totalCount = sortedCp.reduce((s, [, i]) => s + i.count, 0);
    console.log(`\n  Top 3 counterparties: ${topCount}/${totalCount} matches (${(topCount/totalCount*100).toFixed(0)}%)`);
    if (topCount / totalCount > 0.5) {
      console.log(`  → CONCENTRATED: BR is mining a few specific counterparties`);
    } else {
      console.log(`  → DIFFUSE: BR fills from many different traders`);
    }
  } else {
    console.log("  No counterparty matches found (timestamps may not align exactly)");
  }

  // Step 8: Self-fade analysis (purely from BR trades)
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  SELF-FADE: BR'S OWN SIDE-SWITCHING PATTERN");
  console.log("═══════════════════════════════════════════════════════════\n");

  const brSorted = brTrades.sort((a, b) => a.timestamp - b.timestamp);
  let sameCount = 0, switchCount = 0;
  const switchDelays: number[] = [];
  const sameDelays: number[] = [];

  for (let i = 1; i < brSorted.length; i++) {
    const prev = brSorted[i - 1];
    const curr = brSorted[i];
    if (prev.conditionId !== curr.conditionId) continue;
    const delay = curr.timestamp - prev.timestamp;
    if (delay > 120) continue;

    if (prev.outcome.toLowerCase() === curr.outcome.toLowerCase()) {
      sameCount++;
      sameDelays.push(delay);
    } else {
      switchCount++;
      switchDelays.push(delay);
    }
  }

  const pairTotal = sameCount + switchCount;
  if (pairTotal > 0) {
    console.log(`Consecutive trade pairs (same window, within 2 min):`);
    console.log(`  Same side:  ${sameCount} (${(sameCount / pairTotal * 100).toFixed(0)}%)`);
    console.log(`  Switched:   ${switchCount} (${(switchCount / pairTotal * 100).toFixed(0)}%)`);

    if (switchDelays.length > 0) {
      const avg = switchDelays.reduce((a, b) => a + b) / switchDelays.length;
      const med = switchDelays.sort((a, b) => a - b)[Math.floor(switchDelays.length / 2)];
      console.log(`  Switch delay: avg=${avg.toFixed(1)}s, median=${med}s`);
    }
    if (sameDelays.length > 0) {
      const avg = sameDelays.reduce((a, b) => a + b) / sameDelays.length;
      console.log(`  Same-side delay: avg=${avg.toFixed(1)}s`);
    }

    // Run-length distribution
    console.log(`\n  Run-length (consecutive same-side before switching):`);
    const runLengths: number[] = [];
    let runLen = 1;
    for (let i = 1; i < brSorted.length; i++) {
      if (brSorted[i].conditionId !== brSorted[i - 1].conditionId ||
          brSorted[i].timestamp - brSorted[i - 1].timestamp > 120) {
        runLengths.push(runLen);
        runLen = 1;
        continue;
      }
      if (brSorted[i].outcome.toLowerCase() === brSorted[i - 1].outcome.toLowerCase()) {
        runLen++;
      } else {
        runLengths.push(runLen);
        runLen = 1;
      }
    }
    runLengths.push(runLen);

    const buckets = new Map<number, number>();
    for (const r of runLengths) {
      const b = Math.min(r, 10);
      buckets.set(b, (buckets.get(b) || 0) + 1);
    }
    for (const [len, count] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      const bar = "█".repeat(Math.min(count, 40));
      console.log(`    ${len >= 10 ? "10+" : String(len).padStart(2)} : ${bar} ${count}`);
    }
  }
}

main().catch(console.error);
