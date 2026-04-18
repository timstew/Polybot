/**
 * Backtest v2 CLI — runs against real tape_buckets data.
 *
 * Usage:
 *   bun src/analysis/backtest-v2-cli.ts
 *   bun src/analysis/backtest-v2-cli.ts --capital=200
 *   bun src/analysis/backtest-v2-cli.ts --strategies=bonereaper-mimic,bonereaper-hybrid
 */

import { initDb, getDb } from "../db.js";
import { backtestV2All, summarizeV2 } from "./backtest-v2.js";

const args = process.argv.slice(2);
const parseArg = (name: string) => args.find(a => a.startsWith(name + "="))?.slice(name.length + 1);

const stratArg = parseArg("--strategies");
const capitalArg = parseArg("--capital");
const strategies = stratArg ? stratArg.split(",").map(s => s.trim()) : ["bonereaper-mimic", "bonereaper-hybrid"];
const capital = capitalArg ? parseFloat(capitalArg) : undefined;

initDb();

const db = getDb();
const bucketCount = (db.query("SELECT COUNT(*) as n FROM tape_buckets") as any).get().n;
const windowCount = (db.query("SELECT COUNT(DISTINCT window_slug) as n FROM tape_buckets WHERE window_slug IS NOT NULL") as any).get().n;
console.log(`Tape data: ${bucketCount} buckets across ${windowCount} windows\n`);

if (bucketCount === 0) {
  console.log("No tape data yet — let the system run to accumulate tape_buckets.");
  process.exit(0);
}

const results = backtestV2All(strategies, {
  starting_capital: capital,
  only_resolved: true,
  merge_threshold: 1.05,
});

const summary = summarizeV2(results);

console.log("Strategy                Windows  Fills  Maker  Taker   PC      PnL       Avg PnL  Win%   Peak Cap  Mid-Merge");
console.log("─".repeat(110));
for (const s of summary.sort((a, b) => b.total_pnl - a.total_pnl)) {
  console.log(
    s.strategy.padEnd(24),
    String(s.windows).padStart(5),
    String(s.total_fills).padStart(6),
    String(s.maker_fills).padStart(6),
    String(s.taker_fills).padStart(6),
    (s.avg_pair_cost != null ? "$" + s.avg_pair_cost.toFixed(3) : "—").padStart(7),
    ("$" + s.total_pnl.toFixed(2)).padStart(10),
    ("$" + s.avg_pnl.toFixed(2)).padStart(9),
    (s.win_rate.toFixed(0) + "%").padStart(5),
    ("$" + s.avg_peak_cap.toFixed(0)).padStart(10),
    ("$" + s.total_mid_merge.toFixed(0)).padStart(10),
  );
}

// Per-window detail for top strategy
if (results.length > 0) {
  const best = summary.sort((a, b) => b.total_pnl - a.total_pnl)[0];
  const bestResults = results.filter(r => r.strategy === best.strategy).sort((a, b) => b.net_pnl - a.net_pnl);
  console.log(`\nBest 5 / Worst 5 windows for ${best.strategy}:`);
  for (const r of bestResults.slice(0, 5)) {
    console.log(`  ${r.window_slug.slice(-25).padEnd(25)} ${r.outcome?.padEnd(5)} fills=${String(r.total_fills).padStart(3)} pc=${r.pair_cost?.toFixed(3) || "—"}  pnl=$${r.net_pnl.toFixed(2)}`);
  }
  console.log("  ...");
  for (const r of bestResults.slice(-5).reverse()) {
    console.log(`  ${r.window_slug.slice(-25).padEnd(25)} ${r.outcome?.padEnd(5)} fills=${String(r.total_fills).padStart(3)} pc=${r.pair_cost?.toFixed(3) || "—"}  pnl=$${r.net_pnl.toFixed(2)}`);
  }
}
