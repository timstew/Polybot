import {
  calcFeePerShare,
  getMarketFeeParams,
  CRYPTO_FEES,
  type FeeParams,
} from "./categories";
import type { CopyTarget, CopyTrade, DataApiTrade } from "./types";

const DATA_API = "https://data-api.polymarket.com";

// ── Market time guard ──────────────────────────────────────────────

const marketEndTimeCache = new Map<string, number>(); // title → epoch ms

/**
 * Parse settlement time from Polymarket crypto market titles like:
 * "Will the price of Bitcoin be above $97,250 at 2:45 PM on February 23, 2026?"
 * Returns epoch ms or 0 if unparseable.
 */
function parseMarketEndTime(title: string): number {
  if (!title) return 0;
  // Match "at H:MM AM/PM on Month DD, YYYY"
  const m = title.match(
    /at (\d{1,2}):(\d{2})\s*(AM|PM)\s+on\s+(\w+)\s+(\d{1,2}),?\s*(\d{4})/i,
  );
  if (!m) return 0;
  let hour = parseInt(m[1]);
  const minute = parseInt(m[2]);
  const ampm = m[3].toUpperCase();
  const monthStr = m[4];
  const day = parseInt(m[5]);
  const year = parseInt(m[6]);

  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  const months: Record<string, number> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };
  const monthNum = months[monthStr.toLowerCase()];
  if (monthNum === undefined) return 0;

  // Polymarket times are ET (Eastern Time)
  // Build date string and parse as ET
  const dateStr = `${year}-${String(monthNum + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  // Approximate ET offset: UTC-5 (EST) or UTC-4 (EDT)
  // Use -5 as conservative (slightly earlier cutoff is safer)
  return new Date(dateStr + "-05:00").getTime();
}

/**
 * Check if a market is too close to settlement for a BUY trade.
 * Returns true if the trade should be skipped.
 */
function isMarketExpiringSoon(title: string, minMinutes = 2): boolean {
  let endTime = marketEndTimeCache.get(title);
  if (endTime === undefined) {
    endTime = parseMarketEndTime(title);
    marketEndTimeCache.set(title, endTime);
    // Prune cache if too large
    if (marketEndTimeCache.size > 1000) {
      const keys = Array.from(marketEndTimeCache.keys());
      for (let i = 0; i < 500; i++) marketEndTimeCache.delete(keys[i]);
    }
  }
  if (endTime === 0) return false; // Can't parse — don't block
  const minsRemaining = (endTime - Date.now()) / 60_000;
  return minsRemaining < minMinutes;
}

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

  // Fee params — use market category detection, or target override
  const feeParams = getMarketFeeParams(trade.title);
  let feePerShare = 0;
  if (feeParams) {
    feePerShare = calcFeePerShare(execPrice, feeParams);
  }

  // Copy size — both paper and real use same sizing rules
  // If full_copy_below_usd is set and source trade is below that threshold,
  // copy at 100% regardless of trade_pct (small trades aren't worth scaling down)
  const sourceNotional = trade.price * trade.size;
  const fullCopyBelow = target.full_copy_below_usd ?? 0;
  let copyNotional: number;
  if (fullCopyBelow > 0 && sourceNotional <= fullCopyBelow) {
    copyNotional = sourceNotional;
  } else {
    copyNotional = sourceNotional * (target.trade_pct / 100);
  }
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
    title: trade.title || "",
  };
}

// ── Poll cycle ─────────────────────────────────────────────────────

// Track consecutive balance failures per wallet for wind-down trigger
const balanceFailures = new Map<string, number>();

export function getMaxBalanceFailures(): number {
  let max = 0;
  for (const v of balanceFailures.values()) {
    if (v > max) max = v;
  }
  return max;
}

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

      // Sell fee: at price 0, fee is 0 (losing outcome)
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
        fee_amount: 0, // price=0 → fee=0
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

    // Sell fees apply at exit price
    const exitFeeParams = getMarketFeeParams(event.title || "");
    const sellFeePerShare = exitFeeParams
      ? calcFeePerShare(exitPrice, exitFeeParams)
      : 0;
    const sellFeeAmount = sellFeePerShare * openSize;

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
      fee_amount: sellFeeAmount,
      title: event.title || "",
    };
    await insertCopyTrade(db, copy);
    // Track this sell in pendingSells
    pendingSells.set(pos.asset_id, alreadyPending + openSize);
    count++;
  }
  return count;
}

/**
 * Count open positions (filled BUYs minus filled SELLs) across all active real targets.
 */
export async function getOpenPositionCount(db: D1Database): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT ct.asset_id,
              SUM(CASE WHEN ct.side='BUY' THEN ct.size ELSE 0 END) -
              SUM(CASE WHEN ct.side='SELL' THEN ct.size ELSE 0 END) AS held
       FROM copy_trades ct
       JOIN copy_targets tgt ON ct.source_wallet = tgt.wallet
       WHERE ct.status = 'filled' AND tgt.active = 1 AND tgt.mode = 'real'
       GROUP BY ct.asset_id
       HAVING held > 0.01`,
    )
    .all<{ asset_id: string; held: number }>();
  return results?.length ?? 0;
}

/**
 * Compute simple realized P&L for a real-mode target.
 * Uses paired BUY/SELL on same asset_id: sum of (sell_notional - buy_notional).
 */
async function computeSessionPnl(
  db: D1Database,
  wallet: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN side='SELL' THEN price * size ELSE 0 END), 0) -
         COALESCE(SUM(CASE WHEN side='BUY' THEN price * size ELSE 0 END), 0) -
         COALESCE(SUM(fee_amount), 0) AS pnl
       FROM copy_trades
       WHERE source_wallet = ? AND status = 'filled' AND mode = 'real'`,
    )
    .bind(wallet)
    .first<{ pnl: number }>();
  return row?.pnl ?? 0;
}

/**
 * Check circuit breaker for all real targets. Returns true if any tripped.
 */
export async function checkCircuitBreaker(db: D1Database): Promise<boolean> {
  const { results: realTargets } = await db
    .prepare(
      "SELECT wallet, circuit_breaker_usd, circuit_triggered_at FROM copy_targets WHERE active = 1 AND mode = 'real'",
    )
    .all<{
      wallet: string;
      circuit_breaker_usd: number;
      circuit_triggered_at: string | null;
    }>();

  if (!realTargets || realTargets.length === 0) return false;

  let anyTripped = false;
  for (const target of realTargets) {
    if (target.circuit_triggered_at) continue; // already tripped
    const pnl = await computeSessionPnl(db, target.wallet);
    if (pnl < 0 && Math.abs(pnl) >= target.circuit_breaker_usd) {
      console.log(
        `[CIRCUIT] Loss of $${Math.abs(pnl).toFixed(2)} exceeds $${target.circuit_breaker_usd} threshold for ${target.wallet.slice(0, 10)} — winding down`,
      );
      await db
        .prepare(
          "UPDATE copy_targets SET circuit_triggered_at = ? WHERE wallet = ?",
        )
        .bind(new Date().toISOString(), target.wallet)
        .run();
      anyTripped = true;
    }
  }
  return anyTripped;
}

export async function pollCycle(
  db: D1Database,
  seenIds: Set<string>,
  pythonApiUrl?: string,
  buysDisabled?: boolean,
): Promise<number> {
  // Get active targets — real mode first so they always get processed
  // even if the poll cycle runs long on many paper targets
  const { results: targets } = await db
    .prepare(
      "SELECT * FROM copy_targets WHERE active = 1 ORDER BY CASE mode WHEN 'real' THEN 0 ELSE 1 END",
    )
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

      // Wind-down mode: skip new BUYs, only allow SELLs
      if (buysDisabled && copy.side === "BUY") continue;

      // Market time guard: skip BUYs on markets about to expire
      if (
        copy.side === "BUY" &&
        event.title &&
        isMarketExpiringSoon(event.title)
      ) {
        console.log(
          `[SKIP] Market "${event.title.slice(0, 60)}..." resolves too soon — skipping BUY`,
        );
        continue;
      }

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
            if (result.error === "insufficient_balance") {
              console.warn(
                `[REAL] Insufficient balance for ${target.wallet.slice(0, 10)} — skipping`,
              );
              const fails = (balanceFailures.get(target.wallet) ?? 0) + 1;
              balanceFailures.set(target.wallet, fails);
              if (fails >= 5) {
                console.warn(
                  `[REAL] 5 consecutive balance failures for ${target.wallet.slice(0, 10)} — triggering wind-down`,
                );
              }
            } else {
              // Reset balance failure counter on non-balance errors
              balanceFailures.set(target.wallet, 0);
              console.error(
                `[REAL] Failed for ${target.wallet.slice(0, 10)}: ${result.error}`,
              );
            }
          } else {
            // Reset balance failure counter on success
            balanceFailures.set(target.wallet, 0);
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
        // Paper mode: realistic fill simulation
        const copyNotional = copy.price * copy.size;

        // Virtual balance check for paper BUYs
        if (copy.side === "BUY") {
          const vb = target.virtual_balance ?? 1000;
          if (vb < copyNotional) {
            copy.status = "failed";
            console.log(
              `[PAPER] Insufficient balance: $${vb.toFixed(2)} < $${copyNotional.toFixed(2)} for ${target.wallet.slice(0, 10)}`,
            );
          }
        }

        // Book depth check (only if we have a Python API URL and trade isn't already failed)
        if (copy.status !== "failed" && pythonApiUrl) {
          try {
            const bookResp = await fetch(
              `${pythonApiUrl}/api/book-check?asset_id=${encodeURIComponent(copy.asset_id)}&side=${copy.side}&size=${copy.size}`,
            );
            if (bookResp.ok) {
              const book = (await bookResp.json()) as {
                available_size: number;
                would_fill: boolean;
              };
              if (!book.would_fill) {
                if (book.available_size > 0.01) {
                  // Partial fill
                  copy.size = book.available_size;
                  console.log(
                    `[PAPER] Partial fill: ${book.available_size.toFixed(2)} of ${copy.size.toFixed(2)} shares for ${target.wallet.slice(0, 10)}`,
                  );
                } else {
                  copy.status = "failed";
                  console.log(
                    `[PAPER] No liquidity for ${copy.side} ${copy.asset_id.slice(0, 10)} — ${target.wallet.slice(0, 10)}`,
                  );
                }
              }
            }
          } catch {
            // Book check failed — still allow paper trade (graceful degradation)
          }
        }

        // Update virtual balance for filled paper trades
        if (copy.status === "filled") {
          const filledNotional = copy.price * copy.size;
          if (copy.side === "BUY") {
            await db
              .prepare(
                "UPDATE copy_targets SET virtual_balance = virtual_balance - ? WHERE wallet = ?",
              )
              .bind(filledNotional, target.wallet)
              .run();
            target.virtual_balance =
              (target.virtual_balance ?? 1000) - filledNotional;
          } else {
            await db
              .prepare(
                "UPDATE copy_targets SET virtual_balance = virtual_balance + ? WHERE wallet = ?",
              )
              .bind(filledNotional, target.wallet)
              .run();
            target.virtual_balance =
              (target.virtual_balance ?? 1000) + filledNotional;
          }
        }

        // Track pending sells for paper mode to prevent overselling within a poll cycle
        if (copy.side === "SELL" && copy.status === "filled") {
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
