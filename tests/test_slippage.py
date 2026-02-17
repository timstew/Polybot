"""Tests for the real-time slippage tracker."""

import time
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from polybot.config import Config
from polybot.copier import CopyTrader
from polybot.db import Database
from polybot.models import CopyMode, CopyTarget, Trade, TradeSide
from polybot.slippage import SlippageTracker


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
def tracker():
    return SlippageTracker()


def _make_trade(
    asset_id="a1",
    price=0.50,
    size=100,
    side=TradeSide.BUY,
    taker="0xbot1",
    ts_offset=0.0,
    trade_id="t1",
):
    """Create a trade with a configurable timestamp offset (seconds from epoch 1000000)."""
    base_ts = 1000000.0 + ts_offset
    return Trade(
        id=trade_id,
        market="m1",
        asset_id=asset_id,
        side=side,
        price=price,
        size=size,
        timestamp=datetime.fromtimestamp(base_ts, tz=timezone.utc),
        taker=taker,
    )


class TestObserve:
    def test_builds_price_buffer(self, tracker):
        trade = _make_trade(price=0.50)
        tracker.observe(trade)
        assert "a1" in tracker._price_buffer
        assert len(tracker._price_buffer["a1"]) == 1

    def test_multiple_assets(self, tracker):
        tracker.observe(_make_trade(asset_id="a1", price=0.50, trade_id="t1"))
        tracker.observe(_make_trade(asset_id="a2", price=0.60, trade_id="t2"))
        assert "a1" in tracker._price_buffer
        assert "a2" in tracker._price_buffer

    def test_ignores_empty_asset_id(self, tracker):
        trade = _make_trade(asset_id="")
        tracker.observe(trade)
        assert len(tracker._price_buffer) == 0


class TestRegisterObservation:
    def test_adds_pending(self, tracker):
        trade = _make_trade()
        target = CopyTarget(wallet="0xbot1", slippage_bps=50, latency_ms=2000)
        tracker.register_observation(trade, target, "copy-001")
        assert len(tracker._pending) == 1
        assert tracker._pending[0].copy_trade_id == "copy-001"
        assert tracker._pending[0].bot_price == 0.50


class TestResolvePending:
    def test_no_data_returns_empty(self, tracker, db):
        """No pending observations = nothing to resolve."""
        result = tracker.resolve_pending(db)
        assert result == []

    def test_before_window_stays_pending(self, tracker, db):
        """Observation registered just now shouldn't resolve yet."""
        trade = _make_trade()
        target = CopyTarget(wallet="0xbot1", latency_ms=5000)
        tracker.register_observation(trade, target, "copy-001")
        result = tracker.resolve_pending(db)
        assert result == []
        assert len(tracker._pending) == 1

    def test_buy_slippage_positive(self, tracker, db):
        """BUY: subsequent higher prices = positive slippage."""
        bot_trade = _make_trade(price=0.50, ts_offset=0)
        target = CopyTarget(wallet="0xbot1", latency_ms=100)

        # Observe the bot's trade and subsequent market trades
        tracker.observe(bot_trade)
        tracker.observe(_make_trade(price=0.52, ts_offset=0.05, trade_id="m1"))
        tracker.observe(_make_trade(price=0.53, ts_offset=0.08, trade_id="m2"))

        # Register observation with a very short latency for testing
        obs = tracker.register_observation(bot_trade, target, "copy-001")
        # Manually set created_at to past so it resolves
        tracker._pending[0].created_at = time.monotonic() - 1.0

        result = tracker.resolve_pending(db)
        assert len(result) == 1
        r = result[0]
        assert r.slippage_bps > 0  # price moved against us
        assert r.bot_price == 0.50
        assert r.market_price > 0.50
        assert r.trade_count == 2

    def test_sell_slippage_positive(self, tracker, db):
        """SELL: subsequent lower prices = positive slippage."""
        bot_trade = _make_trade(price=0.50, side=TradeSide.SELL, ts_offset=0)
        target = CopyTarget(wallet="0xbot1", latency_ms=100)

        tracker.observe(bot_trade)
        tracker.observe(_make_trade(price=0.48, ts_offset=0.05, trade_id="m1"))
        tracker.observe(_make_trade(price=0.47, ts_offset=0.08, trade_id="m2"))

        tracker.register_observation(bot_trade, target, "copy-001")
        tracker._pending[0].created_at = time.monotonic() - 1.0

        result = tracker.resolve_pending(db)
        assert len(result) == 1
        assert result[0].slippage_bps > 0  # price moved against us

    def test_negative_slippage_means_better_price(self, tracker, db):
        """BUY where price drops after bot = negative slippage (we'd get a better price)."""
        bot_trade = _make_trade(price=0.50, ts_offset=0)
        target = CopyTarget(wallet="0xbot1", latency_ms=100)

        tracker.observe(bot_trade)
        tracker.observe(_make_trade(price=0.48, ts_offset=0.05, trade_id="m1"))

        tracker.register_observation(bot_trade, target, "copy-001")
        tracker._pending[0].created_at = time.monotonic() - 1.0

        result = tracker.resolve_pending(db)
        assert len(result) == 1
        assert result[0].slippage_bps < 0  # we'd get a better price

    def test_vwap_calculation(self, tracker, db):
        """Market price should be volume-weighted, not simple average."""
        bot_trade = _make_trade(price=0.50, ts_offset=0)
        target = CopyTarget(wallet="0xbot1", latency_ms=100)

        tracker.observe(bot_trade)
        # Large trade at 0.52, small trade at 0.60 — VWAP should be closer to 0.52
        tracker.observe(
            _make_trade(price=0.52, size=1000, ts_offset=0.05, trade_id="m1")
        )
        tracker.observe(_make_trade(price=0.60, size=10, ts_offset=0.08, trade_id="m2"))

        tracker.register_observation(bot_trade, target, "copy-001")
        tracker._pending[0].created_at = time.monotonic() - 1.0

        result = tracker.resolve_pending(db)
        assert len(result) == 1
        # VWAP = (0.52*1000 + 0.60*10) / 1010 ≈ 0.52079
        assert result[0].market_price == pytest.approx(0.52079, rel=1e-3)

    def test_updates_db(self, tracker, db):
        """Resolved observation should update the copy trade's exec_price in DB."""
        # Create a copy trade in the DB first
        from polybot.models import CopyTrade

        ct = CopyTrade(
            id="copy-001",
            source_trade_id="t1",
            source_wallet="0xbot1",
            market="m1",
            asset_id="a1",
            side=TradeSide.BUY,
            price=0.50,
            size=10,
            mode=CopyMode.PAPER,
            source_price=0.50,
            exec_price=0.50,
        )
        db.insert_copy_trade(ct)

        bot_trade = _make_trade(price=0.50, ts_offset=0)
        target = CopyTarget(wallet="0xbot1", latency_ms=100)

        tracker.observe(bot_trade)
        tracker.observe(_make_trade(price=0.52, ts_offset=0.05, trade_id="m1"))

        tracker.register_observation(bot_trade, target, "copy-001")
        tracker._pending[0].created_at = time.monotonic() - 1.0

        tracker.resolve_pending(db)

        # Verify DB was updated
        trades = db.get_copy_trades()
        assert len(trades) == 1
        assert trades[0].exec_price == pytest.approx(0.52, rel=1e-3)

    def test_no_trades_in_window_stays_pending(self, tracker, db):
        """If no subsequent trades on the asset, observation stays pending."""
        bot_trade = _make_trade(price=0.50, ts_offset=0)
        target = CopyTarget(wallet="0xbot1", latency_ms=100)

        tracker.observe(bot_trade)
        # No subsequent trades — only the bot's own trade

        tracker.register_observation(bot_trade, target, "copy-001")
        tracker._pending[0].created_at = time.monotonic() - 1.0

        result = tracker.resolve_pending(db)
        assert result == []
        assert len(tracker._pending) == 1  # still pending


class TestStats:
    def test_updates_rolling_average(self, tracker, db):
        """Multiple resolved observations produce correct rolling avg."""
        target = CopyTarget(wallet="0xbot1", latency_ms=100)

        # First observation: 50bps slippage
        bot1 = _make_trade(price=0.50, ts_offset=0, trade_id="t1")
        tracker.observe(bot1)
        tracker.observe(_make_trade(price=0.5025, ts_offset=0.05, trade_id="m1"))
        tracker.register_observation(bot1, target, "copy-001")
        tracker._pending[-1].created_at = time.monotonic() - 1.0
        tracker.resolve_pending(db)

        stats = tracker.get_stats("0xbot1")
        assert stats is not None
        assert stats.observation_count == 1
        assert stats.avg_slippage_bps == pytest.approx(50.0, rel=1e-2)

        # Second observation: 100bps slippage
        bot2 = _make_trade(price=0.50, ts_offset=1, trade_id="t2")
        tracker.observe(bot2)
        tracker.observe(_make_trade(price=0.505, ts_offset=1.05, trade_id="m2"))
        tracker.register_observation(bot2, target, "copy-002")
        tracker._pending[-1].created_at = time.monotonic() - 1.0
        tracker.resolve_pending(db)

        stats = tracker.get_stats("0xbot1")
        assert stats.observation_count == 2
        # avg = (50 + 100) / 2 = 75
        assert stats.avg_slippage_bps == pytest.approx(75.0, rel=1e-2)

    def test_unknown_wallet_returns_none(self, tracker):
        assert tracker.get_stats("0xunknown") is None


class TestPruneBuffers:
    def test_removes_old_entries(self, tracker):
        """Entries older than 60s should be pruned."""
        old_ts = time.time() - 120  # 2 minutes ago
        tracker._price_buffer["a1"] = __import__("collections").deque()
        tracker._price_buffer["a1"].append((old_ts, 0.50, 100))
        tracker._price_buffer["a1"].append((time.time(), 0.51, 100))

        tracker.prune_buffers()
        assert len(tracker._price_buffer["a1"]) == 1  # only the recent one


class TestCopierIntegration:
    def test_copier_uses_measured_slippage(self, db, config):
        """When tracker has measured data, copier uses it over static fallback."""
        tracker = SlippageTracker()
        # Pre-populate stats with measured data
        from polybot.slippage import SlippageStats

        tracker._stats["0xbot1"] = SlippageStats(
            wallet="0xbot1",
            observation_count=5,
            total_slippage_bps=125.0,
            avg_slippage_bps=25.0,  # 25bps measured
            last_slippage_bps=20.0,
        )

        copier = CopyTrader(db, config, slippage_tracker=tracker)
        copier.add_target(
            "0xbot1", mode=CopyMode.PAPER, slippage_bps=100
        )  # 100bps fallback

        trade = _make_trade(taker="0xbot1", price=0.50, size=200)
        result = copier.on_trade(trade)

        # Should use 25bps (measured), not 100bps (fallback)
        expected_exec = 0.50 * (1 + 25 / 10000)  # 0.50125
        assert result.exec_price == pytest.approx(expected_exec, rel=1e-4)

    def test_copier_falls_back_to_static(self, db, config):
        """When no measured data, copier uses target.slippage_bps."""
        tracker = SlippageTracker()  # empty — no stats

        copier = CopyTrader(db, config, slippage_tracker=tracker)
        copier.add_target("0xbot1", mode=CopyMode.PAPER, slippage_bps=100)

        trade = _make_trade(taker="0xbot1", price=0.50, size=200)
        result = copier.on_trade(trade)

        expected_exec = 0.50 * (1 + 100 / 10000)  # 0.505
        assert result.exec_price == pytest.approx(expected_exec, rel=1e-4)

    def test_copier_registers_observation(self, db, config):
        """on_trade() should register an observation with the tracker."""
        tracker = SlippageTracker()
        copier = CopyTrader(db, config, slippage_tracker=tracker)
        copier.add_target("0xbot1", mode=CopyMode.PAPER, slippage_bps=0)

        trade = _make_trade(taker="0xbot1", price=0.50, size=200)
        result = copier.on_trade(trade)

        assert len(tracker._pending) == 1
        assert tracker._pending[0].copy_trade_id == result.id

    def test_copier_works_without_tracker(self, db, config):
        """Backward compat: copier works when slippage_tracker=None."""
        copier = CopyTrader(db, config, slippage_tracker=None)
        copier.add_target("0xbot1", mode=CopyMode.PAPER, slippage_bps=50)

        trade = _make_trade(taker="0xbot1", price=0.50, size=200)
        result = copier.on_trade(trade)

        assert result is not None
        assert result.status == "filled"
        assert len(copier.slippage_tracker or []) == 0  # no tracker, no crash
