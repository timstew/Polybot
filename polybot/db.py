"""SQLite database layer for persistent storage."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Optional

from polybot.models import (
    BotCategory,
    BotProfitability,
    BotSignals,
    CopyMode,
    CopyTarget,
    CopyTrade,
    SuspectBot,
    Trade,
    TradeSide,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    market TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL NOT NULL,
    timestamp TEXT NOT NULL,
    maker TEXT,
    taker TEXT,
    title TEXT,
    outcome TEXT
);

CREATE INDEX IF NOT EXISTS idx_trades_taker ON trades(taker);
CREATE INDEX IF NOT EXISTS idx_trades_maker ON trades(maker);
CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);

CREATE TABLE IF NOT EXISTS suspect_bots (
    wallet TEXT PRIMARY KEY,
    confidence REAL NOT NULL,
    category TEXT NOT NULL,
    signals TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    tags TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS copy_targets (
    wallet TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'paper',
    trade_pct REAL NOT NULL DEFAULT 10.0,
    max_position_usd REAL NOT NULL DEFAULT 100.0,
    active INTEGER NOT NULL DEFAULT 1,
    total_paper_pnl REAL NOT NULL DEFAULT 0.0,
    total_real_pnl REAL NOT NULL DEFAULT 0.0
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
    pnl REAL NOT NULL DEFAULT 0.0
);

CREATE INDEX IF NOT EXISTS idx_copy_trades_wallet ON copy_trades(source_wallet);

CREATE TABLE IF NOT EXISTS analyzed_wallets (
    wallet TEXT PRIMARY KEY,
    analyzed_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'detected'
);
"""


class Database:
    def __init__(self, db_path: str = "data/polybot.db"):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """Add columns that may not exist in older databases."""
        migrations = [
            ("copy_targets", "slippage_bps", "REAL NOT NULL DEFAULT 50.0"),
            ("copy_targets", "latency_ms", "REAL NOT NULL DEFAULT 2000.0"),
            ("copy_targets", "fee_rate", "REAL NOT NULL DEFAULT 0.0"),
            ("copy_trades", "source_price", "REAL NOT NULL DEFAULT 0.0"),
            ("copy_trades", "exec_price", "REAL NOT NULL DEFAULT 0.0"),
            ("copy_trades", "fee_amount", "REAL NOT NULL DEFAULT 0.0"),
            ("copy_targets", "measured_slippage_bps", "REAL NOT NULL DEFAULT -1"),
        ]
        for table, col, col_type in migrations:
            try:
                self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}")
            except sqlite3.OperationalError:
                pass  # column already exists
        self.conn.commit()

    def close(self):
        self.conn.close()

    # ── Trades ──────────────────────────────────────────────────────

    def insert_trade(self, trade: Trade) -> None:
        self.conn.execute(
            """INSERT OR IGNORE INTO trades
               (id, market, asset_id, side, price, size, timestamp, maker, taker, title, outcome)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                trade.id,
                trade.market,
                trade.asset_id,
                trade.side.value,
                trade.price,
                trade.size,
                trade.timestamp.isoformat(),
                trade.maker,
                trade.taker,
                trade.title,
                trade.outcome,
            ),
        )
        self.conn.commit()

    def insert_trades_batch(self, trades: list[Trade]) -> int:
        rows = [
            (
                t.id,
                t.market,
                t.asset_id,
                t.side.value,
                t.price,
                t.size,
                t.timestamp.isoformat(),
                t.maker,
                t.taker,
                t.title,
                t.outcome,
            )
            for t in trades
        ]
        self.conn.executemany(
            """INSERT OR IGNORE INTO trades
               (id, market, asset_id, side, price, size, timestamp, maker, taker, title, outcome)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
        self.conn.commit()
        return len(rows)

    def get_trades_for_wallet(self, wallet: str, limit: int = 1000) -> list[Trade]:
        cursor = self.conn.execute(
            """SELECT * FROM trades
               WHERE maker = ? OR taker = ?
               ORDER BY timestamp DESC LIMIT ?""",
            (wallet, wallet, limit),
        )
        return [self._row_to_trade(r) for r in cursor.fetchall()]

    def get_trades_for_market(self, market: str, limit: int = 1000) -> list[Trade]:
        cursor = self.conn.execute(
            """SELECT * FROM trades WHERE market = ?
               ORDER BY timestamp DESC LIMIT ?""",
            (market, limit),
        )
        return [self._row_to_trade(r) for r in cursor.fetchall()]

    def get_active_wallets(self, min_trades: int = 5) -> list[tuple[str, int]]:
        """Return wallets with at least min_trades, ordered by trade count."""
        cursor = self.conn.execute(
            """SELECT wallet, cnt FROM (
                 SELECT taker AS wallet, COUNT(*) AS cnt FROM trades GROUP BY taker
                 UNION ALL
                 SELECT maker AS wallet, COUNT(*) AS cnt FROM trades GROUP BY maker
               )
               WHERE wallet != ''
               GROUP BY wallet
               HAVING SUM(cnt) >= ?
               ORDER BY SUM(cnt) DESC""",
            (min_trades,),
        )
        return [(r["wallet"], r["cnt"]) for r in cursor.fetchall()]

    def get_all_wallets_trade_counts(self) -> dict[str, int]:
        """Return {wallet: trade_count} for all wallets."""
        cursor = self.conn.execute(
            """SELECT wallet, SUM(cnt) as total FROM (
                 SELECT taker AS wallet, COUNT(*) AS cnt FROM trades
                 WHERE taker != '' GROUP BY taker
                 UNION ALL
                 SELECT maker AS wallet, COUNT(*) AS cnt FROM trades
                 WHERE maker != '' GROUP BY maker
               )
               GROUP BY wallet
               ORDER BY total DESC"""
        )
        return {r["wallet"]: r["total"] for r in cursor.fetchall()}

    def get_trade_count(self) -> int:
        cursor = self.conn.execute("SELECT COUNT(*) as c FROM trades")
        return cursor.fetchone()["c"]

    def _row_to_trade(self, row: sqlite3.Row) -> Trade:
        return Trade(
            id=row["id"],
            market=row["market"],
            asset_id=row["asset_id"],
            side=TradeSide(row["side"]),
            price=row["price"],
            size=row["size"],
            timestamp=datetime.fromisoformat(row["timestamp"]),
            maker=row["maker"] or "",
            taker=row["taker"] or "",
            title=row["title"] or "",
            outcome=row["outcome"] or "",
        )

    # ── Suspect bots ────────────────────────────────────────────────

    def upsert_suspect_bot(self, bot: SuspectBot) -> None:
        self.conn.execute(
            """INSERT OR REPLACE INTO suspect_bots
               (wallet, confidence, category, signals, first_seen, last_seen, tags)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                bot.wallet,
                bot.confidence,
                bot.category.value,
                bot.signals.model_dump_json(),
                bot.first_seen.isoformat(),
                bot.last_seen.isoformat(),
                json.dumps(bot.tags),
            ),
        )
        self.conn.commit()

    def get_suspect_bots(self, min_confidence: float = 0.0) -> list[SuspectBot]:
        cursor = self.conn.execute(
            """SELECT * FROM suspect_bots WHERE confidence >= ?
               ORDER BY confidence DESC""",
            (min_confidence,),
        )
        return [self._row_to_bot(r) for r in cursor.fetchall()]

    def get_suspect_bot(self, wallet: str) -> Optional[SuspectBot]:
        cursor = self.conn.execute(
            "SELECT * FROM suspect_bots WHERE wallet = ?", (wallet,)
        )
        row = cursor.fetchone()
        return self._row_to_bot(row) if row else None

    def _row_to_bot(self, row: sqlite3.Row) -> SuspectBot:
        return SuspectBot(
            wallet=row["wallet"],
            confidence=row["confidence"],
            category=BotCategory(row["category"]),
            signals=BotSignals.model_validate_json(row["signals"]),
            first_seen=datetime.fromisoformat(row["first_seen"]),
            last_seen=datetime.fromisoformat(row["last_seen"]),
            tags=json.loads(row["tags"]),
        )

    # ── Copy targets ────────────────────────────────────────────────

    def upsert_copy_target(self, target: CopyTarget) -> None:
        self.conn.execute(
            """INSERT OR REPLACE INTO copy_targets
               (wallet, mode, trade_pct, max_position_usd, active,
                total_paper_pnl, total_real_pnl,
                slippage_bps, latency_ms, fee_rate, measured_slippage_bps)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                target.wallet,
                target.mode.value,
                target.trade_pct,
                target.max_position_usd,
                int(target.active),
                target.total_paper_pnl,
                target.total_real_pnl,
                target.slippage_bps,
                target.latency_ms,
                target.fee_rate,
                target.measured_slippage_bps,
            ),
        )
        self.conn.commit()

    def _row_to_copy_target(self, r: sqlite3.Row) -> CopyTarget:
        return CopyTarget(
            wallet=r["wallet"],
            mode=CopyMode(r["mode"]),
            trade_pct=r["trade_pct"],
            max_position_usd=r["max_position_usd"],
            active=bool(r["active"]),
            total_paper_pnl=r["total_paper_pnl"],
            total_real_pnl=r["total_real_pnl"],
            slippage_bps=r["slippage_bps"],
            latency_ms=r["latency_ms"],
            fee_rate=r["fee_rate"],
            measured_slippage_bps=r["measured_slippage_bps"],
        )

    def get_copy_targets(self, active_only: bool = True) -> list[CopyTarget]:
        sql = "SELECT * FROM copy_targets"
        if active_only:
            sql += " WHERE active = 1"
        cursor = self.conn.execute(sql)
        return [self._row_to_copy_target(r) for r in cursor.fetchall()]

    def get_copy_target(self, wallet: str) -> Optional[CopyTarget]:
        cursor = self.conn.execute(
            "SELECT * FROM copy_targets WHERE wallet = ?", (wallet,)
        )
        row = cursor.fetchone()
        if not row:
            return None
        return self._row_to_copy_target(row)

    def update_copy_target_measured_slippage(
        self, wallet: str, measured_slippage_bps: float
    ) -> None:
        """Persist the measured slippage average to the copy_targets table."""
        self.conn.execute(
            "UPDATE copy_targets SET measured_slippage_bps = ? WHERE wallet = ?",
            (measured_slippage_bps, wallet),
        )
        self.conn.commit()

    # ── Copy trades ─────────────────────────────────────────────────

    def insert_copy_trade(self, ct: CopyTrade) -> None:
        self.conn.execute(
            """INSERT OR IGNORE INTO copy_trades
               (id, source_trade_id, source_wallet, market, asset_id,
                side, price, size, mode, timestamp, status, pnl,
                source_price, exec_price, fee_amount)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                ct.id,
                ct.source_trade_id,
                ct.source_wallet,
                ct.market,
                ct.asset_id,
                ct.side.value,
                ct.price,
                ct.size,
                ct.mode.value,
                ct.timestamp.isoformat(),
                ct.status,
                ct.pnl,
                ct.source_price,
                ct.exec_price,
                ct.fee_amount,
            ),
        )
        self.conn.commit()

    def update_copy_trade_exec_price(
        self, copy_trade_id: str, exec_price: float
    ) -> None:
        """Update a copy trade's exec_price after slippage observation resolves."""
        self.conn.execute(
            "UPDATE copy_trades SET exec_price = ?, price = ? WHERE id = ?",
            (exec_price, exec_price, copy_trade_id),
        )
        self.conn.commit()

    def get_copy_trades(
        self, source_wallet: Optional[str] = None, limit: int = 100
    ) -> list[CopyTrade]:
        if source_wallet:
            cursor = self.conn.execute(
                """SELECT * FROM copy_trades WHERE source_wallet = ?
                   ORDER BY timestamp DESC LIMIT ?""",
                (source_wallet, limit),
            )
        else:
            cursor = self.conn.execute(
                "SELECT * FROM copy_trades ORDER BY timestamp DESC LIMIT ?",
                (limit,),
            )
        return [
            CopyTrade(
                id=r["id"],
                source_trade_id=r["source_trade_id"],
                source_wallet=r["source_wallet"],
                market=r["market"],
                asset_id=r["asset_id"],
                side=TradeSide(r["side"]),
                price=r["price"],
                size=r["size"],
                mode=CopyMode(r["mode"]),
                timestamp=datetime.fromisoformat(r["timestamp"]),
                status=r["status"],
                pnl=r["pnl"],
                source_price=r["source_price"],
                exec_price=r["exec_price"],
                fee_amount=r["fee_amount"],
            )
            for r in cursor.fetchall()
        ]

    def compute_copy_pnl(self, source_wallet: str) -> dict:
        """Compute paper P&L for a copy target using FIFO position matching.

        Returns {"realized_pnl": float, "total_fees": float, "avg_hold_time_hours": float}.
        """
        cursor = self.conn.execute(
            """SELECT asset_id, side, exec_price, price, size, fee_amount, timestamp
               FROM copy_trades
               WHERE source_wallet = ? AND status = 'filled'
               ORDER BY timestamp ASC""",
            (source_wallet,),
        )
        rows = cursor.fetchall()

        # FIFO matching per asset_id
        # positions[asset_id] = list of [remaining_size, entry_price, entry_timestamp]
        positions: dict[str, list[list]] = {}
        realized_pnl = 0.0
        total_fees = 0.0
        hold_times_s: list[float] = []

        for r in rows:
            asset_id = r["asset_id"]
            side = r["side"]
            price = r["exec_price"] if r["exec_price"] > 0 else r["price"]
            size = r["size"]
            fee = r["fee_amount"]
            ts = r["timestamp"]
            total_fees += fee

            if asset_id not in positions:
                positions[asset_id] = []

            if side == "BUY":
                positions[asset_id].append([size, price, ts])
            else:  # SELL
                remaining = size
                while remaining > 0 and positions[asset_id]:
                    lot = positions[asset_id][0]
                    match_qty = min(remaining, lot[0])
                    realized_pnl += (price - lot[1]) * match_qty
                    # Compute hold time for this matched lot
                    try:
                        buy_dt = datetime.fromisoformat(lot[2])
                        sell_dt = datetime.fromisoformat(ts)
                        hold_times_s.append((sell_dt - buy_dt).total_seconds())
                    except (ValueError, TypeError):
                        pass
                    lot[0] -= match_qty
                    remaining -= match_qty
                    if lot[0] <= 1e-9:
                        positions[asset_id].pop(0)

        avg_hold_hours = 0.0
        if hold_times_s:
            avg_hold_hours = (sum(hold_times_s) / len(hold_times_s)) / 3600

        return {
            "realized_pnl": realized_pnl,
            "total_fees": total_fees,
            "avg_hold_time_hours": avg_hold_hours,
        }

    # ── Analyzed wallets ────────────────────────────────────────────

    def mark_wallet_analyzed(self, wallet: str, status: str = "detected") -> None:
        """Record that a wallet has been analyzed. Status: detected|dismissed|copied."""
        self.conn.execute(
            """INSERT OR REPLACE INTO analyzed_wallets (wallet, analyzed_at, status)
               VALUES (?, ?, ?)""",
            (wallet, datetime.utcnow().isoformat(), status),
        )
        self.conn.commit()

    def is_wallet_analyzed(self, wallet: str) -> bool:
        cursor = self.conn.execute(
            "SELECT 1 FROM analyzed_wallets WHERE wallet = ?", (wallet,)
        )
        return cursor.fetchone() is not None

    def get_analyzed_wallets(self, status: str | None = None) -> list[str]:
        if status:
            cursor = self.conn.execute(
                "SELECT wallet FROM analyzed_wallets WHERE status = ?", (status,)
            )
        else:
            cursor = self.conn.execute("SELECT wallet FROM analyzed_wallets")
        return [r["wallet"] for r in cursor.fetchall()]

    def dismiss_wallet(self, wallet: str) -> None:
        """Mark a wallet as dismissed and remove from suspect_bots."""
        self.mark_wallet_analyzed(wallet, status="dismissed")
        self.conn.execute("DELETE FROM suspect_bots WHERE wallet = ?", (wallet,))
        self.conn.commit()

    def undismiss_wallet(self, wallet: str) -> None:
        """Remove a wallet's dismissed status so it can be re-detected."""
        self.conn.execute(
            "DELETE FROM analyzed_wallets WHERE wallet = ? AND status = 'dismissed'",
            (wallet,),
        )
        self.conn.commit()

    def prune_analyzed_before(self, days: int = 30) -> int:
        """Remove analyzed_wallets entries older than N days for re-evaluation."""
        cursor = self.conn.execute(
            "DELETE FROM analyzed_wallets WHERE analyzed_at < datetime('now', ?)",
            (f"-{days} days",),
        )
        self.conn.commit()
        return cursor.rowcount

    def prune_old_trades(self, days: int = 7) -> int:
        """Delete trades older than N days for wallets NOT in copy_targets."""
        cursor = self.conn.execute(
            """DELETE FROM trades WHERE timestamp < datetime('now', ?)
               AND taker NOT IN (SELECT wallet FROM copy_targets)
               AND maker NOT IN (SELECT wallet FROM copy_targets)""",
            (f"-{days} days",),
        )
        self.conn.commit()
        return cursor.rowcount
