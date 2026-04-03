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
} from "./strategy-core";

// ── CLI args ──

function parseArgs() {
  const args = process.argv.slice(2);
  let configId = "";
  let dbPath = "";
  let port = 8787;
  let pythonApiUrl = "http://127.0.0.1:8000";

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
        if (files.length > 0) { dbPath = path.join(dir, files[0]); break; }
      }
    }
  }

  if (!dbPath) {
    console.error("ERROR: Could not find D1 SQLite database.");
    console.error("Specify with: --db=path/to/database.sqlite");
    process.exit(1);
  }

  if (!configId) {
    console.error("ERROR: --config-id is required.");
    console.error("Usage: npx tsx src/standalone-runner.ts --config-id=strat-xxx");
    process.exit(1);
  }

  return { configId, dbPath, port, pythonApiUrl };
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

  // Recover total_pnl from D1 if state was empty
  if (state.ticks === 0 && state.total_pnl === 0) {
    const row = sqliteDb.prepare(
      "SELECT COALESCE(SUM(pnl), 0) as total_pnl, COUNT(*) as trade_count FROM strategy_trades WHERE strategy_id = ?"
    ).get(configId) as { total_pnl: number; trade_count: number } | undefined;
    if (row && row.trade_count > 0) {
      state.total_pnl = row.total_pnl;
    }
  }

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

async function tick(inst: RunnerInstance) {
  const ctx = buildContext(inst);

  try {
    await inst.strategy.tick(ctx);
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

// ── HTTP server ──

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

          jsonResponse(res, {
            running: true,
            winding_down: inst.state.windingDown,
            active_windows: ((inst.state.custom as Record<string, unknown>)?.activeWindows as unknown[] | undefined)?.length ?? 0,
            config: inst.config,
            state: responseState,
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
        const statuses = [];
        // Load all configs from D1
        const rows = sqliteDb.prepare("SELECT id FROM strategy_configs").all() as Array<{ id: string }>;
        for (const row of rows) {
          const inst = instances.get(row.id);
          if (inst) {
            statuses.push({
              config_id: row.id,
              running: true,
              name: inst.config.name,
              ticks: inst.state.ticks,
              total_pnl: inst.state.total_pnl,
              last_tick_at: inst.state.last_tick_at,
            });
          } else {
            const config = loadConfig(row.id);
            statuses.push({
              config_id: row.id,
              running: false,
              name: config?.name || row.id,
            });
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
  console.log(`Config:   ${configId}`);
  console.log(`Port:     ${port}`);
  console.log(`Python:   ${pythonApiUrl}`);
  console.log("═".repeat(60));

  sqliteDb = new Database(dbPath);
  sqliteDb.pragma("journal_mode = WAL");
  d1Db = createD1Wrapper(sqliteDb);

  // Start HTTP server
  startServer(port, pythonApiUrl);

  // Start the specified strategy
  const result = await startStrategy(configId, pythonApiUrl);
  if (result !== "started") {
    console.error(`Failed to start strategy: ${result}`);
    process.exit(1);
  }

  console.log(`\nStrategy ${configId} running. Ticks every ${instances.get(configId)!.config.tick_interval_ms}ms.`);
  console.log("Press Ctrl+C to stop.\n");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[standalone-runner] Shutting down...");
    for (const [id] of instances) {
      await stopStrategy(id);
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
