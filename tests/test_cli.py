"""Tests for the CLI interface."""

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from click.testing import CliRunner

from polybot.cli import cli
from polybot.db import Database
from polybot.models import (
    BotCategory,
    BotSignals,
    CopyMode,
    CopyTarget,
    CopyTrade,
    SuspectBot,
    Trade,
    TradeSide,
)


@pytest.fixture
def runner():
    return CliRunner()


@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "test.db")


@pytest.fixture
def populated_db(db_path):
    """A database with some sample data pre-loaded."""
    db = Database(db_path)
    base = datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc)

    # Insert trades for a "bot" wallet
    for i in range(30):
        db.insert_trade(Trade(
            id=f"t{i}",
            market=f"market_{i % 5}",
            asset_id=f"asset_{i % 5}",
            side=TradeSide.BUY if i % 2 == 0 else TradeSide.SELL,
            price=0.50,
            size=100,
            timestamp=base + timedelta(seconds=i * 10),
            taker="0xbotwalletabc123",
        ))

    # Insert a suspect bot
    db.upsert_suspect_bot(SuspectBot(
        wallet="0xbotwalletabc123",
        confidence=0.85,
        category=BotCategory.MARKET_MAKER,
        signals=BotSignals(trade_count=30, unique_markets=5),
        tags=["24/7", "clockwork"],
    ))

    db.close()
    return db_path


class TestCLIBasic:
    def test_help(self, runner):
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "Polybot" in result.output

    def test_stats_empty(self, runner, db_path):
        result = runner.invoke(cli, ["stats"], env={"POLYBOT_DB_PATH": db_path})
        assert result.exit_code == 0
        assert "Total trades ingested" in result.output

    def test_bots_empty(self, runner, db_path):
        result = runner.invoke(cli, ["bots"], env={"POLYBOT_DB_PATH": db_path})
        assert result.exit_code == 0
        assert "No bots" in result.output

    def test_targets_empty(self, runner, db_path):
        result = runner.invoke(cli, ["targets"], env={"POLYBOT_DB_PATH": db_path})
        assert result.exit_code == 0
        assert "No copy targets" in result.output

    def test_trades_empty(self, runner, db_path):
        result = runner.invoke(cli, ["trades"], env={"POLYBOT_DB_PATH": db_path})
        assert result.exit_code == 0
        assert "No copy trades" in result.output


class TestCLIWithData:
    def test_stats_with_data(self, runner, populated_db):
        result = runner.invoke(cli, ["stats"], env={"POLYBOT_DB_PATH": populated_db})
        assert result.exit_code == 0
        assert "30" in result.output  # 30 trades

    def test_bots_list(self, runner, populated_db):
        result = runner.invoke(cli, ["bots"], env={"POLYBOT_DB_PATH": populated_db})
        assert result.exit_code == 0
        assert "market_maker" in result.output

    def test_detect(self, runner, populated_db):
        result = runner.invoke(
            cli,
            ["detect", "--min-trades", "5", "--min-confidence", "0.1"],
            env={"POLYBOT_DB_PATH": populated_db},
        )
        assert result.exit_code == 0

    def test_copy_and_uncopy(self, runner, populated_db):
        # Add a copy target
        result = runner.invoke(
            cli,
            ["copy", "0xbotwalletabc123", "--mode", "paper", "--pct", "15"],
            env={"POLYBOT_DB_PATH": populated_db},
        )
        assert result.exit_code == 0
        assert "copying" in result.output.lower()

        # List targets
        result = runner.invoke(
            cli, ["targets"],
            env={"POLYBOT_DB_PATH": populated_db},
        )
        assert result.exit_code == 0
        assert "0xbotwalletabc1" in result.output

        # Remove target
        result = runner.invoke(
            cli, ["uncopy", "0xbotwalletabc123"],
            env={"POLYBOT_DB_PATH": populated_db},
        )
        assert result.exit_code == 0
        assert "Stopped" in result.output

    def test_set_mode(self, runner, populated_db):
        # First add a target
        runner.invoke(
            cli, ["copy", "0xbotwalletabc123"],
            env={"POLYBOT_DB_PATH": populated_db},
        )
        # Switch to real
        result = runner.invoke(
            cli, ["set-mode", "0xbotwalletabc123", "real"],
            env={"POLYBOT_DB_PATH": populated_db},
        )
        assert result.exit_code == 0
        assert "real" in result.output.lower()

    def test_set_mode_nonexistent(self, runner, populated_db):
        result = runner.invoke(
            cli, ["set-mode", "0xnobody", "paper"],
            env={"POLYBOT_DB_PATH": populated_db},
        )
        assert result.exit_code == 0
        assert "not a copy target" in result.output

    def test_rank(self, runner, populated_db):
        result = runner.invoke(
            cli,
            ["rank", "--min-confidence", "0.5"],
            env={"POLYBOT_DB_PATH": populated_db},
        )
        assert result.exit_code == 0
