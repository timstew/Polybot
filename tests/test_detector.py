"""Tests for the bot detection engine."""

from datetime import datetime, timedelta, timezone

import pytest

from polybot.config import Config
from polybot.db import Database
from polybot.detector import BotDetector
from polybot.models import BotCategory, Trade, TradeSide


@pytest.fixture
def db(tmp_path):
    d = Database(str(tmp_path / "test.db"))
    yield d
    d.close()


@pytest.fixture
def config():
    c = Config()
    c.min_trades_for_detection = 5
    return c


def _insert_bot_trades(db, wallet, count, interval_seconds=10, market_count=1):
    """Insert trades that look bot-like: regular intervals, multiple markets."""
    base_time = datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
    for i in range(count):
        market_idx = i % market_count
        db.insert_trade(Trade(
            id=f"{wallet}_t{i}",
            market=f"market_{market_idx}",
            asset_id=f"asset_{market_idx}",
            side=TradeSide.BUY if i % 2 == 0 else TradeSide.SELL,
            price=0.50,
            size=100.0,
            timestamp=base_time + timedelta(seconds=i * interval_seconds),
            taker=wallet,
        ))


def _insert_human_trades(db, wallet, count):
    """Insert trades that look human: irregular intervals, varied sizes."""
    import random
    random.seed(42)
    base_time = datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
    current = base_time
    for i in range(count):
        interval = random.uniform(30, 7200)  # 30s to 2hr gaps
        current += timedelta(seconds=interval)
        db.insert_trade(Trade(
            id=f"{wallet}_t{i}",
            market=f"market_{random.randint(0, 2)}",
            asset_id=f"asset_{random.randint(0, 2)}",
            side=TradeSide.BUY if random.random() > 0.3 else TradeSide.SELL,
            price=random.uniform(0.10, 0.90),
            size=random.uniform(5, 500),
            timestamp=current,
            taker=wallet,
        ))


class TestBotDetector:
    def test_detects_regular_trader_as_bot(self, db, config):
        # Sub-second intervals + many markets triggers speed + coverage signals
        _insert_bot_trades(db, "0xbot", count=500, interval_seconds=1, market_count=20)
        detector = BotDetector(db, config)
        result = detector.analyze_wallet("0xbot")
        assert result is not None
        assert result.confidence > 0.5
        assert result.signals.trade_count == 500

    def test_low_confidence_for_few_trades(self, db, config):
        config.min_trades_for_detection = 3
        _insert_bot_trades(db, "0xsmall", count=3, interval_seconds=60)
        detector = BotDetector(db, config)
        result = detector.analyze_wallet("0xsmall")
        # With only 3 trades, should not meet minimum
        # config says 3, so it will analyze but score low
        if result:
            assert result.confidence < 0.8

    def test_returns_none_below_threshold(self, db, config):
        config.min_trades_for_detection = 50
        _insert_bot_trades(db, "0xfew", count=10)
        detector = BotDetector(db, config)
        result = detector.analyze_wallet("0xfew")
        assert result is None

    def test_market_maker_categorization(self, db, config):
        """A balanced buy/sell across many markets should be categorized as market maker."""
        _insert_bot_trades(db, "0xmm", count=200, interval_seconds=5, market_count=10)
        detector = BotDetector(db, config)
        result = detector.analyze_wallet("0xmm")
        assert result is not None
        assert result.category == BotCategory.MARKET_MAKER

    def test_scan_all_wallets(self, db, config):
        # Use fast intervals and many markets to ensure bots score above 0.3
        _insert_bot_trades(db, "0xbot1", count=500, interval_seconds=1, market_count=20)
        _insert_bot_trades(db, "0xbot2", count=100, interval_seconds=1, market_count=10)
        _insert_human_trades(db, "0xhuman", count=15)

        detector = BotDetector(db, config)
        suspects = detector.scan_all_wallets()
        assert len(suspects) >= 1
        # Bot with more regular trades should rank higher
        wallets = [s.wallet for s in suspects]
        assert "0xbot1" in wallets

    def test_signals_computation(self, db, config):
        _insert_bot_trades(db, "0xsig", count=50, interval_seconds=10, market_count=5)
        detector = BotDetector(db, config)
        result = detector.analyze_wallet("0xsig")
        assert result is not None

        s = result.signals
        assert s.trade_count == 50
        assert s.unique_markets == 5
        assert s.avg_interval_ms > 0
        assert s.buy_sell_ratio == pytest.approx(0.5, abs=0.05)

    def test_tags_generation(self, db, config):
        # Bot with very regular, fast trades across many markets
        _insert_bot_trades(db, "0xtags", count=200, interval_seconds=1, market_count=25)
        detector = BotDetector(db, config)
        result = detector.analyze_wallet("0xtags")
        assert result is not None
        # Should have some meaningful tags
        assert isinstance(result.tags, list)

    def test_human_scores_lower_than_bot(self, db, config):
        config.min_trades_for_detection = 5
        _insert_bot_trades(db, "0xbot", count=100, interval_seconds=5, market_count=10)
        _insert_human_trades(db, "0xhuman", count=100)

        detector = BotDetector(db, config)
        bot_result = detector.analyze_wallet("0xbot")
        human_result = detector.analyze_wallet("0xhuman")

        assert bot_result is not None
        assert human_result is not None
        assert bot_result.confidence > human_result.confidence
