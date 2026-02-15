"""Tests for data models."""

from datetime import datetime, timezone

from polybot.models import (
    BotCategory,
    BotProfitability,
    BotSignals,
    CopyMode,
    CopyTarget,
    CopyTrade,
    PositionSnapshot,
    SuspectBot,
    Trade,
    TradeSide,
)


def test_trade_creation():
    trade = Trade(
        id="t1",
        market="cond_123",
        asset_id="tok_456",
        side=TradeSide.BUY,
        price=0.65,
        size=100,
        timestamp=datetime(2025, 1, 1, tzinfo=timezone.utc),
        taker="0xabc",
    )
    assert trade.id == "t1"
    assert trade.side == TradeSide.BUY
    assert trade.price == 0.65
    assert trade.size == 100


def test_trade_side_enum():
    assert TradeSide.BUY.value == "BUY"
    assert TradeSide.SELL.value == "SELL"
    assert TradeSide("BUY") == TradeSide.BUY


def test_bot_signals_defaults():
    signals = BotSignals()
    assert signals.trade_count == 0
    assert signals.avg_interval_ms == 0.0
    assert signals.fastest_reaction_ms == 999999999.0


def test_suspect_bot_creation():
    bot = SuspectBot(
        wallet="0xdef",
        confidence=0.85,
        category=BotCategory.MARKET_MAKER,
        signals=BotSignals(trade_count=500, avg_interval_ms=1200),
        tags=["24/7", "clockwork"],
    )
    assert bot.confidence == 0.85
    assert bot.category == BotCategory.MARKET_MAKER
    assert "24/7" in bot.tags


def test_bot_category_values():
    assert BotCategory.MARKET_MAKER.value == "market_maker"
    assert BotCategory.SNIPER.value == "sniper"
    assert BotCategory.UNKNOWN.value == "unknown"


def test_position_snapshot():
    pos = PositionSnapshot(
        wallet="0x1",
        market="m1",
        asset_id="a1",
        outcome="Yes",
        side=TradeSide.BUY,
        avg_entry_price=0.55,
        size=200,
        current_price=0.70,
        unrealized_pnl=30.0,
    )
    assert pos.avg_entry_price == 0.55
    assert pos.unrealized_pnl == 30.0


def test_bot_profitability():
    prof = BotProfitability(
        wallet="0x2",
        total_trades=150,
        total_volume_usd=50000,
        realized_pnl=1200.50,
        win_rate=0.62,
    )
    assert prof.realized_pnl == 1200.50
    assert prof.win_rate == 0.62


def test_copy_target_defaults():
    target = CopyTarget(wallet="0x3")
    assert target.mode == CopyMode.PAPER
    assert target.trade_pct == 10.0
    assert target.active is True


def test_copy_trade_creation():
    ct = CopyTrade(
        id="ct1",
        source_trade_id="t1",
        source_wallet="0xbot",
        market="m1",
        asset_id="a1",
        side=TradeSide.BUY,
        price=0.50,
        size=10,
        mode=CopyMode.PAPER,
    )
    assert ct.status == "pending"
    assert ct.mode == CopyMode.PAPER


def test_copy_mode_enum():
    assert CopyMode.PAPER.value == "paper"
    assert CopyMode.REAL.value == "real"


def test_bot_signals_serialization():
    signals = BotSignals(trade_count=42, avg_interval_ms=5000)
    json_str = signals.model_dump_json()
    restored = BotSignals.model_validate_json(json_str)
    assert restored.trade_count == 42
    assert restored.avg_interval_ms == 5000
