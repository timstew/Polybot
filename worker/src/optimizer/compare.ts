#!/usr/bin/env npx tsx
/**
 * Compare default vs optimized params by replaying all recorded windows.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { replayWindow } from "./replay";
import type { WindowSnapshot, TickSnapshot } from "./types";
import { DEFAULT_PARAMS } from "../strategies/safe-maker";

// Auto-detect DB
let dbPath = process.argv[2] || "";
if (!dbPath) {
  const candidates = [
    path.join(__dirname, "../../.wrangler/state/v3/d1/miniflare-D1DatabaseObject"),
    path.join(__dirname, "../../wrangler-data/d1/miniflare-D1DatabaseObject"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".sqlite"));
      if (files.length > 0) { dbPath = path.join(dir, files[0]); break; }
    }
  }
}
if (!dbPath) { console.error("No DB found. Pass path as arg."); process.exit(1); }

const db = new Database(dbPath, { readonly: true });

const sql = `SELECT id, crypto_symbol, window_open_time, window_end_time, window_duration_ms,
       oracle_strike, price_at_open, hour_utc, day_of_week,
       up_token_id, down_token_id, outcome, ticks
FROM strategy_snapshots
WHERE outcome IS NOT NULL AND outcome != 'UNKNOWN'
ORDER BY window_open_time`;

const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
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

console.log(`Loaded ${windows.length} resolved windows`);

const optimized = {
  bid_offset: 0.054,
  max_pair_cost: 0.906,
  conviction_bias: 3,
  min_signal_strength: 0.3,
  base_bid_size: 49,
  max_flips_per_window: 1,
  max_inventory_ratio: 3.368,
  max_bid_per_side: 0.456,
  vol_offset_scale_high: 1.396,
  vol_offset_scale_low: 0.385,
  tighten_start_pct: 0.76,
  dead_zone_pct: 0.026,
  sell_excess: false,
};

const defaultParams = { ...DEFAULT_PARAMS };
const optimizedParams = { ...DEFAULT_PARAMS, ...optimized };

let defTotal = 0, optTotal = 0;
let defWins = 0, optWins = 0;
let defFills = 0, optFills = 0;
const defPnls: number[] = [];
const optPnls: number[] = [];

for (const w of windows) {
  const def = replayWindow(w, defaultParams);
  const opt = replayWindow(w, optimizedParams);
  defTotal += def.netPnl;
  optTotal += opt.netPnl;
  defFills += def.fillCount;
  optFills += opt.fillCount;
  defPnls.push(def.netPnl);
  optPnls.push(opt.netPnl);
  if (def.netPnl > 0) defWins++;
  if (opt.netPnl > 0) optWins++;
}

const hours = (windows[windows.length - 1].windowEndTime - windows[0].windowOpenTime) / 3600000;

const pad = (s: string, n: number) => s.padStart(n);

console.log(`\n=== Replay comparison: ${windows.length} windows over ${hours.toFixed(1)} hours ===\n`);
console.log(`                  Default     Optimized    Delta`);
console.log(`Total PnL:     $${pad(defTotal.toFixed(2), 9)}   $${pad(optTotal.toFixed(2), 9)}   $${pad((optTotal - defTotal).toFixed(2), 9)}`);
console.log(`Per window:    $${pad((defTotal / windows.length).toFixed(2), 9)}   $${pad((optTotal / windows.length).toFixed(2), 9)}   $${pad(((optTotal - defTotal) / windows.length).toFixed(2), 9)}`);
console.log(`Per hour:      $${pad((defTotal / hours).toFixed(2), 9)}   $${pad((optTotal / hours).toFixed(2), 9)}   $${pad(((optTotal - defTotal) / hours).toFixed(2), 9)}`);
console.log(`Win rate:       ${pad((defWins / windows.length * 100).toFixed(1), 8)}%   ${pad((optWins / windows.length * 100).toFixed(1), 8)}%`);
console.log(`Fills:          ${pad(String(defFills), 9)}   ${pad(String(optFills), 9)}`);
console.log(`Fills/window:   ${pad((defFills / windows.length).toFixed(1), 9)}   ${pad((optFills / windows.length).toFixed(1), 9)}`);

// Breakdown by duration
const durations = [...new Set(windows.map(w => w.windowDurationMs))].sort((a, b) => a - b);
console.log(`\n--- By window duration ---`);
for (const dur of durations) {
  const subset = windows.filter(w => w.windowDurationMs === dur);
  let dDef = 0, dOpt = 0;
  for (const w of subset) {
    dDef += replayWindow(w, defaultParams).netPnl;
    dOpt += replayWindow(w, optimizedParams).netPnl;
  }
  const durMin = Math.round(dur / 60000);
  console.log(`  ${durMin}min (${subset.length}w): default=$${dDef.toFixed(2)}  optimized=$${dOpt.toFixed(2)}  delta=$${(dOpt - dDef).toFixed(2)}`);
}
