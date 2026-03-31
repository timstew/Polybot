#!/usr/bin/env npx tsx
/**
 * Comprehensive replay accuracy test.
 * Tests ALL resolved windows — with or without sell events.
 * Optionally filters by window open time to test only "new" data.
 *
 * Usage:
 *   npx tsx src/optimizer/replay-accuracy-test.ts [db-path] [--since=EPOCH_MS]
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { replayWindow } from "./replay";
import type { WindowSnapshot, TickSnapshot } from "./types";
import { DEFAULT_PARAMS } from "../strategies/safe-maker";

let dbPath = "";
let sinceMs = 0;

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--since=")) {
    sinceMs = parseInt(arg.slice(8), 10);
  } else if (!arg.startsWith("--")) {
    dbPath = arg;
  }
}

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
if (!dbPath) { console.error("No DB found."); process.exit(1); }

const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(
  `SELECT id, crypto_symbol, window_open_time, window_end_time, window_duration_ms,
          oracle_strike, price_at_open, hour_utc, day_of_week,
          up_token_id, down_token_id, outcome, ticks
   FROM strategy_snapshots
   WHERE outcome IS NOT NULL AND outcome != 'UNKNOWN'
     AND window_open_time > ?
   ORDER BY window_open_time DESC`
).all(sinceMs) as Array<Record<string, unknown>>;
db.close();

if (rows.length === 0) {
  console.log(`No resolved windows found${sinceMs ? ` since ${new Date(sinceMs).toISOString()}` : ""}. Wait for more data.`);
  process.exit(0);
}

console.log(`Testing ${rows.length} resolved windows${sinceMs ? ` (since ${new Date(sinceMs).toISOString()})` : ""}\n`);

const params = { ...DEFAULT_PARAMS };

let matchCount = 0;
let mismatchCount = 0;
let totalPnlDiff = 0;
const mismatches: string[] = [];

for (const r of rows) {
  const ticks = JSON.parse(r.ticks as string) as TickSnapshot[];
  const w: WindowSnapshot = {
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
    ticks,
  };

  const result = replayWindow(w, params);
  const lastTick = ticks[ticks.length - 1];

  // Count recorded events
  let fillEvents = 0, sellEvents = 0;
  for (const t of ticks) {
    fillEvents += (t.fills?.length ?? 0);
    sellEvents += (t.sells?.length ?? 0);
  }

  const upMatch = Math.abs(result.upInventory - lastTick.upInventory) < 0.5;
  const dnMatch = Math.abs(result.downInventory - lastTick.downInventory) < 0.5;
  const invMatch = upMatch && dnMatch;

  // Compute live PnL estimate for comparison
  const liveUp = lastTick.upInventory, liveDn = lastTick.downInventory;
  const liveCostU = lastTick.upAvgCost, liveCostD = lastTick.downAvgCost;
  let liveResolve = 0;
  if (w.outcome === "UP" && liveUp > 0) liveResolve += liveUp * (1 - liveCostU);
  if (w.outcome === "UP" && liveDn > 0) liveResolve -= liveDn * liveCostD;
  if (w.outcome === "DOWN" && liveDn > 0) liveResolve += liveDn * (1 - liveCostD);
  if (w.outcome === "DOWN" && liveUp > 0) liveResolve -= liveUp * liveCostU;

  const pnlDiff = Math.abs(result.netPnl - liveResolve);
  totalPnlDiff += pnlDiff;

  if (invMatch) {
    matchCount++;
  } else {
    mismatchCount++;
    const durMin = Math.round(w.windowDurationMs / 60000);
    mismatches.push(
      `${w.cryptoSymbol} ${w.id.slice(0, 30)} outcome=${w.outcome} dur=${durMin}min fills=${fillEvents} sells=${sellEvents}\n` +
      `  Replay: UP=${result.upInventory.toFixed(0)}@$${result.upAvgCost.toFixed(3)} DN=${result.downInventory.toFixed(0)}@$${result.downAvgCost.toFixed(3)}\n` +
      `  Live:   UP=${lastTick.upInventory.toFixed(0)}@$${lastTick.upAvgCost.toFixed(3)} DN=${lastTick.downInventory.toFixed(0)}@$${lastTick.downAvgCost.toFixed(3)}\n` +
      `  PnL: replay=$${result.netPnl.toFixed(2)} live=$${liveResolve.toFixed(2)} diff=$${pnlDiff.toFixed(2)}`
    );
  }
}

const total = matchCount + mismatchCount;
const pct = ((matchCount / total) * 100).toFixed(1);
console.log(`=== RESULTS ===`);
console.log(`Match:    ${matchCount}/${total} (${pct}%)`);
console.log(`Mismatch: ${mismatchCount}/${total}`);
console.log(`Avg PnL diff: $${(totalPnlDiff / total).toFixed(2)}`);

if (mismatches.length > 0) {
  console.log(`\n=== MISMATCHES (showing first 15) ===\n`);
  for (const m of mismatches.slice(0, 15)) {
    console.log(m + "\n");
  }
}
