"""Bot detection engine — analyzes trading patterns to identify automated wallets."""

from __future__ import annotations

import logging
import math
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Optional

from polybot.config import Config
from polybot.db import Database
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

    def analyze_wallet(self, wallet: str) -> Optional[SuspectBot]:
        """Compute bot signals for a single wallet and return a SuspectBot
        if the confidence exceeds the minimum threshold."""
        trades = self.db.get_trades_for_wallet(wallet, limit=5000)
        if len(trades) < self.config.min_trades_for_detection:
            return None

        signals = self._compute_signals(trades)
        confidence = self._score(signals)
        category = self._categorize(signals)
        tags = self._generate_tags(signals)

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
        self.db.upsert_suspect_bot(bot)
        return bot

    # ── Signal computation ──────────────────────────────────────────

    def _compute_signals(self, trades: list[Trade]) -> BotSignals:
        trades_sorted = sorted(trades, key=lambda t: t.timestamp)

        # Time intervals between consecutive trades (ms)
        intervals_ms: list[float] = []
        for i in range(1, len(trades_sorted)):
            delta = (
                trades_sorted[i].timestamp - trades_sorted[i - 1].timestamp
            )
            intervals_ms.append(delta.total_seconds() * 1000)

        avg_interval = statistics.mean(intervals_ms) if intervals_ms else 0
        interval_cv = 0.0
        if intervals_ms and avg_interval > 0:
            interval_cv = statistics.stdev(intervals_ms) / avg_interval

        # Fastest reaction (smallest positive interval)
        positive_intervals = [i for i in intervals_ms if i > 0]
        fastest = min(positive_intervals) if positive_intervals else float("inf")

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
        round_count = sum(
            1 for s in sizes_usd if s > 0 and (s % 5 == 0 or s % 10 == 0)
        )
        round_pct = round_count / len(sizes_usd) if sizes_usd else 0

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

    def _generate_tags(self, s: BotSignals) -> list[str]:
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
        return tags
