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
} from "lucide-react";
import { api, type WalletDetail, type TradeRow, type Stats } from "@/lib/api";

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
