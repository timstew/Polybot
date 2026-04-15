# Real Mode Postmortem — April 15, 2026

## Financial Summary

- **Deposited**: $821 ($95 swap + $726 exchange)
- **Final recoverable**: ~$327
- **Total loss**: ~$494
- **Cause**: Software bugs in order lifecycle management, not strategy logic

## Timeline of Losses

| Run | Config | Bug | Money Lost |
|-----|--------|-----|-----------|
| Run 1 | $730 (should have been $50) | Budget used full wallet instead of config | ~$150 |
| Run 2 | $50 | Order status returned ERROR (string parsing), runaway orders | ~$120 |
| Run 3 | $50 | Same bug, more orders before stopped | ~$100 |
| Run 4 | $50 | 22 windows at 32% win rate, legitimate trading losses | ~$25 |
| Run 5 | $500 | Fill detection lost $790 in untracked orders | ~$100 net |

## Root Causes

### 1. `get_order()` String Parsing (Found and fixed)
The `py_clob_client` library returns strings instead of dicts in some cases. `associate_trades` entries are strings. This caused `getOrderStatus()` to always return ERROR, so fills were never detected.

### 2. Fill Detection Architecture (Fundamental flaw)
Order lifecycle relies on polling `getOrderStatus()` every tick. Six failure modes:

1. **Immediate fill misclassified as "placed"**: `get_order()` after `post_order()` can fail (race condition), returning "placed" for a filled order
2. **`hasUnreconciledOrders` blocks all windows**: Single boolean flag on the strategy gates ALL order placement across ALL windows
3. **Window removal destroys order slots**: When a window resolves, its order tracking is deleted. Unfilled-but-tracked orders become orphans.
4. **Cancel-fill race in safeCancelOrder**: Cancel fails because order filled, but the fill detection also fails
5. **Partial fills invisible**: Code only checks for "MATCHED", not partial fills
6. **Compounding**: One API failure cascades — blocks orders, then window expires, then orphan, then flag resets, then new orders placed without knowing about old fills

### 3. No User WebSocket for Fill Notifications
The CLOB has a WebSocket endpoint (`wss://ws-subscriptions-clob.polymarket.com/ws/user`) that delivers fill events in real-time. We never used it. Instead, we polled REST endpoints every tick, creating timing races.

### 4. Ephemeral Order State
Order IDs stored in memory on window objects. Not persisted to D1. Restart loses everything. Cancel-all-on-init is a workaround that can't recover fills.

## The Solution

### User WebSocket (from poly-maker, 1,054 stars)
```
wss://ws-subscriptions-clob.polymarket.com/ws/user
Auth: {type: "user", auth: {apiKey, secret, passphrase}}
Events: MATCHED → MINED → CONFIRMED/FAILED
```

Fill notifications arrive in real-time. No polling needed. The `warproxxx/poly-maker` repo has a complete working implementation.

### Durable Order Ledger
Every order persisted to D1 immediately on placement. Survives restarts. Never destroyed when windows resolve. Reconciliation runs globally, not per-window.

### Activity-Based Fallback
Every 30s, cross-reference `getActivity()` against the order ledger. Catches anything the WebSocket missed.

### Startup Recovery
On init: query open orders + recent activity. Cross-reference with ledger. Cancel orphans, record missed fills.

## Key Libraries Found

| Library | Stars | Language | Key Feature |
|---------|-------|----------|-------------|
| `warproxxx/poly-maker` | 1,054 | Python | **User WebSocket fill detection** — the reference implementation |
| `Polymarket/poly-market-maker` | 277 | Python | Official MM — poll-and-diff every 30s, no WebSocket |
| `Polymarket/rs-clob-client` | 653 | Rust | Official client with `ws` feature flag for user events |
| `pmxt-dev/pmxt` | 1,504 | TS+Python | Unified cross-platform prediction market API |

## Lessons Learned

1. **Never store order state only in memory** — the CLOB is the source of truth, not our in-memory strategy
2. **Use WebSocket for fills, not polling** — polling creates timing races that are impossible to eliminate
3. **Test real mode with $1 orders first** — the $0.99×5 lifecycle test caught the string parsing bug
4. **Silent error swallowing is the #1 real-money risk** — every catch block must log and surface errors
5. **Paper mode can't validate real mode** — the fill mechanism is completely different
6. **The tick system is wrong for order management** — events (fills, book changes) should drive the system, not a timer
