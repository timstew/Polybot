"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { ChevronRight } from "lucide-react";
import {
  api,
  type BalanceProtection,
  type StrategyConfig,
  type StrategyState,
  type StrategyTrade,
  type WalletOverview,
} from "@/lib/api";
import { StrategyCharts } from "@/components/strategy-charts";
import {
  fmt, fmtInv, timeAgo,
  Tip, InventoryBar, SingleSideInventoryBar, PairPnl,
  ActiveWindowRow, SingleSideActiveRow,
  ResolvingWindowRow, SingleSideResolvingRow,
  CompletedWindowRow, SingleSideCompletedRow,
  WindowSection,
} from "@/components/strategy-windows";

// fmt, fmtInv, timeAgo imported from strategy-windows

function fmtTime(ts: string) {
  if (!ts) return "";
  const normalized = /[Z+\-]\d{0,4}$/.test(ts) ? ts : ts + "Z";
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

const SYMBOL_MAP: Record<string, string> = {
  bitcoin: "BTC", ethereum: "ETH", solana: "SOL", xrp: "XRP",
  dogecoin: "DOGE", cardano: "ADA", polygon: "MATIC", avalanche: "AVAX",
  chainlink: "LINK", polkadot: "DOT", litecoin: "LTC", sui: "SUI",
};
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function compactTitle(title: string): string {
  if (!title) return "";
  const cryptoMatch = title.match(/price of (\w+)/i);
  const symbol = cryptoMatch
    ? SYMBOL_MAP[cryptoMatch[1].toLowerCase()] ?? cryptoMatch[1].slice(0, 4).toUpperCase()
    : "";
  const timeMatch = title.match(/from\s+(\d{1,2}:\d{2})(AM|PM)\s+to\s+(\d{1,2}:\d{2})(AM|PM)/i);
  let timeStr = "";
  if (timeMatch) {
    const [, start, startP, end, endP] = timeMatch;
    timeStr = startP === endP
      ? `${start}-${end}${endP}`
      : `${start}${startP}-${end}${endP}`;
  }
  const dateMatch = title.match(/on\s+(\w+)\s+(\d{1,2})/i);
  let dateStr = "";
  if (dateMatch) {
    const monthIdx = new Date(`${dateMatch[1]} 1`).getMonth();
    dateStr = `${MONTH_SHORT[monthIdx]} ${dateMatch[2]}`;
  }
  return [symbol, timeStr, dateStr].filter(Boolean).join(" ");
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}

// PairPnl imported from strategy-windows

/** Format cumulative active wall-clock runtime (skips gaps from evictions/reboots/pauses) */
function fmtRunTime(cumulativeMs: number): string {
  const ms = cumulativeMs;
  if (ms <= 0) return "0m";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ${min % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

const STRATEGY_TYPES = [
  { value: "spread-sniper", label: "Spread Sniper" },
  { value: "split-arb", label: "Split Arbitrage" },
  { value: "passive-mm", label: "Passive Market Making" },
  { value: "directional-taker", label: "Directional Taker" },
  { value: "directional-maker", label: "Directional Maker" },
  { value: "safe-maker", label: "Safe Maker" },
  { value: "conviction-maker", label: "Conviction Maker" },
  { value: "unified-adaptive", label: "Unified Adaptive" },
  { value: "certainty-taker", label: "Certainty Taker" },
  { value: "avellaneda-maker", label: "Avellaneda Maker" },
  { value: "enhanced-maker", label: "Enhanced Maker" },
  { value: "orchestrator", label: "Orchestrator" },
  { value: "scaling-safe-maker", label: "Scaling Safe Maker" },
  { value: "babyboner", label: "BabyBoneR" },
];

// Tip, InventoryBar imported from strategy-windows

/** Annotate known abbreviations in tickAction strings with tooltips. */
function TickAction({ text }: { text: string }) {
  if (!text) return null;

  const ABBREVS: [RegExp, string][] = [
    [/\bsig=(\d+)%/g, "Signal strength: model confidence in direction (0-100%)"],
    [/(UP|DOWN|DN)\s+(\d+)%/g, "Signal direction and strength"],
    [/\bvol=(low|normal|high)/g, "Volatility regime: low=calm, tighter bids; high=volatile, wider bids"],
    [/\boff=([0-9.]+)/g, "Bid offset: how far below fair value we bid ($)"],
    [/\bdecay=(\d+)%/g, "Time decay: offset shrinks near close (100%=full, 0%=at fair value)"],
    [/\bll([+-][0-9.]+)/g, "Lead-lag bonus: BTC price confirms this alt's direction"],
    [/\bpc=([0-9.]+)/g, "Pair cost: UP avg + DN avg. Below $1.00 = structurally profitable"],
    [/[▲▼][0-9.]+/g, "Resting bid price on CLOB"],
    [/\bsz=(\d+)/g, "Bid size in tokens"],
    [/\binv=(\d+)\/(\d+)/g, "Inventory: UP tokens / DOWN tokens held"],
    [/\bchop=([0-9.]+)/g, "Choppiness: how noisy/directionless the price action is (0-1)"],
    [/(\d+)\s*flips?\s*>\s*(\d+)\s*max/g, "Signal changed direction too many times (choppy market)"],
  ];

  // Check if any abbreviation exists
  const hasAbbrev = ABBREVS.some(([re]) => { re.lastIndex = 0; return re.test(text); });
  if (!hasAbbrev) return <span>{text}</span>;

  // Build annotated segments
  type Segment = { text: string; tip?: string };
  const segments: Segment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let earliest: { idx: number; len: number; tip: string } | null = null;
    for (const [re, tip] of ABBREVS) {
      re.lastIndex = 0;
      const m = re.exec(remaining);
      if (m && (!earliest || m.index < earliest.idx)) {
        earliest = { idx: m.index, len: m[0].length, tip };
      }
    }
    if (!earliest) {
      segments.push({ text: remaining });
      break;
    }
    if (earliest.idx > 0) segments.push({ text: remaining.slice(0, earliest.idx) });
    segments.push({ text: remaining.slice(earliest.idx, earliest.idx + earliest.len), tip: earliest.tip });
    remaining = remaining.slice(earliest.idx + earliest.len);
  }

  return (
    <span>
      {segments.map((s, i) =>
        s.tip ? (
          <Tip key={i} tip={s.tip}><span className="cursor-help underline decoration-dotted decoration-muted-foreground/50">{s.text}</span></Tip>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </span>
  );
}

// SingleSideInventoryBar imported from strategy-windows

/** Collapsible legend of tickAction abbreviations. */
function TickActionLegend() {
  const items = [
    ["UP/DOWN 72%", "Signal direction and strength (0-100%)"],
    ["vol=low/normal/high", "Volatility regime: low=calm, tighter bids; high=volatile, wider bids"],
    ["off=0.01", "Bid offset: how far below fair value we bid ($)"],
    ["decay=80%", "Time decay: offset shrinks near window close"],
    ["ll+0.08", "Lead-lag bonus: BTC price confirms this alt's direction"],
    ["pc=0.91", "Pair cost: UP avg + DN avg. Below $1.00 = structurally profitable"],
    ["▲0.48 ▼0.49", "Resting bid prices: ▲=UP side, ▼=DOWN side"],
    ["sz=36", "Bid size in tokens"],
    ["inv=20/15", "Inventory: UP tokens / DOWN tokens held"],
    ["chop=0.3", "Choppiness: how noisy the price action is (0-1)"],
    ["bk=0.62/0.38", "Polymarket book mids: UP/DOWN token. Market consensus on outcome"],
    ["disc=12%@calm", "Bid discount below book mid, varies by regime (osci/trend/calm/vol)"],
    ["FLIP→", "Signal direction changed — requoting"],
  ];
  return (
    <details className="group mt-2">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
        Legend
      </summary>
      <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
        {items.map(([abbr, desc]) => (
          <div key={abbr} className="flex gap-2">
            <code className="shrink-0 font-mono text-[10px] bg-muted px-1 rounded">{abbr}</code>
            <span className="text-muted-foreground">{desc}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function shortType(t: string): string {
  return t.replace("directional-", "dir-").replace("unified-adaptive", "unified").replace("conviction-maker", "conv").replace("safe-maker", "safe");
}

/** Generate a concise narrative of what a window is doing right now. */
function windowNarrative(w: {
  upInventory: number; downInventory: number;
  upAvgCost: number; downAvgCost: number;
  upBidOrderId: string | null; downBidOrderId: string | null;
  upBidPrice: number; downBidPrice: number;
  fillCount: number; sellCount: number;
  rebalanceSold?: boolean;
  lastUpBestAsk?: number; lastDnBestAsk?: number;
  windowEndTime: number;
}, opts?: { windingDown?: boolean }): string {
  const wdPrefix = opts?.windingDown ? "Wind↓ " : "";
  const up = w.upInventory ?? 0;
  const dn = w.downInventory ?? 0;
  const timeLeft = Math.max(0, w.windowEndTime - Date.now());

  if (timeLeft === 0) {
    if (up === 0 && dn === 0) return "Closed with no fills";
    const matched = Math.min(up, dn);
    if (matched > 0) return `${fmtInv(matched)}pr awaiting outcome`;
    return `${up > 0 ? `${fmtInv(up)} UP` : `${fmtInv(dn)} DN`} awaiting outcome`;
  }

  // Poisoned — rebalance sell happened
  if (w.rebalanceSold) {
    if (up === 0 && dn === 0) return `${wdPrefix}Sold excess, quoting stopped`;
    return `${wdPrefix}Holding ${up > 0 ? `${fmtInv(up)} UP` : `${fmtInv(dn)} DN`}, quoting stopped`;
  }

  // No fills yet
  if (up === 0 && dn === 0) {
    if (opts?.windingDown) return "Wind↓ No fills, awaiting resolution";
    const upAsk = w.lastUpBestAsk ?? 0;
    const dnAsk = w.lastDnBestAsk ?? 0;
    if (upAsk > 0 && dnAsk > 0 && Math.abs(upAsk - dnAsk) > 0.15) {
      return `Asks lopsided (${upAsk.toFixed(2)}/${dnAsk.toFixed(2)}), waiting`;
    }
    if (w.upBidOrderId && w.downBidOrderId) {
      return `Bidding ▲${w.upBidPrice.toFixed(2)} ▼${w.downBidPrice.toFixed(2)}`;
    }
    if (w.upBidOrderId) return `Bidding UP @ ${w.upBidPrice.toFixed(2)}`;
    if (w.downBidOrderId) return `Bidding DN @ ${w.downBidPrice.toFixed(2)}`;
    return "Scanning order books";
  }

  // One side filled
  if (up > 0 && dn === 0) {
    if (w.downBidOrderId) return `${wdPrefix}${fmtInv(up)} UP @ ${w.upAvgCost.toFixed(2)}, bidding DN ≤${w.downBidPrice.toFixed(2)}`;
    return `${wdPrefix}Holding ${fmtInv(up)} UP @ ${w.upAvgCost.toFixed(2)}${opts?.windingDown ? ", completing" : ", need DN"}`;
  }
  if (dn > 0 && up === 0) {
    if (w.upBidOrderId) return `${wdPrefix}${fmtInv(dn)} DN @ ${w.downAvgCost.toFixed(2)}, bidding UP ≤${w.upBidPrice.toFixed(2)}`;
    return `${wdPrefix}Holding ${fmtInv(dn)} DN @ ${w.downAvgCost.toFixed(2)}${opts?.windingDown ? ", completing" : ", need UP"}`;
  }

  // Both sides filled
  const matched = Math.min(up, dn);
  const pc = (w.upAvgCost + w.downAvgCost).toFixed(2);
  if (up === dn) {
    if (opts?.windingDown) return `Wind↓ ${fmtInv(matched)}pr locked @ ${pc}, awaiting resolution`;
    if (w.upBidOrderId && w.downBidOrderId) return `${fmtInv(matched)}pr locked @ ${pc}, accumulating more`;
    if (w.upBidOrderId || w.downBidOrderId) return `${fmtInv(matched)}pr locked @ ${pc}, bidding`;
    return `${fmtInv(matched)}pr locked @ ${pc}, holding`;
  }
  const excess = up > dn ? `+${fmtInv(up - dn)} UP` : `+${fmtInv(dn - up)} DN`;
  const balancingBid = up > dn
    ? (w.downBidOrderId ? `, bidding DN ≤${w.downBidPrice.toFixed(2)}` : "")
    : (w.upBidOrderId ? `, bidding UP ≤${w.upBidPrice.toFixed(2)}` : "");
  return `${wdPrefix}${fmtInv(matched)}pr @ ${pc}, ${excess}${balancingBid}`;
}

// ── Mini pie chart (SVG) ──────────────────────────────────────────────

function PieChart({ wins, losses, size = 48 }: { wins: number; losses: number; size?: number }) {
  const total = wins + losses;
  if (total === 0) return <div style={{ width: size, height: size }} className="rounded-full border border-dashed" />;
  const winPct = wins / total;
  const r = size / 2 - 2;
  const cx = size / 2;
  const cy = size / 2;
  if (winPct >= 1) return (
    <svg width={size} height={size}><circle cx={cx} cy={cy} r={r} fill="#16a34a" /></svg>
  );
  if (winPct <= 0) return (
    <svg width={size} height={size}><circle cx={cx} cy={cy} r={r} fill="#dc2626" /></svg>
  );
  const angle = winPct * 360;
  const rad = (angle - 90) * Math.PI / 180;
  const x = cx + r * Math.cos(rad);
  const y = cy + r * Math.sin(rad);
  const large = angle > 180 ? 1 : 0;
  return (
    <svg width={size} height={size}>
      <circle cx={cx} cy={cy} r={r} fill="#dc2626" />
      <path d={`M${cx},${cy} L${cx},${cy - r} A${r},${r} 0 ${large},1 ${x},${y} Z`} fill="#16a34a" />
    </svg>
  );
}

// ── Extract overview stats from any strategy type ─────────────────────

function extractOverviewStats(custom: Record<string, unknown> | undefined, strategyType: string, pnl: number, riskCapital: number) {
  const isUnified = strategyType === "unified-adaptive";
  const isOrchestrator = strategyType === "orchestrator";

  // Sum totalBuyCost across all windows for the tooltip (capital cycled)
  const allWindows = [
    ...((custom?.activeWindows as Array<{ totalBuyCost?: number }>) ?? []),
    ...((custom?.completedWindows as Array<{ totalBuyCost?: number }>) ?? []),
  ];
  const totalCapitalCycled = allWindows.reduce((s, w) => s + (w.totalBuyCost ?? 0), 0);
  // Return on risk: P&L vs capital allocated to the strategy
  const returnOnRisk = riskCapital > 0 ? pnl / riskCapital : 0;

  if (isUnified) {
    const stats = custom?.stats as { windowsTraded?: number; sniperWins?: number; makerWins?: number; totalPnl?: number } | undefined;
    const traded = stats?.windowsTraded ?? 0;
    const wins = (stats?.sniperWins ?? 0) + (stats?.makerWins ?? 0);
    const losses = traded - wins;
    const winRate = traded > 0 ? wins / traded : 0;
    return { traded, wins, losses, winRate, returnOnRisk, totalCapitalCycled };
  }
  if (isOrchestrator) {
    const stats = custom?.stats as { windowsTraded?: number; perTactic?: Record<string, { wins?: number }> } | undefined;
    const traded = stats?.windowsTraded ?? 0;
    const wins = stats?.perTactic ? Object.values(stats.perTactic).reduce((s, t) => s + (t.wins ?? 0), 0) : 0;
    const losses = traded - wins;
    const winRate = traded > 0 ? wins / traded : 0;
    return { traded, wins, losses, winRate, returnOnRisk, totalCapitalCycled };
  }
  // Directional strategies
  const traded = (custom?.windowsTraded as number) ?? 0;
  const wins = (custom?.windowsWon as number) ?? 0;
  const losses = (custom?.windowsLost as number) ?? 0;
  const winRate = (custom?.directionalAccuracy as number) ?? (traded > 0 ? wins / traded : 0);
  return { traded, wins, losses, winRate, returnOnRisk, totalCapitalCycled };
}

// ── Unified Adaptive detail section ───────────────────────────────────

function UnifiedDetail({ custom, isActive, isWindingDown, config }: {
  custom: Record<string, unknown> | undefined;
  isActive: boolean;
  isWindingDown?: boolean;
  config: StrategyConfig;
}) {
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);
  const stats = custom?.stats as {
    totalPnl: number; windowsTraded: number;
    sniperWindows: number; makerWindows: number;
    sniperPnl: number; makerPnl: number;
    sniperWins: number; makerWins: number;
  } | undefined;
  const resolvingValue = (custom?.resolvingValue as number) ?? 0;
  const scanStatus = (custom?.scanStatus as string) ?? "";
  const liquidity = custom?.liquidity as {
    buckets: Record<string, { avgMatchRate: number; sampleCount: number; lastBidSize: number; lastUpdated: number }>;
    globalAvgMatchRate: number; globalSampleCount: number;
  } | undefined;
  const allActiveWindows = (custom?.activeWindows as Array<{
    market: { title: string; conditionId?: string }; cryptoSymbol: string; mode: string;
    convictionSide: string | null; confirmedDirection: string | null;
    signalStrengthAtEntry: number; upInventory: number; downInventory: number;
    upAvgCost: number; downAvgCost: number;
    upBidOrderId: string | null; downBidOrderId: string | null;
    upBidPrice: number; downBidPrice: number;
    totalBuyCost: number; realizedSellPnl: number; windowEndTime: number;
    windowOpenTime: number; bidSize: number;
    fillCount: number; sellCount: number; flipCount: number;
    lastUpBestAsk?: number; lastDnBestAsk?: number;
    rebalanceSold?: boolean;
    binancePrediction?: "UP" | "DOWN" | null;
    tickAction?: string;
  }>) ?? [];
  const activeWindows = allActiveWindows.filter(w => w.windowEndTime > Date.now());
  const resolvingWindows = allActiveWindows.filter(w => w.windowEndTime <= Date.now());
  const completedWindows = (custom?.completedWindows as Array<{
    title: string; cryptoSymbol: string; mode: string; outcome: string;
    upInventory: number; downInventory: number; upAvgCost: number; downAvgCost: number;
    matchedPairs: number; netPnl: number; fillCount: number; sellCount: number;
    completedAt: string; priceMovePct: number; bidSize: number; windowDurationMs: number;
    gammaConfirmed?: boolean;
  }>) ?? [];

  if (!stats) return null;
  const sniperLosses = stats.sniperWindows - stats.sniperWins;
  const makerLosses = stats.makerWindows - stats.makerWins;
  const sniperWR = stats.sniperWindows > 0 ? (stats.sniperWins / stats.sniperWindows * 100).toFixed(0) : "—";
  const makerWR = stats.makerWindows > 0 ? (stats.makerWins / stats.makerWindows * 100).toFixed(0) : "—";

  // Find last used info per mode
  const lastSniper = [...completedWindows].reverse().find(w => w.mode === "sniper");
  const lastMaker = [...completedWindows].reverse().find(w => w.mode === "maker");

  // Liquidity buckets (only exact keys, not wildcards)
  const bucketEntries = Object.entries(liquidity?.buckets ?? {})
    .filter(([k]) => !k.includes("*"))
    .sort(([, a], [, b]) => b.lastUpdated - a.lastUpdated);

  return (
    <div className="space-y-4">
      {/* Sub-strategy breakdown */}
      {stats.windowsTraded > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* Sniper card */}
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <PieChart wins={stats.sniperWins} losses={sniperLosses} size={44} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Sniper</div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{stats.sniperWindows} windows</span>
                  <span className="text-green-600">{stats.sniperWins}W</span>
                  <span className="text-red-600">{sniperLosses}L</span>
                  <span>{sniperWR}% win</span>
                </div>
                <div className={`text-sm font-bold tabular-nums ${stats.sniperPnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {fmt(stats.sniperPnl)}
                  {stats.sniperWindows > 0 && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      ({fmt(stats.sniperPnl / stats.sniperWindows)}/win)
                    </span>
                  )}
                </div>
              </div>
            </div>
            {lastSniper && (
              <div className="mt-2 border-t pt-1.5 text-xs text-muted-foreground">
                Last: {compactTitle(lastSniper.title) || lastSniper.cryptoSymbol}{" "}
                {lastSniper.windowDurationMs ? fmtDuration(lastSniper.windowDurationMs) : ""}{" "}
                <span className={lastSniper.netPnl >= 0 ? "text-green-600" : "text-red-600"}>
                  {fmt(lastSniper.netPnl)}
                </span>{" "}
                {timeAgo(lastSniper.completedAt)}
              </div>
            )}
          </div>

          {/* Maker card */}
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <PieChart wins={stats.makerWins} losses={makerLosses} size={44} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Maker</div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{stats.makerWindows} windows</span>
                  <span className="text-green-600">{stats.makerWins}W</span>
                  <span className="text-red-600">{makerLosses}L</span>
                  <span>{makerWR}% win</span>
                </div>
                <div className={`text-sm font-bold tabular-nums ${stats.makerPnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {fmt(stats.makerPnl)}
                  {stats.makerWindows > 0 && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      ({fmt(stats.makerPnl / stats.makerWindows)}/win)
                    </span>
                  )}
                </div>
              </div>
            </div>
            {lastMaker && (
              <div className="mt-2 border-t pt-1.5 text-xs text-muted-foreground">
                Last: {compactTitle(lastMaker.title) || lastMaker.cryptoSymbol}{" "}
                {lastMaker.windowDurationMs ? fmtDuration(lastMaker.windowDurationMs) : ""}{" "}
                <span className={lastMaker.netPnl >= 0 ? "text-green-600" : "text-red-600"}>
                  {fmt(lastMaker.netPnl)}
                </span>{" "}
                {timeAgo(lastMaker.completedAt)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Current activity — always visible */}
      {(() => {
        const status = scanStatus
          || (activeWindows.length > 0
            ? `${activeWindows.length} window${activeWindows.length > 1 ? "s" : ""} active`
            : "Waiting for markets…");
        return (
          <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground italic">
            {status}
          </div>
        );
      })()}

      <WindowSection
        sectionTitle="Active Windows"
        sectionTip="Binary prediction windows currently being traded. Each window is a crypto up-or-down market with a fixed time range"
        active={activeWindows.map((w, i) => {
          const up = w.upInventory ?? 0;
          const dn = w.downInventory ?? 0;
          const matched = Math.min(up, dn);
          const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
          return (
            <ActiveWindowRow key={i}
              title={w.market?.title ?? ""} compact={compactTitle(w.market?.title ?? "") || w.cryptoSymbol}
              chips={<>
                <Tip tip="sniper = direction-agnostic spread capture. maker = signal-biased directional fills">
                  <span><Badge variant="outline" className="text-[10px] px-1 py-0 cursor-help">{w.mode}</Badge></span>
                </Tip>
                {w.mode === "maker" && w.confirmedDirection && (
                  <Tip tip={`Maker conviction: betting on ${w.confirmedDirection}. Strength at entry: ${((w.signalStrengthAtEntry ?? 0) * 100).toFixed(0)}%`}>
                    <span className={`text-[10px] font-medium cursor-help ${w.confirmedDirection === "UP" ? "text-green-700" : "text-red-700"}`}>
                      {w.confirmedDirection === "UP" ? "BULL" : "BEAR"}
                    </span>
                  </Tip>
                )}
                {w.rebalanceSold && (
                  <Tip tip="Window poisoned — rebalance sell triggered, quoting stopped to prevent churn">
                    <span className="text-[10px] font-medium rounded px-1 py-0 bg-orange-100 text-orange-800 cursor-help">POISON</span>
                  </Tip>
                )}
              </>}
              up={up} dn={dn} upAvgCost={w.upAvgCost ?? 0} dnAvgCost={w.downAvgCost ?? 0}
              scale={w.bidSize ?? 1} pairCost={pairCost}
              upBidActive={!!w.upBidOrderId} dnBidActive={!!w.downBidOrderId}
              fillCount={w.fillCount ?? 0}
              onMerge={isActive && matched > 0 && pairCost !== null && pairCost < 1 && w.market.conditionId ? async () => {
                const cid = w.market.conditionId!;
                setMergingId(cid);
                setMergeMsg(null);
                try {
                  const res = await api.strategyMerge(config.id, cid, matched);
                  setMergeMsg(res.status === "merged"
                    ? `Merged ${res.merged} pairs → +$${res.pnl?.toFixed(2)}${res.duration_ms ? ` (${res.duration_ms}ms)` : ""}`
                    : `Failed: ${(res as Record<string, unknown>).error || "unknown"}`);
                } catch (e) { setMergeMsg(`Error: ${e}`); }
                finally { setMergingId(null); }
              } : undefined}
              merging={mergingId === w.market.conditionId}
              tickAction={w.tickAction ? <TickAction text={w.tickAction} /> : undefined}
              narrative={windowNarrative(w, { windingDown: isWindingDown })}
              timeLeftMs={Math.max(0, w.windowEndTime - Date.now())}
            />
          );
        })}
        resolving={resolvingWindows.map((w, i) => {
          const up = w.upInventory ?? 0;
          const dn = w.downInventory ?? 0;
          const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
          const prediction = (w.binancePrediction ?? w.confirmedDirection) as "UP" | "DOWN" | null;
          const betSide = w.convictionSide || (up > dn ? "UP" : dn > up ? "DOWN" : null);
          const willWin = prediction && betSide ? prediction === betSide : null;
          const estPnl = prediction ? (() => {
            const winSide = prediction === "UP" ? up : dn;
            const loseSide = prediction === "UP" ? dn : up;
            const winCost = prediction === "UP" ? (w.upAvgCost ?? 0) : (w.downAvgCost ?? 0);
            const loseCost = prediction === "UP" ? (w.downAvgCost ?? 0) : (w.upAvgCost ?? 0);
            return winSide * (1.0 - winCost) - loseSide * loseCost - (w.realizedSellPnl ? -w.realizedSellPnl : 0);
          })() : null;
          return (
            <ResolvingWindowRow key={`r-${i}`}
              title={w.market?.title ?? ""} compact={compactTitle(w.market?.title ?? "") || w.cryptoSymbol}
              up={up} dn={dn} upAvgCost={w.upAvgCost ?? 0} dnAvgCost={w.downAvgCost ?? 0}
              scale={w.bidSize ?? 1} pairCost={pairCost}
              prediction={prediction} estPnl={estPnl}
              predictionText={prediction ? (willWin === true ? `Binance predicts win (${prediction})` : willWin === false ? `Binance predicts loss (${prediction})` : undefined) : undefined}
            />
          );
        })}
        completed={completedWindows.slice(-20).reverse().map((w, i) => {
          const up = w.upInventory ?? 0;
          const dn = w.downInventory ?? 0;
          const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
          return (
            <CompletedWindowRow key={i}
              title={w.title} compact={compactTitle(w.title) || w.cryptoSymbol}
              outcome={w.outcome}
              chips={<Tip tip="Mode used for this window (sniper or maker)"><span><Badge variant="outline" className="text-[10px] px-1 py-0 cursor-help">{w.mode}</Badge></span></Tip>}
              up={up} dn={dn} upAvgCost={w.upAvgCost ?? 0} dnAvgCost={w.downAvgCost ?? 0}
              scale={w.bidSize ?? 1} pairCost={pairCost}
              netPnl={w.netPnl} fillCount={w.fillCount}
              durationMs={w.windowDurationMs} completedAt={w.completedAt}
              gammaConfirmed={w.gammaConfirmed}
            />
          );
        })}
      />

      {/* Liquidity buckets */}
      {bucketEntries.length > 0 && (
        <details className="group">
          <Tip tip="Tracks fill rates per symbol/duration/mode to adaptively size bids. Higher match rate = more inventory captured">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
              Fill Buckets ({bucketEntries.length})
            </summary>
          </Tip>
          <div className="mt-2 space-y-1">
            {bucketEntries.map(([key, b]) => (
              <div key={key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1 text-xs font-mono">
                <Tip tip="Bucket key: symbol:duration:mode"><span className="font-medium cursor-help">{key}</span></Tip>
                <Tip tip="EMA of match rate (min(UP,DOWN)/bid). Target: 0.90. Higher = more paired inventory"><span className="tabular-nums cursor-help">match={b.avgMatchRate.toFixed(2)}</span></Tip>
                <Tip tip="Last bid size used for this bucket"><span className="tabular-nums text-muted-foreground cursor-help">bid={b.lastBidSize}</span></Tip>
                <Tip tip="Number of windows sampled for this bucket"><span className="tabular-nums text-muted-foreground cursor-help">n={b.sampleCount}</span></Tip>
                <span className="ml-auto text-muted-foreground">{timeAgo(b.lastUpdated)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ── Params editor ────────────────────────────────────────────────────

function ParamsEditor({
  config,
  isActive,
  isWindingDown,
  hasTicks,
  onSave,
  onClone,
  onReset,
}: {
  config: StrategyConfig;
  isActive: boolean;
  isWindingDown?: boolean;
  hasTicks: boolean;
  onSave: (updates: Partial<StrategyConfig>) => Promise<void>;
  onClone: (config: Partial<StrategyConfig>) => Promise<void>;
  onReset?: () => void;
}) {
  const parseParams = (p: string | Record<string, unknown>) => {
    try { return typeof p === "string" ? JSON.parse(p || "{}") : (p ?? {}); }
    catch { return {}; }
  };

  const [fields, setFields] = useState({
    name: config.name,
    mode: config.mode,
    tick_interval_ms: config.tick_interval_ms,
    max_capital_usd: config.max_capital_usd,
    balance_usd: config.balance_usd,
  });
  const [params, setParams] = useState<Record<string, unknown>>(parseParams(config.params));
  const [newKey, setNewKey] = useState("");
  const [saving, setSaving] = useState(false);

  const origParams = parseParams(config.params);
  const hasChanges =
    fields.name !== config.name ||
    fields.mode !== config.mode ||
    fields.tick_interval_ms !== config.tick_interval_ms ||
    fields.max_capital_usd !== config.max_capital_usd ||
    fields.balance_usd !== config.balance_usd ||
    JSON.stringify(params) !== JSON.stringify(origParams);

  const handleSave = async (resetStats = false) => {
    setSaving(true);
    try {
      await onSave({
        name: fields.name, mode: fields.mode,
        tick_interval_ms: fields.tick_interval_ms,
        max_capital_usd: fields.max_capital_usd,
        balance_usd: fields.balance_usd,
        params: JSON.stringify(params),
      });
      if (resetStats && onReset) await onReset();
    } finally { setSaving(false); }
  };

  const handleClone = async () => {
    setSaving(true);
    try {
      await onClone({
        name: `${fields.name} (copy)`,
        strategy_type: config.strategy_type,
        mode: fields.mode,
        max_capital_usd: fields.max_capital_usd,
        balance_usd: fields.balance_usd,
        params: JSON.stringify(params),
      });
    } finally { setSaving(false); }
  };

  const updateParam = (key: string, value: unknown) => setParams(prev => ({ ...prev, [key]: value }));
  const removeParam = (key: string) => setParams(prev => { const n = { ...prev }; delete n[key]; return n; });
  const addParam = () => { if (newKey.trim()) { updateParam(newKey.trim(), ""); setNewKey(""); } };

  const renderInput = (key: string, value: unknown) => {
    if (typeof value === "boolean") {
      return <input type="checkbox" checked={value} onChange={(e) => updateParam(key, e.target.checked)} className="rounded border" />;
    }
    if (typeof value === "number") {
      return (
        <input type="number" value={value} step="any"
          onChange={(e) => updateParam(key, e.target.value === "" ? 0 : parseFloat(e.target.value))}
          className="h-7 w-full rounded border bg-background px-2 text-xs font-mono tabular-nums" />
      );
    }
    if (typeof value === "string") {
      return (
        <input type="text" value={value}
          onChange={(e) => updateParam(key, e.target.value)}
          className="h-7 w-full rounded border bg-background px-2 text-xs font-mono" />
      );
    }
    return (
      <textarea value={JSON.stringify(value, null, 2)}
        onChange={(e) => { try { updateParam(key, JSON.parse(e.target.value)); } catch { /* typing */ } }}
        className="w-full rounded border bg-background px-2 py-1 text-xs font-mono min-h-[60px]" />
    );
  };

  return (
    <details className="group">
      <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
        Configuration Parameters
        {hasChanges && <span className="ml-2 text-amber-500 text-xs">(unsaved changes)</span>}
      </summary>
      <div className="mt-2 space-y-3">
        {/* Config-level fields */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground">Name</label>
            <input type="text" value={fields.name}
              onChange={(e) => setFields(f => ({ ...f, name: e.target.value }))}
              className="h-7 w-full rounded border bg-background px-2 text-xs" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Mode</label>
            <select value={fields.mode}
              onChange={(e) => setFields(f => ({ ...f, mode: e.target.value as "paper" | "real" }))}
              className="h-7 w-full rounded border bg-background px-2 text-xs">
              <option value="paper">Paper</option>
              <option value="real">Real</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Tick (ms)</label>
            <input type="number" value={fields.tick_interval_ms}
              onChange={(e) => setFields(f => ({ ...f, tick_interval_ms: parseInt(e.target.value) || 5000 }))}
              className="h-7 w-full rounded border bg-background px-2 text-xs font-mono" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Max Capital ($)</label>
            <input type="number" value={fields.max_capital_usd}
              onChange={(e) => setFields(f => ({ ...f, max_capital_usd: parseFloat(e.target.value) || 0 }))}
              className="h-7 w-full rounded border bg-background px-2 text-xs font-mono" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Balance ($)</label>
            <input type="number" value={fields.balance_usd ?? ""} placeholder="—"
              onChange={(e) => setFields(f => ({ ...f, balance_usd: e.target.value ? parseFloat(e.target.value) : null }))}
              className="h-7 w-full rounded border bg-background px-2 text-xs font-mono" />
          </div>
          {fields.balance_usd != null && (
            <>
              <div>
                <label className="text-[10px] text-muted-foreground">Reinvest %</label>
                <input type="number" value={(params.profit_reinvest_pct as number) ?? 0} step="0.05" min="0" max="1"
                  onChange={(e) => updateParam("profit_reinvest_pct", e.target.value === "" ? 0 : parseFloat(e.target.value))}
                  className="h-7 w-full rounded border bg-background px-2 text-xs font-mono" />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">Capital Cap ($)</label>
                <input type="number" value={(params.max_capital_cap_usd as number) || ""} placeholder="no limit"
                  onChange={(e) => updateParam("max_capital_cap_usd", e.target.value === "" ? 0 : parseFloat(e.target.value))}
                  className="h-7 w-full rounded border bg-background px-2 text-xs font-mono" />
              </div>
            </>
          )}
        </div>

        {/* Strategy params */}
        <div>
          <div className="text-[10px] font-medium text-muted-foreground mb-1">Strategy Parameters</div>
          <div className="space-y-1">
            {Object.entries(params).filter(([key]) => key !== "profit_reinvest_pct" && key !== "max_capital_cap_usd").sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => (
              <div key={key} className="flex items-start gap-2">
                <label className="text-xs font-mono text-muted-foreground pt-1.5 min-w-[140px] truncate" title={key}>{key}</label>
                <div className="flex-1 min-w-0">{renderInput(key, value)}</div>
                <button onClick={() => removeParam(key)} className="text-xs text-muted-foreground hover:text-red-500 pt-1.5 shrink-0" title="Remove">&times;</button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <input type="text" value={newKey} onChange={(e) => setNewKey(e.target.value)}
              placeholder="new_param_name" className="h-7 rounded border bg-background px-2 text-xs font-mono flex-1"
              onKeyDown={(e) => e.key === "Enter" && addParam()} />
            <Button size="sm" variant="outline" className="h-7 text-xs px-2" onClick={addParam} disabled={!newKey.trim()}>+ Add</Button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
          <Button size="sm" className="h-7 text-xs px-3" onClick={() => handleSave(false)} disabled={!hasChanges || saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          {hasChanges && !isActive && !isWindingDown && onReset && (
            <Button size="sm" variant="outline" className="h-7 text-xs px-3"
              onClick={() => { if (confirm("Save changes AND reset all stats, trades, and logs?")) handleSave(true); }}
              disabled={saving}>
              Save &amp; Reset
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-7 text-xs px-3" onClick={handleClone} disabled={saving}>Clone</Button>
          {!isActive && !isWindingDown && onReset && hasTicks && (
            <button onClick={() => { if (confirm("Reset all stats, trades, and logs? Config will be kept.")) onReset(); }}
              className="text-xs text-muted-foreground hover:text-red-600 underline ml-auto">
              Reset stats &amp; trades
            </button>
          )}
          {isActive && hasChanges && (
            <span className="text-[10px] text-amber-500 ml-auto">Restart strategy to apply changes</span>
          )}
        </div>
      </div>
    </details>
  );
}

// ── Strategy detail (all types) ───────────────────────────────────────

function StrategyDetail({
  config,
  isActive,
  isWindingDown,
  state,
  balanceProtection,
  onReset,
  onSave,
  onClone,
}: {
  config: StrategyConfig;
  isActive: boolean;
  isWindingDown?: boolean;
  state: StrategyState | null;
  balanceProtection?: BalanceProtection | null;
  onReset?: () => void;
  onSave: (updates: Partial<StrategyConfig>) => Promise<void>;
  onClone: (config: Partial<StrategyConfig>) => Promise<void>;
}) {
  const logs = state?.logs ?? [];
  const custom = state?.custom as Record<string, unknown> | undefined;
  const isConviction = config.strategy_type === "conviction-maker";
  const isDirectional = config.strategy_type === "directional-taker" || config.strategy_type === "directional-maker" || config.strategy_type === "safe-maker" || config.strategy_type === "enhanced-maker" || config.strategy_type === "scaling-safe-maker" || config.strategy_type === "babyboner";
  const isUnified = config.strategy_type === "unified-adaptive";
  const isOrchestrator = config.strategy_type === "orchestrator";
  const isMaker = config.strategy_type === "directional-maker" || config.strategy_type === "safe-maker" || config.strategy_type === "conviction-maker" || config.strategy_type === "enhanced-maker" || config.strategy_type === "scaling-safe-maker" || config.strategy_type === "babyboner";
  const isCertaintyTaker = config.strategy_type === "certainty-taker";
  const isAvellaneda = config.strategy_type === "avellaneda-maker";

  const positions = (custom?.positions as Array<{
    market: { title: string };
    upPrice: number; downPrice: number;
    upFilled: boolean; downFilled: boolean;
    netProfitPerShare: number; placedAt: string;
  }>) ?? [];
  const scalps = (custom?.scalps as Array<{
    market: { title: string };
    inventory: Array<{ side: string; size: number; avgCostBasis: number }>;
    totalBuys: number; totalSells: number; realizedPnl: number;
  }>) ?? [];

  // Directional strategy state
  const allActiveWindows = (custom?.activeWindows as Array<{
    market: { title: string }; cryptoSymbol: string;
    convictionSide: string | null; confirmedDirection: string | null;
    signalStrengthAtEntry: number; upInventory: number; downInventory: number;
    upAvgCost: number; downAvgCost: number;
    upBidOrderId: string | null; downBidOrderId: string | null;
    upBidPrice: number; downBidPrice: number;
    totalBuyCost: number; realizedSellPnl: number; windowEndTime: number;
    buyCount?: number; sellCount: number; phase?: string;
    fillCount?: number; flipCount: number;
    upBidSize?: number; downBidSize?: number; bidSize?: number;
    lastUpBestAsk?: number; lastDnBestAsk?: number;
    rebalanceSold?: boolean;
    binancePrediction?: "UP" | "DOWN" | null;
    tickAction?: string;
    peakUpInventory?: number; peakDownInventory?: number;
    totalMerged?: number; totalMergePnl?: number;
  }>) ?? [];
  const activeWindows = allActiveWindows.filter(w => w.windowEndTime > Date.now());
  const resolvingWindows = allActiveWindows.filter(w => w.windowEndTime <= Date.now());
  const completedWindows = (custom?.completedWindows as Array<{
    title: string; convictionSide: string | null; outcome: string;
    winningPayout: number; losingLoss: number; realizedSellPnl: number;
    netPnl: number; totalBuyCost: number; signalStrength: number;
    correct: boolean; buyCount?: number; sellCount: number;
    fillCount?: number; flipCount: number; completedAt: string;
    upInventory: number; downInventory: number;
    upAvgCost: number; downAvgCost: number; bidSize?: number;
    gammaConfirmed?: boolean;
    peakUpInventory?: number; peakDownInventory?: number;
    totalMerged?: number; totalMergePnl?: number;
  }>) ?? [];
  const windowsTraded = (custom?.windowsTraded as number) ?? 0;
  const windowsWon = (custom?.windowsWon as number) ?? 0;
  const windowsLost = (custom?.windowsLost as number) ?? 0;
  const directionalAccuracy = (custom?.directionalAccuracy as number) ?? 0;
  const totalPnl = (custom?.totalPnl as number) ?? 0;
  const totalMakerFills = (custom?.totalMakerFills as number) ?? 0;

  return (
    <div className="space-y-4 px-2 pb-4">
      {/* Status summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tip tip="Number of 5-second polling cycles completed since start">
          <div className="rounded-lg border p-3 cursor-help">
            <div className="text-xs text-muted-foreground">Ticks</div>
            <div className="text-lg font-bold tabular-nums">{state?.ticks ?? 0}</div>
          </div>
        </Tip>
        <Tip tip="Tick errors (exceptions during polling). Non-zero indicates a bug or API failure">
          <div className="rounded-lg border p-3 cursor-help">
            <div className="text-xs text-muted-foreground">Errors</div>
            <div className={`text-lg font-bold tabular-nums ${(state?.errors ?? 0) > 0 ? "text-red-600" : ""}`}>
              {state?.errors ?? 0}
            </div>
          </div>
        </Tip>
        <Tip tip="Sum of realized P&L from all completed windows (resolution payouts minus buy costs minus fees)">
          <div className="rounded-lg border p-3 cursor-help">
            <div className="text-xs text-muted-foreground">Total P&L</div>
            <div className={`text-lg font-bold tabular-nums ${(state?.total_pnl ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
              {fmt(state?.total_pnl ?? 0)}
            </div>
          </div>
        </Tip>
        <Tip tip="Capital currently locked in active window positions, vs the configured maximum. Matched pairs (structurally profitable) don't count against the capital limit">
          {(() => {
            const deployed = state?.capital_deployed ?? 0;
            const matchedCapital = allActiveWindows.reduce((sum, w) => {
              const matched = Math.min(w.upInventory ?? 0, w.downInventory ?? 0);
              return sum + matched * ((w.upAvgCost ?? 0) + (w.downAvgCost ?? 0));
            }, 0);
            // For merge-heavy strategies (babyboner), show total volume when deployed is near 0
            const totalVolume = allActiveWindows.reduce((sum, w) => sum + (w.totalBuyCost ?? 0), 0);
            const showVolume = deployed < 1 && totalVolume > 1;
            return (
              <div className="rounded-lg border p-3 cursor-help">
                <div className="text-xs text-muted-foreground">{showVolume ? "Volume (recycling)" : "Capital Deployed"}</div>
                <div className="text-lg font-bold tabular-nums">{fmt(showVolume ? totalVolume : deployed)}</div>
                <div className="text-xs text-muted-foreground">
                  / {fmt(balanceProtection?.effective_max_capital ?? config.max_capital_usd)} max
                  {matchedCapital > 1 && <span className="text-green-600"> ({fmt(matchedCapital)} in pairs)</span>}
                </div>
              </div>
            );
          })()}
        </Tip>
      </div>

      {/* Balance protection */}
      {balanceProtection && config.balance_usd != null && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tip tip="Current balance = starting balance + total P&L">
            <div className="rounded-lg border p-3 cursor-help">
              <div className="text-xs text-muted-foreground">Balance</div>
              <div className={`text-lg font-bold tabular-nums ${balanceProtection.current_balance >= config.balance_usd ? "text-green-600" : "text-red-600"}`}>
                {fmt(balanceProtection.current_balance)}
              </div>
              <div className="text-xs text-muted-foreground">of {fmt(config.balance_usd)} initial</div>
            </div>
          </Tip>
          <Tip tip="Profits locked via ratchet. This capital is protected from further losses">
            <div className="rounded-lg border p-3 cursor-help">
              <div className="text-xs text-muted-foreground">Locked</div>
              <div className="text-lg font-bold tabular-nums text-blue-600">
                {fmt(balanceProtection.locked_amount)}
              </div>
              <div className="text-xs text-muted-foreground">protected</div>
            </div>
          </Tip>
          <Tip tip="Capital above the lock that can still be lost. Strategy auto-stops when this hits $0">
            <div className="rounded-lg border p-3 cursor-help">
              <div className="text-xs text-muted-foreground">Working Capital</div>
              <div className={`text-lg font-bold tabular-nums ${
                balanceProtection.working_capital <= 0 ? "text-red-600" :
                balanceProtection.working_capital < (config.balance_usd ?? 0) * 0.25 ? "text-red-500" :
                balanceProtection.working_capital < (config.balance_usd ?? 0) * 0.5 ? "text-amber-500" :
                "text-green-600"
              }`}>
                {fmt(balanceProtection.working_capital)}
              </div>
              {balanceProtection.drawdown_scale != null && balanceProtection.drawdown_scale < 1.0 && (
                <div className={`text-xs font-medium ${balanceProtection.drawdown_scale < 0.5 ? "text-red-600" : "text-amber-600"}`}>
                  {(balanceProtection.drawdown_scale * 100).toFixed(0)}% capacity
                </div>
              )}
            </div>
          </Tip>
          <Tip tip="Highest balance ever reached. Determines the lock level">
            <div className="rounded-lg border p-3 cursor-help">
              <div className="text-xs text-muted-foreground">High Water Mark</div>
              <div className="text-lg font-bold tabular-nums">
                {fmt(balanceProtection.high_water_balance)}
              </div>
            </div>
          </Tip>
        </div>
      )}

      <StrategyCharts strategyId={config.id} isActive={isActive} />

      {/* Strategy narration — winding down / drawdown / scaling state + scan status */}
      {isActive && (() => {
        const parts: string[] = [];
        const activeWinCount = ((custom?.activeWindows as unknown[]) ?? []).length;
        if (isWindingDown) {
          parts.push(`Winding down — completing ${activeWinCount} window${activeWinCount !== 1 ? "s" : ""}, no new entries`);
        }
        if (balanceProtection && config.balance_usd != null) {
          const ds = balanceProtection.drawdown_scale ?? 1.0;
          const pnlPct = config.balance_usd ? ((state?.total_pnl ?? 0) / config.balance_usd * 100) : 0;
          if (ds < 1.0) {
            parts.push(`Drawdown: ${(ds * 100).toFixed(0)}% capacity (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% P&L)`);
          } else if (!isWindingDown && pnlPct > 5) {
            parts.push(`Healthy: +${pnlPct.toFixed(1)}% from initial, full capacity`);
          } else if (!isWindingDown && pnlPct < -5) {
            parts.push(`${pnlPct.toFixed(1)}% from initial, full capacity`);
          }
        }
        const scanStatus = (custom?.scanStatus as string) ?? "";
        if (scanStatus && !isWindingDown) parts.push(scanStatus);
        if (parts.length === 0) return null;
        const drawdownActive = (balanceProtection?.drawdown_scale ?? 1.0) < 1.0;
        return (
          <div className={`rounded border border-dashed px-3 py-2 text-xs italic ${
            isWindingDown ? "border-orange-300 bg-orange-50 text-orange-700" :
            drawdownActive ? "border-amber-300 bg-amber-50 text-amber-700" :
            "text-muted-foreground"
          }`}>
            {parts.join(" · ")}
          </div>
        );
      })()}

      {/* Legend for tickAction abbreviations */}
      <TickActionLegend />

      {/* Unified Adaptive detail */}
      {isUnified && <UnifiedDetail custom={custom} isActive={isActive} isWindingDown={isWindingDown} config={config} />}

      {/* Orchestrator detail */}
      {isOrchestrator && (() => {
        const orchStats = custom?.stats as { totalPnl?: number; windowsTraded?: number; perTactic?: Record<string, { windows: number; pnl: number; wins: number }>; perRegime?: Record<string, { windows: number; pnl: number }> } | undefined;
        const scanStatus = (custom?.scanStatus as string) ?? "";
        const assetRegimes = custom?.assetRegimes as Record<string, { confirmedRegime: string; confidence: number; streak: number; emaScores?: Record<string, number> }> | undefined;
        const orchActiveWindows = (custom?.activeWindows as Array<{
          market: { title: string }; cryptoSymbol: string; tacticId: string;
          confirmedDirection: string | null;
          upInventory: number; downInventory: number;
          upAvgCost: number; downAvgCost: number;
          upBidOrderId: string | null; downBidOrderId: string | null;
          upBidPrice: number; downBidPrice: number;
          fillCount: number; sellCount: number; flipCount: number;
          windowEndTime: number; windowOpenTime: number; tickAction?: string;
          lastUpBestAsk?: number; lastDnBestAsk?: number;
        }>) ?? [];
        const orchCompletedWindows = (custom?.completedWindows as Array<{
          title: string; cryptoSymbol: string; tacticId: string; regime: string;
          outcome: string; matchedPairs: number; netPnl: number; fillCount: number;
          completedAt: string; windowDurationMs: number;
        }>) ?? [];
        const activeWins = orchActiveWindows.filter(w => w.windowEndTime > Date.now());
        const resolvingWins = orchActiveWindows.filter(w => w.windowEndTime <= Date.now());

        return (
          <div className="space-y-4">
            {/* Per-tactic stats */}
            {orchStats && orchStats.windowsTraded && orchStats.windowsTraded > 0 && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {Object.entries(orchStats.perTactic ?? {}).map(([tid, ts]) => (
                  <div key={tid} className="rounded-lg border p-2">
                    <div className="text-xs font-medium">{tid}</div>
                    <div className="flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                      <span>{ts.windows}w</span>
                      <span className={ts.pnl >= 0 ? "text-green-500" : "text-red-500"}>{fmt(ts.pnl)}</span>
                      <span>{ts.windows > 0 ? ((ts.wins / ts.windows) * 100).toFixed(0) : 0}%</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Regime status */}
            {assetRegimes && Object.keys(assetRegimes).length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-1">Regime Status</h4>
                <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                  {Object.entries(assetRegimes).map(([key, rs]) => (
                    <div key={key} className="rounded border px-2 py-1 text-[11px]">
                      <span className="font-medium">{key}</span>{" "}
                      <Badge variant="outline" className="text-[9px] ml-1">{rs.confirmedRegime}</Badge>
                      <span className="text-muted-foreground ml-1">{(rs.confidence * 100).toFixed(0)}% s={rs.streak}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Scan status */}
            {scanStatus && <div className="text-xs text-muted-foreground">{scanStatus}</div>}

            {/* Active windows */}
            {activeWins.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-1">Active Windows ({activeWins.length})</h4>
                <div className="rounded-lg border overflow-hidden">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead className="text-[10px] py-1 px-2">Market</TableHead>
                      <TableHead className="text-[10px] py-1 px-2">Tactic</TableHead>
                      <TableHead className="text-[10px] py-1 px-2">Inv</TableHead>
                      <TableHead className="text-[10px] py-1 px-2">Action</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {activeWins.map((w, i) => {
                        const pairCost = w.upInventory > 0 && w.downInventory > 0 ? w.upAvgCost + w.downAvgCost : 0;
                        return (
                          <TableRow key={i}>
                            <TableCell className="text-[11px] py-1 px-2">{compactTitle(w.market.title) || w.market.title.slice(0, 25)}</TableCell>
                            <TableCell className="text-[11px] py-1 px-2">
                              <Badge variant="outline" className="text-[9px]">{w.tacticId}</Badge>
                            </TableCell>
                            <TableCell className="text-[11px] py-1 px-2">
                              {fmtInv(w.upInventory)}↑/{fmtInv(w.downInventory)}↓
                              {pairCost > 0 && <span className={`ml-1 ${pairCost < 0.93 ? "text-green-500" : "text-red-500"}`}>pc={pairCost.toFixed(2)}</span>}
                            </TableCell>
                            <TableCell className="text-[11px] py-1 px-2 text-muted-foreground">{w.tickAction ?? ""}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {/* Resolving */}
            {resolvingWins.length > 0 && (
              <div className="text-xs text-muted-foreground">{resolvingWins.length} window(s) awaiting resolution</div>
            )}

            {/* Completed windows (last 10) */}
            {orchCompletedWindows.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-1">Recent Completed ({orchCompletedWindows.length})</h4>
                <div className="rounded-lg border overflow-hidden">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead className="text-[10px] py-1 px-2">Market</TableHead>
                      <TableHead className="text-[10px] py-1 px-2">Tactic</TableHead>
                      <TableHead className="text-[10px] py-1 px-2">Regime</TableHead>
                      <TableHead className="text-[10px] py-1 px-2">Result</TableHead>
                      <TableHead className="text-[10px] py-1 px-2">P&L</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {orchCompletedWindows.slice(-10).reverse().map((w, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-[11px] py-1 px-2">{compactTitle(w.title) || w.title.slice(0, 25)}</TableCell>
                          <TableCell className="text-[11px] py-1 px-2"><Badge variant="outline" className="text-[9px]">{w.tacticId}</Badge></TableCell>
                          <TableCell className="text-[11px] py-1 px-2"><Badge variant="outline" className="text-[9px]">{w.regime}</Badge></TableCell>
                          <TableCell className="text-[11px] py-1 px-2">{w.outcome} ({w.matchedPairs}p)</TableCell>
                          <TableCell className={`text-[11px] py-1 px-2 ${w.netPnl >= 0 ? "text-green-500" : "text-red-500"}`}>{fmt(w.netPnl)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Conviction Maker — single-sided inventory windows */}
      {isConviction && (() => {
        const cvWindows = (custom?.activeWindows as Array<{
          market: { title: string }; cryptoSymbol: string;
          convictionDirection: string; confirmedDirection: string | null;
          signalStrengthAtEntry: number;
          upInventory: number; downInventory: number;
          upAvgCost: number; downAvgCost: number;
          bidOrderId: string | null; bidSide: string | null;
          bidPrice: number; bidSize: number;
          fillPhase: string;
          totalBuyCost: number; windowEndTime: number;
          fillCount: number; flipCount: number;
          tickAction?: string;
          binancePrediction?: "UP" | "DOWN" | null;
        }>) ?? [];
        const cvActive = cvWindows.filter(w => w.windowEndTime > Date.now());
        const cvResolving = cvWindows.filter(w => w.windowEndTime <= Date.now());
        const cvCompleted = (custom?.completedWindows as Array<{
          title: string; convictionSide: string; outcome: string;
          upInventory: number; downInventory: number;
          upAvgCost: number; downAvgCost: number;
          netPnl: number; signalStrength: number; fillCount: number;
          correct: boolean; completedAt: string; flipCount: number;
        }>) ?? [];
        const maxFlips = ((typeof config.params === "object" ? config.params as Record<string, unknown> : {})?.max_flips_before_sit_out as number) ?? 2;

        return (
          <WindowSection
            sectionTitle="Active Windows"
            sectionTip="Conviction windows: single-sided bets on confident signals. Only bids on one side, holds to resolution."
            active={cvActive.map((w, i) => {
              const side = (w.convictionDirection ?? w.confirmedDirection) as "UP" | "DOWN" | null;
              const inv = side === "UP" ? (w.upInventory ?? 0) : (w.downInventory ?? 0);
              const cost = side === "UP" ? (w.upAvgCost ?? 0) : (w.downAvgCost ?? 0);
              return (
                <SingleSideActiveRow key={i}
                  title={w.market?.title ?? ""} compact={compactTitle(w.market?.title ?? "") || w.cryptoSymbol}
                  chips={side ? (
                    <Tip tip={`Conviction: betting ${side} at ${((w.signalStrengthAtEntry ?? 0) * 100).toFixed(0)}% signal. Phase: ${w.fillPhase ?? "?"}`}>
                      <span className={`rounded px-1.5 py-0 text-[10px] font-bold cursor-help ${
                        side === "UP" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
                      }`}>{side} {((w.signalStrengthAtEntry ?? 0) * 100).toFixed(0)}%</span>
                    </Tip>
                  ) : undefined}
                  inventory={inv} inventorySide={side}
                  avgCost={cost} scale={w.bidSize ?? 30}
                  bidOrderId={w.bidOrderId} bidSide={w.bidSide} bidPrice={w.bidPrice ?? 0}
                  fillCount={w.fillCount} flipCount={w.flipCount} maxFlips={maxFlips}
                  tickAction={w.tickAction ? <TickAction text={w.tickAction} /> : undefined}
                  timeLeftMs={Math.max(0, w.windowEndTime - Date.now())}
                />
              );
            })}
            resolving={cvResolving.map((w, i) => {
              const side = (w.convictionDirection ?? w.confirmedDirection) as "UP" | "DOWN" | null;
              const inv = side === "UP" ? (w.upInventory ?? 0) : (w.downInventory ?? 0);
              const cost = side === "UP" ? (w.upAvgCost ?? 0) : (w.downAvgCost ?? 0);
              const prediction = (w.binancePrediction ?? w.confirmedDirection) as "UP" | "DOWN" | null;
              const willWin = prediction && side ? prediction === side : null;
              const estPnl = prediction && inv > 0 ? (
                prediction === side ? inv * (1.0 - cost) : -(inv * cost)
              ) : null;
              return (
                <SingleSideResolvingRow key={`r-${i}`}
                  title={w.market?.title ?? ""} compact={compactTitle(w.market?.title ?? "") || w.cryptoSymbol}
                  chips={side ? (
                    <span className={`font-medium ${side === "UP" ? "text-green-600" : "text-red-600"}`}>
                      {side} {((w.signalStrengthAtEntry ?? 0) * 100).toFixed(0)}%
                    </span>
                  ) : undefined}
                  inventory={inv} inventorySide={side}
                  avgCost={cost} scale={w.bidSize ?? 30}
                  prediction={prediction} estPnl={estPnl}
                  predictionText={prediction ? (willWin === true ? `Predicts win (${prediction})` : willWin === false ? `Predicts loss (${prediction})` : undefined) : undefined}
                />
              );
            })}
            completed={cvCompleted.slice(-20).reverse().map((w, i) => {
              const side = w.convictionSide as "UP" | "DOWN" | null;
              const inv = side === "UP" ? (w.upInventory ?? 0) : (w.downInventory ?? 0);
              const cost = side === "UP" ? (w.upAvgCost ?? 0) : (w.downAvgCost ?? 0);
              return (
                <SingleSideCompletedRow key={i}
                  title={w.title} compact={compactTitle(w.title) || w.title?.slice(0, 25)}
                  chips={side ? (
                    <Tip tip={w.correct ? "Conviction matched outcome" : "Conviction was wrong"}>
                      <span className={`cursor-help ${w.correct ? "text-green-600 font-medium" : "text-red-600 font-medium"}`}>
                        {side}{w.correct ? " +" : " -"}
                      </span>
                    </Tip>
                  ) : <span className="text-muted-foreground">--</span>}
                  inventory={inv} inventorySide={side}
                  avgCost={cost} scale={Math.max(inv, 1)}
                  netPnl={w.netPnl ?? 0} fillCount={w.fillCount ?? 0} flipCount={w.flipCount}
                  completedAt={w.completedAt}
                />
              );
            })}
          />
        );
      })()}

      {/* Certainty Taker windows */}
      {isCertaintyTaker && (() => {
        const ctWindows = (custom?.activeWindows as Array<{
          market: { title: string }; cryptoSymbol: string;
          strikePrice: number | null; strikeDirection: string;
          windowEndTime: number; windowDurationMs: number;
          lastPTrue: number; lastDelta: number; lastSpotPrice: number;
          winningSide: string | null;
          inventory: number; avgCost: number; inventorySide: string | null;
          totalCost: number; totalFees: number; fillCount: number;
          tickAction?: string;
          binancePrediction?: "UP" | "DOWN" | null;
        }>) ?? [];
        const ctActive = ctWindows.filter(w => w.windowEndTime > Date.now());
        const ctResolving = ctWindows.filter(w => w.windowEndTime <= Date.now());
        const ctCompleted = (custom?.completedWindows as Array<{
          title: string; cryptoSymbol: string; outcome: string; winningSide: string | null;
          inventory: number; avgCost: number; totalCost: number; totalFees: number;
          netPnl: number; fillCount: number; correct: boolean; completedAt: string;
          lastPTrue: number;
        }>) ?? [];
        const minPTrue = ((typeof config.params === "object" ? config.params as Record<string, unknown> : {})?.min_p_true as number) ?? 0.95;
        return (
          <WindowSection
            sectionTitle="Active Windows"
            sectionTip="Certainty taker: waits for P_true > threshold, sweeps winning side with FAK orders."
            active={ctActive.map((w, i) => {
              const pTrueReady = w.lastPTrue >= minPTrue;
              return (
                <SingleSideActiveRow key={i}
                  title={w.market?.title ?? ""} compact={compactTitle(w.market?.title ?? "") || w.cryptoSymbol}
                  chips={<>
                    <Tip tip={`P_true = ${w.lastPTrue.toFixed(3)} (threshold: ${minPTrue}). ${pTrueReady ? "Ready to sweep!" : "Waiting for certainty"}`}>
                      <span className={`rounded px-1 py-0 text-[10px] font-medium cursor-help ${
                        pTrueReady ? "bg-green-100 text-green-800" : w.lastPTrue > 0.80 ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-600"
                      }`}>P={w.lastPTrue.toFixed(3)}</span>
                    </Tip>
                    {w.winningSide && (
                      <Tip tip={`Predicted winner: ${w.winningSide} (spot ${w.strikeDirection} strike)`}>
                        <span className={`text-[10px] font-bold cursor-help ${w.winningSide === "UP" ? "text-green-700" : "text-red-700"}`}>{w.winningSide}</span>
                      </Tip>
                    )}
                    <Tip tip={`Strike: ${w.strikePrice != null ? `$${w.strikePrice.toLocaleString()}` : "pending"} (${w.strikeDirection}). Spot: $${w.lastSpotPrice?.toLocaleString() ?? "?"}`}>
                      <span className="tabular-nums cursor-help text-muted-foreground">{w.strikePrice != null ? `K=$${w.strikePrice.toLocaleString()}` : "K=?"}</span>
                    </Tip>
                    {w.totalCost > 0 && (
                      <Tip tip={`Total capital deployed: $${w.totalCost.toFixed(2)}`}>
                        <span className="tabular-nums cursor-help text-muted-foreground">{fmt(w.totalCost)}</span>
                      </Tip>
                    )}
                  </>}
                  inventory={w.inventory ?? 0} inventorySide={w.inventorySide as "UP" | "DOWN" | null}
                  avgCost={w.avgCost ?? 0} costDp={3} scale={50}
                  bidOrderId={null} bidSide={null} bidPrice={0}
                  fillCount={w.fillCount}
                  tickAction={w.tickAction ? <TickAction text={w.tickAction} /> : undefined}
                  narrative={pTrueReady ? "Sweeping..." : "Watching for certainty"}
                  timeLeftMs={Math.max(0, w.windowEndTime - Date.now())}
                />
              );
            })}
            resolving={ctResolving.map((w, i) => {
              const prediction = (w.binancePrediction ?? w.winningSide) as "UP" | "DOWN" | null;
              const willWin = prediction && w.inventorySide ? prediction === w.inventorySide : null;
              const estPnl = prediction && w.inventory > 0 ? (
                prediction === w.inventorySide ? w.inventory * (1.0 - (w.avgCost ?? 0)) : -(w.inventory * (w.avgCost ?? 0))
              ) : null;
              return (
                <SingleSideResolvingRow key={`r-${i}`}
                  title={w.market?.title ?? ""} compact={compactTitle(w.market?.title ?? "") || w.cryptoSymbol}
                  chips={w.winningSide ? (
                    <span className={`font-medium ${w.winningSide === "UP" ? "text-green-600" : "text-red-600"}`}>{w.winningSide}</span>
                  ) : undefined}
                  inventory={w.inventory ?? 0} inventorySide={w.inventorySide as "UP" | "DOWN" | null}
                  avgCost={w.avgCost ?? 0} costDp={3} scale={50}
                  prediction={prediction} estPnl={estPnl}
                  predictionText={prediction ? (willWin === true ? `Predicts win (${prediction})` : willWin === false ? `Predicts loss (${prediction})` : undefined) : undefined}
                />
              );
            })}
            completed={ctCompleted.slice(-20).reverse().map((w, i) => (
              <SingleSideCompletedRow key={i}
                title={w.title} compact={compactTitle(w.title) || w.cryptoSymbol || w.title?.slice(0, 25)}
                chips={<>
                  <Tip tip={w.correct ? "Correct prediction" : "Wrong prediction"}>
                    <span className={`rounded px-1 py-0 text-[10px] font-medium cursor-help ${
                      w.outcome === "UP" ? "bg-green-100 text-green-800" : w.outcome === "DOWN" ? "bg-red-100 text-red-800" : "bg-gray-100"
                    }`}>{w.outcome}</span>
                  </Tip>
                  <span className="tabular-nums text-muted-foreground">P={w.lastPTrue?.toFixed(3) ?? "?"}</span>
                </>}
                inventory={w.inventory ?? 0} inventorySide={w.winningSide as "UP" | "DOWN" | null}
                avgCost={w.avgCost ?? 0} costDp={3} scale={Math.max(w.inventory ?? 1, 1)}
                netPnl={w.netPnl ?? 0} fillCount={w.fillCount ?? 0}
                completedAt={w.completedAt}
              />
            ))}
          />
        );
      })()}

      {/* Avellaneda Maker windows */}
      {isAvellaneda && (() => {
        const amWindows = (custom?.activeWindows as Array<{
          market: { title: string }; cryptoSymbol: string;
          strikePrice: number | null; strikeDirection: string;
          windowEndTime: number; windowDurationMs: number;
          lastPTrue: number; lastDelta: number; lastSpotPrice: number;
          lastReservationPrice: number; lastEffectiveSpread: number;
          lastRealizedVol: number;
          upInventory: number; downInventory: number;
          upAvgCost: number; downAvgCost: number;
          upBidOrderId: string | null; upBidPrice: number; upBidSize: number;
          downBidOrderId: string | null; downBidPrice: number; downBidSize: number;
          totalMerged: number; mergedPnl: number;
          totalBuyCost: number; realizedPnl: number;
          fillCount: number; sellCount: number; takerFills: number;
          regime: string; tickAction?: string;
          binancePrediction?: "UP" | "DOWN" | null;
        }>) ?? [];
        const amActive = amWindows.filter(w => w.windowEndTime > Date.now());
        const amResolving = amWindows.filter(w => w.windowEndTime <= Date.now());
        const amCompleted = (custom?.completedWindows as Array<{
          title: string; cryptoSymbol: string; outcome: string;
          upInventory: number; downInventory: number;
          upAvgCost: number; downAvgCost: number;
          pairCost: number | null; matchedPairs: number;
          totalMerged: number; mergedPnl: number;
          netPnl: number; fillCount: number; takerFills: number;
          completedAt: string;
        }>) ?? [];
        const REGIME_TIPS: Record<string, string> = {
          maker: "Quoting both sides with AS inventory shading",
          taker: "P_true at extreme -- sweeping winning side with FAK orders",
          transition: "Approaching regime boundary -- reduced bid size",
          danger_zone: "Near expiry -- widened spread, reduced size",
          delta_kill: "Delta too high -- quotes cancelled, spot near strike",
          time_kill: "Exit buffer -- flattening inventory before resolution",
        };
        const regimeColor = (r: string) =>
          r === "maker" ? "bg-green-100 text-green-800" :
          r === "taker" ? "bg-orange-100 text-orange-800" :
          r === "transition" ? "bg-yellow-100 text-yellow-800" :
          r === "danger_zone" ? "bg-amber-100 text-amber-800" :
          "bg-red-100 text-red-800";
        return (
          <WindowSection
            sectionTitle="Active Windows"
            sectionTip="Avellaneda-Stoikov market maker: quotes both sides using P_true from Chainlink oracle, Delta-based spread, inventory shading."
            active={amActive.map((w, i) => {
              const up = w.upInventory ?? 0;
              const dn = w.downInventory ?? 0;
              const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
              return (
                <ActiveWindowRow key={i}
                  title={w.market?.title ?? ""} compact={compactTitle(w.market?.title ?? "") || w.cryptoSymbol}
                  chips={<>
                    <Tip tip={REGIME_TIPS[w.regime] ?? w.regime}>
                      <span className={`rounded px-1.5 py-0 text-[10px] font-bold cursor-help ${regimeColor(w.regime)}`}>{w.regime?.replace("_", " ")}</span>
                    </Tip>
                    <Tip tip={`V = P_true: ${(w.lastPTrue ?? 0).toFixed(3)}, Vr = reservation: ${(w.lastReservationPrice ?? 0).toFixed(3)}`}>
                      <span className="tabular-nums cursor-help text-muted-foreground">V={w.lastPTrue?.toFixed(3) ?? "?"} Vr={w.lastReservationPrice?.toFixed(3) ?? "?"}</span>
                    </Tip>
                    <Tip tip={`Spread = ${(w.lastEffectiveSpread ?? 0).toFixed(3)}, Vol = ${(w.lastRealizedVol ?? 0).toFixed(3)}%`}>
                      <span className="tabular-nums cursor-help text-muted-foreground">s={w.lastEffectiveSpread?.toFixed(3) ?? "?"}</span>
                    </Tip>
                  </>}
                  up={up} dn={dn} upAvgCost={w.upAvgCost ?? 0} dnAvgCost={w.downAvgCost ?? 0}
                  scale={w.upBidSize ?? w.downBidSize ?? 1} pairCost={pairCost}
                  upBidActive={!!w.upBidOrderId} dnBidActive={!!w.downBidOrderId}
                  fillCount={w.fillCount} takerFills={w.takerFills}
                  totalMerged={w.totalMerged} mergedPnl={w.mergedPnl}
                  tickAction={w.tickAction ? <TickAction text={w.tickAction} /> : undefined}
                  narrative={`${w.regime === "maker" ? "Quoting" : w.regime?.replace("_", " ")} K=${w.strikePrice != null ? `$${w.strikePrice.toLocaleString()}` : "?"}`}
                  timeLeftMs={Math.max(0, w.windowEndTime - Date.now())}
                />
              );
            })}
            resolving={amResolving.map((w, i) => {
              const up = w.upInventory ?? 0;
              const dn = w.downInventory ?? 0;
              const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
              const prediction = w.binancePrediction;
              const estPnl = prediction && (up > 0 || dn > 0) ? (() => {
                const winPayout = prediction === "UP" ? up * (1 - (w.upAvgCost ?? 0)) : dn * (1 - (w.downAvgCost ?? 0));
                const loseLoss = prediction === "UP" ? dn * (w.downAvgCost ?? 0) : up * (w.upAvgCost ?? 0);
                return winPayout - loseLoss;
              })() : null;
              return (
                <ResolvingWindowRow key={`r-${i}`}
                  title={w.market?.title ?? ""} compact={compactTitle(w.market?.title ?? "") || w.cryptoSymbol}
                  chips={<span className={`rounded px-1 py-0 text-[10px] font-medium ${regimeColor(w.regime)}`}>{w.regime?.replace("_", " ")}</span>}
                  up={up} dn={dn} upAvgCost={w.upAvgCost ?? 0} dnAvgCost={w.downAvgCost ?? 0}
                  scale={1} pairCost={pairCost}
                  prediction={prediction} estPnl={estPnl}
                />
              );
            })}
            completed={amCompleted.slice(-20).reverse().map((w, i) => {
              const up = w.upInventory ?? 0;
              const dn = w.downInventory ?? 0;
              const pairCost = w.pairCost ?? ((up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null);
              return (
                <CompletedWindowRow key={i}
                  title={w.title} compact={compactTitle(w.title) || w.cryptoSymbol || w.title?.slice(0, 25)}
                  outcome={w.outcome}
                  up={up} dn={dn} upAvgCost={w.upAvgCost ?? 0} dnAvgCost={w.downAvgCost ?? 0}
                  scale={Math.max(up + dn, 1)} pairCost={pairCost}
                  netPnl={w.netPnl ?? 0} fillCount={w.fillCount} takerFills={w.takerFills}
                  totalMerged={w.totalMerged} completedAt={w.completedAt}
                />
              );
            })}
          />
        );
      })()}

      {/* Sniper / generic windows (not directional, not unified, not conviction, not new strategies) */}
      {!isDirectional && !isUnified && !isConviction && !isCertaintyTaker && !isAvellaneda && (() => {
        const sniperWindows = (custom?.activeWindows as Array<{
          market: { title: string }; cryptoSymbol: string;
          windowEndTime: number; upInventory: number; downInventory: number;
          upAvgCost: number; downAvgCost: number;
          upBidOrderId: string | null; downBidOrderId: string | null;
          upBidPrice: number; downBidPrice: number;
          upBidSize: number; downBidSize: number;
          fillCount: number; sellCount: number; tickAction?: string;
        }>) ?? [];
        const sniperCompleted = (custom?.completedWindows as Array<{
          title: string; cryptoSymbol: string; outcome: string;
          upInventory: number; downInventory: number;
          upAvgCost: number; downAvgCost: number; pairCost: number;
          matchedPairs: number; netPnl: number; fillCount: number;
          completedAt: string;
        }>) ?? [];
        return (
          <WindowSection
            sectionTip="Binary prediction windows currently being traded. Each window is a crypto up-or-down market with a fixed time range"
            active={sniperWindows.map((w, i) => {
              const up = w.upInventory ?? 0;
              const dn = w.downInventory ?? 0;
              const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
              return (
                <ActiveWindowRow key={i}
                  title={w.market?.title ?? ""} compact={compactTitle(w.market?.title ?? "") || w.cryptoSymbol}
                  up={up} dn={dn} upAvgCost={w.upAvgCost ?? 0} dnAvgCost={w.downAvgCost ?? 0}
                  scale={w.upBidSize ?? w.downBidSize ?? 1} pairCost={pairCost}
                  upBidActive={!!w.upBidOrderId} dnBidActive={!!w.downBidOrderId}
                  fillCount={w.fillCount ?? 0}
                  tickAction={w.tickAction ? <TickAction text={w.tickAction} /> : undefined}
                  narrative={!w.tickAction ? windowNarrative(w, { windingDown: isWindingDown }) : undefined}
                  timeLeftMs={Math.max(0, w.windowEndTime - Date.now())}
                />
              );
            })}
            resolving={[]}
            completed={sniperCompleted.slice(-20).reverse().map((w, i) => {
              const up = w.upInventory ?? 0;
              const dn = w.downInventory ?? 0;
              const pairCost = w.pairCost ?? ((up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null);
              return (
                <CompletedWindowRow key={i}
                  title={w.title} compact={compactTitle(w.title) || w.cryptoSymbol}
                  outcome={w.outcome}
                  up={up} dn={dn} upAvgCost={w.upAvgCost ?? 0} dnAvgCost={w.downAvgCost ?? 0}
                  scale={Math.max(up + dn, 1)} pairCost={pairCost}
                  netPnl={w.netPnl ?? 0} fillCount={w.fillCount}
                  completedAt={w.completedAt}
                />
              );
            })}
          />
        );
      })()}

      {/* Open positions (split-arb) */}
      {positions.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium">Open Split Positions</h4>
          <div className="space-y-1">
            {positions.map((p, i) => (
              <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1.5 text-xs" title={p.market.title}>
                <span className="font-medium truncate max-w-[140px]">{compactTitle(p.market.title) || p.market.title.slice(0, 25)}</span>
                <span className="tabular-nums font-mono">
                  U:${p.upPrice.toFixed(3)} D:${p.downPrice.toFixed(3)}
                </span>
                <span className="tabular-nums font-mono">={(p.upPrice + p.downPrice).toFixed(3)}</span>
                <span>
                  <span className={p.upFilled ? "text-green-600" : "text-muted-foreground"}>
                    UP:{p.upFilled ? "Y" : "N"}
                  </span>{" "}
                  <span className={p.downFilled ? "text-green-600" : "text-muted-foreground"}>
                    DN:{p.downFilled ? "Y" : "N"}
                  </span>
                </span>
                <span className={`font-mono tabular-nums ${(p.netProfitPerShare ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
                  ${(p.netProfitPerShare ?? 0).toFixed(4)}/sh
                </span>
                <span className="ml-auto text-muted-foreground">{timeAgo(p.placedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active scalps (passive-mm) */}
      {scalps.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium">Active Scalp Markets</h4>
          <div className="space-y-1">
            {scalps.map((s, i) => (
              <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1.5 text-xs" title={s.market.title}>
                <span className="font-medium truncate max-w-[140px]">{compactTitle(s.market.title) || s.market.title.slice(0, 25)}</span>
                <span className="font-mono tabular-nums">
                  {(s.inventory || []).map((inv) => `${inv.side.toUpperCase()}:${inv.size}@${inv.avgCostBasis.toFixed(3)}`).join(" ") || "—"}
                </span>
                <span className="tabular-nums">{s.totalBuys}B/{s.totalSells}S</span>
                <span className={`ml-auto font-mono tabular-nums font-medium ${s.realizedPnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {fmt(s.realizedPnl)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Directional / conviction strategy stats */}
      {(isDirectional || isConviction) && windowsTraded > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tip tip="Total prediction windows traded, with wins (positive P&L) and losses">
            <div className="rounded-lg border p-3 cursor-help">
              <div className="text-xs text-muted-foreground">Windows</div>
              <div className="text-lg font-bold tabular-nums">{windowsTraded}</div>
              <div className="text-xs text-muted-foreground">
                <span className="text-green-600">{windowsWon}W</span>{" / "}
                <span className="text-red-600">{windowsLost}L</span>
              </div>
            </div>
          </Tip>
          <Tip tip="How often the conviction side matched the market outcome. Less important than pair cost for profitability">
            <div className="rounded-lg border p-3 cursor-help">
              <div className="text-xs text-muted-foreground">Dir. Accuracy</div>
              <div className={`text-lg font-bold tabular-nums ${directionalAccuracy >= 0.5 ? "text-green-600" : "text-red-600"}`}>
                {(directionalAccuracy * 100).toFixed(1)}%
              </div>
            </div>
          </Tip>
          <Tip tip="Cumulative realized profit/loss from all resolved windows">
            <div className="rounded-lg border p-3 cursor-help">
              <div className="text-xs text-muted-foreground">Total P&L</div>
              <div className={`text-lg font-bold tabular-nums ${totalPnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                {fmt(totalPnl)}
              </div>
            </div>
          </Tip>
          {isMaker && (
            <Tip tip="Total resting bids that were filled. Maker fills have zero fees on Polymarket">
              <div className="rounded-lg border p-3 cursor-help">
                <div className="text-xs text-muted-foreground">Maker Fills</div>
                <div className="text-lg font-bold tabular-nums">{totalMakerFills}</div>
                <div className="text-xs text-muted-foreground">
                  fees: {fmt(completedWindows.reduce((s, w) => s + (w.totalBuyCost ?? 0) * 0.02, 0))}
                </div>
              </div>
            </Tip>
          )}
        </div>
      )}

      {/* Directional windows */}
      {isDirectional && (() => {
        const maxFlips = ((typeof config.params === "object" ? config.params as Record<string, unknown> : {})?.max_flips_per_window as number) ?? 3;
        const phaseColors: Record<string, string> = {
          observing: "bg-yellow-100 text-yellow-800",
          active: "bg-blue-100 text-blue-800",
          winding_down: "bg-orange-100 text-orange-800",
        };
        const phaseDesc: Record<string, string> = {
          observing: "Gathering price data before placing bids",
          active: "Actively quoting and filling orders",
          winding_down: "Cancelling bids and selling excess inventory before window closes",
        };
        return (
          <WindowSection
            sectionTip="Binary prediction windows currently being traded. Each window is a crypto up-or-down market with a fixed time range"
            active={activeWindows.map((w, i) => {
              // Use peak inventory when current is 0 (auto-merge recycled everything)
              const rawUp = w.upInventory ?? 0;
              const rawDn = w.downInventory ?? 0;
              const peakUp = w.peakUpInventory ?? 0;
              const peakDn = w.peakDownInventory ?? 0;
              const up = (rawUp === 0 && rawDn === 0 && (peakUp > 0 || peakDn > 0)) ? peakUp : rawUp;
              const dn = (rawUp === 0 && rawDn === 0 && (peakUp > 0 || peakDn > 0)) ? peakDn : rawDn;
              const pairCost = (rawUp > 0 && rawDn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0)
                : (w.totalMerged ?? 0) > 0 && (w.totalBuyCost ?? 0) > 0 ? (w.totalBuyCost ?? 0) / (w.totalMerged ?? 1)
                : null;
              const phase = w.phase || "active";
              return (
                <ActiveWindowRow key={i}
                  title={w.market?.title ?? ""} compact={compactTitle(w.market?.title ?? "") || w.cryptoSymbol}
                  chips={<>
                    <Tip tip={phaseDesc[phase] || "Current trading phase"}>
                      <span className={`rounded px-1 py-0 text-[10px] font-medium cursor-help ${phaseColors[phase] || ""}`}>
                        {phase === "winding_down" ? "wind" : phase}
                      </span>
                    </Tip>
                    {w.convictionSide && (
                      <Tip tip="Signal direction and strength at entry. Higher % = stronger directional conviction for biasing bid sizes">
                        <span className={`cursor-help ${w.convictionSide === "UP" ? "text-green-600 font-medium" : "text-red-600 font-medium"}`}>
                          {w.convictionSide} {(w.signalStrengthAtEntry * 100).toFixed(0)}%
                        </span>
                      </Tip>
                    )}
                    {w.confirmedDirection && (
                      <Tip tip="Confirmed signal direction after hysteresis — survives the dead zone filter to avoid false flips">
                        <span className={`rounded px-1 py-0 text-[10px] font-medium cursor-help ${w.confirmedDirection === "UP" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
                          {w.confirmedDirection}
                        </span>
                      </Tip>
                    )}
                  </>}
                  up={up} dn={dn} upAvgCost={w.upAvgCost ?? 0} dnAvgCost={w.downAvgCost ?? 0}
                  scale={w.upBidSize ?? w.downBidSize ?? w.bidSize ?? Math.max(up + dn, 30)} pairCost={pairCost}
                  upBidActive={!!w.upBidOrderId} dnBidActive={!!w.downBidOrderId}
                  fillCount={w.fillCount ?? 0}
                  totalMerged={w.totalMerged} mergedPnl={w.totalMergePnl}
                  flipCount={w.flipCount} maxFlips={maxFlips}
                  tickAction={w.tickAction ? <TickAction text={w.tickAction} /> : undefined}
                  narrative={!w.tickAction ? windowNarrative({ ...w, fillCount: w.fillCount ?? 0, sellCount: w.sellCount ?? 0, upBidPrice: w.upBidPrice ?? 0, downBidPrice: w.downBidPrice ?? 0 }, { windingDown: isWindingDown }) : undefined}
                  timeLeftMs={Math.max(0, w.windowEndTime - Date.now())}
                />
              );
            })}
            resolving={resolvingWindows.map((w, i) => {
              const up = w.upInventory ?? 0;
              const dn = w.downInventory ?? 0;
              const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
              const prediction = w.binancePrediction ?? w.confirmedDirection;
              return (
                <ResolvingWindowRow key={`r-${i}`}
                  title={w.market?.title ?? ""} compact={compactTitle(w.market?.title ?? "") || (w.market?.title ?? "").slice(0, 25)}
                  chips={w.convictionSide ? (
                    <span className={`${w.convictionSide === "UP" ? "text-green-600" : "text-red-600"} font-medium`}>
                      {w.convictionSide} {(w.signalStrengthAtEntry * 100).toFixed(0)}%
                    </span>
                  ) : undefined}
                  up={up} dn={dn} upAvgCost={w.upAvgCost ?? 0} dnAvgCost={w.downAvgCost ?? 0}
                  scale={w.upBidSize ?? w.downBidSize ?? w.bidSize ?? 30} pairCost={pairCost}
                  prediction={prediction as "UP" | "DOWN" | undefined}
                  estPnl={prediction ? (() => {
                    const winSide = prediction === "UP" ? up : dn;
                    const loseSide = prediction === "UP" ? dn : up;
                    const winCost = prediction === "UP" ? (w.upAvgCost ?? 0) : (w.downAvgCost ?? 0);
                    const loseCost = prediction === "UP" ? (w.downAvgCost ?? 0) : (w.upAvgCost ?? 0);
                    return winSide * (1.0 - winCost) - loseSide * loseCost;
                  })() : undefined}
                />
              );
            })}
            completed={completedWindows.slice(-20).reverse().map((w, i) => {
              // For babyboner: auto-merge reduces final inventory to 0/0 — use peak inventory for display
              const hasPeakData = (w.peakUpInventory ?? 0) > 0 || (w.peakDownInventory ?? 0) > 0;
              const up = hasPeakData ? (w.peakUpInventory ?? 0) : (w.upInventory ?? 0);
              const dn = hasPeakData ? (w.peakDownInventory ?? 0) : (w.downInventory ?? 0);
              const rawUp = w.upInventory ?? 0;
              const rawDn = w.downInventory ?? 0;
              // Pair cost: use final inventory if present, else derive from totalBuyCost/totalMerged
              let pairCost: number | null = null;
              if (rawUp > 0 && rawDn > 0) {
                pairCost = (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0);
              } else if ((w.totalMerged ?? 0) > 0 && (w.totalBuyCost ?? 0) > 0) {
                // Effective pair cost = total spend / pairs merged
                pairCost = (w.totalBuyCost ?? 0) / (w.totalMerged ?? 1);
              }
              return (
                <CompletedWindowRow key={i}
                  title={w.title} compact={compactTitle(w.title) || w.title?.slice(0, 25)}
                  outcome={w.outcome}
                  chips={w.convictionSide ? (
                    <Tip tip={w.correct ? "Conviction direction matched the outcome (+)" : "Conviction direction was wrong (-)"}>
                      <span className={`cursor-help ${w.correct ? "text-green-600 font-medium" : "text-red-600 font-medium"}`}>
                        {w.convictionSide}{w.correct ? " +" : " -"}
                      </span>
                    </Tip>
                  ) : undefined}
                  up={up} dn={dn} upAvgCost={w.upAvgCost ?? 0} dnAvgCost={w.downAvgCost ?? 0}
                  scale={w.bidSize ?? Math.max(up + dn, 1)} pairCost={pairCost}
                  netPnl={w.netPnl ?? 0} fillCount={w.fillCount ?? 0}
                  flipCount={w.flipCount} maxFlips={maxFlips}
                  totalMerged={w.totalMerged}
                  completedAt={w.completedAt}
                  gammaConfirmed={w.gammaConfirmed}
                />
              );
            })}
          />
        );
      })()}

      {/* Activity log */}
      <div>
        <h4 className="mb-2 text-sm font-medium">
          Activity Log
          {logs.length > 0 && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              ({logs.length} entries)
            </span>
          )}
        </h4>
        <div className="max-h-60 overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-xs">
          {logs.length === 0 ? (
            <div className="py-4 text-center text-muted-foreground">
              {isActive
                ? "Waiting for log entries..."
                : "No log entries yet. Start the strategy to begin."}
            </div>
          ) : (
            <div className="space-y-0.5">
              {[...logs].reverse().map((entry, i) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground">
                    {fmtTime(entry.ts)}
                  </span>
                  <span
                    className={
                      entry.msg.startsWith("WARNING")
                        ? "text-amber-600"
                        : entry.msg.startsWith("Tick error")
                          ? "text-red-600"
                          : entry.msg.includes("COMPLETE") || entry.msg.includes("PROFIT") || entry.msg.includes("RESOLVED")
                            ? "text-green-600"
                            : ""
                    }
                  >
                    {entry.msg}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Config params editor */}
      <ParamsEditor
        config={config}
        isActive={isActive}
        isWindingDown={isWindingDown}
        hasTicks={(state?.ticks ?? 0) > 0}
        onSave={onSave}
        onClone={onClone}
        onReset={onReset}
      />
    </div>
  );
}

export default function StrategyPage() {
  const [configs, setConfigs] = useState<StrategyConfig[]>([]);
  const [statuses, setStatuses] = useState<
    Record<string, { running: boolean; winding_down?: boolean; config: StrategyConfig | null; state: StrategyState | null; balance_protection?: BalanceProtection | null }>
  >({});
  const [trades, setTrades] = useState<StrategyTrade[]>([]);
  const [walletOverview, setWalletOverview] = useState<WalletOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // New config form
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("split-arb");
  const [newMode, setNewMode] = useState<"paper" | "real">("paper");
  const [newMaxCapital, setNewMaxCapital] = useState("200");
  const [newBalance, setNewBalance] = useState("");
  const [newGroundedFills, setNewGroundedFills] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [cfgs, sts, tr, wo] = await Promise.all([
        api.strategyConfigs(),
        api.strategyStatuses(),
        api.strategyTrades(),
        api.strategyWalletOverview().catch(() => null),
      ]);
      setConfigs(cfgs);
      setStatuses(sts);
      setTrades(tr);
      setWalletOverview(wo);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const createConfig = async () => {
    if (!newName.trim()) return;
    try {
      await api.strategyCreateConfig({
        name: newName.trim(),
        strategy_type: newType,
        mode: newMode,
        max_capital_usd: parseFloat(newMaxCapital) || 200,
        ...(newBalance ? { balance_usd: parseFloat(newBalance) } : {}),
        ...((newType === "spread-sniper" || newType === "directional-maker" || newType === "unified-adaptive" || newType === "orchestrator" || newType === "scaling-safe-maker") && newMode === "paper"
          ? { params: { grounded_fills: newGroundedFills } as unknown as string }
          : {}),
      });
      setNewName("");
      setNewBalance("");
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const startStrategy = async (id: string) => {
    try {
      await api.strategyStart(id);
      setExpandedId(id);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const stopStrategy = async (id: string) => {
    try {
      await api.strategyStop(id);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const forceStopStrategy = async (id: string) => {
    try {
      await api.strategyForceStop(id);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const resetStrategy = async (id: string) => {
    try {
      await api.strategyReset(id);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const updateStrategy = async (id: string, updates: Partial<StrategyConfig>) => {
    try {
      await api.strategyUpdateConfig(id, updates);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const cloneStrategy = async (config: Partial<StrategyConfig>) => {
    try {
      await api.strategyCreateConfig(config);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const deleteStrategy = async (id: string) => {
    try {
      await api.strategyDelete(id);
      setExpandedId(null);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const runningCount = Object.values(statuses).filter((s) => s.running).length;
  const deployedCapital = Object.values(statuses)
    .filter((s) => s.running && s.config?.mode === "real" && s.state)
    .reduce((sum, s) => sum + (s.state?.capital_deployed ?? 0), 0);
  // Value of winning tokens between resolution and redemption (prevents balance "disappearing")
  const resolvingValue = Object.values(statuses)
    .filter((s) => s.running && s.config?.mode === "real" && s.state)
    .reduce((sum, s) => sum + ((s.state?.custom as Record<string, unknown>)?.resolvingValue as number ?? 0), 0);

  return (
    <TooltipProvider>
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Strategy Execution</h1>
        <Tip tip="Number of strategy DOs actively ticking (every 5s)">
          <Badge variant={runningCount > 0 ? "default" : "secondary"}>
            {runningCount > 0 ? `${runningCount} Running` : "All Stopped"}
          </Badge>
        </Tip>
      </div>

      {/* Wallet overview */}
      {walletOverview && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <Tip tip="Total value: USDC + deployed capital + resolving (won tokens pending redemption) + unredeemed + pending wins">
                <div className="cursor-help">
                  <p className="text-xs text-muted-foreground">Total Balance</p>
                  <p className="text-xl font-bold">{fmt(walletOverview.usdc_balance + deployedCapital + resolvingValue + walletOverview.unredeemed_value + walletOverview.pending_wins_value)}</p>
                </div>
              </Tip>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <Tip tip="USDC.e available in the trading wallet">
                <div className="cursor-help">
                  <p className="text-xs text-muted-foreground">USDC Balance</p>
                  <p className="text-xl font-bold">{fmt(walletOverview.usdc_balance)}</p>
                </div>
              </Tip>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <Tip tip="Capital currently deployed across all running real-mode strategies">
                <div className="cursor-help">
                  <p className="text-xs text-muted-foreground">Deployed</p>
                  <p className="text-xl font-bold">{fmt(deployedCapital)}</p>
                </div>
              </Tip>
            </CardContent>
          </Card>
          {(resolvingValue > 0 || walletOverview.unredeemed_value > 0 || walletOverview.pending_wins_value > 0) && (
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <Tip tip={resolvingValue > 0
                ? "Winning tokens being redeemed back to USDC. This value temporarily leaves 'USDC Balance' after a window resolves and returns once redemption completes (~2 min)."
                : "Winning positions on-chain that haven't been redeemed yet. These need to be redeemed to convert back to USDC."}>
                <div className="cursor-help">
                  <p className="text-xs text-muted-foreground">{resolvingValue > 0 ? "Redeeming" : "Unredeemed"}</p>
                  <p className="text-xl font-bold text-amber-600">{fmt(resolvingValue + walletOverview.unredeemed_value + walletOverview.pending_wins_value)}</p>
                  {resolvingValue > 0 ? (
                    <p className="text-xs text-muted-foreground animate-pulse">in flight</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">{walletOverview.unredeemed_count + walletOverview.pending_wins_count} positions</p>
                  )}
                </div>
              </Tip>
            </CardContent>
          </Card>
          )}
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <Tip tip="POL (native token) for gas fees on Polygon">
                <div className="cursor-help">
                  <p className="text-xs text-muted-foreground">POL (Gas)</p>
                  <p className="text-xl font-bold">{walletOverview.pol_balance.toFixed(2)}</p>
                </div>
              </Tip>
            </CardContent>
          </Card>
        </div>
      )}

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Strategy configs */}
      <Card>
        <CardHeader>
          <CardTitle>Strategy Configurations</CardTitle>
        </CardHeader>
        <CardContent className="px-2 sm:px-6">
          {/* Desktop: single table so columns align. Mobile: stacked cards */}
          {/* Desktop table */}
          <table className="hidden sm:table w-full text-xs">
            <thead>
              <tr className="text-muted-foreground font-medium">
                <th className="w-6 py-1" />
                <th className="text-left py-1">Name</th>
                <th className="text-left py-1"><Tip tip="Strategy algorithm type"><span className="cursor-help">Type</span></Tip></th>
                <th className="text-left py-1"><Tip tip="Paper = simulated trades. Real = live CLOB orders"><span className="cursor-help">Mode</span></Tip></th>
                <th className="text-right py-1 px-1"><Tip tip="Total realized profit/loss across all completed windows"><span className="cursor-help">P&L</span></Tip></th>
                <th className="text-right py-1 px-1"><Tip tip="Windows won / windows lost"><span className="cursor-help">W/L</span></Tip></th>
                <th className="text-right py-1 px-1"><Tip tip="Win rate"><span className="cursor-help">Win%</span></Tip></th>
                <th className="text-right py-1 px-1"><Tip tip="Return on risk (P&L / allocated capital)"><span className="cursor-help">RoR%</span></Tip></th>
                <th className="text-left py-1 px-1">Status</th>
                <th className="text-right py-1">Actions</th>
              </tr>
            </thead>
            <tbody>
              {configs.map((c) => {
                const st = statuses[c.id];
                const isRunning = !!st?.running;
                const isWindingDown = !!st?.winding_down;
                const state = st?.state ?? null;
                const isExpanded = expandedId === c.id;
                const custom = state?.custom as Record<string, unknown> | undefined;
                const pnl = (state?.total_pnl ?? 0) as number;
                const activeWins = ((custom?.activeWindows as unknown[]) ?? []).length;
                const riskCapital = c.balance_usd ?? c.max_capital_usd;
                const { traded, wins, losses, winRate, returnOnRisk, totalCapitalCycled } = extractOverviewStats(custom, c.strategy_type, pnl, riskCapital);
                const bp = st?.balance_protection;
                const runTime = fmtRunTime(state?.cumulative_runtime_ms ?? (state?.ticks ?? 0) * (c.tick_interval_ms ?? 5000));
                return (
                  <React.Fragment key={c.id}>
                    <tr
                      className="cursor-pointer border-b hover:bg-muted/50"
                      onClick={() => setExpandedId(isExpanded ? null : c.id)}
                    >
                      <td className="py-2 px-1">
                        <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                      </td>
                      <td className="py-2 font-medium text-sm">{c.name}</td>
                      <td className="py-2"><Badge variant="outline" className="text-[10px]">{shortType(c.strategy_type)}</Badge></td>
                      <td className="py-2"><Badge variant={c.mode === "real" ? "destructive" : "secondary"} className="text-[10px]">{c.mode}</Badge></td>
                      <td className={`py-2 px-1 text-right font-mono tabular-nums ${pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {traded > 0 ? fmt(pnl) : "—"}
                      </td>
                      <td className="py-2 px-1 text-right font-mono tabular-nums">
                        {traded > 0 ? <><span className="text-green-600">{wins}</span>/<span className="text-red-600">{losses}</span></> : "—"}
                      </td>
                      <td className={`py-2 px-1 text-right font-mono tabular-nums ${winRate >= 0.5 ? "text-green-600" : winRate > 0 ? "text-red-600" : ""}`}>
                        {traded > 0 ? `${(winRate * 100).toFixed(0)}%` : "—"}
                      </td>
                      <td className="py-2 px-1 text-right font-mono tabular-nums">
                        <Tip tip={bp
                          ? `${fmt(pnl)} on ${fmt(riskCapital)} risked (${fmt(totalCapitalCycled)} cycled) | Bal ${fmt(bp.current_balance)} | Working ${fmt(bp.working_capital)}`
                          : `${fmt(pnl)} on ${fmt(riskCapital)} risked (${fmt(totalCapitalCycled)} cycled)`
                        }>
                          <span className={`cursor-help ${returnOnRisk >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {traded > 0 ? `${(returnOnRisk * 100).toFixed(1)}%` : "—"}
                          </span>
                        </Tip>
                      </td>
                      <td className="py-2 px-1 whitespace-nowrap">
                        {isWindingDown ? (
                          <Tip tip={`Winding down — completing ${activeWins} open window${activeWins !== 1 ? "s" : ""}, no new entries`}>
                            <Badge className="bg-orange-500 text-[10px] cursor-help">
                              Wind↓{activeWins > 0 ? ` ${activeWins}` : ""}
                              {runTime && <span> · {runTime}</span>}
                            </Badge>
                          </Tip>
                        ) : isRunning ? (
                          <Tip tip={runTime ? `Running for ${runTime}` : ""}>
                            <Badge className="bg-green-600 text-[10px] cursor-help">
                              {activeWins > 0 ? `${activeWins} active` : `${state?.ticks ?? 0} ticks`}
                              {runTime && <span> · {runTime}</span>}
                            </Badge>
                          </Tip>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">
                            Stopped{runTime && <span> · {runTime}</span>}
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        {isWindingDown ? (
                          <Button size="sm" variant="destructive" className="h-7 text-xs px-2" onClick={() => forceStopStrategy(c.id)}>Force Stop</Button>
                        ) : isRunning ? (
                          <Button size="sm" variant="destructive" className="h-7 text-xs px-2" onClick={() => stopStrategy(c.id)}>Stop</Button>
                        ) : (
                          <div className="flex gap-1 justify-end">
                            <Button size="sm" className="h-7 text-xs px-2" onClick={() => startStrategy(c.id)}>Start</Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs px-1.5 text-muted-foreground hover:text-destructive" onClick={() => deleteStrategy(c.id)}>Del</Button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={10} className="p-2 bg-muted/20">
                          <StrategyDetail config={c} isActive={isRunning} isWindingDown={isWindingDown} state={state} balanceProtection={st?.balance_protection} onReset={() => resetStrategy(c.id)} onSave={(updates) => updateStrategy(c.id, updates)} onClone={cloneStrategy} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {configs.length === 0 && !loading && (
                <tr><td colSpan={10} className="py-8 text-center text-muted-foreground">No strategy configurations yet</td></tr>
              )}
            </tbody>
          </table>

          {/* Mobile: card layout */}
          <div className="sm:hidden space-y-1">
            {configs.map((c) => {
              const st = statuses[c.id];
              const isRunning = !!st?.running;
              const isWindingDown = !!st?.winding_down;
              const state = st?.state ?? null;
              const isExpanded = expandedId === c.id;
              const custom = state?.custom as Record<string, unknown> | undefined;
              const pnl = (state?.total_pnl ?? 0) as number;
              const activeWins = ((custom?.activeWindows as unknown[]) ?? []).length;
              const riskCapital = c.balance_usd ?? c.max_capital_usd;
              const { traded, wins, losses, winRate, returnOnRisk, totalCapitalCycled } = extractOverviewStats(custom, c.strategy_type, pnl, riskCapital);
              const bp = st?.balance_protection;
              const runTime = fmtRunTime(state?.cumulative_runtime_ms ?? (state?.ticks ?? 0) * (c.tick_interval_ms ?? 5000));
              return (
                <React.Fragment key={c.id}>
                  <div
                    className="cursor-pointer rounded border px-2 py-2 hover:bg-muted/50"
                    onClick={() => setExpandedId(isExpanded ? null : c.id)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                      <span className="text-sm font-medium min-w-0 break-words">{c.name}</span>
                      <Badge variant="outline" className="text-[10px] shrink-0">{shortType(c.strategy_type)}</Badge>
                      <Badge variant={c.mode === "real" ? "destructive" : "secondary"} className="text-[10px] shrink-0">{c.mode}</Badge>
                      <span className={`ml-auto text-xs font-mono tabular-nums ${pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {traded > 0 ? fmt(pnl) : ""}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                        {traded > 0 && (
                          <span className="text-xs font-mono tabular-nums shrink-0">
                            <span className="text-green-600">{wins}W</span>/<span className="text-red-600">{losses}L</span>
                            <span className="ml-1 text-muted-foreground">{(winRate * 100).toFixed(0)}%</span>
                            {traded > 0 && (
                              <span className={`ml-1 ${returnOnRisk >= 0 ? "text-green-600" : "text-red-600"}`}>
                                RoR {(returnOnRisk * 100).toFixed(1)}%
                              </span>
                            )}
                          </span>
                        )}
                        {bp && (
                          <Tip tip={`Balance: ${fmt(bp.current_balance)} | Locked: ${fmt(bp.locked_amount)} | Working: ${fmt(bp.working_capital)} | HWM: ${fmt(bp.high_water_balance)}`}>
                            <span className={`text-xs font-mono tabular-nums cursor-help truncate ${
                              bp.working_capital <= 0 ? "text-red-600" :
                              bp.working_capital < (c.balance_usd ?? 0) * 0.25 ? "text-red-500" :
                              bp.working_capital < (c.balance_usd ?? 0) * 0.5 ? "text-amber-500" :
                              "text-green-600"
                            }`}>
                              {fmt(bp.current_balance)}{bp.locked_amount > 0 ? ` / ${fmt(bp.locked_amount)} locked` : ""}
                            </span>
                          </Tip>
                        )}
                        {runTime && <span className="text-xs text-muted-foreground shrink-0">{runTime}</span>}
                      </div>
                      {isWindingDown ? (
                        <Tip tip={`Winding down — completing ${activeWins} open window${activeWins !== 1 ? "s" : ""}, no new entries`}>
                          <Badge className="bg-orange-500 text-[10px] shrink-0 cursor-help">Wind↓{activeWins > 0 ? ` ${activeWins}` : ""}</Badge>
                        </Tip>
                      ) : isRunning ? (
                        <Badge className="bg-green-600 text-[10px] shrink-0">{activeWins > 0 ? `${activeWins} active` : `${state?.ticks ?? 0} ticks`}</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] shrink-0">Stopped</Badge>
                      )}
                      <div className="ml-auto flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                        {isWindingDown ? (
                          <Button size="sm" variant="destructive" className="h-7 text-xs px-2" onClick={() => forceStopStrategy(c.id)}>Force Stop</Button>
                        ) : isRunning ? (
                          <Button size="sm" variant="destructive" className="h-7 text-xs px-2" onClick={() => stopStrategy(c.id)}>Stop</Button>
                        ) : (
                          <>
                            <Button size="sm" className="h-7 text-xs px-2" onClick={() => startStrategy(c.id)}>Start</Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs px-1.5 text-muted-foreground hover:text-destructive" onClick={() => deleteStrategy(c.id)}>Del</Button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="rounded border bg-muted/20 p-2">
                      <StrategyDetail config={c} isActive={isRunning} isWindingDown={isWindingDown} state={state} balanceProtection={st?.balance_protection} onReset={() => resetStrategy(c.id)} onSave={(updates) => updateStrategy(c.id, updates)} onClone={cloneStrategy} />
                    </div>
                  )}
                </React.Fragment>
              );
            })}
            {configs.length === 0 && !loading && (
              <div className="py-8 text-center text-muted-foreground">No strategy configurations yet</div>
            )}
          </div>

          {/* Create new config */}
          <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
            <div className="flex-1 min-w-[120px]">
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. BTC Split Test"
                className="mt-1"
              />
            </div>
            <div className="min-w-[130px]">
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <select
                className="mt-1 block h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
              >
                {STRATEGY_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Mode</label>
              <select
                className="mt-1 block h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={newMode}
                onChange={(e) => setNewMode(e.target.value as "paper" | "real")}
              >
                <option value="paper">Paper</option>
                <option value="real">Real</option>
              </select>
            </div>
            {(newType === "spread-sniper" || newType === "directional-maker" || newType === "unified-adaptive" || newType === "orchestrator" || newType === "scaling-safe-maker") && newMode === "paper" && (
              <div className="flex items-end pb-0.5">
                <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newGroundedFills}
                    onChange={(e) => setNewGroundedFills(e.target.checked)}
                    className="rounded border"
                  />
                  Grounded fills
                </label>
              </div>
            )}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Max Capital ($)</label>
              <Input
                type="number"
                value={newMaxCapital}
                onChange={(e) => setNewMaxCapital(e.target.value)}
                className="mt-1 w-24"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Balance ($)</label>
              <Input
                type="number"
                value={newBalance}
                onChange={(e) => setNewBalance(e.target.value)}
                placeholder="off"
                className="mt-1 w-20"
                title="Starting bankroll for ratchet protection. Empty = disabled."
              />
            </div>
            <Button onClick={createConfig} disabled={!newName.trim()}>
              Create
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Recent trades */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Strategy Trades</CardTitle>
        </CardHeader>
        <CardContent className="px-2 sm:px-6">
          <div className="space-y-1">
            {trades.slice(0, 50).map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1 text-xs" title={t.title}>
                <span className="text-muted-foreground shrink-0">{fmtTime(t.timestamp)}</span>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {configs.find((c) => c.id === t.strategy_id)?.name ?? t.strategy_id.slice(0, 8)}
                </Badge>
                <span className="font-medium truncate max-w-[140px]">
                  {compactTitle(t.title) || t.title || t.market}
                </span>
                <Badge
                  variant={t.side === "BUY" ? "default" : t.side === "SELL" ? "destructive" : "secondary"}
                  className="text-[10px] shrink-0"
                >
                  {t.side}
                </Badge>
                <span className="tabular-nums font-mono">{t.size > 0 ? t.size.toFixed(0) : ""}@{t.price > 0 ? `$${t.price.toFixed(3)}` : ""}</span>
                {t.fee_amount > 0 && <span className="tabular-nums text-muted-foreground" title="Estimated maker rebate (fee equivalent)">rebate:{fmt(t.fee_amount)}</span>}
                {t.pnl !== 0 && (
                  <span className={`ml-auto font-medium tabular-nums ${t.pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {fmt(t.pnl)}
                  </span>
                )}
              </div>
            ))}
            {trades.length === 0 && !loading && (
              <div className="py-8 text-center text-muted-foreground">
                No trades yet
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
    </TooltipProvider>
  );
}
