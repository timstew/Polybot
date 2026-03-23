/**
 * One-time migration: convert old raw-tape snapshots to compact bucket format.
 * Reads strategy_snapshots from local D1 SQLite, converts each tick's
 * `tape` (200 TradeTapeEntry[]) → `tapeBuckets` + `tapeMeta`, then updates in place.
 *
 * Usage: cd worker && npx tsx src/optimizer/migrate-tape.ts [--db path]
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

interface OldTick {
  tape?: Array<{ asset: string; price: number; size: number; timestamp: number; taker?: string }>;
  tapeBuckets?: Array<{ tokenId: string; price: number; size: number }>;
  tapeMeta?: { totalTrades: number; totalVolume: number; uniqueWallets: number };
  // old fields to remove
  uniqueWallets?: number;
  tapeVolume?: number;
  tapeTradeCount?: number;
  avgTradeSize?: number;
  [key: string]: unknown;
}

function findDb(cliPath?: string): string {
  if (cliPath) return cliPath;
  const candidates = [
    ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
    "wrangler-data/d1/miniflare-D1DatabaseObject",
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sqlite") && !f.includes("shm") && !f.includes("wal"));
    if (files.length > 0) return path.join(dir, files[0]);
  }
  throw new Error("Cannot find D1 SQLite — pass --db <path>");
}

const args = process.argv.slice(2);
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : undefined;

const db = new Database(findDb(dbPath));

const rows = db.prepare("SELECT id, ticks FROM strategy_snapshots").all() as Array<{ id: string; ticks: string }>;

console.log(`Found ${rows.length} snapshots to check`);

let migrated = 0;
let skipped = 0;
let totalOldBytes = 0;
let totalNewBytes = 0;

const update = db.prepare("UPDATE strategy_snapshots SET ticks = ? WHERE id = ?");

const txn = db.transaction(() => {
  for (const row of rows) {
    const ticks: OldTick[] = JSON.parse(row.ticks);
    if (!ticks.length) { skipped++; continue; }

    // Check if already migrated (first tick has tapeBuckets)
    if (ticks[0].tapeBuckets) { skipped++; continue; }
    if (!ticks[0].tape) { skipped++; continue; }

    totalOldBytes += row.ticks.length;

    for (const tick of ticks) {
      const tape = tick.tape ?? [];

      // Build volume buckets per token×price
      const bucketMap = new Map<string, number>();
      const walletSet = new Set<string>();
      let totalVol = 0;
      for (const t of tape) {
        if (t.taker) walletSet.add(t.taker);
        totalVol += t.size * t.price;
        const roundedPrice = Math.round(t.price * 100) / 100;
        const key = `${t.asset}:${roundedPrice}`;
        bucketMap.set(key, (bucketMap.get(key) ?? 0) + t.size);
      }

      const tapeBuckets: Array<{ tokenId: string; price: number; size: number }> = [];
      for (const [key, size] of bucketMap) {
        const sep = key.lastIndexOf(":");
        tapeBuckets.push({
          tokenId: key.slice(0, sep),
          price: parseFloat(key.slice(sep + 1)),
          size,
        });
      }

      tick.tapeBuckets = tapeBuckets;
      tick.tapeMeta = {
        totalTrades: tape.length,
        totalVolume: totalVol,
        uniqueWallets: walletSet.size,
      };

      // Remove old fields
      delete tick.tape;
      delete tick.uniqueWallets;
      delete tick.tapeVolume;
      delete tick.tapeTradeCount;
      delete tick.avgTradeSize;
    }

    const newJson = JSON.stringify(ticks);
    totalNewBytes += newJson.length;
    update.run(newJson, row.id);
    migrated++;
  }
});

txn();

console.log(`Migrated: ${migrated}, Skipped: ${skipped}`);
if (migrated > 0) {
  const reduction = ((1 - totalNewBytes / totalOldBytes) * 100).toFixed(1);
  console.log(`Size: ${(totalOldBytes / 1024 / 1024).toFixed(1)} MB → ${(totalNewBytes / 1024 / 1024).toFixed(1)} MB (${reduction}% reduction)`);
}

// Reclaim space
db.exec("VACUUM");
console.log("VACUUMed database");

db.close();
