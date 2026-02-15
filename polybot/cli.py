"""CLI interface for Polybot — the Polymarket bot detection & copy-trading tool."""

from __future__ import annotations

import logging
import signal
import sys

import click
from rich.console import Console
from rich.table import Table

from polybot.config import Config
from polybot.db import Database
from polybot.models import CopyMode

console = Console()

# ── Shared setup ────────────────────────────────────────────────────


def _setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def _get_db(config: Config) -> Database:
    return Database(config.db_path)


# ── Root command ────────────────────────────────────────────────────


@click.group()
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
@click.pass_context
def cli(ctx: click.Context, verbose: bool) -> None:
    """Polybot — Polymarket bot detection & copy-trading system."""
    _setup_logging(verbose)
    ctx.ensure_object(dict)
    ctx.obj["config"] = Config.from_env()


# ── Ingest commands ─────────────────────────────────────────────────


@cli.command()
@click.option("--pages", default=10, help="Number of API pages to backfill.")
@click.option("--per-page", default=100, help="Trades per page.")
@click.pass_context
def backfill(ctx: click.Context, pages: int, per_page: int) -> None:
    """Backfill historical trades from the Polymarket Data API."""
    from polybot.firehose import backfill_trades

    config = ctx.obj["config"]
    db = _get_db(config)

    def _on_trade(trade):
        db.insert_trade(trade)

    console.print(f"Backfilling up to {pages * per_page} trades...")
    total = backfill_trades(on_trade=_on_trade, pages=pages, per_page=per_page)
    console.print(f"[green]Ingested {total} trades.[/green]  DB total: {db.get_trade_count()}")
    db.close()


@cli.command()
@click.option("--markets", default=50, help="Number of top markets to subscribe to.")
@click.pass_context
def stream(ctx: click.Context, markets: int) -> None:
    """Stream live trades from the Polymarket WebSocket firehose."""
    from polybot.copier import CopyTrader
    from polybot.firehose import Firehose

    config = ctx.obj["config"]
    db = _get_db(config)
    copier = CopyTrader(db, config)
    trade_count = 0

    def _on_trade(trade):
        nonlocal trade_count
        db.insert_trade(trade)
        copier.on_trade(trade)
        trade_count += 1
        if trade_count % 100 == 0:
            console.print(f"  [dim]{trade_count} trades ingested...[/dim]")

    firehose = Firehose(on_trade=_on_trade)

    console.print(f"Subscribing to top {markets} active markets...")
    tokens = firehose.subscribe_all_active(limit=markets)
    console.print(f"Watching {len(tokens)} token IDs.  Press Ctrl+C to stop.")

    def _shutdown(sig, frame):
        console.print("\n[yellow]Shutting down...[/yellow]")
        firehose.stop()
        db.close()
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    firehose.start()


# ── Detection commands ──────────────────────────────────────────────


@cli.command()
@click.option("--min-trades", default=20, help="Minimum trades to consider.")
@click.option("--min-confidence", default=0.3, help="Minimum confidence score.")
@click.pass_context
def detect(ctx: click.Context, min_trades: int, min_confidence: float) -> None:
    """Scan all wallets for bot-like behavior."""
    from polybot.detector import BotDetector

    config = ctx.obj["config"]
    config.min_trades_for_detection = min_trades
    db = _get_db(config)
    detector = BotDetector(db, config)

    console.print("Scanning wallets for bot patterns...")
    suspects = detector.scan_all_wallets(min_trades=min_trades)
    suspects = [s for s in suspects if s.confidence >= min_confidence]

    if not suspects:
        console.print("[yellow]No bots detected.  Try backfilling more data first.[/yellow]")
        db.close()
        return

    table = Table(title=f"Suspected Bots ({len(suspects)} found)")
    table.add_column("Wallet", style="cyan", max_width=16)
    table.add_column("Confidence", justify="right")
    table.add_column("Category", style="magenta")
    table.add_column("Trades", justify="right")
    table.add_column("Markets", justify="right")
    table.add_column("Avg $", justify="right")
    table.add_column("Tags")

    for bot in suspects[:50]:
        table.add_row(
            bot.wallet[:16] + "...",
            f"{bot.confidence:.0%}",
            bot.category.value,
            str(bot.signals.trade_count),
            str(bot.signals.unique_markets),
            f"${bot.signals.avg_trade_size_usd:.2f}",
            ", ".join(bot.tags[:3]),
        )

    console.print(table)
    db.close()


@cli.command()
@click.pass_context
def bots(ctx: click.Context) -> None:
    """List all previously detected bots."""
    config = ctx.obj["config"]
    db = _get_db(config)
    suspects = db.get_suspect_bots()

    if not suspects:
        console.print("[yellow]No bots in database.  Run 'detect' first.[/yellow]")
        db.close()
        return

    table = Table(title=f"Known Bots ({len(suspects)})")
    table.add_column("Wallet", style="cyan", max_width=16)
    table.add_column("Confidence", justify="right")
    table.add_column("Category", style="magenta")
    table.add_column("Trades", justify="right")
    table.add_column("Tags")

    for bot in suspects:
        table.add_row(
            bot.wallet[:16] + "...",
            f"{bot.confidence:.0%}",
            bot.category.value,
            str(bot.signals.trade_count),
            ", ".join(bot.tags[:3]),
        )

    console.print(table)
    db.close()


# ── Profitability commands ──────────────────────────────────────────


@cli.command()
@click.option("--top", default=20, help="Number of top wallets to evaluate.")
@click.option("--min-confidence", default=0.5, help="Minimum bot confidence.")
@click.pass_context
def rank(ctx: click.Context, top: int, min_confidence: float) -> None:
    """Rank detected bots by profitability."""
    from polybot.profitability import ProfitabilityTracker

    config = ctx.obj["config"]
    db = _get_db(config)
    tracker = ProfitabilityTracker(db)

    suspects = db.get_suspect_bots(min_confidence=min_confidence)
    if not suspects:
        console.print("[yellow]No bots found.  Run 'detect' first.[/yellow]")
        db.close()
        return

    wallets = [s.wallet for s in suspects[:top]]
    console.print(f"Evaluating profitability for {len(wallets)} bots...")
    results = tracker.rank_wallets(wallets)

    table = Table(title="Bot Profitability Ranking")
    table.add_column("Rank", justify="right")
    table.add_column("Wallet", style="cyan", max_width=16)
    table.add_column("Trades", justify="right")
    table.add_column("Volume", justify="right")
    table.add_column("Realized P&L", justify="right")
    table.add_column("Win Rate", justify="right")
    table.add_column("Sharpe", justify="right")

    for i, r in enumerate(results, 1):
        pnl_style = "green" if r.realized_pnl >= 0 else "red"
        table.add_row(
            str(i),
            r.wallet[:16] + "...",
            str(r.total_trades),
            f"${r.total_volume_usd:,.0f}",
            f"[{pnl_style}]${r.realized_pnl:,.2f}[/{pnl_style}]",
            f"{r.win_rate:.0%}",
            f"{r.sharpe_estimate:.2f}",
        )

    console.print(table)
    db.close()


# ── Copy trading commands ───────────────────────────────────────────


@cli.command()
@click.argument("wallet")
@click.option("--mode", type=click.Choice(["paper", "real"]), default="paper",
              help="Trading mode.")
@click.option("--pct", default=10.0, help="Percentage of bot's trade size to copy.")
@click.option("--max-usd", default=100.0, help="Maximum $ per copy trade.")
@click.pass_context
def copy(ctx: click.Context, wallet: str, mode: str, pct: float, max_usd: float) -> None:
    """Start copy-trading a wallet.

    WALLET is the full wallet address to copy.
    """
    from polybot.copier import CopyTrader

    config = ctx.obj["config"]
    db = _get_db(config)
    copier = CopyTrader(db, config)
    copy_mode = CopyMode.REAL if mode == "real" else CopyMode.PAPER
    target = copier.add_target(wallet, mode=copy_mode, trade_pct=pct, max_position_usd=max_usd)
    console.print(
        f"[green]Now copying[/green] {wallet[:16]}... "
        f"in [bold]{target.mode.value}[/bold] mode "
        f"({target.trade_pct}%, max ${target.max_position_usd})"
    )
    db.close()


@cli.command()
@click.argument("wallet")
@click.pass_context
def uncopy(ctx: click.Context, wallet: str) -> None:
    """Stop copy-trading a wallet."""
    from polybot.copier import CopyTrader

    config = ctx.obj["config"]
    db = _get_db(config)
    copier = CopyTrader(db, config)
    copier.remove_target(wallet)
    console.print(f"[yellow]Stopped copying[/yellow] {wallet[:16]}...")
    db.close()


@cli.command("set-mode")
@click.argument("wallet")
@click.argument("mode", type=click.Choice(["paper", "real"]))
@click.pass_context
def set_mode(ctx: click.Context, wallet: str, mode: str) -> None:
    """Switch a copy target between paper and real mode."""
    from polybot.copier import CopyTrader

    config = ctx.obj["config"]
    db = _get_db(config)
    copier = CopyTrader(db, config)
    copy_mode = CopyMode.REAL if mode == "real" else CopyMode.PAPER
    result = copier.set_mode(wallet, copy_mode)
    if result:
        console.print(f"Switched {wallet[:16]}... to [bold]{mode}[/bold] mode.")
    else:
        console.print(f"[red]Wallet {wallet[:16]}... is not a copy target.[/red]")
    db.close()


@cli.command()
@click.pass_context
def targets(ctx: click.Context) -> None:
    """List all active copy targets."""
    from polybot.copier import CopyTrader

    config = ctx.obj["config"]
    db = _get_db(config)
    copier = CopyTrader(db, config)
    target_list = copier.get_targets()

    if not target_list:
        console.print("[yellow]No copy targets.  Use 'copy <wallet>' to add one.[/yellow]")
        db.close()
        return

    table = Table(title="Copy Targets")
    table.add_column("Wallet", style="cyan", max_width=16)
    table.add_column("Mode", style="bold")
    table.add_column("Trade %", justify="right")
    table.add_column("Max $", justify="right")
    table.add_column("Paper P&L", justify="right")
    table.add_column("Real P&L", justify="right")
    table.add_column("Active")

    for t in target_list:
        table.add_row(
            t.wallet[:16] + "...",
            t.mode.value,
            f"{t.trade_pct:.1f}%",
            f"${t.max_position_usd:.0f}",
            f"${t.total_paper_pnl:.2f}",
            f"${t.total_real_pnl:.2f}",
            "yes" if t.active else "no",
        )

    console.print(table)
    db.close()


@cli.command()
@click.option("--wallet", default=None, help="Filter by source wallet.")
@click.option("--limit", default=50, help="Number of trades to show.")
@click.pass_context
def trades(ctx: click.Context, wallet: str | None, limit: int) -> None:
    """Show recent copy trades."""
    config = ctx.obj["config"]
    db = _get_db(config)
    copy_trades = db.get_copy_trades(source_wallet=wallet, limit=limit)

    if not copy_trades:
        console.print("[yellow]No copy trades yet.[/yellow]")
        db.close()
        return

    table = Table(title=f"Copy Trades (last {limit})")
    table.add_column("Time", style="dim")
    table.add_column("Source", style="cyan", max_width=12)
    table.add_column("Side")
    table.add_column("Price", justify="right")
    table.add_column("Size", justify="right")
    table.add_column("Mode", style="bold")
    table.add_column("Status")

    for ct in copy_trades:
        side_style = "green" if ct.side == "BUY" else "red"
        table.add_row(
            ct.timestamp.strftime("%m-%d %H:%M"),
            ct.source_wallet[:12] + "...",
            f"[{side_style}]{ct.side.value}[/{side_style}]",
            f"${ct.price:.4f}",
            f"{ct.size:.2f}",
            ct.mode.value,
            ct.status,
        )

    console.print(table)
    db.close()


# ── Stats ───────────────────────────────────────────────────────────


@cli.command()
@click.pass_context
def stats(ctx: click.Context) -> None:
    """Show database statistics."""
    config = ctx.obj["config"]
    db = _get_db(config)

    trade_count = db.get_trade_count()
    bot_count = len(db.get_suspect_bots())
    target_count = len(db.get_copy_targets(active_only=True))
    copy_count = len(db.get_copy_trades(limit=100000))

    table = Table(title="Polybot Stats")
    table.add_column("Metric", style="bold")
    table.add_column("Value", justify="right")
    table.add_row("Total trades ingested", f"{trade_count:,}")
    table.add_row("Detected bots", str(bot_count))
    table.add_row("Active copy targets", str(target_count))
    table.add_row("Copy trades executed", str(copy_count))

    console.print(table)
    db.close()
