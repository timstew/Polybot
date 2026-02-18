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

-- Detected bots from cloud scanning
CREATE TABLE IF NOT EXISTS suspect_bots (
    wallet TEXT PRIMARY KEY,
    confidence REAL NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'unknown',
    trade_count INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    pnl_pct REAL NOT NULL DEFAULT 0,
    realized_pnl REAL NOT NULL DEFAULT 0,
    win_rate REAL NOT NULL DEFAULT 0,
    total_volume_usd REAL NOT NULL DEFAULT 0,
    profit_1d REAL NOT NULL DEFAULT 0,
    profit_7d REAL NOT NULL DEFAULT 0,
    profit_30d REAL NOT NULL DEFAULT 0,
    profit_all REAL NOT NULL DEFAULT 0,
    username TEXT NOT NULL DEFAULT '',
    copy_score REAL NOT NULL DEFAULT 0
);
