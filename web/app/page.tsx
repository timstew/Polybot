"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Bot, Copy, Database, Info, Users, X } from "lucide-react";

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
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [rows, setRows] = useState<UnifiedBotRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("copy_score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const refreshStats = useCallback(() => {
    api
      .stats()
      .then((s) => {
        setStats(s);
        setStatsLoaded(true);
      })
      .catch(() => {
        setStats(null);
        setStatsLoaded(true);
      });
  }, []);

  const refreshTable = useCallback(() => {
    api
      .unified(50, 0.01, "pnl_pct")
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    refreshStats();
    refreshTable();
  }, [refreshStats, refreshTable]);

  // Auto-refresh stats every 30s
  useEffect(() => {
    const id = setInterval(refreshStats, 30000);
    return () => clearInterval(id);
  }, [refreshStats]);

  async function handleCopyTrade(wallet: string) {
    try {
      await api.copyAdd(wallet);
      refreshStats();
    } catch {
      // ignore
    }
  }

  async function handleDismiss(wallet: string) {
    try {
      await api.dismissBot(wallet);
      setRows((prev) =>
        prev ? prev.filter((r) => r.wallet !== wallet) : prev,
      );
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

        {/* ── System Status ──────────────────────────────────── */}
        <Card>
          <CardContent className="py-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              {/* Live indicator */}
              <div className="flex items-center gap-2">
                {!statsLoaded ? (
                  <Skeleton className="h-5 w-14 rounded-full" />
                ) : stats?.listening ? (
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
                  <Badge variant="secondary">Offline</Badge>
                )}
              </div>

              <Separator orientation="vertical" className="h-6" />

              {/* Stats */}
              <Stat
                icon={Database}
                label="Trades"
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
                icon={Users}
                label="Wallets"
                value={
                  stats ? (
                    (stats.wallet_count ?? 0).toLocaleString()
                  ) : (
                    <Skeleton className="h-4 w-12" />
                  )
                }
                tip="Unique wallet addresses discovered"
              />
              <Stat
                icon={Bot}
                label="Bots"
                value={
                  stats ? (
                    stats.bot_count.toLocaleString()
                  ) : (
                    <Skeleton className="h-4 w-12" />
                  )
                }
                tip="Wallets classified as automated traders"
              />
              <Stat
                icon={Copy}
                label="Copying"
                value={
                  stats ? stats.copy_targets : <Skeleton className="h-4 w-12" />
                }
                tip="Wallets being copy-traded"
              />

              {/* DB storage */}
              {stats && (stats.db_ops || stats.db_firehose) && (
                <>
                  <Separator orientation="vertical" className="h-6" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-1.5 cursor-help text-xs text-muted-foreground">
                        <Database className="h-3 w-3" />
                        <span className="tabular-nums">
                          {(
                            (stats.db_ops?.size_mb ?? 0) +
                            (stats.db_firehose?.size_mb ?? 0)
                          ).toFixed(1)}{" "}
                          MB / 1,000 MB
                        </span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <div className="space-y-1.5 text-xs">
                        {stats.db_ops && (
                          <div>
                            <div className="font-medium">
                              Ops DB: {stats.db_ops.size_mb ?? 0} MB / 500 MB
                            </div>
                            <div className="text-muted-foreground">
                              {Object.entries(stats.db_ops)
                                .filter(([t]) => t !== "size_mb")
                                .map(
                                  ([t, c]) =>
                                    `${t.replace(/_/g, " ")} ${c.toLocaleString()}`,
                                )
                                .join(", ")}
                            </div>
                          </div>
                        )}
                        {stats.db_firehose && (
                          <div>
                            <div className="font-medium">
                              Firehose DB: {stats.db_firehose.size_mb ?? 0} MB /
                              500 MB
                            </div>
                            <div className="text-muted-foreground">
                              {Object.entries(stats.db_firehose)
                                .filter(([t]) => t !== "size_mb")
                                .map(
                                  ([t, c]) =>
                                    `${t.replace(/_/g, " ")} ${c.toLocaleString()}`,
                                )
                                .join(", ")}
                            </div>
                          </div>
                        )}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </>
              )}
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
                  term: "Bot %",
                  desc: "How certain the classifier is that this wallet is a bot (0\u2013100%)",
                },
                {
                  term: "Score",
                  desc: "Copy-worthiness score (0\u2013100). Higher = better candidate for copy trading. Based on P&L, hold time, win rate, consistency, and loss severity",
                },
                {
                  term: "P&L %",
                  desc: "Total cash P&L as a percentage of total volume deployed",
                },
                {
                  term: "Total P&L",
                  desc: "Lifetime profit/loss from the Polymarket leaderboard API",
                },
                {
                  term: "Day / Week / Month / All Time",
                  desc: "Realized profit over that time window",
                },
                {
                  term: "Win %",
                  desc: "Percentage of positions with positive realized P&L or profitable resolution",
                },
                {
                  term: "Hold",
                  desc: "Average time between opening and closing a position",
                },
                {
                  term: "Info icon",
                  desc: "Hover for details: type, volume, market categories, and behavioral tags",
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
                  The system is always-on. Bots will appear here automatically
                  as they are detected.
                </p>
              </div>
            )}
            {sorted && sorted.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Wallet</TableHead>
                    <SortableHead
                      label="Bot %"
                      sortKey="confidence"
                      currentKey={sortKey}
                      currentDir={sortDir}
                      onSort={handleSort}
                      className="text-right"
                    />
                    <SortableHead
                      label="Score"
                      sortKey="copy_score"
                      currentKey={sortKey}
                      currentDir={sortDir}
                      onSort={handleSort}
                      className="text-right"
                    />
                    <SortableHead
                      label="P&L %"
                      sortKey="pnl_pct"
                      currentKey={sortKey}
                      currentDir={sortDir}
                      onSort={handleSort}
                      className="text-right"
                    />
                    <SortableHead
                      label="Total P&L"
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
                      label="Win %"
                      sortKey="win_rate"
                      currentKey={sortKey}
                      currentDir={sortDir}
                      onSort={handleSort}
                      className="text-right"
                    />
                    <SortableHead
                      label="Hold"
                      sortKey="avg_hold_time_hours"
                      currentKey={sortKey}
                      currentDir={sortDir}
                      onSort={handleSort}
                      className="text-right"
                    />
                    <TableHead className="w-8" />
                    <TableHead className="w-8" />
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
                        <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {(r.confidence * 100).toFixed(0)}%
                        </TableCell>
                        <TableCell className="text-right">
                          {(r.copy_score ?? 0) < 0 ? (
                            <span className="font-mono text-sm tabular-nums text-muted-foreground">
                              N/A
                            </span>
                          ) : (
                            <span
                              className={`font-mono text-sm font-semibold tabular-nums ${
                                r.copy_score >= 70
                                  ? "text-green-600"
                                  : r.copy_score >= 40
                                    ? "text-yellow-600"
                                    : "text-red-600"
                              }`}
                            >
                              {r.copy_score.toFixed(0)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <span
                            className={`font-mono text-sm font-semibold tabular-nums ${
                              r.pnl_pct >= 0 ? "text-green-600" : "text-red-600"
                            }`}
                          >
                            {r.pnl_pct >= 0 ? "+" : ""}
                            {r.pnl_pct.toFixed(1)}%
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <PnlCell value={r.portfolio_value} />
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
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {(r.win_rate * 100).toFixed(0)}%
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {fmtHold(r.avg_hold_time_hours)}
                        </TableCell>
                        {/* Info tooltip: type, volume, categories, tags */}
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                                <Info className="h-3.5 w-3.5" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent
                              side="left"
                              className="max-w-xs space-y-1.5"
                            >
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs text-muted-foreground">
                                  Type:
                                </span>
                                <Badge
                                  variant="secondary"
                                  className={`text-xs ${categoryColor[r.category] || ""}`}
                                >
                                  {r.category.replace("_", " ")}
                                </Badge>
                              </div>
                              <div className="text-xs">
                                <span className="text-muted-foreground">
                                  Volume:
                                </span>{" "}
                                {fmt(r.total_volume_usd)}
                              </div>
                              {(r.market_categories.length > 0 ||
                                marketTags.length > 0) && (
                                <div className="flex flex-wrap items-center gap-1">
                                  <span className="text-xs text-muted-foreground">
                                    Markets:
                                  </span>
                                  <CategoryBadges
                                    categories={r.market_categories}
                                  />
                                  {marketTags
                                    .filter(
                                      (t) => !r.market_categories.includes(t),
                                    )
                                    .map((tag) => (
                                      <CategoryBadge key={tag} category={tag} />
                                    ))}
                                </div>
                              )}
                              {behaviorTags.length > 0 && (
                                <div className="flex flex-wrap items-center gap-1">
                                  <span className="text-xs text-muted-foreground">
                                    Tags:
                                  </span>
                                  {behaviorTags.map((tag) => (
                                    <Badge
                                      key={tag}
                                      variant="outline"
                                      className="text-xs border-white/30 text-white"
                                    >
                                      {tag}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        {/* Dismiss */}
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => handleDismiss(r.wallet)}
                                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive transition-colors"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="left">
                              Dismiss bot
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}
