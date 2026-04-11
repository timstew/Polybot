#!/usr/bin/env npx tsx
/**
 * Test replay accuracy on windows that have recorded sell events.
 * Compare replay inventory + P&L to live inventory at last tick.
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
if (!dbPath) { console.error("No DB found."); process.exit(1); }

const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(
  `SELECT id, crypto_symbol, window_open_time, window_end_time, window_duration_ms,
          oracle_strike, price_at_open, hour_utc, day_of_week,
          up_token_id, down_token_id, outcome, ticks
   FROM strategy_snapshots
   WHERE outcome IS NOT NULL AND outcome != 'UNKNOWN'
     AND ticks LIKE '%"sells":%'
   ORDER BY window_open_time DESC`
).all() as Array<Record<string, unknown>>;
db.close();

if (rows.length === 0) {
  console.log("No resolved windows with sell events yet. Wait for more data.");
  process.exit(0);
}

console.log(`Found ${rows.length} resolved windows with recorded sell events\n`);

const params = { ...DEFAULT_PARAMS };

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

  // Count fill and sell events
  let fillEvents = 0, sellEvents = 0;
  for (const t of ticks) {
    fillEvents += (t.fills?.length ?? 0);
    sellEvents += (t.sells?.length ?? 0);
  }

  const durMin = Math.round(w.windowDurationMs / 60000);
  console.log(`${w.cryptoSymbol} ${w.id.slice(0, 35)} outcome=${w.outcome} dur=${durMin}min`);
  console.log(`  Recorded events: ${fillEvents} fills, ${sellEvents} sells`);
  console.log(`  Replay:  UP=${result.upInventory.toFixed(0)}@$${result.upAvgCost.toFixed(3)}  DN=${result.downInventory.toFixed(0)}@$${result.downAvgCost.toFixed(3)}`);
  console.log(`  Live:    UP=${lastTick.upInventory.toFixed(0)}@$${lastTick.upAvgCost.toFixed(3)}  DN=${lastTick.downInventory.toFixed(0)}@$${lastTick.downAvgCost.toFixed(3)}`);
  console.log(`  Replay PnL: sell=$${result.realizedSellPnl.toFixed(2)} net=$${result.netPnl.toFixed(2)} buyCost=$${result.totalBuyCost.toFixed(2)}`);

  // Compute live-equivalent resolution
  const liveUp = lastTick.upInventory, liveDn = lastTick.downInventory;
  const liveCostU = lastTick.upAvgCost, liveCostD = lastTick.downAvgCost;
  let liveResolve = 0;
  if (w.outcome === "UP" && liveUp > 0) liveResolve += liveUp * (1 - liveCostU);
  if (w.outcome === "UP" && liveDn > 0) liveResolve -= liveDn * liveCostD;
  if (w.outcome === "DOWN" && liveDn > 0) liveResolve += liveDn * (1 - liveCostD);
  if (w.outcome === "DOWN" && liveUp > 0) liveResolve -= liveUp * liveCostU;
  console.log(`  Live resolution estimate: $${liveResolve.toFixed(2)} (from last tick inventory)`);

  // Match check
  const invMatch = result.upInventory === lastTick.upInventory && result.downInventory === lastTick.downInventory;
  console.log(`  Inventory match: ${invMatch ? 'YES ✓' : 'NO ✗'}`);
  console.log();
}
