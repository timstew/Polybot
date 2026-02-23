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
    measured_slippage_bps REAL NOT NULL DEFAULT -1,
    username TEXT NOT NULL DEFAULT '',
    full_copy_below_usd REAL NOT NULL DEFAULT 0.0,
    circuit_breaker_usd REAL NOT NULL DEFAULT 50.0,
    circuit_triggered_at TEXT,
    virtual_balance REAL NOT NULL DEFAULT 1000.0,
    virtual_balance_initial REAL NOT NULL DEFAULT 1000.0
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
    fee_amount REAL NOT NULL DEFAULT 0.0,
    title TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_copy_trades_wallet ON copy_trades(source_wallet);

-- Firehose: ingested trades from the Polymarket trade stream
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

-- Watchlist: lightweight monitoring tier between detection and copy-trading
CREATE TABLE IF NOT EXISTS watchlist (
    wallet TEXT PRIMARY KEY,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    added_by TEXT NOT NULL DEFAULT 'user',
    category TEXT NOT NULL DEFAULT 'unknown',
    check_interval_min INTEGER NOT NULL DEFAULT 60,
    last_checked TEXT,
    notes TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS watchlist_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
    profit_1d REAL NOT NULL DEFAULT 0,
    profit_7d REAL NOT NULL DEFAULT 0,
    profit_30d REAL NOT NULL DEFAULT 0,
    profit_all REAL NOT NULL DEFAULT 0,
    volume_24h REAL NOT NULL DEFAULT 0,
    win_rate REAL NOT NULL DEFAULT 0,
    open_positions INTEGER NOT NULL DEFAULT 0,
    active_markets INTEGER NOT NULL DEFAULT 0,
    avg_trade_size REAL NOT NULL DEFAULT 0,
    trades_24h INTEGER NOT NULL DEFAULT 0,
    copy_score REAL NOT NULL DEFAULT 0,
    positions_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_watchlist_snap_wallet ON watchlist_snapshots(wallet, snapshot_at);

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
