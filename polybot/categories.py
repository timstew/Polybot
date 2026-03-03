"""Market category inference from titles using keyword matching."""

from __future__ import annotations

from typing import Iterable, NamedTuple

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


# ── Fee params by market type (from docs.polymarket.com/trading/fees) ──

class FeeParams(NamedTuple):
    rate: float
    exponent: int


CRYPTO_FEES = FeeParams(rate=0.25, exponent=2)
SPORTS_FEES = FeeParams(rate=0.0175, exponent=1)

# Categories that map to specific fee params
_CATEGORY_FEE_PARAMS: dict[str, FeeParams] = {
    "crypto": CRYPTO_FEES,
    "crypto markets": CRYPTO_FEES,
    "sports": SPORTS_FEES,
}


def calc_fee_per_share(price: float, rate: float, exponent: int) -> float:
    """New fee formula: price × rate × (price × (1 - price))^exponent"""
    return price * rate * (price * (1 - price)) ** exponent


def get_fee_params(title: str) -> FeeParams | None:
    """Return fee params for a market based on its title, or None if no fees."""
    categories = infer_categories([title])
    for cat in categories:
        params = _CATEGORY_FEE_PARAMS.get(cat)
        if params is not None:
            return params
    return None


# Cache: category → (fee_rate, timestamp)
_category_fee_cache: dict[str, tuple[float, float]] = {}
_CATEGORY_FEE_TTL = 86400.0  # 24 hours

# Search keywords used to find a sample active market per category.
# We pick one keyword per category that reliably returns results from Gamma.
_CATEGORY_SEARCH_HINTS: dict[str, str] = {
    "crypto": "bitcoin",
    "politics": "president",
    "sports": "win on",
    "pop culture": "oscar",
    "finance": "interest rate",
    "crypto markets": "updown",
}


def _find_sample_token(category: str) -> str:
    """Discover a token ID for a category by searching Gamma for an active market."""
    import json

    import requests

    from polybot.config import GAMMA_HOST

    hint = _CATEGORY_SEARCH_HINTS.get(category, "")
    if not hint:
        return ""
    try:
        resp = requests.get(
            f"{GAMMA_HOST}/markets",
            params={"active": "true", "closed": "false", "limit": 5},
            timeout=5,
        )
        if not resp.ok:
            return ""
        for m in resp.json():
            title = (m.get("question") or m.get("title") or "").lower()
            if hint.lower() in title:
                clob_ids = m.get("clobTokenIds", "[]")
                if isinstance(clob_ids, str):
                    clob_ids = json.loads(clob_ids)
                if clob_ids:
                    return clob_ids[0]
    except Exception:
        pass
    return ""


def _fetch_fee_rate_from_api(token_id: str) -> float:
    """Query the CLOB API for a token's fee rate. Returns decimal (e.g. 0.10)."""
    import requests

    from polybot.config import CLOB_HOST

    try:
        resp = requests.get(
            f"{CLOB_HOST}/fee-rate",
            params={"token_id": token_id},
            timeout=5,
        )
        if resp.ok:
            bps = resp.json().get("base_fee", 0) or 0
            return bps / 10000.0
    except Exception:
        pass
    return 0.0


def _get_category_fee_rate(category: str) -> float:
    """Get the fee rate for a category, refreshing from the API every 24h.

    Every category is checked daily — even those currently at 0% — so we
    automatically pick up new fees within a day of them being introduced.
    """
    import time

    now = time.time()
    cached = _category_fee_cache.get(category)
    if cached and (now - cached[1]) < _CATEGORY_FEE_TTL:
        return cached[0]

    token_id = _find_sample_token(category)
    rate = _fetch_fee_rate_from_api(token_id) if token_id else 0.0

    # Always cache the result (even 0.0) so we recheck in 24h
    _category_fee_cache[category] = (rate, now)
    return rate


def get_fee_rate(title: str) -> float:
    """Return the taker fee rate for a market based on its title.

    Infers the market category from the title, checks each category's
    fee rate from the CLOB API (cached per category for 24 hours).
    Every category is checked daily so new fees are picked up automatically.
    """
    categories = infer_categories([title])
    best_rate = 0.0
    for cat in categories:
        rate = _get_category_fee_rate(cat)
        if rate > best_rate:
            best_rate = rate
    return best_rate


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
