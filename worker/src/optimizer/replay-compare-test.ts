#!/usr/bin/env npx tsx
/**
 * Comparison test: faithful replay vs simulated replay.
 *
 * Runs both replayWindow() (faithful — replays recorded events) and
 * replayWindowSimulated() (simulated — computes fills from params + tape)
 * on the same snapshots with DEFAULT_PARAMS.
 *
 * Reports:
 * - Fill counts (faithful vs simulated)
 * - PnL difference between modes
 * - Which windows diverge most
 *
 * Usage:
 *   cd worker && npx tsx src/optimizer/replay-compare-test.ts [db-path]
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { replayWindow, replayWindowSimulated } from "./replay";
import type { WindowSnapshot, TickSnapshot } from "./types";
import { DEFAULT_PARAMS, type DirectionalMakerParams } from "../strategies/safe-maker";

// ── Find DB ──

let dbPath = "";
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith("--")) dbPath = arg;
}

if (!dbPath) {
  const candidates = [
    path.join(__dirname, "../../wrangler-data/d1/miniflare-D1DatabaseObject"),
    path.join(__dirname, "../../.wrangler/state/v3/d1/miniflare-D1DatabaseObject"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".sqlite"));
      if (files.length > 0) { dbPath = path.join(dir, files[0]); break; }
    }
  }
}
if (!dbPath) { console.error("No DB found. Specify with: npx tsx replay-compare-test.ts path/to/db.sqlite"); process.exit(1); }

// ── Load snapshots ──

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

if (rows.length === 0) {
  console.log("No resolved windows found. Enable record_snapshots and let it run.");
  process.exit(0);
}

const windows: WindowSnapshot[] = rows.map(r => ({
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

console.log(`Loaded ${windows.length} resolved windows from ${dbPath}\n`);

// ── Run comparison with DEFAULT_PARAMS ──

interface Comparison {
  id: string;
  symbol: string;
  duration: number;
  outcome: string;
  faithfulPnl: number;
  faithfulFills: number;
  faithfulSells: number;
  simPnl: number;
  simFills: number;
  simSells: number;
  simBidPlacements: number;
  pnlDiff: number;
  fillDiff: number;
}

const comparisons: Comparison[] = [];

for (const w of windows) {
  const faithful = replayWindow(w, DEFAULT_PARAMS);
  const simulated = replayWindowSimulated(w, DEFAULT_PARAMS);

  comparisons.push({
    id: w.id.slice(0, 12),
    symbol: w.cryptoSymbol,
    duration: Math.round(w.windowDurationMs / 60_000),
    outcome: w.outcome,
    faithfulPnl: faithful.netPnl,
    faithfulFills: faithful.fillCount,
    faithfulSells: faithful.sellCount,
    simPnl: simulated.netPnl,
    simFills: simulated.simulatedFillCount ?? simulated.fillCount,
    simSells: simulated.simulatedSellCount ?? simulated.sellCount,
    simBidPlacements: simulated.bidPlacementCount ?? 0,
    pnlDiff: simulated.netPnl - faithful.netPnl,
    fillDiff: (simulated.simulatedFillCount ?? simulated.fillCount) - faithful.fillCount,
  });
}

// ── Summary stats ──

const totalFaithfulPnl = comparisons.reduce((s, c) => s + c.faithfulPnl, 0);
const totalSimPnl = comparisons.reduce((s, c) => s + c.simPnl, 0);
const totalFaithfulFills = comparisons.reduce((s, c) => s + c.faithfulFills, 0);
const totalSimFills = comparisons.reduce((s, c) => s + c.simFills, 0);
const totalFaithfulSells = comparisons.reduce((s, c) => s + c.faithfulSells, 0);
const totalSimSells = comparisons.reduce((s, c) => s + c.simSells, 0);

console.log("═".repeat(80));
console.log("SUMMARY: Faithful Replay vs Simulated Replay (DEFAULT_PARAMS)");
console.log("═".repeat(80));
console.log(`Windows:          ${comparisons.length}`);
console.log(`                  ${"Faithful".padStart(12)} ${"Simulated".padStart(12)} ${"Diff".padStart(12)}`);
console.log(`Total PnL:        $${totalFaithfulPnl.toFixed(2).padStart(11)} $${totalSimPnl.toFixed(2).padStart(11)} $${(totalSimPnl - totalFaithfulPnl).toFixed(2).padStart(11)}`);
console.log(`Total Fills:      ${String(totalFaithfulFills).padStart(12)} ${String(totalSimFills).padStart(12)} ${String(totalSimFills - totalFaithfulFills).padStart(12)}`);
console.log(`Total Sells:      ${String(totalFaithfulSells).padStart(12)} ${String(totalSimSells).padStart(12)} ${String(totalSimSells - totalFaithfulSells).padStart(12)}`);
console.log(`Mean PnL:         $${(totalFaithfulPnl / comparisons.length).toFixed(2).padStart(11)} $${(totalSimPnl / comparisons.length).toFixed(2).padStart(11)}`);

// Fill ratio
const fillRatio = totalFaithfulFills > 0 ? totalSimFills / totalFaithfulFills : 0;
console.log(`\nFill ratio (sim/faithful): ${fillRatio.toFixed(2)}x`);
if (fillRatio > 0.7 && fillRatio < 1.3) {
  console.log("  ✓ Within ±30% — simulation quality looks reasonable");
} else {
  console.log("  ⚠ Outside ±30% — investigate tape data quality");
}

// ── Top diverging windows ──

const sorted = [...comparisons].sort((a, b) => Math.abs(b.pnlDiff) - Math.abs(a.pnlDiff));

console.log(`\n${"─".repeat(80)}`);
console.log("Top 10 most divergent windows (by |PnL difference|):");
console.log(`${"─".repeat(80)}`);
console.log(
  `${"ID".padEnd(14)} ${"Symbol".padEnd(8)} ${"Dur".padStart(4)} ${"Out".padStart(4)} ` +
  `${"F-PnL".padStart(8)} ${"S-PnL".padStart(8)} ${"Diff".padStart(8)} ` +
  `${"F-Fill".padStart(7)} ${"S-Fill".padStart(7)} ${"Bids".padStart(5)}`
);

for (const c of sorted.slice(0, 10)) {
  console.log(
    `${c.id.padEnd(14)} ${c.symbol.padEnd(8)} ${(c.duration + "m").padStart(4)} ${c.outcome.padStart(4)} ` +
    `$${c.faithfulPnl.toFixed(2).padStart(7)} $${c.simPnl.toFixed(2).padStart(7)} $${c.pnlDiff.toFixed(2).padStart(7)} ` +
    `${String(c.faithfulFills).padStart(7)} ${String(c.simFills).padStart(7)} ${String(c.simBidPlacements).padStart(5)}`
  );
}

// ── Extreme params test ──

console.log(`\n${"═".repeat(80)}`);
console.log("SENSITIVITY TEST: Extreme params should produce different results");
console.log("═".repeat(80));

const tinyBid: DirectionalMakerParams = { ...DEFAULT_PARAMS, base_bid_size: 1 };
const largeBid: DirectionalMakerParams = { ...DEFAULT_PARAMS, base_bid_size: 100 };
const tightPairCost: DirectionalMakerParams = { ...DEFAULT_PARAMS, max_pair_cost: 0.80 };

const configs = [
  { label: "DEFAULT_PARAMS", params: DEFAULT_PARAMS },
  { label: "base_bid_size=1", params: tinyBid },
  { label: "base_bid_size=100", params: largeBid },
  { label: "max_pair_cost=0.80", params: tightPairCost },
];

for (const cfg of configs) {
  let totalPnl = 0;
  let totalFills = 0;
  for (const w of windows) {
    const result = replayWindowSimulated(w, cfg.params);
    totalPnl += result.netPnl;
    totalFills += result.fillCount;
  }
  const meanPnl = totalPnl / windows.length;
  console.log(
    `  ${cfg.label.padEnd(25)} total=$${totalPnl.toFixed(2).padStart(8)}  mean=$${meanPnl.toFixed(2).padStart(7)}  fills=${totalFills}`
  );
}

const defaultResult = configs[0];
const tinyResult = configs[1];
if (defaultResult && tinyResult) {
  // Verify that different params give different results
  let defaultTotal = 0, tinyTotal = 0;
  for (const w of windows) {
    defaultTotal += replayWindowSimulated(w, DEFAULT_PARAMS).fillCount;
    tinyTotal += replayWindowSimulated(w, tinyBid).fillCount;
  }
  if (defaultTotal !== tinyTotal) {
    console.log("\n  ✓ Different params produce different fill counts — simulation is working");
  } else {
    console.log("\n  ⚠ Same fill counts with different params — check simulation logic");
  }
}

console.log("\nDone.");
