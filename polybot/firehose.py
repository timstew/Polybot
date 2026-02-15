"""Polymarket trade firehose — connects to the CLOB WebSocket and Data API
to stream and ingest trades in real time."""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Callable, Optional

import requests
import websocket

from polybot.config import CLOB_WS, DATA_API_HOST, GAMMA_HOST
from polybot.models import Trade, TradeSide

logger = logging.getLogger(__name__)

TradeCallback = Callable[[Trade], None]


# ── REST polling (Data API) ─────────────────────────────────────────

def fetch_recent_trades(
    market: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[Trade]:
    """Fetch recent trades from the Data API (REST).

    This is useful for backfilling historical data.  The Data API returns
    trades for all markets when no filter is given.
    """
    params: dict = {"limit": limit, "offset": offset}
    if market:
        params["market"] = market

    resp = requests.get(f"{DATA_API_HOST}/trades", params=params, timeout=30)
    resp.raise_for_status()
    raw = resp.json()
    trades: list[Trade] = []
    for item in raw:
        try:
            trades.append(_parse_data_api_trade(item))
        except Exception:
            logger.debug("Skipping unparseable trade: %s", item)
    return trades


def fetch_active_markets(limit: int = 100) -> list[dict]:
    """Fetch active markets from the Gamma API."""
    params = {"active": "true", "limit": limit, "order": "volume24hr", "ascending": "false"}
    resp = requests.get(f"{GAMMA_HOST}/markets", params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


def _parse_data_api_trade(item: dict) -> Trade:
    ts_raw = item.get("timestamp") or item.get("createdAt", "")
    if isinstance(ts_raw, (int, float)):
        ts = datetime.fromtimestamp(ts_raw / 1000 if ts_raw > 1e12 else ts_raw, tz=timezone.utc)
    else:
        ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))

    return Trade(
        id=item.get("id", str(uuid.uuid4())),
        market=item.get("conditionId", item.get("market", "")),
        asset_id=item.get("asset", item.get("asset_id", "")),
        side=TradeSide(item.get("side", "BUY").upper()),
        price=float(item.get("price", 0)),
        size=float(item.get("size", 0)),
        timestamp=ts,
        taker=item.get("proxyWallet", item.get("taker", "")),
        title=item.get("title", ""),
        outcome=item.get("outcome", ""),
    )


# ── WebSocket firehose ──────────────────────────────────────────────

class Firehose:
    """Connects to the Polymarket CLOB WebSocket market channel to receive
    real-time orderbook and trade events.

    Usage:
        firehose = Firehose(on_trade=my_callback)
        firehose.subscribe_tokens(["<token_id_1>", "<token_id_2>"])
        firehose.start()  # blocks, or use start_background()
    """

    def __init__(self, on_trade: Optional[TradeCallback] = None):
        self._on_trade = on_trade
        self._ws: Optional[websocket.WebSocketApp] = None
        self._thread: Optional[threading.Thread] = None
        self._subscribed_tokens: list[str] = []
        self._running = False

    # ── public API ──────────────────────────────────────────────────

    def subscribe_tokens(self, token_ids: list[str]) -> None:
        """Set the token IDs to subscribe to.  Call before start()."""
        self._subscribed_tokens = list(token_ids)

    def subscribe_all_active(self, limit: int = 50) -> list[str]:
        """Fetch top active markets from Gamma and subscribe to all their
        token IDs.  Returns the list of token IDs subscribed to."""
        markets = fetch_active_markets(limit=limit)
        token_ids: list[str] = []
        for m in markets:
            clob_ids = m.get("clobTokenIds")
            if clob_ids:
                if isinstance(clob_ids, str):
                    clob_ids = json.loads(clob_ids)
                token_ids.extend(clob_ids)
        self._subscribed_tokens = token_ids
        logger.info("Subscribed to %d tokens from %d markets", len(token_ids), len(markets))
        return token_ids

    def start(self) -> None:
        """Start the WebSocket connection (blocking)."""
        self._running = True
        self._connect()

    def start_background(self) -> threading.Thread:
        """Start the WebSocket in a daemon thread."""
        self._running = True
        self._thread = threading.Thread(target=self._connect, daemon=True)
        self._thread.start()
        return self._thread

    def stop(self) -> None:
        self._running = False
        if self._ws:
            self._ws.close()

    # ── internals ───────────────────────────────────────────────────

    def _connect(self) -> None:
        while self._running:
            try:
                self._ws = websocket.WebSocketApp(
                    CLOB_WS,
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_error=self._on_error,
                    on_close=self._on_close,
                )
                self._ws.run_forever(ping_interval=30, ping_timeout=10)
            except Exception:
                logger.exception("WebSocket connection error")
            if self._running:
                logger.info("Reconnecting in 5s...")
                time.sleep(5)

    def _on_open(self, ws: websocket.WebSocket) -> None:
        logger.info("WebSocket connected")
        if self._subscribed_tokens:
            msg = json.dumps({
                "assets_ids": self._subscribed_tokens,
                "type": "market",
            })
            ws.send(msg)
            logger.info("Subscribed to %d tokens", len(self._subscribed_tokens))

    def _on_message(self, ws: websocket.WebSocket, message: str) -> None:
        try:
            data = json.loads(message)
        except json.JSONDecodeError:
            return

        event_type = data.get("event_type", "")

        if event_type == "last_trade_price":
            self._handle_trade_event(data)
        elif event_type == "book":
            pass  # orderbook snapshot — not a trade
        elif event_type == "price_change":
            pass  # order placed/cancelled — not a trade

    def _handle_trade_event(self, data: dict) -> None:
        try:
            ts_raw = data.get("timestamp")
            if isinstance(ts_raw, (int, float)):
                ts = datetime.fromtimestamp(
                    ts_raw / 1000 if ts_raw > 1e12 else ts_raw,
                    tz=timezone.utc,
                )
            else:
                ts = datetime.utcnow().replace(tzinfo=timezone.utc)

            trade = Trade(
                id=str(uuid.uuid4()),
                market=data.get("market", ""),
                asset_id=data.get("asset_id", ""),
                side=TradeSide(data.get("side", "BUY").upper()),
                price=float(data.get("price", 0)),
                size=float(data.get("size", 0)),
                timestamp=ts,
            )

            if self._on_trade:
                self._on_trade(trade)
        except Exception:
            logger.debug("Failed to parse trade event: %s", data)

    def _on_error(self, ws: websocket.WebSocket, error: Exception) -> None:
        logger.warning("WebSocket error: %s", error)

    def _on_close(
        self, ws: websocket.WebSocket, close_status: int, close_msg: str
    ) -> None:
        logger.info("WebSocket closed: %s %s", close_status, close_msg)


# ── Backfill helper ─────────────────────────────────────────────────

def backfill_trades(
    on_trade: TradeCallback,
    pages: int = 10,
    per_page: int = 100,
) -> int:
    """Fetch historical trades from the Data API and feed them through
    the callback.  Returns total trades fetched."""
    total = 0
    for page in range(pages):
        trades = fetch_recent_trades(limit=per_page, offset=page * per_page)
        for t in trades:
            on_trade(t)
        total += len(trades)
        if len(trades) < per_page:
            break
        time.sleep(0.2)  # be polite to the API
    return total
