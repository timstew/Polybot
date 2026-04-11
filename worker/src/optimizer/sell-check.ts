#!/usr/bin/env npx tsx
/**
 * Check whether recorded snapshots contain sell events.
 * Validates the sell recording fix is working.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { TickSnapshot } from "./types";

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
if (!dbPath) { console.error("No DB found."); process.exit(1); }

const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(
  `SELECT id, crypto_symbol, window_open_time, outcome, ticks
   FROM strategy_snapshots
   WHERE outcome IS NOT NULL AND outcome != 'UNKNOWN'
   ORDER BY window_open_time DESC
   LIMIT 50`
).all() as Array<Record<string, unknown>>;
db.close();

let windowsWithSells = 0;
let windowsWithoutSells = 0;
let totalSellEvents = 0;
let totalFillEvents = 0;

for (const r of rows) {
  const ticks = JSON.parse(r.ticks as string) as TickSnapshot[];
  let hasSells = false;
  for (const tick of ticks) {
    if (tick.fills) totalFillEvents += tick.fills.length;
    if (tick.sells && tick.sells.length > 0) {
      hasSells = true;
      totalSellEvents += tick.sells.length;
    }
  }
  if (hasSells) {
    windowsWithSells++;
    const sellTicks = ticks.filter(t => t.sells && t.sells.length > 0);
    const id = (r.id as string).slice(0, 35);
    console.log(`  ${id} ${r.crypto_symbol} outcome=${r.outcome} sells=${sellTicks.length} ticks with sells`);
    for (const st of sellTicks) {
      for (const s of st.sells!) {
        console.log(`    ${s.side} ${s.size}@$${s.price.toFixed(3)} cost=$${s.costBasis.toFixed(3)} pnl=$${s.pnl.toFixed(2)}`);
      }
    }
  } else {
    windowsWithoutSells++;
  }
}

console.log(`\n=== Summary (last ${rows.length} resolved windows) ===`);
console.log(`Windows with sell events:    ${windowsWithSells}`);
console.log(`Windows without sell events: ${windowsWithoutSells}`);
console.log(`Total fill events:           ${totalFillEvents}`);
console.log(`Total sell events:           ${totalSellEvents}`);
