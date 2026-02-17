"""Data models for the system."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

# ── Trade from the firehose ─────────────────────────────────────────


class TradeSide(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class Trade(BaseModel):
    """A single trade observed from the firehose."""

    id: str = ""
    market: str  # condition_id
    asset_id: str  # token_id
    side: TradeSide
    price: float
    size: float
    timestamp: datetime
    maker: str = ""  # wallet address
    taker: str = ""  # wallet address
    title: str = ""
    outcome: str = ""
    activity_type: str = "TRADE"  # TRADE, CONVERSION, or REDEEM
    usdc_size: float = 0.0  # for CONVERSION/REDEEM: effective USDC value


# ── Bot detection ───────────────────────────────────────────────────


class BotCategory(str, Enum):
    MARKET_MAKER = "market_maker"
    ARBITRAGEUR = "arbitrageur"
    MOMENTUM = "momentum"
    CONTRARIAN = "contrarian"
    SNIPER = "sniper"  # fast reaction to news / new markets
    WHALE_FOLLOWER = "whale_follower"
    UNKNOWN = "unknown"


class BotSignals(BaseModel):
    """Quantitative signals used for bot detection."""

    trade_count: int = 0
    avg_interval_ms: float = 0.0
    interval_cv: float = 0.0  # coefficient of variation of intervals
    unique_markets: int = 0
    avg_trade_size_usd: float = 0.0
    buy_sell_ratio: float = 0.5
    active_hours_per_day: float = 0.0
    fastest_reaction_ms: float = 999999999.0
    round_size_pct: float = 0.0  # % of trades with round numbers
    avg_hold_time_hours: float = 0.0  # average time between buy and matched sell
    # Copy-worthiness signals
    trades_per_market: float = 0.0  # trade_count / unique_markets — low = clean entries
    avg_market_burst: float = 0.0  # avg trades per market within a 10-min session
    max_market_burst: int = 0  # worst-case burst on a single market
    profit_per_trade_usd: float = 0.0  # avg realized profit per trade (from LB data)
    market_concentration: float = 0.0  # fraction of trades in top market (0-1)
    copy_score: float = 0.0  # 0-100 composite score for copy-worthiness


class SuspectBot(BaseModel):
    """A wallet suspected to be a bot."""

    wallet: str
    confidence: float = Field(ge=0.0, le=1.0)
    category: BotCategory = BotCategory.UNKNOWN
    signals: BotSignals = Field(default_factory=BotSignals)
    first_seen: datetime = Field(default_factory=datetime.utcnow)
    last_seen: datetime = Field(default_factory=datetime.utcnow)
    tags: list[str] = Field(default_factory=list)


# ── Profitability ───────────────────────────────────────────────────


class PositionSnapshot(BaseModel):
    """A point-in-time snapshot of a bot's position in one market."""

    wallet: str
    market: str
    asset_id: str
    outcome: str
    side: TradeSide
    avg_entry_price: float
    size: float
    current_price: float = 0.0
    unrealized_pnl: float = 0.0
    realized_pnl: float = 0.0


class BotProfitability(BaseModel):
    """Aggregated profitability metrics for a bot."""

    wallet: str
    total_trades: int = 0
    total_volume_usd: float = 0.0
    realized_pnl: float = 0.0
    unrealized_pnl: float = 0.0
    pnl_pct: float = 0.0  # total P&L as % of capital deployed
    win_rate: float = 0.0  # fraction of resolved markets won
    avg_return_pct: float = 0.0
    sharpe_estimate: float = 0.0
    markets_traded: int = 0
    active_positions: int = 0
    portfolio_value: float = 0.0  # sum of currentValue across all positions
    market_categories: list[str] = Field(default_factory=list)


# ── Copy trading ────────────────────────────────────────────────────


class CopyMode(str, Enum):
    PAPER = "paper"
    REAL = "real"


class CopyTarget(BaseModel):
    """A bot we are actively copy-trading."""

    wallet: str
    mode: CopyMode = CopyMode.PAPER
    trade_pct: float = 10.0  # % of bot's size to copy
    max_position_usd: float = 100.0
    active: bool = True
    total_paper_pnl: float = 0.0
    total_real_pnl: float = 0.0
    # Per-bot paper trading realism settings
    slippage_bps: float = 50.0  # estimated slippage in basis points (50 = 0.5%)
    latency_ms: float = 2000.0  # estimated execution latency in ms
    fee_rate: float = 0.0  # fee rate override (0 = auto-detect from market category)
    measured_slippage_bps: float = -1.0  # -1 = no measured data yet


class CopyTrade(BaseModel):
    """A trade executed (or paper-recorded) as a copy."""

    id: str = ""
    source_trade_id: str = ""
    source_wallet: str
    market: str
    asset_id: str
    side: TradeSide
    price: float
    size: float
    mode: CopyMode
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    status: str = "pending"  # pending, filled, failed
    pnl: float = 0.0
    # Execution details for realistic paper trading
    source_price: float = 0.0  # price the bot got
    exec_price: float = 0.0  # our simulated price (after slippage)
    fee_amount: float = 0.0  # fee deducted
