"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Database,
  Filter,
  Info,
  Star,
  Users,
  X,
} from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────

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

const FILTER_CATEGORIES = [
  "crypto",
  "politics",
  "sports",
  "finance",
  "pop culture",
] as const;

// ── Column definitions ─────────────────────────────────────────────

interface ColumnDef {
  key: string;
  label: string;
  sortKey?: SortKey;
  defaultVisible: boolean;
  className?: string;
}

const COLUMNS: ColumnDef[] = [
  { key: "wallet", label: "Wallet", defaultVisible: true },
  {
    key: "confidence",
    label: "Bot %",
    sortKey: "confidence",
    defaultVisible: false,
    className: "text-right",
  },
  {
    key: "copy_score",
    label: "Score",
    sortKey: "copy_score",
    defaultVisible: true,
    className: "text-right",
  },
  {
    key: "pnl_pct",
    label: "P&L %",
    sortKey: "pnl_pct",
    defaultVisible: true,
    className: "text-right",
  },
  {
    key: "portfolio_value",
    label: "Total P&L",
    sortKey: "portfolio_value",
    defaultVisible: true,
    className: "text-right",
  },
  {
    key: "profit_1d",
    label: "Day",
    sortKey: "profit_1d",
    defaultVisible: true,
    className: "text-right",
  },
  {
    key: "profit_7d",
    label: "Week",
    sortKey: "profit_7d",
    defaultVisible: false,
    className: "text-right",
  },
  {
    key: "profit_30d",
    label: "Month",
    sortKey: "profit_30d",
    defaultVisible: false,
    className: "text-right",
  },
  {
    key: "profit_all",
    label: "All Time",
    sortKey: "profit_all",
    defaultVisible: false,
    className: "text-right",
  },
  {
    key: "win_rate",
    label: "Win %",
    sortKey: "win_rate",
    defaultVisible: true,
    className: "text-right",
  },
  {
    key: "total_volume_usd",
    label: "Vol",
    sortKey: "total_volume_usd",
    defaultVisible: false,
    className: "text-right",
  },
  {
    key: "efficiency",
    label: "Efficiency",
    sortKey: "efficiency",
    defaultVisible: false,
    className: "text-right",
  },
  {
    key: "avg_hold_time_hours",
    label: "Hold",
    sortKey: "avg_hold_time_hours",
    defaultVisible: false,
    className: "text-right",
  },
  { key: "info", label: "", defaultVisible: true },
  { key: "dismiss", label: "", defaultVisible: true },
];

// ── Types ──────────────────────────────────────────────────────────

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
  | "profit_all"
  | "efficiency";

type SortDir = "asc" | "desc";

interface Filters {
  categories: Set<string>;
  search: string;
  minScore: number;
  profitableOnly: boolean;
}

// ── localStorage helpers ───────────────────────────────────────────

function loadFromStorage<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveToStorage(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

// ── Recommendation check ───────────────────────────────────────────

function isRecommended(r: UnifiedBotRow): string | null {
  if (r.copy_score >= 40 && r.profit_all > 0) {
    return "High copy score with positive all-time P&L";
  }
  const nonCrypto = r.tags.some(
    (t) => t === "politics" || t === "sports" || t === "finance",
  );
  if (nonCrypto && r.copy_score >= 20) {
    return "Non-crypto specialist with solid score";
  }
  if (r.profit_30d > 500 && r.win_rate > 0.55) {
    return "Strong recent performance ($500+ monthly, 55%+ win rate)";
  }
  return null;
}

// ── Sub-components ─────────────────────────────────────────────────

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
  const arrow = active
    ? currentDir === "desc"
      ? " \u25BC"
      : " \u25B2"
    : " \u25BD";
  return (
    <TableHead
      className={`cursor-pointer select-none hover:text-foreground ${className}`}
      onClick={() => onSort(sortKey)}
    >
      {label}
      <span
        className={`ml-0.5 text-xs ${active ? "" : "text-muted-foreground/40"}`}
      >
        {arrow}
      </span>
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

// ── Main page ──────────────────────────────────────────────────────

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [allRows, setAllRows] = useState<UnifiedBotRow[]>([]);
  const [totalBots, setTotalBots] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("copy_score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Pagination
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  // Filters
  const [filters, setFilters] = useState<Filters>(() => ({
    categories: new Set<string>(),
    search: "",
    minScore: 0,
    profitableOnly: false,
  }));
  const [showFilters, setShowFilters] = useState(false);

  // Column visibility
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    () =>
      new Set(
        loadFromStorage(
          "dashboard:visibleCols",
          COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key),
        ),
      ),
  );
  const [showColPicker, setShowColPicker] = useState(false);
  const colPickerRef = useRef<HTMLDivElement>(null);

  // Watchlist tracking
  const [watchlistedWallets, setWatchlistedWallets] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    api
      .watchlist()
      .then((entries) => {
        setWatchlistedWallets(new Set(entries.map((e) => e.wallet)));
      })
      .catch(() => {});
  }, []);

  // Close column picker on click outside
  useEffect(() => {
    if (!showColPicker) return;
    function handleClick(e: MouseEvent) {
      if (
        colPickerRef.current &&
        !colPickerRef.current.contains(e.target as Node)
      ) {
        setShowColPicker(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showColPicker]);

  // Save column visibility to localStorage
  useEffect(() => {
    saveToStorage("dashboard:visibleCols", Array.from(visibleCols));
  }, [visibleCols]);

  const toggleCol = (key: string) => {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ── Data fetching ──────────────────────────────────────────────

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
    // Fetch a large batch — we filter/sort/paginate client-side
    api
      .unified(500, 0)
      .then((resp) => {
        setAllRows(resp.bots);
        setTotalBots(resp.total);
      })
      .catch(() => {
        setAllRows([]);
        setTotalBots(0);
      });
  }, []);

  useEffect(() => {
    refreshStats();
    refreshTable();
  }, [refreshStats, refreshTable]);

  useEffect(() => {
    const id = setInterval(refreshStats, 30000);
    return () => clearInterval(id);
  }, [refreshStats]);

  // ── Actions ────────────────────────────────────────────────────

  async function handleCopyTrade(wallet: string) {
    try {
      await api.copyAdd(wallet);
      refreshStats();
    } catch {
      // ignore
    }
  }

  async function handleWatchlist(wallet: string) {
    try {
      await api.watchlistAdd(wallet);
      setWatchlistedWallets((prev) => new Set([...prev, wallet]));
    } catch {
      // ignore
    }
  }

  async function handleDismiss(wallet: string) {
    try {
      await api.dismissBot(wallet);
      setAllRows((prev) => prev.filter((r) => r.wallet !== wallet));
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
    setPage(0);
  }

  function toggleCategory(cat: string) {
    setFilters((prev) => {
      const next = new Set(prev.categories);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return { ...prev, categories: next };
    });
    setPage(0);
  }

  // ── Filtered + sorted + paginated ─────────────────────────────

  const filtered = useMemo(() => {
    let rows = allRows;

    // Category filter
    if (filters.categories.size > 0) {
      rows = rows.filter((r) => r.tags.some((t) => filters.categories.has(t)));
    }

    // Search filter
    if (filters.search) {
      const q = filters.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          (r.username || "").toLowerCase().includes(q) ||
          r.wallet.toLowerCase().includes(q),
      );
    }

    // Score filter
    if (filters.minScore > 0) {
      rows = rows.filter((r) => r.copy_score >= filters.minScore);
    }

    // Profitable only
    if (filters.profitableOnly) {
      rows = rows.filter((r) => r.profit_all > 0);
    }

    return rows;
  }, [allRows, filters]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    const mul = sortDir === "desc" ? -1 : 1;
    copy.sort(
      (a, b) =>
        mul *
        ((a[sortKey as keyof UnifiedBotRow] as number) -
          (b[sortKey as keyof UnifiedBotRow] as number)),
    );
    return copy;
  }, [filtered, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const paginated = sorted.slice(page * pageSize, (page + 1) * pageSize);

  const activeFilterCount =
    filters.categories.size +
    (filters.search ? 1 : 0) +
    (filters.minScore > 0 ? 1 : 0) +
    (filters.profitableOnly ? 1 : 0);

  // ── Render ─────────────────────────────────────────────────────

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>

        {/* ── System Status ──────────────────────────────────── */}
        <Card>
          <CardContent className="py-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
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
                ) : stats ? (
                  <Badge variant="outline">Idle</Badge>
                ) : (
                  <Badge variant="destructive">Offline</Badge>
                )}
              </div>

              <Separator orientation="vertical" className="h-6" />

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
            <div className="flex items-center justify-between">
              <CardTitle>
                Bot Rankings
                {totalBots > 0 && (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {filtered.length === totalBots
                      ? `(${totalBots})`
                      : `(${filtered.length} of ${totalBots})`}
                  </span>
                )}
              </CardTitle>
              <div className="flex items-center gap-2">
                {/* Filter toggle */}
                <Button
                  variant={showFilters ? "default" : "outline"}
                  size="sm"
                  onClick={() => setShowFilters(!showFilters)}
                  className="gap-1.5"
                >
                  <Filter className="h-3.5 w-3.5" />
                  Filters
                  {activeFilterCount > 0 && (
                    <Badge
                      variant="secondary"
                      className="ml-1 h-5 w-5 rounded-full p-0 text-xs flex items-center justify-center"
                    >
                      {activeFilterCount}
                    </Badge>
                  )}
                </Button>
                {/* Column picker toggle */}
                <div className="relative" ref={colPickerRef}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowColPicker(!showColPicker)}
                    className="gap-1.5"
                  >
                    <Columns3 className="h-3.5 w-3.5" />
                    Columns
                  </Button>
                  {showColPicker && (
                    <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-md border bg-popover p-2 shadow-md">
                      {COLUMNS.filter(
                        (c) =>
                          c.key !== "info" &&
                          c.key !== "dismiss" &&
                          c.key !== "wallet",
                      ).map((col) => (
                        <label
                          key={col.key}
                          className="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer hover:bg-accent rounded"
                        >
                          <input
                            type="checkbox"
                            checked={visibleCols.has(col.key)}
                            onChange={() => toggleCol(col.key)}
                            className="rounded"
                          />
                          {col.label}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── Filter bar ────────────────────────────────── */}
            {showFilters && (
              <div className="mt-3 space-y-3">
                {/* Category chips */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Category:
                  </span>
                  {FILTER_CATEGORIES.map((cat) => (
                    <Badge
                      key={cat}
                      variant={
                        filters.categories.has(cat) ? "default" : "outline"
                      }
                      className="cursor-pointer select-none"
                      onClick={() => toggleCategory(cat)}
                    >
                      {cat}
                    </Badge>
                  ))}
                  {filters.categories.size > 0 && (
                    <button
                      onClick={() =>
                        setFilters((f) => ({
                          ...f,
                          categories: new Set(),
                        }))
                      }
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Clear
                    </button>
                  )}
                </div>

                {/* Other filters */}
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      Search:
                    </span>
                    <Input
                      placeholder="Username or wallet..."
                      value={filters.search}
                      onChange={(e) => {
                        setFilters((f) => ({ ...f, search: e.target.value }));
                        setPage(0);
                      }}
                      className="h-7 w-48 text-xs"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      Min score:
                    </span>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={filters.minScore || ""}
                      onChange={(e) => {
                        setFilters((f) => ({
                          ...f,
                          minScore: Number(e.target.value) || 0,
                        }));
                        setPage(0);
                      }}
                      placeholder="0"
                      className="h-7 w-16 text-xs"
                    />
                  </div>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filters.profitableOnly}
                      onChange={(e) => {
                        setFilters((f) => ({
                          ...f,
                          profitableOnly: e.target.checked,
                        }));
                        setPage(0);
                      }}
                      className="rounded"
                    />
                    Profitable only
                  </label>
                  {activeFilterCount > 0 && (
                    <button
                      onClick={() => {
                        setFilters({
                          categories: new Set(),
                          search: "",
                          minScore: 0,
                          profitableOnly: false,
                        });
                        setPage(0);
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Clear all filters
                    </button>
                  )}
                </div>
              </div>
            )}

            <Legend
              items={[
                {
                  term: "Score",
                  desc: "Copy-worthiness score (0\u2013100). Higher = better candidate for copy trading",
                },
                {
                  term: "P&L %",
                  desc: "Total cash P&L as a percentage of total volume deployed",
                },
                {
                  term: "\u2605 Star",
                  desc: "System recommends this bot for watchlist based on score, P&L, and market diversity",
                },
              ]}
            />
          </CardHeader>
          <CardContent>
            {error && (
              <p className="text-sm text-red-500">
                Failed to load data: {error}. Is the API running?
              </p>
            )}
            {allRows.length === 0 && !error && (
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            )}
            {sorted.length === 0 && allRows.length > 0 && (
              <div className="py-12 text-center text-muted-foreground">
                <Filter className="mx-auto mb-3 h-10 w-10 opacity-30" />
                <p className="text-sm font-medium">
                  No bots match your filters
                </p>
                <p className="mt-1 text-xs">
                  Try adjusting your filter criteria.
                </p>
              </div>
            )}
            {paginated.length > 0 && (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      {/* Star column — always visible */}
                      <TableHead className="w-6" />
                      {visibleCols.has("wallet") && (
                        <TableHead>Wallet</TableHead>
                      )}
                      {COLUMNS.filter(
                        (c) =>
                          c.sortKey &&
                          c.key !== "wallet" &&
                          visibleCols.has(c.key),
                      ).map((col) => (
                        <SortableHead
                          key={col.key}
                          label={col.label}
                          sortKey={col.sortKey!}
                          currentKey={sortKey}
                          currentDir={sortDir}
                          onSort={handleSort}
                          className={col.className || ""}
                        />
                      ))}
                      {visibleCols.has("info") && <TableHead className="w-8" />}
                      {visibleCols.has("dismiss") && (
                        <TableHead className="w-8" />
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginated.map((r) => {
                      const marketTags = r.tags.filter((t) =>
                        MARKET_CATEGORIES.has(t),
                      );
                      const behaviorTags = r.tags.filter(
                        (t) => !MARKET_CATEGORIES.has(t),
                      );
                      const recommendation = isRecommended(r);
                      return (
                        <TableRow key={r.wallet}>
                          {/* Star recommendation */}
                          <TableCell className="px-1">
                            {recommendation && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                                </TooltipTrigger>
                                <TooltipContent side="right">
                                  {recommendation}
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </TableCell>
                          {visibleCols.has("wallet") && (
                            <TableCell>
                              <WalletLink
                                address={r.wallet}
                                username={r.username}
                                onCopyTrade={handleCopyTrade}
                                onWatchlist={handleWatchlist}
                                isWatchlisted={watchlistedWallets.has(r.wallet)}
                              />
                            </TableCell>
                          )}
                          {visibleCols.has("confidence") && (
                            <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                              {(r.confidence * 100).toFixed(0)}%
                            </TableCell>
                          )}
                          {visibleCols.has("copy_score") && (
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
                          )}
                          {visibleCols.has("pnl_pct") && (
                            <TableCell className="text-right">
                              <span
                                className={`font-mono text-sm font-semibold tabular-nums ${
                                  r.pnl_pct > 0
                                    ? "text-green-600"
                                    : r.pnl_pct < 0
                                      ? "text-red-600"
                                      : "text-muted-foreground"
                                }`}
                              >
                                {r.pnl_pct >= 0 ? "+" : ""}
                                {r.pnl_pct.toFixed(1)}%
                              </span>
                            </TableCell>
                          )}
                          {visibleCols.has("portfolio_value") && (
                            <TableCell className="text-right">
                              <PnlCell value={r.portfolio_value} />
                            </TableCell>
                          )}
                          {visibleCols.has("profit_1d") && (
                            <TableCell className="text-right">
                              <PnlCell value={r.profit_1d} />
                            </TableCell>
                          )}
                          {visibleCols.has("profit_7d") && (
                            <TableCell className="text-right">
                              <PnlCell value={r.profit_7d} />
                            </TableCell>
                          )}
                          {visibleCols.has("profit_30d") && (
                            <TableCell className="text-right">
                              <PnlCell value={r.profit_30d} />
                            </TableCell>
                          )}
                          {visibleCols.has("profit_all") && (
                            <TableCell className="text-right">
                              <PnlCell value={r.profit_all} />
                            </TableCell>
                          )}
                          {visibleCols.has("win_rate") && (
                            <TableCell className="text-right font-mono text-xs tabular-nums">
                              {(r.win_rate * 100).toFixed(0)}%
                            </TableCell>
                          )}
                          {visibleCols.has("total_volume_usd") && (
                            <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                              $
                              {r.total_volume_usd >= 1000
                                ? `${(r.total_volume_usd / 1000).toFixed(1)}k`
                                : r.total_volume_usd.toFixed(0)}
                            </TableCell>
                          )}
                          {visibleCols.has("efficiency") && (
                            <TableCell className="text-right">
                              <span
                                className={`font-mono text-xs font-semibold tabular-nums ${(r.efficiency ?? 0) > 0 ? "text-green-600" : (r.efficiency ?? 0) < 0 ? "text-red-600" : "text-muted-foreground"}`}
                              >
                                {(r.efficiency ?? 0) > 0 ? "+" : ""}
                                {(r.efficiency ?? 0).toFixed(2)}%
                              </span>
                            </TableCell>
                          )}
                          {visibleCols.has("avg_hold_time_hours") && (
                            <TableCell className="text-right font-mono text-xs tabular-nums">
                              {fmtHold(r.avg_hold_time_hours)}
                            </TableCell>
                          )}
                          {visibleCols.has("info") && (
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
                                          (t) =>
                                            !r.market_categories.includes(t),
                                        )
                                        .map((tag) => (
                                          <CategoryBadge
                                            key={tag}
                                            category={tag}
                                          />
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
                                          className="text-xs"
                                        >
                                          {tag}
                                        </Badge>
                                      ))}
                                    </div>
                                  )}
                                </TooltipContent>
                              </Tooltip>
                            </TableCell>
                          )}
                          {visibleCols.has("dismiss") && (
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
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>

                {/* ── Pagination ──────────────────────────────── */}
                <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span>
                      Showing {page * pageSize + 1} &ndash;{" "}
                      {Math.min((page + 1) * pageSize, sorted.length)} of{" "}
                      {sorted.length}
                    </span>
                    <select
                      value={pageSize}
                      onChange={(e) => {
                        setPageSize(Number(e.target.value));
                        setPage(0);
                      }}
                      className="h-7 rounded border bg-background px-2 text-xs"
                    >
                      <option value={25}>25</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                    </select>
                    <span className="text-xs">per page</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      disabled={page === 0}
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="px-2 text-xs tabular-nums">
                      Page {page + 1} of {pageCount}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      disabled={page >= pageCount - 1}
                      onClick={() =>
                        setPage((p) => Math.min(pageCount - 1, p + 1))
                      }
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}
