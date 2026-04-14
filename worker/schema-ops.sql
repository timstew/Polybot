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
    balance_usd REAL DEFAULT NULL,
    lock_increment_usd REAL DEFAULT NULL,
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

-- Orchestrator regime performance log
CREATE TABLE IF NOT EXISTS strategy_regime_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    condition_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    window_duration_ms INTEGER NOT NULL,
    regime TEXT NOT NULL,
    regime_confidence REAL NOT NULL,
    regime_streak INTEGER NOT NULL,
    tactic_id TEXT NOT NULL,
    features TEXT NOT NULL DEFAULT '{}',
    ema_scores TEXT NOT NULL DEFAULT '{}',
    outcome TEXT,
    pnl REAL,
    fill_count INTEGER,
    pair_cost REAL,
    was_override INTEGER DEFAULT 0,
    entered_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_regime_log_strategy ON strategy_regime_log(strategy_id, entered_at);

-- Strategy snapshot recording for offline replay / parameter optimization
CREATE TABLE IF NOT EXISTS strategy_snapshots (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    window_title TEXT NOT NULL,
    crypto_symbol TEXT NOT NULL,
    window_open_time INTEGER NOT NULL,
    window_end_time INTEGER NOT NULL,
    window_duration_ms INTEGER NOT NULL,
    oracle_strike REAL,
    price_at_open REAL NOT NULL,
    hour_utc INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL,
    up_token_id TEXT NOT NULL DEFAULT '',
    down_token_id TEXT NOT NULL DEFAULT '',
    outcome TEXT,
    ticks TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_strategy ON strategy_snapshots(strategy_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON strategy_snapshots(hour_utc, day_of_week);

-- Bandit tactic scores (Thompson Sampling)
CREATE TABLE IF NOT EXISTS tactic_scores (
    strategy_id TEXT NOT NULL,
    regime TEXT NOT NULL,
    tactic_id TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    total_pnl REAL NOT NULL DEFAULT 0,
    sum_pnl_sq REAL NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    avg_pnl REAL NOT NULL DEFAULT 0,
    variance REAL NOT NULL DEFAULT 0,
    last_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (strategy_id, regime, tactic_id)
);

-- Shadow wallet activity snapshots (compressed per-slug summaries)
CREATE TABLE IF NOT EXISTS shadow_wallet_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    shadow_wallet TEXT NOT NULL,
    slug TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    up_fills INTEGER NOT NULL DEFAULT 0,
    dn_fills INTEGER NOT NULL DEFAULT 0,
    up_avg_price REAL NOT NULL DEFAULT 0,
    dn_avg_price REAL NOT NULL DEFAULT 0,
    up_total_size REAL NOT NULL DEFAULT 0,
    dn_total_size REAL NOT NULL DEFAULT 0,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shadow_activity_strategy ON shadow_wallet_activity(strategy_id, slug);
CREATE INDEX IF NOT EXISTS idx_shadow_activity_time ON shadow_wallet_activity(timestamp);
