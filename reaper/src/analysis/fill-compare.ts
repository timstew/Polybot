/**
 * Fill-rate comparison: us vs Bonereaper, per window.
 *
 * Reads the `fills` table (our trades) and `shadow_trades` table (BR's trades)
 * and reports per-window and aggregate fill behavior so we can tell whether
 * queue-sim is calibrated correctly.
 *
 * Usage:
 *   bun src/analysis/fill-compare.ts                  # last 2 hours, aggregate
 *   bun src/analysis/fill-compare.ts --since=6h       # last 6 hours
 *   bun src/analysis/fill-compare.ts --per-window     # break down by window
 *   bun src/analysis/fill-compare.ts --slug=btc-updown-5m-1776339300
 */
import { initDb, getDb } from "../db.js";

interface Row {
  slug: string;
  ours_fills: number;
  ours_tokens: number;
  ours_avg_px: number;
  br_fills: number;
  br_tokens: number;
  br_avg_px: number;
}

function parseSince(raw: string | undefined): number {
  if (!raw) return 2 * 60 * 60 * 1000;
  const m = raw.match(/^(\d+)([smhd])$/);
  if (!m) return 2 * 60 * 60 * 1000;
  const n = parseInt(m[1]);
  const unit = m[2];
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

function fmt(x: number, w = 7, digits = 2): string {
  return x.toFixed(digits).padStart(w);
}

const args = process.argv.slice(2);
const sinceMs = parseSince(args.find(a => a.startsWith("--since="))?.slice(8));
const perWindow = args.includes("--per-window");
const slugFilter = args.find(a => a.startsWith("--slug="))?.slice(7);

initDb();
const db = getDb();
const cutoffMs = Date.now() - sinceMs;
const cutoffIso = new Date(cutoffMs).toISOString();

const slugCondition = slugFilter ? "AND window_slug = ?" : "";
const slugArgs = slugFilter ? [slugFilter] : [];

const perWindowRows = db.prepare(`
  SELECT
    f.window_slug AS slug,
    COUNT(*) AS ours_fills,
    COALESCE(SUM(f.size), 0) AS ours_tokens,
    COALESCE(SUM(f.price * f.size) / NULLIF(SUM(f.size), 0), 0) AS ours_avg_px,
    (SELECT COUNT(*) FROM shadow_trades s
      WHERE s.window_slug = f.window_slug AND s.buy_sell = 'BUY'
        AND s.timestamp >= ? ${slugFilter ? "AND s.window_slug = ?" : ""}) AS br_fills,
    (SELECT COALESCE(SUM(size), 0) FROM shadow_trades s
      WHERE s.window_slug = f.window_slug AND s.buy_sell = 'BUY'
        AND s.timestamp >= ? ${slugFilter ? "AND s.window_slug = ?" : ""}) AS br_tokens,
    (SELECT COALESCE(SUM(price * size) / NULLIF(SUM(size), 0), 0) FROM shadow_trades s
      WHERE s.window_slug = f.window_slug AND s.buy_sell = 'BUY'
        AND s.timestamp >= ? ${slugFilter ? "AND s.window_slug = ?" : ""}) AS br_avg_px
  FROM fills f
  WHERE f.created_at >= ? ${slugCondition}
  GROUP BY f.window_slug
  ORDER BY MAX(f.created_at) DESC
`).all(
  cutoffMs, ...slugArgs,
  cutoffMs, ...slugArgs,
  cutoffMs, ...slugArgs,
  cutoffIso, ...slugArgs,
) as Row[];

if (perWindowRows.length === 0) {
  console.log(`No fills in the last ${Math.round(sinceMs / 60000)}m.`);
  process.exit(0);
}

let totOursFills = 0, totBrFills = 0, totOursTokens = 0, totBrTokens = 0;
let totOursNotional = 0, totBrNotional = 0;
for (const r of perWindowRows) {
  totOursFills += r.ours_fills;
  totBrFills += r.br_fills;
  totOursTokens += r.ours_tokens;
  totBrTokens += r.br_tokens;
  totOursNotional += r.ours_tokens * r.ours_avg_px;
  totBrNotional += r.br_tokens * r.br_avg_px;
}

console.log("═".repeat(92));
console.log(`FILL COMPARISON — last ${Math.round(sinceMs / 60000)}m, ${perWindowRows.length} windows`);
console.log("═".repeat(92));
console.log();
console.log("Aggregate:");
console.log(`  Ours:  ${totOursFills} fills, ${fmt(totOursTokens, 8, 0)} tokens, avg $${fmt(totOursNotional / Math.max(1, totOursTokens), 5, 3)}, $${fmt(totOursNotional, 7, 0)} notional`);
console.log(`  BR:    ${totBrFills} fills, ${fmt(totBrTokens, 8, 0)} tokens, avg $${fmt(totBrNotional / Math.max(1, totBrTokens), 5, 3)}, $${fmt(totBrNotional, 7, 0)} notional`);
const fillRatio = totBrFills > 0 ? totOursFills / totBrFills : 0;
const tokenRatio = totBrTokens > 0 ? totOursTokens / totBrTokens : 0;
console.log(`  Ratio: ${(fillRatio * 100).toFixed(1)}% fills, ${(tokenRatio * 100).toFixed(1)}% tokens`);
console.log();
console.log("Interpretation:");
console.log("  Fill ratio ~5-15% means queue-sim is producing realistic rates for small capital.");
console.log("  >50% means we're over-filling (queue-sim calibration too loose).");
console.log("  <1% means we're under-filling (bid prices too cautious or mult too low).");

if (perWindow) {
  console.log();
  console.log("Per-window:");
  console.log("  slug (last 20)        ours_fills  ours_tok  ours_avg    br_fills  br_tok    br_avg    fill_%");
  for (const r of perWindowRows) {
    const ratio = r.br_fills > 0 ? r.ours_fills / r.br_fills * 100 : 0;
    console.log(
      "  " + r.slug.slice(-20).padEnd(22),
      String(r.ours_fills).padStart(8),
      fmt(r.ours_tokens, 8, 0),
      "$" + fmt(r.ours_avg_px, 5, 3),
      String(r.br_fills).padStart(8),
      fmt(r.br_tokens, 8, 0),
      "$" + fmt(r.br_avg_px, 5, 3),
      fmt(ratio, 7, 1) + "%",
    );
  }
}
