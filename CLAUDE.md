# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Polybot is a Python CLI tool for detecting automated trading bots on Polymarket and copy-trading their strategies. It ingests trades via REST/WebSocket, applies signal-based detection heuristics, ranks bots by profitability, and can execute copy trades in paper or real mode.

## Commands

```bash
# Install (editable, with dev deps)
pip install -e ".[dev]"

# Run all tests
pytest

# Run a single test file
pytest tests/test_detector.py

# Run a single test
pytest tests/test_detector.py::test_detect_bot_high_frequency -v

# CLI entry point (after install)
polybot --help
```

There is no separate build, lint, or type-check step configured.

## Architecture

Eight modules in `polybot/`, each with a corresponding test file in `tests/`:

- **cli.py** — Click command group with 15 commands (backfill, stream, detect, bots, rank, copy, uncopy, set-mode, targets, trades, stats, etc.). Entry point registered as `polybot` console script.
- **config.py** — `Config.from_env()` loads settings from `.env` via python-dotenv. Defaults: paper mode, 10% copy size, $100 max position, `data/polybot.db`.
- **models.py** — Pydantic v2 models and enums: `Trade`, `BotSignals`, `SuspectBot`, `BotCategory`, `CopyTarget`, `CopyTrade`, `BotProfitability`, `PositionSnapshot`. Enums: `TradeSide`, `BotCategory`, `CopyMode`.
- **db.py** — Async SQLite layer (`aiosqlite`). 5 tables: `trades`, `suspect_bots`, `copy_targets`, `copy_trades`, `position_snapshots`. Auto-creates schema on instantiation.
- **detector.py** — Bot detection engine. Computes 9 quantitative signals per wallet, produces weighted confidence score (0–1), and categorizes into: MARKET_MAKER, ARBITRAGEUR, MOMENTUM, CONTRARIAN, SNIPER, WHALE_FOLLOWER.
- **copier.py** — Copy trading executor. Paper mode logs simulated trades; real mode uses `py-clob-client` to place FOK market orders on Polygon (chain 137). Calculates copy size as `source_notional * trade_pct / 100`, capped at `max_position_usd`.
- **firehose.py** — WebSocket subscriber (`wss://ws-subscriptions-clob.polymarket.com`) and REST client for Polymarket Data API / Gamma API. Accepts `on_trade` callback.
- **profitability.py** — FIFO position reconstruction with realized/unrealized P&L, win rate, Sharpe estimate. Fetches current prices from CLOB API.

## Key Patterns

- **Dependency injection**: All major classes (`Detector`, `CopyTrader`, `ProfitabilityTracker`) accept `db` and `config` in constructors.
- **Async DB, sync CLI**: Database operations are async (`aiosqlite`); CLI commands use `asyncio.run()` to bridge.
- **Pytest fixtures**: Tests use `tmp_path` for ephemeral SQLite databases, `pytest-mock` for external API mocking, and `pytest-asyncio` with `asyncio_mode = "auto"`.
- **Environment config**: Copy `.env.example` to `.env`. Real trading requires `POLYMARKET_PRIVATE_KEY` and `POLYMARKET_FUNDER_ADDRESS`.

## External APIs

- **CLOB API**: `https://clob.polymarket.com` — order placement, price fetching
- **Data API**: `https://data-api.polymarket.com` — historical trade ingestion
- **Gamma API**: `https://gamma-api.polymarket.com` — market metadata
- **WebSocket**: `wss://ws-subscriptions-clob.polymarket.com/ws/market` — live trade stream
