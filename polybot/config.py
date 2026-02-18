"""Configuration management."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# Polymarket endpoints
CLOB_HOST = "https://clob.polymarket.com"
CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
RTDS_WS = "wss://ws-live-data.polymarket.com"
GAMMA_HOST = "https://gamma-api.polymarket.com"
DATA_API_HOST = "https://data-api.polymarket.com"
LB_API_HOST = "https://lb-api.polymarket.com"

# Chain
CHAIN_ID = 137  # Polygon


@dataclass
class Config:
    # Polymarket credentials (only needed for real trading)
    private_key: str = ""
    funder_address: str = ""
    signature_type: int = 0

    # Database
    db_path: str = "data/polybot.db"

    # Bot detection thresholds
    min_trades_for_detection: int = 20
    speed_threshold_ms: int = 2000  # trades faster than this are suspicious

    # Copy trading
    copy_trade_percentage: float = 10.0  # % of the bot's trade size to copy
    copy_trade_mode: str = "paper"  # "paper" or "real"
    max_position_usd: float = 100.0  # max $ per single copy trade

    # Cloudflare Worker URL (for remote copy listener)
    cloudflare_worker_url: str = ""

    @classmethod
    def from_env(cls) -> Config:
        return cls(
            private_key=os.getenv("POLYMARKET_PRIVATE_KEY", ""),
            funder_address=os.getenv("POLYMARKET_FUNDER_ADDRESS", ""),
            signature_type=int(os.getenv("POLYMARKET_SIGNATURE_TYPE", "0")),
            db_path=os.getenv("POLYBOT_DB_PATH", "data/polybot.db"),
            copy_trade_percentage=float(os.getenv("COPY_TRADE_PERCENTAGE", "10")),
            copy_trade_mode=os.getenv("COPY_TRADE_MODE", "paper"),
            cloudflare_worker_url=os.getenv("CLOUDFLARE_WORKER_URL", ""),
        )
