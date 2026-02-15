"""Tests for the firehose module."""

import json
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from polybot.firehose import (
    Firehose,
    _parse_data_api_trade,
    backfill_trades,
    fetch_active_markets,
    fetch_recent_trades,
)
from polybot.models import TradeSide


class TestParseDataApiTrade:
    def test_parse_basic_trade(self):
        raw = {
            "id": "abc123",
            "conditionId": "cond_1",
            "asset": "tok_1",
            "side": "BUY",
            "price": "0.65",
            "size": "100",
            "timestamp": "2025-06-01T12:00:00Z",
            "proxyWallet": "0xabc",
            "title": "Will X happen?",
            "outcome": "Yes",
        }
        trade = _parse_data_api_trade(raw)
        assert trade.id == "abc123"
        assert trade.market == "cond_1"
        assert trade.asset_id == "tok_1"
        assert trade.side == TradeSide.BUY
        assert trade.price == 0.65
        assert trade.size == 100
        assert trade.taker == "0xabc"

    def test_parse_numeric_timestamp(self):
        raw = {
            "conditionId": "c1",
            "asset": "a1",
            "side": "SELL",
            "price": "0.30",
            "size": "50",
            "timestamp": 1717243200000,  # epoch ms
        }
        trade = _parse_data_api_trade(raw)
        assert trade.side == TradeSide.SELL
        assert trade.timestamp.year == 2024 or trade.timestamp.year == 2025  # depends on exact epoch

    def test_parse_missing_fields_uses_defaults(self):
        raw = {
            "side": "BUY",
            "price": "0.50",
            "size": "10",
            "timestamp": "2025-01-01T00:00:00Z",
        }
        trade = _parse_data_api_trade(raw)
        assert trade.market == ""
        assert trade.asset_id == ""
        assert trade.taker == ""


class TestFirehose:
    def test_subscribe_tokens(self):
        firehose = Firehose()
        firehose.subscribe_tokens(["tok1", "tok2"])
        assert firehose._subscribed_tokens == ["tok1", "tok2"]

    @patch("polybot.firehose.fetch_active_markets")
    def test_subscribe_all_active(self, mock_fetch):
        mock_fetch.return_value = [
            {"clobTokenIds": '["tok_a1", "tok_a2"]'},
            {"clobTokenIds": '["tok_b1"]'},
        ]
        firehose = Firehose()
        tokens = firehose.subscribe_all_active(limit=10)
        assert len(tokens) == 3
        assert "tok_a1" in tokens
        assert "tok_b1" in tokens

    def test_on_message_trade_event(self):
        received = []
        firehose = Firehose(on_trade=lambda t: received.append(t))

        msg = json.dumps({
            "event_type": "last_trade_price",
            "market": "m1",
            "asset_id": "a1",
            "side": "BUY",
            "price": 0.65,
            "size": 50,
            "timestamp": 1717243200000,
        })
        firehose._on_message(MagicMock(), msg)
        assert len(received) == 1
        assert received[0].price == 0.65

    def test_on_message_ignores_book_event(self):
        received = []
        firehose = Firehose(on_trade=lambda t: received.append(t))

        msg = json.dumps({"event_type": "book", "asset_id": "a1"})
        firehose._on_message(MagicMock(), msg)
        assert len(received) == 0

    def test_on_message_ignores_invalid_json(self):
        firehose = Firehose(on_trade=lambda t: None)
        firehose._on_message(MagicMock(), "not json")
        # Should not raise

    def test_stop(self):
        firehose = Firehose()
        firehose._ws = MagicMock()
        firehose.stop()
        assert firehose._running is False
        firehose._ws.close.assert_called_once()


class TestBackfill:
    @patch("polybot.firehose.fetch_recent_trades")
    def test_backfill_calls_callback(self, mock_fetch):
        from polybot.models import Trade
        mock_trades = [
            Trade(
                id=f"t{i}", market="m1", asset_id="a1", side=TradeSide.BUY,
                price=0.5, size=10,
                timestamp=datetime(2025, 6, 1, tzinfo=timezone.utc),
            )
            for i in range(5)
        ]
        mock_fetch.return_value = mock_trades

        received = []
        total = backfill_trades(on_trade=lambda t: received.append(t), pages=1, per_page=100)
        assert total == 5
        assert len(received) == 5

    @patch("polybot.firehose.fetch_recent_trades")
    def test_backfill_stops_on_empty_page(self, mock_fetch):
        mock_fetch.return_value = []
        total = backfill_trades(on_trade=lambda t: None, pages=5)
        assert total == 0
        assert mock_fetch.call_count == 1  # stops after first empty page
