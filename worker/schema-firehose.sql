-- Firehose tables: trade ingestion + wallet discovery (large, high-volume)
CREATE TABLE IF NOT EXISTS firehose_trades (
    id TEXT PRIMARY KEY,
    market TEXT NOT NULL,
    asset_id TEXT NOT NULL DEFAULT '',
    side TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL NOT NULL,
    timestamp TEXT NOT NULL,
    taker TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_firehose_trades_taker ON firehose_trades(taker);
CREATE INDEX IF NOT EXISTS idx_firehose_trades_ts ON firehose_trades(timestamp);

-- Firehose: discovered wallet addresses
CREATE TABLE IF NOT EXISTS firehose_wallets (
    wallet TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'trade',
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    trade_count INTEGER NOT NULL DEFAULT 0
);

-- Detected bots from cloud scanning (moved from ops DB)
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
