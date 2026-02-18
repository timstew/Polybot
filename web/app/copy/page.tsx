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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WalletLink } from "@/components/wallet-link";
import { CopyTargetDetail } from "@/components/copy-target-detail";
import { Legend } from "@/components/legend";
import { ChevronRight, RotateCcw } from "lucide-react";
import { api, type CopyTarget, type CopyTradeRow, type Stats } from "@/lib/api";

function fmt(n: number) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const CATEGORY_ICONS: Record<string, { icon: string; label: string }> = {
  crypto: { icon: "₿", label: "Crypto" },
  sports: { icon: "⚽", label: "Sports" },
  politics: { icon: "🏛", label: "Politics" },
  other: { icon: "📊", label: "Other" },
};

function CategoryIcons({ categories }: { categories: string[] }) {
  if (!categories?.length)
    return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex gap-0.5">
      {categories.map((cat) => {
        const info = CATEGORY_ICONS[cat] || { icon: "?", label: cat };
        return (
          <TooltipProvider key={cat}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="cursor-default text-sm"
                  role="img"
                  aria-label={info.label}
                >
                  {info.icon}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs">{info.label}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      })}
    </span>
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

export default function CopyTradingPage() {
  const [targets, setTargets] = useState<CopyTarget[] | null>(null);
  const [trades, setTrades] = useState<CopyTradeRow[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [expandedWallet, setExpandedWallet] = useState<string | null>(null);

  // Form state
  const [wallet, setWallet] = useState("");
  const [tradePct, setTradePct] = useState("10");
  const [maxUsd, setMaxUsd] = useState("100");
  const [slippageBps, setSlippageBps] = useState("50");
  const [latencyMs, setLatencyMs] = useState("2000");
  const [feeRate, setFeeRate] = useState("0");
  const [adding, setAdding] = useState(false);

  const [cloudRunning, setCloudRunning] = useState(false);
  const [cloudTradeCount, setCloudTradeCount] = useState(0);
  const [cloudLoading, setCloudLoading] = useState(false);

  const isAnyListenerActive =
    stats?.listening || stats?.copy_listening || cloudRunning;

  const fetchTrades = useCallback(() => {
    return api.cloudTrades(20);
  }, []);

  const fetchTargets = useCallback(() => {
    return api.cloudTargets();
  }, []);

  const refresh = useCallback(() => {
    fetchTargets()
      .then(setTargets)
      .catch(() => {});
    fetchTrades()
      .then(setTrades)
      .catch(() => {});
    api
      .stats()
      .then(setStats)
      .catch(() => {});
  }, [fetchTrades, fetchTargets]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // On mount: check if cloud listener is already running
  useEffect(() => {
    api
      .cloudListenerStatus()
      .then((s) => {
        setCloudRunning(s.running);
        setCloudTradeCount(s.trade_count ?? 0);
      })
      .catch(() => {});
  }, []);

  // Poll while any listener is active
  const shouldPoll = isAnyListenerActive;
  useEffect(() => {
    if (!shouldPoll) return;
    const id = setInterval(() => {
      fetchTrades()
        .then(setTrades)
        .catch(() => {});
      fetchTargets()
        .then(setTargets)
        .catch(() => {});
      api
        .stats()
        .then(setStats)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [shouldPoll, fetchTrades, fetchTargets]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await api.copyAdd(
        wallet.trim(),
        parseFloat(tradePct),
        parseFloat(maxUsd),
        parseFloat(slippageBps),
        parseFloat(latencyMs),
        parseFloat(feeRate),
      );
      setWallet("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add target");
    }
    setAdding(false);
  }

  async function handleRemove(addr: string) {
    try {
      await api.copyRemove(addr);
      refresh();
    } catch {
      // ignore
    }
  }

  async function handleReactivate(addr: string) {
    try {
      await api.copyReactivate(addr);
      refresh();
    } catch {
      // ignore
    }
  }

  // Poll cloud listener status
  const updateCloudStatus = useCallback(
    (s: { running: boolean; trade_count?: number }) => {
      setCloudRunning(s.running);
      setCloudTradeCount(s.trade_count ?? 0);
    },
    [],
  );
  useEffect(() => {
    const id = setInterval(() => {
      api
        .cloudListenerStatus()
        .then(updateCloudStatus)
        .catch(() => setCloudRunning(false));
    }, 5000);
    return () => clearInterval(id);
  }, [updateCloudStatus]);

  async function handleCloudListenerToggle() {
    setCloudLoading(true);
    try {
      if (cloudRunning) {
        await api.cloudListenerStop();
        setCloudRunning(false);
      } else {
        await api.cloudSyncTargets();
        await api.cloudListenerStart();
        setCloudRunning(true);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Cloud listener toggle failed",
      );
    }
    setCloudLoading(false);
  }

  const activeTargets = targets?.filter((t) => t.active) ?? [];
  const inactiveTargets = targets?.filter((t) => !t.active) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Copy Trading</h1>
        <div className="flex items-center gap-3">
          <Button
            variant={cloudRunning ? "destructive" : "default"}
            size="sm"
            disabled={cloudLoading}
            onClick={handleCloudListenerToggle}
          >
            {cloudLoading ? "..." : cloudRunning ? "Stop" : "Start"}
          </Button>
          {cloudRunning && (
            <Badge
              variant="outline"
              className="border-green-300 text-green-700"
            >
              Listening
            </Badge>
          )}
          {!isAnyListenerActive && (
            <span className="text-xs text-amber-600">No listener running</span>
          )}
        </div>
      </div>

      {/* Add target form */}
      <Card>
        <CardHeader>
          <CardTitle>Add Copy Target</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-4">
            <div className="flex-1 min-w-[300px]">
              <label className="text-sm font-medium text-muted-foreground">
                Wallet Address
              </label>
              <Input
                placeholder="0x..."
                value={wallet}
                onChange={(e) => setWallet(e.target.value)}
                className="mt-1 font-mono"
              />
            </div>
            <div className="w-32">
              <label className="text-sm font-medium text-muted-foreground">
                Copy % of Size
              </label>
              <Input
                type="number"
                min="1"
                max="100"
                step="1"
                value={tradePct}
                onChange={(e) => setTradePct(e.target.value)}
                className="mt-1"
              />
            </div>
            <div className="w-36">
              <label className="text-sm font-medium text-muted-foreground">
                Max Position ($)
              </label>
              <Input
                type="number"
                min="1"
                step="10"
                value={maxUsd}
                onChange={(e) => setMaxUsd(e.target.value)}
                className="mt-1"
              />
            </div>
            <div className="w-32">
              <label className="text-sm font-medium text-muted-foreground">
                Slippage (bps)
              </label>
              <Input
                type="number"
                min="0"
                step="10"
                value={slippageBps}
                onChange={(e) => setSlippageBps(e.target.value)}
                className="mt-1"
                title="Price slippage estimate in basis points (50 = 0.5%)"
              />
            </div>
            <div className="w-32">
              <label className="text-sm font-medium text-muted-foreground">
                Latency (ms)
              </label>
              <Input
                type="number"
                min="0"
                step="500"
                value={latencyMs}
                onChange={(e) => setLatencyMs(e.target.value)}
                className="mt-1"
                title="Estimated execution delay in milliseconds"
              />
            </div>
            <div className="w-28">
              <label className="text-sm font-medium text-muted-foreground">
                Fee Rate
              </label>
              <Input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={feeRate}
                onChange={(e) => setFeeRate(e.target.value)}
                className="mt-1"
                title="0 = auto-detect from market category, or override (e.g. 0.0625)"
              />
            </div>
            <Button type="submit" disabled={adding || !wallet.trim()}>
              {adding ? "Adding..." : "Start Paper Trading"}
            </Button>
          </form>
          {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
        </CardContent>
      </Card>

      {/* Active targets */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Active Targets
            {activeTargets.length > 0 ? ` (${activeTargets.length})` : ""}
            {(() => {
              const count = cloudTradeCount || (trades?.length ?? 0);
              return count > 0 ? (
                <Badge variant="secondary" className="text-xs font-normal">
                  {count.toLocaleString()} trade{count !== 1 ? "s" : ""}
                </Badge>
              ) : null;
            })()}
            {shouldPoll && (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
              </span>
            )}
          </CardTitle>
          <Legend
            items={[
              {
                term: "Mode",
                desc: '"paper" = simulated trades only, no real money',
              },
              {
                term: "Copy %",
                desc: "Percentage of the target's trade size to mirror",
              },
              {
                term: "Max Position",
                desc: "Maximum dollar exposure per market per target",
              },
              {
                term: "Slippage",
                desc: 'Price impact estimate in basis points (100bps = 1%). "measured" = computed from real market data; "fallback" = static guess before enough data',
              },
              {
                term: "Latency",
                desc: 'Time delay before simulated execution. "measured" = actual detection delay observed; "fallback" = configured estimate',
              },
              {
                term: "Fee Rate",
                desc: 'Trading fee applied to paper trades. "auto" = derived from market category',
              },
              {
                term: "Trades",
                desc: "Total number of filled copy trades for this target",
              },
              {
                term: "Listening",
                desc: "Time span from first to most recent copy trade",
              },
              {
                term: "Avg Hold",
                desc: "Average time between opening and closing a position for this target's paper trades",
              },
              {
                term: "Paper P&L",
                desc: "Simulated profit/loss from all paper trades for this target",
              },
            ]}
          />
        </CardHeader>
        <CardContent>
          {!targets && (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )}
          {targets && activeTargets.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No active copy targets. Add a wallet address above to start paper
              trading.
            </p>
          )}
          {activeTargets.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead>Wallet</TableHead>
                    <TableHead>Cat</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead className="text-right">Copy %</TableHead>
                    <TableHead className="text-right">Trades</TableHead>
                    <TableHead className="text-right">Listening</TableHead>
                    <TableHead className="text-right">Avg Hold</TableHead>
                    <TableHead className="text-right">Peak Capital</TableHead>
                    <TableHead className="text-right">Paper P&L</TableHead>
                    <TableHead className="w-24"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeTargets.map((t) => (
                    <React.Fragment key={t.wallet}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() =>
                          setExpandedWallet(
                            expandedWallet === t.wallet ? null : t.wallet,
                          )
                        }
                      >
                        <TableCell className="w-8 px-2">
                          <ChevronRight
                            className={`h-4 w-4 text-muted-foreground transition-transform ${expandedWallet === t.wallet ? "rotate-90" : ""}`}
                          />
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <WalletLink
                            address={t.wallet}
                            username={t.username}
                          />
                        </TableCell>
                        <TableCell>
                          <CategoryIcons categories={t.categories ?? []} />
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={`cursor-pointer select-none transition-colors ${
                              t.mode === "real"
                                ? "bg-green-100 text-green-800 hover:bg-green-200"
                                : "bg-blue-100 text-blue-800 hover:bg-blue-200"
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              const next =
                                t.mode === "paper" ? "real" : "paper";
                              if (
                                next === "real" &&
                                !confirm(
                                  `Switch ${t.username || t.wallet.slice(0, 10)} to REAL trading? This will execute actual trades with real funds.`,
                                )
                              )
                                return;
                              api
                                .copySetMode(t.wallet, next)
                                .then(refresh)
                                .catch(() => {});
                            }}
                            title={`Click to switch to ${t.mode === "paper" ? "real" : "paper"} mode`}
                          >
                            {t.mode}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {t.trade_pct}%
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {t.trade_count ?? 0}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {fmtHold(t.listening_hours ?? 0)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {fmtHold(t.avg_hold_time_hours)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums text-muted-foreground">
                          {fmt(t.peak_capital ?? 0)}
                        </TableCell>
                        <TableCell className="text-right">
                          <span
                            className={`font-mono text-sm font-semibold tabular-nums ${
                              t.total_paper_pnl >= 0
                                ? "text-green-600"
                                : "text-red-600"
                            }`}
                          >
                            {fmt(t.total_paper_pnl)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemove(t.wallet);
                            }}
                          >
                            Stop
                          </Button>
                        </TableCell>
                      </TableRow>
                      {expandedWallet === t.wallet && (
                        <TableRow key={`${t.wallet}-detail`}>
                          <TableCell colSpan={11} className="p-0 px-4 pb-4">
                            <CopyTargetDetail
                              wallet={t.wallet}
                              source="cloud"
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {inactiveTargets.length > 0 && (
            <div className="mt-4">
              <p className="text-xs text-muted-foreground mb-2">
                Inactive ({inactiveTargets.length})
              </p>
              <div className="flex flex-wrap gap-2">
                {inactiveTargets.map((t) => (
                  <Badge
                    key={t.wallet}
                    variant="outline"
                    className="font-mono text-xs flex items-center gap-1"
                  >
                    {t.username ||
                      `${t.wallet.slice(0, 6)}...${t.wallet.slice(-4)}`}
                    <button
                      onClick={() => handleReactivate(t.wallet)}
                      className="ml-1 hover:text-foreground text-muted-foreground transition-colors"
                      title="Reactivate"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent activity */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {!trades && (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          )}
          {trades && trades.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No trades yet. Start the listener and wait for a target to trade.
            </p>
          )}
          {trades && trades.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead className="text-right">Notional</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trades.map((ct) => (
                    <TableRow key={ct.id} className="h-8">
                      <TableCell className="font-mono text-xs tabular-nums whitespace-nowrap py-1">
                        {new Date(ct.timestamp).toLocaleString()}
                      </TableCell>
                      <TableCell className="py-1">
                        <span className="font-mono text-xs">
                          {ct.source_wallet.slice(0, 6)}...
                          {ct.source_wallet.slice(-4)}
                        </span>
                      </TableCell>
                      <TableCell className="py-1">
                        <Badge
                          variant="secondary"
                          className={
                            ct.side === "BUY"
                              ? "bg-green-100 text-green-800"
                              : "bg-red-100 text-red-800"
                          }
                        >
                          {ct.side}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums py-1">
                        {fmt(
                          ct.exec_price > 0
                            ? ct.exec_price * ct.size
                            : ct.price * ct.size,
                        )}
                      </TableCell>
                      <TableCell className="py-1">
                        <Badge
                          variant="outline"
                          className={
                            ct.status === "filled"
                              ? "border-green-300 text-green-700"
                              : ct.status === "failed"
                                ? "border-red-300 text-red-700"
                                : ""
                          }
                        >
                          {ct.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
