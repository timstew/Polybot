/**
 * Bonereaper tick-aligned analysis CLI.
 *
 * Usage:
 *   bun src/analysis/analyze-bonereaper.ts              # full report
 *   bun src/analysis/analyze-bonereaper.ts --slug=btc-updown-5m-1776339300  # single window
 *   bun src/analysis/analyze-bonereaper.ts --json       # machine-readable
 */

import { initDb } from "../db.js";
import { buildReport, joinTradesWithTicks, findCheapSweeps } from "./tick-aligned.js";

// Parse args
const args = process.argv.slice(2);
const slug = args.find(a => a.startsWith("--slug="))?.slice(7);
const asJson = args.includes("--json");

initDb();

const filters: Parameters<typeof buildReport>[0] = {};
if (slug) filters.window_slug = slug;

const report = buildReport(filters);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// Pretty print
function line(char = "─", n = 68) { return char.repeat(n); }
function section(title: string) { console.log("\n" + line("═") + "\n" + title + "\n" + line("═")); }
function sub(title: string) { console.log("\n" + title + "\n" + line()); }

section("BONEREAPER TICK-ALIGNED ANALYSIS");
console.log(`Window filter: ${slug || "(all)"}`);
console.log(`Trades joined:  ${report.dataset.total_trades}`);
console.log(`Unique windows: ${report.dataset.unique_windows}`);
console.log(`Tick match %:   ${(report.dataset.tick_match_coverage * 100).toFixed(1)}% (avg Δt=${Math.round(report.dataset.avg_tick_dt_ms)}ms)`);

sub("Overall price distribution (BUY trades only)");
console.log("Side    n       avg_px    median    p10      p90      avg_size  total_usd");
for (const side of ["UP", "DOWN"] as const) {
  const s = report.by_side[side];
  if (!s) continue;
  console.log(
    side.padEnd(6),
    String(s.n).padStart(6),
    ("$" + s.avg_price.toFixed(3)).padStart(8),
    ("$" + s.median_price.toFixed(3)).padStart(8),
    ("$" + s.p10_price.toFixed(3)).padStart(8),
    ("$" + s.p90_price.toFixed(3)).padStart(8),
    s.avg_size.toFixed(1).padStart(7),
    ("$" + s.total_usd.toFixed(0)).padStart(10),
  );
}

sub("Buy price by time-in-window (elapsed %)");
console.log("Bucket           n       avg_px    median    p10      p90      avg_size");
for (const b of report.by_elapsed) {
  console.log(
    b.bucket.padEnd(16),
    String(b.n).padStart(6),
    ("$" + b.avg_price.toFixed(3)).padStart(8),
    ("$" + b.median_price.toFixed(3)).padStart(8),
    ("$" + b.p10_price.toFixed(3)).padStart(8),
    ("$" + b.p90_price.toFixed(3)).padStart(8),
    b.avg_size.toFixed(1).padStart(7),
  );
}

sub("Buy price by P_true (market's fair-value estimate)");
console.log("Bucket    n      avg_px    median    p10      p90");
for (const b of report.by_p_true) {
  console.log(
    b.bucket.padEnd(9),
    String(b.n).padStart(6),
    ("$" + b.avg_price.toFixed(3)).padStart(8),
    ("$" + b.median_price.toFixed(3)).padStart(8),
    ("$" + b.p10_price.toFixed(3)).padStart(8),
    ("$" + b.p90_price.toFixed(3)).padStart(8),
  );
}

sub("Joint: side × elapsed (reveals directional bias over time)");
console.log("Bucket                n       avg_px    median    avg_size");
for (const b of report.by_side_and_elapsed) {
  console.log(
    b.bucket.padEnd(20),
    String(b.n).padStart(6),
    ("$" + b.avg_price.toFixed(3)).padStart(8),
    ("$" + b.median_price.toFixed(3)).padStart(8),
    b.avg_size.toFixed(1).padStart(8),
  );
}

sub("Buy aggressiveness: price vs best ask at time of trade");
console.log("Range                 n       avg_px    avg_size");
for (const b of report.by_price_vs_ask) {
  console.log(
    b.bucket.padEnd(20),
    String(b.n).padStart(6),
    ("$" + b.avg_price.toFixed(3)).padStart(8),
    b.avg_size.toFixed(1).padStart(8),
  );
}

sub("Cheap sweeps (BR buys at < $0.20 when other side >30pp above fair)");
console.log(`Total sweeps: ${report.cheap_sweeps.count}`);
console.log(`Total USD spent on sweeps: $${report.cheap_sweeps.total_usd.toFixed(0)}`);
if (report.cheap_sweeps.count > 0) {
  const sp = report.patterns.sweep_price_distribution;
  const se = report.patterns.sweep_elapsed_distribution;
  console.log(`Sweep price distribution: p10=$${sp.p10.toFixed(3)} p50=$${sp.p50.toFixed(3)} p90=$${sp.p90.toFixed(3)}`);
  console.log(`Sweep elapsed distribution: p10=${(se.p10*100).toFixed(0)}% p50=${(se.p50*100).toFixed(0)}% p90=${(se.p90*100).toFixed(0)}%`);
  console.log("\nExamples:");
  console.log("  window                          time (utc)          side  price    size   fair   elapsed%");
  for (const ex of report.cheap_sweeps.examples) {
    console.log(
      "  " + ex.slug.slice(-28).padEnd(28),
      ex.time.slice(11, 19),
      "         ",
      ex.side.padEnd(5),
      ("$" + ex.price.toFixed(3)).padStart(7),
      ex.size.toFixed(1).padStart(6),
      ex.fair.toFixed(3).padStart(6),
      ((ex.elapsed_pct * 100).toFixed(0) + "%").padStart(6),
    );
  }
}

sub("Typical entry price: side × phase (EARLY/MID/LATE)");
console.log("Key              phase   median   n");
for (const [k, v] of Object.entries(report.patterns.typical_entry_price_by_side_and_phase)) {
  console.log(
    k.padEnd(15),
    v.phase.padEnd(6),
    ("$" + v.median.toFixed(3)).padStart(7),
    String(v.n).padStart(5),
  );
}

section("DONE");
