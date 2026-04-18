/**
 * Goldsky Backfill — pulls orderFilledEvents for configured wallets into the
 * `goldsky_trades` table. Each (wallet, role) pair has its own persistent
 * cursor so resumes are cheap.
 *
 * Runs as:
 *   - Cron inside the engine (scheduled from engine.ts)
 *   - CLI: `bun src/analysis/goldsky-backfill.ts [--wallet=0x…] [--once]`
 *
 * Wallets come from the `goldsky_wallets` config (comma-separated addresses).
 */

import { getDb, getConfig, logActivity } from "../db.js";
import {
  fetchOrderFilledEvents,
  advanceCursor,
  emptyCursor,
  type CursorState,
  type GoldskyEvent,
} from "../feeds/goldsky-feed.js";

type Role = "maker" | "taker";

export interface BackfillResult {
  wallet: string;
  role: Role;
  fetched: number;
  inserted: number;
  elapsedMs: number;
  reachedEnd: boolean;
}

/** Swappable for tests — default is the real Goldsky endpoint. */
let fetcher: typeof fetchOrderFilledEvents = fetchOrderFilledEvents;

export function setGoldskyFetcher(fn: typeof fetchOrderFilledEvents): void {
  fetcher = fn;
}

export function resetGoldskyFetcher(): void {
  fetcher = fetchOrderFilledEvents;
}

function loadCursor(wallet: string, role: Role): CursorState {
  const row = getDb().prepare(
    "SELECT last_timestamp, last_id, sticky_timestamp FROM goldsky_cursor WHERE wallet = ? AND role = ?"
  ).get(wallet, role) as { last_timestamp: number; last_id: string | null; sticky_timestamp: number | null } | undefined;
  if (!row) return emptyCursor();
  return {
    lastTimestamp: row.last_timestamp,
    lastId: row.last_id,
    stickyTimestamp: row.sticky_timestamp,
  };
}

function saveCursor(wallet: string, role: Role, c: CursorState): void {
  getDb().prepare(`
    INSERT INTO goldsky_cursor (wallet, role, last_timestamp, last_id, sticky_timestamp, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(wallet, role) DO UPDATE SET
      last_timestamp = excluded.last_timestamp,
      last_id = excluded.last_id,
      sticky_timestamp = excluded.sticky_timestamp,
      updated_at = datetime('now')
  `).run(wallet, role, c.lastTimestamp, c.lastId, c.stickyTimestamp);
}

function insertEvents(wallet: string, role: Role, events: GoldskyEvent[]): number {
  if (events.length === 0) return 0;
  const insert = getDb().prepare(`
    INSERT OR IGNORE INTO goldsky_trades (
      id, timestamp, maker, maker_asset_id, maker_amount_filled,
      taker, taker_asset_id, taker_amount_filled,
      fee, order_hash, transaction_hash, tracked_wallet, role
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = getDb().transaction((rows: GoldskyEvent[]) => {
    let n = 0;
    for (const e of rows) {
      const info = insert.run(
        e.id,
        Number(e.timestamp),
        e.maker.toLowerCase(),
        e.makerAssetId,
        e.makerAmountFilled,
        e.taker.toLowerCase(),
        e.takerAssetId,
        e.takerAmountFilled,
        e.fee,
        e.orderHash,
        e.transactionHash,
        wallet,
        role,
      );
      n += info.changes;
    }
    return n;
  });
  return tx(events);
}

/** Backfill one (wallet, role). Runs until the subgraph says done or maxBatches. */
export async function backfillWalletRole(
  wallet: string,
  role: Role,
  maxBatches = 50,
): Promise<BackfillResult> {
  const start = Date.now();
  const addr = wallet.toLowerCase();
  let cursor = loadCursor(addr, role);
  let fetched = 0;
  let inserted = 0;
  let reachedEnd = false;

  for (let i = 0; i < maxBatches; i++) {
    const events = await fetcher(cursor, role === "maker" ? { makerEq: addr } : { takerEq: addr });
    fetched += events.length;
    inserted += insertEvents(addr, role, events);

    const { next, done } = advanceCursor(cursor, events, 1000);
    cursor = next;
    saveCursor(addr, role, cursor);
    if (done) { reachedEnd = true; break; }
  }

  return {
    wallet: addr, role, fetched, inserted,
    elapsedMs: Date.now() - start, reachedEnd,
  };
}

/** Backfill all configured wallets (both roles). */
export async function backfillAll(maxBatchesPerWallet = 50): Promise<BackfillResult[]> {
  const walletsRaw = getConfig("goldsky_wallets", "") || "";
  const wallets = walletsRaw.split(",").map(w => w.trim()).filter(Boolean);
  if (wallets.length === 0) return [];

  const results: BackfillResult[] = [];
  for (const wallet of wallets) {
    for (const role of ["maker", "taker"] as Role[]) {
      try {
        const r = await backfillWalletRole(wallet, role, maxBatchesPerWallet);
        results.push(r);
        if (r.inserted > 0) {
          logActivity("GOLDSKY_BACKFILL",
            `${wallet.slice(0, 10)}… ${role}: +${r.inserted} events (${r.fetched} fetched) in ${r.elapsedMs}ms`,
            { level: "info" });
        }
      } catch (err) {
        logActivity("GOLDSKY_ERROR", `${wallet.slice(0, 10)}… ${role}: ${String(err).slice(0, 120)}`, { level: "warning" });
      }
    }
  }
  return results;
}

// ── CLI ───────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2);
  const walletArg = args.find(a => a.startsWith("--wallet="))?.slice(9);
  const once = args.includes("--once");
  const maxBatches = parseInt(args.find(a => a.startsWith("--max-batches="))?.slice(14) || "200");

  const { initDb } = await import("../db.js");
  initDb();

  if (walletArg) {
    for (const role of ["maker", "taker"] as Role[]) {
      const r = await backfillWalletRole(walletArg, role, maxBatches);
      console.log(`[${role}] ${r.wallet}: +${r.inserted} (${r.fetched} fetched) in ${r.elapsedMs}ms, done=${r.reachedEnd}`);
    }
  } else {
    const results = await backfillAll(maxBatches);
    for (const r of results) {
      console.log(`[${r.role}] ${r.wallet}: +${r.inserted} (${r.fetched} fetched) in ${r.elapsedMs}ms, done=${r.reachedEnd}`);
    }
  }

  if (!once) {
    const interval = parseInt(getConfig("goldsky_interval_ms", "300000") || "300000");
    console.log(`[GOLDSKY] Running on ${interval}ms interval (ctrl-c to stop)`);
    setInterval(async () => {
      const results = await backfillAll(20);
      const total = results.reduce((s, r) => s + r.inserted, 0);
      if (total > 0) console.log(`[GOLDSKY] +${total} events across ${results.length} (wallet, role) pairs`);
    }, interval);
  }
}
