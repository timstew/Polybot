/**
 * SQLite database — the durable source of truth for all order and window state.
 *
 * Key principle: NEVER store order state only in memory.
 * Every order is persisted before placement, every fill is recorded immediately.
 * Process restarts recover fully from this database.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

let db: InstanceType<typeof Database>;

export function getDb(): InstanceType<typeof Database> {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}

export function initDb(dbPath?: string): InstanceType<typeof Database> {
  const resolvedPath = dbPath || path.join(process.cwd(), "reaper.db");
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create all tables
  db.exec(`
    -- Durable order ledger — every order ever placed
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,                -- our local UUID, assigned before placement
      clob_order_id TEXT,                 -- CLOB order ID (set after placement succeeds)
      token_id TEXT NOT NULL,
      window_slug TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('UP', 'DOWN')),
      buy_sell TEXT NOT NULL DEFAULT 'BUY' CHECK(buy_sell IN ('BUY', 'SELL')),
      price REAL NOT NULL,
      size REAL NOT NULL,
      size_matched REAL DEFAULT 0,
      avg_fill_price REAL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'OPEN', 'PARTIAL', 'FILLED', 'CANCELLED', 'FAILED')),
      order_type TEXT DEFAULT 'GTC',
      ladder_level INTEGER DEFAULT 1,
      reconcile_attempts INTEGER DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      filled_at TEXT,
      cancelled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_window ON orders(window_slug);
    CREATE INDEX IF NOT EXISTS idx_orders_clob ON orders(clob_order_id);

    -- Windows — active and completed
    CREATE TABLE IF NOT EXISTS windows (
      slug TEXT PRIMARY KEY,
      condition_id TEXT NOT NULL,
      title TEXT,
      crypto_symbol TEXT NOT NULL,
      up_token_id TEXT NOT NULL,
      down_token_id TEXT NOT NULL,
      open_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      oracle_strike REAL,
      price_at_open REAL,
      status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'RESOLVING', 'RESOLVED', 'EXPIRED')),
      outcome TEXT CHECK(outcome IN ('UP', 'DOWN', 'UNKNOWN', NULL)),
      entered_at TEXT,
      resolved_at TEXT,
      -- Inventory (updated on every fill/merge)
      up_inventory REAL DEFAULT 0,
      up_avg_cost REAL DEFAULT 0,
      down_inventory REAL DEFAULT 0,
      down_avg_cost REAL DEFAULT 0,
      peak_up_inventory REAL DEFAULT 0,
      peak_down_inventory REAL DEFAULT 0,
      -- Stats
      fill_count INTEGER DEFAULT 0,
      total_buy_cost REAL DEFAULT 0,
      total_merged REAL DEFAULT 0,
      merge_pnl REAL DEFAULT 0,
      resolution_pnl REAL DEFAULT 0,
      net_pnl REAL DEFAULT 0,
      estimated_rebates REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_windows_status ON windows(status);

    -- Fill events — every fill from WebSocket or reconciliation
    CREATE TABLE IF NOT EXISTS fills (
      id TEXT PRIMARY KEY,                -- trade ID from CLOB (dedup key)
      order_id TEXT,                      -- links to orders.id (our local ID)
      clob_order_id TEXT,                 -- links to orders.clob_order_id
      window_slug TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('UP', 'DOWN')),
      price REAL NOT NULL,
      size REAL NOT NULL,
      fee REAL DEFAULT 0,
      source TEXT NOT NULL CHECK(source IN ('user_ws', 'rest_reconcile', 'immediate', 'cancel_fill')),
      is_maker INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fills_window ON fills(window_slug);
    CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(clob_order_id);

    -- Merge/redeem events
    CREATE TABLE IF NOT EXISTS exits (
      id TEXT PRIMARY KEY,
      window_slug TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('MERGE', 'REDEEM')),
      amount REAL NOT NULL,
      pnl REAL,
      tx_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Activity log — every event for the frontend feed
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      window_slug TEXT,
      side TEXT,
      detail TEXT NOT NULL,
      level TEXT DEFAULT 'info' CHECK(level IN ('info', 'trade', 'signal', 'warning', 'error'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(timestamp DESC);

    -- Strategy config (key-value)
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  console.log(`[DB] Initialized at ${resolvedPath}`);
  return db;
}

// ── Activity log helpers ────────────────────────────────────────────

export function logActivity(
  type: string,
  detail: string | Record<string, unknown>,
  opts?: { windowSlug?: string; side?: string; level?: "info" | "trade" | "signal" | "warning" | "error" }
): void {
  const detailStr = typeof detail === "string" ? detail : JSON.stringify(detail);
  getDb().prepare(
    "INSERT INTO activity_log (type, window_slug, side, detail, level) VALUES (?, ?, ?, ?, ?)"
  ).run(type, opts?.windowSlug ?? null, opts?.side ?? null, detailStr, opts?.level ?? "info");
}

// ── Config helpers ──────────────────────────────────────────────────

export function getConfig(key: string, defaultValue?: string): string | undefined {
  const row = getDb().prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? defaultValue;
}

export function setConfig(key: string, value: string): void {
  getDb().prepare(
    "INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
  ).run(key, value, value);
}

export function getAllConfig(): Record<string, string> {
  const rows = getDb().prepare("SELECT key, value FROM config").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
