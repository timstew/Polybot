"""FastAPI backend for the Polybot web dashboard."""

from __future__ import annotations

import logging
import threading
import time

import requests as http_requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel as PydanticBaseModel

from polybot.config import Config
from polybot.copier import CopyTrader
from polybot.db import Database
from polybot.detector import BotDetector
from polybot.firehose import fetch_asset_trades, fetch_wallet_trades, listen_trades
from polybot.models import BotSignals, CopyMode
from polybot.profitability import ProfitabilityTracker
from polybot.slippage import SlippageTracker

logger = logging.getLogger(__name__)

app = FastAPI(title="Polybot API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://polybot-b5l.pages.dev",
        "https://polybot-copy-listener.timstew.workers.dev",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

config = Config.from_env()

# ── Listener state ──────────────────────────────────────────────────

_listener_stop: threading.Event | None = None
_listener_thread: threading.Thread | None = None
_listener_new_trades: int = 0
_listener_polls: int = 0
_listener_cumulative_seconds: float = 0.0
_listener_started_at: float | None = None  # time.time() when current session started
_slippage_tracker = SlippageTracker()

# ── Copy-only listener state ────────────────────────────────────────

_copy_listener_stop: threading.Event | None = None
_copy_listener_thread: threading.Thread | None = None
_copy_listener_batches: int = 0


def _db() -> Database:
    return Database(config.db_path)


@app.get("/api/stats")
def stats():
    db = _db()
    trade_count = db.get_trade_count()
    bots = db.get_suspect_bots(min_confidence=0.0)
    targets = db.get_copy_targets(active_only=False)
    active_targets = [t for t in targets if t.active]
    listening = _listener_thread is not None and _listener_thread.is_alive()
    copy_listening = (
        _copy_listener_thread is not None and _copy_listener_thread.is_alive()
    )
    db.close()
    cumulative = _listener_cumulative_seconds
    if _listener_started_at is not None:
        cumulative += time.time() - _listener_started_at

    return {
        "trade_count": trade_count,
        "bot_count": len(bots),
        "copy_targets": len(active_targets),
        "listening": listening,
        "listener_new_trades": _listener_new_trades,
        "listener_polls": _listener_polls,
        "listener_cumulative_seconds": cumulative,
        "copy_listening": copy_listening,
    }


@app.post("/api/listener/start")
def listener_start():
    global \
        _listener_stop, \
        _listener_thread, \
        _listener_new_trades, \
        _listener_polls, \
        _listener_started_at, \
        _slippage_tracker

    if _listener_thread is not None and _listener_thread.is_alive():
        return {"status": "already_running"}

    # Don't run both listeners simultaneously
    if _copy_listener_thread is not None and _copy_listener_thread.is_alive():
        return {"status": "error", "detail": "Copy listener is running. Stop it first."}

    _listener_new_trades = 0
    _listener_polls = 0
    _listener_started_at = time.time()
    _listener_stop = threading.Event()
    _slippage_tracker = SlippageTracker()

    def on_batch(trades):
        global _listener_new_trades, _listener_polls
        _listener_polls += 1
        db = _db()
        before = db.get_trade_count()
        db.insert_trades_batch(trades)
        after = db.get_trade_count()
        added = after - before
        _listener_new_trades += added

        # 1. Feed ALL trades to slippage tracker price buffers
        for trade in trades:
            _slippage_tracker.observe(trade)

        # 2. Execute copy trades (copier uses measured slippage + registers observations)
        copier = CopyTrader(db, config, slippage_tracker=_slippage_tracker)
        for trade in trades:
            copier.on_trade(trade)

        # 3. Resolve pending slippage observations with new price data
        _slippage_tracker.resolve_pending(db)

        # 4. Prune old price buffer entries
        _slippage_tracker.prune_buffers()

        # 5. Periodically persist measured slippage to DB
        if _listener_new_trades % 1000 < len(trades):
            _slippage_tracker.update_target_measured_slippage(db)

        db.close()
        return added

    def on_new_wallets(wallets: list[str]):
        """Continuous detection: scan newly harvested wallets, skip already-analyzed."""
        db = _db()
        try:
            new_wallets = [w for w in wallets if not db.is_wallet_analyzed(w)]
            if not new_wallets:
                return
            logger.info(
                "Continuous detection: %d new wallets to scan", len(new_wallets)
            )
            detector = BotDetector(db, config)
            suspects = detector.scan_wallets_remote(new_wallets)
            for s in suspects:
                db.upsert_suspect(s)
            for w in new_wallets:
                status = (
                    "detected" if any(s.wallet == w for s in suspects) else "detected"
                )
                db.mark_wallet_analyzed(w, status=status)
            logger.info(
                "Continuous detection: found %d bots from %d new wallets",
                len(suspects),
                len(new_wallets),
            )
        finally:
            db.close()

    def on_prune():
        """Periodic cleanup: prune old trades and stale analyzed_wallets."""
        db = _db()
        try:
            db.prune_old_trades(days=7)
            db.prune_analyzed_before(days=30)
            logger.info("Pruned old trades (>7d) and stale analyzed wallets (>30d)")
        finally:
            db.close()

    _listener_thread = threading.Thread(
        target=listen_trades,
        kwargs={
            "on_batch": on_batch,
            "poll_interval": 2.0,
            "batch_size": 500,
            "stop_event": _listener_stop,
            "on_new_wallets": on_new_wallets,
            "on_prune": on_prune,
        },
        daemon=True,
    )
    _listener_thread.start()
    return {"status": "started"}


@app.post("/api/listener/stop")
def listener_stop():
    global \
        _listener_stop, \
        _listener_thread, \
        _listener_cumulative_seconds, \
        _listener_started_at

    if (
        _listener_stop is None
        or _listener_thread is None
        or not _listener_thread.is_alive()
    ):
        return {"status": "not_running"}

    if _listener_started_at is not None:
        _listener_cumulative_seconds += time.time() - _listener_started_at
        _listener_started_at = None

    _listener_stop.set()
    _listener_thread.join(timeout=5)
    return {"status": "stopped", "new_trades": _listener_new_trades}


# ── Copy-only listener (per-wallet polling) ────────────────────────


def _copy_listener_loop(stop_event: threading.Event) -> None:
    """Thin wrapper around the shared listener loop."""
    from polybot.listener import run_copy_listener

    global _copy_listener_batches

    def _on_batch(batch: int, new_count: int) -> None:
        global _copy_listener_batches
        _copy_listener_batches = batch

    run_copy_listener(
        db_factory=_db,
        config=config,
        stop_event=stop_event,
        slippage_tracker=_slippage_tracker,
        on_batch=_on_batch,
    )


@app.post("/api/copy/listener/start")
def copy_listener_start():
    global \
        _copy_listener_stop, \
        _copy_listener_thread, \
        _copy_listener_batches, \
        _slippage_tracker

    if _copy_listener_thread is not None and _copy_listener_thread.is_alive():
        return {"status": "already_running"}

    if _listener_thread is not None and _listener_thread.is_alive():
        return {
            "status": "error",
            "detail": "Full listener is running. Stop it first or use it instead.",
        }

    _copy_listener_batches = 0
    _copy_listener_stop = threading.Event()
    _slippage_tracker = SlippageTracker()

    _copy_listener_thread = threading.Thread(
        target=_copy_listener_loop,
        args=(_copy_listener_stop,),
        daemon=True,
    )
    _copy_listener_thread.start()
    return {"status": "started"}


@app.post("/api/copy/listener/stop")
def copy_listener_stop():
    global _copy_listener_stop, _copy_listener_thread

    if (
        _copy_listener_stop is None
        or _copy_listener_thread is None
        or not _copy_listener_thread.is_alive()
    ):
        return {"status": "not_running"}

    _copy_listener_stop.set()
    _copy_listener_thread.join(timeout=5)
    db = _db()
    _slippage_tracker.update_target_measured_slippage(db)
    db.close()
    return {"status": "stopped"}


# ── Cloudflare Worker proxy endpoints ───────────────────────────────


def _cf_url() -> str:
    url = config.cloudflare_worker_url.rstrip("/")
    if not url:
        raise HTTPException(
            status_code=400,
            detail="CLOUDFLARE_WORKER_URL not configured",
        )
    return url


@app.post("/api/copy/listener/cloud-sync")
def cloud_sync():
    """Push active copy_targets to the Cloudflare Worker's D1 database."""
    db = _db()
    targets = db.get_copy_targets(active_only=False)
    db.close()
    payload = [
        {
            "wallet": t.wallet,
            "mode": t.mode.value,
            "trade_pct": t.trade_pct,
            "max_position_usd": t.max_position_usd,
            "active": int(t.active),
            "total_paper_pnl": t.total_paper_pnl,
            "total_real_pnl": t.total_real_pnl,
            "slippage_bps": t.slippage_bps,
            "latency_ms": t.latency_ms,
            "fee_rate": t.fee_rate,
            "measured_slippage_bps": t.measured_slippage_bps,
        }
        for t in targets
    ]
    resp = http_requests.post(f"{_cf_url()}/sync", json=payload, timeout=10)
    return resp.json()


@app.post("/api/copy/listener/cloud-start")
def cloud_start():
    """Start the Cloudflare Worker copy listener."""
    resp = http_requests.post(f"{_cf_url()}/start", timeout=10)
    return resp.json()


@app.post("/api/copy/listener/cloud-stop")
def cloud_stop():
    """Stop the Cloudflare Worker copy listener."""
    resp = http_requests.post(f"{_cf_url()}/stop", timeout=10)
    return resp.json()


@app.get("/api/copy/listener/cloud-status")
def cloud_status():
    """Check if the Cloudflare Worker copy listener is running."""
    try:
        resp = http_requests.get(f"{_cf_url()}/status", timeout=5)
        return resp.json()
    except Exception:
        return {"running": False, "error": "Cannot reach worker"}


@app.get("/api/copy/trades/cloud")
def cloud_trades(limit: int = Query(20, ge=1, le=200)):
    """Fetch recent copy trades from the Cloudflare Worker's D1 database."""
    try:
        resp = http_requests.get(f"{_cf_url()}/trades?limit={limit}", timeout=10)
        return resp.json()
    except Exception:
        return []


def _compute_pnl_from_trades(trades: list[dict]) -> dict:
    """FIFO P&L computation from a list of trade dicts (same logic as db.compute_copy_pnl)."""
    from datetime import datetime as dt

    positions: dict[str, list[list]] = {}
    realized_pnl = 0.0
    total_fees = 0.0
    hold_times_s: list[float] = []

    for r in trades:
        asset_id = r.get("asset_id", "")
        side = r.get("side", "")
        price = r.get("exec_price", 0) or r.get("price", 0)
        size = r.get("size", 0)
        total_fees += r.get("fee_amount", 0)
        ts = r.get("timestamp", "")

        if asset_id not in positions:
            positions[asset_id] = []

        if side == "BUY":
            positions[asset_id].append([size, price, ts])
        else:
            remaining = size
            while remaining > 0 and positions[asset_id]:
                lot = positions[asset_id][0]
                match_qty = min(remaining, lot[0])
                realized_pnl += (price - lot[1]) * match_qty
                try:
                    buy_dt = dt.fromisoformat(lot[2].replace("Z", "+00:00"))
                    sell_dt = dt.fromisoformat(ts.replace("Z", "+00:00"))
                    hold_times_s.append((sell_dt - buy_dt).total_seconds())
                except (ValueError, TypeError):
                    pass
                lot[0] -= match_qty
                remaining -= match_qty
                if lot[0] <= 1e-9:
                    positions[asset_id].pop(0)

    avg_hold_hours = 0.0
    if hold_times_s:
        avg_hold_hours = (sum(hold_times_s) / len(hold_times_s)) / 3600

    return {
        "realized_pnl": realized_pnl,
        "total_fees": total_fees,
        "avg_hold_time_hours": avg_hold_hours,
    }


@app.get("/api/copy/targets/cloud")
def cloud_targets():
    """Fetch copy targets with P&L computed from Cloudflare Worker's D1 trades."""
    db = _db()
    tracker = ProfitabilityTracker(db)
    targets = db.get_copy_targets(active_only=False)

    # Fetch usernames
    wallets = [t.wallet for t in targets]
    profits = tracker.fetch_wallets_profit(wallets) if wallets else {}
    db.close()

    # Fetch all cloud trades for P&L computation
    cloud_trades_data: list[dict] = []
    try:
        resp = http_requests.get(f"{_cf_url()}/trades?limit=10000", timeout=15)
        if resp.ok:
            cloud_trades_data = resp.json()
    except Exception:
        pass

    # Group trades by source_wallet
    by_wallet: dict[str, list[dict]] = {}
    for ct in cloud_trades_data:
        w = ct.get("source_wallet", "")
        if ct.get("status") == "filled":
            by_wallet.setdefault(w, []).append(ct)
    # Sort each wallet's trades by timestamp for FIFO
    for w in by_wallet:
        by_wallet[w].sort(key=lambda x: x.get("timestamp", ""))

    result = []
    for t in targets:
        wallet_trades = by_wallet.get(t.wallet, [])
        pnl = _compute_pnl_from_trades(wallet_trades)
        paper_pnl = pnl["realized_pnl"] - pnl["total_fees"]

        # Compute listening duration from trade timestamps
        trade_count = len(wallet_trades)
        listening_hours = 0.0
        if trade_count >= 2:
            from datetime import datetime as _dt

            try:
                first = _dt.fromisoformat(
                    wallet_trades[0].get("timestamp", "").replace("Z", "+00:00")
                )
                last = _dt.fromisoformat(
                    wallet_trades[-1].get("timestamp", "").replace("Z", "+00:00")
                )
                listening_hours = (last - first).total_seconds() / 3600
            except (ValueError, TypeError):
                pass

        result.append(
            {
                "wallet": t.wallet,
                "username": profits.get(t.wallet, {}).get("username", ""),
                "mode": t.mode.value,
                "trade_pct": t.trade_pct,
                "max_position_usd": t.max_position_usd,
                "active": t.active,
                "total_paper_pnl": paper_pnl,
                "total_real_pnl": t.total_real_pnl,
                "slippage_bps": t.slippage_bps,
                "latency_ms": t.latency_ms,
                "fee_rate": t.fee_rate,
                "measured_slippage_bps": t.measured_slippage_bps,
                "measured_latency_ms": -1,
                "observations": 0,
                "avg_hold_time_hours": pnl["avg_hold_time_hours"],
                "trade_count": trade_count,
                "listening_hours": round(listening_hours, 1),
            }
        )
    return result


@app.get("/api/bots")
def bots(min_confidence: float = Query(0.0)):
    db = _db()
    suspects = db.get_suspect_bots(min_confidence=min_confidence)
    dismissed = set(db.get_analyzed_wallets(status="dismissed"))
    suspects = [s for s in suspects if s.wallet not in dismissed]
    db.close()
    return [
        {
            "wallet": s.wallet,
            "confidence": s.confidence,
            "category": s.category.value
            if hasattr(s.category, "value")
            else s.category,
            "trade_count": s.signals.trade_count,
            "unique_markets": s.signals.unique_markets,
            "avg_trade_size_usd": s.signals.avg_trade_size_usd,
            "avg_hold_time_hours": s.signals.avg_hold_time_hours,
            "tags": s.tags,
            "first_seen": s.first_seen.isoformat() if s.first_seen else None,
            "last_seen": s.last_seen.isoformat() if s.last_seen else None,
        }
        for s in suspects
    ]


@app.get("/api/rank")
def rank(
    top: int = Query(30, ge=1, le=100),
    min_confidence: float = Query(0.0),
    sort_by: str = Query("pnl_pct", pattern="^(realized_pnl|pnl_pct)$"),
):
    db = _db()
    tracker = ProfitabilityTracker(db)
    suspects = db.get_suspect_bots(min_confidence=min_confidence)
    wallets = [s.wallet for s in suspects[:top]]
    results = tracker.rank_wallets_remote(wallets, sort_by=sort_by)

    # Fetch time-windowed profit for all wallets in parallel from Polymarket LB API
    profits = tracker.fetch_wallets_profit([r.wallet for r in results])

    db.close()
    return [
        {
            "rank": i,
            "wallet": r.wallet,
            "total_trades": r.total_trades,
            "total_volume_usd": r.total_volume_usd,
            "realized_pnl": r.realized_pnl,
            "unrealized_pnl": r.unrealized_pnl,
            "pnl_pct": r.pnl_pct,
            "win_rate": r.win_rate,
            "markets_traded": r.markets_traded,
            "active_positions": r.active_positions,
            "market_categories": r.market_categories,
            **profits.get(r.wallet, {}),
        }
        for i, r in enumerate(results, 1)
    ]


@app.post("/api/bots/clear")
def bots_clear():
    """Clear all detected bots from the database."""
    db = _db()
    db.conn.execute("DELETE FROM suspect_bots")
    db.conn.commit()
    db.close()
    return {"status": "cleared"}


class DismissRequest(PydanticBaseModel):
    wallet: str


@app.post("/api/bots/dismiss")
def bots_dismiss(req: DismissRequest):
    """Dismiss a bot — removes from suspect_bots and prevents re-detection for 30 days."""
    db = _db()
    db.dismiss_wallet(req.wallet)
    db.close()
    return {"status": "dismissed", "wallet": req.wallet}


@app.post("/api/bots/undismiss")
def bots_undismiss(req: DismissRequest):
    """Undo a dismissal so the wallet can be re-detected."""
    db = _db()
    db.undismiss_wallet(req.wallet)
    db.close()
    return {"status": "undismissed", "wallet": req.wallet}


@app.post("/api/trades/clear")
def trades_clear():
    """Clear all ingested firehose trades and reset the listening timer."""
    global \
        _listener_cumulative_seconds, \
        _listener_started_at, \
        _listener_new_trades, \
        _listener_polls
    db = _db()
    db.conn.execute("DELETE FROM trades")
    db.conn.commit()
    db.close()
    _listener_cumulative_seconds = 0.0
    _listener_started_at = None
    _listener_new_trades = 0
    _listener_polls = 0
    return {"status": "cleared"}


@app.post("/api/detect")
def detect(min_trades: int = Query(20)):
    """Run bot detection: local scan then remote-enrich top candidates.

    1. Scans all wallets with ≥min_trades local trades (fast, no HTTP).
    2. For the top wallets by local trade count that didn't score as bots,
       fetches full trade history from the API for a richer analysis.
    """
    db = _db()
    detector = BotDetector(db, config)

    # Phase 1: fast local scan
    suspects = detector.scan_all_wallets(min_trades=min_trades)
    found_wallets = {s.wallet for s in suspects}

    # Phase 2: remote-enrich top wallets that didn't make the cut locally
    wallets = db.get_all_wallets_trade_counts()
    candidates = [
        w
        for w, count in sorted(wallets.items(), key=lambda x: x[1], reverse=True)
        if count >= min_trades and w not in found_wallets
    ][:200]  # cap at 200 to avoid rate limiting

    if candidates:
        remote_suspects = detector.scan_wallets_remote(
            candidates, min_trades=min_trades
        )
        suspects.extend(remote_suspects)

    wallets_scanned = len(wallets)
    db.close()
    return {
        "status": "completed",
        "bots_found": len(suspects),
        "wallets_scanned": wallets_scanned,
    }


@app.post("/api/detect/cloud")
def detect_cloud(
    wallets: list[str],
    min_trades: int = Query(5),
    min_confidence: float = Query(0.1),
):
    """Run bot detection on a provided list of wallets (for cloud use).

    Skips Phase 1 (local DB scan) and runs Phase 2 only — fetching each
    wallet's activity from the Polymarket API and scoring remotely.
    Uses a lower confidence threshold than local detection since we have
    fewer trades per wallet from the remote API.
    """
    if not wallets:
        return {"status": "completed", "bots_found": 0, "wallets_scanned": 0}

    db = _db()
    detector = BotDetector(db, config)

    # Cap at 500 to avoid rate limiting
    candidates = wallets[:500]
    suspects = detector.scan_wallets_remote(
        candidates,
        min_trades=min_trades,
        min_confidence=min_confidence,
    )

    # Fetch profitability and win rates for detected bots
    tracker = ProfitabilityTracker(db)
    bot_wallets = [s.wallet for s in suspects]
    profits = tracker.fetch_wallets_profit(bot_wallets) if bot_wallets else {}
    win_rates = tracker.fetch_wallets_win_rates(bot_wallets) if bot_wallets else {}

    bots_out = []
    for s in suspects:
        p = profits.get(s.wallet, {})
        wr = win_rates.get(s.wallet, 0.0)
        cat_str = s.category.value if hasattr(s.category, "value") else str(s.category)
        copy_score = BotDetector.compute_copy_score(
            s.signals,
            pnl_pct=p.get("lb_pnl_pct", 0) or 0,
            win_rate=wr,
            profit_all=p.get("profit_all", 0) or 0,
            profit_1d=p.get("profit_1d", 0) or 0,
            profit_7d=p.get("profit_7d", 0) or 0,
            profit_30d=p.get("profit_30d", 0) or 0,
            category=cat_str,
        )
        bots_out.append(
            {
                "wallet": s.wallet,
                "confidence": s.confidence,
                "category": s.category.value
                if hasattr(s.category, "value")
                else s.category,
                "trade_count": s.signals.trade_count,
                "tags": s.tags,
                "username": p.get("username", ""),
                "pnl_pct": p.get("lb_pnl_pct", 0) or 0,
                "realized_pnl": p.get("profit_all", 0) or 0,
                "win_rate": wr,
                "total_volume_usd": p.get("volume_all", 0) or 0,
                "profit_1d": p.get("profit_1d", 0) or 0,
                "profit_7d": p.get("profit_7d", 0) or 0,
                "profit_30d": p.get("profit_30d", 0) or 0,
                "profit_all": p.get("profit_all", 0) or 0,
                "copy_score": round(copy_score, 1),
            }
        )

    db.close()
    return {
        "status": "completed",
        "bots_found": len(suspects),
        "wallets_scanned": len(candidates),
        "bots": bots_out,
    }


@app.get("/api/detect/debug/{wallet}")
def detect_debug(wallet: str):
    """Debug endpoint: test detection on a single wallet with full diagnostics."""
    result: dict = {"wallet": wallet}

    # Step 1: Fetch trades
    try:
        trades = fetch_wallet_trades(wallet, limit=200)
        result["trades_fetched"] = len(trades)
        if trades:
            result["first_trade"] = trades[0].timestamp.isoformat()
            result["last_trade"] = trades[-1].timestamp.isoformat()
    except Exception as e:
        result["fetch_error"] = str(e)
        return result

    if not trades:
        result["analysis"] = "no_trades"
        return result

    # Step 2: Analyze
    db = _db()
    detector = BotDetector(db, config)
    try:
        bot = detector.analyze_wallet(wallet, trades=trades, min_trades_override=1)
        if bot:
            result["confidence"] = bot.confidence
            result["category"] = (
                bot.category.value if hasattr(bot.category, "value") else bot.category
            )
            result["trade_count"] = bot.signals.trade_count
            result["tags"] = bot.tags
        else:
            result["analysis"] = "returned_none"
    except Exception as e:
        result["analyze_error"] = str(e)
    db.close()
    return result


@app.get("/api/unified")
def unified(
    top: int = Query(30, ge=1, le=200),
    min_confidence: float = Query(0.0),
    sort_by: str = Query("pnl_pct", pattern="^(realized_pnl|pnl_pct)$"),
):
    """Unified endpoint merging bot detection signals with profitability data."""
    db = _db()
    tracker = ProfitabilityTracker(db)
    suspects = db.get_suspect_bots(min_confidence=min_confidence)
    dismissed = set(db.get_analyzed_wallets(status="dismissed"))
    suspects = [s for s in suspects if s.wallet not in dismissed]

    # Build detection lookup
    bot_map = {s.wallet: s for s in suspects}
    wallets = [s.wallet for s in suspects[:top]]

    # Profitability from Polymarket Data API (fail gracefully)
    try:
        results = tracker.rank_wallets_remote(wallets, sort_by=sort_by)
    except Exception:
        logger.warning("rank_wallets_remote failed, using detection data only")
        results = []

    # Time-windowed profits from Polymarket Leaderboard API (fail gracefully)
    try:
        profits = tracker.fetch_wallets_profit([r.wallet for r in results])
    except Exception:
        logger.warning("fetch_wallets_profit failed")
        profits = {}

    db.close()

    # Build rows from profitability results
    result_wallets = {r.wallet for r in results}
    rows = []
    for r in results:
        bot = bot_map.get(r.wallet)
        signals = bot.signals if bot else BotSignals()
        p = profits.get(r.wallet, {})
        pnl_pct = p.get("lb_pnl_pct") or r.pnl_pct
        win_rate = r.win_rate
        profit_all = p.get("profit_all", 0) or 0

        cat_str = (
            (
                bot.category.value
                if hasattr(bot.category, "value")
                else str(bot.category)
            )
            if bot
            else ""
        )
        copy_score = BotDetector.compute_copy_score(
            signals,
            pnl_pct=pnl_pct,
            win_rate=win_rate,
            profit_all=profit_all,
            profit_1d=p.get("profit_1d", 0) or 0,
            profit_7d=p.get("profit_7d", 0) or 0,
            profit_30d=p.get("profit_30d", 0) or 0,
            category=cat_str,
        )

        row = {
            "wallet": r.wallet,
            "confidence": bot.confidence if bot else 0,
            "category": (
                bot.category.value
                if bot and hasattr(bot.category, "value")
                else "unknown"
            ),
            "tags": bot.tags if bot else [],
            "avg_hold_time_hours": signals.avg_hold_time_hours,
            "pnl_pct": pnl_pct,
            "realized_pnl": r.realized_pnl,
            "unrealized_pnl": r.unrealized_pnl,
            "win_rate": win_rate,
            "total_volume_usd": p.get("volume_all") or r.total_volume_usd,
            "active_positions": r.active_positions,
            "portfolio_value": p.get("profit_all", 0) or r.portfolio_value,
            "market_categories": r.market_categories,
            "copy_score": round(copy_score, 1),
            "trades_per_market": round(signals.trades_per_market, 1),
            "avg_market_burst": round(signals.avg_market_burst, 1),
            "max_market_burst": signals.max_market_burst,
            "market_concentration": round(signals.market_concentration, 2),
            **{k: v for k, v in p.items() if k not in ("lb_pnl_pct", "volume_all")},
        }
        rows.append(row)

    # If remote profitability failed, still return bots with detection data only
    for s in suspects[:top]:
        if s.wallet in result_wallets:
            continue
        signals = s.signals
        cat_str = s.category.value if hasattr(s.category, "value") else str(s.category)
        copy_score = BotDetector.compute_copy_score(signals, category=cat_str)
        rows.append(
            {
                "wallet": s.wallet,
                "confidence": s.confidence,
                "category": (
                    s.category.value if hasattr(s.category, "value") else s.category
                ),
                "tags": s.tags,
                "avg_hold_time_hours": signals.avg_hold_time_hours,
                "pnl_pct": 0,
                "realized_pnl": 0,
                "unrealized_pnl": 0,
                "win_rate": 0,
                "total_volume_usd": 0,
                "active_positions": 0,
                "portfolio_value": 0,
                "market_categories": [],
                "copy_score": round(copy_score, 1),
                "trades_per_market": round(signals.trades_per_market, 1),
                "avg_market_burst": round(signals.avg_market_burst, 1),
                "max_market_burst": signals.max_market_burst,
                "market_concentration": round(signals.market_concentration, 2),
            }
        )

    return rows


@app.get("/api/wallet/{address}")
def wallet_detail(address: str):
    db = _db()
    tracker = ProfitabilityTracker(db)

    # Bot info from local DB
    bot = db.get_suspect_bot(address)
    bot_info = None
    if bot:
        bot_info = {
            "wallet": bot.wallet,
            "confidence": bot.confidence,
            "category": bot.category.value
            if hasattr(bot.category, "value")
            else bot.category,
            "tags": bot.tags,
            "avg_hold_time_hours": bot.signals.avg_hold_time_hours,
        }

    # Remote positions from Polymarket Data API
    positions = tracker.fetch_remote_positions(address)
    profitability = tracker.evaluate_wallet_remote(address)

    # Fetch username from Polymarket leaderboard API
    profit_data = tracker.fetch_wallet_profit(address)
    lb_username = profit_data.get("username", "")

    # Also check copy_targets for the username we use on the copy page
    copy_target = db.get_copy_target(address)
    copy_username = (
        copy_target.username if copy_target and hasattr(copy_target, "username") else ""
    ) or ""

    # Prefer copy_targets username (matches copy page), fall back to leaderboard
    username = copy_username or lb_username

    db.close()
    return {
        "username": username,
        "alt_username": lb_username if lb_username and lb_username != username else "",
        "bot": bot_info,
        "profitability": {
            "total_trades": profitability.total_trades,
            "total_volume_usd": profit_data.get("volume_all")
            or profitability.total_volume_usd,
            "realized_pnl": profitability.realized_pnl,
            "unrealized_pnl": profitability.unrealized_pnl,
            "pnl_pct": profit_data.get("lb_pnl_pct") or profitability.pnl_pct,
            "win_rate": profitability.win_rate,
            "markets_traded": profitability.markets_traded,
            "active_positions": profitability.active_positions,
            "market_categories": profitability.market_categories,
        },
        "positions": [
            {
                "title": p.get("title", ""),
                "outcome": p.get("outcome", ""),
                "size": float(p.get("size", 0)),
                "avg_price": float(p.get("avgPrice", 0)),
                "current_price": float(p.get("curPrice", 0)),
                "initial_value": float(p.get("initialValue", 0)),
                "current_value": float(p.get("currentValue", 0)),
                "cash_pnl": float(p.get("cashPnl", 0)),
                "percent_pnl": float(p.get("percentPnl", 0)),
                "realized_pnl": float(p.get("realizedPnl", 0)),
                "slug": p.get("slug", ""),
            }
            for p in positions
        ],
    }


@app.get("/api/wallet/{address}/trades")
def wallet_trades(address: str, limit: int = Query(100, ge=1, le=1000)):
    db = _db()
    trades = db.get_trades_for_wallet(address, limit=limit)
    db.close()
    return [
        {
            "id": t.id,
            "market": t.market,
            "title": t.title,
            "side": t.side.value,
            "price": t.price,
            "size": t.size,
            "timestamp": t.timestamp.isoformat() if t.timestamp else None,
        }
        for t in trades
    ]


# ── Copy trading ────────────────────────────────────────────────────


class AddTargetRequest(PydanticBaseModel):
    wallet: str
    trade_pct: float = 10.0
    max_position_usd: float = 100.0
    slippage_bps: float = 50.0
    latency_ms: float = 2000.0
    fee_rate: float = 0.0


@app.post("/api/copy/add")
def copy_add(req: AddTargetRequest):
    db = _db()
    copier = CopyTrader(db, config)
    target = copier.add_target(
        wallet=req.wallet,
        mode=CopyMode.PAPER,
        trade_pct=req.trade_pct,
        max_position_usd=req.max_position_usd,
        slippage_bps=req.slippage_bps,
        latency_ms=req.latency_ms,
        fee_rate=req.fee_rate,
    )
    db.close()
    return {
        "status": "added",
        "wallet": target.wallet,
        "mode": target.mode.value,
        "trade_pct": target.trade_pct,
        "max_position_usd": target.max_position_usd,
        "slippage_bps": target.slippage_bps,
        "latency_ms": target.latency_ms,
        "fee_rate": target.fee_rate,
    }


@app.post("/api/copy/remove")
def copy_remove(req: AddTargetRequest):
    db = _db()
    copier = CopyTrader(db, config)
    copier.remove_target(req.wallet)
    db.close()
    return {"status": "removed", "wallet": req.wallet}


@app.post("/api/copy/reactivate")
def copy_reactivate(req: AddTargetRequest):
    db = _db()
    copier = CopyTrader(db, config)
    target = copier.reactivate_target(req.wallet)
    db.close()
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")
    return {"status": "reactivated", "wallet": target.wallet}


class SetModeRequest(PydanticBaseModel):
    wallet: str
    mode: str  # "paper" or "real"


@app.post("/api/copy/set-mode")
def copy_set_mode(req: SetModeRequest):
    if req.mode not in ("paper", "real"):
        raise HTTPException(status_code=400, detail="Mode must be 'paper' or 'real'")
    db = _db()
    copier = CopyTrader(db, config)
    target = copier.set_mode(req.wallet, CopyMode(req.mode))
    db.close()
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")
    return {"status": "ok", "wallet": target.wallet, "mode": target.mode.value}


@app.get("/api/copy/targets")
def copy_targets():
    db = _db()
    tracker = ProfitabilityTracker(db)
    targets = db.get_copy_targets(active_only=False)

    # Fetch usernames for all target wallets in parallel
    wallets = [t.wallet for t in targets]
    profits = tracker.fetch_wallets_profit(wallets) if wallets else {}

    result = []
    for t in targets:
        stats = _slippage_tracker.get_stats(t.wallet)
        pnl = db.compute_copy_pnl(t.wallet)
        paper_pnl = pnl["realized_pnl"] - pnl["total_fees"]

        # Trade count and listening duration from local copy trades
        local_trades = db.get_copy_trades(source_wallet=t.wallet, limit=10000)
        filled = [ct for ct in local_trades if ct.status == "filled"]
        trade_count = len(filled)
        listening_hours = 0.0
        if trade_count >= 2:
            ts_sorted = sorted(ct.timestamp for ct in filled)
            listening_hours = (ts_sorted[-1] - ts_sorted[0]).total_seconds() / 3600

        result.append(
            {
                "wallet": t.wallet,
                "username": profits.get(t.wallet, {}).get("username", ""),
                "mode": t.mode.value,
                "trade_pct": t.trade_pct,
                "max_position_usd": t.max_position_usd,
                "active": t.active,
                "total_paper_pnl": paper_pnl,
                "total_real_pnl": t.total_real_pnl,
                "slippage_bps": t.slippage_bps,
                "latency_ms": t.latency_ms,
                "fee_rate": t.fee_rate,
                "measured_slippage_bps": stats.avg_slippage_bps
                if stats
                else t.measured_slippage_bps,
                "measured_latency_ms": stats.avg_latency_ms if stats else -1,
                "observations": stats.observation_count if stats else 0,
                "avg_hold_time_hours": pnl["avg_hold_time_hours"],
                "trade_count": trade_count,
                "listening_hours": round(listening_hours, 1),
            }
        )
    db.close()
    return result


@app.get("/api/copy/detail/{wallet}")
def copy_detail(wallet: str, source: str = Query("local")):
    """Detailed breakdown of a copy target: positions, P&L series, missed positions."""
    from collections import defaultdict
    from datetime import datetime

    db = _db()
    tracker = ProfitabilityTracker(db)

    # 1. Fetch all filled copy trades for this wallet, chronological
    if source == "cloud":
        try:
            resp = http_requests.get(f"{_cf_url()}/trades?limit=10000", timeout=15)
            cloud_all = resp.json() if resp.ok else []
        except Exception:
            cloud_all = []
        # Filter to this wallet's filled trades and convert to CopyTrade objects
        from polybot.models import CopyMode as CM
        from polybot.models import CopyTrade as CopyTradeModel
        from polybot.models import TradeSide as TS

        filled = []
        for ct in cloud_all:
            if ct.get("source_wallet") != wallet or ct.get("status") != "filled":
                continue
            try:
                ts_str = ct.get("timestamp", "")
                ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                filled.append(
                    CopyTradeModel(
                        id=ct.get("id", ""),
                        source_trade_id=ct.get("source_trade_id", ""),
                        source_wallet=wallet,
                        market=ct.get("market", ""),
                        asset_id=ct.get("asset_id", ""),
                        side=TS(ct.get("side", "BUY")),
                        price=ct.get("price", 0),
                        size=ct.get("size", 0),
                        mode=CM(ct.get("mode", "paper")),
                        timestamp=ts,
                        status="filled",
                        pnl=ct.get("pnl", 0),
                        source_price=ct.get("source_price", 0),
                        exec_price=ct.get("exec_price", 0),
                        fee_amount=ct.get("fee_amount", 0),
                    )
                )
            except Exception:
                continue
        filled.sort(key=lambda t: t.timestamp)
    else:
        trades = db.get_copy_trades(source_wallet=wallet, limit=10000)
        filled = [t for t in trades if t.status == "filled"]
        filled.sort(key=lambda t: t.timestamp)

    # 2. Build conditionId -> title map from remote positions
    remote_positions = tracker.fetch_remote_positions(wallet)
    title_map: dict[str, str] = {}
    for p in remote_positions:
        cid = p.get("conditionId", "")
        title = p.get("title", "")
        if cid and title:
            title_map[cid] = title

    # 3. FIFO position reconstruction (extends db.compute_copy_pnl pattern)
    # positions[asset_id] = list of [remaining_size, entry_price, entry_timestamp]
    lots: dict[str, list[list]] = defaultdict(list)
    asset_to_market: dict[str, str] = {}
    closed_positions: list[dict] = []
    per_closed_pnls: list[float] = []
    total_fees = 0.0
    total_slippage_cost = 0.0
    running_pnl = 0.0
    pnl_series: list[dict] = []

    for t in filled:
        asset_to_market[t.asset_id] = t.market
        total_fees += t.fee_amount
        if t.source_price > 0 and t.exec_price > 0:
            total_slippage_cost += abs(t.exec_price - t.source_price) * t.size

        if t.side.value == "BUY":
            lots[t.asset_id].append(
                [t.size, t.exec_price or t.price, t.timestamp.isoformat()]
            )
        else:
            remaining = t.size
            sell_price = t.exec_price or t.price
            while remaining > 1e-9 and lots[t.asset_id]:
                lot = lots[t.asset_id][0]
                match_qty = min(remaining, lot[0])
                pnl = (sell_price - lot[1]) * match_qty
                per_closed_pnls.append(pnl)
                running_pnl += pnl - (
                    t.fee_amount * match_qty / t.size if t.size > 0 else 0
                )

                try:
                    hold_s = (
                        t.timestamp - datetime.fromisoformat(lot[2])
                    ).total_seconds()
                except (ValueError, TypeError):
                    hold_s = 0

                closed_positions.append(
                    {
                        "market": t.market,
                        "title": title_map.get(t.market, t.market[:10] + "..."),
                        "asset_id": t.asset_id,
                        "size": match_qty,
                        "entry_price": lot[1],
                        "exit_price": sell_price,
                        "realized_pnl": pnl,
                        "hold_time_hours": hold_s / 3600,
                        "closed_at": t.timestamp.isoformat(),
                    }
                )

                lot[0] -= match_qty
                remaining -= match_qty
                if lot[0] <= 1e-9:
                    lots[t.asset_id].pop(0)

        # Emit P&L series point after each trade
        pnl_series.append({"t": t.timestamp.isoformat(), "pnl": round(running_pnl, 4)})

    # 4. Open positions — unmatched BUY lots with current prices
    open_asset_ids = [aid for aid, l in lots.items() if any(lot[0] > 1e-9 for lot in l)]
    current_prices = (
        tracker._fetch_current_prices(open_asset_ids) if open_asset_ids else {}
    )

    open_positions: list[dict] = []
    total_unrealized = 0.0
    for asset_id, lot_list in lots.items():
        for lot in lot_list:
            if lot[0] <= 1e-9:
                continue
            cur_price = current_prices.get(asset_id, lot[1])
            unrealized = (cur_price - lot[1]) * lot[0]
            total_unrealized += unrealized
            market = asset_to_market.get(asset_id, "")
            open_positions.append(
                {
                    "market": market,
                    "title": title_map.get(market, market[:10] + "..."),
                    "asset_id": asset_id,
                    "size": lot[0],
                    "entry_price": lot[1],
                    "current_price": cur_price,
                    "unrealized_pnl": unrealized,
                    "entry_time": lot[2],
                }
            )

    # 5. Summary stats
    wins = sum(1 for p in per_closed_pnls if p > 0.001)
    losses = sum(1 for p in per_closed_pnls if p < -0.001)
    rated = wins + losses

    summary = {
        "total_trades": len(filled),
        "wins": wins,
        "losses": losses,
        "win_rate": wins / rated if rated else 0.0,
        "total_realized_pnl": sum(per_closed_pnls),
        "total_unrealized_pnl": total_unrealized,
        "total_fees": total_fees,
        "total_slippage_cost": total_slippage_cost,
        "best_trade_pnl": max(per_closed_pnls) if per_closed_pnls else 0.0,
        "worst_trade_pnl": min(per_closed_pnls) if per_closed_pnls else 0.0,
    }

    # 6. Missed positions — target's real positions we don't have copy trades for
    copied_markets = {t.market for t in filled}
    missed: list[dict] = []
    for p in remote_positions:
        cid = p.get("conditionId", "")
        if cid and cid not in copied_markets and float(p.get("size", 0)) > 0.01:
            missed.append(
                {
                    "title": p.get("title", ""),
                    "outcome": p.get("outcome", ""),
                    "size": float(p.get("size", 0)),
                    "current_value": float(p.get("currentValue", 0)),
                    "cash_pnl": float(p.get("cashPnl", 0)),
                    "percent_pnl": float(p.get("percentPnl", 0)),
                }
            )

    db.close()
    return {
        "summary": summary,
        "pnl_series": pnl_series,
        "open_positions": open_positions,
        "closed_positions": closed_positions,
        "missed_positions": missed,
    }


@app.get("/api/copy/trades")
def copy_trades(wallet: str = Query(""), limit: int = Query(200, ge=1, le=1000)):
    db = _db()
    trades = db.get_copy_trades(source_wallet=wallet or None, limit=limit)
    db.close()
    return [
        {
            "id": ct.id,
            "source_trade_id": ct.source_trade_id,
            "source_wallet": ct.source_wallet,
            "market": ct.market,
            "asset_id": ct.asset_id,
            "side": ct.side.value,
            "price": ct.price,
            "size": ct.size,
            "mode": ct.mode.value,
            "timestamp": ct.timestamp.isoformat(),
            "status": ct.status,
            "pnl": ct.pnl,
            "source_price": ct.source_price,
            "exec_price": ct.exec_price,
            "fee_amount": ct.fee_amount,
        }
        for ct in trades
    ]
