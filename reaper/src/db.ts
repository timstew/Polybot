/**
 * SQLite database — the durable source of truth for all order and window state.
 *
 * Key principle: NEVER store order state only in memory.
 * Every order is persisted before placement, every fill is recorded immediately.
 * Process restarts recover fully from this database.
 *
 * Uses bun:sqlite — Bun's built-in SQLite (faster than better-sqlite3).
 */

import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";

let db: Database;

export function getDb(): Database {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}

export function initDb(dbPath?: string): Database {
  const resolvedPath = dbPath || path.join(process.cwd(), "reaper.db");
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

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

    -- Fill events — every fill from any detection path
    -- Source values: user_ws, immediate, rest_reconcile, cancel_fill,
    --                paper_shadow, paper_grounded, paper_book
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
      source TEXT NOT NULL,
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

    -- Shadow trades — every trade from the tracked wallet (e.g., Bonereaper)
    -- Recorded regardless of fill mode; used for analysis and offline replay.
    CREATE TABLE IF NOT EXISTS shadow_trades (
      id TEXT PRIMARY KEY,                    -- tx hash or synthetic id (dedup key)
      wallet TEXT NOT NULL,                   -- shadow wallet address
      window_slug TEXT,                       -- market slug (nullable — may be non-crypto)
      condition_id TEXT,                      -- market condition id
      token_id TEXT,                          -- asset id
      side TEXT CHECK(side IN ('UP','DOWN','YES','NO','OTHER')),
      buy_sell TEXT CHECK(buy_sell IN ('BUY','SELL')),
      price REAL NOT NULL,
      size REAL NOT NULL,
      timestamp INTEGER NOT NULL,             -- unix ms
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_trades_slug ON shadow_trades(window_slug);
    CREATE INDEX IF NOT EXISTS idx_shadow_trades_ts ON shadow_trades(timestamp);

    -- Per-second trade tape buckets (for accurate offline replay)
    -- Aggregated from real-time market WS events: one row per token per second.
    -- ~5 MB/day, supports fill simulation: "did trades happen at ≤ our bid with enough volume?"
    CREATE TABLE IF NOT EXISTS tape_buckets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      window_slug TEXT,
      bucket_ts INTEGER NOT NULL,         -- unix seconds (floor of event timestamp)
      trade_count INTEGER NOT NULL,
      total_volume REAL NOT NULL,
      min_price REAL NOT NULL,
      max_price REAL NOT NULL,
      vwap REAL NOT NULL,                 -- volume-weighted average price
      side_buy_volume REAL DEFAULT 0,     -- volume from BUY-side trades
      side_sell_volume REAL DEFAULT 0     -- volume from SELL-side trades
    );
    CREATE INDEX IF NOT EXISTS idx_tape_buckets_token_ts ON tape_buckets(token_id, bucket_ts);
    CREATE INDEX IF NOT EXISTS idx_tape_buckets_slug ON tape_buckets(window_slug, bucket_ts);

    -- Goldsky subgraph orderFilledEvents (deep historical fill data)
    -- Raw dump keyed by event id; tracked_wallet tags which config wallet this
    -- event belongs to (as maker or taker). Amounts are raw uint256 strings;
    -- divide by 1e6 for USDC.
    CREATE TABLE IF NOT EXISTS goldsky_trades (
      id TEXT PRIMARY KEY,                -- Goldsky event id (unique)
      timestamp INTEGER NOT NULL,         -- unix seconds
      maker TEXT NOT NULL,
      maker_asset_id TEXT NOT NULL,
      maker_amount_filled TEXT NOT NULL,  -- raw (divide by 1e6)
      taker TEXT NOT NULL,
      taker_asset_id TEXT NOT NULL,
      taker_amount_filled TEXT NOT NULL,
      fee TEXT,
      order_hash TEXT,
      transaction_hash TEXT,
      tracked_wallet TEXT NOT NULL,       -- the config wallet matched (lowercase)
      role TEXT NOT NULL CHECK(role IN ('maker','taker')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_goldsky_wallet_ts ON goldsky_trades(tracked_wallet, timestamp);
    CREATE INDEX IF NOT EXISTS idx_goldsky_timestamp ON goldsky_trades(timestamp);

    -- Resume cursor per (wallet, role). Sticky-cursor pattern: when a batch
    -- is full and all events share the same timestamp, we paginate by id at
    -- that timestamp until the timestamp is exhausted.
    CREATE TABLE IF NOT EXISTS goldsky_cursor (
      wallet TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('maker','taker')),
      last_timestamp INTEGER NOT NULL DEFAULT 0,
      last_id TEXT,
      sticky_timestamp INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (wallet, role)
    );

    -- Per-tick window snapshots (for charts + drill-down)
    CREATE TABLE IF NOT EXISTS window_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      window_slug TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      p_true REAL,
      spot_price REAL,
      up_best_bid REAL,
      up_best_ask REAL,
      up_bid_size REAL,
      up_ask_size REAL,
      up_last_trade REAL,
      dn_best_bid REAL,
      dn_best_ask REAL,
      dn_bid_size REAL,
      dn_ask_size REAL,
      dn_last_trade REAL,
      up_inventory REAL,
      down_inventory REAL,
      up_avg_cost REAL,
      down_avg_cost REAL,
      phase TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_window_ticks_slug_ts ON window_ticks(window_slug, timestamp DESC);
  `);

  // Migration: drop CHECK constraint on fills.source if present (pre-v0.2 schema)
  migrateFillsSource(db);

  // Migration: add last_trade columns to window_ticks if missing
  addColumnIfMissing(db, "window_ticks", "up_last_trade", "REAL");
  addColumnIfMissing(db, "window_ticks", "dn_last_trade", "REAL");

  // Migration: add confirmed column to windows (false = predicted from oracle, true = confirmed by Gamma)
  addColumnIfMissing(db, "windows", "confirmed", "INTEGER DEFAULT 0");
  // Migration: capture spot price at window close (oracle-preferred, for instant resolution)
  addColumnIfMissing(db, "windows", "spot_at_close", "REAL");

  console.log(`[DB] Initialized at ${resolvedPath}`);
  return db;
}

/** Add a column if it doesn't exist on the given table. */
function addColumnIfMissing(db: Database, table: string, col: string, type: string): void {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (info.some(c => c.name === col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

/** One-time migration: rebuild fills table without the source CHECK constraint. */
function migrateFillsSource(db: Database): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fills'"
  ).get() as { sql: string } | null;
  if (!row) return;
  // Old schema had: source TEXT NOT NULL CHECK(source IN (...))
  // If it's present, rebuild the table.
  if (!row.sql.includes("CHECK(source IN")) return;

  console.log("[DB] Migrating fills table to allow new source values…");
  db.exec(`
    BEGIN TRANSACTION;
    CREATE TABLE fills_new (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      clob_order_id TEXT,
      window_slug TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('UP', 'DOWN')),
      price REAL NOT NULL,
      size REAL NOT NULL,
      fee REAL DEFAULT 0,
      source TEXT NOT NULL,
      is_maker INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO fills_new SELECT * FROM fills;
    DROP TABLE fills;
    ALTER TABLE fills_new RENAME TO fills;
    CREATE INDEX IF NOT EXISTS idx_fills_window ON fills(window_slug);
    CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(clob_order_id);
    COMMIT;
  `);
  console.log("[DB] Migration complete.");
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
  const row = getDb().prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | null;
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
