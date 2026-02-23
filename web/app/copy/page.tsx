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
import { ChevronDown, ChevronRight, RotateCcw, Trash2 } from "lucide-react";
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

function EditableNumber({
  value,
  onSave,
  prefix = "",
  suffix = "",
}: {
  value: number;
  onSave: (v: number) => void;
  prefix?: string;
  suffix?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  if (!editing) {
    return (
      <span
        className="cursor-pointer hover:underline decoration-dotted"
        onClick={(e) => {
          e.stopPropagation();
          setDraft(String(value));
          setEditing(true);
        }}
        title="Click to edit"
      >
        {prefix}
        {value}
        {suffix}
      </span>
    );
  }

  return (
    <input
      type="number"
      className="w-20 rounded border px-1 py-0.5 text-right font-mono text-sm"
      value={draft}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const n = parseFloat(draft);
        if (!isNaN(n) && n > 0 && n !== value) onSave(n);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const n = parseFloat(draft);
          if (!isNaN(n) && n > 0 && n !== value) onSave(n);
          setEditing(false);
        }
        if (e.key === "Escape") setEditing(false);
      }}
    />
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

const COLLAPSE_THRESHOLD = 8;

function InactiveTargets({
  targets,
  onReactivate,
  onPurge,
}: {
  targets: CopyTarget[];
  onReactivate: (addr: string) => void;
  onPurge: (addr: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = targets.length > COLLAPSE_THRESHOLD;
  const visible =
    shouldCollapse && !expanded
      ? targets.slice(0, COLLAPSE_THRESHOLD)
      : targets;

  return (
    <div className="mt-4">
      <button
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2"
        onClick={() => setExpanded(!expanded)}
      >
        {shouldCollapse ? (
          expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )
        ) : null}
        Inactive ({targets.length})
      </button>
      <div className="flex flex-wrap gap-2">
        {visible.map((t) => (
          <Badge
            key={t.wallet}
            variant="outline"
            className="font-mono text-xs flex items-center gap-1.5"
          >
            {t.username || `${t.wallet.slice(0, 6)}...${t.wallet.slice(-4)}`}
            <button
              onClick={() => onReactivate(t.wallet)}
              className="p-0.5 rounded hover:bg-accent hover:text-foreground text-muted-foreground transition-colors"
              title="Reactivate"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => {
                if (
                  confirm(
                    `Permanently delete ${t.username || t.wallet.slice(0, 10)} and all its trade data?`,
                  )
                )
                  onPurge(t.wallet);
              }}
              className="p-0.5 rounded hover:bg-destructive/20 hover:text-destructive text-muted-foreground transition-colors"
              title="Purge (permanent delete)"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </Badge>
        ))}
        {shouldCollapse && !expanded && (
          <Badge
            variant="outline"
            className="text-xs cursor-pointer hover:bg-accent"
            onClick={() => setExpanded(true)}
          >
            +{targets.length - COLLAPSE_THRESHOLD} more
          </Badge>
        )}
      </div>
    </div>
  );
}

function ModeDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: CopyTarget;
  onClose: () => void;
  onConfirm: (pct: number, maxPos: number) => void;
}) {
  const [pct, setPct] = useState("10");
  const [maxPos, setMaxPos] = useState("500");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <Card className="w-96" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle className="text-base">Switch to Real Trading</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Configure real trading for{" "}
            <span className="font-mono font-medium">
              {target.username || target.wallet.slice(0, 10)}
            </span>
          </p>
          <div>
            <label className="text-sm font-medium">Copy % of trade size</label>
            <Input
              type="number"
              min={1}
              max={100}
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Max position (USD)</label>
            <Input
              type="number"
              min={1}
              value={maxPos}
              onChange={(e) => setMaxPos(e.target.value)}
              className="mt-1"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const p = parseFloat(pct);
                const m = parseFloat(maxPos);
                if (!isNaN(p) && p > 0 && p <= 100 && !isNaN(m) && m > 0) {
                  onConfirm(p, m);
                }
              }}
            >
              Switch to Real
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function CopyTradingPage() {
  const [targets, setTargets] = useState<CopyTarget[] | null>(null);
  const [trades, setTrades] = useState<CopyTradeRow[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [expandedWallet, setExpandedWallet] = useState<string | null>(null);

  // Form state
  const [wallet, setWallet] = useState("");
  const [adding, setAdding] = useState(false);

  const [modeDialogTarget, setModeDialogTarget] = useState<CopyTarget | null>(
    null,
  );

  const [cloudRunning, setCloudRunning] = useState(false);
  const [cloudTradeCount, setCloudTradeCount] = useState(0);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [listenerState, setListenerState] = useState<
    "running" | "winding_down" | "stopped"
  >("stopped");
  const [openPositions, setOpenPositions] = useState(0);

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
        setListenerState(s.state ?? (s.running ? "running" : "stopped"));
        setOpenPositions(s.open_positions ?? 0);
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
      await api.copyAdd(wallet.trim());
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

  async function handlePurge(addr: string) {
    try {
      await api.copyPurge(addr);
      refresh();
    } catch {
      // ignore
    }
  }

  // Poll cloud listener status
  const updateCloudStatus = useCallback(
    (s: {
      running: boolean;
      trade_count?: number;
      state?: "running" | "winding_down" | "stopped";
      open_positions?: number;
    }) => {
      setCloudRunning(s.running);
      setCloudTradeCount(s.trade_count ?? 0);
      setListenerState(s.state ?? (s.running ? "running" : "stopped"));
      setOpenPositions(s.open_positions ?? 0);
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
      if (listenerState === "running") {
        // Running → Wind Down
        await api.cloudListenerStop();
        setListenerState("winding_down");
      } else if (listenerState === "winding_down") {
        // Winding Down → Force Stop
        await api.cloudListenerForceStop();
        setCloudRunning(false);
        setListenerState("stopped");
      } else {
        // Stopped → Start
        await api.cloudSyncTargets();
        await api.cloudListenerStart();
        setCloudRunning(true);
        setListenerState("running");
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
            variant={
              listenerState === "running"
                ? "destructive"
                : listenerState === "winding_down"
                  ? "destructive"
                  : "default"
            }
            size="sm"
            disabled={cloudLoading}
            onClick={handleCloudListenerToggle}
          >
            {cloudLoading
              ? "..."
              : listenerState === "running"
                ? "Wind Down"
                : listenerState === "winding_down"
                  ? "Force Stop"
                  : "Start"}
          </Button>
          {listenerState === "running" && (
            <Badge
              variant="outline"
              className="border-green-300 text-green-700"
            >
              Listening
            </Badge>
          )}
          {listenerState === "winding_down" && (
            <Badge
              variant="outline"
              className="border-amber-300 text-amber-700"
            >
              Winding Down
              {openPositions > 0
                ? ` — ${openPositions} position${openPositions !== 1 ? "s" : ""} remaining`
                : ""}
            </Badge>
          )}
          {listenerState === "stopped" && !isAnyListenerActive && (
            <span className="text-xs text-amber-600">No listener running</span>
          )}
        </div>
      </div>

      {/* Circuit breaker alerts */}
      {activeTargets.some((t) => t.circuit_triggered_at) && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3">
          {activeTargets
            .filter((t) => t.circuit_triggered_at)
            .map((t) => (
              <p key={t.wallet} className="text-sm text-red-700">
                Circuit breaker triggered for{" "}
                <span className="font-mono font-medium">
                  {t.username || `${t.wallet.slice(0, 10)}...`}
                </span>{" "}
                at {new Date(t.circuit_triggered_at!).toLocaleString()} — loss
                exceeded ${t.circuit_breaker_usd} threshold
              </p>
            ))}
        </div>
      )}

      {/* Add target form */}
      <Card>
        <CardHeader>
          <CardTitle>Add Copy Target</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="flex items-end gap-4">
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
            <Button type="submit" disabled={adding || !wallet.trim()}>
              {adding ? "Adding..." : "Start Paper Trading"}
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            Paper mode copies 100% of the bot&apos;s trades. Switch to real mode
            to configure sizing.
          </p>
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
                desc: "Percentage of the bot's trade size to mirror. Paper always copies 100%. Click to edit in real mode.",
              },
              {
                term: "Max Pos",
                desc: "Per-trade safety cap in USD. Only applies in real mode. Click to edit.",
              },
              {
                term: "Trades",
                desc: "Total number of filled copy trades for this target",
              },
              {
                term: "Win Rate",
                desc: "Percentage of closed positions that were profitable. Hover for W/L breakdown. Does not include open positions.",
              },
              {
                term: "Open",
                desc: "Number of positions still open (not yet sold or resolved). High counts mean win rate is unreliable.",
              },
              {
                term: "ROI %",
                desc: "Realized P&L divided by peak capital deployed. Measures return on the capital that was at risk.",
              },
              {
                term: "Avg Hold",
                desc: "Average time between opening and closing a position for this target's paper trades",
              },
              {
                term: "Paper P&L",
                desc: "Realized profit/loss from closed paper trades only. Does not include open position risk.",
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
                    <TableHead>Category</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead className="text-right">Copy %</TableHead>
                    <TableHead className="text-right">Max Pos</TableHead>
                    <TableHead className="text-right">Trades</TableHead>
                    <TableHead className="text-right">Win Rate</TableHead>
                    <TableHead className="text-right">Open</TableHead>
                    <TableHead className="text-right">ROI %</TableHead>
                    <TableHead className="text-right">Avg Hold</TableHead>
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
                              if (t.mode === "paper") {
                                setModeDialogTarget(t);
                              } else {
                                api
                                  .copySetMode(t.wallet, "paper")
                                  .then(refresh)
                                  .catch(() => {});
                              }
                            }}
                            title={`Click to switch to ${t.mode === "paper" ? "real" : "paper"} mode`}
                          >
                            {t.mode}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {t.mode === "real" ? (
                            <EditableNumber
                              value={t.trade_pct}
                              suffix="%"
                              onSave={(v) =>
                                api
                                  .copyUpdate(t.wallet, { trade_pct: v })
                                  .then(refresh)
                              }
                            />
                          ) : (
                            <span className="text-muted-foreground">100%</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {t.mode === "real" ? (
                            <EditableNumber
                              value={t.max_position_usd}
                              prefix="$"
                              onSave={(v) =>
                                api
                                  .copyUpdate(t.wallet, { max_position_usd: v })
                                  .then(refresh)
                              }
                            />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {(t.trade_count ?? 0) > 0 ? (
                            t.trade_count
                          ) : (
                            <span className="text-muted-foreground">
                              &mdash;
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {(t.wins ?? 0) + (t.losses ?? 0) > 0 ? (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span>{t.win_rate ?? 0}%</span>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  <p className="text-xs">
                                    {t.wins ?? 0}W / {t.losses ?? 0}L (closed
                                    only)
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {(t.open_positions_count ?? 0) > 0 ? (
                            <span className="text-amber-600">
                              {t.open_positions_count}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              &mdash;
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {(t.roi_pct ?? 0) !== 0 ? (
                            <span
                              className={
                                t.roi_pct >= 0
                                  ? "text-green-600"
                                  : "text-red-600"
                              }
                            >
                              {t.roi_pct}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {fmtHold(t.avg_hold_time_hours)}
                        </TableCell>
                        <TableCell className="text-right">
                          <span
                            className={`font-mono text-sm font-semibold tabular-nums ${
                              t.total_paper_pnl > 0
                                ? "text-green-600"
                                : t.total_paper_pnl < 0
                                  ? "text-red-600"
                                  : "text-muted-foreground"
                            }`}
                          >
                            {fmt(t.total_paper_pnl)}
                          </span>
                          {t.mode === "paper" && (
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {fmt(t.virtual_balance)} /{" "}
                              {fmt(t.virtual_balance_initial)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {t.mode === "paper" && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  api.copyResetPaper(t.wallet).then(refresh);
                                }}
                              >
                                Reset
                              </Button>
                            )}
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
                          </div>
                        </TableCell>
                      </TableRow>
                      {expandedWallet === t.wallet && (
                        <TableRow key={`${t.wallet}-detail`}>
                          <TableCell colSpan={13} className="p-0 px-4 pb-4">
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
            <InactiveTargets
              targets={inactiveTargets}
              onReactivate={handleReactivate}
              onPurge={handlePurge}
            />
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

      {modeDialogTarget && (
        <ModeDialog
          target={modeDialogTarget}
          onClose={() => setModeDialogTarget(null)}
          onConfirm={async (pct, maxPos) => {
            try {
              await api.copyUpdate(modeDialogTarget.wallet, {
                trade_pct: pct,
                max_position_usd: maxPos,
              });
              await api.copySetMode(modeDialogTarget.wallet, "real");
              refresh();
            } catch {
              /* ignore */
            }
            setModeDialogTarget(null);
          }}
        />
      )}
    </div>
  );
}
