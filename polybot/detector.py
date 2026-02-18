"""Bot detection engine — analyzes trading patterns to identify automated wallets."""

from __future__ import annotations

import logging
import math
import statistics
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Optional

from polybot.categories import infer_categories
from polybot.config import Config
from polybot.db import Database
from polybot.firehose import fetch_wallet_trades
from polybot.models import (
    BotCategory,
    BotSignals,
    SuspectBot,
    Trade,
)

logger = logging.getLogger(__name__)


class BotDetector:
    """Scores wallets for bot-like behavior based on trading patterns.

    Signals analyzed:
    - Trade frequency and regularity (bots trade at consistent intervals)
    - Speed of execution (sub-second reactions)
    - Round-number trade sizes (bots often use exact dollar amounts)
    - Market coverage (bots tend to hit many markets)
    - Buy/sell balance (market makers stay near 50/50)
    - 24/7 activity (humans sleep, bots don't)
    """

    def __init__(self, db: Database, config: Optional[Config] = None):
        self.db = db
        self.config = config or Config()

    def scan_all_wallets(self, min_trades: int = 0) -> list[SuspectBot]:
        """Analyze every wallet in the database and return those that look
        like bots, sorted by confidence descending."""
        min_t = min_trades or self.config.min_trades_for_detection
        wallets = self.db.get_all_wallets_trade_counts()
        suspects: list[SuspectBot] = []

        for wallet, count in wallets.items():
            if count < min_t:
                continue
            bot = self.analyze_wallet(wallet)
            if bot and bot.confidence > 0.3:
                suspects.append(bot)

        suspects.sort(key=lambda b: b.confidence, reverse=True)
        return suspects

    def scan_wallets_remote(
        self,
        wallets: list[str],
        min_trades: int = 0,
        min_confidence: float = 0.3,
    ) -> list[SuspectBot]:
        """Analyze wallets by fetching trades from the Data API (in-memory).

        Instead of reading from the local DB, this fetches each wallet's
        trades directly from Polymarket.  Results are persisted to the
        suspect_bots table but the raw trades are not stored.
        """
        min_t = min_trades or self.config.min_trades_for_detection
        suspects: list[SuspectBot] = []

        import threading
        import time as _time

        _throttle = threading.Semaphore(4)  # max 4 concurrent API calls

        def _fetch_and_analyze(wallet: str) -> Optional[SuspectBot]:
            with _throttle:
                _time.sleep(0.15)  # 150ms between requests — leave headroom
                try:
                    trades = fetch_wallet_trades(wallet, limit=200)
                    if len(trades) < min_t:
                        return None
                    return self.analyze_wallet(
                        wallet, trades=trades, min_trades_override=min_t
                    )
                except Exception:
                    logger.warning(
                        "Failed to fetch/analyze trades for %s: %s",
                        wallet[:10],
                        Exception,
                        exc_info=True,
                    )
                    return None

        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(_fetch_and_analyze, w): w for w in wallets}
            for future in as_completed(futures):
                bot = future.result()
                if bot and bot.confidence > min_confidence:
                    suspects.append(bot)

        suspects.sort(key=lambda b: b.confidence, reverse=True)
        return suspects

    def analyze_wallet(
        self,
        wallet: str,
        trades: list[Trade] | None = None,
        min_trades_override: int | None = None,
    ) -> Optional[SuspectBot]:
        """Compute bot signals for a single wallet and return a SuspectBot
        if the confidence exceeds the minimum threshold.

        If *trades* is provided, uses them directly instead of reading from DB.
        If *min_trades_override* is given, it replaces the config threshold.
        """
        if trades is None:
            trades = self.db.get_trades_for_wallet(wallet, limit=5000)
        min_required = min_trades_override or self.config.min_trades_for_detection
        if len(trades) < min_required:
            return None

        signals = self._compute_signals(trades)
        confidence = self._score(signals)
        category = self._categorize(signals)
        tags = self._generate_tags(signals, trades)

        timestamps = [t.timestamp for t in trades]

        bot = SuspectBot(
            wallet=wallet,
            confidence=confidence,
            category=category,
            signals=signals,
            first_seen=min(timestamps),
            last_seen=max(timestamps),
            tags=tags,
        )
        try:
            self.db.upsert_suspect_bot(bot)
        except Exception:
            # DB write may fail in thread pool (SQLite thread-safety).
            # The SuspectBot result is still valid.
            pass
        return bot

    # ── Signal computation ──────────────────────────────────────────

    def _compute_signals(self, trades: list[Trade]) -> BotSignals:
        trades_sorted = sorted(trades, key=lambda t: t.timestamp)

        # Time intervals between consecutive trades (ms)
        intervals_ms: list[float] = []
        for i in range(1, len(trades_sorted)):
            delta = trades_sorted[i].timestamp - trades_sorted[i - 1].timestamp
            intervals_ms.append(delta.total_seconds() * 1000)

        avg_interval = statistics.mean(intervals_ms) if intervals_ms else 0
        interval_cv = 0.0
        if intervals_ms and avg_interval > 0:
            interval_cv = statistics.stdev(intervals_ms) / avg_interval

        # Fastest reaction (smallest positive interval)
        positive_intervals = [i for i in intervals_ms if i > 0]
        fastest = min(positive_intervals) if positive_intervals else 999999.0

        # Unique markets
        unique_markets = len({t.market for t in trades_sorted})

        # Trade sizes
        sizes_usd = [t.price * t.size for t in trades_sorted]
        avg_size = statistics.mean(sizes_usd) if sizes_usd else 0

        # Buy/sell ratio
        buys = sum(1 for t in trades_sorted if t.side.value == "BUY")
        buy_sell_ratio = buys / len(trades_sorted) if trades_sorted else 0.5

        # Active hours per day
        active_hours = self._active_hours_per_day(trades_sorted)

        # Round-number sizes (e.g. exactly $10, $25, $50, $100)
        round_count = sum(1 for s in sizes_usd if s > 0 and (s % 5 == 0 or s % 10 == 0))
        round_pct = round_count / len(sizes_usd) if sizes_usd else 0

        # Hold time: FIFO matching per asset to find buy→sell durations
        hold_times_s: list[float] = []
        by_asset: dict[str, list[Trade]] = defaultdict(list)
        for t in trades_sorted:
            by_asset[t.asset_id].append(t)
        for asset_trades in by_asset.values():
            lots: list[tuple[float, datetime]] = []  # (remaining_size, buy_ts)
            for t in asset_trades:
                if t.side.value == "BUY":
                    lots.append((t.size, t.timestamp))
                elif lots:
                    remaining = t.size
                    new_lots = []
                    for lot_size, lot_ts in lots:
                        if remaining <= 1e-9:
                            new_lots.append((lot_size, lot_ts))
                            continue
                        match_qty = min(remaining, lot_size)
                        hold_times_s.append((t.timestamp - lot_ts).total_seconds())
                        remaining -= match_qty
                        leftover = lot_size - match_qty
                        if leftover > 1e-9:
                            new_lots.append((leftover, lot_ts))
                    lots = new_lots

        avg_hold_hours = statistics.mean(hold_times_s) / 3600 if hold_times_s else 0.0

        # Trades per market (lower = cleaner entry/exit pattern)
        trades_per_market = (
            len(trades_sorted) / unique_markets if unique_markets > 0 else 0
        )

        # Market concentration: fraction of trades in the busiest market
        market_counts = Counter(t.market for t in trades_sorted)
        top_market_count = max(market_counts.values()) if market_counts else 0
        market_concentration = (
            top_market_count / len(trades_sorted) if trades_sorted else 0
        )

        # Burst detection: group trades per market into 10-minute sessions
        # and measure how many trades happen per burst
        burst_sizes: list[int] = []
        by_market: dict[str, list[Trade]] = defaultdict(list)
        for t in trades_sorted:
            by_market[t.market].append(t)
        for market_trades in by_market.values():
            if len(market_trades) < 2:
                burst_sizes.append(1)
                continue
            # Split into sessions with 10-min gaps
            session_count = 1
            for i in range(1, len(market_trades)):
                gap = (
                    market_trades[i].timestamp - market_trades[i - 1].timestamp
                ).total_seconds()
                if gap > 600:  # 10 min gap = new session
                    burst_sizes.append(session_count)
                    session_count = 0
                session_count += 1
            burst_sizes.append(session_count)

        avg_market_burst = statistics.mean(burst_sizes) if burst_sizes else 0
        max_market_burst = max(burst_sizes) if burst_sizes else 0

        return BotSignals(
            trade_count=len(trades_sorted),
            avg_interval_ms=avg_interval,
            interval_cv=interval_cv,
            unique_markets=unique_markets,
            avg_trade_size_usd=avg_size,
            buy_sell_ratio=buy_sell_ratio,
            active_hours_per_day=active_hours,
            fastest_reaction_ms=fastest,
            round_size_pct=round_pct,
            avg_hold_time_hours=avg_hold_hours,
            trades_per_market=trades_per_market,
            avg_market_burst=avg_market_burst,
            max_market_burst=max_market_burst,
            market_concentration=market_concentration,
        )

    def _active_hours_per_day(self, trades: list[Trade]) -> float:
        """Estimate average hours per day the wallet is active."""
        if len(trades) < 2:
            return 0

        by_day: dict[str, set[int]] = defaultdict(set)
        for t in trades:
            day = t.timestamp.strftime("%Y-%m-%d")
            by_day[day].add(t.timestamp.hour)

        if not by_day:
            return 0
        return statistics.mean(len(hours) for hours in by_day.values())

    # ── Scoring ─────────────────────────────────────────────────────

    def _score(self, s: BotSignals) -> float:
        """Produce a 0-1 confidence score that the wallet is a bot."""
        score = 0.0
        weights_total = 0.0

        # 1. High trade count → more likely bot (weight: 1.0)
        if s.trade_count >= 500:
            score += 1.0
        elif s.trade_count >= 100:
            score += 0.6
        elif s.trade_count >= 50:
            score += 0.3
        weights_total += 1.0

        # 2. Low interval CV → very regular timing (weight: 1.5)
        if s.interval_cv > 0:
            if s.interval_cv < 0.3:
                score += 1.5  # extremely regular
            elif s.interval_cv < 0.6:
                score += 0.9
            elif s.interval_cv < 1.0:
                score += 0.3
        weights_total += 1.5

        # 3. Fast execution (weight: 1.5)
        if s.fastest_reaction_ms < 500:
            score += 1.5
        elif s.fastest_reaction_ms < self.config.speed_threshold_ms:
            score += 0.9
        elif s.fastest_reaction_ms < 5000:
            score += 0.3
        weights_total += 1.5

        # 4. Many markets (weight: 1.0)
        if s.unique_markets >= 20:
            score += 1.0
        elif s.unique_markets >= 10:
            score += 0.6
        elif s.unique_markets >= 5:
            score += 0.3
        weights_total += 1.0

        # 5. Extended active hours (weight: 1.0)
        if s.active_hours_per_day >= 20:
            score += 1.0  # practically 24/7
        elif s.active_hours_per_day >= 16:
            score += 0.7
        elif s.active_hours_per_day >= 12:
            score += 0.3
        weights_total += 1.0

        # 6. Round trade sizes (weight: 0.5)
        if s.round_size_pct >= 0.8:
            score += 0.5
        elif s.round_size_pct >= 0.5:
            score += 0.25
        weights_total += 0.5

        # 7. Balanced buy/sell near 0.5 suggests market making (weight: 0.5)
        balance_dist = abs(s.buy_sell_ratio - 0.5)
        if balance_dist < 0.05:
            score += 0.5
        elif balance_dist < 0.15:
            score += 0.25
        weights_total += 0.5

        return min(score / weights_total, 1.0)

    # ── Categorization ──────────────────────────────────────────────

    def _categorize(self, s: BotSignals) -> BotCategory:
        """Assign a category based on the dominant signal pattern."""
        # Market maker: balanced buy/sell, many markets, high frequency
        balance = abs(s.buy_sell_ratio - 0.5)
        if balance < 0.1 and s.unique_markets >= 5 and s.trade_count >= 100:
            return BotCategory.MARKET_MAKER

        # Sniper: extremely fast reactions, fewer trades
        if s.fastest_reaction_ms < 1000 and s.trade_count < 200:
            return BotCategory.SNIPER

        # Arbitrageur: many markets, fast, balanced
        if s.unique_markets >= 15 and s.fastest_reaction_ms < 3000:
            return BotCategory.ARBITRAGEUR

        # Momentum: buys heavily (ratio > 0.65)
        if s.buy_sell_ratio > 0.65:
            return BotCategory.MOMENTUM

        # Contrarian: sells heavily (ratio < 0.35)
        if s.buy_sell_ratio < 0.35:
            return BotCategory.CONTRARIAN

        return BotCategory.UNKNOWN

    def _generate_tags(
        self, s: BotSignals, trades: list[Trade] | None = None
    ) -> list[str]:
        tags: list[str] = []
        if s.fastest_reaction_ms < 1000:
            tags.append("sub-second")
        if s.active_hours_per_day >= 20:
            tags.append("24/7")
        if s.interval_cv < 0.3 and s.interval_cv > 0:
            tags.append("clockwork")
        if s.round_size_pct >= 0.7:
            tags.append("round-sizes")
        if s.unique_markets >= 20:
            tags.append("wide-coverage")
        if s.avg_trade_size_usd >= 1000:
            tags.append("whale")
        if abs(s.buy_sell_ratio - 0.5) < 0.05:
            tags.append("balanced")

        # Copy-worthiness tags
        if s.avg_market_burst <= 2:
            tags.append("clean-entries")
        elif s.avg_market_burst >= 10:
            tags.append("micro-trader")
        if s.trades_per_market <= 3:
            tags.append("conviction")
        if s.market_concentration >= 0.5:
            tags.append("concentrated")
        if 1 <= s.avg_hold_time_hours <= 168:  # 1h to 1 week
            tags.append("mid-hold")

        # Market category tags from trade titles
        if trades:
            titles = {t.title for t in trades if t.title}
            categories = infer_categories(titles)
            tags.extend(categories)

        return tags

    # ── Copy-worthiness scoring ─────────────────────────────────────

    @staticmethod
    def compute_copy_score(
        signals: BotSignals,
        pnl_pct: float = 0.0,
        win_rate: float = 0.0,
        profit_all: float = 0.0,
        profit_1d: float = 0.0,
        profit_7d: float = 0.0,
        profit_30d: float = 0.0,
        category: str = "",
    ) -> float:
        """Compute a 0-100 copy-worthiness score (bottom-up).

        Returns -1 when insufficient data to score meaningfully.
        Higher = better candidate for copy trading.

        Signals (total 100 pts):
        - P&L % (25): is this wallet actually profitable?
        - Win rate (15): higher = more consistent
        - Hold time (15): longer holds = easier to copy
        - Profit consistency (10): profitable across time periods
        - Market liquidity (10): trades on liquid markets = less slippage
        - Trade frequency (10): moderate = manageable to copy
        - Drawdown (10): low drawdown = safer
        - Burst penalty (5): clean entries vs micro-trading

        Category penalties:
        - Market makers profit from the spread, not direction — copying
          their buys means buying at their ask price without the spread.
        - Arbitrageurs exploit momentary price differences across venues —
          by the time we copy, the arb opportunity is gone.
        """
        # Insufficient data: need trades and some profit data
        if signals.trade_count < 10 and profit_all == 0 and pnl_pct == 0:
            return -1.0

        score = 0.0

        # Category penalty: uncopyable strategies get a hard cap
        uncopyable = category.lower() in ("market_maker", "arbitrageur")
        if uncopyable:
            # Still compute the score for informational purposes but cap at 15
            pass

        # 1. P&L % — the most important signal (up to 25 pts)
        if pnl_pct > 10:
            score += 25
        elif pnl_pct > 5:
            score += 20
        elif pnl_pct > 1:
            score += 12
        elif pnl_pct > 0:
            score += 5
        # Negative P&L is simply 0 pts (not penalized below 0)

        # 2. Win rate (up to 15 pts)
        if win_rate >= 0.65:
            score += 15
        elif win_rate >= 0.55:
            score += 10
        elif win_rate >= 0.45:
            score += 5

        # 3. Hold time — longer holds are easier to copy (up to 15 pts)
        h = signals.avg_hold_time_hours
        if 4 <= h <= 168:  # 4h to 1 week — ideal range
            score += 15
        elif 1 <= h < 4:
            score += 8
        elif h > 168:
            score += 5  # very long holds are fine, just slow
        # Sub-hour holds get 0 pts (hard to copy)

        # 4. Profit consistency — profitable across time periods (up to 10 pts)
        periods_positive = sum(1 for p in (profit_1d, profit_7d, profit_30d) if p > 0)
        if periods_positive == 3:
            score += 10  # all recent periods profitable
        elif periods_positive == 2:
            score += 6
        elif periods_positive == 1 and profit_all > 0:
            score += 3

        # 5. Market liquidity proxy — diversified, moderate-sized trades (up to 10 pts)
        # Low concentration + moderate trade size = liquid markets
        if signals.market_concentration < 0.3 and signals.avg_trade_size_usd < 500:
            score += 10
        elif signals.market_concentration < 0.5 and signals.avg_trade_size_usd < 1000:
            score += 6
        elif signals.market_concentration < 0.7:
            score += 3

        # 6. Trade frequency — moderate is best (up to 10 pts)
        # Ideal: 1-20 trades per day equivalent
        tpm = signals.trades_per_market
        if 2 <= tpm <= 10:
            score += 10  # moderate, deliberate trading
        elif 1 <= tpm < 2:
            score += 7  # very clean entries
        elif 10 < tpm <= 20:
            score += 5
        elif tpm > 50:
            score += 0  # excessive micro-trading

        # 7. Drawdown — inferred from recent vs all-time (up to 10 pts)
        if profit_all > 0:
            if profit_30d >= 0:
                score += 10  # no recent drawdown
            elif profit_30d > -profit_all * 0.1:
                score += 5  # small recent drawdown
            # Large drawdown gets 0 pts

        # 8. Burst trading penalty (up to 5 pts)
        if signals.avg_market_burst <= 2:
            score += 5  # clean single entries
        elif signals.avg_market_burst <= 5:
            score += 3

        # Cap uncopyable categories — their profits don't transfer to copiers
        if uncopyable:
            score = min(score, 15)

        return max(0, min(100, score))
