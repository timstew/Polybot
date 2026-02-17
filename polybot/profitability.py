"""Profitability tracker — evaluates how profitable each suspected bot is
by reconstructing their positions and P&L from trade history."""

from __future__ import annotations

import logging
import statistics
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

import requests

from polybot.categories import infer_categories
from polybot.config import CLOB_HOST, DATA_API_HOST, LB_API_HOST
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
        current_prices = self._fetch_current_prices([p.asset_id for p in positions])

        # Update positions with current prices and compute unrealized P&L
        for pos in positions:
            pos.current_price = current_prices.get(pos.asset_id, pos.avg_entry_price)
            if pos.size > 0:
                if pos.side == TradeSide.BUY:
                    pos.unrealized_pnl = (
                        pos.current_price - pos.avg_entry_price
                    ) * pos.size
                else:
                    pos.unrealized_pnl = (
                        pos.avg_entry_price - pos.current_price
                    ) * pos.size

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
        hold_times_out: list[float] | None = None,
    ) -> PositionSnapshot:
        """FIFO position builder for a single market/asset.

        If hold_times_out is provided, appends hold durations (in seconds)
        for each matched buy→sell pair.
        """
        net_size = 0.0
        total_cost = 0.0
        realized_pnl = 0.0
        last_side = TradeSide.BUY
        outcome = trades[0].outcome if trades else ""

        # FIFO lot queue: [(remaining_size, entry_price, entry_timestamp), ...]
        lots: list[list] = []

        for t in trades:
            notional = t.price * t.size
            last_side = t.side

            if t.side == TradeSide.BUY:
                # Adding to long position
                total_cost += notional
                net_size += t.size
                lots.append([t.size, t.price, t.timestamp])
            else:
                # Selling — realize P&L via FIFO
                if net_size > 0:
                    remaining = min(t.size, net_size)
                    while remaining > 1e-9 and lots:
                        lot = lots[0]
                        match_qty = min(remaining, lot[0])
                        realized_pnl += (t.price - lot[1]) * match_qty

                        if hold_times_out is not None:
                            hold_s = (t.timestamp - lot[2]).total_seconds()
                            hold_times_out.append(hold_s)

                        lot[0] -= match_qty
                        remaining -= match_qty
                        if lot[0] <= 1e-9:
                            lots.pop(0)

                    sell_qty = min(t.size, net_size)
                    net_size -= sell_qty
                    total_cost = (
                        (total_cost / (net_size + sell_qty)) * net_size
                        if net_size > 0
                        else 0
                    )
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

    def compute_hold_times(self, wallet: str) -> list[float]:
        """Compute hold times (in seconds) for all closed position lots of a wallet."""
        trades = self.db.get_trades_for_wallet(wallet, limit=10000)
        if not trades:
            return []

        grouped: dict[tuple[str, str], list[Trade]] = defaultdict(list)
        for t in sorted(trades, key=lambda x: x.timestamp):
            grouped[(t.market, t.asset_id)].append(t)

        hold_times: list[float] = []
        for (market, asset_id), market_trades in grouped.items():
            self._build_position(
                wallet, market, asset_id, market_trades, hold_times_out=hold_times
            )
        return hold_times

    # ── Price fetching ──────────────────────────────────────────────

    def _fetch_current_prices(self, asset_ids: list[str]) -> dict[str, float]:
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
                params={"user": wallet, "limit": 500},
                timeout=30,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception:
            logger.debug("Could not fetch remote positions for %s", wallet)
            return []

    def evaluate_wallet_remote(self, wallet: str) -> BotProfitability:
        """Compute profitability for a wallet using the Data API positions endpoint."""
        positions = self.fetch_remote_positions(wallet)
        if not positions:
            return BotProfitability(wallet=wallet)

        total_realized = 0.0
        total_unrealized = 0.0
        total_volume = 0.0
        total_current_value = 0.0
        total_cash_pnl = 0.0
        wins = 0
        losses = 0
        markets = set()

        for p in positions:
            cash_pnl = float(p.get("cashPnl", 0))
            realized = float(p.get("realizedPnl", 0))
            initial = float(p.get("initialValue", 0))
            current = float(p.get("currentValue", 0))
            size = float(p.get("size", 0))
            total_bought = float(p.get("totalBought", 0))

            total_realized += realized
            total_unrealized += cash_pnl - realized
            total_volume += total_bought
            total_current_value += current
            total_cash_pnl += cash_pnl

            title = p.get("title", "")
            if title:
                markets.add(title)

            # Win rate: count positions with non-zero realized P&L,
            # or resolved markets (curPrice at 0 or 1) where holder never sold
            cur_price = float(p.get("curPrice", 0))
            redeemable = p.get("redeemable", False)
            if realized > 0.001:
                wins += 1
            elif realized < -0.001:
                losses += 1
            elif redeemable and initial > 0:
                # Market resolved — holder redeems instead of selling
                if cash_pnl > 0.001:
                    wins += 1
                elif cash_pnl < -0.001:
                    losses += 1

        rated = wins + losses
        win_rate = wins / rated if rated else 0.0
        active = sum(1 for p in positions if float(p.get("size", 0)) >= 0.01)

        # P&L % = total cash P&L / total volume deployed (matches Polymarket LB approach)
        pnl_pct = (total_cash_pnl / total_volume * 100) if total_volume > 0 else 0.0

        # Infer market categories from position titles
        market_categories = infer_categories(markets)

        return BotProfitability(
            wallet=wallet,
            total_trades=len(positions),
            total_volume_usd=total_volume,
            realized_pnl=total_realized,
            unrealized_pnl=total_unrealized,
            pnl_pct=pnl_pct,
            win_rate=win_rate,
            markets_traded=len(markets),
            active_positions=active,
            portfolio_value=total_current_value,
            market_categories=market_categories,
        )

    def _fetch_single_profit(
        self, wallet: str, window: str
    ) -> tuple[str, str, float, str, Optional[float]]:
        """Fetch one wallet+window profit. Returns (wallet, key, amount, name, pnl_pct).

        pnl_pct is only populated for window='all' (the LB API returns it there).
        """
        key = f"profit_{window}"
        try:
            resp = requests.get(
                f"{LB_API_HOST}/profit",
                params={"window": window, "address": wallet},
                timeout=10,
            )
            if resp.ok:
                data = resp.json()
                if data and isinstance(data, list) and len(data) > 0:
                    entry = data[0]
                    name = entry.get("name") or entry.get("pseudonym") or ""
                    # Ignore names that are just the wallet address
                    if name.startswith("0x"):
                        name = ""
                    pnl_pct = None
                    if window == "all" and "pnl_percent" in entry:
                        pnl_pct = float(entry["pnl_percent"]) * 100
                    return (wallet, key, float(entry.get("amount", 0)), name, pnl_pct)
        except Exception:
            logger.debug("Could not fetch %s profit for %s", window, wallet)
        return (wallet, key, 0.0, "", None)

    def _fetch_single_volume(self, wallet: str, window: str) -> tuple[str, str, float]:
        """Fetch one wallet+window volume. Returns (wallet, key, amount)."""
        key = f"volume_{window}"
        try:
            resp = requests.get(
                f"{LB_API_HOST}/volume",
                params={"window": window, "address": wallet},
                timeout=10,
            )
            if resp.ok:
                data = resp.json()
                if data and isinstance(data, list) and len(data) > 0:
                    return (wallet, key, float(data[0].get("amount", 0)))
        except Exception:
            logger.debug("Could not fetch %s volume for %s", window, wallet)
        return (wallet, key, 0.0)

    def fetch_wallet_profit(self, wallet: str) -> dict:
        """Fetch time-windowed profit and volume from the Polymarket leaderboard API.

        Returns dict with keys: profit_1d/7d/30d/all, volume_all, username, lb_pnl_pct
        """
        result: dict = {
            "profit_1d": 0.0,
            "profit_7d": 0.0,
            "profit_30d": 0.0,
            "profit_all": 0.0,
            "volume_all": 0.0,
            "username": "",
            "lb_pnl_pct": None,
        }
        for window in ("1d", "7d", "30d", "all"):
            _, key, amount, name, pnl_pct = self._fetch_single_profit(wallet, window)
            result[key] = amount
            if name and not result["username"]:
                result["username"] = name
            if pnl_pct is not None:
                result["lb_pnl_pct"] = pnl_pct
        # Fetch all-time volume
        _, _, vol = self._fetch_single_volume(wallet, "all")
        result["volume_all"] = vol
        # Compute lb_pnl_pct from profit_all / volume_all when not provided directly
        if (
            result["lb_pnl_pct"] is None
            and result["volume_all"] > 0
            and result["profit_all"] != 0
        ):
            result["lb_pnl_pct"] = result["profit_all"] / result["volume_all"] * 100
        return result

    def fetch_wallets_profit(self, wallets: list[str]) -> dict[str, dict]:
        """Fetch time-windowed profit and volume for multiple wallets in parallel."""
        results: dict[str, dict] = {
            w: {
                "profit_1d": 0.0,
                "profit_7d": 0.0,
                "profit_30d": 0.0,
                "profit_all": 0.0,
                "volume_all": 0.0,
                "username": "",
                "lb_pnl_pct": None,
            }
            for w in wallets
        }
        with ThreadPoolExecutor(max_workers=20) as pool:
            # Submit profit tasks
            profit_futures = {
                pool.submit(self._fetch_single_profit, w, window): ("profit", w)
                for w in wallets
                for window in ("1d", "7d", "30d", "all")
            }
            # Submit volume tasks (all-time only)
            volume_futures = {
                pool.submit(self._fetch_single_volume, w, "all"): ("volume", w)
                for w in wallets
            }
            for future in as_completed({**profit_futures, **volume_futures}):
                kind, _ = profit_futures.get(future) or volume_futures.get(future)
                if kind == "profit":
                    wallet, key, amount, name, pnl_pct = future.result()
                    results[wallet][key] = amount
                    if name and not results[wallet]["username"]:
                        results[wallet]["username"] = name
                    if pnl_pct is not None:
                        results[wallet]["lb_pnl_pct"] = pnl_pct
                else:
                    wallet, key, amount = future.result()
                    results[wallet][key] = amount
        # Compute lb_pnl_pct from profit_all / volume_all when not provided directly
        for w in wallets:
            r = results[w]
            if r["lb_pnl_pct"] is None and r["volume_all"] > 0 and r["profit_all"] != 0:
                r["lb_pnl_pct"] = r["profit_all"] / r["volume_all"] * 100
        return results

    def rank_wallets_remote(
        self, wallets: list[str], sort_by: str = "realized_pnl"
    ) -> list[BotProfitability]:
        """Evaluate and rank wallets using the Data API.

        sort_by: "realized_pnl" (default) or "pnl_pct"
        """
        results = [self.evaluate_wallet_remote(w) for w in wallets]
        key = (
            (lambda r: r.pnl_pct)
            if sort_by == "pnl_pct"
            else (lambda r: r.realized_pnl)
        )
        results.sort(key=key, reverse=True)
        return results
