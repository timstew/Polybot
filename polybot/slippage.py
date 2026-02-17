"""Real-time slippage measurement from the trade firehose."""

from __future__ import annotations

import logging
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from polybot.models import CopyTarget, Trade, TradeSide

logger = logging.getLogger(__name__)

BUFFER_MAX_AGE_S = 120.0  # keep last 120s of trades per asset
PENDING_TIMEOUT_S = 120.0  # give up on observations older than 120s

# Each entry: (epoch_timestamp, price, size)
PriceEntry = tuple[float, float, float]


@dataclass
class PendingObservation:
    """A bot trade waiting for subsequent market data to measure slippage."""

    copy_trade_id: str
    asset_id: str
    source_wallet: str
    side: TradeSide
    bot_price: float
    bot_ts: float  # epoch timestamp of the bot's trade
    latency_ms: float
    created_at: float = field(default_factory=time.monotonic)


@dataclass
class SlippageStats:
    """Rolling slippage statistics for a single wallet."""

    wallet: str
    observation_count: int = 0
    total_slippage_bps: float = 0.0
    avg_slippage_bps: float = 0.0
    last_slippage_bps: float = 0.0
    total_latency_ms: float = 0.0
    avg_latency_ms: float = 0.0
    last_updated: Optional[datetime] = None


@dataclass
class ResolvedSlippage:
    """Result of a resolved observation."""

    copy_trade_id: str
    source_wallet: str
    asset_id: str
    side: TradeSide
    bot_price: float
    market_price: float  # VWAP of trades in the window
    slippage_bps: float
    trade_count: int
    latency_ms: float = 0.0  # the detection latency used for this observation


class SlippageTracker:
    """Observes all firehose trades and measures real slippage for copy trades.

    Lifecycle (called each batch in api.py):
    1. observe(trade) for ALL trades — builds price buffers
    2. copier.on_trade() registers observations for target trades
    3. resolve_pending(db) — resolves observations where latency window elapsed
    4. prune_buffers() — removes old price data
    """

    def __init__(self) -> None:
        self._price_buffer: dict[str, deque[PriceEntry]] = {}
        self._pending: list[PendingObservation] = []
        self._stats: dict[str, SlippageStats] = {}

    def observe(self, trade: Trade) -> None:
        """Feed every trade from the firehose to build price buffers."""
        asset = trade.asset_id
        if not asset:
            return
        ts = trade.timestamp.timestamp()
        entry: PriceEntry = (ts, trade.price, trade.size)
        buf = self._price_buffer.get(asset)
        if buf is None:
            buf = deque(maxlen=5000)
            self._price_buffer[asset] = buf
        buf.append(entry)

    def register_observation(
        self,
        trade: Trade,
        target: CopyTarget,
        copy_trade_id: str,
        detected_latency_ms: Optional[float] = None,
    ) -> None:
        """Mark a bot's trade for slippage observation.

        If detected_latency_ms is provided (measured from now - trade.timestamp),
        use it as the observation window. Otherwise fall back to target.latency_ms.
        """
        latency = (
            detected_latency_ms
            if detected_latency_ms is not None
            else target.latency_ms
        )
        obs = PendingObservation(
            copy_trade_id=copy_trade_id,
            asset_id=trade.asset_id,
            source_wallet=target.wallet,
            side=trade.side,
            bot_price=trade.price,
            bot_ts=trade.timestamp.timestamp(),
            latency_ms=latency,
        )
        self._pending.append(obs)

    def resolve_pending(self, db) -> list[ResolvedSlippage]:
        """Check pending observations. Resolve those whose latency window
        has elapsed and we have subsequent trade data."""
        if not self._pending:
            return []

        now_mono = time.monotonic()
        resolved: list[ResolvedSlippage] = []
        still_pending: list[PendingObservation] = []

        for obs in self._pending:
            elapsed_s = now_mono - obs.created_at

            if elapsed_s > PENDING_TIMEOUT_S:
                continue  # too old, drop it

            result = self._compute_slippage(obs)
            if result is not None:
                resolved.append(result)
                self._update_stats(result)
                self._update_copy_trade(db, result)
            elif elapsed_s * 1000 < obs.latency_ms:
                # Not enough wall-clock time and no data yet — keep waiting
                still_pending.append(obs)
            else:
                # Enough time passed but no data — keep until timeout
                still_pending.append(obs)

        self._pending = still_pending
        return resolved

    def prune_buffers(self) -> None:
        """Remove entries older than BUFFER_MAX_AGE_S."""
        cutoff = time.time() - BUFFER_MAX_AGE_S
        empty_keys = []
        for asset, buf in self._price_buffer.items():
            while buf and buf[0][0] < cutoff:
                buf.popleft()
            if not buf:
                empty_keys.append(asset)
        for k in empty_keys:
            del self._price_buffer[k]

    def update_target_measured_slippage(self, db) -> None:
        """Persist rolling average slippage to copy_targets table."""
        for wallet, stats in self._stats.items():
            if stats.observation_count > 0:
                try:
                    db.update_copy_target_measured_slippage(
                        wallet, stats.avg_slippage_bps
                    )
                except Exception:
                    logger.exception(
                        "Failed to persist measured slippage for %s", wallet[:10]
                    )

    def get_stats(self, wallet: str) -> Optional[SlippageStats]:
        """Get rolling average slippage stats for a bot wallet."""
        return self._stats.get(wallet)

    def get_all_stats(self) -> dict[str, SlippageStats]:
        """Get all wallet stats."""
        return dict(self._stats)

    def get_pending_asset_ids(self) -> set[str]:
        """Return asset IDs with unresolved observations."""
        return {obs.asset_id for obs in self._pending}

    # ── internals ───────────────────────────────────────────────────

    def _compute_slippage(self, obs: PendingObservation) -> Optional[ResolvedSlippage]:
        """Compute slippage from buffered prices after the bot's trade.

        Uses trades with timestamp strictly greater than the bot's trade
        timestamp — i.e. the next batch(es) from the Data API.  The Data API
        batches trades to the same second, so same-timestamp trades are
        excluded to avoid measuring the bot's own price impact.
        """
        buf = self._price_buffer.get(obs.asset_id)
        if not buf:
            return None

        total_value = 0.0
        total_size = 0.0
        count = 0

        for ts, price, size in buf:
            if ts <= obs.bot_ts:
                continue
            total_value += price * size
            total_size += size
            count += 1

        if count == 0 or total_size == 0:
            return None

        market_price = total_value / total_size  # VWAP

        if obs.side == TradeSide.BUY:
            slippage_bps = ((market_price - obs.bot_price) / obs.bot_price) * 10_000
        else:
            slippage_bps = ((obs.bot_price - market_price) / obs.bot_price) * 10_000

        return ResolvedSlippage(
            copy_trade_id=obs.copy_trade_id,
            source_wallet=obs.source_wallet,
            asset_id=obs.asset_id,
            side=obs.side,
            bot_price=obs.bot_price,
            market_price=market_price,
            slippage_bps=slippage_bps,
            trade_count=count,
            latency_ms=obs.latency_ms,
        )

    def _update_stats(self, result: ResolvedSlippage) -> None:
        """Update rolling average slippage and latency for the wallet."""
        wallet = result.source_wallet
        stats = self._stats.get(wallet)
        if stats is None:
            stats = SlippageStats(wallet=wallet)
            self._stats[wallet] = stats
        stats.observation_count += 1
        stats.total_slippage_bps += result.slippage_bps
        stats.avg_slippage_bps = stats.total_slippage_bps / stats.observation_count
        stats.last_slippage_bps = result.slippage_bps
        stats.total_latency_ms += result.latency_ms
        stats.avg_latency_ms = stats.total_latency_ms / stats.observation_count
        stats.last_updated = datetime.now(timezone.utc)

    def _update_copy_trade(self, db, result: ResolvedSlippage) -> None:
        """Update the CopyTrade record with the real exec_price."""
        if result.side == TradeSide.BUY:
            exec_price = min(result.market_price, 0.99)
        else:
            exec_price = max(result.market_price, 0.01)
        try:
            db.update_copy_trade_exec_price(result.copy_trade_id, exec_price)
            logger.info(
                "Slippage resolved: %s | bot=$%.4f market=$%.4f slip=%.1fbps (%d trades)",
                result.copy_trade_id[:8],
                result.bot_price,
                result.market_price,
                result.slippage_bps,
                result.trade_count,
            )
        except Exception:
            logger.exception("Failed to update copy trade exec_price")
