-- Operational tables: copy trading + bot detection (small, stable)
CREATE TABLE IF NOT EXISTS copy_targets (
    wallet TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'paper',
    trade_pct REAL NOT NULL DEFAULT 10.0,
    max_position_usd REAL NOT NULL DEFAULT 100.0,
    active INTEGER NOT NULL DEFAULT 1,
    total_paper_pnl REAL NOT NULL DEFAULT 0.0,
    total_real_pnl REAL NOT NULL DEFAULT 0.0,
    slippage_bps REAL NOT NULL DEFAULT 50.0,
    latency_ms REAL NOT NULL DEFAULT 2000.0,
    fee_rate REAL NOT NULL DEFAULT 0.0,
    measured_slippage_bps REAL NOT NULL DEFAULT -1
);

CREATE TABLE IF NOT EXISTS copy_trades (
    id TEXT PRIMARY KEY,
    source_trade_id TEXT,
    source_wallet TEXT NOT NULL,
    market TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL NOT NULL,
    mode TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    pnl REAL NOT NULL DEFAULT 0.0,
    source_price REAL NOT NULL DEFAULT 0.0,
    exec_price REAL NOT NULL DEFAULT 0.0,
    fee_amount REAL NOT NULL DEFAULT 0.0
);

CREATE INDEX IF NOT EXISTS idx_copy_trades_wallet ON copy_trades(source_wallet);

-- suspect_bots now lives in FIREHOSE_DB (schema-firehose.sql)

-- Strategy execution tables
CREATE TABLE IF NOT EXISTS strategy_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    strategy_type TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'paper',
    active INTEGER NOT NULL DEFAULT 0,
    params TEXT NOT NULL DEFAULT '{}',
    tick_interval_ms INTEGER NOT NULL DEFAULT 5000,
    max_capital_usd REAL NOT NULL DEFAULT 200,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategy_orders (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    market TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    side TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    placed_at TEXT NOT NULL DEFAULT (datetime('now')),
    filled_at TEXT,
    cancelled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_strategy_orders_strategy ON strategy_orders(strategy_id);

CREATE TABLE IF NOT EXISTS strategy_trades (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    market TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    side TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL NOT NULL,
    fee_amount REAL NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    pnl REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_strategy_trades_strategy ON strategy_trades(strategy_id);

CREATE TABLE IF NOT EXISTS strategy_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    tick INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    symbol TEXT,
    direction TEXT,
    signal_strength REAL,
    price_change_pct REAL,
    momentum REAL,
    volatility_regime TEXT,
    in_dead_zone INTEGER,
    flip_count INTEGER,
    up_inventory REAL,
    down_inventory REAL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_strategy_logs_strategy ON strategy_logs(strategy_id, timestamp);

-- Balance protection (ratchet lock)
-- NULL = disabled (backward compatible)
ALTER TABLE strategy_configs ADD COLUMN balance_usd REAL DEFAULT NULL;
ALTER TABLE strategy_configs ADD COLUMN lock_increment_usd REAL DEFAULT NULL;
