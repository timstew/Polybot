/**
 * Synced clock — all internal timing uses CLOB server time.
 *
 * On startup, fetches CLOB server time and computes offset vs local clock.
 * Re-syncs periodically (every 5 min). All code should use clock.now()
 * instead of Date.now().
 *
 * Timezone note: both CLOB and Date.now() return UTC epoch milliseconds.
 * Timezones (Vancouver, NYC, etc.) only affect human-readable display,
 * not the epoch values used for trading logic.
 */

const CLOB_TIME_URL = "https://clob.polymarket.com/time";
const RESYNC_INTERVAL_MS = 5 * 60 * 1000; // re-sync every 5 min

let offsetMs = 0;       // serverTime - localTime (positive = we're behind server)
let lastSyncAt = 0;
let synced = false;

/** Current time in UTC epoch milliseconds, synced to CLOB server. */
export function now(): number {
  return Date.now() + offsetMs;
}

/** Sync with CLOB server. Call once at startup, then periodically. */
export async function syncClock(): Promise<{ offsetMs: number; driftMs: number }> {
  try {
    const beforeMs = Date.now();
    const resp = await fetch(CLOB_TIME_URL);
    const afterMs = Date.now();
    const serverTimeSec = await resp.json() as number;

    // Account for network roundtrip: assume server timestamp is from midpoint
    const roundtripMs = afterMs - beforeMs;
    const localMidpointMs = beforeMs + roundtripMs / 2;
    const serverTimeMs = serverTimeSec * 1000;

    const newOffset = serverTimeMs - localMidpointMs;
    const drift = Math.abs(newOffset - offsetMs);

    offsetMs = newOffset;
    lastSyncAt = Date.now();
    synced = true;

    if (Math.abs(offsetMs) > 100) {
      console.log(`[CLOCK] Synced: offset=${offsetMs.toFixed(0)}ms (${offsetMs > 0 ? "behind" : "ahead"} server by ${Math.abs(offsetMs).toFixed(0)}ms, roundtrip=${roundtripMs}ms)`);
    }

    return { offsetMs, driftMs: drift };
  } catch (err) {
    console.warn("[CLOCK] Sync failed:", err);
    return { offsetMs, driftMs: 0 };
  }
}

/** Start periodic re-sync. */
export function startClockSync(): void {
  syncClock(); // initial sync
  setInterval(() => syncClock(), RESYNC_INTERVAL_MS);
}

/** Whether we've successfully synced at least once. */
export function isSynced(): boolean {
  return synced;
}

/** Current offset in ms (for diagnostics). */
export function getOffset(): number {
  return offsetMs;
}
