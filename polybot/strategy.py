"""Bot strategy analysis and similar bot search."""

from __future__ import annotations

import logging
import math
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

import requests

from polybot.categories import CATEGORY_KEYWORDS, infer_categories

logger = logging.getLogger(__name__)

DATA_API = "https://data-api.polymarket.com"

# ── Data fetching ───────────────────────────────────────────────────


def _fetch_activity(wallet: str, limit: int = 500) -> list[dict]:
    """Fetch activity items from Polymarket Data API."""
    items: list[dict] = []
    offset = 0
    while len(items) < limit:
        batch_limit = min(100, limit - len(items))
        try:
            resp = requests.get(
                f"{DATA_API}/activity",
                params={"user": wallet, "limit": batch_limit, "offset": offset},
                timeout=15,
            )
            resp.raise_for_status()
            batch = resp.json()
            if not batch:
                break
            items.extend(batch)
            if len(batch) < batch_limit:
                break
            offset += batch_limit
        except Exception as e:
            logger.warning("Failed to fetch activity for %s: %s", wallet, e)
            break
    return items


def _fetch_positions(wallet: str) -> list[dict]:
    """Fetch current positions from Polymarket."""
    try:
        resp = requests.get(
            f"{DATA_API}/positions",
            params={"user": wallet, "sizeThreshold": -1, "limit": 200},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        logger.warning("Failed to fetch positions for %s: %s", wallet, e)
        return []


def _fetch_profit(wallet: str, window: str = "all") -> float:
    """Fetch profit amount for a given window."""
    try:
        resp = requests.get(
            f"{DATA_API}/profit",
            params={"user": wallet, "window": window},
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json().get("amount", 0) or 0
    except Exception:
        return 0


def _parse_ts(raw: Any) -> datetime | None:
    """Parse a timestamp from activity data."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        ts = raw if raw > 1e12 else raw * 1000
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
    if isinstance(raw, str):
        try:
            n = float(raw)
            ts = n if n > 1e12 else n * 1000
            return datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        except ValueError:
            try:
                return datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                return None
    return None


def _classify_title(title: str) -> str:
    """Classify a single title into a category."""
    lower = title.lower()
    for category, keywords in CATEGORY_KEYWORDS.items():
        if any(kw in lower for kw in keywords):
            return category
    return "other"


# ── Strategy Analysis ───────────────────────────────────────────────


def analyze_strategy(wallet: str) -> dict:
    """Analyze a wallet's trading strategy in depth.

    Returns a comprehensive strategy profile including:
    - Activity heatmap (24x7)
    - Market category breakdown with P&L
    - Position sizing profile
    - Hold time distribution
    - Entry/exit patterns
    - Side analysis
    """
    activities = _fetch_activity(wallet, limit=500)
    positions = _fetch_positions(wallet)

    # Filter to trades only
    trades = [
        a
        for a in activities
        if a.get("type") == "TRADE" or (not a.get("type") and a.get("side"))
    ]

    # Get username
    username = ""
    if activities:
        name = activities[0].get("name")
        if name and isinstance(name, str) and not name.startswith("0x"):
            username = name

    # ── Activity heatmap (24x7: hour x day-of-week) ────────────────
    heatmap = [[0] * 7 for _ in range(24)]  # heatmap[hour][dow]
    trade_timestamps: list[datetime] = []

    for t in trades:
        ts = _parse_ts(t.get("timestamp"))
        if ts:
            heatmap[ts.hour][ts.weekday()] += 1
            trade_timestamps.append(ts)

    # Identify active hours (hours with > 5% of total trades)
    total_trades = sum(sum(row) for row in heatmap)
    threshold = max(1, total_trades * 0.02)
    active_hours_utc: list[int] = []
    for h in range(24):
        if sum(heatmap[h]) >= threshold:
            active_hours_utc.append(h)

    # Guess quiet window
    quiet_start = quiet_end = 0
    if active_hours_utc:
        # Find the longest gap
        sorted_hours = sorted(active_hours_utc)
        max_gap = 0
        gap_start = 0
        for i in range(len(sorted_hours)):
            next_i = (i + 1) % len(sorted_hours)
            gap = (sorted_hours[next_i] - sorted_hours[i]) % 24
            if gap > max_gap:
                max_gap = gap
                gap_start = sorted_hours[i]
                gap_end = sorted_hours[next_i]
        if max_gap >= 4:
            quiet_start = (gap_start + 1) % 24
            quiet_end = gap_end

    # Guess timezone based on quiet window center
    tz_guess = ""
    if quiet_start != quiet_end:
        quiet_center = (quiet_start + ((quiet_end - quiet_start) % 24) // 2) % 24
        # If quiet center is around 20-22 UTC, bot is likely EST/PST
        tz_offsets = {
            (20, 22): "PST",
            (17, 19): "EST",
            (12, 14): "CET",
            (4, 6): "JST",
        }
        for (lo, hi), tz in tz_offsets.items():
            if lo <= quiet_center <= hi:
                tz_guess = tz
                break

    # ── Category breakdown with P&L ────────────────────────────────
    cat_stats: dict[str, dict] = defaultdict(
        lambda: {"pnl": 0.0, "volume": 0.0, "wins": 0, "losses": 0, "trade_count": 0}
    )

    # Build per-asset FIFO queues for P&L
    asset_buys: dict[str, list[dict]] = defaultdict(list)  # asset_id -> [buy entries]

    for t in trades:
        title = t.get("title", "")
        cat = _classify_title(title)
        side = (t.get("side") or "").upper()
        price = float(t.get("price") or 0)
        size = float(t.get("size") or 0)
        asset_id = t.get("asset") or t.get("asset_id") or t.get("conditionId", "")
        ts = _parse_ts(t.get("timestamp"))

        cat_stats[cat]["trade_count"] += 1
        notional = price * size
        cat_stats[cat]["volume"] += notional

        if side == "BUY":
            asset_buys[asset_id].append(
                {
                    "price": price,
                    "size": size,
                    "ts": ts,
                    "cat": cat,
                }
            )
        elif side == "SELL" and asset_buys[asset_id]:
            sell_remaining = size
            while sell_remaining > 0 and asset_buys[asset_id]:
                buy = asset_buys[asset_id][0]
                matched = min(sell_remaining, buy["size"])
                pnl = matched * (price - buy["price"])
                buy_cat = buy["cat"]
                cat_stats[buy_cat]["pnl"] += pnl
                if pnl >= 0:
                    cat_stats[buy_cat]["wins"] += 1
                else:
                    cat_stats[buy_cat]["losses"] += 1
                buy["size"] -= matched
                sell_remaining -= matched
                if buy["size"] <= 0.001:
                    asset_buys[asset_id].pop(0)

    category_breakdown = []
    for cat, stats in sorted(cat_stats.items(), key=lambda x: -x[1]["volume"]):
        total = stats["wins"] + stats["losses"]
        category_breakdown.append(
            {
                "category": cat,
                "pnl": round(stats["pnl"], 2),
                "win_rate": round(stats["wins"] / total, 3) if total > 0 else 0,
                "volume": round(stats["volume"], 2),
                "trade_count": stats["trade_count"],
            }
        )

    # ── Position sizing profile ─────────────────────────────────────
    trade_sizes = [
        float(t.get("price", 0)) * float(t.get("size", 0))
        for t in trades
        if float(t.get("size", 0)) > 0
    ]
    trade_sizes.sort()

    def percentile(arr: list[float], p: float) -> float:
        if not arr:
            return 0
        idx = int(len(arr) * p)
        return arr[min(idx, len(arr) - 1)]

    sizing = {
        "median": round(percentile(trade_sizes, 0.5), 2),
        "p25": round(percentile(trade_sizes, 0.25), 2),
        "p75": round(percentile(trade_sizes, 0.75), 2),
        "max": round(max(trade_sizes) if trade_sizes else 0, 2),
        "count": len(trade_sizes),
    }

    # ── Hold time distribution ──────────────────────────────────────
    # Build FIFO match for hold times
    hold_times_min: list[float] = []
    win_hold_times: list[float] = []
    loss_hold_times: list[float] = []
    ht_buys: dict[str, list[dict]] = defaultdict(list)

    for t in trades:
        side = (t.get("side") or "").upper()
        price = float(t.get("price") or 0)
        size = float(t.get("size") or 0)
        asset_id = t.get("asset") or t.get("asset_id") or t.get("conditionId", "")
        ts = _parse_ts(t.get("timestamp"))

        if side == "BUY":
            ht_buys[asset_id].append({"price": price, "size": size, "ts": ts})
        elif side == "SELL" and ht_buys[asset_id]:
            sell_remaining = size
            while sell_remaining > 0 and ht_buys[asset_id]:
                buy = ht_buys[asset_id][0]
                matched = min(sell_remaining, buy["size"])
                if ts and buy["ts"]:
                    hold_min = (ts - buy["ts"]).total_seconds() / 60
                    hold_times_min.append(hold_min)
                    pnl = matched * (price - buy["price"])
                    if pnl >= 0:
                        win_hold_times.append(hold_min)
                    else:
                        loss_hold_times.append(hold_min)
                buy["size"] -= matched
                sell_remaining -= matched
                if buy["size"] <= 0.001:
                    ht_buys[asset_id].pop(0)

    # Bucket hold times
    buckets = {
        "<5m": 0,
        "5-30m": 0,
        "30m-1h": 0,
        "1-4h": 0,
        "4-24h": 0,
        "1-7d": 0,
        ">7d": 0,
    }
    for ht in hold_times_min:
        if ht < 5:
            buckets["<5m"] += 1
        elif ht < 30:
            buckets["5-30m"] += 1
        elif ht < 60:
            buckets["30m-1h"] += 1
        elif ht < 240:
            buckets["1-4h"] += 1
        elif ht < 1440:
            buckets["4-24h"] += 1
        elif ht < 10080:
            buckets["1-7d"] += 1
        else:
            buckets[">7d"] += 1

    # ── Entry/exit patterns ─────────────────────────────────────────
    avg_win_hold = (
        round(sum(win_hold_times) / len(win_hold_times), 1) if win_hold_times else 0
    )
    avg_loss_hold = (
        round(sum(loss_hold_times) / len(loss_hold_times), 1) if loss_hold_times else 0
    )

    entry_exit = {
        "avg_loss_exit_time_min": avg_loss_hold,
        "avg_win_exit_time_min": avg_win_hold,
        "total_closed_trades": len(hold_times_min),
    }

    # ── Side analysis ───────────────────────────────────────────────
    market_sides: dict[str, dict] = defaultdict(lambda: {"buy": 0.0, "sell": 0.0})
    for t in trades:
        cid = t.get("conditionId") or t.get("market", "")
        side = (t.get("side") or "").upper()
        notional = float(t.get("price", 0)) * float(t.get("size", 0))
        if side == "BUY":
            market_sides[cid]["buy"] += notional
        elif side == "SELL":
            market_sides[cid]["sell"] += notional

    both_sides_count = sum(
        1 for m in market_sides.values() if m["buy"] > 0 and m["sell"] > 0
    )
    total_markets = len(market_sides)
    total_buy = sum(m["buy"] for m in market_sides.values())
    total_sell = sum(m["sell"] for m in market_sides.values())
    total_notional = total_buy + total_sell

    side_analysis = {
        "both_sides_pct": round(both_sides_count / total_markets, 3)
        if total_markets > 0
        else 0,
        "net_long_bias": round(total_buy / total_notional, 3)
        if total_notional > 0
        else 0.5,
        "markets_traded": total_markets,
    }

    # ── Fetch profit data ───────────────────────────────────────────
    profits = {}
    for window in ["1d", "7d", "30d", "all"]:
        profits[window] = _fetch_profit(wallet, window)

    return {
        "wallet": wallet,
        "username": username,
        "analysis_time": datetime.now(timezone.utc).isoformat(),
        "total_trades": total_trades,
        "active_hours": heatmap,
        "active_hours_utc": active_hours_utc,
        "quiet_window": {
            "start_hour_utc": quiet_start,
            "end_hour_utc": quiet_end,
            "timezone_guess": tz_guess,
        },
        "category_breakdown": category_breakdown,
        "sizing": sizing,
        "hold_times": buckets,
        "hold_time_median_min": round(percentile(sorted(hold_times_min), 0.5), 1)
        if hold_times_min
        else 0,
        "entry_exit": entry_exit,
        "side_analysis": side_analysis,
        "profits": {
            "profit_1d": profits.get("1d", 0),
            "profit_7d": profits.get("7d", 0),
            "profit_30d": profits.get("30d", 0),
            "profit_all": profits.get("all", 0),
        },
        "open_positions": len(positions),
    }


# ── Similar Bot Search ──────────────────────────────────────────────


def _jaccard(a: set, b: set) -> float:
    """Jaccard similarity between two sets."""
    if not a and not b:
        return 1.0
    union = a | b
    if not union:
        return 0.0
    return len(a & b) / len(union)


def compute_similarity(ref: dict, candidate: dict) -> float:
    """Compute similarity score (0-100) between a reference strategy profile and a candidate.

    ref: full strategy analysis result from analyze_strategy()
    candidate: dict with keys:
        active_hours_utc, categories, median_hold_min, trades_per_day,
        win_rate, volume_all
    """
    score = 0.0

    # 1. Active hours overlap (25%)
    ref_hours = set(ref.get("active_hours_utc", []))
    cand_hours = set(candidate.get("active_hours_utc", []))
    score += 25 * _jaccard(ref_hours, cand_hours)

    # 2. Market categories (25%)
    ref_cats = set(
        c["category"]
        for c in ref.get("category_breakdown", [])
        if c.get("trade_count", 0) >= 5
    )
    cand_cats = set(candidate.get("categories", []))
    score += 25 * _jaccard(ref_cats, cand_cats)

    # 3. Hold time range (15%)
    ref_hold = ref.get("hold_time_median_min", 0)
    cand_hold = candidate.get("median_hold_min", 0)
    if ref_hold > 0 and cand_hold > 0:
        max_hold = max(ref_hold, cand_hold)
        score += 15 * (1 - abs(ref_hold - cand_hold) / max_hold)
    elif ref_hold == 0 and cand_hold == 0:
        score += 15  # both unknown = match

    # 4. Win rate (15%)
    ref_wr = 0
    for c in ref.get("category_breakdown", []):
        total = c.get("trade_count", 0)
        wins = c.get("wins", 0) if "wins" in c else 0
        # Estimate from win_rate if available
        if total > 0 and c.get("win_rate", 0) > 0:
            ref_wr = c["win_rate"]
            break
    cand_wr = candidate.get("win_rate", 0)
    score += 15 * (1 - abs(ref_wr - cand_wr))

    # 5. Volume range (10%)
    ref_vol = sum(c.get("volume", 0) for c in ref.get("category_breakdown", []))
    cand_vol = candidate.get("volume_all", 0)
    if ref_vol > 0 and cand_vol > 0:
        log_diff = abs(math.log10(max(ref_vol, 1)) - math.log10(max(cand_vol, 1)))
        max_log = 6  # orders of magnitude range
        score += 10 * max(0, 1 - log_diff / max_log)
    elif ref_vol == 0 and cand_vol == 0:
        score += 10

    # 6. Trade frequency (10%)
    ref_freq = ref.get("total_trades", 0)
    cand_freq = candidate.get("trades_per_day", 0) * 7  # approximate weekly
    if ref_freq > 0 and cand_freq > 0:
        max_freq = max(ref_freq, cand_freq)
        score += 10 * (1 - abs(ref_freq - cand_freq) / max_freq)
    elif ref_freq == 0 and cand_freq == 0:
        score += 10

    return round(min(score, 100), 1)


def find_similar_bots(
    ref_analysis: dict,
    candidates: list[dict],
    top: int = 20,
) -> list[dict]:
    """Find bots most similar to a reference bot.

    ref_analysis: output of analyze_strategy() for the reference bot
    candidates: list of dicts with bot profile data (from suspect_bots table)
        Each must have: wallet, categories (list[str]), win_rate, volume_all,
        and optionally: active_hours_utc, median_hold_min, trades_per_day
    top: number of results to return
    """
    ref_wallet = ref_analysis.get("wallet", "").lower()
    results = []

    for cand in candidates:
        if cand.get("wallet", "").lower() == ref_wallet:
            continue
        sim = compute_similarity(ref_analysis, cand)
        results.append(
            {
                "wallet": cand["wallet"],
                "username": cand.get("username", ""),
                "similarity": sim,
                "category": cand.get("category", ""),
                "categories": cand.get("categories", []),
                "win_rate": cand.get("win_rate", 0),
                "profit_all": cand.get("profit_all", 0),
                "copy_score": cand.get("copy_score", 0),
                "trade_count": cand.get("trade_count", 0),
            }
        )

    results.sort(key=lambda x: -x["similarity"])
    return results[:top]
