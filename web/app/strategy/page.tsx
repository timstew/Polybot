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

function fmt(n: number | undefined | null) {
  if (n == null || isNaN(n)) return "$0.00";
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format inventory: integers as-is, fractional to 1-2dp, dust as <0.1 */
function fmtInv(n: number): string {
  if (n === 0) return "0";
  if (n < 0.1) return "<0.1";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(n < 10 ? 2 : 1);
}

function timeAgo(ts: string | number) {
  if (!ts) return "never";
  const t = typeof ts === "number" ? ts : new Date(ts).getTime();
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

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

function fmtRunTime(createdAt: string, lastTickAt: string, isRunning: boolean): string {
  if (!createdAt) return "";
  const start = new Date(createdAt.endsWith("Z") ? createdAt : createdAt + "Z").getTime();
  const end = isRunning ? Date.now() : (lastTickAt ? new Date(lastTickAt.endsWith("Z") ? lastTickAt : lastTickAt + "Z").getTime() : start);
  const ms = end - start;
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
];

/** Inline tooltip wrapper — keeps JSX compact. Children are the trigger element. */
function Tip({ tip, children }: { tip: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">{tip}</TooltipContent>
    </Tooltip>
  );
}

function InventoryBar({ up, down, scale }: { up: number; down: number; scale: number }) {
  const total = Math.max(up + down, scale, 1);
  const W = 80, H = 14;
  const upW = (up / total) * W;
  const dnW = (down / total) * W;
  const redX = W - dnW;
  const overlapX = Math.max(redX, 0);
  const overlapW = Math.max(Math.min(upW, W) - overlapX, 0);
  return (
    <Tip tip="Green = UP tokens, Red = DOWN tokens. Purple overlap = matched pairs. Fully matched inventory profits when pair cost < $1. One-sided (no overlap) loses full cost if that side loses.">
      <svg width={W} height={H} className="cursor-help inline-block align-middle" style={{ borderRadius: 2, background: "#e5e7eb" }}>
        {upW > 0 && <rect x={0} y={0} width={upW} height={H} fill="#22c55e" />}
        {dnW > 0 && <rect x={redX} y={0} width={dnW} height={H} fill="#ef4444" />}
        {overlapW > 0 && <rect x={overlapX} y={0} width={overlapW} height={H} fill="#a855f7" />}
      </svg>
    </Tip>
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

function extractOverviewStats(custom: Record<string, unknown> | undefined, strategyType: string, pnl: number) {
  const isUnified = strategyType === "unified-adaptive";

  // Sum totalBuyCost across all windows (active + completed) for capital efficiency
  const allWindows = [
    ...((custom?.activeWindows as Array<{ totalBuyCost?: number }>) ?? []),
    ...((custom?.completedWindows as Array<{ totalBuyCost?: number }>) ?? []),
  ];
  const totalCapitalUsed = allWindows.reduce((s, w) => s + (w.totalBuyCost ?? 0), 0);
  const capitalEfficiency = totalCapitalUsed > 0 ? pnl / totalCapitalUsed : 0;

  if (isUnified) {
    const stats = custom?.stats as { windowsTraded?: number; sniperWins?: number; makerWins?: number; totalPnl?: number } | undefined;
    const traded = stats?.windowsTraded ?? 0;
    const wins = (stats?.sniperWins ?? 0) + (stats?.makerWins ?? 0);
    const losses = traded - wins;
    const winRate = traded > 0 ? wins / traded : 0;
    return { traded, wins, losses, winRate, capitalEfficiency, totalCapitalUsed };
  }
  // Directional strategies
  const traded = (custom?.windowsTraded as number) ?? 0;
  const wins = (custom?.windowsWon as number) ?? 0;
  const losses = (custom?.windowsLost as number) ?? 0;
  const winRate = (custom?.directionalAccuracy as number) ?? (traded > 0 ? wins / traded : 0);
  return { traded, wins, losses, winRate, capitalEfficiency, totalCapitalUsed };
}

// ── Unified Adaptive detail section ───────────────────────────────────

function UnifiedDetail({ custom, isActive, isWindingDown, config }: {
  custom: Record<string, unknown> | undefined;
  isActive: boolean;
  isWindingDown?: boolean;
  config: StrategyConfig;
}) {
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
    market: { title: string }; cryptoSymbol: string; mode: string;
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
  }>) ?? [];
  const activeWindows = allActiveWindows.filter(w => w.windowEndTime > Date.now());
  const resolvingWindows = allActiveWindows.filter(w => w.windowEndTime <= Date.now());
  const completedWindows = (custom?.completedWindows as Array<{
    title: string; cryptoSymbol: string; mode: string; outcome: string;
    upInventory: number; downInventory: number; upAvgCost: number; downAvgCost: number;
    matchedPairs: number; netPnl: number; fillCount: number; sellCount: number;
    completedAt: string; priceMovePct: number; bidSize: number; windowDurationMs: number;
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

      {/* Active windows */}
      {activeWindows.length > 0 && (
        <div>
          <Tip tip="Binary prediction windows currently being traded. Each window is a crypto up-or-down market with a fixed time range">
            <h4 className="mb-2 text-sm font-medium cursor-help">Active Windows</h4>
          </Tip>
          <div className="space-y-1.5">
            {activeWindows.map((w, i) => {
              const timeLeft = Math.max(0, w.windowEndTime - Date.now());
              const mins = Math.floor(timeLeft / 60000);
              const secs = Math.floor((timeLeft % 60000) / 1000);
              const compact = compactTitle(w.market?.title ?? "") || w.cryptoSymbol;
              const up = w.upInventory ?? 0;
              const dn = w.downInventory ?? 0;
              const matched = Math.min(up, dn);
              const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
              return (
                <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1.5 text-xs">
                  <Tip tip={w.market?.title ?? "Crypto symbol being traded"}>
                    <span className="font-medium cursor-help">{compact}</span>
                  </Tip>
                  <Tip tip="sniper = direction-agnostic spread capture. maker = signal-biased directional fills">
                    <span><Badge variant="outline" className="text-[10px] px-1 py-0 cursor-help">{w.mode}</Badge></span>
                  </Tip>
                  <InventoryBar up={up} down={dn} scale={w.bidSize ?? 1} />
                  <Tip tip="UP tokens / DOWN tokens held. Matched = min(UP,DOWN) — structurally profitable when pair cost < $1">
                    <span className="tabular-nums cursor-help">
                      <span className="text-green-600">{fmtInv(up)}</span>↑/<span className="text-red-600">{fmtInv(dn)}</span>↓
                      {matched > 0 && <span className="text-purple-600 ml-0.5">({fmtInv(matched)}pr)</span>}
                    </span>
                  </Tip>
                  {pairCost !== null ? (
                    <Tip tip="Average cost of one UP + one DOWN token. Below $1.00 = profit regardless of outcome. Target: 0.92">
                      <span className={`tabular-nums font-medium cursor-help rounded px-1 py-0 text-[10px] ${
                        pairCost < 0.90 ? "bg-green-100 text-green-800" : pairCost <= 0.95 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"
                      }`}>pc={pairCost.toFixed(2)}</span>
                    </Tip>
                  ) : (
                    <span className="tabular-nums text-[10px] text-muted-foreground rounded px-1 py-0 bg-gray-100">pc=—</span>
                  )}
                  {w.rebalanceSold && (
                    <Tip tip="Window poisoned — rebalance sell triggered, quoting stopped to prevent churn">
                      <span className="text-[10px] font-medium rounded px-1 py-0 bg-orange-100 text-orange-800 cursor-help">POISON</span>
                    </Tip>
                  )}
                  <Tip tip="▲ = UP bid resting on CLOB, ▼ = DOWN bid resting. Dim = no active order (filled or cancelled for balance)">
                    <span className="cursor-help">
                      <span className={w.upBidOrderId ? "text-green-600" : "text-gray-300"}>▲</span>
                      <span className={w.downBidOrderId ? "text-red-600" : "text-gray-300"}>▼</span>
                    </span>
                  </Tip>
                  {w.mode === "maker" && w.confirmedDirection && (
                    <Tip tip={`Maker conviction: betting on ${w.confirmedDirection}. Strength at entry: ${((w.signalStrengthAtEntry ?? 0) * 100).toFixed(0)}%`}>
                      <span className={`text-[10px] font-medium cursor-help ${w.confirmedDirection === "UP" ? "text-green-700" : "text-red-700"}`}>
                        {w.confirmedDirection === "UP" ? "BULL" : "BEAR"}
                      </span>
                    </Tip>
                  )}
                  {w.fillCount > 0 && <Tip tip="Number of maker fills"><span className="tabular-nums cursor-help">{w.fillCount}f</span></Tip>}
                  <span className="ml-auto text-[11px] text-muted-foreground italic truncate max-w-[50%]" title={windowNarrative(w, { windingDown: isWindingDown })}>
                    {windowNarrative(w, { windingDown: isWindingDown })}
                  </span>
                  <Tip tip={timeLeft === 0 ? "Window expired — waiting for Polymarket to confirm outcome" : "Time remaining until window closes and resolves"}>
                    <span className={`tabular-nums cursor-help ${timeLeft === 0 ? "text-amber-500 animate-pulse" : "text-muted-foreground"}`}>
                      {timeLeft === 0 ? "resolving…" : `${mins}:${secs.toString().padStart(2, "0")}`}
                    </span>
                  </Tip>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Completed windows (resolving at top) */}
      {(resolvingWindows.length > 0 || completedWindows.length > 0) && (
        <div>
          <h4 className="mb-2 text-sm font-medium">
            Completed
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              ({resolvingWindows.length > 0 ? `${resolvingWindows.length} resolving, ` : ""}last {Math.min(completedWindows.length, 20)})
            </span>
          </h4>
          <div className="space-y-1">
            {/* Resolving windows (past end time, awaiting Polymarket) */}
            {resolvingWindows.map((w, i) => {
              const up = w.upInventory ?? 0;
              const dn = w.downInventory ?? 0;
              const matched = Math.min(up, dn);
              const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
              const compact = compactTitle(w.market?.title ?? "") || w.cryptoSymbol;
              const prediction = w.binancePrediction ?? w.confirmedDirection;
              const betSide = w.convictionSide || (up > dn ? "UP" : dn > up ? "DOWN" : null);
              const willWin = prediction && betSide ? prediction === betSide : null;
              // Estimate P&L if prediction is correct
              const estPnl = prediction ? (() => {
                const winSide = prediction === "UP" ? up : dn;
                const loseSide = prediction === "UP" ? dn : up;
                const winCost = prediction === "UP" ? (w.upAvgCost ?? 0) : (w.downAvgCost ?? 0);
                const loseCost = prediction === "UP" ? (w.downAvgCost ?? 0) : (w.upAvgCost ?? 0);
                return winSide * (1.0 - winCost) - loseSide * loseCost - (w.realizedSellPnl ? -w.realizedSellPnl : 0);
              })() : null;
              return (
                <div key={`r-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border border-amber-300 bg-amber-50/50 px-2 py-1 text-xs">
                  <Tip tip={w.market?.title ?? ""}><span className="font-medium cursor-help">{compact}</span></Tip>
                  <span className="rounded px-1 py-0 text-[10px] font-medium bg-amber-100 text-amber-800 animate-pulse">resolving</span>
                  <InventoryBar up={up} down={dn} scale={w.bidSize ?? 1} />
                  <span className="tabular-nums">
                    <span className="text-green-600">{fmtInv(up)}</span>↑/<span className="text-red-600">{fmtInv(dn)}</span>↓
                    {matched > 0 && <span className="text-purple-600 ml-0.5">({fmtInv(matched)}pr)</span>}
                  </span>
                  {pairCost !== null && (
                    <span className={`tabular-nums font-medium rounded px-1 py-0 text-[10px] ${
                      pairCost < 0.90 ? "bg-green-100 text-green-800" : pairCost <= 0.95 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"
                    }`}>pc={pairCost.toFixed(2)}</span>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground italic">
                    {prediction
                      ? <>
                          {willWin === true ? `Binance predicts win (${prediction})`
                            : willWin === false ? `Binance predicts loss (${prediction})`
                            : `Binance says ${prediction}`}
                          {estPnl !== null && <span className={`ml-1 font-medium ${estPnl >= 0 ? "text-green-600" : "text-red-600"}`}>≈{estPnl >= 0 ? "+" : ""}{fmt(estPnl)}</span>}
                        </>
                      : "awaiting Polymarket…"}
                  </span>
                </div>
              );
            })}
            {completedWindows.slice(-20).reverse().map((w, i) => {
              const up = w.upInventory ?? 0;
              const dn = w.downInventory ?? 0;
              const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
              return (
                <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1 text-xs">
                  <Tip tip={w.title}><span className="font-medium cursor-help">{compactTitle(w.title) || w.cryptoSymbol}</span></Tip>
                  <Tip tip="Mode used for this window (sniper or maker)">
                    <span><Badge variant="outline" className="text-[10px] px-1 py-0 cursor-help">{w.mode}</Badge></span>
                  </Tip>
                  <Tip tip="Market resolution outcome — which side won">
                    <span className={`rounded px-1 py-0 text-[10px] font-medium cursor-help ${
                      w.outcome === "UP" ? "bg-green-100 text-green-800" : w.outcome === "DOWN" ? "bg-red-100 text-red-800" : "bg-gray-100"
                    }`}>{w.outcome}</span>
                  </Tip>
                  <InventoryBar up={up} down={dn} scale={w.bidSize ?? 1} />
                  <Tip tip="UP tokens / DOWN tokens held. Matched = min(UP,DOWN) — structurally profitable when pair cost < $1">
                    <span className="tabular-nums cursor-help">
                      <span className="text-green-600">{fmtInv(up)}</span>↑/<span className="text-red-600">{fmtInv(dn)}</span>↓
                      <span className="text-purple-600 ml-0.5">({w.matchedPairs}pr)</span>
                    </span>
                  </Tip>
                  {pairCost !== null ? (
                    <Tip tip="Average cost of one UP + one DOWN token. Below $1.00 = profit regardless of outcome. Target: 0.92">
                      <span className={`tabular-nums font-medium cursor-help rounded px-1 py-0 text-[10px] ${
                        pairCost < 0.90 ? "bg-green-100 text-green-800" : pairCost <= 0.95 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"
                      }`}>pc={pairCost.toFixed(2)}</span>
                    </Tip>
                  ) : (
                    <span className="tabular-nums text-[10px] text-muted-foreground rounded px-1 py-0 bg-gray-100">pc=—</span>
                  )}
                  <Tip tip="Net P&L for this window after resolution, costs, and fees">
                    <span className={`font-medium tabular-nums cursor-help ${w.netPnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {fmt(w.netPnl)}
                    </span>
                  </Tip>
                  <Tip tip="Total maker fills in this window"><span className="tabular-nums text-muted-foreground cursor-help">{w.fillCount}f</span></Tip>
                  {w.windowDurationMs > 0 && (
                    <Tip tip="Duration of the prediction window"><span className="text-muted-foreground cursor-help">{fmtDuration(w.windowDurationMs)}</span></Tip>
                  )}
                  <Tip tip="When this window was resolved"><span className="ml-auto text-muted-foreground cursor-help">{timeAgo(w.completedAt)}</span></Tip>
                </div>
              );
            })}
          </div>
        </div>
      )}

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

// ── Strategy detail (all types) ───────────────────────────────────────

function StrategyDetail({
  config,
  isActive,
  isWindingDown,
  state,
  balanceProtection,
  onReset,
}: {
  config: StrategyConfig;
  isActive: boolean;
  isWindingDown?: boolean;
  state: StrategyState | null;
  balanceProtection?: BalanceProtection | null;
  onReset?: () => void;
}) {
  const logs = state?.logs ?? [];
  const custom = state?.custom as Record<string, unknown> | undefined;
  const isDirectional = config.strategy_type === "directional-taker" || config.strategy_type === "directional-maker" || config.strategy_type === "safe-maker" || config.strategy_type === "conviction-maker";
  const isUnified = config.strategy_type === "unified-adaptive";
  const isMaker = config.strategy_type === "directional-maker" || config.strategy_type === "safe-maker" || config.strategy_type === "conviction-maker";

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
    buyCount: number; sellCount: number; phase: string;
    fillCount?: number; flipCount: number; bidSize: number;
    lastUpBestAsk?: number; lastDnBestAsk?: number;
    rebalanceSold?: boolean;
    binancePrediction?: "UP" | "DOWN" | null;
  }>) ?? [];
  const activeWindows = allActiveWindows.filter(w => w.windowEndTime > Date.now());
  const resolvingWindows = allActiveWindows.filter(w => w.windowEndTime <= Date.now());
  const completedWindows = (custom?.completedWindows as Array<{
    title: string; convictionSide: string | null; outcome: string;
    winningPayout: number; losingLoss: number; realizedSellPnl: number;
    netPnl: number; totalBuyCost: number; signalStrength: number;
    correct: boolean; buyCount: number; sellCount: number;
    fillCount?: number; flipCount: number; completedAt: string;
    upInventory: number; downInventory: number;
    upAvgCost: number; downAvgCost: number; bidSize: number;
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
            return (
              <div className="rounded-lg border p-3 cursor-help">
                <div className="text-xs text-muted-foreground">Capital Deployed</div>
                <div className="text-lg font-bold tabular-nums">{fmt(deployed)}</div>
                <div className="text-xs text-muted-foreground">
                  / {fmt(config.max_capital_usd)} max
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
                balanceProtection.working_capital < (config.lock_increment_usd ?? config.balance_usd) * 0.25 ? "text-red-500" :
                balanceProtection.working_capital < (config.lock_increment_usd ?? config.balance_usd) * 0.5 ? "text-amber-500" :
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

      {/* Unified Adaptive detail */}
      {isUnified && <UnifiedDetail custom={custom} isActive={isActive} isWindingDown={isWindingDown} config={config} />}

      {/* Sniper / generic active windows (not directional, not unified) */}
      {!isDirectional && !isUnified && (() => {
        const sniperWindows = (custom?.activeWindows as Array<{
          market: { title: string }; cryptoSymbol: string;
          windowEndTime: number; upInventory: number; downInventory: number;
          upAvgCost: number; downAvgCost: number;
          upBidOrderId: string | null; downBidOrderId: string | null;
          upBidPrice: number; downBidPrice: number;
          upBidSize: number; downBidSize: number;
          fillCount: number; sellCount: number; totalBuyCost: number;
          lastUpBestAsk?: number; lastDnBestAsk?: number;
          rebalanceSold?: boolean;
        }>) ?? [];
        const sniperCompleted = (custom?.completedWindows as Array<{
          title: string; cryptoSymbol: string; outcome: string;
          upInventory: number; downInventory: number;
          upAvgCost: number; downAvgCost: number; pairCost: number;
          matchedPairs: number; netPnl: number; fillCount: number; sellCount: number;
          completedAt: string; priceMovePct: number;
        }>) ?? [];
        return (
          <>
            {sniperWindows.length > 0 && (
              <div>
                <Tip tip="Binary prediction windows currently being traded. Each window is a crypto up-or-down market with a fixed time range">
                  <h4 className="mb-2 text-sm font-medium cursor-help">Active Windows</h4>
                </Tip>
                <div className="space-y-1.5">
                  {sniperWindows.map((w, i) => {
                    const timeLeft = Math.max(0, w.windowEndTime - Date.now());
                    const mins = Math.floor(timeLeft / 60000);
                    const secs = Math.floor((timeLeft % 60000) / 1000);
                    const compact = compactTitle(w.market?.title ?? "") || w.cryptoSymbol;
                    const up = w.upInventory ?? 0;
                    const dn = w.downInventory ?? 0;
                    const matched = Math.min(up, dn);
                    const bidSize = w.upBidSize ?? w.downBidSize ?? 1;
                    const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
                    return (
                      <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1.5 text-xs">
                        <Tip tip={w.market?.title ?? "Crypto symbol being traded"}>
                          <span className="font-medium cursor-help">{compact}</span>
                        </Tip>
                        <InventoryBar up={up} down={dn} scale={bidSize} />
                        <Tip tip="UP tokens / DOWN tokens held. Matched = min(UP,DOWN) — structurally profitable when pair cost < $1">
                          <span className="tabular-nums cursor-help">
                            <span className="text-green-600">{fmtInv(up)}</span>↑/<span className="text-red-600">{fmtInv(dn)}</span>↓
                            {matched > 0 && <span className="text-purple-600 ml-0.5">({fmtInv(matched)}pr)</span>}
                          </span>
                        </Tip>
                        {pairCost !== null ? (
                          <Tip tip="Average cost of one UP + one DOWN token. Below $1.00 = profit regardless of outcome. Target: 0.92">
                            <span className={`tabular-nums font-medium cursor-help rounded px-1 py-0 text-[10px] ${
                              pairCost < 0.90 ? "bg-green-100 text-green-800" : pairCost <= 0.95 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"
                            }`}>pc={pairCost.toFixed(2)}</span>
                          </Tip>
                        ) : (
                          <span className="tabular-nums text-[10px] text-muted-foreground rounded px-1 py-0 bg-gray-100">pc=—</span>
                        )}
                        <Tip tip="▲ = UP bid resting on CLOB, ▼ = DOWN bid resting. Dim = no active order (filled or cancelled for balance)">
                          <span className="cursor-help">
                            <span className={w.upBidOrderId ? "text-green-600" : "text-gray-300"}>▲</span>
                            <span className={w.downBidOrderId ? "text-red-600" : "text-gray-300"}>▼</span>
                          </span>
                        </Tip>
                        {w.fillCount > 0 && <Tip tip="Number of maker fills (resting bids that got hit)"><span className="tabular-nums cursor-help">{w.fillCount}f</span></Tip>}
                        <span className="ml-auto text-[11px] text-muted-foreground italic truncate max-w-[260px]">
                          {windowNarrative(w, { windingDown: isWindingDown })}
                        </span>
                        <Tip tip={timeLeft === 0 ? "Window expired — waiting for Polymarket to confirm outcome" : "Time remaining until window closes and resolves"}>
                          <span className={`tabular-nums cursor-help ${timeLeft === 0 ? "text-amber-500 animate-pulse" : "text-muted-foreground"}`}>
                            {timeLeft === 0 ? "resolving…" : `${mins}:${secs.toString().padStart(2, "0")}`}
                          </span>
                        </Tip>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {sniperCompleted.length > 0 && (
              <div>
                <h4 className="mb-2 text-sm font-medium">
                  Completed
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    (last {Math.min(sniperCompleted.length, 20)})
                  </span>
                </h4>
                <div className="space-y-1">
                  {sniperCompleted.slice(-20).reverse().map((w, i) => {
                    const up = w.upInventory ?? 0;
                    const dn = w.downInventory ?? 0;
                    const pairCost = w.pairCost ?? ((up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null);
                    return (
                      <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1 text-xs">
                        <Tip tip={w.title}><span className="font-medium cursor-help">{compactTitle(w.title) || w.cryptoSymbol}</span></Tip>
                        <Tip tip="Market resolution outcome — which side won">
                          <span className={`rounded px-1 py-0 text-[10px] font-medium cursor-help ${
                            w.outcome === "UP" ? "bg-green-100 text-green-800" : w.outcome === "DOWN" ? "bg-red-100 text-red-800" : "bg-gray-100"
                          }`}>{w.outcome}</span>
                        </Tip>
                        <InventoryBar up={up} down={dn} scale={Math.max(up + dn, 1)} />
                        <Tip tip="UP tokens / DOWN tokens held. Matched = min(UP,DOWN) — structurally profitable when pair cost < $1">
                          <span className="tabular-nums cursor-help">
                            <span className="text-green-600">{fmtInv(up)}</span>↑/<span className="text-red-600">{fmtInv(dn)}</span>↓
                            <span className="text-purple-600 ml-0.5">({w.matchedPairs}pr)</span>
                          </span>
                        </Tip>
                        {pairCost !== null && pairCost > 0 ? (
                          <Tip tip="Average cost of one UP + one DOWN token. Below $1.00 = profit regardless of outcome. Target: 0.92">
                            <span className={`tabular-nums font-medium cursor-help rounded px-1 py-0 text-[10px] ${
                              pairCost < 0.90 ? "bg-green-100 text-green-800" : pairCost <= 0.95 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"
                            }`}>pc={pairCost.toFixed(2)}</span>
                          </Tip>
                        ) : (
                          <span className="tabular-nums text-[10px] text-muted-foreground rounded px-1 py-0 bg-gray-100">pc=—</span>
                        )}
                        <Tip tip="Net P&L for this window after resolution, costs, and fees">
                          <span className={`font-medium tabular-nums cursor-help ${w.netPnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {fmt(w.netPnl)}
                          </span>
                        </Tip>
                        <Tip tip="Total maker fills in this window"><span className="tabular-nums text-muted-foreground cursor-help">{w.fillCount}f</span></Tip>
                        <Tip tip="When this window was resolved"><span className="ml-auto text-muted-foreground cursor-help">{timeAgo(w.completedAt)}</span></Tip>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
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

      {/* Directional strategy stats */}
      {isDirectional && windowsTraded > 0 && (
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

      {/* Active directional windows */}
      {isDirectional && activeWindows.length > 0 && (
        <div>
          <Tip tip="Binary prediction windows currently being traded. Each window is a crypto up-or-down market with a fixed time range">
            <h4 className="mb-2 text-sm font-medium cursor-help">Active Windows</h4>
          </Tip>
          <div className="space-y-1.5">
            {activeWindows.map((w, i) => {
              const timeLeft = Math.max(0, w.windowEndTime - Date.now());
              const mins = Math.floor(timeLeft / 60000);
              const secs = Math.floor((timeLeft % 60000) / 1000);
              const title = w.market?.title ?? "";
              const compact = compactTitle(title) || w.cryptoSymbol;
              const maxFlips = ((typeof config.params === "object" ? config.params as Record<string, unknown> : {})?.max_flips_per_window as number) ?? 3;
              const phase = w.phase || "active";
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
              const up = w.upInventory ?? 0;
              const dn = w.downInventory ?? 0;
              const matched = Math.min(up, dn);
              const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
              return (
                <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1.5 text-xs">
                  <Tip tip={title}><span className="font-medium cursor-help">{compact}</span></Tip>
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
                  <InventoryBar up={up} down={dn} scale={w.bidSize ?? 1} />
                  <Tip tip="UP tokens / DOWN tokens held. Matched = min(UP,DOWN) — structurally profitable when pair cost < $1">
                    <span className="tabular-nums cursor-help">
                      <span className="text-green-600">{fmtInv(up)}</span>↑/<span className="text-red-600">{fmtInv(dn)}</span>↓
                      {matched > 0 && <span className="text-purple-600 ml-0.5">({fmtInv(matched)}pr)</span>}
                    </span>
                  </Tip>
                  {pairCost !== null ? (
                    <Tip tip="Average cost of one UP + one DOWN token. Below $1.00 = profit regardless of outcome. Target: 0.92">
                      <span className={`tabular-nums font-medium cursor-help rounded px-1 py-0 text-[10px] ${
                        pairCost < 0.90 ? "bg-green-100 text-green-800" : pairCost <= 0.95 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"
                      }`}>pc={pairCost.toFixed(2)}</span>
                    </Tip>
                  ) : (
                    <span className="tabular-nums text-[10px] text-muted-foreground rounded px-1 py-0 bg-gray-100">pc=—</span>
                  )}
                  <Tip tip="▲ = UP bid resting on CLOB, ▼ = DOWN bid resting. Dim = no active order (filled or cancelled for balance)">
                    <span className="cursor-help">
                      <span className={w.upBidOrderId ? "text-green-600" : "text-gray-300"}>▲</span>
                      <span className={w.downBidOrderId ? "text-red-600" : "text-gray-300"}>▼</span>
                    </span>
                  </Tip>
                  {(w.flipCount ?? 0) > 0 && (
                    <Tip tip={`Direction flips (${w.flipCount}/${maxFlips} max). Exceeding max stops quoting — choppy market protection`}>
                      <span className={`tabular-nums cursor-help ${(w.flipCount ?? 0) > maxFlips ? "text-red-600 font-medium" : "text-amber-600"}`}>
                        {w.flipCount}fl
                      </span>
                    </Tip>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground italic truncate max-w-[50%]" title={windowNarrative({ ...w, fillCount: w.fillCount ?? 0, sellCount: w.sellCount ?? 0, upBidPrice: w.upBidPrice ?? 0, downBidPrice: w.downBidPrice ?? 0 }, { windingDown: isWindingDown })}>
                    {windowNarrative({ ...w, fillCount: w.fillCount ?? 0, sellCount: w.sellCount ?? 0, upBidPrice: w.upBidPrice ?? 0, downBidPrice: w.downBidPrice ?? 0 }, { windingDown: isWindingDown })}
                  </span>
                  <Tip tip={timeLeft === 0 ? "Window expired — waiting for Polymarket to confirm outcome" : "Time remaining until window closes and resolves"}>
                    <span className={`tabular-nums cursor-help ${timeLeft === 0 ? "text-amber-500 animate-pulse" : "text-muted-foreground"}`}>
                      {timeLeft === 0 ? "resolving…" : `${mins}:${secs.toString().padStart(2, "0")}`}
                    </span>
                  </Tip>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Completed directional windows (resolving at top) */}
      {isDirectional && (resolvingWindows.length > 0 || completedWindows.length > 0) && (
        <div>
          <h4 className="mb-2 text-sm font-medium">
            Completed
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              ({resolvingWindows.length > 0 ? `${resolvingWindows.length} resolving, ` : ""}last {Math.min(completedWindows.length, 20)})
            </span>
          </h4>
          <div className="space-y-1">
            {/* Resolving windows (past end time, awaiting Polymarket) */}
            {resolvingWindows.map((w, i) => {
              const up = w.upInventory ?? 0;
              const dn = w.downInventory ?? 0;
              const matched = Math.min(up, dn);
              const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
              const compact = compactTitle(w.market?.title ?? "") || (w.market?.title ?? "").slice(0, 25);
              const prediction = w.binancePrediction ?? w.confirmedDirection;
              const betSide = w.convictionSide || (up > dn ? "UP" : dn > up ? "DOWN" : null);
              const willWin = prediction && betSide ? prediction === betSide : null;
              const estPnl = prediction ? (() => {
                const winSide = prediction === "UP" ? up : dn;
                const loseSide = prediction === "UP" ? dn : up;
                const winCost = prediction === "UP" ? (w.upAvgCost ?? 0) : (w.downAvgCost ?? 0);
                const loseCost = prediction === "UP" ? (w.downAvgCost ?? 0) : (w.upAvgCost ?? 0);
                return winSide * (1.0 - winCost) - loseSide * loseCost;
              })() : null;
              return (
                <div key={`r-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border border-amber-300 bg-amber-50/50 px-2 py-1 text-xs">
                  <Tip tip={w.market?.title ?? ""}><span className="font-medium cursor-help">{compact}</span></Tip>
                  <span className="rounded px-1 py-0 text-[10px] font-medium bg-amber-100 text-amber-800 animate-pulse">resolving</span>
                  {w.convictionSide && (
                    <span className={`${w.convictionSide === "UP" ? "text-green-600" : "text-red-600"} font-medium`}>
                      {w.convictionSide} {(w.signalStrengthAtEntry * 100).toFixed(0)}%
                    </span>
                  )}
                  <InventoryBar up={up} down={dn} scale={w.bidSize ?? 1} />
                  <span className="tabular-nums">
                    <span className="text-green-600">{fmtInv(up)}</span>↑/<span className="text-red-600">{fmtInv(dn)}</span>↓
                    {matched > 0 && <span className="text-purple-600 ml-0.5">({fmtInv(matched)}pr)</span>}
                  </span>
                  {pairCost !== null && (
                    <span className={`tabular-nums font-medium rounded px-1 py-0 text-[10px] ${
                      pairCost < 0.90 ? "bg-green-100 text-green-800" : pairCost <= 0.95 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"
                    }`}>pc={pairCost.toFixed(2)}</span>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground italic">
                    {prediction
                      ? <>
                          {willWin === true ? `Binance predicts win (${prediction})`
                            : willWin === false ? `Binance predicts loss (${prediction})`
                            : `Binance says ${prediction}`}
                          {estPnl !== null && <span className={`ml-1 font-medium ${estPnl >= 0 ? "text-green-600" : "text-red-600"}`}>≈{estPnl >= 0 ? "+" : ""}{fmt(estPnl)}</span>}
                        </>
                      : "awaiting Polymarket…"}
                  </span>
                </div>
              );
            })}
            {completedWindows.slice(-20).reverse().map((w, i) => {
              const maxFlips = ((typeof config.params === "object" ? config.params as Record<string, unknown> : {})?.max_flips_per_window as number) ?? 3;
              const up = w.upInventory ?? 0;
              const dn = w.downInventory ?? 0;
              const matched = Math.min(up, dn);
              const pairCost = (up > 0 && dn > 0) ? (w.upAvgCost ?? 0) + (w.downAvgCost ?? 0) : null;
              return (
                <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1 text-xs">
                  <Tip tip={w.title}><span className="font-medium cursor-help">{compactTitle(w.title) || w.title.slice(0, 25)}</span></Tip>
                  {w.convictionSide ? (
                    <Tip tip={w.correct ? "Conviction direction matched the outcome (+)" : "Conviction direction was wrong (-)"}>
                      <span className={`cursor-help ${w.correct ? "text-green-600 font-medium" : "text-red-600 font-medium"}`}>
                        {w.convictionSide}{w.correct ? " +" : " -"}
                      </span>
                    </Tip>
                  ) : <span className="text-muted-foreground">—</span>}
                  <InventoryBar up={up} down={dn} scale={w.bidSize ?? 1} />
                  {(up > 0 || dn > 0) && (
                    <Tip tip="UP tokens / DOWN tokens held. Matched = min(UP,DOWN) — structurally profitable when pair cost < $1">
                      <span className="tabular-nums cursor-help">
                        <span className="text-green-600">{fmtInv(up)}</span>↑/<span className="text-red-600">{fmtInv(dn)}</span>↓
                        {matched > 0 && <span className="text-purple-600 ml-0.5">({fmtInv(matched)}pr)</span>}
                      </span>
                    </Tip>
                  )}
                  {pairCost !== null && (
                    <Tip tip="Average cost of one UP + one DOWN token. Below $1.00 = profit regardless of outcome">
                      <span className={`tabular-nums font-medium cursor-help rounded px-1 py-0 text-[10px] ${
                        pairCost < 0.90 ? "bg-green-100 text-green-800" : pairCost <= 0.95 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"
                      }`}>pc={pairCost.toFixed(2)}</span>
                    </Tip>
                  )}
                  <Tip tip="Net P&L = winning payout - losing loss + sell P&L - fees">
                    <span className={`font-medium tabular-nums cursor-help ${(w.netPnl ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
                      ={fmt(w.netPnl)}
                    </span>
                  </Tip>
                  <Tip tip={isMaker ? "Maker fills in this window" : "Buy and sell orders executed"}>
                    <span className="tabular-nums cursor-help">
                      {isMaker ? `${w.fillCount ?? 0}f` : `${w.buyCount ?? 0}b/${w.sellCount ?? 0}s`}
                    </span>
                  </Tip>
                  {(w.flipCount ?? 0) > 0 && (
                    <Tip tip={`Direction flips in this window (${w.flipCount}/${maxFlips} max)`}>
                      <span className={`tabular-nums cursor-help ${(w.flipCount ?? 0) > maxFlips ? "text-red-600 font-medium" : ""}`}>
                        {w.flipCount}fl
                      </span>
                    </Tip>
                  )}
                  <Tip tip="When this window resolved"><span className="ml-auto text-muted-foreground cursor-help">{timeAgo(w.completedAt)}</span></Tip>
                </div>
              );
            })}
          </div>
        </div>
      )}

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

      {/* Config params */}
      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
          Configuration Parameters
        </summary>
        <pre className="mt-2 rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-all">
          {(() => {
            try {
              const params = typeof config.params === "string"
                ? JSON.parse(config.params || "{}")
                : config.params;
              return JSON.stringify(
                {
                  strategy_type: config.strategy_type,
                  mode: config.mode,
                  tick_interval_ms: config.tick_interval_ms,
                  max_capital_usd: config.max_capital_usd,
                  ...params,
                },
                null,
                2
              );
            } catch {
              return String(config.params);
            }
          })()}
        </pre>
      </details>

      {/* Reset stats button — only when stopped */}
      {!isActive && !isWindingDown && onReset && (state?.ticks ?? 0) > 0 && (
        <button
          onClick={() => {
            if (confirm("Reset all stats, trades, and logs for this strategy? Config will be kept.")) {
              onReset();
            }
          }}
          className="text-xs text-muted-foreground hover:text-red-600 underline"
        >
          Reset stats &amp; trades
        </button>
      )}
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
        ...((newType === "spread-sniper" || newType === "directional-maker" || newType === "unified-adaptive") && newMode === "paper"
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
                <th className="text-right py-1 px-1"><Tip tip="Capital efficiency (P&L / capital cycled). Shows balance when protection is enabled"><span className="cursor-help">Eff%</span></Tip></th>
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
                const { traded, wins, losses, winRate, capitalEfficiency, totalCapitalUsed } = extractOverviewStats(custom, c.strategy_type, pnl);
                const bp = st?.balance_protection;
                const runTime = fmtRunTime(state?.started_at ?? c.created_at, state?.last_tick_at ?? "", isRunning);
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
                          ? `Eff ${totalCapitalUsed > 0 ? (capitalEfficiency * 100).toFixed(1) + "%" : "—"} | Bal ${fmt(bp.current_balance)} | Locked ${fmt(bp.locked_amount)} | Working ${fmt(bp.working_capital)}`
                          : `P&L ${fmt(pnl)} on ${fmt(totalCapitalUsed)} capital cycled`
                        }>
                          <span className={`cursor-help ${capitalEfficiency >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {bp
                              ? <span className={
                                  bp.working_capital <= 0 ? "text-red-600" :
                                  bp.working_capital < (c.lock_increment_usd ?? c.balance_usd ?? 0) * 0.5 ? "text-amber-500" :
                                  "text-green-600"
                                }>{fmt(bp.current_balance)}</span>
                              : totalCapitalUsed > 0 ? `${(capitalEfficiency * 100).toFixed(1)}%` : "—"
                            }
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
                          <StrategyDetail config={c} isActive={isRunning} isWindingDown={isWindingDown} state={state} balanceProtection={st?.balance_protection} onReset={() => resetStrategy(c.id)} />
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
              const { traded, wins, losses, winRate, capitalEfficiency, totalCapitalUsed } = extractOverviewStats(custom, c.strategy_type, pnl);
              const bp = st?.balance_protection;
              const runTime = fmtRunTime(state?.started_at ?? c.created_at, state?.last_tick_at ?? "", isRunning);
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
                            {totalCapitalUsed > 0 && (
                              <span className={`ml-1 ${capitalEfficiency >= 0 ? "text-green-600" : "text-red-600"}`}>
                                eff {(capitalEfficiency * 100).toFixed(1)}%
                              </span>
                            )}
                          </span>
                        )}
                        {bp && (
                          <Tip tip={`Balance: ${fmt(bp.current_balance)} | Locked: ${fmt(bp.locked_amount)} | Working: ${fmt(bp.working_capital)} | HWM: ${fmt(bp.high_water_balance)}`}>
                            <span className={`text-xs font-mono tabular-nums cursor-help truncate ${
                              bp.working_capital <= 0 ? "text-red-600" :
                              bp.working_capital < (c.lock_increment_usd ?? c.balance_usd ?? 0) * 0.25 ? "text-red-500" :
                              bp.working_capital < (c.lock_increment_usd ?? c.balance_usd ?? 0) * 0.5 ? "text-amber-500" :
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
                      <StrategyDetail config={c} isActive={isRunning} isWindingDown={isWindingDown} state={state} balanceProtection={st?.balance_protection} onReset={() => resetStrategy(c.id)} />
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
            {(newType === "spread-sniper" || newType === "directional-maker" || newType === "unified-adaptive") && newMode === "paper" && (
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
