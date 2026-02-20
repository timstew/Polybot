"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PnlCell } from "@/components/pnl-cell";
import { Legend } from "@/components/legend";
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  BarChart3,
  Bot,
  UserPlus,
  Activity,
  Search,
  Eye,
} from "lucide-react";
import { WalletLink } from "@/components/wallet-link";
import { CategoryBadge } from "@/components/category-badge";
import {
  api,
  type WalletDetail,
  type TradeRow,
  type Stats,
  type StrategyAnalysis,
  type SimilarBot,
} from "@/lib/api";

function Tip({ children, text }: { children: React.ReactNode; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

function fmtHold(hours: number): string {
  if (!hours || hours <= 0) return "—";
  if (hours >= 24) return `${(hours / 24).toFixed(1)}d`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  const mins = hours * 60;
  if (mins >= 1) return `${mins.toFixed(0)}m`;
  return `${(mins * 60).toFixed(0)}s`;
}

function fmtUsd(n: number) {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

const botCategoryDescriptions: Record<string, string> = {
  market_maker:
    "Provides liquidity by placing orders on both sides of the book",
  arbitrageur: "Exploits price differences across related markets",
  momentum: "Follows price trends, buying into strength",
  contrarian: "Bets against prevailing market sentiment",
  sniper: "Fast entry on newly created markets",
  whale_follower: "Mirrors trades of large-position wallets",
  unknown: "Trading pattern does not match a known category",
};

const tagDescriptions: Record<string, string> = {
  "high-frequency": "Places many trades per day",
  "large-size": "Trades above-average position sizes",
  "multi-market": "Active across many different markets",
  "wide-coverage": "Trades across many market categories",
  crypto: "Trades in cryptocurrency prediction markets",
  politics: "Trades in political prediction markets",
  sports: "Trades in sports prediction markets",
  finance: "Trades in financial prediction markets",
  "pop culture": "Trades in pop culture prediction markets",
  "crypto markets": "Trades in crypto-specific markets",
};

// ── Activity Heatmap ───────────────────────────────────────────────

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function ActivityHeatmap({ data }: { data: number[][] }) {
  // data is 24x7 (hour x day-of-week)
  const max = Math.max(1, ...data.flat());
  return (
    <div className="overflow-x-auto">
      <div
        className="inline-grid gap-px"
        style={{ gridTemplateColumns: `40px repeat(7, 1fr)` }}
      >
        {/* Header row */}
        <div />
        {DOW_LABELS.map((d) => (
          <div
            key={d}
            className="text-center text-[10px] text-muted-foreground px-1"
          >
            {d}
          </div>
        ))}
        {/* Data rows */}
        {Array.from({ length: 24 }, (_, h) => (
          <>
            <div
              key={`h-${h}`}
              className="text-right text-[10px] text-muted-foreground pr-2 leading-[18px]"
            >
              {h.toString().padStart(2, "0")}:00
            </div>
            {Array.from({ length: 7 }, (_, d) => {
              const val = data[h]?.[d] ?? 0;
              const intensity = val / max;
              const bg =
                intensity === 0
                  ? "bg-muted/30"
                  : intensity < 0.25
                    ? "bg-emerald-100"
                    : intensity < 0.5
                      ? "bg-emerald-300"
                      : intensity < 0.75
                        ? "bg-emerald-500"
                        : "bg-emerald-700";
              return (
                <Tooltip key={`${h}-${d}`}>
                  <TooltipTrigger asChild>
                    <div
                      className={`h-[18px] min-w-[28px] rounded-sm ${bg} cursor-help`}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {DOW_LABELS[d]} {h}:00 UTC — {val} trades
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </>
        ))}
      </div>
    </div>
  );
}

// ── Hold Time Chart ────────────────────────────────────────────────

function HoldTimeChart({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data).filter(([, v]) => v > 0);
  if (entries.length === 0)
    return <p className="text-sm text-muted-foreground">No hold time data</p>;
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div className="space-y-1">
      {entries.map(([label, count]) => (
        <div key={label} className="flex items-center gap-2">
          <span className="w-16 text-right text-xs text-muted-foreground">
            {label}
          </span>
          <div className="flex-1 h-5 bg-muted/30 rounded-sm overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-sm"
              style={{ width: `${(count / max) * 100}%` }}
            />
          </div>
          <span className="w-10 text-right text-xs font-mono">{count}</span>
        </div>
      ))}
    </div>
  );
}

// ── Strategy Section ───────────────────────────────────────────────

function StrategySection({ address }: { address: string }) {
  const [strategy, setStrategy] = useState<StrategyAnalysis | null>(null);
  const [similar, setSimilar] = useState<SimilarBot[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStrategy = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [strat, sim] = await Promise.all([
        api.walletStrategy(address),
        api.similarBots(address, 10),
      ]);
      setStrategy(strat);
      setSimilar(sim.similar);
      setLoaded(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load strategy analysis",
      );
    } finally {
      setLoading(false);
    }
  }, [address]);

  const addToWatchlist = async (wallet: string) => {
    try {
      await api.watchlistAdd(wallet);
    } catch {
      /* ignore */
    }
  };

  if (!loaded && !loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Activity className="h-4 w-4" />
            Strategy Analysis
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Button onClick={loadStrategy} variant="outline" size="sm">
            <Search className="mr-1.5 h-3.5 w-3.5" />
            Analyze Trading Strategy
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Deep-dive into trading patterns, market categories, hold times, and
            find similar bots.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Activity className="h-4 w-4 animate-pulse" />
            Analyzing Strategy...
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-red-500">
            <Activity className="h-4 w-4" />
            Strategy Analysis Failed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-500">{error}</p>
          <Button
            onClick={loadStrategy}
            variant="outline"
            size="sm"
            className="mt-2"
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!strategy) return null;

  // Build key insights text
  const topCat = strategy.category_breakdown[0];
  const quietStart = strategy.quiet_window.start_hour_utc;
  const quietEnd = strategy.quiet_window.end_hour_utc;
  const tz = strategy.quiet_window.timezone_guess;
  const holdBuckets = Object.entries(strategy.hold_times);
  const topHold = holdBuckets.sort((a, b) => b[1] - a[1])[0];

  return (
    <div className="space-y-4">
      {/* Key Insights */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Activity className="h-4 w-4" />
            Strategy Analysis
            <span className="text-xs font-normal text-muted-foreground">
              ({strategy.total_trades} trades analyzed)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1">
            {topCat && (
              <p>
                Best performance in <strong>{topCat.category}</strong> category
                ({fmtUsd(topCat.pnl)} P&L, {(topCat.win_rate * 100).toFixed(0)}%
                win rate, {topCat.trade_count} trades).
              </p>
            )}
            {quietStart !== quietEnd && (
              <p>
                Quiet window: {quietStart}:00 - {quietEnd}:00 UTC
                {tz && ` (likely ${tz})`}.
              </p>
            )}
            {topHold && (
              <p>
                Most common hold time: <strong>{topHold[0]}</strong> (
                {topHold[1]} trades).
                {strategy.entry_exit.avg_loss_exit_time_min > 0 && (
                  <>
                    {" "}
                    Cuts losses in avg{" "}
                    {strategy.entry_exit.avg_loss_exit_time_min.toFixed(0)} min,
                    holds winners for{" "}
                    {strategy.entry_exit.avg_win_exit_time_min.toFixed(0)} min.
                  </>
                )}
              </p>
            )}
            {strategy.side_analysis.both_sides_pct > 0.1 && (
              <p>
                Trades both sides in{" "}
                {(strategy.side_analysis.both_sides_pct * 100).toFixed(0)}% of
                markets. Net{" "}
                {strategy.side_analysis.net_long_bias > 0.55
                  ? "long"
                  : strategy.side_analysis.net_long_bias < 0.45
                    ? "short"
                    : "neutral"}{" "}
                bias ({(strategy.side_analysis.net_long_bias * 100).toFixed(0)}%
                long).
              </p>
            )}
            <p>
              Typical trade size: ${strategy.sizing.median.toFixed(2)} median ($
              {strategy.sizing.p25.toFixed(2)} - $
              {strategy.sizing.p75.toFixed(2)} interquartile).
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Activity Heatmap */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Activity Heatmap (UTC)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityHeatmap data={strategy.active_hours} />
          </CardContent>
        </Card>

        {/* Hold Time Distribution */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Hold Time Distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            <HoldTimeChart data={strategy.hold_times} />
          </CardContent>
        </Card>
      </div>

      {/* Category Breakdown */}
      {strategy.category_breakdown.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Category P&L Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                  <TableHead className="text-right">Win %</TableHead>
                  <TableHead className="text-right">Trades</TableHead>
                  <TableHead className="text-right">Volume</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {strategy.category_breakdown.map((c) => (
                  <TableRow key={c.category}>
                    <TableCell>
                      <CategoryBadge category={c.category} />
                    </TableCell>
                    <TableCell className="text-right">
                      <PnlCell value={c.pnl} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {(c.win_rate * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {c.trade_count}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {fmtUsd(c.volume)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Similar Bots */}
      {similar.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Similar Bots ({similar.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Wallet</TableHead>
                  <TableHead className="text-right">Similarity</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                  <TableHead className="text-right">Win %</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {similar.map((bot) => (
                  <TableRow key={bot.wallet}>
                    <TableCell>
                      <WalletLink
                        address={bot.wallet}
                        username={bot.username}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <span
                        className={`font-mono text-sm ${
                          bot.similarity >= 70
                            ? "text-emerald-600 font-bold"
                            : bot.similarity >= 50
                              ? "text-amber-600"
                              : "text-muted-foreground"
                        }`}
                      >
                        {bot.similarity.toFixed(1)}%
                      </span>
                    </TableCell>
                    <TableCell>
                      <CategoryBadge category={bot.category} />
                    </TableCell>
                    <TableCell className="text-right">
                      <PnlCell value={bot.profit_all} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {(bot.win_rate * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {bot.copy_score.toFixed(0)}
                    </TableCell>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => addToWatchlist(bot.wallet)}
                          >
                            <Eye className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Add to watchlist</TooltipContent>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function WalletPageClient() {
  const { address } = useParams<{ address: string }>();
  const [data, setData] = useState<WalletDetail | null>(null);
  const [trades, setTrades] = useState<TradeRow[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyTrading, setCopyTrading] = useState(false);
  const [copyTradingStatus, setCopyTradingStatus] = useState<string | null>(
    null,
  );

  const refresh = useCallback(() => {
    if (!address) return;
    api
      .wallet(address)
      .then(setData)
      .catch((e) => setError(e.message));
    api
      .walletTrades(address, 50)
      .then(setTrades)
      .catch(() => {});
  }, [address]);

  useEffect(() => {
    refresh();
    api
      .stats()
      .then(setStats)
      .catch(() => {});
  }, [refresh]);

  // Poll while any listener is active
  const anyListening = stats?.listening || stats?.copy_listening || false;
  useEffect(() => {
    if (!anyListening) return;
    const id = setInterval(() => {
      refresh();
      api
        .stats()
        .then(setStats)
        .catch(() => {});
    }, 10_000);
    return () => clearInterval(id);
  }, [anyListening, refresh]);

  const portfolio = useMemo(() => {
    if (!data?.positions.length) return null;
    let deployed = 0;
    let current = 0;
    for (const p of data.positions) {
      deployed += p.initial_value;
      current += p.current_value;
    }
    const returnPct =
      deployed > 0 ? ((current - deployed) / deployed) * 100 : 0;
    return { deployed, current, returnPct };
  }, [data]);

  function copyAddress() {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function startCopyTrading() {
    setCopyTrading(true);
    setCopyTradingStatus(null);
    try {
      await api.copyAdd(address);
      setCopyTradingStatus("Added to copy targets");
    } catch {
      setCopyTradingStatus("Failed to add");
    }
    setCopyTrading(false);
    setTimeout(() => setCopyTradingStatus(null), 3000);
  }

  if (error) {
    return <p className="text-red-500">Failed to load wallet: {error}</p>;
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">
            {data?.username || "Wallet"}
            {data?.alt_username && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                aka {data.alt_username}
              </span>
            )}
          </h1>
          <code className="rounded bg-muted px-2 py-1 font-mono text-sm">
            {address}
          </code>
          <Button variant="outline" size="sm" onClick={copyAddress}>
            {copied ? "Copied!" : "Copy"}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a
              href={`https://polymarket.com/profile/${address}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on Polymarket
            </a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={startCopyTrading}
            disabled={copyTrading}
          >
            <UserPlus className="mr-1.5 h-3.5 w-3.5" />
            {copyTrading ? "Adding..." : "Copy Trade"}
          </Button>
          {copyTradingStatus && (
            <span className="text-xs text-muted-foreground">
              {copyTradingStatus}
            </span>
          )}
          {anyListening && (
            <Badge
              variant="outline"
              className="border-green-400 text-green-600 animate-pulse"
            >
              Live
            </Badge>
          )}
        </div>

        {!data && (
          <div className="grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        )}

        {data && (
          <>
            {/* Bot info with tooltips */}
            {data.bot && (
              <div className="flex flex-wrap items-center gap-2">
                <Tip
                  text={
                    botCategoryDescriptions[data.bot.category] ||
                    "Bot behavioral type"
                  }
                >
                  <span>
                    <Badge variant="secondary" className="cursor-help">
                      <Bot className="mr-1 h-3 w-3" />
                      {data.bot.category.replace("_", " ")}
                    </Badge>
                  </span>
                </Tip>
                <Tip text="How certain the classifier is that this wallet is an automated trader">
                  <span className="text-sm text-muted-foreground cursor-help">
                    {(data.bot.confidence * 100).toFixed(0)}% confidence
                  </span>
                </Tip>
                {data.bot.tags.map((tag) => (
                  <Tip
                    key={tag}
                    text={
                      tagDescriptions[tag] ||
                      "Behavioral pattern or market category"
                    }
                  >
                    <span>
                      <Badge variant="outline" className="text-xs cursor-help">
                        {tag}
                      </Badge>
                    </span>
                  </Tip>
                ))}
              </div>
            )}

            {/* Consolidated stat cards — 3 cards */}
            <div className="grid gap-4 sm:grid-cols-3">
              {/* Card 1: P&L */}
              <Card>
                <CardHeader className="pb-3">
                  <Tip text="Profit and loss from trading activity">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground cursor-help">
                      {data.profitability.realized_pnl +
                        data.profitability.unrealized_pnl >=
                      0 ? (
                        <TrendingUp className="h-4 w-4 text-emerald-500" />
                      ) : (
                        <TrendingDown className="h-4 w-4 text-red-500" />
                      )}
                      Profit & Loss
                    </CardTitle>
                  </Tip>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-baseline justify-between">
                    <Tip text="Profit/loss locked in from closed positions">
                      <span className="text-xs text-muted-foreground cursor-help">
                        Realized
                      </span>
                    </Tip>
                    <span className="text-lg font-bold">
                      <PnlCell value={data.profitability.realized_pnl} />
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <Tip text="Paper profit/loss on still-open positions based on current market prices">
                      <span className="text-xs text-muted-foreground cursor-help">
                        Unrealized
                      </span>
                    </Tip>
                    <span className="text-lg font-bold">
                      <PnlCell value={data.profitability.unrealized_pnl} />
                    </span>
                  </div>
                  <Separator />
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-medium">Net</span>
                    <span className="text-xl font-bold">
                      <PnlCell
                        value={
                          data.profitability.realized_pnl +
                          data.profitability.unrealized_pnl
                        }
                      />
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* Card 2: Portfolio */}
              <Card>
                <CardHeader className="pb-3">
                  <Tip text="Summary of open positions and capital allocation">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground cursor-help">
                      <Wallet className="h-4 w-4 text-blue-500" />
                      Portfolio
                    </CardTitle>
                  </Tip>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-baseline justify-between">
                    <Tip text="Number of currently open market positions">
                      <span className="text-xs text-muted-foreground cursor-help">
                        Positions
                      </span>
                    </Tip>
                    <span className="text-lg font-bold tabular-nums">
                      {data.profitability.active_positions}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <Tip text="Total cost basis of all open positions">
                      <span className="text-xs text-muted-foreground cursor-help">
                        Deployed
                      </span>
                    </Tip>
                    <span className="text-lg font-bold tabular-nums">
                      {portfolio ? fmtUsd(portfolio.deployed) : "—"}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <Tip text="Total current market value of all open positions">
                      <span className="text-xs text-muted-foreground cursor-help">
                        Market Value
                      </span>
                    </Tip>
                    <span className="text-lg font-bold tabular-nums">
                      {portfolio ? fmtUsd(portfolio.current) : "—"}
                    </span>
                  </div>
                  {portfolio && portfolio.deployed > 0 && (
                    <>
                      <Tip text="Unrealized return on deployed capital">
                        <div className="cursor-help">
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-muted-foreground">
                              Return
                            </span>
                            <span
                              className={`font-semibold tabular-nums ${
                                portfolio.returnPct >= 0
                                  ? "text-emerald-600"
                                  : "text-red-500"
                              }`}
                            >
                              {portfolio.returnPct >= 0 ? "+" : ""}
                              {portfolio.returnPct.toFixed(1)}%
                            </span>
                          </div>
                          <Progress
                            value={Math.min(
                              Math.max(50 + portfolio.returnPct / 2, 0),
                              100,
                            )}
                            className="h-1.5"
                          />
                        </div>
                      </Tip>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Card 3: Activity */}
              <Card>
                <CardHeader className="pb-3">
                  <Tip text="Trading volume and performance metrics">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground cursor-help">
                      <BarChart3 className="h-4 w-4 text-violet-500" />
                      Activity
                    </CardTitle>
                  </Tip>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-baseline justify-between">
                    <Tip text="Total dollar value of all trades">
                      <span className="text-xs text-muted-foreground cursor-help">
                        Volume
                      </span>
                    </Tip>
                    <span className="text-lg font-bold tabular-nums">
                      {fmtUsd(data.profitability.total_volume_usd)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <Tip text="Number of distinct markets this wallet has traded in">
                      <span className="text-xs text-muted-foreground cursor-help">
                        Markets
                      </span>
                    </Tip>
                    <span className="text-lg font-bold tabular-nums">
                      {data.profitability.markets_traded}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <Tip text="Percentage of positions closed in profit">
                      <span className="text-xs text-muted-foreground cursor-help">
                        Win Rate
                      </span>
                    </Tip>
                    <span className="text-lg font-bold tabular-nums">
                      {(data.profitability.win_rate * 100).toFixed(0)}%
                    </span>
                  </div>
                  {data.profitability.win_rate > 0 && (
                    <Tip text="Visual indicator of win rate (50% = break even)">
                      <div className="cursor-help">
                        <Progress
                          value={data.profitability.win_rate * 100}
                          className="h-1.5"
                        />
                      </div>
                    </Tip>
                  )}
                  {data.bot && data.bot.avg_hold_time_hours > 0 && (
                    <div className="flex items-baseline justify-between">
                      <Tip text="Average time between opening and closing a position (from local trade history)">
                        <span className="text-xs text-muted-foreground cursor-help">
                          Avg Hold
                        </span>
                      </Tip>
                      <span className="text-lg font-bold tabular-nums">
                        {fmtHold(data.bot.avg_hold_time_hours)}
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Positions table */}
            {data.positions.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Positions ({data.positions.length})</CardTitle>
                  <Legend
                    items={[
                      { term: "Size", desc: "Number of outcome shares held" },
                      {
                        term: "Avg Price",
                        desc: "Volume-weighted average purchase price per share",
                      },
                      {
                        term: "Cur Price",
                        desc: "Current market price per share",
                      },
                      {
                        term: "Cash P&L",
                        desc: "Unrealized profit/loss in dollars: (current price - avg price) \u00d7 size",
                      },
                      {
                        term: "% P&L",
                        desc: "Percentage gain/loss relative to cost basis",
                      },
                      {
                        term: "Realized",
                        desc: "Profit/loss from closed portions of this position",
                      },
                    ]}
                  />
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="min-w-[200px]">
                            Market
                          </TableHead>
                          <TableHead>Outcome</TableHead>
                          <TableHead className="text-right">Size</TableHead>
                          <TableHead className="text-right">
                            Avg Price
                          </TableHead>
                          <TableHead className="text-right">
                            Cur Price
                          </TableHead>
                          <TableHead className="text-right">Cash P&L</TableHead>
                          <TableHead className="text-right">% P&L</TableHead>
                          <TableHead className="text-right">Realized</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.positions.map((p, i) => (
                          <TableRow key={i}>
                            <TableCell className="max-w-[300px] truncate text-sm">
                              {p.slug ? (
                                <a
                                  href={`https://polymarket.com/event/${p.slug}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="hover:underline"
                                >
                                  {p.title}
                                </a>
                              ) : (
                                p.title
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">
                                {p.outcome}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums">
                              {p.size.toLocaleString("en-US", {
                                maximumFractionDigits: 1,
                              })}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums">
                              {p.avg_price.toFixed(4)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums">
                              {p.current_price.toFixed(4)}
                            </TableCell>
                            <TableCell className="text-right">
                              <PnlCell value={p.cash_pnl} />
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums">
                              <span
                                className={
                                  p.percent_pnl > 0
                                    ? "text-emerald-600"
                                    : p.percent_pnl < 0
                                      ? "text-red-500"
                                      : "text-muted-foreground"
                                }
                              >
                                {p.percent_pnl.toFixed(1)}%
                              </span>
                            </TableCell>
                            <TableCell className="text-right">
                              <PnlCell value={p.realized_pnl} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Strategy Analysis Section */}
            <StrategySection address={address} />

            <Separator />

            {/* Local trades */}
            <Card>
              <CardHeader>
                <CardTitle>Recent Trades (Local DB)</CardTitle>
                <Legend
                  items={[
                    {
                      term: "Side",
                      desc: "BUY = purchased shares, SELL = sold shares",
                    },
                    {
                      term: "Price",
                      desc: "Execution price per share (0 to 1, where 1 = certain outcome)",
                    },
                    { term: "Size", desc: "Number of shares traded" },
                    {
                      term: "Notional",
                      desc: "Dollar value of the trade (price \u00d7 size)",
                    },
                  ]}
                />
              </CardHeader>
              <CardContent>
                {!trades && (
                  <div className="space-y-2">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Skeleton key={i} className="h-8 w-full" />
                    ))}
                  </div>
                )}
                {trades && trades.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No trades found in local database for this wallet.
                  </p>
                )}
                {trades && trades.length > 0 && (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Market</TableHead>
                          <TableHead>Side</TableHead>
                          <TableHead className="text-right">Price</TableHead>
                          <TableHead className="text-right">Size</TableHead>
                          <TableHead className="text-right">Notional</TableHead>
                          <TableHead>Time</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {trades.map((t) => (
                          <TableRow key={t.id}>
                            <TableCell className="max-w-[250px] truncate text-sm">
                              {t.title || t.market}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={
                                  t.side === "BUY" ? "default" : "destructive"
                                }
                                className="text-xs"
                              >
                                {t.side}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums">
                              {t.price.toFixed(4)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums">
                              {t.size.toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums">
                              ${(t.price * t.size).toFixed(2)}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {t.timestamp
                                ? new Date(t.timestamp).toLocaleString()
                                : "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
