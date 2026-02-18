"""Copy trading engine — mirrors trades from target bots in paper or real mode."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from polybot.categories import get_fee_rate
from polybot.config import Config
from polybot.db import Database
from polybot.models import (
    CopyMode,
    CopyTarget,
    CopyTrade,
    Trade,
    TradeSide,
)

logger = logging.getLogger(__name__)


class CopyTrader:
    """Watches the trade stream for activity from copy targets and executes
    (or paper-records) matching trades.

    Usage:
        copier = CopyTrader(db, config)
        # Register as firehose callback:
        firehose = Firehose(on_trade=copier.on_trade)
    """

    # Minimum seconds between copy trades on the same (wallet, market) pair.
    # Prevents micro-trading bots from flooding us with hundreds of copies
    # on the same market within minutes.
    MARKET_COOLDOWN_SECONDS = 600  # 10 minutes

    def __init__(
        self, db: Database, config: Optional[Config] = None, slippage_tracker=None
    ):
        self.db = db
        self.config = config or Config()
        self.slippage_tracker = slippage_tracker
        self._targets: dict[str, CopyTarget] = {}
        self._real_client = None  # lazy-loaded ClobClient for real trades
        # Track last copy time per (wallet, market) for cooldown
        self._last_copy: dict[tuple[str, str], datetime] = {}
        self._load_targets()

    # ── Target management ───────────────────────────────────────────

    def add_target(
        self,
        wallet: str,
        mode: CopyMode = CopyMode.PAPER,
        trade_pct: Optional[float] = None,
        max_position_usd: Optional[float] = None,
        slippage_bps: float = 50.0,
        latency_ms: float = 2000.0,
        fee_rate: float = 0.0,
    ) -> CopyTarget:
        """Start copy-trading a wallet."""
        target = CopyTarget(
            wallet=wallet,
            mode=mode,
            trade_pct=trade_pct or self.config.copy_trade_percentage,
            max_position_usd=max_position_usd or self.config.max_position_usd,
            active=True,
            slippage_bps=slippage_bps,
            latency_ms=latency_ms,
            fee_rate=fee_rate,
        )
        self.db.upsert_copy_target(target)
        self._targets[wallet] = target
        logger.info(
            "Now copying %s in %s mode (%.1f%%, max $%.2f)",
            wallet[:10] + "...",
            mode.value,
            target.trade_pct,
            target.max_position_usd,
        )
        return target

    def remove_target(self, wallet: str) -> None:
        """Stop copy-trading a wallet."""
        target = self._targets.pop(wallet, None)
        if target:
            target.active = False
            self.db.upsert_copy_target(target)
            logger.info("Stopped copying %s", wallet[:10] + "...")

    def reactivate_target(self, wallet: str) -> Optional[CopyTarget]:
        """Re-enable a previously stopped copy target."""
        targets = self.db.get_copy_targets(active_only=False)
        target = next((t for t in targets if t.wallet == wallet), None)
        if not target:
            return None
        target.active = True
        self.db.upsert_copy_target(target)
        self._targets[wallet] = target
        logger.info("Reactivated copying %s", wallet[:10] + "...")
        return target

    def set_mode(self, wallet: str, mode: CopyMode) -> Optional[CopyTarget]:
        """Switch a target between paper and real mode."""
        target = self._targets.get(wallet)
        if not target:
            return None
        target.mode = mode
        self.db.upsert_copy_target(target)
        logger.info("Switched %s to %s mode", wallet[:10] + "...", mode.value)
        return target

    def get_targets(self) -> list[CopyTarget]:
        return list(self._targets.values())

    def _load_targets(self) -> None:
        for target in self.db.get_copy_targets(active_only=True):
            self._targets[target.wallet] = target

    # ── Trade handling ──────────────────────────────────────────────

    def on_trade(self, trade: Trade) -> Optional[CopyTrade]:
        """Called for every trade from the firehose.  If the trade is from
        a copy target, execute (or paper-record) a copy trade."""
        # Check if the taker or maker is one of our targets
        target = self._targets.get(trade.taker) or self._targets.get(trade.maker)
        if not target or not target.active:
            return None

        # Intra-market cooldown: skip if we recently copied a trade on this market
        cooldown_key = (target.wallet, trade.market)
        last_ts = self._last_copy.get(cooldown_key)
        if last_ts is not None:
            elapsed = (datetime.now(timezone.utc) - last_ts).total_seconds()
            if elapsed < self.MARKET_COOLDOWN_SECONDS:
                logger.debug(
                    "Cooldown: skipping %s on %s (%.0fs since last copy)",
                    trade.side.value,
                    trade.market[:10],
                    elapsed,
                )
                return None

        # Determine slippage: prefer measured data, fall back to static config
        effective_slippage_bps = target.slippage_bps
        if self.slippage_tracker:
            stats = self.slippage_tracker.get_stats(target.wallet)
            if stats and stats.observation_count >= 1:
                effective_slippage_bps = max(stats.avg_slippage_bps, 0)

        slip_mult = effective_slippage_bps / 10_000
        if trade.side == TradeSide.BUY:
            exec_price = min(trade.price * (1 + slip_mult), 0.99)
        else:
            exec_price = max(trade.price * (1 - slip_mult), 0.01)

        # Fee rate by market category (e.g. crypto-updown = 10%, all others = 0%).
        # Use target override if explicitly set > 0, otherwise infer from title.
        if target.fee_rate > 0:
            fee_rate = target.fee_rate
        else:
            fee_rate = get_fee_rate(trade.title)

        # Fee formula: fee_per_share = exec_price * (1 - exec_price) * fee_rate
        fee_per_share = exec_price * (1 - exec_price) * fee_rate

        # Calculate our copy size based on exec_price (what we'd actually pay)
        # Paper mode: 100% of bot's trade to measure true P&L
        # Real mode: use the configured trade_pct
        source_notional = trade.price * trade.size
        if target.mode == CopyMode.PAPER:
            copy_notional = source_notional
        else:
            copy_notional = source_notional * (target.trade_pct / 100.0)

        if copy_notional < 0.01:
            return None

        # Effective cost per share includes fee
        cost_per_share = exec_price + fee_per_share
        copy_size = copy_notional / cost_per_share if cost_per_share > 0 else 0
        if copy_size <= 0:
            return None

        fee_amount = fee_per_share * copy_size

        copy = CopyTrade(
            id=str(uuid.uuid4()),
            source_trade_id=trade.id,
            source_wallet=target.wallet,
            market=trade.market,
            asset_id=trade.asset_id,
            side=trade.side,
            price=exec_price,
            size=copy_size,
            mode=target.mode,
            timestamp=datetime.now(timezone.utc),
            status="pending",
            source_price=trade.price,
            exec_price=exec_price,
            fee_amount=fee_amount,
        )

        if target.mode == CopyMode.PAPER:
            copy = self._execute_paper(copy, target)
        else:
            copy = self._execute_real(copy, target)

        self.db.insert_copy_trade(copy)

        # Record copy time for intra-market cooldown
        self._last_copy[cooldown_key] = datetime.now(timezone.utc)

        # Register for real slippage observation (will update exec_price later)
        if self.slippage_tracker:
            # Measure real detection latency: how long between the trade and now
            detection_delay = (
                datetime.now(timezone.utc) - trade.timestamp
            ).total_seconds() * 1000
            detected_latency_ms = max(detection_delay, 0)
            self.slippage_tracker.register_observation(
                trade,
                target,
                copy.id,
                detected_latency_ms=detected_latency_ms,
            )

        return copy

    # ── Paper trading ───────────────────────────────────────────────

    def _execute_paper(self, copy: CopyTrade, target: CopyTarget) -> CopyTrade:
        """Record a paper trade — no real money moves."""
        copy.status = "filled"
        logger.info(
            "[PAPER] %s %.2f shares | src=$%.4f exec=$%.4f slip=%dbps fee=$%.4f (from %s)",
            copy.side.value,
            copy.size,
            copy.source_price,
            copy.exec_price,
            target.slippage_bps,
            copy.fee_amount,
            copy.source_wallet[:10] + "...",
        )
        return copy

    # ── Real trading ────────────────────────────────────────────────

    def _execute_real(self, copy: CopyTrade, target: CopyTarget) -> CopyTrade:
        """Execute a real trade via the Polymarket CLOB API."""
        client = self._get_real_client()
        if not client:
            logger.error("Cannot execute real trade — no API credentials configured")
            copy.status = "failed"
            return copy

        try:
            from py_clob_client.clob_types import MarketOrderArgs, OrderArgs
            from py_clob_client.order_builder.constants import BUY, SELL

            side = BUY if copy.side == TradeSide.BUY else SELL

            # Use a market order for immediate execution
            order = client.create_market_order(
                MarketOrderArgs(
                    token_id=copy.asset_id,
                    amount=copy.price * copy.size,  # dollar amount
                )
            )
            resp = client.post_order(order, "FOK")

            if resp.get("success") or resp.get("orderID"):
                copy.status = "filled"
                logger.info(
                    "[REAL] %s %.2f shares @ $%.4f (from %s)",
                    copy.side.value,
                    copy.size,
                    copy.price,
                    copy.source_wallet[:10] + "...",
                )
            else:
                copy.status = "failed"
                logger.warning("Real order rejected: %s", resp)
        except Exception:
            logger.exception("Failed to execute real copy trade")
            copy.status = "failed"

        return copy

    def _get_real_client(self):
        """Lazily initialize the authenticated CLOB client."""
        if self._real_client is not None:
            return self._real_client

        if not self.config.private_key:
            return None

        try:
            from py_clob_client.client import ClobClient

            client = ClobClient(
                host="https://clob.polymarket.com",
                key=self.config.private_key,
                chain_id=137,
                signature_type=self.config.signature_type,
                funder=self.config.funder_address or None,
            )
            client.set_api_creds(client.create_or_derive_api_creds())
            self._real_client = client
            return client
        except Exception:
            logger.exception("Failed to initialize CLOB client")
            return None

    # ── Reporting ───────────────────────────────────────────────────

    def get_copy_summary(self, wallet: Optional[str] = None) -> dict:
        """Get a summary of copy trading performance."""
        copy_trades = self.db.get_copy_trades(source_wallet=wallet, limit=10000)
        if not copy_trades:
            return {"total_trades": 0, "paper": {}, "real": {}}

        paper = [ct for ct in copy_trades if ct.mode == CopyMode.PAPER]
        real = [ct for ct in copy_trades if ct.mode == CopyMode.REAL]

        def _summarize(trades: list[CopyTrade]) -> dict:
            if not trades:
                return {"count": 0, "volume": 0, "pnl": 0}
            filled = [t for t in trades if t.status == "filled"]
            return {
                "count": len(filled),
                "volume": sum(t.price * t.size for t in filled),
                "pnl": sum(t.pnl for t in filled),
                "pending": sum(1 for t in trades if t.status == "pending"),
                "failed": sum(1 for t in trades if t.status == "failed"),
            }

        return {
            "total_trades": len(copy_trades),
            "paper": _summarize(paper),
            "real": _summarize(real),
        }
