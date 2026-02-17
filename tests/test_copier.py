"""Tests for the copy trading engine."""

from datetime import datetime, timezone

import pytest

from polybot.config import Config
from polybot.copier import CopyTrader
from polybot.db import Database
from polybot.models import CopyMode, CopyTarget, Trade, TradeSide


@pytest.fixture
def db(tmp_path):
    d = Database(str(tmp_path / "test.db"))
    yield d
    d.close()


@pytest.fixture
def config():
    c = Config()
    c.copy_trade_percentage = 10.0
    c.max_position_usd = 100.0
    return c


@pytest.fixture
def copier(db, config):
    return CopyTrader(db, config)


def _make_trade(taker="0xbot1", price=0.50, size=200, side=TradeSide.BUY):
    return Trade(
        id="t_source",
        market="m1",
        asset_id="a1",
        side=side,
        price=price,
        size=size,
        timestamp=datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc),
        taker=taker,
    )


class TestTargetManagement:
    def test_add_target(self, copier):
        target = copier.add_target("0xbot1", mode=CopyMode.PAPER)
        assert target.wallet == "0xbot1"
        assert target.mode == CopyMode.PAPER
        assert target.active is True

    def test_remove_target(self, copier):
        copier.add_target("0xbot1")
        copier.remove_target("0xbot1")
        targets = copier.get_targets()
        assert len(targets) == 0

    def test_set_mode(self, copier):
        copier.add_target("0xbot1", mode=CopyMode.PAPER)
        result = copier.set_mode("0xbot1", CopyMode.REAL)
        assert result is not None
        assert result.mode == CopyMode.REAL

    def test_set_mode_nonexistent(self, copier):
        result = copier.set_mode("0xnobody", CopyMode.REAL)
        assert result is None

    def test_get_targets(self, copier):
        copier.add_target("0xa")
        copier.add_target("0xb")
        targets = copier.get_targets()
        assert len(targets) == 2

    def test_custom_parameters(self, copier):
        target = copier.add_target(
            "0xcustom",
            mode=CopyMode.PAPER,
            trade_pct=25.0,
            max_position_usd=500.0,
        )
        assert target.trade_pct == 25.0
        assert target.max_position_usd == 500.0

    def test_targets_persist_across_instances(self, db, config):
        copier1 = CopyTrader(db, config)
        copier1.add_target("0xpersist")
        # New instance should load from DB
        copier2 = CopyTrader(db, config)
        targets = copier2.get_targets()
        assert any(t.wallet == "0xpersist" for t in targets)


class TestCopyExecution:
    def test_paper_trade_on_target_activity(self, copier):
        copier.add_target("0xbot1", mode=CopyMode.PAPER, trade_pct=10.0, slippage_bps=0)
        trade = _make_trade(taker="0xbot1", price=0.50, size=200)
        # Source trade notional = 0.50 * 200 = $100, copy = 10% = $10
        result = copier.on_trade(trade)
        assert result is not None
        assert result.mode == CopyMode.PAPER
        assert result.status == "filled"
        assert result.price == 0.50
        # Copy size: $10 / $0.50 = 20 shares
        assert result.size == pytest.approx(20.0)

    def test_ignores_non_target_trades(self, copier):
        copier.add_target("0xbot1")
        trade = _make_trade(taker="0xstranger")
        result = copier.on_trade(trade)
        assert result is None

    def test_respects_max_position(self, copier):
        copier.add_target(
            "0xbot1",
            mode=CopyMode.PAPER,
            trade_pct=100.0,  # 100% copy
            max_position_usd=50.0,  # but cap at $50
            slippage_bps=0,
        )
        # Source trade: $100 notional. 100% copy = $100, but max = $50.
        trade = _make_trade(taker="0xbot1", price=0.50, size=200)
        result = copier.on_trade(trade)
        assert result is not None
        # $50 / $0.50 = 100 shares max
        assert result.size == pytest.approx(100.0)

    def test_copies_sell_side(self, copier):
        copier.add_target("0xbot1", mode=CopyMode.PAPER)
        trade = _make_trade(taker="0xbot1", side=TradeSide.SELL)
        result = copier.on_trade(trade)
        assert result is not None
        assert result.side == TradeSide.SELL

    def test_copies_maker_trades(self, copier):
        """Should also copy when the target is the maker, not just taker."""
        copier.add_target("0xmaker_bot")
        trade = Trade(
            id="t1",
            market="m1",
            asset_id="a1",
            side=TradeSide.BUY,
            price=0.50,
            size=100,
            timestamp=datetime(2025, 6, 1, tzinfo=timezone.utc),
            maker="0xmaker_bot",
            taker="0xsomeone",
        )
        result = copier.on_trade(trade)
        assert result is not None

    def test_inactive_target_ignored(self, copier):
        copier.add_target("0xbot1")
        copier.remove_target("0xbot1")
        trade = _make_trade(taker="0xbot1")
        result = copier.on_trade(trade)
        assert result is None

    def test_zero_price_trade_ignored(self, copier):
        copier.add_target("0xbot1")
        trade = _make_trade(taker="0xbot1", price=0.0, size=100)
        result = copier.on_trade(trade)
        assert result is None


class TestCopySummary:
    def test_empty_summary(self, copier):
        summary = copier.get_copy_summary()
        assert summary["total_trades"] == 0

    def test_summary_counts_paper_trades(self, copier):
        copier.add_target("0xbot1", mode=CopyMode.PAPER)
        for i in range(5):
            trade = Trade(
                id=f"t{i}",
                market=f"m{i}",
                asset_id=f"a{i}",
                side=TradeSide.BUY,
                price=0.50,
                size=100,
                timestamp=datetime(2025, 6, 1, tzinfo=timezone.utc),
                taker="0xbot1",
            )
            copier.on_trade(trade)

        summary = copier.get_copy_summary()
        assert summary["total_trades"] == 5
        assert summary["paper"]["count"] == 5
        assert summary["paper"]["volume"] > 0
