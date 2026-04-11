#!/usr/bin/env npx tsx
/**
 * Debug replay P&L breakdown vs live trades.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { replayWindow } from "./replay";
import type { WindowSnapshot, TickSnapshot } from "./types";
import { DEFAULT_PARAMS } from "../strategies/safe-maker";

let dbPath = process.argv[2] || "";
if (!dbPath) {
  const candidates = [
    path.join(__dirname, "../../.wrangler/state/v3/d1/miniflare-D1DatabaseObject"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".sqlite"));
      if (files.length > 0) { dbPath = path.join(dir, files[0]); break; }
    }
  }
}

const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(
  `SELECT id, crypto_symbol, window_open_time, window_end_time, window_duration_ms,
          oracle_strike, price_at_open, hour_utc, day_of_week,
          up_token_id, down_token_id, outcome, ticks
   FROM strategy_snapshots
   WHERE outcome IS NOT NULL AND outcome != 'UNKNOWN'
   ORDER BY window_open_time`
).all() as Array<Record<string, unknown>>;
db.close();

const windows: WindowSnapshot[] = rows.map((r: Record<string, unknown>) => ({
  id: r.id as string,
  cryptoSymbol: r.crypto_symbol as string,
  windowOpenTime: r.window_open_time as number,
  windowEndTime: r.window_end_time as number,
  windowDurationMs: r.window_duration_ms as number,
  oracleStrike: r.oracle_strike as number | null,
  outcome: r.outcome as "UP" | "DOWN",
  priceAtWindowOpen: r.price_at_open as number,
  hourUtc: r.hour_utc as number,
  dayOfWeek: r.day_of_week as number,
  upTokenId: r.up_token_id as string,
  downTokenId: r.down_token_id as string,
  ticks: JSON.parse(r.ticks as string) as TickSnapshot[],
}));

const params = { ...DEFAULT_PARAMS };

// Aggregate replay results
let totalMergePnl = 0;
let totalSellPnl = 0;
let totalResolvePnl = 0;
let totalFills = 0;
let totalSells = 0;

// For each window, compute a more detailed breakdown
for (const w of windows) {
  const result = replayWindow(w, params);
  totalFills += result.fillCount;
  totalSells += result.sellCount;

  // The replay lumps everything into netPnl. Let's decompose:
  // netPnl = mergePnl + realizedSellPnl + winPayout + loseLoss
  // But we don't have separate fields for merge vs resolve.
  // realizedSellPnl is from sells during the window
  totalSellPnl += result.realizedSellPnl;
}

// To get merge vs resolve breakdown, we need to modify replayWindow or compute it differently.
// For now, let's look at a few individual windows.

// Count windows with sell events in snapshots
let windowsWithSellEvents = 0;
let totalRecordedSellEvents = 0;
for (const w of windows) {
  let hasSells = false;
  for (const tick of w.ticks) {
    if (tick.sells && tick.sells.length > 0) {
      hasSells = true;
      totalRecordedSellEvents += tick.sells.length;
    }
  }
  if (hasSells) windowsWithSellEvents++;
}
console.log(`Windows with recorded sell events: ${windowsWithSellEvents}/${windows.length} (${totalRecordedSellEvents} total sell events)\n`);

console.log("=== Detailed window-level comparison (first 10 with fills) ===\n");

let shown = 0;
for (const w of windows) {
  const result = replayWindow(w, params);
  if (result.fillCount === 0) continue;
  if (shown >= 10) break;
  shown++;

  const lastTick = w.ticks[w.ticks.length - 1];
  const liveUpInv = lastTick.upInventory;
  const liveDownInv = lastTick.downInventory;
  const liveUpCost = lastTick.upAvgCost;
  const liveDownCost = lastTick.downAvgCost;
  const sellEvts = w.ticks.reduce((n, t) => n + (t.sells?.length ?? 0), 0);

  console.log(`${w.cryptoSymbol} ${w.id.slice(0, 30)} outcome=${w.outcome} dur=${Math.round(w.windowDurationMs / 60000)}min`);
  console.log(`  Fills: ${result.fillCount}  Sells: ${result.sellCount}  Flips: ${result.flipCount}  RecordedSellEvents: ${sellEvts}`);
  console.log(`  Replay inv:  UP=${result.upInventory.toFixed(0)}@$${result.upAvgCost.toFixed(3)}  DN=${result.downInventory.toFixed(0)}@$${result.downAvgCost.toFixed(3)}`);
  console.log(`  Live inv:    UP=${liveUpInv.toFixed(0)}@$${liveUpCost.toFixed(3)}  DN=${liveDownInv.toFixed(0)}@$${liveDownCost.toFixed(3)}`);
  console.log(`  Replay: sellPnl=$${result.realizedSellPnl.toFixed(2)} netPnl=$${result.netPnl.toFixed(2)} buyCost=$${result.totalBuyCost.toFixed(2)}`);
  console.log();
}

// Overall stats
console.log("=== Aggregate ===");
const totalResult = windows.reduce(
  (acc, w) => {
    const r = replayWindow(w, params);
    return {
      netPnl: acc.netPnl + r.netPnl,
      sellPnl: acc.sellPnl + r.realizedSellPnl,
      fillCount: acc.fillCount + r.fillCount,
      sellCount: acc.sellCount + r.sellCount,
      buyCost: acc.buyCost + r.totalBuyCost,
    };
  },
  { netPnl: 0, sellPnl: 0, fillCount: 0, sellCount: 0, buyCost: 0 }
);

console.log(`Total fills: ${totalResult.fillCount}`);
console.log(`Total sells: ${totalResult.sellCount}`);
console.log(`Total buy cost: $${totalResult.buyCost.toFixed(2)}`);
console.log(`Total sell PnL: $${totalResult.sellPnl.toFixed(2)}`);
console.log(`Net PnL: $${totalResult.netPnl.toFixed(2)}`);
console.log(`Implied merge+resolve PnL: $${(totalResult.netPnl - totalResult.sellPnl).toFixed(2)}`);
