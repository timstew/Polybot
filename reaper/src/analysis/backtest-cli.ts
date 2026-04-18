/**
 * Backtest CLI — run strategies against historical data with optional capital budget.
 *
 * Usage:
 *   bun src/analysis/backtest-cli.ts                            # unlimited capital
 *   bun src/analysis/backtest-cli.ts --capital=500              # $500 starting capital
 *   bun src/analysis/backtest-cli.ts --capital=500,1000,5000    # sweep
 *   bun src/analysis/backtest-cli.ts --strategies=bonereaper-mimic
 *   bun src/analysis/backtest-cli.ts --only-resolved
 *   bun src/analysis/backtest-cli.ts --merge-pc=1.00            # merge when pc<=X (default 1.00)
 */

import { initDb, getDb } from "../db.js";
import { backtestAll, summarizeByStrategy } from "./backtest.js";

const args = process.argv.slice(2);
const parseArg = (name: string) => args.find(a => a.startsWith(name + "="))?.slice(name.length + 1);

const stratArg = parseArg("--strategies");
const capitalArg = parseArg("--capital");
const mergePcArg = parseArg("--merge-pc");
const onlyResolved = args.includes("--only-resolved");

const strategies = stratArg
  ? stratArg.split(",").map(s => s.trim())
  : ["hybrid", "bonereaper-ladder", "bonereaper-mimic"];

// Allow sweeping multiple capital amounts
const capitalValues = capitalArg
  ? capitalArg.split(",").map(c => parseFloat(c.trim()))
  : [undefined]; // undefined = unlimited

const mergeThresholdPC = mergePcArg ? parseFloat(mergePcArg) : 1.00;

initDb();

function line(c = "─", n = 115) { return c.repeat(n); }

console.log(`Strategies: ${strategies.join(", ")}`);
console.log(`Capital values to test: ${capitalValues.map(c => c ? "$" + c : "unlimited").join(", ")}`);
console.log(`Merge threshold: pair_cost <= $${mergeThresholdPC.toFixed(3)}`);
console.log(`Filter: ${onlyResolved ? "only RESOLVED windows" : "all windows with data"}\n`);

// Reference: BR's actual behavior
const db = getDb();
const brSlugsStmt = db.prepare(`
  SELECT DISTINCT w.slug FROM windows w
  WHERE EXISTS (SELECT 1 FROM window_ticks WHERE window_slug = w.slug)
    AND EXISTS (SELECT 1 FROM shadow_trades WHERE window_slug = w.slug)
    ${onlyResolved ? "AND w.status = 'RESOLVED' AND w.outcome IS NOT NULL" : ""}
`);
const uniqueSlugs = (brSlugsStmt.all() as Array<{ slug: string }>).map(r => r.slug);
let brTotalFills = 0, brTotalSpend = 0;
for (const slug of uniqueSlugs) {
  const s = db.prepare(`
    SELECT COUNT(*) as n, SUM(price * size) as spend
    FROM shadow_trades WHERE window_slug = ? AND buy_sell = 'BUY'
  `).get(slug) as { n: number; spend: number };
  brTotalFills += s.n;
  brTotalSpend += s.spend || 0;
}
console.log(`Reference (BR actual) across ${uniqueSlugs.length} windows:`);
console.log(`  Total fills: ${brTotalFills}  |  Total spend: $${brTotalSpend.toFixed(0)}  |  Avg fills/window: ${(brTotalFills / uniqueSlugs.length).toFixed(1)}\n`);

for (const capital of capitalValues) {
  const label = capital == null ? "UNLIMITED CAPITAL" : `$${capital} STARTING CAPITAL`;
  console.log(line("═"));
  console.log(label + "  (mid-window merges when pair_cost ≤ $" + mergeThresholdPC.toFixed(3) + ")");
  console.log(line("═"));

  const results = backtestAll(strategies, {
    only_resolved: onlyResolved,
    starting_capital: capital,
    merge_threshold_pc: mergeThresholdPC,
  });
  const summary = summarizeByStrategy(results);

  console.log(
    "Strategy".padEnd(22) +
    "fills".padStart(7) +
    "skipped".padStart(9) +
    "avg/win".padStart(9) +
    "1st-fill".padStart(10) +
    "pair-cost".padStart(11) +
    "spend".padStart(10) +
    "mid-merge$".padStart(12) +
    "peak-cap".padStart(10) +
    "max-peak".padStart(10) +
    "total-pnl".padStart(12) +
    "win%".padStart(6)
  );
  console.log(line());

  for (const s of summary.sort((a, b) => b.total_pnl - a.total_pnl)) {
    console.log(
      s.strategy.padEnd(22) +
      String(s.total_fills).padStart(7) +
      String(s.total_skipped_fills).padStart(9) +
      s.avg_fills_per_window.toFixed(1).padStart(9) +
      (s.avg_first_fill_sec.toFixed(0) + "s").padStart(10) +
      (s.avg_pair_cost != null ? "$" + s.avg_pair_cost.toFixed(3) : "—").padStart(11) +
      ("$" + s.total_spend.toFixed(0)).padStart(10) +
      ("$" + s.total_mid_merge_usd.toFixed(0)).padStart(12) +
      ("$" + s.avg_peak_capital.toFixed(0)).padStart(10) +
      ("$" + s.max_peak_capital.toFixed(0)).padStart(10) +
      ("$" + s.total_pnl.toFixed(0)).padStart(12) +
      (s.win_rate_pct.toFixed(0) + "%").padStart(6)
    );
  }
  console.log();
}

console.log(line("═"));
console.log("Columns:");
console.log("  peak-cap  = average per-window max (starting − available) — typical capital lock-up");
console.log("  max-peak  = worst-case single-window peak capital needed across all windows");
console.log("  mid-merge = total $ recycled via mid-window merges (capital freed up)");
console.log("  skipped   = fills we would have gotten but skipped due to capital constraint");
console.log("If skipped > 0, the strategy is capital-constrained at this budget.");
console.log(line("═"));
