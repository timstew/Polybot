#!/usr/bin/env python3
"""Check if previous tick's bid state matches fill events."""
import sqlite3, json, sys

db = sqlite3.connect(sys.argv[1])
rows = db.execute(
    "SELECT id, crypto_symbol, ticks FROM strategy_snapshots "
    "WHERE outcome IS NOT NULL AND outcome != 'UNKNOWN' "
    "ORDER BY window_open_time"
).fetchall()

total = 0
prev_match = 0
prev_no_bid = 0
prev_price_low = 0
no_prev_tick = 0

for r in rows:
    ticks = json.loads(r[2])
    for i, t in enumerate(ticks):
        fills = t.get('fills', [])
        if not fills:
            continue
        prev = ticks[i - 1] if i > 0 else None
        for f in fills:
            total += 1
            side = f['side']
            if prev is None:
                no_prev_tick += 1
                continue
            prevBid = prev['upBidPrice'] if side == 'UP' else prev['downBidPrice']
            prevSize = prev['upBidSize'] if side == 'UP' else prev['downBidSize']
            if prevSize <= 0:
                prev_no_bid += 1
            elif prevBid < f['price']:
                prev_price_low += 1
            else:
                prev_match += 1

print(f"Total recorded fills: {total}")
print(f"Previous tick bid matches:  {prev_match} ({prev_match/total*100:.1f}%)")
print(f"Previous tick no bid:       {prev_no_bid} ({prev_no_bid/total*100:.1f}%)")
print(f"Previous tick price too low: {prev_price_low} ({prev_price_low/total*100:.1f}%)")
print(f"No previous tick (first):   {no_prev_tick} ({no_prev_tick/total*100:.1f}%)")
db.close()
