/**
 * Goldsky Subgraph Client — orderFilledEvents from the Polymarket CTF.
 *
 * The Polymarket orderbook contract emits an event on every fill. Goldsky
 * indexes these via a public subgraph. This module queries that subgraph via
 * GraphQL with the sticky-cursor pattern (ported from warproxxx/poly_data).
 *
 * Public endpoint — no auth required. Schema (subset we use):
 *   orderFilledEvents {
 *     id, timestamp, maker, makerAssetId, makerAmountFilled,
 *     taker, takerAssetId, takerAmountFilled, fee, orderHash, transactionHash
 *   }
 *
 * Sticky-cursor: when a batch is full and all events share a timestamp, we
 * paginate by id at that timestamp (`timestamp: X, id_gt: Y`) until the
 * timestamp is exhausted. Otherwise we advance `timestamp_gt: X`. This avoids
 * losing events when many fills share the same timestamp (common at boundaries).
 */

export const GOLDSKY_URL =
  "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn";

export interface GoldskyEvent {
  id: string;
  timestamp: string;          // GraphQL returns these as strings
  maker: string;
  makerAssetId: string;
  makerAmountFilled: string;
  taker: string;
  takerAssetId: string;
  takerAmountFilled: string;
  fee: string | null;
  orderHash: string | null;
  transactionHash: string | null;
}

export interface CursorState {
  lastTimestamp: number;
  lastId: string | null;
  stickyTimestamp: number | null;
}

export interface FetchOptions {
  makerEq?: string;           // filter by maker address (lowercase)
  takerEq?: string;           // filter by taker address (lowercase)
  first?: number;             // batch size (max 1000)
}

/** Build a where-clause from cursor + filters. */
export function buildWhereClause(cursor: CursorState, opts: FetchOptions): string {
  const parts: string[] = [];

  if (cursor.stickyTimestamp != null) {
    parts.push(`timestamp: "${cursor.stickyTimestamp}"`);
    if (cursor.lastId) parts.push(`id_gt: "${cursor.lastId}"`);
  } else {
    parts.push(`timestamp_gt: "${cursor.lastTimestamp}"`);
  }
  if (opts.makerEq) parts.push(`maker: "${opts.makerEq.toLowerCase()}"`);
  if (opts.takerEq) parts.push(`taker: "${opts.takerEq.toLowerCase()}"`);

  return parts.join(", ");
}

/** One GraphQL request. Returns events in ascending (timestamp, id) order. */
export async function fetchOrderFilledEvents(
  cursor: CursorState,
  opts: FetchOptions,
): Promise<GoldskyEvent[]> {
  const first = Math.min(1000, Math.max(1, opts.first ?? 1000));
  const where = buildWhereClause(cursor, opts);

  const query = `query {
    orderFilledEvents(
      orderBy: timestamp,
      orderDirection: asc,
      first: ${first},
      where: { ${where} }
    ) {
      id timestamp maker makerAssetId makerAmountFilled
      taker takerAssetId takerAmountFilled
      fee orderHash transactionHash
    }
  }`;

  const resp = await fetch(GOLDSKY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!resp.ok) throw new Error(`Goldsky HTTP ${resp.status}`);
  const body = await resp.json() as { data?: { orderFilledEvents?: GoldskyEvent[] }; errors?: unknown };
  if (body.errors) throw new Error(`Goldsky GraphQL error: ${JSON.stringify(body.errors)}`);
  return body.data?.orderFilledEvents ?? [];
}

/**
 * Advance the cursor after a batch.
 *
 * Rules:
 *   - Empty batch while sticky → clear sticky, advance past sticky timestamp
 *   - Empty batch without sticky → done (return same cursor + done=true)
 *   - Full batch, all same timestamp → enter sticky at that timestamp
 *   - Full batch, mixed timestamps → sticky on the last timestamp (some events
 *     at that boundary timestamp may still be pending)
 *   - Partial batch while sticky → exhausted that timestamp, advance
 *   - Partial batch without sticky → exhausted everything, done
 */
export function advanceCursor(
  cursor: CursorState,
  events: GoldskyEvent[],
  batchSize: number,
): { next: CursorState; done: boolean } {
  if (events.length === 0) {
    if (cursor.stickyTimestamp != null) {
      return {
        next: { lastTimestamp: cursor.stickyTimestamp, lastId: null, stickyTimestamp: null },
        done: false,
      };
    }
    return { next: cursor, done: true };
  }

  const first = Number(events[0].timestamp);
  const last = Number(events[events.length - 1].timestamp);
  const lastId = events[events.length - 1].id;

  if (events.length >= batchSize) {
    // Full batch — stay sticky at the last timestamp (even if mixed)
    return {
      next: { lastTimestamp: cursor.lastTimestamp, lastId, stickyTimestamp: last },
      done: false,
    };
  }

  // Partial batch
  if (cursor.stickyTimestamp != null) {
    // Exhausted sticky timestamp — advance past it
    return {
      next: { lastTimestamp: cursor.stickyTimestamp, lastId: null, stickyTimestamp: null },
      done: false, // give one more query a chance in case batch was partial due to equality edge
    };
  }

  // Partial batch, not sticky — we may still need another query if more events
  // landed since; but from the data we have, we've consumed up to `last`.
  return {
    next: { lastTimestamp: last, lastId: null, stickyTimestamp: null },
    done: events.length === 0,
  };
}

/** Utility: zero cursor for a fresh start. */
export function emptyCursor(): CursorState {
  return { lastTimestamp: 0, lastId: null, stickyTimestamp: null };
}
