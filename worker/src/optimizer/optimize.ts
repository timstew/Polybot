#!/usr/bin/env npx tsx
/**
 * Strategy Parameter Optimizer
 *
 * Standalone Node.js script that reads recorded window snapshots from D1 SQLite,
 * runs Tree of Parzen Estimators (TPE) optimization over strategy parameters,
 * and outputs the best parameter sets by Sharpe ratio.
 *
 * Usage:
 *   cd worker && npx tsx src/optimizer/optimize.ts
 *   cd worker && npx tsx src/optimizer/optimize.ts --iterations 5000
 *   cd worker && npx tsx src/optimizer/optimize.ts --db path/to/d1.sqlite
 *   cd worker && npx tsx src/optimizer/optimize.ts --objective sortino
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { replayWindow } from "./replay";
import type { WindowSnapshot } from "./types";
import type { DirectionalMakerParams } from "../strategies/safe-maker";
import { DEFAULT_PARAMS } from "../strategies/safe-maker";

// ── CLI args ──

type ObjectiveType = "sharpe" | "sortino";

function parseArgs() {
  const args = process.argv.slice(2);
  let iterations = 2000;
  let dbPath = "";
  let holdoutPct = 0.20;
  let objective: ObjectiveType = "sharpe";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--iterations" && args[i + 1]) {
      iterations = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--db" && args[i + 1]) {
      dbPath = args[i + 1];
      i++;
    } else if (args[i] === "--holdout" && args[i + 1]) {
      holdoutPct = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === "--objective" && args[i + 1]) {
      const val = args[i + 1].toLowerCase();
      if (val === "sharpe" || val === "sortino") {
        objective = val;
      } else {
        console.error(`Unknown objective: ${val}. Use "sharpe" or "sortino".`);
        process.exit(1);
      }
      i++;
    }
  }

  // Auto-detect D1 SQLite path (wrangler dev --persist-to)
  if (!dbPath) {
    const candidates = [
      path.join(__dirname, "../../wrangler-data/d1/miniflare-D1DatabaseObject"),
      path.join(__dirname, "../../.wrangler/state/v3/d1/miniflare-D1DatabaseObject"),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => f.endsWith(".sqlite"));
        if (files.length > 0) {
          dbPath = path.join(dir, files[0]);
          break;
        }
      }
    }
  }

  if (!dbPath) {
    console.error("ERROR: Could not find D1 SQLite database.");
    console.error("Specify with: --db path/to/database.sqlite");
    console.error("Or ensure wrangler-data/ exists from running dev.sh");
    process.exit(1);
  }

  return { iterations, dbPath, holdoutPct, objective };
}

// ── Load snapshots ──

function loadSnapshots(dbPath: string): WindowSnapshot[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT id, crypto_symbol, window_open_time, window_end_time, window_duration_ms,
            oracle_strike, price_at_open, hour_utc, day_of_week,
            up_token_id, down_token_id, outcome, ticks
     FROM strategy_snapshots
     WHERE outcome IS NOT NULL AND outcome != 'UNKNOWN'
     ORDER BY window_open_time`
  ).all() as Array<{
    id: string;
    crypto_symbol: string;
    window_open_time: number;
    window_end_time: number;
    window_duration_ms: number;
    oracle_strike: number | null;
    price_at_open: number;
    hour_utc: number;
    day_of_week: number;
    up_token_id: string;
    down_token_id: string;
    outcome: string;
    ticks: string;
  }>;
  db.close();

  return rows.map(r => ({
    id: r.id,
    cryptoSymbol: r.crypto_symbol,
    windowOpenTime: r.window_open_time,
    windowEndTime: r.window_end_time,
    windowDurationMs: r.window_duration_ms,
    oracleStrike: r.oracle_strike,
    outcome: r.outcome as "UP" | "DOWN",
    priceAtWindowOpen: r.price_at_open,
    hourUtc: r.hour_utc,
    dayOfWeek: r.day_of_week,
    upTokenId: r.up_token_id,
    downTokenId: r.down_token_id,
    ticks: JSON.parse(r.ticks) as TickSnapshot[],
  }));
}

// ── Parameter search space ──

interface ParamSpec {
  name: keyof DirectionalMakerParams;
  type: "continuous" | "integer" | "boolean";
  min?: number;
  max?: number;
}

const SEARCH_SPACE: ParamSpec[] = [
  { name: "bid_offset", type: "continuous", min: 0.01, max: 0.06 },
  { name: "max_pair_cost", type: "continuous", min: 0.88, max: 0.96 },
  { name: "conviction_bias", type: "continuous", min: 1.0, max: 3.0 },
  { name: "min_signal_strength", type: "continuous", min: 0.30, max: 0.70 },
  { name: "base_bid_size", type: "integer", min: 5, max: 60 },
  { name: "max_flips_per_window", type: "integer", min: 1, max: 5 },
  { name: "max_inventory_ratio", type: "continuous", min: 1.5, max: 4.0 },
  { name: "max_bid_per_side", type: "continuous", min: 0.35, max: 0.55 },
  { name: "vol_offset_scale_high", type: "continuous", min: 1.0, max: 2.5 },
  { name: "vol_offset_scale_low", type: "continuous", min: 0.3, max: 1.0 },
  { name: "tighten_start_pct", type: "continuous", min: 0.50, max: 0.90 },
  { name: "dead_zone_pct", type: "continuous", min: 0, max: 0.05 },
  { name: "sell_excess", type: "boolean" },
];

// ── Sample parameters ──

function sampleRandom(): Partial<DirectionalMakerParams> {
  const params: Record<string, number | boolean> = {};
  for (const spec of SEARCH_SPACE) {
    if (spec.type === "boolean") {
      params[spec.name] = Math.random() < 0.5;
    } else if (spec.type === "integer") {
      params[spec.name] = Math.round(spec.min! + Math.random() * (spec.max! - spec.min!));
    } else {
      params[spec.name] = spec.min! + Math.random() * (spec.max! - spec.min!);
    }
  }
  return params as unknown as Partial<DirectionalMakerParams>;
}

/** Sample from kernel density estimate of good samples (simple TPE) */
function sampleFromGood(goodSamples: Record<string, number | boolean>[]): Partial<DirectionalMakerParams> {
  const params: Record<string, number | boolean> = {};
  // Pick a random good sample, then perturb it
  const base = goodSamples[Math.floor(Math.random() * goodSamples.length)];

  for (const spec of SEARCH_SPACE) {
    const baseVal = base[spec.name];
    if (spec.type === "boolean") {
      // Flip with 20% probability
      params[spec.name] = Math.random() < 0.20 ? !(baseVal as boolean) : baseVal;
    } else if (spec.type === "integer") {
      const range = spec.max! - spec.min!;
      const bandwidth = range * 0.15; // 15% of range
      const perturbed = (baseVal as number) + (Math.random() - 0.5) * 2 * bandwidth;
      params[spec.name] = Math.round(Math.max(spec.min!, Math.min(spec.max!, perturbed)));
    } else {
      const range = spec.max! - spec.min!;
      const bandwidth = range * 0.15;
      const perturbed = (baseVal as number) + (Math.random() - 0.5) * 2 * bandwidth;
      params[spec.name] = Math.max(spec.min!, Math.min(spec.max!, perturbed));
    }
  }
  return params as unknown as Partial<DirectionalMakerParams>;
}

function mergeParams(overrides: Partial<DirectionalMakerParams>): DirectionalMakerParams {
  return { ...DEFAULT_PARAMS, ...overrides };
}

function paramsToRecord(p: Partial<DirectionalMakerParams>): Record<string, number | boolean> {
  const rec: Record<string, number | boolean> = {};
  for (const spec of SEARCH_SPACE) {
    rec[spec.name] = (p as unknown as Record<string, number | boolean>)[spec.name] ?? (DEFAULT_PARAMS as unknown as Record<string, number | boolean>)[spec.name];
  }
  return rec;
}

// ── Evaluation ──

interface EvalResult {
  objective: number;    // primary objective value (sharpe or sortino)
  sharpe: number;
  sortino: number;
  meanPnl: number;
  stdPnl: number;
  totalPnl: number;
  fillRate: number;
  profitFactor: number;
}

function evaluate(
  windows: WindowSnapshot[],
  params: DirectionalMakerParams,
  objectiveType: ObjectiveType = "sharpe",
): EvalResult {
  const pnls: number[] = [];
  let totalFills = 0;

  for (const snap of windows) {
    const result = replayWindow(snap, params);
    pnls.push(result.netPnl);
    totalFills += result.fillCount;
  }

  if (pnls.length === 0) {
    return { objective: -Infinity, sharpe: -Infinity, sortino: -Infinity,
             meanPnl: 0, stdPnl: 0, totalPnl: 0, fillRate: 0, profitFactor: 0 };
  }

  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance = pnls.reduce((a, p) => a + (p - mean) ** 2, 0) / pnls.length;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? mean / std : (mean > 0 ? Infinity : -Infinity);

  // Sortino: only penalize downside deviation
  const downsideVariance = pnls.reduce((a, p) => {
    const diff = Math.min(0, p - mean);
    return a + diff * diff;
  }, 0) / pnls.length;
  const downsideDev = Math.sqrt(downsideVariance);
  const sortino = downsideDev > 0 ? mean / downsideDev : (mean > 0 ? Infinity : -Infinity);

  // Profit factor: gross wins / gross losses
  const grossWins = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);

  const fillRate = totalFills / pnls.length;
  const objective = objectiveType === "sortino" ? sortino : sharpe;

  return { objective, sharpe, sortino, meanPnl: mean, stdPnl: std,
           totalPnl: mean * pnls.length, fillRate, profitFactor };
}

// ── TPE Optimizer ──

interface Trial {
  params: Partial<DirectionalMakerParams>;
  paramsRec: Record<string, number | boolean>;
  objective: number;
  sharpe: number;
  sortino: number;
  meanPnl: number;
  totalPnl: number;
  fillRate: number;
  profitFactor: number;
}

/** Convergence point: best objective seen at each iteration milestone */
interface ConvergencePoint {
  iteration: number;
  bestObjective: number;
  bestMeanPnl: number;
}

function runTPE(
  windows: WindowSnapshot[],
  iterations: number,
  objectiveType: ObjectiveType,
  label: string = "Global",
): { trials: Trial[]; convergence: ConvergencePoint[] } {
  const trials: Trial[] = [];
  const convergence: ConvergencePoint[] = [];
  const TOP_PCT = 0.20; // top 20% = "good"
  const WARMUP = Math.min(50, Math.floor(iterations * 0.1));

  console.log(`\n  [${label}] Running ${iterations} iterations on ${windows.length} windows (objective: ${objectiveType})...`);

  let bestObjective = -Infinity;
  let bestMeanPnl = 0;

  for (let i = 0; i < iterations; i++) {
    let overrides: Partial<DirectionalMakerParams>;

    if (i < WARMUP || trials.length < 10) {
      // Random exploration
      overrides = sampleRandom();
    } else {
      // TPE: sample from top 20%
      const sorted = [...trials].sort((a, b) => b.objective - a.objective);
      const nGood = Math.max(5, Math.floor(sorted.length * TOP_PCT));
      const goodSamples = sorted.slice(0, nGood).map(t => t.paramsRec);

      // 80% from good, 20% random (exploration)
      overrides = Math.random() < 0.80
        ? sampleFromGood(goodSamples)
        : sampleRandom();
    }

    const params = mergeParams(overrides);
    const result = evaluate(windows, params, objectiveType);

    trials.push({
      params: overrides,
      paramsRec: paramsToRecord(overrides),
      objective: result.objective,
      sharpe: result.sharpe,
      sortino: result.sortino,
      meanPnl: result.meanPnl,
      totalPnl: result.totalPnl,
      fillRate: result.fillRate,
      profitFactor: result.profitFactor,
    });

    // Track convergence
    if (result.objective > bestObjective) {
      bestObjective = result.objective;
      bestMeanPnl = result.meanPnl;
    }

    // Log convergence every 100 iterations
    if ((i + 1) % 100 === 0 || i === 0 || i === iterations - 1) {
      convergence.push({ iteration: i + 1, bestObjective, bestMeanPnl });
    }

    // Progress
    if ((i + 1) % 200 === 0 || i === iterations - 1) {
      console.log(`  [${label}] ${i + 1}/${iterations} — best ${objectiveType}=${bestObjective.toFixed(3)} mean=$${bestMeanPnl.toFixed(2)}`);
    }
  }

  return {
    trials: trials.sort((a, b) => b.objective - a.objective),
    convergence,
  };
}

// ── Time bucketing ──

interface TimeBucket {
  label: string;
  filter: (s: WindowSnapshot) => boolean;
}

function getTimeBuckets(): TimeBucket[] {
  return [
    { label: "Night (0-5 UTC)", filter: s => s.hourUtc >= 0 && s.hourUtc < 6 },
    { label: "Morning (6-11 UTC)", filter: s => s.hourUtc >= 6 && s.hourUtc < 12 },
    { label: "Afternoon (12-17 UTC)", filter: s => s.hourUtc >= 12 && s.hourUtc < 18 },
    { label: "Evening (18-23 UTC)", filter: s => s.hourUtc >= 18 && s.hourUtc < 24 },
    { label: "Weekday", filter: s => s.dayOfWeek >= 1 && s.dayOfWeek <= 5 },
    { label: "Weekend", filter: s => s.dayOfWeek === 0 || s.dayOfWeek === 6 },
  ];
}

function getSymbolBuckets(windows: WindowSnapshot[]): TimeBucket[] {
  const symbols = [...new Set(windows.map(w => w.cryptoSymbol))];
  return symbols.map(sym => ({
    label: sym,
    filter: (s: WindowSnapshot) => s.cryptoSymbol === sym,
  }));
}

function getDurationBuckets(windows: WindowSnapshot[]): TimeBucket[] {
  const durations = [...new Set(windows.map(w => w.windowDurationMs))].sort((a, b) => a - b);
  return durations.map(d => ({
    label: `${Math.round(d / 60_000)}min`,
    filter: (s: WindowSnapshot) => s.windowDurationMs === d,
  }));
}

// ── Output formatting ──

function printTop10(label: string, trials: Trial[], objectiveType: ObjectiveType) {
  console.log(`\n${"═".repeat(80)}`);
  console.log(`Top 10 parameter sets by ${objectiveType} (${label}):`);
  console.log(`${"═".repeat(80)}`);

  const top = trials.slice(0, 10);
  for (let i = 0; i < top.length; i++) {
    const t = top[i];
    const paramStr = SEARCH_SPACE
      .map(s => {
        const v = t.paramsRec[s.name];
        if (s.type === "boolean") return `${s.name}=${v}`;
        if (s.type === "integer") return `${s.name}=${v}`;
        return `${s.name}=${(v as number).toFixed(3)}`;
      })
      .join("  ");
    console.log(
      `#${i + 1}  sharpe=${t.sharpe.toFixed(3)}  sortino=${t.sortino.toFixed(3)}  pf=${t.profitFactor.toFixed(2)}  mean=$${t.meanPnl.toFixed(2)}  total=$${t.totalPnl.toFixed(2)}  fills=${t.fillRate.toFixed(1)}/win`
    );
    console.log(`     ${paramStr}`);
  }
}

function printConvergence(convergence: ConvergencePoint[], objectiveType: ObjectiveType) {
  console.log(`\n── Convergence Curve (${objectiveType}) ──`);
  console.log(`${"Iteration".padStart(10)} ${"Best".padStart(10)} ${"Mean PnL".padStart(10)}`);
  for (const c of convergence) {
    console.log(`${String(c.iteration).padStart(10)} ${c.bestObjective.toFixed(4).padStart(10)} $${c.bestMeanPnl.toFixed(2).padStart(9)}`);
  }
  const first = convergence[0];
  const last = convergence[convergence.length - 1];
  const midIdx = Math.floor(convergence.length / 2);
  const mid = convergence[midIdx];
  const earlyGain = mid.bestObjective - first.bestObjective;
  const lateGain = last.bestObjective - mid.bestObjective;
  if (lateGain > earlyGain * 0.3) {
    console.log(`  Note: Still improving in second half — consider more iterations (--iterations ${last.iteration * 2})`);
  } else if (lateGain < earlyGain * 0.05) {
    console.log(`  Note: Converged early — search space is well-explored`);
  }
}

function printJSON(label: string, trial: Trial) {
  console.log(`\n── Best params as JSON (${label}) ──`);
  const jsonParams: Record<string, unknown> = {};
  for (const spec of SEARCH_SPACE) {
    const v = trial.paramsRec[spec.name];
    if (spec.type === "continuous") {
      jsonParams[spec.name] = Math.round((v as number) * 1000) / 1000;
    } else {
      jsonParams[spec.name] = v;
    }
  }
  console.log(JSON.stringify(jsonParams, null, 2));
}

// ── Main ──

// Minimum windows required for bucketed optimization — below this, the search
// is likely to overfit on noise rather than find real patterns
const MIN_BUCKET_SIZE = 100;

function main() {
  const { iterations, dbPath, holdoutPct, objective } = parseArgs();

  console.log(`Strategy Parameter Optimizer`);
  console.log(`Database: ${dbPath}`);
  console.log(`Iterations: ${iterations}`);
  console.log(`Holdout: ${(holdoutPct * 100).toFixed(0)}% (chronological — last ${(holdoutPct * 100).toFixed(0)}% by time)`);
  console.log(`Objective: ${objective}`);

  // Load snapshots (already sorted by window_open_time)
  const allWindows = loadSnapshots(dbPath);
  console.log(`Loaded ${allWindows.length} window snapshots`);

  if (allWindows.length === 0) {
    console.error("No snapshots found. Enable record_snapshots on a strategy and let it run.");
    process.exit(1);
  }

  // Show data summary
  const symbols = [...new Set(allWindows.map(w => w.cryptoSymbol))];
  const durations = [...new Set(allWindows.map(w => Math.round(w.windowDurationMs / 60_000)))];
  console.log(`Symbols: ${symbols.join(", ")}`);
  console.log(`Durations: ${durations.join(", ")}min`);
  console.log(`Time range: ${new Date(allWindows[0].windowOpenTime).toISOString()} → ${new Date(allWindows[allWindows.length - 1].windowEndTime).toISOString()}`);

  // Chronological train/test split — last N% by time, no temporal leakage
  const holdoutCount = Math.floor(allWindows.length * holdoutPct);
  const trainWindows = allWindows.slice(0, allWindows.length - holdoutCount);
  const testWindows = allWindows.slice(allWindows.length - holdoutCount);

  console.log(`Train: ${trainWindows.length} windows (${new Date(trainWindows[0].windowOpenTime).toISOString()} → ${new Date(trainWindows[trainWindows.length - 1].windowEndTime).toISOString()})`);
  console.log(`Test:  ${testWindows.length} windows (${new Date(testWindows[0].windowOpenTime).toISOString()} → ${new Date(testWindows[testWindows.length - 1].windowEndTime).toISOString()})`);

  // Baseline: evaluate with DEFAULT_PARAMS
  const baseline = evaluate(trainWindows, DEFAULT_PARAMS, objective);
  console.log(`\nBaseline (DEFAULT_PARAMS): ${objective}=${baseline.objective.toFixed(3)} sharpe=${baseline.sharpe.toFixed(3)} sortino=${baseline.sortino.toFixed(3)} pf=${baseline.profitFactor.toFixed(2)} mean=$${baseline.meanPnl.toFixed(2)} total=$${baseline.totalPnl.toFixed(2)}`);

  // Global optimization
  const { trials: globalTrials, convergence: globalConvergence } = runTPE(trainWindows, iterations, objective, "Global");
  printTop10("Global - In-Sample", globalTrials, objective);
  printConvergence(globalConvergence, objective);

  // Out-of-sample validation
  if (testWindows.length >= 5) {
    const best = globalTrials[0];
    const bestParams = mergeParams(best.params);
    const oos = evaluate(testWindows, bestParams, objective);
    const baselineOos = evaluate(testWindows, DEFAULT_PARAMS, objective);

    console.log(`\n── Out-of-Sample Validation (chronological holdout) ──`);
    console.log(`Best params:  ${objective}=${oos.objective.toFixed(3)} sharpe=${oos.sharpe.toFixed(3)} sortino=${oos.sortino.toFixed(3)} pf=${oos.profitFactor.toFixed(2)} mean=$${oos.meanPnl.toFixed(2)} total=$${oos.totalPnl.toFixed(2)}`);
    console.log(`Baseline:     ${objective}=${baselineOos.objective.toFixed(3)} sharpe=${baselineOos.sharpe.toFixed(3)} sortino=${baselineOos.sortino.toFixed(3)} pf=${baselineOos.profitFactor.toFixed(2)} mean=$${baselineOos.meanPnl.toFixed(2)} total=$${baselineOos.totalPnl.toFixed(2)}`);

    const divergence = Math.abs(best.objective - oos.objective) / Math.max(0.01, Math.abs(best.objective));
    if (divergence > 0.5) {
      console.log(`  WARNING: ${objective} divergence ${(divergence * 100).toFixed(0)}% between in-sample and out-of-sample — possible overfitting!`);
    } else {
      console.log(`  ${objective} divergence: ${(divergence * 100).toFixed(0)}% (acceptable)`);
    }

    // Check boundary params — flag if optimal is within 10% of a boundary
    const boundaryWarnings: string[] = [];
    for (const spec of SEARCH_SPACE) {
      if (spec.type === "boolean" || spec.min == null || spec.max == null) continue;
      const val = best.paramsRec[spec.name] as number;
      const range = spec.max - spec.min;
      if (val - spec.min < range * 0.10) {
        boundaryWarnings.push(`${spec.name}=${val.toFixed(3)} (near min ${spec.min})`);
      } else if (spec.max - val < range * 0.10) {
        boundaryWarnings.push(`${spec.name}=${val.toFixed(3)} (near max ${spec.max})`);
      }
    }
    if (boundaryWarnings.length > 0) {
      console.log(`\n  Boundary warning — optimal params near search bounds (consider widening):`);
      for (const w of boundaryWarnings) {
        console.log(`    ${w}`);
      }
    }
  }

  printJSON("Global Best", globalTrials[0]);

  // Time-bucketed analysis
  console.log(`\n${"═".repeat(80)}`);
  console.log(`Time-Bucketed Analysis (min ${MIN_BUCKET_SIZE} windows per bucket)`);
  console.log(`${"═".repeat(80)}`);

  const allBuckets = [
    ...getTimeBuckets(),
    ...getSymbolBuckets(allWindows),
    ...getDurationBuckets(allWindows),
  ];

  const bucketResults: Array<{ label: string; best: Trial; count: number; baselineObjective: number }> = [];

  for (const bucket of allBuckets) {
    const bucketWindows = trainWindows.filter(bucket.filter);
    if (bucketWindows.length < MIN_BUCKET_SIZE) {
      console.log(`  [${bucket.label}] Skipping — only ${bucketWindows.length} windows (need ${MIN_BUCKET_SIZE})`);
      continue;
    }

    // Scale iterations proportionally to bucket size to prevent overfitting thin buckets
    const bucketIterations = Math.min(500, bucketWindows.length * 3);
    const { trials } = runTPE(bucketWindows, bucketIterations, objective, bucket.label);
    const bucketBaseline = evaluate(bucketWindows, DEFAULT_PARAMS, objective);

    bucketResults.push({
      label: bucket.label,
      best: trials[0],
      count: bucketWindows.length,
      baselineObjective: bucketBaseline.objective,
    });
  }

  // Summary table
  if (bucketResults.length > 0) {
    console.log(`\n── Bucket Summary (${objective}) ──`);
    console.log(`${"Bucket".padEnd(25)} ${"N".padStart(4)} ${"Iters".padStart(5)} ${"Baseline".padStart(10)} ${"Optimized".padStart(10)} ${"Improvement".padStart(12)}`);
    console.log(`${"-".repeat(25)} ${"-".repeat(4)} ${"-".repeat(5)} ${"-".repeat(10)} ${"-".repeat(10)} ${"-".repeat(12)}`);

    for (const b of bucketResults) {
      const bucketIters = Math.min(500, b.count * 3);
      const improvement = b.best.objective - b.baselineObjective;
      const pct = b.baselineObjective !== 0 ? ((improvement / Math.abs(b.baselineObjective)) * 100).toFixed(0) : "N/A";
      console.log(
        `${b.label.padEnd(25)} ${String(b.count).padStart(4)} ${String(bucketIters).padStart(5)} ${b.baselineObjective.toFixed(3).padStart(10)} ${b.best.objective.toFixed(3).padStart(10)} ${(improvement >= 0 ? "+" : "") + improvement.toFixed(3).padStart(11)} (${pct}%)`
      );
    }

    // Check if any bucket significantly outperforms global
    const globalBest = globalTrials[0].objective;
    const betterBuckets = bucketResults.filter(b => b.best.objective > globalBest * 1.1);
    if (betterBuckets.length > 0) {
      console.log(`\nBuckets that outperform global params by >10%:`);
      for (const b of betterBuckets) {
        printJSON(b.label, b.best);
      }
    }
  }

  console.log(`\nDone.`);
}

main();
