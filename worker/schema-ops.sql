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
