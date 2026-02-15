"""Tests for the profitability tracker."""

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from polybot.db import Database
from polybot.models import Trade, TradeSide
from polybot.profitability import ProfitabilityTracker


@pytest.fixture
def db(tmp_path):
    d = Database(str(tmp_path / "test.db"))
    yield d
    d.close()


def _ts(minutes=0):
    return datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)


class TestPositionReconstruction:
    def test_simple_long_position(self, db):
        """Buy 100 @ $0.50 → position of 100 shares at $0.50 avg."""
        db.insert_trade(Trade(
            id="t1", market="m1", asset_id="a1", side=TradeSide.BUY,
            price=0.50, size=100, timestamp=_ts(0), taker="0xbot",
        ))
        tracker = ProfitabilityTracker(db)
        positions = tracker.get_positions("0xbot")
        assert len(positions) == 1
        assert positions[0].size == 100
        assert positions[0].avg_entry_price == pytest.approx(0.50)

    def test_buy_then_sell_realizes_pnl(self, db):
        """Buy 100 @ $0.50 then sell 100 @ $0.70 → realized $20 profit."""
        db.insert_trade(Trade(
            id="t1", market="m1", asset_id="a1", side=TradeSide.BUY,
            price=0.50, size=100, timestamp=_ts(0), taker="0xbot",
        ))
        db.insert_trade(Trade(
            id="t2", market="m1", asset_id="a1", side=TradeSide.SELL,
            price=0.70, size=100, timestamp=_ts(10), taker="0xbot",
        ))
        tracker = ProfitabilityTracker(db)
        positions = tracker.get_positions("0xbot")
        assert len(positions) == 1
        assert positions[0].size == 0  # fully closed
        assert positions[0].realized_pnl == pytest.approx(20.0)

    def test_partial_sell(self, db):
        """Buy 100 @ $0.50, sell 50 @ $0.70 → 50 remaining, $10 realized."""
        db.insert_trade(Trade(
            id="t1", market="m1", asset_id="a1", side=TradeSide.BUY,
            price=0.50, size=100, timestamp=_ts(0), taker="0xbot",
        ))
        db.insert_trade(Trade(
            id="t2", market="m1", asset_id="a1", side=TradeSide.SELL,
            price=0.70, size=50, timestamp=_ts(10), taker="0xbot",
        ))
        tracker = ProfitabilityTracker(db)
        positions = tracker.get_positions("0xbot")
        assert len(positions) == 1
        assert positions[0].size == 50
        assert positions[0].realized_pnl == pytest.approx(10.0)

    def test_multiple_buys_then_sell(self, db):
        """Buy 50 @ $0.40, buy 50 @ $0.60, sell 100 @ $0.70.
        Avg entry = $0.50, realized = $20."""
        db.insert_trade(Trade(
            id="t1", market="m1", asset_id="a1", side=TradeSide.BUY,
            price=0.40, size=50, timestamp=_ts(0), taker="0xbot",
        ))
        db.insert_trade(Trade(
            id="t2", market="m1", asset_id="a1", side=TradeSide.BUY,
            price=0.60, size=50, timestamp=_ts(5), taker="0xbot",
        ))
        db.insert_trade(Trade(
            id="t3", market="m1", asset_id="a1", side=TradeSide.SELL,
            price=0.70, size=100, timestamp=_ts(10), taker="0xbot",
        ))
        tracker = ProfitabilityTracker(db)
        positions = tracker.get_positions("0xbot")
        assert positions[0].size == 0
        assert positions[0].realized_pnl == pytest.approx(20.0)

    def test_multiple_markets(self, db):
        db.insert_trade(Trade(
            id="t1", market="m1", asset_id="a1", side=TradeSide.BUY,
            price=0.50, size=100, timestamp=_ts(0), taker="0xbot",
        ))
        db.insert_trade(Trade(
            id="t2", market="m2", asset_id="a2", side=TradeSide.BUY,
            price=0.30, size=200, timestamp=_ts(5), taker="0xbot",
        ))
        tracker = ProfitabilityTracker(db)
        positions = tracker.get_positions("0xbot")
        assert len(positions) == 2


class TestProfitabilityEvaluation:
    @patch.object(ProfitabilityTracker, "_fetch_current_prices", return_value={})
    def test_evaluate_empty_wallet(self, mock_prices, db):
        tracker = ProfitabilityTracker(db)
        result = tracker.evaluate_wallet("0xnobody")
        assert result.total_trades == 0
        assert result.realized_pnl == 0

    @patch.object(ProfitabilityTracker, "_fetch_current_prices",
                  return_value={"a1": 0.80})
    def test_evaluate_profitable_bot(self, mock_prices, db):
        # Buy and sell for profit
        db.insert_trade(Trade(
            id="t1", market="m1", asset_id="a1", side=TradeSide.BUY,
            price=0.50, size=100, timestamp=_ts(0), taker="0xbot",
        ))
        db.insert_trade(Trade(
            id="t2", market="m1", asset_id="a1", side=TradeSide.SELL,
            price=0.70, size=100, timestamp=_ts(10), taker="0xbot",
        ))
        tracker = ProfitabilityTracker(db)
        result = tracker.evaluate_wallet("0xbot")
        assert result.total_trades == 2
        assert result.realized_pnl > 0
        assert result.total_volume_usd > 0

    @patch.object(ProfitabilityTracker, "_fetch_current_prices",
                  return_value={"a1": 0.80, "a2": 0.40})
    def test_rank_wallets(self, mock_prices, db):
        # Bot A: profitable
        db.insert_trade(Trade(
            id="a1", market="m1", asset_id="a1", side=TradeSide.BUY,
            price=0.50, size=100, timestamp=_ts(0), taker="0xbotA",
        ))
        db.insert_trade(Trade(
            id="a2", market="m1", asset_id="a1", side=TradeSide.SELL,
            price=0.80, size=100, timestamp=_ts(10), taker="0xbotA",
        ))
        # Bot B: unprofitable
        db.insert_trade(Trade(
            id="b1", market="m2", asset_id="a2", side=TradeSide.BUY,
            price=0.60, size=100, timestamp=_ts(0), taker="0xbotB",
        ))
        db.insert_trade(Trade(
            id="b2", market="m2", asset_id="a2", side=TradeSide.SELL,
            price=0.40, size=100, timestamp=_ts(10), taker="0xbotB",
        ))

        tracker = ProfitabilityTracker(db)
        ranked = tracker.rank_wallets(["0xbotA", "0xbotB"])
        assert ranked[0].wallet == "0xbotA"
        assert ranked[0].realized_pnl > 0
        assert ranked[1].wallet == "0xbotB"
        assert ranked[1].realized_pnl < 0
