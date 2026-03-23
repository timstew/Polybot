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
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { replayWindow } from "./replay";
import type { WindowSnapshot, TickSnapshot, ReplayResult } from "./types";
import type { DirectionalMakerParams } from "../strategies/safe-maker";
import { DEFAULT_PARAMS } from "../strategies/safe-maker";

// ── CLI args ──

function parseArgs() {
  const args = process.argv.slice(2);
  let iterations = 2000;
  let dbPath = "";
  let holdoutPct = 0.20;

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

  return { iterations, dbPath, holdoutPct };
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

function evaluate(
  windows: WindowSnapshot[],
  params: DirectionalMakerParams,
): { sharpe: number; meanPnl: number; stdPnl: number; totalPnl: number; fillRate: number } {
  const pnls: number[] = [];
  let totalFills = 0;

  for (const snap of windows) {
    const result = replayWindow(snap, params);
    pnls.push(result.netPnl);
    totalFills += result.fillCount;
  }

  if (pnls.length === 0) return { sharpe: -Infinity, meanPnl: 0, stdPnl: 0, totalPnl: 0, fillRate: 0 };

  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance = pnls.reduce((a, p) => a + (p - mean) ** 2, 0) / pnls.length;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? mean / std : (mean > 0 ? Infinity : -Infinity);
  const fillRate = totalFills / pnls.length;

  return { sharpe, meanPnl: mean, stdPnl: std, totalPnl: mean * pnls.length, fillRate };
}

// ── TPE Optimizer ──

interface Trial {
  params: Partial<DirectionalMakerParams>;
  paramsRec: Record<string, number | boolean>;
  sharpe: number;
  meanPnl: number;
  totalPnl: number;
  fillRate: number;
}

function runTPE(
  windows: WindowSnapshot[],
  iterations: number,
  label: string = "Global",
): Trial[] {
  const trials: Trial[] = [];
  const TOP_PCT = 0.20; // top 20% = "good"
  const WARMUP = Math.min(50, Math.floor(iterations * 0.1));

  console.log(`\n  [${label}] Running ${iterations} iterations on ${windows.length} windows...`);

  for (let i = 0; i < iterations; i++) {
    let overrides: Partial<DirectionalMakerParams>;

    if (i < WARMUP || trials.length < 10) {
      // Random exploration
      overrides = sampleRandom();
    } else {
      // TPE: sample from top 20%
      const sorted = [...trials].sort((a, b) => b.sharpe - a.sharpe);
      const nGood = Math.max(5, Math.floor(sorted.length * TOP_PCT));
      const goodSamples = sorted.slice(0, nGood).map(t => t.paramsRec);

      // 80% from good, 20% random (exploration)
      overrides = Math.random() < 0.80
        ? sampleFromGood(goodSamples)
        : sampleRandom();
    }

    const params = mergeParams(overrides);
    const result = evaluate(windows, params);

    trials.push({
      params: overrides,
      paramsRec: paramsToRecord(overrides),
      sharpe: result.sharpe,
      meanPnl: result.meanPnl,
      totalPnl: result.totalPnl,
      fillRate: result.fillRate,
    });

    // Progress
    if ((i + 1) % 200 === 0 || i === iterations - 1) {
      const best = [...trials].sort((a, b) => b.sharpe - a.sharpe)[0];
      console.log(`  [${label}] ${i + 1}/${iterations} — best sharpe=${best.sharpe.toFixed(3)} mean=$${best.meanPnl.toFixed(2)}`);
    }
  }

  return trials.sort((a, b) => b.sharpe - a.sharpe);
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

function printTop10(label: string, trials: Trial[]) {
  console.log(`\n${"═".repeat(80)}`);
  console.log(`Top 10 parameter sets by Sharpe ratio (${label}):`);
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
      `#${i + 1}  sharpe=${t.sharpe.toFixed(3)}  mean_pnl=$${t.meanPnl.toFixed(2)}  total=$${t.totalPnl.toFixed(2)}  fills=${t.fillRate.toFixed(1)}/win`
    );
    console.log(`     ${paramStr}`);
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

function main() {
  const { iterations, dbPath, holdoutPct } = parseArgs();

  console.log(`Strategy Parameter Optimizer`);
  console.log(`Database: ${dbPath}`);
  console.log(`Iterations: ${iterations}`);
  console.log(`Holdout: ${(holdoutPct * 100).toFixed(0)}%`);

  // Load snapshots
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

  // Train/test split (deterministic seed based on window count)
  const seed = allWindows.length * 31337;
  const shuffled = [...allWindows].sort((a, b) => {
    const ha = hashCode(`${a.id}${seed}`) & 0x7fffffff;
    const hb = hashCode(`${b.id}${seed}`) & 0x7fffffff;
    return ha - hb;
  });
  const holdoutCount = Math.floor(shuffled.length * holdoutPct);
  const testWindows = shuffled.slice(0, holdoutCount);
  const trainWindows = shuffled.slice(holdoutCount);

  console.log(`Train: ${trainWindows.length} windows, Test: ${testWindows.length} windows`);

  // Baseline: evaluate with DEFAULT_PARAMS
  const baseline = evaluate(trainWindows, DEFAULT_PARAMS);
  console.log(`\nBaseline (DEFAULT_PARAMS): sharpe=${baseline.sharpe.toFixed(3)} mean=$${baseline.meanPnl.toFixed(2)} total=$${baseline.totalPnl.toFixed(2)}`);

  // Global optimization
  const globalTrials = runTPE(trainWindows, iterations, "Global");
  printTop10("Global - In-Sample", globalTrials);

  // Out-of-sample validation
  if (testWindows.length >= 5) {
    const best = globalTrials[0];
    const bestParams = mergeParams(best.params);
    const oos = evaluate(testWindows, bestParams);
    const baselineOos = evaluate(testWindows, DEFAULT_PARAMS);

    console.log(`\n── Out-of-Sample Validation ──`);
    console.log(`Best params:  sharpe=${oos.sharpe.toFixed(3)} mean=$${oos.meanPnl.toFixed(2)} total=$${oos.totalPnl.toFixed(2)}`);
    console.log(`Baseline:     sharpe=${baselineOos.sharpe.toFixed(3)} mean=$${baselineOos.meanPnl.toFixed(2)} total=$${baselineOos.totalPnl.toFixed(2)}`);

    const divergence = Math.abs(best.sharpe - oos.sharpe) / Math.max(0.01, Math.abs(best.sharpe));
    if (divergence > 0.5) {
      console.log(`⚠ WARNING: Sharpe divergence ${(divergence * 100).toFixed(0)}% between in-sample and out-of-sample — possible overfitting!`);
    } else {
      console.log(`Sharpe divergence: ${(divergence * 100).toFixed(0)}% (acceptable)`);
    }
  }

  printJSON("Global Best", globalTrials[0]);

  // Time-bucketed analysis
  console.log(`\n${"═".repeat(80)}`);
  console.log(`Time-Bucketed Analysis`);
  console.log(`${"═".repeat(80)}`);

  const bucketIterations = Math.min(500, Math.floor(iterations / 4));
  const allBuckets = [
    ...getTimeBuckets(),
    ...getSymbolBuckets(allWindows),
    ...getDurationBuckets(allWindows),
  ];

  const bucketResults: Array<{ label: string; best: Trial; count: number; baselineSharpe: number }> = [];

  for (const bucket of allBuckets) {
    const bucketWindows = trainWindows.filter(bucket.filter);
    if (bucketWindows.length < 10) {
      console.log(`  [${bucket.label}] Skipping — only ${bucketWindows.length} windows`);
      continue;
    }

    const trials = runTPE(bucketWindows, bucketIterations, bucket.label);
    const bucketBaseline = evaluate(bucketWindows, DEFAULT_PARAMS);

    bucketResults.push({
      label: bucket.label,
      best: trials[0],
      count: bucketWindows.length,
      baselineSharpe: bucketBaseline.sharpe,
    });
  }

  // Summary table
  if (bucketResults.length > 0) {
    console.log(`\n── Bucket Summary ──`);
    console.log(`${"Bucket".padEnd(25)} ${"N".padStart(4)} ${"Baseline".padStart(10)} ${"Optimized".padStart(10)} ${"Improvement".padStart(12)}`);
    console.log(`${"-".repeat(25)} ${"-".repeat(4)} ${"-".repeat(10)} ${"-".repeat(10)} ${"-".repeat(12)}`);

    for (const b of bucketResults) {
      const improvement = b.best.sharpe - b.baselineSharpe;
      const pct = b.baselineSharpe !== 0 ? ((improvement / Math.abs(b.baselineSharpe)) * 100).toFixed(0) : "N/A";
      console.log(
        `${b.label.padEnd(25)} ${String(b.count).padStart(4)} ${b.baselineSharpe.toFixed(3).padStart(10)} ${b.best.sharpe.toFixed(3).padStart(10)} ${(improvement >= 0 ? "+" : "") + improvement.toFixed(3).padStart(11)} (${pct}%)`
      );
    }

    // Check if any bucket significantly outperforms global
    const globalBest = globalTrials[0].sharpe;
    const betterBuckets = bucketResults.filter(b => b.best.sharpe > globalBest * 1.1);
    if (betterBuckets.length > 0) {
      console.log(`\nBuckets that outperform global params by >10%:`);
      for (const b of betterBuckets) {
        printJSON(b.label, b.best);
      }
    }
  }

  console.log(`\nDone.`);
}

/** Simple string hash for deterministic shuffling */
function hashCode(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash;
}

main();
