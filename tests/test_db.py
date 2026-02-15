"""Tests for the database layer."""

import json
import os
import tempfile
from datetime import datetime, timezone

import pytest

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
def db(tmp_path):
    db_path = str(tmp_path / "test.db")
    d = Database(db_path)
    yield d
    d.close()


def _make_trade(
    id="t1",
    market="m1",
    asset_id="a1",
    side=TradeSide.BUY,
    price=0.5,
    size=100,
    taker="0xuser1",
    maker="0xmaker1",
    **kwargs,
) -> Trade:
    return Trade(
        id=id,
        market=market,
        asset_id=asset_id,
        side=side,
        price=price,
        size=size,
        timestamp=kwargs.get("timestamp", datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc)),
        taker=taker,
        maker=maker,
        title=kwargs.get("title", "Will X happen?"),
        outcome=kwargs.get("outcome", "Yes"),
    )


class TestTradeOperations:
    def test_insert_and_retrieve(self, db):
        trade = _make_trade()
        db.insert_trade(trade)
        assert db.get_trade_count() == 1

    def test_insert_duplicate_ignored(self, db):
        trade = _make_trade()
        db.insert_trade(trade)
        db.insert_trade(trade)  # same id
        assert db.get_trade_count() == 1

    def test_insert_batch(self, db):
        trades = [
            _make_trade(id=f"t{i}", taker=f"0xuser{i}")
            for i in range(10)
        ]
        count = db.insert_trades_batch(trades)
        assert count == 10
        assert db.get_trade_count() == 10

    def test_get_trades_for_wallet(self, db):
        db.insert_trade(_make_trade(id="t1", taker="0xbob"))
        db.insert_trade(_make_trade(id="t2", taker="0xalice"))
        db.insert_trade(_make_trade(id="t3", maker="0xbob"))

        bob_trades = db.get_trades_for_wallet("0xbob")
        assert len(bob_trades) == 2  # one as taker, one as maker

    def test_get_trades_for_market(self, db):
        db.insert_trade(_make_trade(id="t1", market="m1"))
        db.insert_trade(_make_trade(id="t2", market="m2"))
        db.insert_trade(_make_trade(id="t3", market="m1"))

        m1_trades = db.get_trades_for_market("m1")
        assert len(m1_trades) == 2

    def test_get_active_wallets(self, db):
        for i in range(10):
            db.insert_trade(_make_trade(id=f"t{i}", taker="0xactive"))
        for i in range(10, 12):
            db.insert_trade(_make_trade(id=f"t{i}", taker="0xinactive"))

        wallets = db.get_active_wallets(min_trades=5)
        wallet_addrs = [w[0] for w in wallets]
        assert "0xactive" in wallet_addrs

    def test_get_all_wallets_trade_counts(self, db):
        for i in range(5):
            db.insert_trade(_make_trade(id=f"ta{i}", taker="0xa"))
        for i in range(3):
            db.insert_trade(_make_trade(id=f"tb{i}", taker="0xb"))

        counts = db.get_all_wallets_trade_counts()
        assert counts["0xa"] >= 5
        assert counts["0xb"] >= 3


class TestSuspectBotOperations:
    def test_upsert_and_retrieve(self, db):
        bot = SuspectBot(
            wallet="0xbot1",
            confidence=0.9,
            category=BotCategory.MARKET_MAKER,
            signals=BotSignals(trade_count=500),
            tags=["24/7"],
        )
        db.upsert_suspect_bot(bot)

        bots = db.get_suspect_bots()
        assert len(bots) == 1
        assert bots[0].wallet == "0xbot1"
        assert bots[0].confidence == 0.9
        assert bots[0].category == BotCategory.MARKET_MAKER
        assert bots[0].signals.trade_count == 500
        assert "24/7" in bots[0].tags

    def test_upsert_updates_existing(self, db):
        bot = SuspectBot(wallet="0xbot1", confidence=0.5, category=BotCategory.UNKNOWN)
        db.upsert_suspect_bot(bot)

        bot.confidence = 0.95
        bot.category = BotCategory.SNIPER
        db.upsert_suspect_bot(bot)

        bots = db.get_suspect_bots()
        assert len(bots) == 1
        assert bots[0].confidence == 0.95

    def test_get_with_min_confidence(self, db):
        db.upsert_suspect_bot(SuspectBot(wallet="0xlow", confidence=0.2))
        db.upsert_suspect_bot(SuspectBot(wallet="0xhigh", confidence=0.8))

        high_conf = db.get_suspect_bots(min_confidence=0.5)
        assert len(high_conf) == 1
        assert high_conf[0].wallet == "0xhigh"

    def test_get_single_bot(self, db):
        db.upsert_suspect_bot(SuspectBot(wallet="0xfind_me", confidence=0.7))
        bot = db.get_suspect_bot("0xfind_me")
        assert bot is not None
        assert bot.confidence == 0.7

        missing = db.get_suspect_bot("0xnobody")
        assert missing is None


class TestCopyTargetOperations:
    def test_upsert_and_retrieve(self, db):
        target = CopyTarget(
            wallet="0xtarget1",
            mode=CopyMode.PAPER,
            trade_pct=15.0,
            max_position_usd=200.0,
        )
        db.upsert_copy_target(target)

        targets = db.get_copy_targets()
        assert len(targets) == 1
        assert targets[0].wallet == "0xtarget1"
        assert targets[0].trade_pct == 15.0

    def test_active_only_filter(self, db):
        db.upsert_copy_target(CopyTarget(wallet="0xactive", active=True))
        db.upsert_copy_target(CopyTarget(wallet="0xinactive", active=False))

        active = db.get_copy_targets(active_only=True)
        assert len(active) == 1
        assert active[0].wallet == "0xactive"

        all_targets = db.get_copy_targets(active_only=False)
        assert len(all_targets) == 2

    def test_get_single_target(self, db):
        db.upsert_copy_target(CopyTarget(wallet="0xfind"))
        found = db.get_copy_target("0xfind")
        assert found is not None

        missing = db.get_copy_target("0xnope")
        assert missing is None


class TestCopyTradeOperations:
    def test_insert_and_retrieve(self, db):
        ct = CopyTrade(
            id="ct1",
            source_trade_id="t1",
            source_wallet="0xbot",
            market="m1",
            asset_id="a1",
            side=TradeSide.BUY,
            price=0.60,
            size=50,
            mode=CopyMode.PAPER,
            status="filled",
        )
        db.insert_copy_trade(ct)

        trades = db.get_copy_trades()
        assert len(trades) == 1
        assert trades[0].id == "ct1"
        assert trades[0].status == "filled"

    def test_filter_by_wallet(self, db):
        for i, wallet in enumerate(["0xa", "0xa", "0xb"]):
            db.insert_copy_trade(CopyTrade(
                id=f"ct{i}",
                source_wallet=wallet,
                market="m1",
                asset_id="a1",
                side=TradeSide.BUY,
                price=0.5,
                size=10,
                mode=CopyMode.PAPER,
            ))

        a_trades = db.get_copy_trades(source_wallet="0xa")
        assert len(a_trades) == 2
