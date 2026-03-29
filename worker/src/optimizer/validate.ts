#!/usr/bin/env npx tsx
/**
 * Snapshot Validation Script
 *
 * Replays recently recorded snapshots and compares replay results against
 * what the live strategy actually observed. Run after even a single resolved
 * window to detect recording/replay issues early.
 *
 * Usage:
 *   cd worker && npx tsx src/optimizer/validate.ts
 *   cd worker && npx tsx src/optimizer/validate.ts --db path/to/d1.sqlite
 *   cd worker && npx tsx src/optimizer/validate.ts --status http://localhost:8787/api/strategy/status/strat-XXX
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { replayWindow } from "./replay";
import type { WindowSnapshot, TickSnapshot, TapeBucket } from "./types";
import type { DirectionalMakerParams } from "../strategies/safe-maker";
import { DEFAULT_PARAMS } from "../strategies/safe-maker";

// ── CLI args ──

function parseArgs() {
  const args = process.argv.slice(2);
  let dbPath = "";
  let statusUrl = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && args[i + 1]) dbPath = args[++i];
    else if (args[i] === "--status" && args[i + 1]) statusUrl = args[++i];
  }

  if (!dbPath) {
    // Auto-detect local D1 SQLite
    const wranglerState = path.join(process.cwd(), ".wrangler", "state", "v3", "d1");
    if (fs.existsSync(wranglerState)) {
      const miniDb = fs.readdirSync(wranglerState).find(f => f.endsWith(".sqlite") && !f.includes("wal"));
      if (miniDb) dbPath = path.join(wranglerState, miniDb);
    }
  }

  return { dbPath, statusUrl };
}

// ── Load snapshots ──

interface SnapshotRow {
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
}

function loadSnapshots(dbPath: string): WindowSnapshot[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT id, crypto_symbol, window_open_time, window_end_time, window_duration_ms,
            oracle_strike, price_at_open, hour_utc, day_of_week,
            up_token_id, down_token_id, outcome, ticks
     FROM strategy_snapshots
     WHERE outcome IS NOT NULL AND outcome != 'UNKNOWN' AND outcome != 'null'
     ORDER BY window_end_time DESC
     LIMIT 50`
  ).all() as SnapshotRow[];
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

// ── Load live trades for comparison ──

interface LiveTrade {
  token_id: string;
  side: string;
  price: number;
  size: number;
  timestamp: string;
}

function loadLiveTrades(dbPath: string, strategyId: string, sinceMs: number): LiveTrade[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT token_id, side, price, size, timestamp
     FROM strategy_trades
     WHERE strategy_id = ? AND timestamp >= datetime(? / 1000, 'unixepoch')
     ORDER BY timestamp`
  ).all(strategyId, sinceMs) as LiveTrade[];
  db.close();
  return rows;
}

function loadStrategyId(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(
    `SELECT id FROM strategy_configs WHERE params LIKE '%record_snapshots%' LIMIT 1`
  ).get() as { id: string } | undefined;
  db.close();
  return row?.id ?? "";
}

// ── Tape diagnostics ──

function analyzeTape(snap: WindowSnapshot) {
  const ticks = snap.ticks;
  if (ticks.length === 0) return null;

  let totalBuckets = 0;
  let upBuckets = 0;
  let downBuckets = 0;
  let otherBuckets = 0;
  let maxBucketVolume = 0;
  let growingTicks = 0;
  let prevTotalVolume = 0;

  const pricesSeen = new Set<string>();

  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i];
    let tickVolume = 0;
    for (const b of tick.tapeBuckets) {
      totalBuckets++;
      tickVolume += b.size;
      pricesSeen.add(`${b.tokenId.slice(-6)}@${b.price}`);
      if (b.tokenId === snap.upTokenId) upBuckets++;
      else if (b.tokenId === snap.downTokenId) downBuckets++;
      else otherBuckets++;
      if (b.size > maxBucketVolume) maxBucketVolume = b.size;
    }
    if (tickVolume > prevTotalVolume) growingTicks++;
    prevTotalVolume = tickVolume;
  }

  const firstTick = ticks[0];
  const lastTick = ticks[ticks.length - 1];
  const firstVolume = firstTick.tapeBuckets.reduce((s, b) => s + b.size, 0);
  const lastVolume = lastTick.tapeBuckets.reduce((s, b) => s + b.size, 0);

  return {
    tickCount: ticks.length,
    totalBucketEntries: totalBuckets,
    upBuckets,
    downBuckets,
    otherBuckets,
    uniquePriceLevels: pricesSeen.size,
    firstTickVolume: firstVolume,
    lastTickVolume: lastVolume,
    volumeGrowth: lastVolume - firstVolume,
    growingTicks,
    maxBucketVolume,
    firstTapeMeta: firstTick.tapeMeta,
    lastTapeMeta: lastTick.tapeMeta,
  };
}

// ── Main ──

async function main() {
  const { dbPath, statusUrl } = parseArgs();

  if (!dbPath || !fs.existsSync(dbPath)) {
    // Try to find any D1 sqlite in .wrangler
    const wranglerState = path.join(process.cwd(), ".wrangler", "state", "v3", "d1");
    if (fs.existsSync(wranglerState)) {
      const files = fs.readdirSync(wranglerState).filter(f => f.endsWith(".sqlite") && !f.includes("wal") && !f.includes("shm"));
      if (files.length > 0) {
        console.log("Available D1 databases:");
        for (const f of files) {
          const fp = path.join(wranglerState, f);
          const db = new Database(fp, { readonly: true });
          try {
            const count = db.prepare("SELECT COUNT(*) as n FROM strategy_snapshots").get() as { n: number };
            console.log(`  ${f}: ${count.n} snapshots`);
          } catch {
            // Not the right database
          }
          db.close();
        }
      }
    }
    console.error("\nUsage: npx tsx src/optimizer/validate.ts --db path/to/d1.sqlite");
    process.exit(1);
  }

  console.log(`\n📊 Snapshot Validation Report`);
  console.log(`Database: ${dbPath}\n`);

  const snapshots = loadSnapshots(dbPath);
  if (snapshots.length === 0) {
    console.log("❌ No resolved snapshots found. Wait for windows to resolve (5-15 min).\n");

    // Check for in-progress snapshots
    const db = new Database(dbPath, { readonly: true });
    const pending = db.prepare(
      `SELECT id, crypto_symbol, window_duration_ms, outcome, LENGTH(ticks) as bytes
       FROM strategy_snapshots ORDER BY window_end_time DESC LIMIT 5`
    ).all() as Array<{ id: string; crypto_symbol: string; window_duration_ms: number; outcome: string; bytes: number }>;
    db.close();

    if (pending.length > 0) {
      console.log("Pending/in-progress snapshots:");
      for (const p of pending) {
        console.log(`  ${p.crypto_symbol} ${p.window_duration_ms / 1000}s  outcome=${p.outcome}  ${p.bytes} bytes`);
      }
    }
    return;
  }

  console.log(`Found ${snapshots.length} resolved snapshot(s)\n`);

  // Load live trades for comparison
  const strategyId = loadStrategyId(dbPath);
  const oldestSnap = Math.min(...snapshots.map(s => s.windowOpenTime));
  const liveTrades = strategyId ? loadLiveTrades(dbPath, strategyId, oldestSnap) : [];

  // Get recorder params (use defaults + record_snapshots)
  const params: DirectionalMakerParams = { ...DEFAULT_PARAMS, record_snapshots: true };

  let totalReplayFills = 0;
  let totalLiveFills = 0;
  let totalReplayPnl = 0;

  for (const snap of snapshots) {
    const durMin = snap.windowDurationMs / 60_000;
    const tape = analyzeTape(snap);

    console.log(`━━━ ${snap.cryptoSymbol} ${durMin}min  outcome=${snap.outcome} ━━━`);

    if (tape) {
      console.log(`  Ticks: ${tape.tickCount}  (${(snap.windowDurationMs / 1000 / tape.tickCount).toFixed(1)}s interval)`);
      console.log(`  Tape buckets: ${tape.upBuckets} UP, ${tape.downBuckets} DN, ${tape.otherBuckets} other`);
      if (tape.otherBuckets > 0) {
        console.log(`  ⚠️  ${tape.otherBuckets} non-token buckets detected (old recording format?)`);
      }
      console.log(`  Unique price levels: ${tape.uniquePriceLevels}`);
      console.log(`  Volume: first=${tape.firstTickVolume.toFixed(0)} → last=${tape.lastTickVolume.toFixed(0)} (+${tape.volumeGrowth.toFixed(0)})`);
      console.log(`  Growing ticks: ${tape.growingTicks}/${tape.tickCount} (${(tape.growingTicks / tape.tickCount * 100).toFixed(0)}%)`);
      if (tape.lastTapeMeta) {
        console.log(`  Tape meta: ${tape.lastTapeMeta.totalTrades} trades, ${tape.lastTapeMeta.uniqueWallets} wallets, $${tape.lastTapeMeta.totalVolume.toFixed(2)} volume`);
      }
    }

    // Replay
    const result = replayWindow(snap, params);
    totalReplayFills += result.fillCount;
    totalReplayPnl += result.netPnl;

    // Find matching live trades
    const windowTrades = liveTrades.filter(t => {
      const tMs = new Date(t.timestamp).getTime();
      return tMs >= snap.windowOpenTime && tMs <= snap.windowEndTime + 60_000;
    });
    // Count BUY fills for this window's tokens
    const liveFills = windowTrades.filter(t =>
      t.side === "BUY" &&
      (t.token_id === snap.upTokenId || t.token_id === snap.downTokenId)
    ).length;
    totalLiveFills += liveFills;

    console.log(`  Replay: ${result.fillCount} fills, PnL=$${result.netPnl.toFixed(4)}, inv=${result.upInventory}↑/${result.downInventory}↓`);
    console.log(`  Live:   ${liveFills} fills (from strategy_trades)`);

    if (liveFills > 0 && result.fillCount === 0) {
      console.log(`  ❌ FILL GAP: live had fills but replay found none`);
      // Diagnose: check if tape has volume at bid-worthy prices
      if (tape) {
        const lastTick = snap.ticks[snap.ticks.length - 1];
        const upVol = lastTick.tapeBuckets
          .filter(b => b.tokenId === snap.upTokenId && b.price <= params.max_bid_per_side)
          .reduce((s, b) => s + b.size, 0);
        const dnVol = lastTick.tapeBuckets
          .filter(b => b.tokenId === snap.downTokenId && b.price <= params.max_bid_per_side)
          .reduce((s, b) => s + b.size, 0);
        console.log(`  Tape volume at fill-worthy prices (≤$${params.max_bid_per_side}): UP=${upVol} DN=${dnVol}`);
      }
    } else if (result.fillCount > 0 && liveFills === 0) {
      console.log(`  ⚠️  PHANTOM FILLS: replay found fills but live had none`);
    } else if (liveFills > 0 && result.fillCount > 0) {
      const ratio = result.fillCount / liveFills;
      const icon = ratio >= 0.5 && ratio <= 2.0 ? "✅" : "⚠️";
      console.log(`  ${icon} Fill ratio: ${ratio.toFixed(2)}x (replay/live)`);
    }

    // Check for recording quality issues
    if (tape && tape.growingTicks < tape.tickCount * 0.1 && tape.tickCount > 10) {
      console.log(`  ⚠️  Tape barely grows — may still be using old recording format`);
    }
    if (tape && tape.otherBuckets > tape.upBuckets + tape.downBuckets) {
      console.log(`  ❌ More non-token buckets than token buckets — old format data`);
    }

    console.log();
  }

  // Summary
  console.log(`═══ SUMMARY ═══`);
  console.log(`Snapshots: ${snapshots.length}`);
  console.log(`Replay fills: ${totalReplayFills}  (${(totalReplayFills / snapshots.length).toFixed(1)}/window)`);
  console.log(`Live fills:   ${totalLiveFills}  (${(totalLiveFills / snapshots.length).toFixed(1)}/window)`);
  if (totalLiveFills > 0) {
    console.log(`Fill capture rate: ${(totalReplayFills / totalLiveFills * 100).toFixed(0)}%`);
  }
  console.log(`Replay total PnL: $${totalReplayPnl.toFixed(4)}`);
  console.log(`Avg PnL/window: $${(totalReplayPnl / snapshots.length).toFixed(4)}`);
  console.log();

  if (totalLiveFills > 0 && totalReplayFills / totalLiveFills < 0.3) {
    console.log(`❌ Fill capture rate below 30% — recording may still be insufficient`);
  } else if (totalLiveFills > 0 && totalReplayFills / totalLiveFills >= 0.5) {
    console.log(`✅ Fill capture rate looks reasonable`);
  } else if (totalLiveFills === 0 && totalReplayFills === 0) {
    console.log(`ℹ️  No fills in either live or replay — check tape data quality above`);
  }
}

main().catch(console.error);
