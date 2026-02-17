"""Polymarket trade firehose — connects to the CLOB WebSocket and Data API
to stream and ingest trades in real time."""

from __future__ import annotations

import json
import logging
import ssl
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Callable, Optional

import certifi
import requests
import websocket

from polybot.config import CLOB_WS, DATA_API_HOST, GAMMA_HOST, RTDS_WS
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


_RELEVANT_ACTIVITY_TYPES = {"TRADE", "CONVERSION", "REDEEM"}


def fetch_wallet_trades(
    wallet: str,
    limit: int = 50,
) -> list[Trade]:
    """Fetch recent activity for a specific wallet from the Data API.

    Uses the ``/activity`` endpoint with ``user=`` which correctly
    returns only items where *wallet* was a participant.  Returns
    TRADE, CONVERSION, and REDEEM events.

    CONVERSION and REDEEM events are converted to synthetic SELL trades:
    - CONVERSION: exit price = usdcSize / size (typically 1.0 for winners)
    - REDEEM with size=0: exit price = 0 (losing outcome, expired worthless)
    """
    params: dict = {"limit": limit, "user": wallet, "_t": int(time.time() * 1000)}
    resp = requests.get(f"{DATA_API_HOST}/activity", params=params, timeout=15)
    resp.raise_for_status()
    raw = resp.json()
    trades: list[Trade] = []
    for item in raw:
        try:
            activity_type = item.get("type", "")
            if activity_type not in _RELEVANT_ACTIVITY_TYPES:
                continue

            if activity_type == "TRADE":
                trade = _parse_data_api_trade(item)
                trade.maker = wallet
                trade.activity_type = "TRADE"
                trades.append(trade)
            else:
                # CONVERSION or REDEEM — synthetic SELL
                trade = _parse_exit_event(item, activity_type)
                trade.maker = wallet
                trades.append(trade)
        except Exception:
            logger.debug("Skipping unparseable activity item: %s", item)
    return trades


def _parse_exit_event(item: dict, activity_type: str) -> Trade:
    """Parse a CONVERSION or REDEEM activity item as a synthetic SELL trade."""
    ts_raw = item.get("timestamp") or item.get("createdAt", "")
    if isinstance(ts_raw, (int, float)):
        ts = datetime.fromtimestamp(
            ts_raw / 1000 if ts_raw > 1e12 else ts_raw, tz=timezone.utc
        )
    else:
        ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))

    trade_id = item.get("transactionHash") or item.get("id") or str(uuid.uuid4())
    size = float(item.get("size", 0))
    usdc_size = float(item.get("usdcSize", 0))

    # Exit price: for CONVERSION = usdcSize/size, for REDEEM with size=0 = 0
    price = usdc_size / size if size > 0 else 0.0

    trade = Trade(
        id=trade_id,
        market=item.get("conditionId", item.get("market", "")),
        asset_id="",  # CONVERSIONs/REDEEMs lack asset field
        side=TradeSide.SELL,
        price=price,
        size=size,
        timestamp=ts,
        title=item.get("title", ""),
        outcome=item.get("outcome", ""),
    )
    trade.activity_type = activity_type
    trade.usdc_size = usdc_size
    return trade


def fetch_asset_trades(
    asset_id: str,
    limit: int = 50,
) -> list[Trade]:
    """Fetch recent trades for a specific asset (for slippage measurement)."""
    params: dict = {"limit": limit, "asset": asset_id}
    resp = requests.get(f"{DATA_API_HOST}/trades", params=params, timeout=15)
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
    params = {
        "active": "true",
        "limit": limit,
        "order": "volume24hr",
        "ascending": "false",
    }
    resp = requests.get(f"{GAMMA_HOST}/markets", params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


# ── Wallet harvesting (leaderboard + market positions) ──────────────

_LEADERBOARD_CATEGORIES = ["POLITICS", "ECONOMICS", "TECH", "FINANCE", "SPORTS"]
_LEADERBOARD_PERIODS = ["DAY", "WEEK", "MONTH", "ALL"]


def fetch_leaderboard_wallets() -> set[str]:
    """Harvest wallet addresses from the Polymarket leaderboard.

    Sweeps all category × time-period combinations via the
    ``/v1/leaderboard`` endpoint (50 per page, 20-min cache).
    Returns a deduplicated set of proxy wallet addresses.
    """
    wallets: set[str] = set()
    for category in _LEADERBOARD_CATEGORIES:
        for period in _LEADERBOARD_PERIODS:
            try:
                resp = requests.get(
                    f"{DATA_API_HOST}/v1/leaderboard",
                    params={
                        "category": category,
                        "timePeriod": period,
                        "orderBy": "PNL",
                        "limit": 50,
                        "offset": 0,
                    },
                    timeout=15,
                )
                resp.raise_for_status()
                for entry in resp.json():
                    w = entry.get("proxyWallet", "")
                    if w:
                        wallets.add(w)
            except Exception:
                logger.debug("Leaderboard fetch failed: %s/%s", category, period)
    logger.info("Leaderboard: harvested %d unique wallets", len(wallets))
    return wallets


def fetch_market_position_wallets(
    condition_ids: list[str],
    limit_per_market: int = 500,
) -> set[str]:
    """Harvest wallet addresses from market position holders.

    Uses the ``/v1/market-positions`` endpoint (uncached, DYNAMIC) to
    get all traders with open or closed positions in the given markets.
    """
    wallets: set[str] = set()
    for cid in condition_ids:
        try:
            resp = requests.get(
                f"{DATA_API_HOST}/v1/market-positions",
                params={
                    "market": cid,
                    "limit": limit_per_market,
                    "status": "ALL",
                },
                timeout=15,
            )
            resp.raise_for_status()
            for pos in resp.json():
                w = pos.get("proxyWallet", "")
                if w:
                    wallets.add(w)
        except Exception:
            logger.debug("Market positions fetch failed: %s", cid[:10])
    logger.info(
        "Market positions: harvested %d unique wallets from %d markets",
        len(wallets),
        len(condition_ids),
    )
    return wallets


def harvest_wallets(top_markets: int = 20) -> set[str]:
    """Harvest wallets from leaderboard + top market positions.

    Combines wallets from the leaderboard (all categories/periods)
    with position holders from the top *top_markets* active markets
    by 24h volume.  Returns a deduplicated set.
    """
    wallets: set[str] = set()

    # 1. Leaderboard
    wallets |= fetch_leaderboard_wallets()

    # 2. Top market positions
    try:
        markets = fetch_active_markets(limit=top_markets)
        condition_ids = [
            m.get("conditionId", "") for m in markets if m.get("conditionId")
        ]
        wallets |= fetch_market_position_wallets(condition_ids)
    except Exception:
        logger.debug("Failed to fetch active markets for position harvesting")

    logger.info("Total harvested wallets: %d", len(wallets))
    return wallets


def _parse_data_api_trade(item: dict) -> Trade:
    ts_raw = item.get("timestamp") or item.get("createdAt", "")
    if isinstance(ts_raw, (int, float)):
        ts = datetime.fromtimestamp(
            ts_raw / 1000 if ts_raw > 1e12 else ts_raw, tz=timezone.utc
        )
    else:
        ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))

    # Prefer transactionHash as stable ID; fall back to id field or uuid
    trade_id = item.get("transactionHash") or item.get("id") or str(uuid.uuid4())

    return Trade(
        id=trade_id,
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
        token IDs.  Returns the list of token IDs subscribed to.

        If the WebSocket is already connected, sends the subscription
        message immediately to pick up new markets.
        """
        markets = fetch_active_markets(limit=limit)
        token_ids: list[str] = []
        for m in markets:
            clob_ids = m.get("clobTokenIds")
            if clob_ids:
                if isinstance(clob_ids, str):
                    clob_ids = json.loads(clob_ids)
                token_ids.extend(clob_ids)
        self._subscribed_tokens = token_ids
        logger.info(
            "Subscribed to %d tokens from %d markets", len(token_ids), len(markets)
        )
        # If already connected, send subscription immediately
        if self._ws and token_ids:
            try:
                msg = json.dumps({"assets_ids": token_ids, "type": "market"})
                self._ws.send(msg)
            except Exception:
                pass  # will re-subscribe on next reconnect
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
            msg = json.dumps(
                {
                    "assets_ids": self._subscribed_tokens,
                    "type": "market",
                }
            )
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


# ── RTDS real-time trade stream ─────────────────────────────────────


class RTDSFirehose:
    """Connects to Polymarket's Real-Time Data Streaming (RTDS) WebSocket
    to receive every trade globally with wallet addresses.

    Unlike the CLOB WebSocket (which only gives price/size/side), RTDS
    ``activity/trades`` messages include ``proxyWallet``, making them
    suitable for bot detection and wallet discovery.

    Usage:
        rtds = RTDSFirehose(on_trade=my_callback)
        rtds.start_background()
    """

    def __init__(self, on_trade: Optional[TradeCallback] = None):
        self._on_trade = on_trade
        self._ws: Optional[websocket.WebSocketApp] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False

    def start(self) -> None:
        """Start the RTDS WebSocket (blocking)."""
        self._running = True
        self._connect()

    def start_background(self) -> threading.Thread:
        """Start the RTDS WebSocket in a daemon thread."""
        self._running = True
        self._thread = threading.Thread(target=self._connect, daemon=True)
        self._thread.start()
        return self._thread

    def stop(self) -> None:
        self._running = False
        if self._ws:
            self._ws.close()

    def _connect(self) -> None:
        ssl_context = ssl.create_default_context(cafile=certifi.where())
        while self._running:
            try:
                self._ws = websocket.WebSocketApp(
                    RTDS_WS,
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_error=self._on_error,
                    on_close=self._on_close,
                )
                self._ws.run_forever(
                    ping_interval=5,
                    ping_timeout=3,
                    sslopt={"context": ssl_context},
                )
            except Exception:
                logger.exception("RTDS connection error")
            if self._running:
                logger.info("RTDS reconnecting in 5s...")
                time.sleep(5)

    def _on_open(self, ws: websocket.WebSocket) -> None:
        logger.info("RTDS connected")
        sub = json.dumps(
            {
                "action": "subscribe",
                "subscriptions": [{"topic": "activity", "type": "trades"}],
            }
        )
        ws.send(sub)
        logger.info("RTDS subscribed to activity/trades")

    def _on_message(self, ws: websocket.WebSocket, message: str) -> None:
        try:
            data = json.loads(message)
        except json.JSONDecodeError:
            return

        # RTDS wraps payload in {topic, type, timestamp, payload} sometimes,
        # but activity/trades messages come as flat trade objects
        if "proxyWallet" in data or "transactionHash" in data:
            self._handle_trade(data)

    def _handle_trade(self, data: dict) -> None:
        try:
            ts_raw = data.get("timestamp")
            if isinstance(ts_raw, (int, float)):
                ts = datetime.fromtimestamp(
                    ts_raw / 1000 if ts_raw > 1e12 else ts_raw,
                    tz=timezone.utc,
                )
            else:
                ts = datetime.now(tz=timezone.utc)

            trade_id = (
                data.get("transactionHash") or data.get("id") or str(uuid.uuid4())
            )

            trade = Trade(
                id=trade_id,
                market=data.get("conditionId", data.get("market", "")),
                asset_id=data.get("asset", data.get("asset_id", "")),
                side=TradeSide(data.get("side", "BUY").upper()),
                price=float(data.get("price", 0)),
                size=float(data.get("size", 0)),
                timestamp=ts,
                taker=data.get("proxyWallet", ""),
                title=data.get("title", ""),
                outcome=data.get("outcome", ""),
            )

            if self._on_trade:
                self._on_trade(trade)
        except Exception:
            logger.debug("RTDS: failed to parse trade: %s", data)

    def _on_error(self, ws: websocket.WebSocket, error: Exception) -> None:
        logger.warning("RTDS error: %s", error)

    def _on_close(
        self, ws: websocket.WebSocket, close_status: int, close_msg: str
    ) -> None:
        logger.info("RTDS closed: %s %s", close_status, close_msg)


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


# ── Continuous listener ─────────────────────────────────────────────


def listen_trades(
    on_batch: Callable[[list[Trade]], int],
    poll_interval: float = 2.0,
    batch_size: int = 500,
    stop_event: Optional[threading.Event] = None,
) -> None:
    """RTDS-primary trade ingestion with REST fallback.

    1. Connects to the RTDS WebSocket (``wss://ws-live-data.polymarket.com``)
       which streams every trade globally with wallet addresses in real-time.
    2. Buffers incoming RTDS trades and flushes them to ``on_batch`` every
       *poll_interval* seconds.
    3. Also polls ``/trades`` REST endpoint every cycle as a fallback to
       catch anything RTDS might miss (e.g. during reconnects).
    4. Does a broad REST sweep across offsets every 5 minutes for
       historical backfill.

    on_batch receives a list of trades and should return the number of
    *new* trades inserted.  Deduplication is handled by the caller.
    """
    if stop_event is None:
        stop_event = threading.Event()

    # ── RTDS trade buffer ──
    rtds_buffer: list[Trade] = []
    rtds_lock = threading.Lock()

    def _on_rtds_trade(trade: Trade) -> None:
        with rtds_lock:
            rtds_buffer.append(trade)

    # Start RTDS firehose in background
    rtds = RTDSFirehose(on_trade=_on_rtds_trade)
    rtds.start_background()

    # Track when we last did a full broad sweep
    last_broad_sweep = 0.0
    BROAD_SWEEP_INTERVAL = 300.0  # 5 minutes
    # Wallet harvesting from leaderboard + market positions
    last_harvest = 0.0
    HARVEST_INTERVAL = 1800.0  # 30 minutes

    logger.info(
        "Listener started — RTDS primary, REST fallback every %.1fs", poll_interval
    )

    try:
        while not stop_event.is_set():
            try:
                # ── 1. Flush RTDS buffer ──
                with rtds_lock:
                    rtds_trades = list(rtds_buffer)
                    rtds_buffer.clear()

                if rtds_trades:
                    new_count = on_batch(rtds_trades)
                    if new_count > 0:
                        logger.debug(
                            "RTDS: +%d new trades (batch %d)",
                            new_count,
                            len(rtds_trades),
                        )

                # ── 2. REST fallback poll (cached, ~0.1s) ──
                rest_trades = fetch_recent_trades(limit=batch_size, offset=0)
                if rest_trades:
                    new_count = on_batch(rest_trades)
                    if new_count > 0:
                        logger.debug("REST: +%d new trades", new_count)

                # ── 3. Broad sweep every 5 minutes ──
                now = time.time()
                if now - last_broad_sweep >= BROAD_SWEEP_INTERVAL:
                    last_broad_sweep = now
                    for offset in range(0, 3000, batch_size):
                        if stop_event.is_set():
                            break
                        try:
                            trades = fetch_recent_trades(
                                limit=batch_size, offset=offset
                            )
                            if trades:
                                on_batch(trades)
                        except Exception:
                            logger.debug("Broad sweep error at offset %d", offset)

                # ── 4. Wallet harvesting every 30 minutes ──
                if now - last_harvest >= HARVEST_INTERVAL:
                    last_harvest = now
                    try:
                        wallets = harvest_wallets(top_markets=20)
                        harvest_new = 0
                        for wallet in wallets:
                            if stop_event.is_set():
                                break
                            try:
                                trades = fetch_wallet_trades(wallet, limit=50)
                                if trades:
                                    harvest_new += on_batch(trades)
                            except Exception:
                                pass
                        if harvest_new > 0:
                            logger.info(
                                "Harvest: +%d new trades from %d wallets",
                                harvest_new,
                                len(wallets),
                            )
                    except Exception:
                        logger.debug("Wallet harvest failed")

            except Exception:
                logger.exception("Listener poll error")

            stop_event.wait(poll_interval)
    finally:
        rtds.stop()
