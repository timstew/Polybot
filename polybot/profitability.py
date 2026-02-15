"""Profitability tracker — evaluates how profitable each suspected bot is
by reconstructing their positions and P&L from trade history."""

from __future__ import annotations

import logging
import statistics
from collections import defaultdict
from typing import Optional

import requests

from polybot.config import CLOB_HOST, DATA_API_HOST
from polybot.db import Database
from polybot.models import (
    BotProfitability,
    PositionSnapshot,
    Trade,
    TradeSide,
)

logger = logging.getLogger(__name__)


class ProfitabilityTracker:
    """Reconstructs positions and estimates P&L for tracked wallets.

    Two data sources:
    1. Local trade DB (from firehose ingestion)
    2. Data API (for current positions and prices)
    """

    def __init__(self, db: Database):
        self.db = db

    def evaluate_wallet(self, wallet: str) -> BotProfitability:
        """Compute profitability metrics for a wallet from its trade history."""
        trades = self.db.get_trades_for_wallet(wallet, limit=10000)
        if not trades:
            return BotProfitability(wallet=wallet)

        positions = self._reconstruct_positions(wallet, trades)
        current_prices = self._fetch_current_prices(
            [p.asset_id for p in positions]
        )

        # Update positions with current prices and compute unrealized P&L
        for pos in positions:
            pos.current_price = current_prices.get(pos.asset_id, pos.avg_entry_price)
            if pos.size > 0:
                if pos.side == TradeSide.BUY:
                    pos.unrealized_pnl = (pos.current_price - pos.avg_entry_price) * pos.size
                else:
                    pos.unrealized_pnl = (pos.avg_entry_price - pos.current_price) * pos.size

        total_volume = sum(t.price * t.size for t in trades)
        unique_markets = len({t.market for t in trades})
        active_positions = [p for p in positions if p.size > 0]
        total_unrealized = sum(p.unrealized_pnl for p in positions)

        # Estimate realized P&L from closed positions (position size = 0)
        closed = [p for p in positions if p.size == 0]
        total_realized = sum(p.realized_pnl for p in closed)

        # Win rate: fraction of closed positions with positive P&L
        wins = sum(1 for p in closed if p.realized_pnl > 0)
        win_rate = wins / len(closed) if closed else 0.0

        # Average return % per closed position
        returns = []
        for p in closed:
            if p.avg_entry_price > 0:
                ret = p.realized_pnl / (p.avg_entry_price * max(p.size, 1))
                returns.append(ret)
        avg_return = statistics.mean(returns) if returns else 0.0

        # Simple Sharpe estimate (return / stdev of returns)
        sharpe = 0.0
        if len(returns) >= 2:
            stdev = statistics.stdev(returns)
            if stdev > 0:
                sharpe = avg_return / stdev

        return BotProfitability(
            wallet=wallet,
            total_trades=len(trades),
            total_volume_usd=total_volume,
            realized_pnl=total_realized,
            unrealized_pnl=total_unrealized,
            win_rate=win_rate,
            avg_return_pct=avg_return * 100,
            sharpe_estimate=sharpe,
            markets_traded=unique_markets,
            active_positions=len(active_positions),
        )

    def rank_wallets(self, wallets: list[str]) -> list[BotProfitability]:
        """Evaluate and rank a list of wallets by realized P&L."""
        results = [self.evaluate_wallet(w) for w in wallets]
        results.sort(key=lambda r: r.realized_pnl, reverse=True)
        return results

    def get_positions(self, wallet: str) -> list[PositionSnapshot]:
        """Get current reconstructed positions for a wallet."""
        trades = self.db.get_trades_for_wallet(wallet, limit=10000)
        return self._reconstruct_positions(wallet, trades)

    # ── Position reconstruction ─────────────────────────────────────

    def _reconstruct_positions(
        self, wallet: str, trades: list[Trade]
    ) -> list[PositionSnapshot]:
        """Build position snapshots from trade history using FIFO accounting."""
        # Group trades by (market, asset_id)
        grouped: dict[tuple[str, str], list[Trade]] = defaultdict(list)
        for t in sorted(trades, key=lambda x: x.timestamp):
            grouped[(t.market, t.asset_id)].append(t)

        positions: list[PositionSnapshot] = []
        for (market, asset_id), market_trades in grouped.items():
            pos = self._build_position(wallet, market, asset_id, market_trades)
            positions.append(pos)
        return positions

    def _build_position(
        self,
        wallet: str,
        market: str,
        asset_id: str,
        trades: list[Trade],
    ) -> PositionSnapshot:
        """FIFO position builder for a single market/asset."""
        net_size = 0.0
        total_cost = 0.0
        realized_pnl = 0.0
        last_side = TradeSide.BUY
        outcome = trades[0].outcome if trades else ""

        for t in trades:
            notional = t.price * t.size
            last_side = t.side

            if t.side == TradeSide.BUY:
                # Adding to long position
                total_cost += notional
                net_size += t.size
            else:
                # Selling — realize P&L
                if net_size > 0:
                    avg_entry = total_cost / net_size
                    sell_qty = min(t.size, net_size)
                    realized_pnl += (t.price - avg_entry) * sell_qty
                    net_size -= sell_qty
                    total_cost = (total_cost / (net_size + sell_qty)) * net_size if net_size > 0 else 0
                else:
                    # Short selling (net_size goes negative)
                    total_cost += notional
                    net_size -= t.size

        avg_entry = total_cost / net_size if net_size > 0 else 0

        return PositionSnapshot(
            wallet=wallet,
            market=market,
            asset_id=asset_id,
            outcome=outcome,
            side=last_side,
            avg_entry_price=avg_entry,
            size=max(net_size, 0),
            realized_pnl=realized_pnl,
        )

    # ── Price fetching ──────────────────────────────────────────────

    def _fetch_current_prices(
        self, asset_ids: list[str]
    ) -> dict[str, float]:
        """Fetch current midpoint prices from the CLOB API."""
        prices: dict[str, float] = {}
        for asset_id in set(asset_ids):
            if not asset_id:
                continue
            try:
                resp = requests.get(
                    f"{CLOB_HOST}/midpoint",
                    params={"token_id": asset_id},
                    timeout=10,
                )
                if resp.ok:
                    data = resp.json()
                    mid = data.get("mid", data.get("midpoint"))
                    if mid is not None:
                        prices[asset_id] = float(mid)
            except Exception:
                logger.debug("Could not fetch price for %s", asset_id)
        return prices

    def fetch_remote_positions(self, wallet: str) -> list[dict]:
        """Fetch a wallet's current positions from the Data API."""
        try:
            resp = requests.get(
                f"{DATA_API_HOST}/positions",
                params={"user": wallet},
                timeout=30,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception:
            logger.debug("Could not fetch remote positions for %s", wallet)
            return []
