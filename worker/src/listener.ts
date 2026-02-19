import { DEFAULT_FEE_RATE, marketHasFees } from "./categories";
import type { CopyTarget, CopyTrade, DataApiTrade } from "./types";

const DATA_API = "https://data-api.polymarket.com";

// ── Polymarket Data API ────────────────────────────────────────────

const RELEVANT_TYPES = new Set(["TRADE", "CONVERSION", "REDEEM"]);

export async function fetchWalletActivity(
  wallet: string,
  limit = 50,
): Promise<DataApiTrade[]> {
  const url = `${DATA_API}/activity?user=${wallet}&limit=${limit}&_t=${Date.now()}`;
  const resp = await fetch(url);
  if (!resp.ok) return [];
  const items: unknown[] = await resp.json();
  return items
    .filter((item) => {
      if (!item || typeof item !== "object") return false;
      const t = (item as Record<string, unknown>).type;
      return typeof t === "string" && RELEVANT_TYPES.has(t);
    })
    .map(parseActivityItem)
    .filter(Boolean) as DataApiTrade[];
}

function parseActivityItem(item: unknown): DataApiTrade | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  const id = String(r.transactionHash ?? r.id ?? "");
  if (!id) return null;

  let ts = Number(r.timestamp ?? r.createdAt ?? 0);
  // If timestamp looks like seconds (< year 2100 in s), convert to ms
  if (ts > 0 && ts < 4_102_444_800) ts *= 1000;

  const activityType = String(r.type ?? "TRADE") as
    | "TRADE"
    | "CONVERSION"
    | "REDEEM";
  const size = Number(r.size ?? 0);
  const usdcSize = Number(r.usdcSize ?? 0);

  // For CONVERSION/REDEEM: side is always SELL (position exit)
  // For TRADE: use the reported side
  let side: "BUY" | "SELL";
  if (activityType === "CONVERSION" || activityType === "REDEEM") {
    side = "SELL";
  } else {
    side = String(r.side ?? "BUY").toUpperCase() as "BUY" | "SELL";
  }

  // For CONVERSION: effective price = usdcSize / size (typically 1.0 for winners)
  // For REDEEM with size=0: price = 0 (losing outcome)
  // For TRADE: use reported price
  let price: number;
  if (activityType === "CONVERSION" || activityType === "REDEEM") {
    price = size > 0 ? usdcSize / size : 0;
  } else {
    price = Number(r.price ?? 0);
  }

  return {
    id,
    market: String(r.conditionId ?? r.market ?? ""),
    asset_id: String(r.asset ?? r.asset_id ?? ""),
    side,
    price,
    size,
    timestamp: ts,
    taker: String(r.proxyWallet ?? r.taker ?? ""),
    maker: String(r.maker ?? ""),
    title: String(r.title ?? ""),
    outcome: String(r.outcome ?? ""),
    activity_type: activityType,
    usdcSize,
  };
}

// ── Copy trade calculation ─────────────────────────────────────────

export function calculateCopyTrade(
  trade: DataApiTrade,
  target: CopyTarget,
): CopyTrade | null {
  // Determine effective slippage
  const slippageBps =
    target.measured_slippage_bps > 0
      ? target.measured_slippage_bps
      : target.slippage_bps;

  const slipMult = slippageBps / 10_000;
  let execPrice: number;
  if (trade.side === "BUY") {
    execPrice = Math.min(trade.price * (1 + slipMult), 0.99);
  } else {
    execPrice = Math.max(trade.price * (1 - slipMult), 0.01);
  }

  // Fee rate
  let feeRate = target.fee_rate;
  if (feeRate === 0 && marketHasFees(trade.title)) {
    feeRate = DEFAULT_FEE_RATE;
  }
  const feePerShare = execPrice * (1 - execPrice) * feeRate;

  // Copy size — paper mode uses 100% of source, real mode uses configured %
  // If full_copy_below_usd is set and source trade is below that threshold,
  // copy at 100% regardless of trade_pct (small trades aren't worth scaling down)
  const sourceNotional = trade.price * trade.size;
  const fullCopyBelow = target.full_copy_below_usd ?? 0;
  let copyNotional: number;
  if (target.mode === "paper") {
    copyNotional = sourceNotional;
  } else if (fullCopyBelow > 0 && sourceNotional <= fullCopyBelow) {
    copyNotional = sourceNotional;
  } else {
    copyNotional = sourceNotional * (target.trade_pct / 100);
  }
  // Only apply max position cap for real trades
  if (target.mode !== "paper") {
    copyNotional = Math.min(copyNotional, target.max_position_usd);
  }
  if (copyNotional < 0.01) return null;

  const costPerShare = execPrice + feePerShare;
  const copySize = costPerShare > 0 ? copyNotional / costPerShare : 0;
  if (copySize <= 0) return null;

  const feeAmount = feePerShare * copySize;

  return {
    id: crypto.randomUUID(),
    source_trade_id: trade.id,
    source_wallet: target.wallet,
    market: trade.market,
    asset_id: trade.asset_id,
    side: trade.side,
    price: execPrice,
    size: copySize,
    mode: target.mode,
    timestamp: new Date().toISOString(),
    status: "filled",
    pnl: 0,
    source_price: trade.price,
    exec_price: execPrice,
    fee_amount: feeAmount,
    title: trade.title || "",
  };
}

// ── Poll cycle ─────────────────────────────────────────────────────

async function executeRealTrade(
  pythonApiUrl: string,
  copy: CopyTrade,
): Promise<{
  status: string;
  order_id?: string;
  error?: string;
  filled_size?: number;
  filled_notional?: number;
}> {
  try {
    const resp = await fetch(`${pythonApiUrl}/api/copy/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        asset_id: copy.asset_id,
        side: copy.side,
        size: copy.size,
        price: copy.exec_price,
        source_wallet: copy.source_wallet,
        market: copy.market,
      }),
    });
    if (!resp.ok) {
      return { status: "failed", error: `HTTP ${resp.status}` };
    }
    return (await resp.json()) as {
      status: string;
      order_id?: string;
      error?: string;
    };
  } catch (e) {
    return { status: "failed", error: String(e) };
  }
}

async function insertCopyTrade(db: D1Database, copy: CopyTrade): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO copy_trades
       (id, source_trade_id, source_wallet, market, asset_id,
        side, price, size, mode, timestamp, status, pnl,
        source_price, exec_price, fee_amount, title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      copy.id,
      copy.source_trade_id,
      copy.source_wallet,
      copy.market,
      copy.asset_id,
      copy.side,
      copy.price,
      copy.size,
      copy.mode,
      copy.timestamp,
      copy.status,
      copy.pnl,
      copy.source_price,
      copy.exec_price,
      copy.fee_amount,
      copy.title,
    )
    .run();
}

/**
 * Handle a CONVERSION or REDEEM event by closing open copy positions.
 *
 * CONVERSIONs have no `asset` field, so we look up the asset_id from
 * our existing BUY copy trades on the same market (conditionId).
 * The exit price is usdcSize/size (1.0 for winners, 0 for losers).
 *
 * We compute how many shares we still hold (BUY total - SELL total)
 * and create a SELL copy trade for the remaining open position,
 * scaled by the target's trade_pct ratio.
 */
async function handlePositionExit(
  db: D1Database,
  event: DataApiTrade,
  target: CopyTarget,
  pendingSells: Map<string, number>,
): Promise<number> {
  // Skip zero-size redeems (losing outcomes with no value)
  if (event.size <= 0 && event.usdcSize <= 0) {
    // Look up if we have open BUY positions on this market — close them at $0
    const { results: openBuys } = await db
      .prepare(
        `SELECT asset_id, SUM(CASE WHEN side='BUY' THEN size ELSE 0 END) as buy_total,
                SUM(CASE WHEN side='SELL' THEN size ELSE 0 END) as sell_total
         FROM copy_trades
         WHERE source_wallet = ? AND market = ? AND status = 'filled'
         GROUP BY asset_id
         HAVING buy_total > sell_total`,
      )
      .bind(target.wallet, event.market)
      .all<{ asset_id: string; buy_total: number; sell_total: number }>();

    if (!openBuys || openBuys.length === 0) return 0;

    let count = 0;
    for (const pos of openBuys) {
      const alreadyPending = pendingSells.get(pos.asset_id) ?? 0;
      const remainingSize = pos.buy_total - pos.sell_total - alreadyPending;
      if (remainingSize < 0.001) continue;

      const copy: CopyTrade = {
        id: crypto.randomUUID(),
        source_trade_id: event.id,
        source_wallet: target.wallet,
        market: event.market,
        asset_id: pos.asset_id,
        side: "SELL",
        price: 0,
        size: remainingSize,
        mode: target.mode,
        timestamp: new Date().toISOString(),
        status: "filled",
        pnl: 0,
        source_price: 0,
        exec_price: 0,
        fee_amount: 0,
        title: event.title || "",
      };
      await insertCopyTrade(db, copy);
      // Track this sell in pendingSells
      pendingSells.set(pos.asset_id, alreadyPending + remainingSize);
      count++;
    }
    return count;
  }

  // CONVERSION with size > 0: winning exit at effective price usdcSize/size
  const exitPrice = event.size > 0 ? event.usdcSize / event.size : 0;

  // Look up our open BUY position on this market
  const { results: positions } = await db
    .prepare(
      `SELECT asset_id, SUM(CASE WHEN side='BUY' THEN size ELSE 0 END) as buy_total,
              SUM(CASE WHEN side='SELL' THEN size ELSE 0 END) as sell_total
       FROM copy_trades
       WHERE source_wallet = ? AND market = ? AND status = 'filled'
       GROUP BY asset_id
       HAVING buy_total > sell_total`,
    )
    .bind(target.wallet, event.market)
    .all<{ asset_id: string; buy_total: number; sell_total: number }>();

  if (!positions || positions.length === 0) return 0;

  let count = 0;
  for (const pos of positions) {
    const alreadyPending = pendingSells.get(pos.asset_id) ?? 0;
    const openSize = pos.buy_total - pos.sell_total - alreadyPending;
    if (openSize < 0.001) continue;

    const copy: CopyTrade = {
      id: crypto.randomUUID(),
      source_trade_id: event.id,
      source_wallet: target.wallet,
      market: event.market,
      asset_id: pos.asset_id,
      side: "SELL",
      price: exitPrice,
      size: openSize,
      mode: target.mode,
      timestamp: new Date().toISOString(),
      status: "filled",
      pnl: 0,
      source_price: exitPrice,
      exec_price: exitPrice,
      fee_amount: 0,
      title: event.title || "",
    };
    await insertCopyTrade(db, copy);
    // Track this sell in pendingSells
    pendingSells.set(pos.asset_id, alreadyPending + openSize);
    count++;
  }
  return count;
}

export async function pollCycle(
  db: D1Database,
  seenIds: Set<string>,
  pythonApiUrl?: string,
): Promise<number> {
  // Get active targets
  const { results: targets } = await db
    .prepare("SELECT * FROM copy_targets WHERE active = 1")
    .all<CopyTarget>();

  if (!targets || targets.length === 0) return 0;

  let newCount = 0;

  // Track in-flight sell sizes within this poll cycle to prevent overselling
  // when multiple SELLs for the same asset are processed before DB writes settle
  const pendingSells = new Map<string, number>();

  for (const target of targets) {
    let activity: DataApiTrade[];
    try {
      activity = await fetchWalletActivity(target.wallet, 50);
    } catch {
      continue;
    }

    for (const event of activity) {
      if (seenIds.has(event.id)) continue;
      seenIds.add(event.id);

      // Handle position exits (CONVERSION / REDEEM)
      if (
        event.activity_type === "CONVERSION" ||
        event.activity_type === "REDEEM"
      ) {
        newCount += await handlePositionExit(db, event, target, pendingSells);
        continue;
      }

      const copy = calculateCopyTrade(event, target);
      if (!copy) continue;

      // For ALL modes: check position before selling.
      // Without this, we create phantom sells for shares the target
      // accumulated before we started copying (we never bought them).
      if (copy.side === "SELL") {
        const pos = await db
          .prepare(
            `SELECT
               COALESCE(SUM(CASE WHEN side='BUY' THEN size ELSE 0 END), 0) -
               COALESCE(SUM(CASE WHEN side='SELL' THEN size ELSE 0 END), 0) AS held
             FROM copy_trades
             WHERE source_wallet = ? AND asset_id = ? AND status = 'filled'`,
          )
          .bind(target.wallet, copy.asset_id)
          .first<{ held: number }>();

        const dbHeld = pos?.held ?? 0;
        const alreadyPending = pendingSells.get(copy.asset_id) ?? 0;
        const available = dbHeld - alreadyPending;

        if (available < 0.01) {
          continue; // skip — we don't hold this asset
        }
        if (copy.size > available) {
          copy.size = available; // cap to what we actually hold
        }
      }

      // Real mode: execute via CLOB API
      if (target.mode === "real") {
        if (pythonApiUrl) {
          const result = await executeRealTrade(pythonApiUrl, copy);
          copy.status = result.status === "filled" ? "filled" : "failed";
          if (result.error) {
            console.error(
              `[REAL] Failed for ${target.wallet.slice(0, 10)}: ${result.error}`,
            );
          } else {
            // Use actual filled size from Cloud Run (may be less due to liquidity)
            if (result.filled_size && result.filled_size > 0) {
              copy.size = result.filled_size;
            }
            console.log(
              `[REAL] ${copy.side} ${copy.size.toFixed(2)} shares @ $${copy.exec_price.toFixed(4)} for ${target.wallet.slice(0, 10)}`,
            );
          }
        } else {
          copy.status = "failed";
          console.error(
            "[REAL] PYTHON_API_URL not configured — cannot execute",
          );
        }

        // Track sells in pendingSells (real mode)
        if (copy.side === "SELL" && copy.status === "filled") {
          const prev = pendingSells.get(copy.asset_id) ?? 0;
          pendingSells.set(copy.asset_id, prev + copy.size);
        }
      } else {
        // Track pending sells for paper mode to prevent overselling within a poll cycle
        if (copy.side === "SELL") {
          const prev = pendingSells.get(copy.asset_id) ?? 0;
          pendingSells.set(copy.asset_id, prev + copy.size);
        }
      }

      await insertCopyTrade(db, copy);
      newCount++;
    }
  }

  // Prune seen IDs if too large (keep recent half)
  if (seenIds.size > 50_000) {
    const arr = Array.from(seenIds);
    seenIds.clear();
    for (let i = arr.length >> 1; i < arr.length; i++) seenIds.add(arr[i]);
  }

  return newCount;
}
