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

  // Copy size
  const sourceNotional = trade.price * trade.size;
  let copyNotional = sourceNotional * (target.trade_pct / 100);
  copyNotional = Math.min(copyNotional, target.max_position_usd);
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
  };
}

// ── Poll cycle ─────────────────────────────────────────────────────

// Minimum ms between copy trades on the same (wallet, market) pair.
const MARKET_COOLDOWN_MS = 600_000; // 10 minutes

async function insertCopyTrade(db: D1Database, copy: CopyTrade): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO copy_trades
       (id, source_trade_id, source_wallet, market, asset_id,
        side, price, size, mode, timestamp, status, pnl,
        source_price, exec_price, fee_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      const remainingSize = pos.buy_total - pos.sell_total;
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
      };
      await insertCopyTrade(db, copy);
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
    const openSize = pos.buy_total - pos.sell_total;
    if (openSize < 0.001) continue;

    // Scale the exit: source converted `event.size` shares, our position
    // is proportional to trade_pct. Close our full open position.
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
    };
    await insertCopyTrade(db, copy);
    count++;
  }
  return count;
}

export async function pollCycle(
  db: D1Database,
  seenIds: Set<string>,
  lastCopy: Map<string, number>,
): Promise<number> {
  // Get active targets
  const { results: targets } = await db
    .prepare("SELECT * FROM copy_targets WHERE active = 1")
    .all<CopyTarget>();

  if (!targets || targets.length === 0) return 0;

  let newCount = 0;
  const now = Date.now();

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
        newCount += await handlePositionExit(db, event, target);
        continue;
      }

      // Regular TRADE: apply intra-market cooldown
      const cooldownKey = `${target.wallet}:${event.market}`;
      const lastTs = lastCopy.get(cooldownKey);
      if (lastTs !== undefined && now - lastTs < MARKET_COOLDOWN_MS) {
        continue;
      }

      const copy = calculateCopyTrade(event, target);
      if (!copy) continue;

      await insertCopyTrade(db, copy);
      lastCopy.set(cooldownKey, now);
      newCount++;
    }
  }

  // Prune seen IDs if too large
  if (seenIds.size > 50_000) seenIds.clear();
  // Prune stale cooldown entries
  if (lastCopy.size > 10_000) lastCopy.clear();

  return newCount;
}
