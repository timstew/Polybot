"use client";

import React, { type ReactNode } from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

// ── Shared utilities ─────────────────────────────────────────────────

export function fmt(n: number | undefined | null) {
  if (n == null || isNaN(n)) return "$0.00";
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtInv(n: number): string {
  if (n === 0) return "0";
  if (n < 0.1) return "<0.1";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(n < 10 ? 2 : 1);
}

export function timeAgo(ts: string | number) {
  if (!ts) return "never";
  const t = typeof ts === "number" ? ts : new Date(ts).getTime();
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

export function Tip({ tip, children }: { tip: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">{tip}</TooltipContent>
    </Tooltip>
  );
}

export function InventoryBar({ up, down, scale }: { up: number; down: number; scale: number }) {
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

export function SingleSideInventoryBar({ amount, side, scale }: { amount: number; side: "UP" | "DOWN" | null; scale: number }) {
  const total = Math.max(amount, scale, 1);
  const W = 80, H = 14;
  const barW = (amount / total) * W;
  const color = side === "UP" ? "#22c55e" : side === "DOWN" ? "#ef4444" : "#a855f7";
  return (
    <Tip tip={`${side ?? "?"} inventory: ${amount} tokens. Single-sided (conviction bet)`}>
      <svg width={W} height={H} className="cursor-help inline-block align-middle" style={{ borderRadius: 2, background: "#e5e7eb" }}>
        {barW > 0 && <rect x={0} y={0} width={barW} height={H} fill={color} />}
      </svg>
    </Tip>
  );
}

export function PairPnl({ up, dn, upAvgCost, dnAvgCost, pairCost, onMerge, merging }: {
  up: number; dn: number; upAvgCost: number; dnAvgCost: number; pairCost: number | null;
  onMerge?: () => void; merging?: boolean;
}) {
  const matched = Math.min(up, dn);
  const unmatched = Math.max(up, dn) - matched;
  const lockedPnl = matched > 0 && pairCost !== null && pairCost < 1 ? matched * (1.00 - pairCost) : 0;
  const unmatchedSide = up > dn ? "UP" : "DOWN";
  const unmatchedAvgCost = up > dn ? upAvgCost : dnAvgCost;
  const atRisk = unmatched * unmatchedAvgCost;
  if (lockedPnl <= 0 && atRisk <= 0) return null;
  return (
    <>
      {lockedPnl > 0 && (
        <>
          <Tip tip={`${matched} pairs x $${(1 - (pairCost ?? 0)).toFixed(2)} spread = guaranteed profit regardless of outcome`}>
            <span className="text-[10px] text-green-700 font-medium cursor-help">+{fmt(lockedPnl)}</span>
          </Tip>
          {onMerge && (
            <button
              onClick={onMerge}
              disabled={merging}
              className="text-[10px] text-blue-600 hover:text-blue-800 underline ml-1 disabled:opacity-50"
            >
              {merging ? "..." : "Merge"}
            </button>
          )}
        </>
      )}
      {atRisk > 0 && (
        <Tip tip={`${unmatched} unmatched ${unmatchedSide} x $${unmatchedAvgCost.toFixed(2)} = at risk if ${unmatchedSide === "UP" ? "DOWN" : "UP"} wins`}>
          <span className="text-[10px] text-amber-600 font-medium cursor-help">{fmt(atRisk)}</span>
        </Tip>
      )}
    </>
  );
}

// ── Pair cost badge ──────────────────────────────────────────────────

function PairCostBadge({ pairCost }: { pairCost: number | null }) {
  if (pairCost !== null) {
    return (
      <Tip tip="Cost of one UP + one DOWN token. Below $1.00 = profit regardless of outcome. Target: 0.92">
        <span className={`tabular-nums font-medium cursor-help rounded px-1 py-0 text-[10px] ${
          pairCost < 0.90 ? "bg-green-100 text-green-800" : pairCost <= 0.95 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"
        }`}>pc={pairCost.toFixed(2)}</span>
      </Tip>
    );
  }
  return <span className="tabular-nums text-[10px] text-muted-foreground rounded px-1 py-0 bg-gray-100">pc=--</span>;
}

// ── Dual-side inventory text ─────────────────────────────────────────

function DualInventoryText({ up, dn, upAvgCost, dnAvgCost, costDp }: {
  up: number; dn: number; upAvgCost: number; dnAvgCost: number; costDp?: number;
}) {
  const matched = Math.min(up, dn);
  const dp = costDp ?? 2;
  return (
    <Tip tip="UP/DOWN tokens held with avg cost. Matched pairs profit when pair cost < $1">
      <span className="tabular-nums cursor-help">
        <span className="text-green-600">{fmtInv(up)}</span>{up > 0 && <span className="text-muted-foreground">@{upAvgCost.toFixed(dp)}</span>}
        /<span className="text-red-600">{fmtInv(dn)}</span>{dn > 0 && <span className="text-muted-foreground">@{dnAvgCost.toFixed(dp)}</span>}
        {matched > 0 && <span className="text-purple-600 ml-0.5">({fmtInv(matched)}pr)</span>}
      </span>
    </Tip>
  );
}

// ── Bid arrows ───────────────────────────────────────────────────────

function BidArrows({ upActive, dnActive }: { upActive: boolean; dnActive: boolean }) {
  return (
    <Tip tip="Resting bids: green = UP bid active, red = DOWN bid active. Dim = no active order">
      <span className="cursor-help">
        <span className={upActive ? "text-green-600" : "text-gray-300"}>&#x25B2;</span>
        <span className={dnActive ? "text-red-600" : "text-gray-300"}>&#x25BC;</span>
      </span>
    </Tip>
  );
}

// ── ActiveWindowRow ──────────────────────────────────────────────────

export interface ActiveWindowRowProps {
  title: string;
  compact: string;
  chips?: ReactNode;
  // Dual-side inventory
  up: number; dn: number;
  upAvgCost: number; dnAvgCost: number;
  costDp?: number;
  scale: number;
  pairCost: number | null;
  // Bids
  upBidActive: boolean; dnBidActive: boolean;
  // Fills
  fillCount: number;
  takerFills?: number;
  flipCount?: number; maxFlips?: number;
  // Merge
  totalMerged?: number; mergedPnl?: number;
  // PairPnl
  onMerge?: () => void; merging?: boolean;
  // Content
  tickAction?: ReactNode;
  narrative?: string;
  timeLeftMs: number;
}

export function ActiveWindowRow(props: ActiveWindowRowProps) {
  const {
    title, compact, chips,
    up, dn, upAvgCost, dnAvgCost, costDp, scale, pairCost,
    upBidActive, dnBidActive,
    fillCount, takerFills, flipCount, maxFlips,
    totalMerged, mergedPnl,
    onMerge, merging,
    tickAction, narrative,
    timeLeftMs,
  } = props;
  const mins = Math.floor(timeLeftMs / 60000);
  const secs = Math.floor((timeLeftMs % 60000) / 1000);

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1.5 text-xs overflow-hidden min-w-0">
      <Tip tip={title}><span className="font-medium cursor-help">{compact}</span></Tip>
      {chips}
      <InventoryBar up={up} down={dn} scale={scale} />
      <DualInventoryText up={up} dn={dn} upAvgCost={upAvgCost} dnAvgCost={dnAvgCost} costDp={costDp} />
      <PairCostBadge pairCost={pairCost} />
      <PairPnl up={up} dn={dn} upAvgCost={upAvgCost} dnAvgCost={dnAvgCost} pairCost={pairCost}
        onMerge={onMerge} merging={merging} />
      {(totalMerged ?? 0) > 0 && (
        <Tip tip={`${totalMerged} pairs merged via CTF for ${fmt(mergedPnl ?? 0)} locked profit`}>
          <span className="text-[10px] text-blue-600 font-medium cursor-help">mrg={totalMerged} +{fmt(mergedPnl ?? 0)}</span>
        </Tip>
      )}
      <BidArrows upActive={upBidActive} dnActive={dnBidActive} />
      {fillCount > 0 && <Tip tip="Maker fills — resting bid orders that got matched"><span className="tabular-nums cursor-help">{fillCount}f</span></Tip>}
      {(takerFills ?? 0) > 0 && <Tip tip="Taker-mode FAK sweeps"><span className="tabular-nums cursor-help text-orange-600">{takerFills}t</span></Tip>}
      {(flipCount ?? 0) > 0 && (
        <Tip tip={`Direction flips (${flipCount}/${maxFlips ?? "?"} max). Exceeding max stops quoting — choppy market protection`}>
          <span className={`tabular-nums cursor-help ${(flipCount ?? 0) > (maxFlips ?? 999) ? "text-red-600 font-medium" : "text-amber-600"}`}>
            {flipCount}fl
          </span>
        </Tip>
      )}
      <span className="ml-auto text-[11px] text-muted-foreground italic truncate max-w-[50%]" title={typeof tickAction === "string" ? tickAction : narrative ?? ""}>
        {tickAction ?? narrative ?? ""}
      </span>
      <Tip tip={timeLeftMs === 0 ? "Window expired — waiting for Polymarket to confirm outcome" : "Time remaining until window closes and resolves"}>
        <span className={`tabular-nums cursor-help ${timeLeftMs === 0 ? "text-amber-500 animate-pulse" : "text-muted-foreground"}`}>
          {timeLeftMs === 0 ? "resolving..." : `${mins}:${secs.toString().padStart(2, "0")}`}
        </span>
      </Tip>
    </div>
  );
}

// ── Single-side ActiveWindowRow (conviction, certainty) ──────────────

export interface SingleSideActiveRowProps {
  title: string;
  compact: string;
  chips?: ReactNode;
  inventory: number;
  inventorySide: "UP" | "DOWN" | null;
  avgCost: number;
  costDp?: number;
  scale: number;
  // Bid
  bidOrderId: string | null;
  bidSide: string | null;
  bidPrice: number;
  // Fills
  fillCount: number;
  flipCount?: number; maxFlips?: number;
  // Content
  tickAction?: ReactNode;
  narrative?: string;
  timeLeftMs: number;
}

export function SingleSideActiveRow(props: SingleSideActiveRowProps) {
  const {
    title, compact, chips,
    inventory, inventorySide, avgCost, costDp, scale,
    bidOrderId, bidSide, bidPrice,
    fillCount, flipCount, maxFlips,
    tickAction, narrative,
    timeLeftMs,
  } = props;
  const mins = Math.floor(timeLeftMs / 60000);
  const secs = Math.floor((timeLeftMs % 60000) / 1000);
  const dp = costDp ?? 2;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1.5 text-xs">
      <Tip tip={title}><span className="font-medium cursor-help">{compact}</span></Tip>
      {chips}
      <SingleSideInventoryBar amount={inventory} side={inventorySide} scale={scale} />
      {inventory > 0 && (
        <Tip tip={`${inventorySide} inventory: ${inventory} tokens @ $${avgCost.toFixed(dp)} avg`}>
          <span className={`tabular-nums cursor-help font-medium ${
            inventorySide === "UP" ? "text-green-600" : "text-red-600"
          }`}>
            {fmtInv(inventory)} {inventorySide ?? "?"} @{avgCost.toFixed(dp)}
          </span>
        </Tip>
      )}
      {bidOrderId && (
        <Tip tip={`Resting bid on ${bidSide} side`}>
          <span className="cursor-help">
            <span className={bidSide === "UP" ? "text-green-600" : "text-red-600"}>
              {bidSide === "UP" ? "\u25B2" : "\u25BC"}{bidPrice.toFixed(2)}
            </span>
          </span>
        </Tip>
      )}
      {fillCount > 0 && <Tip tip="Maker fills"><span className="tabular-nums cursor-help">{fillCount}f</span></Tip>}
      {(flipCount ?? 0) > 0 && (
        <Tip tip={`Direction flips (${flipCount}/${maxFlips ?? "?"} max)`}>
          <span className={`tabular-nums cursor-help ${(flipCount ?? 0) > (maxFlips ?? 999) ? "text-red-600 font-medium" : "text-amber-600"}`}>
            {flipCount}fl
          </span>
        </Tip>
      )}
      <span className="ml-auto text-[11px] text-muted-foreground italic truncate max-w-[50%]" title={typeof tickAction === "string" ? tickAction : narrative ?? ""}>
        {tickAction ?? narrative ?? "Scanning..."}
      </span>
      <Tip tip={timeLeftMs === 0 ? "Window expired — awaiting resolution" : "Time remaining"}>
        <span className={`tabular-nums cursor-help ${timeLeftMs === 0 ? "text-amber-500 animate-pulse" : "text-muted-foreground"}`}>
          {timeLeftMs === 0 ? "resolving..." : `${mins}:${secs.toString().padStart(2, "0")}`}
        </span>
      </Tip>
    </div>
  );
}

// ── ResolvingWindowRow (dual-side) ───────────────────────────────────

export interface ResolvingWindowRowProps {
  title: string;
  compact: string;
  chips?: ReactNode;
  // Dual-side
  up: number; dn: number;
  upAvgCost: number; dnAvgCost: number;
  costDp?: number;
  scale: number;
  pairCost: number | null;
  // Prediction
  prediction?: "UP" | "DOWN" | null;
  estPnl?: number | null;
  predictionText?: string;
  // Merge
  onMerge?: () => void; merging?: boolean;
}

export function ResolvingWindowRow(props: ResolvingWindowRowProps) {
  const {
    title, compact, chips,
    up, dn, upAvgCost, dnAvgCost, costDp, scale, pairCost,
    prediction, estPnl, predictionText,
    onMerge, merging,
  } = props;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border border-amber-300 bg-amber-50/50 px-2 py-1 text-xs">
      <Tip tip={title}><span className="font-medium cursor-help">{compact}</span></Tip>
      {prediction
        ? <span className={`rounded px-1 py-0 text-[10px] font-medium ${prediction === "UP" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>{prediction} ⏳</span>
        : <span className="rounded px-1 py-0 text-[10px] font-medium bg-amber-100 text-amber-800 animate-pulse">resolving</span>
      }
      {chips}
      <InventoryBar up={up} down={dn} scale={scale} />
      <DualInventoryText up={up} dn={dn} upAvgCost={upAvgCost} dnAvgCost={dnAvgCost} costDp={costDp} />
      {pairCost !== null && (
        <PairCostBadge pairCost={pairCost} />
      )}
      <PairPnl up={up} dn={dn} upAvgCost={upAvgCost} dnAvgCost={dnAvgCost} pairCost={pairCost}
        onMerge={onMerge} merging={merging} />
      {estPnl != null && (
        <span className={`ml-auto text-[11px] font-medium tabular-nums ${estPnl >= 0 ? "text-green-600" : "text-red-600"}`}>
          {estPnl >= 0 ? "+" : ""}{fmt(estPnl)}
        </span>
      )}
      {predictionText && (
        <span className="text-[11px] text-muted-foreground italic">{predictionText}</span>
      )}
    </div>
  );
}

// ── Single-side ResolvingRow ─────────────────────────────────────────

export interface SingleSideResolvingRowProps {
  title: string;
  compact: string;
  chips?: ReactNode;
  inventory: number;
  inventorySide: "UP" | "DOWN" | null;
  avgCost: number;
  costDp?: number;
  scale: number;
  prediction?: "UP" | "DOWN" | null;
  estPnl?: number | null;
  predictionText?: string;
}

export function SingleSideResolvingRow(props: SingleSideResolvingRowProps) {
  const {
    title, compact, chips,
    inventory, inventorySide, avgCost, costDp, scale,
    prediction, estPnl, predictionText,
  } = props;
  const dp = costDp ?? 2;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border border-amber-300 bg-amber-50/50 px-2 py-1 text-xs">
      <Tip tip={title}><span className="font-medium cursor-help">{compact}</span></Tip>
      <span className="rounded px-1 py-0 text-[10px] font-medium bg-amber-100 text-amber-800 animate-pulse">resolving</span>
      {chips}
      <SingleSideInventoryBar amount={inventory} side={inventorySide} scale={scale} />
      {inventory > 0 && (
        <span className={`tabular-nums font-medium ${inventorySide === "UP" ? "text-green-600" : "text-red-600"}`}>
          {fmtInv(inventory)} {inventorySide ?? "?"} @{avgCost.toFixed(dp)}
        </span>
      )}
      <span className="ml-auto text-[11px] text-muted-foreground italic">
        {predictionText ? predictionText : prediction
          ? <>{`Binance says ${prediction}`}{estPnl != null && <span className={`ml-1 font-medium ${estPnl >= 0 ? "text-green-600" : "text-red-600"}`}>{estPnl >= 0 ? "+" : ""}{fmt(estPnl)}</span>}</>
          : "awaiting Polymarket..."}
      </span>
    </div>
  );
}

// ── CompletedWindowRow (dual-side) ───────────────────────────────────

export interface CompletedWindowRowProps {
  title: string;
  compact: string;
  outcome: string;
  chips?: ReactNode;
  // Dual-side
  up: number; dn: number;
  upAvgCost: number; dnAvgCost: number;
  costDp?: number;
  scale: number;
  pairCost: number | null;
  matchedPairs?: number;
  // P&L
  netPnl: number;
  // Fills
  fillCount: number;
  takerFills?: number;
  flipCount?: number; maxFlips?: number;
  // Merge
  totalMerged?: number;
  // Rebates
  estimatedRebates?: number;
  // Duration
  durationMs?: number;
  completedAt: string;
  // Confirmation
  gammaConfirmed?: boolean;
}

export function CompletedWindowRow(props: CompletedWindowRowProps) {
  const {
    title, compact, outcome, chips,
    up, dn, upAvgCost, dnAvgCost, costDp, scale, pairCost,
    netPnl, fillCount, takerFills,
    flipCount, maxFlips,
    totalMerged,
    estimatedRebates,
    durationMs,
    completedAt,
    gammaConfirmed,
  } = props;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1 text-xs">
      <Tip tip={title}><span className="font-medium cursor-help">{compact}</span></Tip>
      <Tip tip={gammaConfirmed ? "Confirmed by Polymarket" : "Oracle-resolved (same settlement source as Polymarket)"}>
        <span className={`rounded px-1 py-0 text-[10px] font-medium cursor-help ${
          outcome === "UP" ? "bg-green-100 text-green-800" : outcome === "DOWN" ? "bg-red-100 text-red-800" : "bg-gray-100"
        }`}>{outcome}{gammaConfirmed ? " \u2705" : ""}</span>
      </Tip>
      {chips}
      <InventoryBar up={up} down={dn} scale={scale} />
      <DualInventoryText up={up} dn={dn} upAvgCost={upAvgCost} dnAvgCost={dnAvgCost} costDp={costDp} />
      <PairCostBadge pairCost={pairCost} />
      <Tip tip={`Net P&L = winning payout - losing cost + sell P&L - fees${estimatedRebates ? ` (+ est. $${estimatedRebates.toFixed(2)} rebates)` : ""}`}>
        <span className={`font-medium tabular-nums cursor-help ${netPnl >= 0 ? "text-green-600" : "text-red-600"}`}>
          {fmt(netPnl)}
        </span>
      </Tip>
      {(estimatedRebates ?? 0) > 0.01 && (
        <Tip tip="Estimated maker rebates (20% of taker fees on your maker fills)">
          <span className="tabular-nums cursor-help text-purple-600 text-[10px]">+{fmt(estimatedRebates!)} reb</span>
        </Tip>
      )}
      {fillCount > 0 && <Tip tip="Maker fills in this window"><span className="tabular-nums text-muted-foreground cursor-help">{fillCount}f</span></Tip>}
      {(takerFills ?? 0) > 0 && <Tip tip="Taker sweeps"><span className="tabular-nums cursor-help text-orange-600">{takerFills}t</span></Tip>}
      {(flipCount ?? 0) > 0 && (
        <Tip tip={`Direction flips (${flipCount}/${maxFlips ?? "?"} max)`}>
          <span className={`tabular-nums cursor-help ${(flipCount ?? 0) > (maxFlips ?? 999) ? "text-red-600 font-medium" : ""}`}>
            {flipCount}fl
          </span>
        </Tip>
      )}
      {(totalMerged ?? 0) > 0 && <Tip tip="CTF merges"><span className="tabular-nums cursor-help text-blue-600">mrg={totalMerged}</span></Tip>}
      {durationMs != null && durationMs > 0 && (
        <Tip tip="Duration of the prediction window"><span className="text-muted-foreground cursor-help">{fmtDuration(durationMs)}</span></Tip>
      )}
      <Tip tip="When this window resolved"><span className="ml-auto text-muted-foreground cursor-help">{timeAgo(completedAt)}</span></Tip>
    </div>
  );
}

// ── Single-side CompletedRow ─────────────────────────────────────────

export interface SingleSideCompletedRowProps {
  title: string;
  compact: string;
  chips?: ReactNode;
  inventory: number;
  inventorySide: "UP" | "DOWN" | null;
  avgCost: number;
  costDp?: number;
  scale: number;
  netPnl: number;
  fillCount: number;
  flipCount?: number;
  completedAt: string;
}

export function SingleSideCompletedRow(props: SingleSideCompletedRowProps) {
  const {
    title, compact, chips,
    inventory, inventorySide, avgCost, costDp, scale,
    netPnl, fillCount, flipCount, completedAt,
  } = props;
  const dp = costDp ?? 2;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1 text-xs">
      <Tip tip={title}><span className="font-medium cursor-help">{compact}</span></Tip>
      {chips}
      <SingleSideInventoryBar amount={inventory} side={inventorySide} scale={Math.max(inventory, 1)} />
      {inventory > 0 && (
        <span className={`tabular-nums ${inventorySide === "UP" ? "text-green-600" : "text-red-600"}`}>
          {fmtInv(inventory)} {inventorySide ?? "?"} @{avgCost.toFixed(dp)}
        </span>
      )}
      <Tip tip="Net P&L after resolution">
        <span className={`font-medium tabular-nums cursor-help ${netPnl >= 0 ? "text-green-600" : "text-red-600"}`}>
          ={fmt(netPnl)}
        </span>
      </Tip>
      <Tip tip="Maker fills"><span className="tabular-nums cursor-help">{fillCount}f</span></Tip>
      {(flipCount ?? 0) > 0 && <span className="tabular-nums">{flipCount}fl</span>}
      <Tip tip="When resolved"><span className="ml-auto text-muted-foreground cursor-help">{timeAgo(completedAt)}</span></Tip>
    </div>
  );
}

// ── WindowSection ────────────────────────────────────────────────────

export interface WindowSectionProps {
  sectionTitle?: string;
  sectionTip?: string;
  active: ReactNode[];
  resolving: ReactNode[];
  completed: ReactNode[];
  maxCompleted?: number;
}

export function WindowSection({ sectionTitle, sectionTip, active, resolving, completed, maxCompleted = 20 }: WindowSectionProps) {
  const shownCompleted = completed.slice(0, maxCompleted);
  return (
    <>
      {active.length > 0 && (
        <div>
          {sectionTip ? (
            <Tip tip={sectionTip}>
              <h4 className="mb-2 text-sm font-medium cursor-help">{sectionTitle ?? "Active Windows"}</h4>
            </Tip>
          ) : (
            <h4 className="mb-2 text-sm font-medium">{sectionTitle ?? "Active Windows"}</h4>
          )}
          <div className="space-y-1.5">{active}</div>
        </div>
      )}
      {(resolving.length > 0 || shownCompleted.length > 0) && (
        <div>
          <h4 className="mb-2 text-sm font-medium">
            Completed
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              ({resolving.length > 0 ? `${resolving.length} resolving, ` : ""}last {Math.min(completed.length, maxCompleted)})
            </span>
          </h4>
          <div className="space-y-1">
            {resolving}
            {shownCompleted}
          </div>
        </div>
      )}
    </>
  );
}

// ── Utility ──────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  if (ms <= 0) return "--";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}
