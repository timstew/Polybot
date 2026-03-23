"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip, TooltipTrigger, TooltipContent, TooltipProvider,
} from "@/components/ui/tooltip";
import {
  api,
  type BalanceProtection,
  type StrategyConfig,
  type StrategyState,
  type TacticInfo,
  type RegimePerformanceRow,
  type TacticScore,
} from "@/lib/api";

// ── Formatting helpers ──────────────────────────────────────────────

function fmt(n: number | undefined | null) {
  if (n == null || isNaN(n)) return "$0.00";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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
    timeStr = startP === endP ? `${start}-${end}${endP}` : `${start}${startP}-${end}${endP}`;
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

function fmtRunTime(ticks: number, tickIntervalMs: number): string {
  const ms = ticks * tickIntervalMs;
  if (ms <= 0) return "0m";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ${min % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

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
    <Tip tip="Green=UP, Red=DOWN, Purple=matched pairs">
      <svg width={W} height={H} className="cursor-help inline-block align-middle" style={{ borderRadius: 2, background: "#e5e7eb" }}>
        {upW > 0 && <rect x={0} y={0} width={upW} height={H} fill="#22c55e" />}
        {dnW > 0 && <rect x={redX} y={0} width={dnW} height={H} fill="#ef4444" />}
        {overlapW > 0 && <rect x={overlapX} y={0} width={overlapW} height={H} fill="#a855f7" />}
      </svg>
    </Tip>
  );
}

function PairPnl({ up, dn, upAvgCost, dnAvgCost, pairCost }: {
  up: number; dn: number; upAvgCost: number; dnAvgCost: number; pairCost: number | null;
}) {
  const matched = Math.min(up, dn);
  const unmatched = Math.max(up, dn) - matched;
  const lockedPnl = matched > 0 && pairCost !== null && pairCost < 1 ? matched * (1 - pairCost) : 0;
  const unmatchedSide = up > dn ? "UP" : "DOWN";
  const unmatchedAvgCost = up > dn ? upAvgCost : dnAvgCost;
  const atRisk = unmatched * unmatchedAvgCost;
  if (lockedPnl <= 0 && atRisk <= 0) return null;
  return (
    <>
      {lockedPnl > 0 && (
        <Tip tip={`${matched} pairs x $${(1 - (pairCost ?? 0)).toFixed(2)} spread`}>
          <span className="text-[10px] text-green-700 font-medium cursor-help">+{fmt(lockedPnl)}</span>
        </Tip>
      )}
      {atRisk > 0 && (
        <Tip tip={`${unmatched} unmatched ${unmatchedSide} at risk`}>
          <span className="text-[10px] text-amber-600 font-medium cursor-help">{fmt(atRisk)}!</span>
        </Tip>
      )}
    </>
  );
}

function TickAction({ text }: { text: string }) {
  if (!text) return null;
  return <span>{text}</span>;
}

// ── Regime colors ──

const REGIME_COLORS: Record<string, string> = {
  trending: "bg-blue-100 text-blue-800",
  oscillating: "bg-purple-100 text-purple-800",
  calm: "bg-gray-100 text-gray-800",
  volatile: "bg-red-100 text-red-800",
  "near-strike": "bg-amber-100 text-amber-800",
  "late-window": "bg-orange-100 text-orange-800",
};

const ALL_REGIMES = ["trending", "oscillating", "calm", "volatile", "near-strike", "late-window"] as const;

/** Tactic notes: ordered by estimated earnings potential (best first) */
const TACTIC_NOTES: Record<string, { rank: number; market: string }> = {
  "sniper":            { rank: 1, market: "Oscillating/calm crypto — structural pair arb, most consistent earner" },
  "safe-maker":        { rank: 2, market: "Oscillating/moderate vol — paired protection, never sells matched pairs" },
  "scaling-safe-maker": { rank: 3, market: "Oscillating/calm — safe-maker with adaptive sizing, starts small, ramps on wins" },
  "enhanced":          { rank: 4, market: "Volatile/near-strike — safe-maker + vol-adaptive spread + delta gates" },
  "directional-maker": { rank: 5, market: "Trending crypto — signal-biased, higher upside but more risk" },
  "avellaneda":        { rank: 6, market: "Volatile/near-strike — dual-mode (maker+taker), needs tuning" },
  "conviction":        { rank: 7, market: "Strong trending — one-sided bets, high risk/reward, no hedging" },
  "certainty":         { rank: 8, market: "Late-window only — sweeps asks when P_true > 85%, specialist" },
};

// ── Types for orchestrator state ──

interface OrchestratorStatus {
  running: boolean;
  winding_down?: boolean;
  config: StrategyConfig | null;
  state: StrategyState | null;
  balance_protection?: BalanceProtection | null;
}

interface OrchestratorCustom {
  activeWindows: ActiveWindow[];
  completedWindows: CompletedWindow[];
  assetRegimes: Record<string, RegimeStatus>;
  stats: OrchestratorStats;
  scanStatus: string;
  resolvingValue: number;
}

interface ActiveWindow {
  market: { title: string; conditionId: string };
  cryptoSymbol: string;
  tacticId: string;
  confirmedDirection: string | null;
  upInventory: number;
  downInventory: number;
  upAvgCost: number;
  downAvgCost: number;
  upBidOrderId: string | null;
  downBidOrderId: string | null;
  upBidPrice: number;
  downBidPrice: number;
  upBidSize: number;
  downBidSize: number;
  fillCount: number;
  sellCount: number;
  flipCount: number;
  windowEndTime: number;
  windowOpenTime: number;
  tickAction?: string;
  lastUpBestAsk?: number;
  lastDnBestAsk?: number;
  rebalanceSold?: boolean;
}

interface CompletedWindow {
  title: string;
  cryptoSymbol: string;
  tacticId: string;
  regime: string;
  outcome: string;
  upInventory: number;
  downInventory: number;
  upAvgCost: number;
  downAvgCost: number;
  matchedPairs: number;
  netPnl: number;
  fillCount: number;
  sellCount: number;
  completedAt: string;
  priceMovePct: number;
  windowDurationMs: number;
}

interface RegimeStatus {
  confirmedRegime: string;
  confidence: number;
  streak: number;
  emaScores?: Record<string, number>;
  pendingTransition?: string | null;
  pendingCount?: number;
}

interface OrchestratorStats {
  totalPnl: number;
  windowsTraded: number;
  perTactic: Record<string, { windows: number; pnl: number; wins: number }>;
  perRegime: Record<string, { windows: number; pnl: number }>;
}

// ── Main Page ──

export default function OrchestratorPage() {
  const [configs, setConfigs] = useState<StrategyConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [tactics, setTactics] = useState<TacticInfo[]>([]);
  const [perfData, setPerfData] = useState<RegimePerformanceRow[]>([]);
  const [tacticScores, setTacticScores] = useState<TacticScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [mappingDraft, setMappingDraft] = useState<Record<string, string[]> | null>(null);
  const [mappingSaving, setMappingSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [allStatuses, allConfigs, tacticList] = await Promise.all([
        api.strategyStatuses(),
        api.strategyConfigs(),
        api.tactics(),
      ]);

      const orchConfigs = allConfigs.filter(c => c.strategy_type === "orchestrator");
      setConfigs(orchConfigs);
      setTactics(tacticList);

      // Auto-select first orchestrator if none selected
      const id = selectedId && orchConfigs.find(c => c.id === selectedId)
        ? selectedId
        : orchConfigs.length > 0 ? orchConfigs[0].id : null;
      setSelectedId(id);

      if (id && allStatuses[id]) {
        setStatus(allStatuses[id] as OrchestratorStatus);
        // Load perf data + tactic scores
        try {
          const [perf, scores] = await Promise.all([
            api.regimePerformance(id),
            api.tacticScores(id).catch(() => [] as TacticScore[]),
          ]);
          setPerfData(perf);
          setTacticScores(scores);
        } catch { setPerfData([]); setTacticScores([]); }
      } else {
        setStatus(null);
        setPerfData([]);
        setTacticScores([]);
      }
    } catch (e) {
      console.error("Orchestrator refresh failed:", e);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
  }, [refresh]);

  const config = status?.config ?? configs.find(c => c.id === selectedId) ?? null;
  const state = status?.state ?? null;
  const custom = state?.custom as unknown as OrchestratorCustom | undefined;
  const isRunning = status?.running ?? false;
  const isWindingDown = status?.winding_down ?? false;
  const bp = status?.balance_protection;

  const handleCreate = async () => {
    setActionLoading(true);
    try {
      const result = await api.strategyCreateConfig({
        name: "orchestrator",
        strategy_type: "orchestrator",
        mode: "paper",
        params: JSON.stringify({
          target_cryptos: ["Bitcoin", "Ethereum", "Solana", "XRP"],
          regime_mapping: {
            trending: ["directional-maker"],
            oscillating: ["sniper"],
            calm: ["sniper"],
            volatile: ["sniper"],
            "near-strike": ["sniper"],
            "late-window": ["sniper"],
          },
        }),
        tick_interval_ms: 5000,
        max_capital_usd: 50,
      });
      setSelectedId(result.id);
      await refresh();
    } catch (e) {
      console.error("Create failed:", e);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStart = async () => {
    if (!selectedId) return;
    setActionLoading(true);
    try {
      await api.strategyStart(selectedId);
      await refresh();
    } finally { setActionLoading(false); }
  };

  const handleStop = async () => {
    if (!selectedId) return;
    setActionLoading(true);
    try {
      await api.strategyStop(selectedId);
      await refresh();
    } finally { setActionLoading(false); }
  };

  const handleSaveMapping = async () => {
    if (!selectedId || !config || !mappingDraft) return;
    setMappingSaving(true);
    try {
      const currentParams = typeof config.params === "string"
        ? JSON.parse(config.params || "{}")
        : (config.params || {});
      const updatedParams = { ...currentParams, regime_mapping: mappingDraft };
      await api.strategyUpdateConfig(selectedId, { params: JSON.stringify(updatedParams) });
      setMappingDraft(null);
      await refresh();
    } catch (e) {
      console.error("Save mapping failed:", e);
    } finally {
      setMappingSaving(false);
    }
  };

  // Parse regime_mapping from config params (params may be a JSON string or already-parsed object)
  const configParams = config ? (() => {
    try {
      if (typeof config.params === "string") return JSON.parse(config.params || "{}");
      if (typeof config.params === "object" && config.params) return config.params;
      return {};
    } catch { return {}; }
  })() : {};
  const regimeMapping: Record<string, string[]> = mappingDraft ?? configParams.regime_mapping ?? {};

  // Stats
  const stats = custom?.stats;
  const totalPnl = stats?.totalPnl ?? state?.total_pnl ?? 0;
  const windowsTraded = stats?.windowsTraded ?? 0;
  const totalWins = stats?.perTactic
    ? Object.values(stats.perTactic).reduce((s, t) => s + t.wins, 0) : 0;
  const winRate = windowsTraded > 0 ? (totalWins / windowsTraded * 100).toFixed(0) : "—";

  // Windows
  const allActiveWindows = custom?.activeWindows ?? [];
  const activeWindows = allActiveWindows.filter(w => w.windowEndTime > Date.now());
  const resolvingWindows = allActiveWindows.filter(w => w.windowEndTime <= Date.now());
  const completedWindows = custom?.completedWindows ?? [];

  // Regimes
  const assetRegimes = custom?.assetRegimes ?? {};

  return (
    <TooltipProvider delayDuration={200}>
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-bold">Orchestrator</h1>

        {/* Section 1: Control Bar */}
        <Card>
          <CardContent className="pt-6">
            {configs.length === 0 && !loading ? (
              <div className="flex items-center gap-4">
                <span className="text-sm text-muted-foreground">No orchestrator configs found.</span>
                <Button onClick={handleCreate} disabled={actionLoading} size="sm">
                  {actionLoading ? "Creating..." : "Create Orchestrator"}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                {/* Config selector */}
                {configs.length > 1 && (
                  <select
                    className="rounded border px-2 py-1 text-sm"
                    value={selectedId ?? ""}
                    onChange={e => setSelectedId(e.target.value)}
                  >
                    {configs.map(c => (
                      <option key={c.id} value={c.id}>{c.name} ({c.id.slice(-6)})</option>
                    ))}
                  </select>
                )}
                {configs.length === 1 && (
                  <span className="text-sm font-medium">{config?.name ?? "orchestrator"}</span>
                )}

                {/* Status badge */}
                <Badge variant={isRunning ? (isWindingDown ? "secondary" : "default") : "outline"}>
                  {isRunning ? (isWindingDown ? "Winding Down" : "Running") : "Stopped"}
                </Badge>
                {config && <Badge variant="outline">{config.mode}</Badge>}

                {/* Start/Stop */}
                <div className="flex gap-2">
                  {!isRunning && (
                    <Button size="sm" onClick={handleStart} disabled={actionLoading || !selectedId}>
                      Start
                    </Button>
                  )}
                  {isRunning && (
                    <Button size="sm" variant="destructive" onClick={handleStop} disabled={actionLoading}>
                      Stop
                    </Button>
                  )}
                </div>

                {/* Summary stats */}
                <div className="ml-auto flex flex-wrap items-center gap-4 text-sm">
                  <Tip tip="Total P&L from all resolved windows">
                    <span className={`font-bold tabular-nums cursor-help ${totalPnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {fmt(totalPnl)}
                    </span>
                  </Tip>
                  <Tip tip="Windows traded / Win rate">
                    <span className="tabular-nums text-muted-foreground cursor-help">
                      {windowsTraded}w {winRate}%
                    </span>
                  </Tip>
                  {state && config && (
                    <Tip tip="Active runtime">
                      <span className="text-muted-foreground cursor-help">
                        {fmtRunTime(state.ticks, config.tick_interval_ms)}
                      </span>
                    </Tip>
                  )}
                  {bp && (
                    <Tip tip={`Balance: ${fmt(bp.current_balance)} | Locked: ${fmt(bp.locked_amount)} | Working: ${fmt(bp.working_capital)}`}>
                      <span className={`tabular-nums cursor-help ${bp.capital_status === "exhausted" ? "text-red-600" : bp.capital_status === "low" ? "text-amber-600" : "text-muted-foreground"}`}>
                        {fmt(bp.working_capital)} avail
                      </span>
                    </Tip>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Scan status */}
        {custom?.scanStatus && (
          <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground italic">
            {custom.scanStatus}
          </div>
        )}

        {/* Section 2: Regime Status Grid */}
        {Object.keys(assetRegimes).length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Regime Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs py-1.5 px-3">Asset</TableHead>
                      <TableHead className="text-xs py-1.5 px-3">Duration</TableHead>
                      <TableHead className="text-xs py-1.5 px-3">Regime</TableHead>
                      <TableHead className="text-xs py-1.5 px-3">Confidence</TableHead>
                      <TableHead className="text-xs py-1.5 px-3">Streak</TableHead>
                      <TableHead className="text-xs py-1.5 px-3">EMA Scores</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(assetRegimes).map(([key, rs]) => {
                      const [asset, duration] = key.split(":");
                      return (
                        <TableRow key={key}>
                          <TableCell className="text-xs py-1.5 px-3 font-medium">{asset}</TableCell>
                          <TableCell className="text-xs py-1.5 px-3">{duration}</TableCell>
                          <TableCell className="text-xs py-1.5 px-3">
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${REGIME_COLORS[rs.confirmedRegime] ?? "bg-gray-100"}`}>
                              {rs.confirmedRegime}
                            </span>
                            {rs.pendingTransition && (
                              <Tip tip={`Pending transition to ${rs.pendingTransition} (${rs.pendingCount ?? 0}/2 confirmations)`}>
                                <span className="ml-1 text-[10px] text-amber-600 cursor-help">
                                  {"->"}{rs.pendingTransition}
                                </span>
                              </Tip>
                            )}
                          </TableCell>
                          <TableCell className="text-xs py-1.5 px-3 tabular-nums">
                            {(rs.confidence * 100).toFixed(0)}%
                          </TableCell>
                          <TableCell className="text-xs py-1.5 px-3 tabular-nums">{rs.streak}</TableCell>
                          <TableCell className="py-1.5 px-3">
                            <EmaScoreBars scores={rs.emaScores ?? {}} confirmed={rs.confirmedRegime} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Section 3: Active Windows */}
        {activeWindows.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Active Windows ({activeWindows.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs py-1.5 px-2">Market</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">Tactic</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">Direction</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">Inventory</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">Pair Cost</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">Fills</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">Time Left</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activeWindows.map((w, i) => {
                      const up = w.upInventory ?? 0;
                      const dn = w.downInventory ?? 0;
                      const pairCost = (up > 0 && dn > 0) ? w.upAvgCost + w.downAvgCost : null;
                      const compact = compactTitle(w.market.title) || w.cryptoSymbol;
                      const timeLeft = Math.max(0, w.windowEndTime - Date.now());
                      const mins = Math.floor(timeLeft / 60000);
                      const secs = Math.floor((timeLeft % 60000) / 1000);
                      return (
                        <TableRow key={i}>
                          <TableCell className="text-xs py-1 px-2">
                            <Tip tip={w.market.title}><span className="font-medium cursor-help">{compact}</span></Tip>
                          </TableCell>
                          <TableCell className="text-xs py-1 px-2">
                            <Badge variant="outline" className="text-[9px]">{w.tacticId}</Badge>
                          </TableCell>
                          <TableCell className="text-xs py-1 px-2">
                            {w.confirmedDirection ? (
                              <span className={w.confirmedDirection === "UP" ? "text-green-600 font-medium" : "text-red-600 font-medium"}>
                                {w.confirmedDirection}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs py-1 px-2">
                            <div className="flex items-center gap-1">
                              <InventoryBar up={up} down={dn} scale={w.upBidSize || 30} />
                              <span className="tabular-nums text-[10px]">
                                <span className="text-green-600">{fmtInv(up)}</span>/<span className="text-red-600">{fmtInv(dn)}</span>
                              </span>
                              <PairPnl up={up} dn={dn} upAvgCost={w.upAvgCost} dnAvgCost={w.downAvgCost} pairCost={pairCost} />
                            </div>
                          </TableCell>
                          <TableCell className="text-xs py-1 px-2 tabular-nums">
                            {pairCost !== null ? (
                              <span className={`font-medium rounded px-1 py-0 text-[10px] ${
                                pairCost < 0.90 ? "bg-green-100 text-green-800" : pairCost <= 0.95 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"
                              }`}>{pairCost.toFixed(2)}</span>
                            ) : "—"}
                          </TableCell>
                          <TableCell className="text-xs py-1 px-2 tabular-nums">{w.fillCount}</TableCell>
                          <TableCell className="text-xs py-1 px-2 tabular-nums">
                            {mins}:{secs.toString().padStart(2, "0")}
                          </TableCell>
                          <TableCell className="text-xs py-1 px-2 text-muted-foreground italic truncate max-w-[200px]">
                            <TickAction text={w.tickAction ?? ""} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Resolving windows */}
        {resolvingWindows.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base text-amber-600">
                Resolving ({resolvingWindows.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {resolvingWindows.map((w, i) => {
                  const up = w.upInventory ?? 0;
                  const dn = w.downInventory ?? 0;
                  const compact = compactTitle(w.market.title) || w.cryptoSymbol;
                  return (
                    <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border border-amber-300 bg-amber-50/50 px-2 py-1 text-xs">
                      <span className="font-medium">{compact}</span>
                      <Badge variant="outline" className="text-[9px]">{w.tacticId}</Badge>
                      <span className="rounded px-1 py-0 text-[10px] font-medium bg-amber-100 text-amber-800 animate-pulse">resolving</span>
                      <InventoryBar up={up} down={dn} scale={w.upBidSize || 30} />
                      <span className="tabular-nums text-[10px]">
                        <span className="text-green-600">{fmtInv(up)}</span>/<span className="text-red-600">{fmtInv(dn)}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Section 4: Tactic Mapping Editor (drag-and-drop) */}
        {selectedId && config && (
          <TacticMappingEditor
            regimeMapping={regimeMapping}
            tactics={tactics}
            mappingDraft={mappingDraft}
            setMappingDraft={setMappingDraft}
            mappingSaving={mappingSaving}
            onSave={handleSaveMapping}
            tacticScores={tacticScores}
          />
        )}

        {/* Section 5: Performance Summary */}
        {stats && windowsTraded > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Performance</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Per-tactic stats */}
              {Object.keys(stats.perTactic).length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">Per Tactic</h4>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {Object.entries(stats.perTactic).map(([tid, ts]) => {
                      const losses = ts.windows - ts.wins;
                      const wr = ts.windows > 0 ? (ts.wins / ts.windows * 100).toFixed(0) : "—";
                      return (
                        <div key={tid} className="rounded-lg border p-3">
                          <div className="text-sm font-medium">{tid}</div>
                          <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground mt-1">
                            <span>{ts.windows}w</span>
                            <span className="text-green-600">{ts.wins}W</span>
                            <span className="text-red-600">{losses}L</span>
                            <span>{wr}%</span>
                          </div>
                          <div className={`text-sm font-bold tabular-nums mt-1 ${ts.pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {fmt(ts.pnl)}
                            {ts.windows > 0 && (
                              <span className="ml-1 text-xs font-normal text-muted-foreground">
                                ({fmt(ts.pnl / ts.windows)}/w)
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Per-regime stats */}
              {Object.keys(stats.perRegime).length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">Per Regime</h4>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    {Object.entries(stats.perRegime).map(([regime, rs]) => (
                      <div key={regime} className="rounded-lg border p-2">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium mb-1 ${REGIME_COLORS[regime] ?? "bg-gray-100"}`}>
                          {regime}
                        </span>
                        <div className="text-xs text-muted-foreground">{rs.windows}w</div>
                        <div className={`text-sm font-bold tabular-nums ${rs.pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                          {fmt(rs.pnl)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Regime x Tactic heatmap */}
              {perfData.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">Regime x Tactic (from D1)</h4>
                  <PerformanceHeatmap data={perfData} />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Section 6: Completed Windows */}
        {completedWindows.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Completed Windows
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  (last {Math.min(completedWindows.length, 30)})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs py-1.5 px-2">Market</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">Tactic</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">Regime</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">Outcome</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">Pairs</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">P&L</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">Duration</TableHead>
                      <TableHead className="text-xs py-1.5 px-2">Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {completedWindows.slice(-30).reverse().map((w, i) => {
                      const pairCost = (w.upInventory > 0 && w.downInventory > 0)
                        ? w.upAvgCost + w.downAvgCost : null;
                      return (
                        <TableRow key={i}>
                          <TableCell className="text-xs py-1 px-2">
                            <Tip tip={w.title}>
                              <span className="font-medium cursor-help">{compactTitle(w.title) || w.cryptoSymbol}</span>
                            </Tip>
                          </TableCell>
                          <TableCell className="text-xs py-1 px-2">
                            <Badge variant="outline" className="text-[9px]">{w.tacticId}</Badge>
                          </TableCell>
                          <TableCell className="text-xs py-1 px-2">
                            <span className={`rounded px-1 py-0 text-[9px] font-medium ${REGIME_COLORS[w.regime] ?? "bg-gray-100"}`}>
                              {w.regime}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs py-1 px-2">
                            <span className={`font-medium ${w.outcome === "UP" ? "text-green-600" : w.outcome === "DOWN" ? "text-red-600" : ""}`}>
                              {w.outcome}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs py-1 px-2 tabular-nums">
                            {w.matchedPairs}p
                            {pairCost !== null && (
                              <span className={`ml-1 text-[10px] ${pairCost < 0.93 ? "text-green-500" : "text-red-500"}`}>
                                pc={pairCost.toFixed(2)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className={`text-xs py-1 px-2 tabular-nums font-medium ${w.netPnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {fmt(w.netPnl)}
                          </TableCell>
                          <TableCell className="text-xs py-1 px-2 text-muted-foreground">
                            {fmtDuration(w.windowDurationMs)}
                          </TableCell>
                          <TableCell className="text-xs py-1 px-2 text-muted-foreground">
                            {timeAgo(w.completedAt)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Loading / empty state */}
        {loading && (
          <div className="text-center text-sm text-muted-foreground py-8">Loading...</div>
        )}
        {!loading && configs.length > 0 && !isRunning && windowsTraded === 0 && (
          <div className="text-center text-sm text-muted-foreground py-8">
            Orchestrator is stopped. Start it to begin regime-based trading.
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

// ── Tactic Mapping Editor (drag-and-drop) ──

function TacticMappingEditor({
  regimeMapping, tactics, mappingDraft, setMappingDraft, mappingSaving, onSave, tacticScores,
}: {
  regimeMapping: Record<string, string[]>;
  tactics: TacticInfo[];
  mappingDraft: Record<string, string[]> | null;
  setMappingDraft: (d: Record<string, string[]> | null) => void;
  mappingSaving: boolean;
  onSave: () => void;
  tacticScores: TacticScore[];
}) {
  // Build lookup: "regime:tactic_id" → TacticScore
  const scoreMap = new Map<string, TacticScore>();
  for (const s of tacticScores) scoreMap.set(`${s.regime}:${s.tactic_id}`, s);

  // Find best tactic per regime (highest avg_pnl with n >= 5)
  const bestPerRegime = new Map<string, string>();
  for (const regime of ALL_REGIMES) {
    let bestAvg = -Infinity;
    let bestTid = "";
    for (const s of tacticScores) {
      if (s.regime === regime && s.n >= 5 && s.avg_pnl > bestAvg) {
        bestAvg = s.avg_pnl; bestTid = s.tactic_id;
      }
    }
    if (bestTid) bestPerRegime.set(regime, bestTid);
  }

  const [expandedTactic, setExpandedTactic] = useState<string | null>(null);
  const isEditing = mappingDraft !== null;
  const mapping = mappingDraft ?? regimeMapping;

  // Sort tactics by rank
  const sortedTactics = [...tactics].sort((a, b) => {
    const ra = TACTIC_NOTES[a.id]?.rank ?? 99;
    const rb = TACTIC_NOTES[b.id]?.rank ?? 99;
    return ra - rb;
  });

  function ensureEditing(): Record<string, string[]> {
    if (mappingDraft) return mappingDraft;
    // Deep-copy current mapping to start editing
    const draft: Record<string, string[]> = {};
    for (const r of ALL_REGIMES) draft[r] = [...(regimeMapping[r] ?? [])];
    setMappingDraft(draft);
    return draft;
  }

  const [dropTarget, setDropTarget] = useState<{ regime: string; insertIdx: number } | null>(null);

  function handleDragStart(e: React.DragEvent, tacticId: string, fromRegime: string | null, fromIdx: number) {
    e.dataTransfer.setData("tacticId", tacticId);
    e.dataTransfer.setData("fromRegime", fromRegime ?? "");
    e.dataTransfer.setData("fromIdx", String(fromIdx));
    e.dataTransfer.effectAllowed = "copyMove";
  }

  function getInsertIdx(e: React.DragEvent, container: HTMLElement, items: string[]): number {
    // Find which item we're hovering over and whether it's top or bottom half
    const children = Array.from(container.querySelectorAll("[data-tactic-idx]"));
    for (const child of children) {
      const rect = (child as HTMLElement).getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        return parseInt((child as HTMLElement).dataset.tacticIdx!, 10);
      }
    }
    return items.length; // append at end
  }

  function handleDragOverRegime(e: React.DragEvent, regime: string) {
    e.preventDefault();
    const container = e.currentTarget as HTMLElement;
    const items = mapping[regime] ?? [];
    const idx = getInsertIdx(e, container, items);
    setDropTarget({ regime, insertIdx: idx });
  }

  function handleDrop(e: React.DragEvent, toRegime: string) {
    e.preventDefault();
    const tacticId = e.dataTransfer.getData("tacticId");
    const fromRegime = e.dataTransfer.getData("fromRegime");
    const fromIdx = parseInt(e.dataTransfer.getData("fromIdx"), 10);
    if (!tacticId) { setDropTarget(null); return; }

    const draft = ensureEditing();
    const updated = { ...draft };

    // If reordering within the same regime, remove then insert at new position
    if (fromRegime === toRegime && fromRegime) {
      const list = [...(updated[toRegime] ?? [])];
      const rawInsert = dropTarget?.regime === toRegime
        ? dropTarget.insertIdx : list.length;
      // Adjust: after removing fromIdx, indices shift down
      list.splice(fromIdx, 1);
      const adjustedIdx = rawInsert > fromIdx
        ? Math.min(rawInsert - 1, list.length)
        : Math.min(rawInsert, list.length);
      list.splice(adjustedIdx, 0, tacticId);
      updated[toRegime] = list;
    } else {
      // Copy to target (tactics can appear in multiple regimes)
      if (!updated[toRegime]) updated[toRegime] = [];
      // Don't duplicate within same regime
      if (!updated[toRegime].includes(tacticId)) {
        const list = [...updated[toRegime]];
        const insertAt = dropTarget?.regime === toRegime
          ? Math.min(dropTarget.insertIdx, list.length)
          : list.length;
        list.splice(insertAt, 0, tacticId);
        updated[toRegime] = list;
      }
    }

    setDropTarget(null);
    setMappingDraft(updated);
  }

  function handleDropToPool(e: React.DragEvent) {
    e.preventDefault();
    setDropTarget(null);
    const tacticId = e.dataTransfer.getData("tacticId");
    const fromRegime = e.dataTransfer.getData("fromRegime");
    if (!tacticId || !fromRegime) return;

    const draft = ensureEditing();
    const updated = { ...draft };
    if (updated[fromRegime]) {
      const idx = updated[fromRegime].indexOf(tacticId);
      if (idx >= 0) {
        updated[fromRegime] = [...updated[fromRegime]];
        updated[fromRegime].splice(idx, 1);
      }
    }
    setMappingDraft(updated);
  }

  function handleRemove(regime: string, idx: number) {
    const draft = ensureEditing();
    const updated = { ...draft };
    updated[regime] = [...(updated[regime] ?? [])];
    updated[regime].splice(idx, 1);
    setMappingDraft(updated);
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Tactic Mapping</CardTitle>
          <div className="flex items-center gap-2">
            {!isEditing && (
              <span className="text-xs text-muted-foreground">Drag tactics between columns to edit</span>
            )}
            {isEditing && (
              <>
                <Button size="sm" variant="outline" onClick={() => setMappingDraft(null)}>Cancel</Button>
                <Button size="sm" onClick={onSave} disabled={mappingSaving}>
                  {mappingSaving ? "Saving..." : "Save"}
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {ALL_REGIMES.map(regime => {
            const assigned = mapping[regime] ?? [];
            const isOver = dropTarget?.regime === regime;
            const insertIdx = isOver ? dropTarget.insertIdx : -1;
            return (
              <div
                key={regime}
                className={`rounded-lg border p-2 min-h-[80px] transition-colors ${isOver ? "border-blue-400 bg-blue-50/50" : ""}`}
                onDragOver={e => handleDragOverRegime(e, regime)}
                onDragLeave={() => setDropTarget(null)}
                onDrop={e => handleDrop(e, regime)}
              >
                <div className={`text-[10px] font-medium rounded px-1.5 py-0.5 mb-2 inline-block ${REGIME_COLORS[regime]}`}>
                  {regime}
                </div>
                <div className="space-y-0">
                  {assigned.map((tid, idx) => (
                    <React.Fragment key={`${tid}-${idx}`}>
                      {isOver && insertIdx === idx && (
                        <div className="h-0.5 bg-blue-400 rounded my-0.5" />
                      )}
                      <div
                        data-tactic-idx={idx}
                        draggable
                        onDragStart={e => handleDragStart(e, tid, regime, idx)}
                        className="group flex items-center gap-1 cursor-grab active:cursor-grabbing py-0.5"
                      >
                        <span className="text-[9px] text-muted-foreground w-3 text-right tabular-nums">{idx + 1}</span>
                        <Tip tip={TACTIC_NOTES[tid]?.market ?? ""}>
                          <span>
                            <Badge variant="secondary" className="text-[10px] select-none cursor-grab">
                              {bestPerRegime.get(regime) === tid ? "★ " : ""}{tid}
                            </Badge>
                          </span>
                        </Tip>
                        {(() => {
                          const sc = scoreMap.get(`${regime}:${tid}`);
                          if (!sc) return null;
                          const color = sc.n < 5 ? "text-gray-400" : sc.avg_pnl >= 0 ? "text-green-600" : "text-red-500";
                          return (
                            <span className={`text-[9px] tabular-nums ${color}`}>
                              {sc.avg_pnl >= 0 ? "+" : ""}{sc.avg_pnl.toFixed(2)}/w ({sc.n}w)
                            </span>
                          );
                        })()}
                        <button
                          className="text-[10px] text-red-400 opacity-0 group-hover:opacity-100 hover:text-red-600 transition-opacity"
                          onClick={() => handleRemove(regime, idx)}
                        >x</button>
                      </div>
                    </React.Fragment>
                  ))}
                  {isOver && insertIdx >= assigned.length && (
                    <div className="h-0.5 bg-blue-400 rounded my-0.5" />
                  )}
                  {assigned.length === 0 && !isOver && (
                    <span className="text-[10px] text-muted-foreground italic">drop here</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Available tactics pool */}
        <div
          className={`mt-4 rounded-lg border border-dashed p-3 transition-colors ${dropTarget?.regime === "_pool" ? "border-red-400 bg-red-50/30" : ""}`}
          onDragOver={e => { e.preventDefault(); setDropTarget({ regime: "_pool", insertIdx: 0 }); }}
          onDragLeave={() => setDropTarget(null)}
          onDrop={handleDropToPool}
        >
          <div className="text-xs font-medium text-muted-foreground mb-2">
            All Tactics (drag to regime columns — tactics can be in multiple regimes, drag back here to remove)
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {sortedTactics.map(t => {
              const note = TACTIC_NOTES[t.id];
              const tacticRows = tacticScores.filter(s => s.tactic_id === t.id);
              const isExpanded = expandedTactic === t.id;
              return (
                <div
                  key={t.id}
                  draggable
                  onDragStart={e => handleDragStart(e, t.id, null, -1)}
                  className="flex flex-col text-xs rounded border px-2 py-1.5 cursor-grab active:cursor-grabbing hover:border-blue-300"
                >
                  <div className="flex items-start gap-2">
                    <div className="shrink-0 flex flex-col items-center gap-0.5">
                      <Badge variant="secondary" className="text-[10px] select-none">
                        {note?.rank ? `#${note.rank} ` : ""}{t.id}
                      </Badge>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{t.displayName}</div>
                      <div className="text-muted-foreground text-[10px]">{t.description}</div>
                      {note && (
                        <div className="text-[10px] text-blue-600 mt-0.5">{note.market}</div>
                      )}
                      {t.naturalRegimes.length > 0 && (
                        <div className="mt-0.5 flex flex-wrap gap-0.5">
                          {t.naturalRegimes.map(r => (
                            <span key={r} className={`inline-block rounded px-1 py-0 text-[9px] ${REGIME_COLORS[r] ?? "bg-gray-100"}`}>{r}</span>
                          ))}
                        </div>
                      )}
                      {/* Per-regime score chips */}
                      {tacticRows.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {tacticRows.map(s => {
                            const color = s.n < 5 ? "bg-gray-100 text-gray-500" : s.avg_pnl >= 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700";
                            return (
                              <span key={s.regime} className={`inline-block rounded px-1 py-0 text-[9px] tabular-nums ${color}`}>
                                {s.regime}: {s.avg_pnl >= 0 ? "+" : ""}{s.avg_pnl.toFixed(2)} ({s.n}w)
                              </span>
                            );
                          })}
                          <button
                            className="text-[9px] text-blue-500 hover:text-blue-700"
                            onClick={e => { e.stopPropagation(); setExpandedTactic(isExpanded ? null : t.id); }}
                            onMouseDown={e => e.stopPropagation()}
                            draggable={false}
                          >{isExpanded ? "▴" : "▾"}</button>
                        </div>
                      )}
                      {tacticRows.length === 0 && (
                        <div className="mt-1 text-[9px] text-muted-foreground italic">Not yet tested</div>
                      )}
                    </div>
                  </div>
                  {/* Expandable detail table */}
                  {isExpanded && tacticRows.length > 0 && (
                    <div className="mt-1.5 border-t pt-1.5" onMouseDown={e => e.stopPropagation()} draggable={false}>
                      <table className="w-full text-[10px]">
                        <thead>
                          <tr className="text-muted-foreground">
                            <th className="text-left font-medium pr-2">Regime</th>
                            <th className="text-right font-medium pr-2">Windows</th>
                            <th className="text-right font-medium pr-2">Avg P&L</th>
                            <th className="text-right font-medium pr-2">Win Rate</th>
                            <th className="text-right font-medium">Var</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tacticRows.map(s => {
                            const wr = s.n > 0 ? ((s.wins / s.n) * 100).toFixed(0) : "—";
                            const rowColor = s.n < 5 ? "text-gray-400" : s.avg_pnl >= 0 ? "" : "text-red-500";
                            return (
                              <tr key={s.regime} className={`tabular-nums ${rowColor}`}>
                                <td className="pr-2">
                                  <span className={`inline-block rounded px-1 py-0 ${REGIME_COLORS[s.regime] ?? "bg-gray-100"}`}>{s.regime}</span>
                                </td>
                                <td className="text-right pr-2">{s.n}</td>
                                <td className="text-right pr-2">{s.avg_pnl >= 0 ? "+" : ""}{s.avg_pnl.toFixed(3)}</td>
                                <td className="text-right pr-2">{wr}%</td>
                                <td className="text-right">{s.variance.toFixed(4)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── EMA Score Bars Component ──

function EmaScoreBars({ scores, confirmed }: { scores: Record<string, number>; confirmed: string }) {
  return (
    <div className="flex items-center gap-0.5">
      {ALL_REGIMES.map(regime => {
        const score = scores[regime] ?? 0;
        const isActive = regime === confirmed;
        const W = 24, H = 10;
        const barW = score * W;
        return (
          <Tip key={regime} tip={`${regime}: ${(score * 100).toFixed(0)}%`}>
            <svg width={W} height={H} className="cursor-help" style={{ borderRadius: 1 }}>
              <rect x={0} y={0} width={W} height={H} fill={isActive ? "#e2e8f0" : "#f8fafc"} rx={1} />
              <rect x={0} y={0} width={barW} height={H} fill={isActive ? "#3b82f6" : "#94a3b8"} rx={1} />
            </svg>
          </Tip>
        );
      })}
    </div>
  );
}

// ── Performance Heatmap Component ──

function PerformanceHeatmap({ data }: { data: RegimePerformanceRow[] }) {
  const regimes = [...new Set(data.map(d => d.regime))];
  const tacticIds = [...new Set(data.map(d => d.tactic_id))];

  if (regimes.length === 0 || tacticIds.length === 0) return null;

  const lookup = new Map<string, RegimePerformanceRow>();
  for (const row of data) {
    lookup.set(`${row.regime}:${row.tactic_id}`, row);
  }

  const maxPnl = Math.max(...data.map(d => Math.abs(d.total_pnl)), 1);

  return (
    <div className="rounded-lg border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-[10px] py-1 px-2">Regime \ Tactic</TableHead>
            {tacticIds.map(tid => (
              <TableHead key={tid} className="text-[10px] py-1 px-2 text-center">{tid}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {regimes.map(regime => (
            <TableRow key={regime}>
              <TableCell className="text-[10px] py-1 px-2">
                <span className={`rounded px-1 py-0 text-[9px] font-medium ${REGIME_COLORS[regime] ?? "bg-gray-100"}`}>
                  {regime}
                </span>
              </TableCell>
              {tacticIds.map(tid => {
                const row = lookup.get(`${regime}:${tid}`);
                if (!row) return <TableCell key={tid} className="text-center py-1 px-2">—</TableCell>;
                const intensity = Math.min(Math.abs(row.total_pnl) / maxPnl, 1);
                const alpha = 0.15 + intensity * 0.55;
                const bg = row.total_pnl >= 0
                  ? `rgba(22, 163, 74, ${alpha})`
                  : `rgba(220, 38, 38, ${alpha})`;
                const wr = row.windows > 0 ? (row.wins / row.windows * 100).toFixed(0) : "0";
                return (
                  <TableCell key={tid} className="text-center py-1 px-2" style={{ background: bg }}>
                    <Tip tip={`${regime} + ${tid}: ${row.windows}w, ${wr}% win, ${fmt(row.total_pnl)} P&L`}>
                      <div className="cursor-help">
                        <div className={`text-[10px] font-bold tabular-nums ${row.total_pnl >= 0 ? "text-green-800" : "text-red-800"}`}>
                          {fmt(row.total_pnl)}
                        </div>
                        <div className="text-[9px] text-muted-foreground">
                          {row.windows}w {wr}%
                        </div>
                      </div>
                    </Tip>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
