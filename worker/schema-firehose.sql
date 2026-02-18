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
