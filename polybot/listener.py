"""Standalone copy-trading listener loop.

Polls each active copy target's trades from the Polymarket Data API and
executes paper (or real) copy trades.  Used by both the CLI ``copy-listen``
command and the web API's background listener thread.
"""

from __future__ import annotations

import logging
import threading
import uuid
from datetime import datetime, timezone
from typing import Callable, Optional

from polybot.config import Config
from polybot.copier import CopyTrader
from polybot.db import Database
from polybot.firehose import fetch_asset_trades, fetch_wallet_trades
from polybot.models import CopyTrade, Trade, TradeSide
from polybot.slippage import SlippageTracker

logger = logging.getLogger(__name__)


def _handle_local_exit(
    db: Database,
    event: Trade,
    target,
    copier: CopyTrader,
) -> None:
    """Handle a CONVERSION or REDEEM by closing open copy positions.

    Looks up BUY copy trades on the same market (conditionId) for this
    wallet, computes the remaining open position, and inserts a
    synthetic SELL copy trade at the exit price.
    """
    # Get all copy trades for this wallet + market
    all_copies = db.get_copy_trades(source_wallet=target.wallet, limit=10000)
    market_copies = [c for c in all_copies if c.market == event.market]
    if not market_copies:
        return

    # Group by asset_id to find open positions
    positions: dict[str, float] = {}
    for c in market_copies:
        if c.status != "filled":
            continue
        if c.side == TradeSide.BUY:
            positions[c.asset_id] = positions.get(c.asset_id, 0) + c.size
        else:
            positions[c.asset_id] = positions.get(c.asset_id, 0) - c.size

    exit_price = event.price  # already computed in _parse_exit_event

    for asset_id, open_size in positions.items():
        if open_size < 0.001:
            continue

        copy = CopyTrade(
            id=str(uuid.uuid4()),
            source_trade_id=event.id,
            source_wallet=target.wallet,
            market=event.market,
            asset_id=asset_id,
            side=TradeSide.SELL,
            price=exit_price,
            size=open_size,
            mode=target.mode,
            timestamp=datetime.now(timezone.utc),
            status="filled",
            source_price=exit_price,
            exec_price=exit_price,
            fee_amount=0.0,
        )
        db.insert_copy_trade(copy)
        logger.info(
            "[%s] EXIT %s %.2f shares @ $%.4f (from %s)",
            event.activity_type,
            asset_id[:10],
            open_size,
            exit_price,
            target.wallet[:10] + "...",
        )


def run_copy_listener(
    db_factory: Callable[[], Database],
    config: Config,
    stop_event: threading.Event,
    poll_interval: float = 2.0,
    on_batch: Optional[Callable[[int, int], None]] = None,
    slippage_tracker: Optional[SlippageTracker] = None,
) -> None:
    """Run the copy-trading listener loop until *stop_event* is set.

    Parameters
    ----------
    db_factory:
        Callable that returns a fresh ``Database`` connection.
    config:
        Application configuration.
    stop_event:
        Set this event to stop the loop gracefully.
    poll_interval:
        Seconds between poll cycles (default 2).
    on_batch:
        Optional callback ``(batch_number, new_trades_count) -> None``
        invoked after each poll cycle.
    slippage_tracker:
        Optional shared ``SlippageTracker``.  A new one is created if not
        provided.
    """
    tracker = slippage_tracker or SlippageTracker()
    seen_ids: set[str] = set()
    batches = 0

    # Seed seen_ids with current trades so we only copy NEW ones
    try:
        db = db_factory()
        targets = db.get_copy_targets(active_only=True)
        for target in targets:
            try:
                existing = fetch_wallet_trades(target.wallet, limit=20)
                for t in existing:
                    seen_ids.add(t.id)
            except Exception:
                pass
        db.close()
        logger.info("Copy listener seeded with %d existing trade IDs", len(seen_ids))
    except Exception:
        logger.warning("Failed to seed seen_ids")

    while not stop_event.is_set():
        new_count = 0
        try:
            db = db_factory()
            targets = db.get_copy_targets(active_only=True)

            if not targets:
                db.close()
                stop_event.wait(poll_interval)
                continue

            copier = CopyTrader(db, config, slippage_tracker=tracker)
            new_trade_assets: set[str] = set()

            # Poll each target wallet
            target_trades: list = []
            for target in targets:
                try:
                    trades = fetch_wallet_trades(target.wallet, limit=50)
                except Exception:
                    logger.warning("Failed to fetch trades for %s", target.wallet[:10])
                    continue

                for trade in trades:
                    if trade.id in seen_ids:
                        continue
                    seen_ids.add(trade.id)

                    # Handle position exits (CONVERSION / REDEEM)
                    if trade.activity_type in ("CONVERSION", "REDEEM"):
                        _handle_local_exit(db, trade, target, copier)
                        new_count += 1
                        continue

                    target_trades.append(trade)
                    tracker.observe(trade)
                    copier.on_trade(trade)
                    new_count += 1
                    if trade.asset_id:
                        new_trade_assets.add(trade.asset_id)

            # Store target wallet trades so they appear on wallet detail pages
            if target_trades:
                db.insert_trades_batch(target_trades)

            # Fetch market trades for slippage measurement
            assets_to_fetch = new_trade_assets | tracker.get_pending_asset_ids()
            for asset_id in assets_to_fetch:
                try:
                    asset_trades = fetch_asset_trades(asset_id, limit=50)
                    for t in asset_trades:
                        if t.id not in seen_ids:
                            seen_ids.add(t.id)
                            tracker.observe(t)
                except Exception:
                    logger.warning("Failed to fetch asset trades for %s", asset_id[:10])

            tracker.resolve_pending(db)
            tracker.prune_buffers()

            batches += 1
            if batches % 30 == 0:
                tracker.update_target_measured_slippage(db)
                if len(seen_ids) > 50000:
                    seen_ids.clear()

            db.close()
        except Exception:
            logger.exception("Copy listener poll error")

        if on_batch:
            on_batch(batches, new_count)

        stop_event.wait(poll_interval)
