"""Market category inference from titles using keyword matching."""

from __future__ import annotations

from typing import Iterable

CATEGORY_KEYWORDS: dict[str, list[str]] = {
    "crypto": [
        "bitcoin",
        "btc",
        "eth",
        "ethereum",
        "crypto",
        "solana",
        "sol",
        "token",
        "coin",
        "defi",
        "dogecoin",
        "doge",
        "xrp",
        "ripple",
        "cardano",
        "ada",
        "bnb",
        "binance",
        "polygon",
        "matic",
        "avax",
        "avalanche",
        "chainlink",
        "link",
        "litecoin",
        "ltc",
    ],
    "politics": [
        "trump",
        "biden",
        "president",
        "election",
        "congress",
        "senate",
        "governor",
        "democrat",
        "republican",
        "nominee",
        "fed chair",
        "supreme court",
        "impeach",
        "parliament",
        "prime minister",
        "political",
        "vote",
        "ballot",
        "electoral",
        "gop",
        "dnc",
    ],
    "sports": [
        "nba",
        "nfl",
        "mlb",
        "nhl",
        "ufc",
        "tennis",
        "open championship",
        "win the",
        "playoff",
        "super bowl",
        "world series",
        "premier league",
        "champions league",
        "world cup",
        "formula 1",
        "f1 ",
        "grand prix",
        "olympics",
        "boxing",
        "mma",
        "la liga",
        "serie a",
        "bundesliga",
    ],
    "pop culture": [
        "oscar",
        "grammy",
        "emmy",
        "movie",
        "album",
        "spotify",
        "tiktok",
        "youtube",
        "netflix",
        "celebrity",
        "award show",
        "box office",
        "billboard",
        "streaming",
        "tv show",
    ],
    "finance": [
        "stock",
        "s&p",
        "nasdaq",
        "gdp",
        "inflation",
        "interest rate",
        "fed ",
        "recession",
        "dow jones",
        "treasury",
        "bond",
        "forex",
        "commodit",
        "oil price",
        "gold price",
        "unemployment",
    ],
    "crypto markets": [
        "btc-updown",
        "eth-updown",
        "sol-updown",
        "updown",
    ],
}


FEE_CATEGORIES = {"crypto markets"}  # markets where taker fees apply
DEFAULT_FEE_RATE = 0.0625


def market_has_fees(title: str) -> bool:
    """Check if a market title indicates taker fees apply."""
    categories = infer_categories([title])
    return bool(FEE_CATEGORIES.intersection(categories))


def infer_categories(titles: Iterable[str]) -> list[str]:
    """Infer market categories from a collection of market titles.

    Returns a sorted list of unique category strings.
    """
    found: set[str] = set()
    for title in titles:
        lower = title.lower()
        for category, keywords in CATEGORY_KEYWORDS.items():
            if any(kw in lower for kw in keywords):
                found.add(category)
    return sorted(found)
