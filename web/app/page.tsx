"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WalletLink } from "@/components/wallet-link";
import { PnlCell } from "@/components/pnl-cell";
import { CategoryBadge, CategoryBadges } from "@/components/category-badge";
import { Legend } from "@/components/legend";
import { api, type UnifiedBotRow, type Stats } from "@/lib/api";
import {
  Radio,
  Search,
  Activity,
  Bot,
  Clock,
  Copy,
  Database,
  Trash2,
} from "lucide-react";

function fmt(n: number) {
  return `$${(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtHold(hours: number): string {
  if (!hours || hours <= 0) return "\u2014";
  if (hours >= 24) return `${(hours / 24).toFixed(1)}d`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  const mins = hours * 60;
  if (mins >= 1) return `${mins.toFixed(0)}m`;
  return `${(mins * 60).toFixed(0)}s`;
}

function fmtTimer(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0s";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const categoryColor: Record<string, string> = {
  market_maker: "bg-blue-100 text-blue-800",
  arbitrageur: "bg-purple-100 text-purple-800",
  momentum: "bg-orange-100 text-orange-800",
  contrarian: "bg-pink-100 text-pink-800",
  sniper: "bg-red-100 text-red-800",
  whale_follower: "bg-teal-100 text-teal-800",
  unknown: "bg-gray-100 text-gray-800",
};

const MARKET_CATEGORIES = new Set([
  "crypto",
  "politics",
  "sports",
  "finance",
  "pop culture",
  "crypto markets",
]);

type SortKey =
  | "confidence"
  | "copy_score"
  | "pnl_pct"
  | "portfolio_value"
  | "realized_pnl"
  | "unrealized_pnl"
  | "total_volume_usd"
  | "win_rate"
  | "avg_hold_time_hours"
  | "active_positions"
  | "profit_1d"
  | "profit_7d"
  | "profit_30d"
  | "profit_all";

type SortDir = "asc" | "desc";

function SortableHead({
  label,
  sortKey,
  currentKey,
  currentDir,
  onSort,
  className = "",
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = currentKey === sortKey;
  const arrow = active ? (currentDir === "desc" ? " \u25BC" : " \u25B2") : "";
  return (
    <TableHead
      className={`cursor-pointer select-none hover:text-foreground ${className}`}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {arrow && <span className="ml-0.5 text-xs">{arrow}</span>}
    </TableHead>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  tip,
}: {
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
  tip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-3 cursor-help">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-sm font-semibold tabular-nums">{value}</div>
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<UnifiedBotRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("pnl_pct");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [listening, setListening] = useState(false);
  const [listenerLoading, setListenerLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState<string | null>(null);
  const [cloudStatus, setCloudStatus] = useState<{
    running: boolean;
    polls?: number;
    trade_count?: number;
  } | null>(null);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const timerSnapshotRef = useRef<{ seconds: number; fetchedAt: number }>({
    seconds: 0,
    fetchedAt: Date.now() / 1000,
  });

  const refreshStats = useCallback(() => {
    api
      .stats()
      .then((s) => {
        setStats(s);
        setListening(s.listening);
        const secs = s.listener_cumulative_seconds ?? 0;
        timerSnapshotRef.current = {
          seconds: secs,
          fetchedAt: Date.now() / 1000,
        };
        setTimerSeconds(Math.floor(secs));
      })
      .catch(() => {});
  }, []);

  const refreshTable = useCallback(() => {
    api
      .unified(50, 0.01, "pnl_pct")
      .then(setRows)
      .catch((e) => setError(e.message));
  }, []);

  const refreshCloudStatus = useCallback(() => {
    api
      .cloudListenerStatus()
      .then(setCloudStatus)
      .catch(() => setCloudStatus(null));
  }, []);

  useEffect(() => {
    refreshStats();
    refreshTable();
    refreshCloudStatus();
  }, [refreshStats, refreshTable, refreshCloudStatus]);

  // Poll cloud status periodically
  useEffect(() => {
    const id = setInterval(refreshCloudStatus, 15000);
    return () => clearInterval(id);
  }, [refreshCloudStatus]);

  useEffect(() => {
    if (!listening) return;
    const id = setInterval(refreshStats, 5000);
    return () => clearInterval(id);
  }, [listening, refreshStats]);

  // Tick the timer every second while listening
  useEffect(() => {
    if (!listening) return;
    const id = setInterval(() => {
      const snap = timerSnapshotRef.current;
      const elapsed = Date.now() / 1000 - snap.fetchedAt;
      setTimerSeconds(Math.floor(snap.seconds + elapsed));
    }, 1000);
    return () => clearInterval(id);
  }, [listening]);

  async function toggleListener() {
    setListenerLoading(true);
    try {
      if (listening) {
        await api.listenerStop();
        setListening(false);
      } else {
        await api.listenerStart();
        setListening(true);
      }
      refreshStats();
    } catch {
      // ignore
    }
    setListenerLoading(false);
  }

  async function runDetection() {
    setDetecting(true);
    setDetectResult(null);
    try {
      const result = await api.detect();
      setDetectResult(
        `Found ${result.bots_found} bots from ${result.wallets_scanned} wallets`,
      );
      refreshStats();
      refreshTable();
    } catch {
      setDetectResult("Detection failed");
    }
    setDetecting(false);
  }

  async function clearBots() {
    try {
      await api.botsClear();
      setDetectResult(null);
      refreshStats();
      refreshTable();
    } catch {
      // ignore
    }
  }

  async function clearTrades() {
    try {
      await api.tradesClear();
      refreshStats();
    } catch {
      // ignore
    }
  }

  async function handleCopyTrade(wallet: string) {
    try {
      await api.copyAdd(wallet);
      refreshStats();
    } catch {
      // ignore
    }
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sorted = useMemo(() => {
    if (!rows) return null;
    const copy = [...rows];
    const mul = sortDir === "desc" ? -1 : 1;
    copy.sort(
      (a, b) =>
        mul *
        ((a[sortKey as keyof UnifiedBotRow] as number) -
          (b[sortKey as keyof UnifiedBotRow] as number)),
    );
    return copy;
  }, [rows, sortKey, sortDir]);

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>

        {/* ── Control Panel ─────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Control Panel
            </CardTitle>
            <CardDescription>
              Start the listener to stream trades from Polymarket via real-time
              WebSocket + REST APIs, then scan to classify bots. Longer
              listening = more trade data per wallet = better detection.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {/* Step row */}
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Step 1: Listener */}
              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-bold">
                      1
                    </div>
                    <span className="text-sm font-medium">
                      Discover Wallets
                    </span>
                  </div>
                  {listening ? (
                    <Badge
                      variant="default"
                      className="bg-green-600 text-white gap-1.5"
                    >
                      <span className="relative flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                      </span>
                      Live
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Off</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Stream trades from the Polymarket firehose to collect wallet
                  addresses. Run for a few minutes to gather data, then stop.
                </p>
                <div className="flex items-center gap-3">
                  <Button
                    variant={listening ? "destructive" : "default"}
                    size="sm"
                    onClick={toggleListener}
                    disabled={listenerLoading}
                    className="w-20"
                  >
                    <Radio className="mr-1.5 h-3.5 w-3.5" />
                    {listenerLoading ? "..." : listening ? "Stop" : "Start"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={clearTrades}
                    disabled={listening}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Clear
                  </Button>
                  {timerSeconds > 0 && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                      <Clock className="h-3 w-3" />
                      {fmtTimer(timerSeconds)}
                    </span>
                  )}
                  {listening && stats && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      +{stats.listener_new_trades.toLocaleString()} trades
                      &middot; {stats.listener_polls} polls
                    </span>
                  )}
                </div>
              </div>

              {/* Step 2: Detection */}
              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-bold">
                      2
                    </div>
                    <span className="text-sm font-medium">Detect Bots</span>
                  </div>
                  {detecting && (
                    <Badge variant="default" className="gap-1.5">
                      <span className="relative flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                      </span>
                      Scanning
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Analyze discovered wallets for bot-like patterns using
                  ingested trades + Polymarket activity data.
                </p>
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    onClick={runDetection}
                    disabled={detecting}
                    className="w-20"
                  >
                    <Search className="mr-1.5 h-3.5 w-3.5" />
                    {detecting ? "..." : "Scan"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={clearBots}
                    disabled={detecting}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Clear
                  </Button>
                  {detectResult && (
                    <span className="text-xs text-muted-foreground">
                      {detectResult}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <Separator />

            {/* Stats row */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat
                icon={Database}
                label="Trades Ingested"
                value={
                  stats ? (
                    stats.trade_count.toLocaleString()
                  ) : (
                    <Skeleton className="h-4 w-12" />
                  )
                }
                tip="Total trades captured from the Polymarket firehose"
              />
              <Stat
                icon={Bot}
                label="Bots Detected"
                value={
                  stats ? (
                    stats.bot_count.toLocaleString()
                  ) : (
                    <Skeleton className="h-4 w-12" />
                  )
                }
                tip="Wallets classified as automated traders based on trading patterns"
              />
              <Stat
                icon={Copy}
                label="Copy Targets"
                value={
                  stats ? stats.copy_targets : <Skeleton className="h-4 w-12" />
                }
                tip="Wallets being paper-traded via the copy trading system"
              />
              <Stat
                icon={Activity}
                label="Listener"
                value={
                  stats ? (
                    cloudStatus?.running ? (
                      <span className="text-green-600">
                        Cloud ({(cloudStatus.trade_count ?? 0).toLocaleString()}{" "}
                        trades)
                      </span>
                    ) : listening ? (
                      <span className="text-green-600">
                        Local (+{stats.listener_new_trades.toLocaleString()})
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Idle</span>
                    )
                  ) : (
                    <Skeleton className="h-4 w-12" />
                  )
                }
                tip="Copy listener status — cloud (Cloudflare Worker) or local firehose"
              />
            </div>
          </CardContent>
        </Card>

        {/* ── Bot Rankings ──────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Bot Rankings{rows ? ` (${rows.length})` : ""}</CardTitle>
            <Legend
              items={[
                {
                  term: "Confidence",
                  desc: "How certain the classifier is that this wallet is a bot (0\u2013100%)",
                },
                {
                  term: "Copy",
                  desc: "Copy-worthiness score (0\u2013100). Higher = better candidate. Based on P&L, hold time, trade burst patterns, and market concentration",
                },
                {
                  term: "Type",
                  desc: "Behavioral classification: market maker, arbitrageur, momentum, sniper, etc.",
                },
                {
                  term: "P&L %",
                  desc: "Total cash P&L as a percentage of total volume deployed",
                },
                {
                  term: "Value",
                  desc: "Current total value of all open positions on Polymarket",
                },
                {
                  term: "Day / Week / Month / All Time",
                  desc: "Realized profit over that time window",
                },
                {
                  term: "Volume",
                  desc: "Total dollar value of all trades",
                },
                {
                  term: "Win %",
                  desc: "Percentage of positions with positive realized P&L or profitable resolution",
                },
                {
                  term: "Avg Hold",
                  desc: "Average time between opening and closing a position",
                },
                {
                  term: "Categories",
                  desc: "Market types this bot trades in (crypto, politics, sports, etc.)",
                },
                {
                  term: "Tags",
                  desc: "Behavioral patterns detected (e.g. sub-second, 24/7, clockwork, whale)",
                },
              ]}
            />
          </CardHeader>
          <CardContent>
            {error && (
              <p className="text-sm text-red-500">
                Failed to load data: {error}. Is the API running on :8000?
              </p>
            )}
            {!rows && !error && (
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            )}
            {sorted && sorted.length === 0 && (
              <div className="py-12 text-center text-muted-foreground">
                <Bot className="mx-auto mb-3 h-10 w-10 opacity-30" />
                <p className="text-sm font-medium">No bots detected yet</p>
                <p className="mt-1 text-xs">
                  Start the listener to discover wallets, then run a scan to
                  detect bots.
                </p>
              </div>
            )}
            {sorted && sorted.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Wallet</TableHead>
                      <SortableHead
                        label="Confidence"
                        sortKey="confidence"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="w-36"
                      />
                      <SortableHead
                        label="Copy"
                        sortKey="copy_score"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <TableHead>Type</TableHead>
                      <SortableHead
                        label="P&L %"
                        sortKey="pnl_pct"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortableHead
                        label="Value"
                        sortKey="portfolio_value"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortableHead
                        label="Day"
                        sortKey="profit_1d"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortableHead
                        label="Week"
                        sortKey="profit_7d"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortableHead
                        label="Month"
                        sortKey="profit_30d"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortableHead
                        label="All Time"
                        sortKey="profit_all"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortableHead
                        label="Volume"
                        sortKey="total_volume_usd"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortableHead
                        label="Win %"
                        sortKey="win_rate"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortableHead
                        label="Avg Hold"
                        sortKey="avg_hold_time_hours"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <TableHead>Categories</TableHead>
                      <TableHead>Tags</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map((r) => {
                      const marketTags = r.tags.filter((t) =>
                        MARKET_CATEGORIES.has(t),
                      );
                      const behaviorTags = r.tags.filter(
                        (t) => !MARKET_CATEGORIES.has(t),
                      );
                      return (
                        <TableRow key={r.wallet}>
                          <TableCell>
                            <WalletLink
                              address={r.wallet}
                              username={r.username}
                              onCopyTrade={handleCopyTrade}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Progress
                                value={r.confidence * 100}
                                className="h-2 w-16"
                              />
                              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                                {(r.confidence * 100).toFixed(0)}%
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <span
                              className={`font-mono text-sm font-semibold tabular-nums ${
                                r.copy_score >= 70
                                  ? "text-green-600"
                                  : r.copy_score >= 40
                                    ? "text-yellow-600"
                                    : "text-red-600"
                              }`}
                            >
                              {(r.copy_score ?? 0).toFixed(0)}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="secondary"
                              className={categoryColor[r.category] || ""}
                            >
                              {r.category.replace("_", " ")}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <span
                              className={`font-mono text-sm font-semibold tabular-nums ${
                                r.pnl_pct >= 0
                                  ? "text-green-600"
                                  : "text-red-600"
                              }`}
                            >
                              {r.pnl_pct >= 0 ? "+" : ""}
                              {r.pnl_pct.toFixed(1)}%
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">
                            {fmt(r.portfolio_value)}
                          </TableCell>
                          <TableCell className="text-right">
                            <PnlCell value={r.profit_1d} />
                          </TableCell>
                          <TableCell className="text-right">
                            <PnlCell value={r.profit_7d} />
                          </TableCell>
                          <TableCell className="text-right">
                            <PnlCell value={r.profit_30d} />
                          </TableCell>
                          <TableCell className="text-right">
                            <PnlCell value={r.profit_all} />
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">
                            {fmt(r.total_volume_usd)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">
                            {(r.win_rate * 100).toFixed(0)}%
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">
                            {fmtHold(r.avg_hold_time_hours)}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              <CategoryBadges
                                categories={r.market_categories}
                              />
                              {marketTags
                                .filter((t) => !r.market_categories.includes(t))
                                .map((tag) => (
                                  <CategoryBadge key={tag} category={tag} />
                                ))}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {behaviorTags.map((tag) => (
                                <Badge
                                  key={tag}
                                  variant="outline"
                                  className="text-xs"
                                >
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}
