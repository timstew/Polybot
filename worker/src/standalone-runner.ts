#!/usr/bin/env npx tsx
/**
 * Standalone Strategy Runner — No DO Eviction
 *
 * Alternative entry point for running strategies as a plain Node.js process.
 * Uses setInterval instead of DO alarms, better-sqlite3 instead of D1 binding.
 * Eliminates DO eviction entirely — reliable for recording/optimization.
 *
 * Usage:
 *   cd worker && npx tsx src/standalone-runner.ts --config-id=strat-xxx
 *   cd worker && npx tsx src/standalone-runner.ts --config-id=strat-xxx --db=path/to/d1.sqlite
 *   cd worker && npx tsx src/standalone-runner.ts --config-id=strat-xxx --port=8787
 *
 * Compatible with the dashboard: same API shape as StrategyDO.
 */

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import {
  type StrategyConfig,
  type StrategyState,
  type Strategy,
  type StructuredLogData,
  PaperStrategyAPI,
  RealStrategyAPI,
  getStrategy,
  emptyState,
  buildProtectedConfig,
  type StrategyContext,
} from "./strategy-core";
import { tryMerge, type MergeableWindow } from "./strategies/merge";

// ── CLI args ──

function parseArgs() {
  const args = process.argv.slice(2);
  let configId = "";
  let dbPath = "";
  let port = parseInt(process.env.PORT || "8787", 10);
  let pythonApiUrl = process.env.PYTHON_API_URL || "http://127.0.0.1:8000";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--config-id=")) {
      configId = arg.slice("--config-id=".length);
    } else if (arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length);
    } else if (arg.startsWith("--port=")) {
      port = parseInt(arg.slice("--port=".length), 10);
    } else if (arg.startsWith("--python-api=")) {
      pythonApiUrl = arg.slice("--python-api=".length);
    }
  }

  // Auto-detect D1 SQLite path
  if (!dbPath) {
    const candidates = [
      path.join(__dirname, "../wrangler-data/d1/miniflare-D1DatabaseObject"),
      path.join(__dirname, "../.wrangler/state/v3/d1/miniflare-D1DatabaseObject"),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => f.endsWith(".sqlite"));
        // Find the ops database (has strategy_configs table), not firehose or empty
        for (const file of files) {
          const filePath = path.join(dir, file);
          try {
            const testDb = new Database(filePath, { readonly: true });
            const hasTable = testDb.prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='strategy_configs'"
            ).get();
            testDb.close();
            if (hasTable) { dbPath = filePath; break; }
          } catch { /* skip unreadable files */ }
        }
        if (dbPath) break;
      }
    }
  }

  if (!dbPath) {
    console.error("ERROR: Could not find D1 SQLite database.");
    console.error("Specify with: --db=path/to/database.sqlite");
    process.exit(1);
  }

  return { configId: configId || null, dbPath, port, pythonApiUrl };
}

// ── D1-compatible SQLite wrapper ──

function createD1Wrapper(db: InstanceType<typeof Database>): D1Database {
  return {
    prepare(sql: string) {
      return createD1Statement(db, sql);
    },
    batch(statements: D1PreparedStatement[]) {
      return db.transaction(() => {
        return statements.map(stmt => (stmt as unknown as { _run(): D1Result })._run());
      })();
    },
    exec(sql: string) {
      db.exec(sql);
      return Promise.resolve({ count: 0, duration: 0 });
    },
    dump() {
      return Promise.resolve(new ArrayBuffer(0));
    },
  } as unknown as D1Database;
}

function createD1Statement(db: InstanceType<typeof Database>, sql: string): D1PreparedStatement {
  let bindings: unknown[] = [];

  const stmt: D1PreparedStatement = {
    bind(...args: unknown[]) {
      bindings = args;
      return stmt;
    },
    async first<T = Record<string, unknown>>(col?: string) {
      const prepared = db.prepare(sql);
      const row = prepared.get(...bindings) as Record<string, unknown> | undefined;
      if (!row) return null as T;
      if (col) return (row as Record<string, unknown>)[col] as T;
      return row as T;
    },
    async all<T = Record<string, unknown>>() {
      const prepared = db.prepare(sql);
      const rows = prepared.all(...bindings);
      return { results: rows as T[], success: true, meta: {} } as D1Result<T>;
    },
    async run() {
      const prepared = db.prepare(sql);
      const result = prepared.run(...bindings);
      return {
        success: true,
        meta: { changes: result.changes, last_row_id: result.lastInsertRowid },
        results: [],
      } as unknown as D1Result;
    },
    async raw<T = unknown[]>() {
      const prepared = db.prepare(sql);
      const rows = prepared.all(...bindings);
      return rows.map(r => Object.values(r as Record<string, unknown>)) as T[];
    },
    // Internal: used by batch()
    _run() {
      const prepared = db.prepare(sql);
      const result = prepared.run(...bindings);
      return {
        success: true,
        meta: { changes: result.changes },
        results: [],
      };
    },
  } as unknown as D1PreparedStatement & { _run(): D1Result };

  return stmt;
}

// ── Strategy registration (mirrors ensureRegistered) ──

async function ensureRegistered(): Promise<void> {
  await import("./strategies/split-arb");
  await import("./strategies/passive-mm");
  await import("./strategies/directional-taker");
  await import("./strategies/directional-maker");
  await import("./strategies/spread-sniper");
  await import("./strategies/unified-adaptive");
  await import("./strategies/safe-maker");
  await import("./strategies/conviction-maker");
  await import("./strategies/certainty-taker");
  await import("./strategies/avellaneda-maker");
  await import("./strategies/enhanced-maker");
  await import("./strategies/orchestrator");
  await import("./strategies/scaling-safe-maker");
  await import("./strategies/bonestar");
  await import("./strategies/babyboner");
}

// ── Runner state ──

interface RunnerInstance {
  config: StrategyConfig;
  strategy: Strategy;
  api: PaperStrategyAPI | RealStrategyAPI;
  state: StrategyState;
  interval: ReturnType<typeof setInterval> | null;
  logBuffer: Array<{ msg: string; data?: StructuredLogData; ts: string }>;
  ticking: boolean;
}

const instances = new Map<string, RunnerInstance>();
let sqliteDb: InstanceType<typeof Database>;
let d1Db: D1Database;

function loadConfig(configId: string): StrategyConfig | null {
  const row = sqliteDb.prepare(
    "SELECT * FROM strategy_configs WHERE id = ?"
  ).get(configId) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: row.id as string,
    name: row.name as string,
    strategy_type: row.strategy_type as string,
    mode: row.mode as "paper" | "real",
    active: !!(row.active as number),
    params: JSON.parse((row.params as string) || "{}"),
    tick_interval_ms: (row.tick_interval_ms as number) || 3000,
    max_capital_usd: (row.max_capital_usd as number) || 200,
    balance_usd: row.balance_usd != null ? (row.balance_usd as number) : null,
    lock_increment_usd: row.lock_increment_usd != null ? (row.lock_increment_usd as number) : null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function addLog(inst: RunnerInstance, msg: string, data?: StructuredLogData) {
  const ts = new Date().toISOString();
  inst.state.logs.push({ ts, msg, data });
  if (inst.state.logs.length > 100) {
    inst.state.logs = inst.state.logs.slice(-100);
  }
  if (data) {
    inst.logBuffer.push({ msg, data, ts });
  }
  console.log(`[STRATEGY ${inst.config.name}] ${msg}`);
}

function flushLogs(inst: RunnerInstance) {
  if (inst.logBuffer.length === 0) return;
  const insertStmt = sqliteDb.prepare(
    `INSERT INTO strategy_logs (strategy_id, tick, phase, level, message, symbol, direction, signal_strength, price_change_pct, momentum, volatility_regime, in_dead_zone, flip_count, up_inventory, down_inventory, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMany = sqliteDb.transaction((entries: typeof inst.logBuffer) => {
    for (const entry of entries) {
      const d = entry.data || {};
      insertStmt.run(
        inst.config.id,
        inst.state.ticks,
        d.phase ?? "",
        d.level ?? "info",
        entry.msg,
        d.symbol ?? null,
        d.direction ?? null,
        d.signalStrength ?? null,
        d.priceChangePct ?? null,
        d.momentum ?? null,
        d.volatilityRegime ?? null,
        d.inDeadZone != null ? (d.inDeadZone ? 1 : 0) : null,
        d.flipCount ?? null,
        d.upInventory ?? null,
        d.downInventory ?? null,
        entry.ts,
      );
    }
  });
  insertMany(inst.logBuffer);
  inst.logBuffer = [];
}

function persistState(inst: RunnerInstance) {
  // Save state to a JSON file (no DO storage limits)
  const statePath = path.join(path.dirname(sqliteDb.name), `standalone-state-${inst.config.id}.json`);

  // Strip tickSnapshots before saving (same as DO)
  const custom = inst.state.custom as Record<string, unknown> | undefined;
  const activeWindows = custom?.activeWindows as Array<Record<string, unknown>> | undefined;
  const savedSnapshots: unknown[] = [];
  if (activeWindows?.some(w => w.tickSnapshots)) {
    for (let i = 0; i < activeWindows.length; i++) {
      savedSnapshots[i] = activeWindows[i].tickSnapshots;
      delete activeWindows[i].tickSnapshots;
    }
  }

  fs.writeFileSync(statePath, JSON.stringify(inst.state), "utf-8");

  // Restore tickSnapshots in memory
  if (activeWindows) {
    for (let i = 0; i < activeWindows.length; i++) {
      if (savedSnapshots[i]) activeWindows[i].tickSnapshots = savedSnapshots[i];
    }
  }
}

function loadState(configId: string): StrategyState | null {
  const candidates = [
    path.join(path.dirname(sqliteDb.name), `standalone-state-${configId}.json`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf-8")) as StrategyState;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function startStrategy(configId: string, pythonApiUrl: string): Promise<string> {
  if (instances.has(configId)) {
    return "already_running";
  }

  const config = loadConfig(configId);
  if (!config) return "config_not_found";

  await ensureRegistered();
  const strategy = getStrategy(config.strategy_type);
  if (!strategy) return `unknown_strategy_type: ${config.strategy_type}`;

  const grounded = (config.params as Record<string, unknown>)?.grounded_fills !== false;
  const api = config.mode === "paper"
    ? new PaperStrategyAPI(pythonApiUrl, undefined, grounded)
    : new RealStrategyAPI(pythonApiUrl);

  const state = loadState(configId) || emptyState();
  if (!state.logs) state.logs = [];
  if (!state.started_at) state.started_at = new Date().toISOString();

  // State file is the source of truth for P&L. No D1 recovery — it causes
  // double-counting when state files are cleared without clearing D1 trades.
  // Use "Reset Stats" button to clear both D1 and state together.

  // HWM
  if (config.balance_usd != null) {
    const currentBalance = config.balance_usd + state.total_pnl;
    state.high_water_balance = Math.max(state.high_water_balance || 0, currentBalance);
  }

  const inst: RunnerInstance = {
    config: { ...config, active: true },
    strategy,
    api,
    state,
    interval: null,
    logBuffer: [],
    ticking: false,
  };

  instances.set(configId, inst);

  addLog(inst, `Started (standalone): ${config.name} (${config.strategy_type}, ${config.mode} mode)`);

  // Build context and init
  const ctx = buildContext(inst);
  try {
    await strategy.init(ctx);
  } catch (e) {
    addLog(inst, `Init error: ${e instanceof Error ? e.message : String(e)}`);
  }

  persistState(inst);

  // Mark active in D1
  sqliteDb.prepare(
    "UPDATE strategy_configs SET active = 1, updated_at = datetime('now') WHERE id = ?"
  ).run(configId);

  // Start tick loop
  inst.interval = setInterval(async () => {
    if (inst.ticking) return; // prevent re-entrance
    inst.ticking = true;
    try {
      await tick(inst);
    } catch (e) {
      console.error(`[TICK ERROR] ${inst.config.name}:`, e);
      inst.state.errors++;
    }
    inst.ticking = false;
  }, config.tick_interval_ms);

  return "started";
}

async function autoMergeProfitablePairs(inst: RunnerInstance, ctx: StrategyContext): Promise<void> {
  const custom = inst.state.custom as Record<string, unknown> | undefined;
  const windows = custom?.activeWindows as Array<MergeableWindow & Record<string, unknown>> | undefined;
  if (!windows) return;

  for (const w of windows) {
    // ── Estimate maker rebates for ALL strategies ──────────────────
    // Track cumulative inventory to compute incremental rebates each tick.
    // Polymarket crypto fee: price × (1-price) × 0.0625 × size. Maker gets 20%.
    const upInv = (w.upInventory as number) || 0;
    const dnInv = (w.downInventory as number) || 0;
    const upCost = (w.upAvgCost as number) || 0;
    const dnCost = (w.downAvgCost as number) || 0;
    const totalTokens = upInv + dnInv + ((w.totalMerged as number) || 0) * 2; // include merged (they were inventory)
    const prevTokens = (w._lastRebateTokens as number) || 0;
    if (totalTokens > prevTokens) {
      // New tokens accumulated since last check — estimate rebate on the delta
      // Use weighted avg price across both sides for fee calc
      const totalCost = upInv * upCost + dnInv * dnCost;
      const avgPrice = (upInv + dnInv) > 0 ? totalCost / (upInv + dnInv) : 0.5;
      const newTokens = totalTokens - prevTokens;
      const feePerToken = avgPrice * (1 - avgPrice) * 0.0625;
      const rebate = feePerToken * newTokens * 0.20;
      w.estimatedRebates = ((w.estimatedRebates as number) || 0) + rebate;
      w._lastRebateTokens = totalTokens;
    }

    // ── Auto-merge profitable pairs ───────────────────────────────
    if (!w.upInventory || !w.downInventory) continue;
    if (w.upAvgCost + w.downAvgCost >= 1.0) continue;
    try {
      const result = await tryMerge(ctx, w);
      if (result) {
        if (typeof w.realizedSellPnl === "number") w.realizedSellPnl += result.pnl;
        if (typeof w.realizedPnl === "number") w.realizedPnl += result.pnl;
        if (typeof w.totalMerged === "number") w.totalMerged += result.merged;
        if (typeof w.totalMergePnl === "number") w.totalMergePnl += result.pnl;
        addLog(inst, `AUTO-MERGE: ${result.merged} pairs @ pc=${result.pairCost.toFixed(4)} → +$${result.pnl.toFixed(2)}`);
      }
    } catch { /* non-critical */ }
  }
}

async function tick(inst: RunnerInstance) {
  const ctx = buildContext(inst);

  try {
    await inst.strategy.tick(ctx);

    // Auto-merge profitable pairs across all active windows
    await autoMergeProfitablePairs(inst, ctx);

    inst.state.ticks++;
    const now = Date.now();
    if (inst.state.last_tick_at) {
      const elapsed = now - new Date(inst.state.last_tick_at).getTime();
      if (elapsed < 600_000) {
        inst.state.cumulative_runtime_ms = (inst.state.cumulative_runtime_ms || 0) + elapsed;
      }
    }
    inst.state.last_tick_at = new Date(now).toISOString();
  } catch (e) {
    inst.state.errors++;
    addLog(inst, `Tick error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Flush logs every 10 ticks
  if (inst.state.ticks % 10 === 0 && inst.logBuffer.length > 0) {
    try { flushLogs(inst); } catch { /* ignore */ }
  }

  // Balance protection
  if (inst.config.balance_usd != null) {
    const currentBalance = inst.config.balance_usd + inst.state.total_pnl;
    inst.state.high_water_balance = Math.max(inst.state.high_water_balance || 0, currentBalance);

    const params = inst.config.params as Record<string, unknown>;
    const reinvestPct = (params?.profit_reinvest_pct as number) ?? 0;
    const hwmProfit = Math.max(0, inst.state.high_water_balance - inst.config.balance_usd);
    const lockedAmount = Math.min(hwmProfit * (1 - reinvestPct), Math.max(0, currentBalance));
    const workingCapital = currentBalance - lockedAmount;

    if (workingCapital <= 0) {
      addLog(inst, `BALANCE PROTECTION: working capital exhausted. Auto-stopping.`, { level: "warning" });
      await stopStrategy(inst.config.id);
      return;
    }
  }

  // Wind-down auto-stop
  if (inst.state.windingDown) {
    const custom = inst.state.custom as Record<string, unknown>;
    const activeWindows = custom?.activeWindows as unknown[] | undefined;
    if (!activeWindows || activeWindows.length === 0) {
      addLog(inst, "WIND DOWN COMPLETE: auto-stopping");
      await stopStrategy(inst.config.id);
      return;
    }
  }

  // Clean old logs every 100 ticks
  if (inst.state.ticks % 100 === 0) {
    try {
      sqliteDb.prepare("DELETE FROM strategy_logs WHERE timestamp < datetime('now', '-24 hours')").run();
    } catch { /* ignore */ }
  }

  persistState(inst);
}

function buildContext(inst: RunnerInstance) {
  const { config: protectedConfig } = buildProtectedConfig(inst.config, inst.state);

  // Set paper API balance if applicable
  if (inst.api instanceof PaperStrategyAPI && inst.config.balance_usd != null) {
    const protection = buildProtectedConfig(inst.config, inst.state).protection;
    if (protection) inst.api.balanceOverride = protection.workingCapital;
  }

  return {
    config: protectedConfig,
    state: inst.state,
    api: inst.api,
    db: d1Db,
    log: (msg: string, data?: StructuredLogData) => addLog(inst, msg, data),
    windingDown: inst.state.windingDown,
  };
}

async function stopStrategy(configId: string): Promise<string> {
  const inst = instances.get(configId);
  if (!inst) return "not_running";

  if (inst.interval) {
    clearInterval(inst.interval);
    inst.interval = null;
  }

  addLog(inst, `Stopped: ${inst.config.name}`);
  const ctx = buildContext(inst);
  try {
    await inst.strategy.stop(ctx);
  } catch (e) {
    console.error("Strategy stop error:", e);
  }

  // Flush logs and state
  try { flushLogs(inst); } catch { /* ignore */ }
  inst.state.windingDown = false;
  persistState(inst);

  // Mark inactive in D1
  sqliteDb.prepare(
    "UPDATE strategy_configs SET active = 0, updated_at = datetime('now') WHERE id = ?"
  ).run(configId);

  instances.delete(configId);
  return "stopped";
}

async function resetStrategy(configId: string): Promise<string> {
  // Stop if running — clear interval first to prevent state persist race
  const inst = instances.get(configId);
  if (inst) {
    if (inst.interval) { clearInterval(inst.interval); inst.interval = null; }
    instances.delete(configId);
    sqliteDb.prepare("UPDATE strategy_configs SET active = 0, updated_at = datetime('now') WHERE id = ?").run(configId);
  }

  // Delete persisted state JSON file FIRST (before stopStrategy could re-create it)
  const statePath = path.join(path.dirname(sqliteDb.name), `standalone-state-${configId}.json`);
  try {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  } catch { /* ignore */ }

  // Clear D1/SQLite data for this strategy
  try {
    sqliteDb.prepare("DELETE FROM strategy_trades WHERE strategy_id = ?").run(configId);
    sqliteDb.prepare("DELETE FROM strategy_logs WHERE strategy_id = ?").run(configId);
    sqliteDb.prepare("DELETE FROM strategy_orders WHERE strategy_id = ?").run(configId);
    sqliteDb.prepare("DELETE FROM strategy_snapshots WHERE strategy_id = ?").run(configId);
    sqliteDb.prepare(
      "UPDATE strategy_configs SET updated_at = datetime('now') WHERE id = ?"
    ).run(configId);
  } catch (e) {
    console.error("Reset DB cleanup error:", e);
  }

  console.log(`[standalone-runner] Reset strategy ${configId}: cleared state, trades, logs, orders, snapshots`);
  return "reset";
}

// ── HTTP server ──

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function startServer(port: number, pythonApiUrl: string) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const method = req.method || "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    try {
      // Strategy API — compatible with StrategyDO endpoints
      const startMatch = url.pathname.match(/^\/api\/strategy\/start\/(.+)$/);
      if (startMatch && method === "POST") {
        const result = await startStrategy(startMatch[1], pythonApiUrl);
        jsonResponse(res, { status: result });
        return;
      }

      const stopMatch = url.pathname.match(/^\/api\/strategy\/stop\/(.+)$/);
      if (stopMatch && method === "POST") {
        const result = await stopStrategy(stopMatch[1]);
        jsonResponse(res, { status: result });
        return;
      }

      const resetMatch = url.pathname.match(/^\/api\/strategy\/reset\/(.+)$/);
      if (resetMatch && method === "POST") {
        const result = await resetStrategy(resetMatch[1]);
        jsonResponse(res, { status: result });
        return;
      }

      const statusMatch = url.pathname.match(/^\/api\/strategy\/status\/(.+)$/);
      if (statusMatch) {
        const configId = statusMatch[1];
        const inst = instances.get(configId);
        if (inst) {
          const { logs: _allLogs, ...stateWithoutLogs } = inst.state;
          const recentLogs = (inst.state.logs ?? []).slice(-5);
          const responseState = { ...stateWithoutLogs, logs: recentLogs };

          // Strip tickSnapshots
          const custom = responseState.custom as Record<string, unknown> | undefined;
          if (custom?.activeWindows) {
            custom.activeWindows = (custom.activeWindows as Array<Record<string, unknown>>).map(w => {
              const { tickSnapshots: _, ...rest } = w;
              return { ...rest, snapshotCount: Array.isArray(_) ? _.length : 0 };
            });
          }

          // Compute balance protection for the response
          let balanceProtection = null;
          if (inst.config.balance_usd != null) {
            const currentBalance = inst.config.balance_usd + inst.state.total_pnl;
            const hwm = inst.state.high_water_balance || 0;
            const reinvestPct = ((inst.config.params as Record<string, unknown>)?.profit_reinvest_pct as number) ?? 0;
            const capitalCap = ((inst.config.params as Record<string, unknown>)?.capital_cap_usd as number) ?? null;
            const hwmProfit = Math.max(0, hwm - inst.config.balance_usd);
            let lockedAmount = Math.min(hwmProfit * (1 - reinvestPct), Math.max(0, currentBalance));
            let workingCapital = currentBalance - lockedAmount;
            // Apply capital cap: lock everything above the cap
            if (capitalCap != null && workingCapital > capitalCap) {
              lockedAmount += workingCapital - capitalCap;
              workingCapital = capitalCap;
            }
            balanceProtection = {
              current_balance: Math.round(currentBalance * 100) / 100,
              locked_amount: Math.round(lockedAmount * 100) / 100,
              working_capital: Math.round(workingCapital * 100) / 100,
              high_water_balance: Math.round(hwm * 100) / 100,
              effective_max_capital: Math.round(workingCapital * 100) / 100,
              capital_cap: capitalCap,
            };
          }

          jsonResponse(res, {
            running: true,
            winding_down: inst.state.windingDown,
            active_windows: ((inst.state.custom as Record<string, unknown>)?.activeWindows as unknown[] | undefined)?.length ?? 0,
            config: inst.config,
            state: responseState,
            balance_protection: balanceProtection,
            standalone: true,
          });
        } else {
          // Not running — try to load config from D1
          const config = loadConfig(configId);
          const state = loadState(configId) || emptyState();
          jsonResponse(res, {
            running: false,
            config,
            state,
            standalone: true,
          });
        }
        return;
      }

      if (url.pathname === "/api/strategy/statuses") {
        // Return same format as DO version: Record<id, statusObj>
        const statuses: Record<string, unknown> = {};
        const rows = sqliteDb.prepare("SELECT id FROM strategy_configs").all() as Array<{ id: string }>;
        for (const row of rows) {
          const inst = instances.get(row.id);
          if (inst) {
            const { logs: _allLogs, ...stateWithoutLogs } = inst.state;
            const recentLogs = (inst.state.logs ?? []).slice(-5);
            const responseState = { ...stateWithoutLogs, logs: recentLogs };
            const custom = responseState.custom as Record<string, unknown> | undefined;
            if (custom?.activeWindows) {
              custom.activeWindows = (custom.activeWindows as Array<Record<string, unknown>>).map(w => {
                const { tickSnapshots: _, ...rest } = w;
                return { ...rest, snapshotCount: Array.isArray(_) ? _.length : 0 };
              });
            }
            // Compute balance protection
            let bp = null;
            if (inst.config.balance_usd != null) {
              const cb = inst.config.balance_usd + inst.state.total_pnl;
              const hwm = inst.state.high_water_balance || 0;
              const rp = ((inst.config.params as Record<string, unknown>)?.profit_reinvest_pct as number) ?? 0;
              const cap = ((inst.config.params as Record<string, unknown>)?.capital_cap_usd as number) ?? null;
              const hwmP = Math.max(0, hwm - inst.config.balance_usd);
              let locked = Math.min(hwmP * (1 - rp), Math.max(0, cb));
              let wc = cb - locked;
              if (cap != null && wc > cap) { locked += wc - cap; wc = cap; }
              bp = {
                current_balance: Math.round(cb * 100) / 100,
                locked_amount: Math.round(locked * 100) / 100,
                working_capital: Math.round(wc * 100) / 100,
                high_water_balance: Math.round(hwm * 100) / 100,
                effective_max_capital: Math.round(wc * 100) / 100,
                capital_cap: cap,
              };
            }
            statuses[row.id] = {
              running: true,
              winding_down: inst.state.windingDown,
              active_windows: ((inst.state.custom as Record<string, unknown>)?.activeWindows as unknown[] | undefined)?.length ?? 0,
              config: inst.config,
              state: responseState,
              balance_protection: bp,
              standalone: true,
            };
          } else {
            const config = loadConfig(row.id);
            const state = loadState(row.id) || emptyState();
            statuses[row.id] = {
              running: false,
              config,
              state,
              standalone: true,
            };
          }
        }
        jsonResponse(res, statuses);
        return;
      }

      if (url.pathname === "/api/strategy/configs") {
        if (method === "GET") {
          const rows = sqliteDb.prepare("SELECT * FROM strategy_configs ORDER BY created_at DESC").all();
          jsonResponse(res, rows);
          return;
        }
        if (method === "POST") {
          const body = await readBody(req);
          const id = body.id || `strat-${Date.now()}`;
          const params = typeof body.params === "string" ? body.params : JSON.stringify(body.params || {});
          sqliteDb.prepare(
            `INSERT INTO strategy_configs (id, name, strategy_type, mode, active, params, tick_interval_ms, max_capital_usd, balance_usd, lock_increment_usd, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
          ).run(id, body.name || id, body.strategy_type || "babyboner", body.mode || "paper", params,
            body.tick_interval_ms || 2000, body.max_capital_usd || 100, body.balance_usd ?? null, body.lock_increment_usd ?? null);
          jsonResponse(res, { status: "created", id });
          return;
        }
      }

      // PUT /api/strategy/configs/:id — update config
      const configPutMatch = url.pathname.match(/^\/api\/strategy\/configs\/(.+)$/);
      if (configPutMatch && method === "PUT") {
        const configId = configPutMatch[1];
        const body = await readBody(req);
        const existing = sqliteDb.prepare("SELECT * FROM strategy_configs WHERE id = ?").get(configId) as Record<string, unknown> | undefined;
        if (!existing) { jsonResponse(res, { error: "Config not found" }, 404); return; }

        // Merge params
        const oldParams = typeof existing.params === "string" ? JSON.parse(existing.params as string) : (existing.params || {});
        const newParams = body.params ? { ...oldParams, ...body.params } : oldParams;

        sqliteDb.prepare(
          `UPDATE strategy_configs SET
            name = COALESCE(?, name),
            mode = COALESCE(?, mode),
            params = ?,
            tick_interval_ms = COALESCE(?, tick_interval_ms),
            max_capital_usd = COALESCE(?, max_capital_usd),
            balance_usd = ?,
            lock_increment_usd = ?,
            updated_at = datetime('now')
          WHERE id = ?`
        ).run(
          body.name ?? null, body.mode ?? null, JSON.stringify(newParams),
          body.tick_interval_ms ?? null, body.max_capital_usd ?? null,
          body.balance_usd !== undefined ? body.balance_usd : existing.balance_usd,
          body.lock_increment_usd !== undefined ? body.lock_increment_usd : existing.lock_increment_usd,
          configId
        );

        // Update running instance if any
        const inst = instances.get(configId);
        if (inst) {
          const updated = loadConfig(configId);
          if (updated) inst.config = updated;
        }

        const row = sqliteDb.prepare("SELECT * FROM strategy_configs WHERE id = ?").get(configId);
        jsonResponse(res, { status: "updated", config: row });
        return;
      }

      // DELETE /api/strategy/configs/:id
      const configDelMatch = url.pathname.match(/^\/api\/strategy\/configs\/(.+)$/);
      if (configDelMatch && method === "DELETE") {
        const configId = configDelMatch[1];
        if (instances.has(configId)) await stopStrategy(configId);
        sqliteDb.prepare("DELETE FROM strategy_configs WHERE id = ?").run(configId);
        jsonResponse(res, { status: "deleted", id: configId });
        return;
      }

      // Trades endpoints
      const tradesMatch = url.pathname.match(/^\/api\/strategy\/trades\/(.+)$/);
      if (tradesMatch && method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);
        const rows = sqliteDb.prepare(
          "SELECT * FROM strategy_trades WHERE strategy_id = ? ORDER BY timestamp DESC LIMIT ?"
        ).all(tradesMatch[1], limit);
        jsonResponse(res, rows);
        return;
      }
      if (url.pathname === "/api/strategy/trades" && method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);
        const rows = sqliteDb.prepare(
          "SELECT * FROM strategy_trades ORDER BY timestamp DESC LIMIT ?"
        ).all(limit);
        jsonResponse(res, rows);
        return;
      }

      // Logs endpoint
      const logsMatch = url.pathname.match(/^\/api\/strategy\/logs\/(.+)$/);
      if (logsMatch && method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        const level = url.searchParams.get("level");
        let query = "SELECT * FROM strategy_logs WHERE strategy_id = ?";
        const params: unknown[] = [logsMatch[1]];
        if (level) {
          query += " AND level = ?";
          params.push(level);
        }
        query += " ORDER BY timestamp DESC LIMIT ?";
        params.push(limit);
        const rows = sqliteDb.prepare(query).all(...params);
        jsonResponse(res, rows);
        return;
      }

      // ── Chart data (PnL series from strategy_trades) ────────────────
      const chartMatch = url.pathname.match(/^\/api\/strategy\/chart-data\/(.+)$/);
      if (chartMatch && method === "GET") {
        const configId = chartMatch[1];
        const since = parseInt(url.searchParams.get("since") || "0", 10);
        const until = parseInt(url.searchParams.get("until") || `${Date.now()}`, 10);
        const maxPoints = Math.min(parseInt(url.searchParams.get("max_points") || "300", 10), 1000);

        const SYMBOL_NORM: Record<string, string> = { bitcoin: "BTC", btc: "BTC", ethereum: "ETH", eth: "ETH", solana: "SOL", sol: "SOL" };
        const parseMarket = (market: string) => {
          const parts = (market || "").split("-");
          const raw = (parts[0] || "").toLowerCase();
          const symbol = SYMBOL_NORM[raw] || raw.toUpperCase();
          const durPart = parts.find(p => /^\d+[mh]$/.test(p)) || "";
          const durMs = durPart.endsWith("m") ? parseInt(durPart) * 60_000 : durPart.endsWith("h") ? parseInt(durPart) * 3_600_000 : 0;
          return { symbol, durMs };
        };

        const tradeRows = sqliteDb.prepare(
          "SELECT timestamp, pnl, market FROM strategy_trades WHERE strategy_id = ? ORDER BY timestamp ASC"
        ).all(configId) as Array<{ timestamp: string; pnl: number; market: string }>;

        let cumPnl = 0;
        const pnlSeries: Array<{ t: number; cumulative_pnl: number; trade_pnl: number; symbol: string; window_duration_ms: number }> = [];
        for (const row of tradeRows) {
          // D1 timestamps are UTC but stored without 'Z' — force UTC parsing
          const tsStr = row.timestamp.endsWith("Z") ? row.timestamp : row.timestamp + "Z";
          const t = new Date(tsStr).getTime();
          cumPnl += row.pnl || 0;
          if (t >= since && t <= until) {
            const { symbol, durMs } = parseMarket(row.market || "");
            pnlSeries.push({ t, cumulative_pnl: cumPnl, trade_pnl: row.pnl || 0, symbol, window_duration_ms: durMs });
          }
        }

        // Downsample: aggregate trade_pnl between sampled points so the chart's
        // cumulative sum matches. The chart recomputes cumulative from trade_pnl.
        let sampled = pnlSeries;
        if (pnlSeries.length > maxPoints) {
          const step = Math.ceil(pnlSeries.length / maxPoints);
          sampled = [];
          let aggPnl = 0;
          for (let i = 0; i < pnlSeries.length; i++) {
            aggPnl += pnlSeries[i].trade_pnl;
            if (i % step === 0 || i === pnlSeries.length - 1) {
              sampled.push({ ...pnlSeries[i], trade_pnl: aggPnl });
              aggPnl = 0;
            }
          }
        }

        jsonResponse(res, { pnl_series: sampled, tick_series: [], wallet_balances: [] });
        return;
      }

      // ── Orchestrator routes ──────────────────────────────────────────
      if (url.pathname === "/api/strategy/tactics" && method === "GET") {
        // Import orchestrator to trigger tactic registrations (side-effect imports)
        await import("./strategies/orchestrator");
        const { listTactics } = await import("./strategies/tactic");
        jsonResponse(res, listTactics());
        return;
      }

      const tacticScoresMatch = url.pathname.match(/^\/api\/strategy\/tactic-scores\/(.+)$/);
      if (tacticScoresMatch && method === "GET") {
        const stratId = tacticScoresMatch[1];
        try {
          const rows = sqliteDb.prepare(
            `SELECT regime, tactic_id, n, total_pnl, avg_pnl, variance, wins, losses, last_updated_at
             FROM tactic_scores WHERE strategy_id = ? ORDER BY regime, avg_pnl DESC`
          ).all(stratId);
          jsonResponse(res, rows);
        } catch {
          jsonResponse(res, []);
        }
        return;
      }

      const regimePerfMatch = url.pathname.match(/^\/api\/strategy\/regime-performance\/(.+)$/);
      if (regimePerfMatch && method === "GET") {
        const stratId = regimePerfMatch[1];
        try {
          const rows = sqliteDb.prepare(
            `SELECT regime, tactic_id, COUNT(*) as windows, COALESCE(SUM(pnl), 0) as total_pnl, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins
             FROM strategy_regime_log WHERE strategy_id = ? AND pnl IS NOT NULL
             GROUP BY regime, tactic_id ORDER BY regime, total_pnl DESC`
          ).all(stratId);
          jsonResponse(res, rows);
        } catch {
          jsonResponse(res, []);
        }
        return;
      }

      // ── Wallet overview (proxied to Python API) ────────────────────
      if (url.pathname === "/api/strategy/wallet-overview" && method === "GET") {
        try {
          const pyUrl = pythonApiUrl;
          // Fetch balance, positions, and POL in parallel
          const [balRes, posRes, polRes] = await Promise.all([
            fetch(`${pyUrl}/api/strategy/balance`).then(r => r.json()).catch(() => ({ balance: 0 })),
            fetch(`${pyUrl}/api/redeem/positions`).then(r => r.json()).catch(() => ({ positions: [] })),
            fetch(`${pyUrl}/api/strategy/wallet-overview`).then(r => r.json()).catch(() => ({})),
          ]);
          const usdc = (balRes as Record<string, unknown>).balance as number || 0;
          const positions = ((posRes as Record<string, unknown>).positions || []) as Array<Record<string, unknown>>;
          const unredeemed = positions.reduce((sum: number, p) => sum + ((p.currentValue as number) || 0), 0);
          const redeemable = positions.filter(p => p.redeemable).length;
          const pol = (polRes as Record<string, unknown>).pol_balance as number || 0;
          const walletAddress = (polRes as Record<string, unknown>).wallet_address as string || "";
          const pendingWinsValue = (polRes as Record<string, unknown>).pending_wins_value as number || 0;
          const pendingWinsCount = (polRes as Record<string, unknown>).pending_wins_count as number || 0;
          jsonResponse(res, {
            usdc_balance: usdc,
            total_balance: usdc + unredeemed + pendingWinsValue,
            unredeemed_value: unredeemed,
            unredeemed_count: redeemable,
            pending_wins_value: pendingWinsValue,
            pending_wins_count: pendingWinsCount,
            pol_balance: pol,
            wallet_address: walletAddress,
            position_count: positions.length,
            redeemable_count: redeemable,
          });
        } catch (e) {
          jsonResponse(res, { usdc_balance: 0, total_balance: 0, unredeemed_value: 0, error: String(e) });
        }
        return;
      }

      // ── Wrangler dev proxy for non-strategy endpoints ──────────────
      // Bot detection, firehose, copy trading, etc. live in wrangler dev (port 8788).
      // Forward unrecognized /api/* requests to the local wrangler dev instance.
      const cloudWorkerUrl = process.env.WORKER_PROXY_URL || "http://127.0.0.1:8788";
      if (url.pathname.startsWith("/api/")) {
        try {
          const target = `${cloudWorkerUrl}${url.pathname}${url.search}`;
          const fetchOpts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
          if (method === "POST") {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            const bodyStr = Buffer.concat(chunks).toString();
            if (bodyStr) fetchOpts.body = bodyStr;
          }
          const proxyRes = await fetch(target, fetchOpts);
          const data = await proxyRes.text();
          res.writeHead(proxyRes.status, {
            "Content-Type": proxyRes.headers.get("content-type") || "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(data);
        } catch (proxyErr) {
          console.error("[proxy] Cloud Worker proxy error:", proxyErr);
          jsonResponse(res, { error: "Cloud Worker proxy failed" }, 502);
        }
        return;
      }

      jsonResponse(res, { error: "Not found" }, 404);
    } catch (e) {
      console.error("HTTP error:", e);
      jsonResponse(res, { error: String(e) }, 500);
    }
  });

  server.listen(port, () => {
    console.log(`[standalone-runner] HTTP server listening on port ${port}`);
  });

  return server;
}

// ── Main ──

async function main() {
  const { configId, dbPath, port, pythonApiUrl } = parseArgs();

  console.log("═".repeat(60));
  console.log("Standalone Strategy Runner (no DO eviction)");
  console.log(`Database: ${dbPath}`);
  console.log(`Config:   ${configId ?? "(auto-start all active)"}`);
  console.log(`Port:     ${port}`);
  console.log(`Python:   ${pythonApiUrl}`);
  console.log("═".repeat(60));

  sqliteDb = new Database(dbPath);
  sqliteDb.pragma("journal_mode = WAL");
  d1Db = createD1Wrapper(sqliteDb);

  // Enable oracle feed (Chainlink authenticated → RTDS fallback)
  try {
    const { enableOracleFeed } = await import("./strategies/oracle-feed");
    const { CRYPTO_SYMBOL_MAP } = await import("./strategies/price-feed");
    const allCryptos = new Set<string>();
    const rows = sqliteDb.prepare("SELECT params FROM strategy_configs WHERE active = 1").all() as Array<{ params: string }>;
    for (const row of rows) {
      try {
        const params = JSON.parse(row.params);
        if (Array.isArray(params.target_cryptos)) {
          for (const c of params.target_cryptos as string[]) {
            const upper = c.toUpperCase();
            // Already a Binance symbol (e.g. "BTCUSDT")
            if (upper.endsWith("USDT")) { allCryptos.add(upper); continue; }
            // Keyword (e.g. "Bitcoin", "btc") → map to Binance symbol
            const mapped = CRYPTO_SYMBOL_MAP[c.toLowerCase()];
            if (mapped) allCryptos.add(mapped);
          }
        }
      } catch { /* skip malformed params */ }
    }
    if (allCryptos.size === 0) {
      ["BTCUSDT", "ETHUSDT", "SOLUSDT"].forEach(s => allCryptos.add(s));
    }
    enableOracleFeed([...allCryptos]);
    console.log(`Oracle feed: enabled for ${[...allCryptos].join(", ")}`);
  } catch (e) {
    console.log(`Oracle feed: unavailable (${e instanceof Error ? e.message : String(e)})`);
  }

  // Start HTTP server
  startServer(port, pythonApiUrl);

  if (configId) {
    // Start the specified strategy
    const result = await startStrategy(configId, pythonApiUrl);
    if (result !== "started") {
      console.error(`Failed to start strategy: ${result}`);
      process.exit(1);
    }
    console.log(`\nStrategy ${configId} running. Ticks every ${instances.get(configId)!.config.tick_interval_ms}ms.`);
  } else {
    // Auto-start all active configs
    const rows = sqliteDb.prepare("SELECT id, name FROM strategy_configs WHERE active = 1").all() as Array<{ id: string; name: string }>;
    if (rows.length === 0) {
      console.log("\nNo active strategies found. Server is running — use POST /api/strategy/start/:id to start one.");
    } else {
      console.log(`\nAuto-starting ${rows.length} active strategies...`);
      for (const row of rows) {
        const result = await startStrategy(row.id, pythonApiUrl);
        console.log(`  ${row.name} (${row.id}): ${result}`);
      }
    }
  }
  console.log("Press Ctrl+C to stop.\n");

  // Graceful shutdown — flush state but keep active=1 so strategies auto-restart.
  // Only explicit POST /stop sets active=0.
  const shutdown = async () => {
    console.log("\n[standalone-runner] Shutting down (preserving active flags)...");
    for (const [id, inst] of instances) {
      try { flushLogs(inst); } catch { /* ignore */ }
      persistState(inst);
      console.log(`  Saved state for ${id}`);
    }
    sqliteDb.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
